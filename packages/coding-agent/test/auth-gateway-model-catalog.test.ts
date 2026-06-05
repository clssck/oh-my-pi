import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { createAuthGatewayModelCatalog } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";

function gatewayTestModel(provider: string, id: string, api: Api): Model<Api> {
	return {
		id,
		name: `${provider}/${id}`,
		api,
		provider,
		baseUrl: `https://example.invalid/${provider}`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

describe("auth-gateway model catalog", () => {
	test("keeps bare ids compatible while provider-qualified ids disambiguate collisions", () => {
		const copilot = gatewayTestModel("github-copilot", "gpt-5.5", "openai-responses");
		const codex = gatewayTestModel("openai-codex", "gpt-5.5", "openai-codex-responses");
		const catalog = createAuthGatewayModelCatalog([copilot, codex]);

		expect(catalog.resolveModel("gpt-5.5")).toBe(copilot);
		expect(catalog.resolveModel("github-copilot/gpt-5.5")).toBe(copilot);
		expect(catalog.resolveModel("openai-codex/gpt-5.5")).toBe(codex);
	});

	test("lists provider-qualified aliases without changing canonical routed model ids", () => {
		const copilot = gatewayTestModel("github-copilot", "gpt-5.5", "openai-responses");
		const codex = gatewayTestModel("openai-codex", "gpt-5.5", "openai-codex-responses");
		const catalog = createAuthGatewayModelCatalog([copilot, codex]);
		const listed = Array.from(catalog.listModels());

		expect(listed.map(model => model.id)).toEqual(["gpt-5.5", "github-copilot/gpt-5.5", "openai-codex/gpt-5.5"]);
		expect(listed.find(model => model.id === "openai-codex/gpt-5.5")?.provider).toBe("openai-codex");
		expect(catalog.resolveModel("openai-codex/gpt-5.5")?.id).toBe("gpt-5.5");
	});
});
