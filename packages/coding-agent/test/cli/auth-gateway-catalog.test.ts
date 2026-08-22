import { describe, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	composeProbeApiKey,
	indexModelsByRequestId,
	isHostAuthenticatedProvider,
	resolveRoutableProviders,
	runAuthGatewayCommand,
} from "../../src/cli/auth-gateway-cli";
import { ModelRegistry } from "../../src/config/model-registry";

function stubAuthStorage(configKeys?: string[]): AuthStorage {
	const stub = {
		setFallbackResolver: () => {},
		clearConfigApiKeys: () => {},
		setConfigApiKey: (provider: string) => configKeys?.push(provider),
		removeConfigApiKey: () => {},
		hasAuth: () => true,
		getAll: () => ({ anthropic: {} }),
	};
	return stub as unknown as AuthStorage;
}

describe("indexModelsByRequestId (auth-gateway catalog)", () => {
	test("resolves a discovery-only model absent from the bundled catalog", () => {
		const registry = new ModelRegistry(stubAuthStorage());
		// Simulate a model reached via provider discovery but not compiled into
		// the bundle (e.g. a post-release id). registerProvider merges it into
		// getAll() exactly as runtime discovery does.
		registry.registerProvider("anthropic", {
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
			apiKey: "test-key",
			models: [
				{
					id: "claude-opus-5-repro",
					name: "Claude Opus 5 (repro)",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 8192,
				},
			],
		});
		expect(getBundledModels("anthropic").map(m => m.id)).not.toContain("claude-opus-5-repro");

		const index = indexModelsByRequestId(registry.getAll(), new Set(["anthropic"]));

		// The gateway can now resolve it by qualified id and bare id — was
		// "Unknown model" when the index was built from getBundledModels only.
		expect(index.get("anthropic/claude-opus-5-repro")?.id).toBe("claude-opus-5-repro");
		expect(index.get("claude-opus-5-repro")?.id).toBe("claude-opus-5-repro");
	});

	test("gateway registry ignores local models.yml credential and routing overrides", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const modelsPath = tempDir.join("models.yml");
		// anthropic: a plain credential/baseUrl override (no transport) — the
		// reviewer's leak. openai: a pi-native gateway route — the self-routing loop.
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  anthropic:",
				"    baseUrl: http://127.0.0.1:18899",
				"    apiKey: gateway-token",
				"  openai:",
				"    baseUrl: http://127.0.0.1:18899",
				"    apiKey: gateway-token",
				"    transport: pi-native",
				"",
			].join("\n"),
		);

		// A normal client registry applies the local overrides and installs the
		// config API keys into AuthStorage.
		const clientKeys: string[] = [];
		const clientRegistry = new ModelRegistry(stubAuthStorage(clientKeys), modelsPath);
		expect(clientRegistry.find("anthropic", "claude-sonnet-4-5")?.baseUrl).toBe("http://127.0.0.1:18899");
		expect(clientRegistry.getAll().find(model => model.provider === "openai")?.transport).toBe("pi-native");
		expect(clientKeys).toContain("anthropic");

		// The gateway registry ignores models.yml entirely: bundled routing wins,
		// no config key reaches AuthStorage, and no pi-native self-route survives.
		const gatewayKeys: string[] = [];
		const gatewayRegistry = new ModelRegistry(stubAuthStorage(gatewayKeys), modelsPath, {
			ignoreLocalModelConfig: true,
		});
		const gatewayModel = gatewayRegistry.find("anthropic", "claude-sonnet-4-5");
		const bundledModel = getBundledModels("anthropic").find(model => model.id === "claude-sonnet-4-5");
		if (!gatewayModel || !bundledModel) throw new Error("expected bundled Anthropic model");

		expect(gatewayModel.baseUrl).toBe(bundledModel.baseUrl);
		expect(gatewayModel.transport).toBeUndefined();
		expect(gatewayKeys).toHaveLength(0);
		expect(gatewayRegistry.getAll().find(model => model.provider === "openai")?.transport).toBeUndefined();
		expect(indexModelsByRequestId(gatewayRegistry.getAll(), new Set(["anthropic"])).get(gatewayModel.id)).toBe(
			gatewayModel,
		);
	});

	test("scopes the catalog to providers with credentials", () => {
		const registry = new ModelRegistry(stubAuthStorage());
		const all = registry.getAll();
		const anthropicModel = all.find(m => m.provider === "anthropic");
		const foreignModel = all.find(m => m.provider !== "anthropic");
		if (!anthropicModel || !foreignModel) throw new Error("expected mixed-provider bundled catalog");

		const index = indexModelsByRequestId(all, new Set(["anthropic"]));

		expect(index.get(`anthropic/${anthropicModel.id}`)).toBeDefined();
		expect(index.get(`${foreignModel.provider}/${foreignModel.id}`)).toBeUndefined();
	});
});

describe("resolveRoutableProviders (auth-gateway host authentication)", () => {
	const brokerRows = [{ provider: "anthropic" }, { provider: "github-copilot" }] as const satisfies readonly {
		provider: string;
	}[];

	test("admits an allowlisted provider when the host itself is authenticated", () => {
		const routable = resolveRoutableProviders(
			brokerRows,
			new Set(["anthropic", "google-vertex"]),
			provider => provider === "google-vertex",
		);

		expect(routable).toEqual(new Set(["anthropic", "google-vertex"]));
	});

	test("omits an allowlisted provider with no broker row and no host auth", () => {
		const routable = resolveRoutableProviders(brokerRows, new Set(["anthropic", "openai"]), () => false);

		expect(routable).toEqual(new Set(["anthropic"]));
	});

	test("never admits host-authenticated providers without an explicit --providers filter", () => {
		const routable = resolveRoutableProviders(brokerRows, null, () => true);

		expect(routable).toEqual(new Set(["anthropic", "github-copilot"]));
	});

	test("keeps broker rows subject to the provider filter", () => {
		const routable = resolveRoutableProviders(brokerRows, new Set(["anthropic"]), () => true);

		expect(routable).toEqual(new Set(["anthropic"]));
	});

	test("routes an allowlisted ADC-authenticated Vertex model with no broker snapshot row", () => {
		const registry = new ModelRegistry(stubAuthStorage());
		const vertexModel = registry.getAll().find(model => model.provider === "google-vertex");
		if (!vertexModel) throw new Error("expected a bundled google-vertex model");

		// Broker snapshot holds no google-vertex row; the gateway host reports
		// ADC auth for it via the registry's authenticated sentinel.
		const routable = resolveRoutableProviders(
			[{ provider: "anthropic" }],
			new Set(["anthropic", "google-vertex"]),
			provider => provider === "google-vertex",
		);
		const index = indexModelsByRequestId(registry.getAll(), routable);

		expect(index.get(`google-vertex/${vertexModel.id}`)).toBe(vertexModel);
		expect(index.get(vertexModel.id)).toBe(vertexModel);
	});

	test("keeps an allowlisted Vertex model unroutable when the host is not authenticated", () => {
		const registry = new ModelRegistry(stubAuthStorage());
		const vertexModel = registry.getAll().find(model => model.provider === "google-vertex");
		if (!vertexModel) throw new Error("expected a bundled google-vertex model");

		const routable = resolveRoutableProviders(
			[{ provider: "anthropic" }],
			new Set(["anthropic", "google-vertex"]),
			() => false,
		);
		const index = indexModelsByRequestId(registry.getAll(), routable);

		expect(index.get(`google-vertex/${vertexModel.id}`)).toBeUndefined();
	});

	test("isHostAuthenticatedProvider rejects anything but the registry sentinel", () => {
		// A provider with no registry env resolver can never be host-authenticated.
		expect(isHostAuthenticatedProvider("gateway-test-unknown-provider")).toBe(false);
		// A plain env-key provider resolves a real secret, not the sentinel —
		// even when this host happens to export the key, it stays unroutable.
		expect(isHostAuthenticatedProvider("openai")).toBe(false);
	});
});

describe("composeProbeApiKey (auth-gateway structured probe credentials)", () => {
	test("composes a structured Vertex blob carrying token, projectId, and location", () => {
		const key = composeProbeApiKey("google-vertex", {
			type: "oauth",
			accessToken: "sa-token",
			refreshToken: "sa-private-material",
			projectId: "gateway-project",
			location: "us-central1",
			email: "svc@example.com",
		});

		expect(JSON.parse(key)).toEqual({
			token: "sa-token",
			projectId: "gateway-project",
			location: "us-central1",
			email: "svc@example.com",
		});
	});

	test("omits refreshToken from the Vertex blob so service-account material never becomes a request key", () => {
		const key = composeProbeApiKey("google-vertex", {
			type: "oauth",
			accessToken: "sa-token",
			refreshToken: "sa-private-material",
		});

		const parsed = JSON.parse(key);
		expect(parsed.token).toBe("sa-token");
		expect(parsed).not.toHaveProperty("refreshToken");
	});

	test("keeps refreshToken in the blob for providers that expect it", () => {
		const key = composeProbeApiKey("github-copilot", {
			type: "oauth",
			accessToken: "copilot-token",
			refreshToken: "copilot-refresh",
		});

		const parsed = JSON.parse(key);
		expect(parsed.token).toBe("copilot-token");
		expect(parsed.refreshToken).toBe("copilot-refresh");
	});

	test("passes api_key credentials through verbatim", () => {
		expect(composeProbeApiKey("google-vertex", { type: "api_key", apiKey: "raw-key" })).toBe("raw-key");
	});

	test("returns the raw access token for unstructured providers", () => {
		expect(composeProbeApiKey("anthropic", { type: "oauth", accessToken: "anthropic-token" })).toBe(
			"anthropic-token",
		);
	});
});
describe("runAuthGatewayCommand provider filtering", () => {
	test("rejects a serve-only provider filter on check", async () => {
		await expect(
			runAuthGatewayCommand({
				action: "check",
				flags: { providers: ["openai-codex"] },
			}),
		).rejects.toThrow("--providers is only supported by `auth-gateway serve`");
	});
});
