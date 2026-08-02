import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { indexModelsByRequestId } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";

function gatewayTestModel(provider: string, id: string, api: Api): Model<Api> {
	return buildModel({
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
	});
}

describe("auth-gateway model catalog", () => {
	test("keeps bare ids compatible while provider-qualified ids disambiguate collisions", () => {
		const copilot = gatewayTestModel("github-copilot", "gpt-5.5", "openai-responses");
		const codex = gatewayTestModel("openai-codex", "gpt-5.5", "openai-codex-responses");
		const modelById = indexModelsByRequestId([copilot, codex], new Set(["github-copilot", "openai-codex"]));

		expect(modelById.get("gpt-5.5")).toBe(copilot);
		expect(modelById.get("github-copilot/gpt-5.5")).toBe(copilot);
		expect(modelById.get("openai-codex/gpt-5.5")).toBe(codex);
	});

	test("does not expose omitted providers when gateway input is provider-scoped", () => {
		const copilot = gatewayTestModel("github-copilot", "gpt-5.5", "openai-responses");
		const codex = gatewayTestModel("openai-codex", "gpt-5.5", "openai-codex-responses");
		const modelById = indexModelsByRequestId([copilot, codex], new Set(["openai-codex"]));

		expect(modelById.get("gpt-5.5")).toBe(codex);
		expect(modelById.get("openai-codex/gpt-5.5")).toBe(codex);
		expect(modelById.get("github-copilot/gpt-5.5")).toBeUndefined();
		expect([...modelById.values()].every(model => model.provider === "openai-codex")).toBe(true);
	});
});
