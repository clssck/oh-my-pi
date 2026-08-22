import { describe, expect, test } from "bun:test";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	RUNINFRA_STATIC_MODELS,
	runInfraModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("RunInfra provider", () => {
	test("resolves the configured DeepSeek Pro model without generation credentials", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "runinfra");
		expect(descriptor).toMatchObject({
			defaultModel: "deepseek-v4-pro",
			envVars: ["RUNINFRA_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		expect(RUNINFRA_STATIC_MODELS.find(model => model.id === "deepseek-v4-pro")).toMatchObject({
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 32_768,
			thinking: { mode: "effort", efforts: ["low", "high", "max"] },
		});
	});

	test("authenticated discovery preserves configured metadata for known ids", async () => {
		const fetch: FetchImpl = async () =>
			Response.json({
				object: "list",
				data: [
					...RUNINFRA_STATIC_MODELS.map(model => ({ id: model.id, object: "model" })),
					{ id: "nemotron-3-5-lightning-30b", object: "model" },
					{ id: "qwen3-embedding-8b", object: "model" },
					{ id: "qwen3-reranker-8b", object: "model" },
				],
			});
		const options = runInfraModelManagerOptions({ apiKey: "test-key", fetch });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const pro = models.find(model => model.id === "deepseek-v4-pro");

		expect(pro).toMatchObject({
			provider: "runinfra",
			baseUrl: "https://api.runinfra.ai/v1",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 32_768,
			cost: { input: 0.6, output: 1.9, cacheRead: 0.03, cacheWrite: 0 },
		});
		expect(models.some(model => model.id === "nemotron-3-5-lightning-30b")).toBe(true);
		expect(models.some(model => /(?:embedding|rerank|tts)/i.test(model.id))).toBe(false);
	});
});
