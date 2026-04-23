import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { enrichModelThinking } from "@oh-my-pi/pi-ai/model-thinking";
import { type RequestBody, transformRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import type { Model } from "@oh-my-pi/pi-ai/types";

const FLAG = "PI_CODEX_PROMPT_CACHE_RETENTION";

function createCodexModel(id: string): Model<"openai-codex-responses"> {
	return enrichModelThinking({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

async function transformFresh(): Promise<RequestBody> {
	const body: RequestBody = { model: "gpt-5.4" };
	return transformRequestBody(body, createCodexModel(body.model));
}

describe("openai-codex prompt_cache_retention opt-in", () => {
	let previous: string | undefined;

	beforeEach(() => {
		previous = process.env[FLAG];
		delete process.env[FLAG];
	});

	afterEach(() => {
		if (previous === undefined) {
			delete process.env[FLAG];
		} else {
			process.env[FLAG] = previous;
		}
	});

	it("omits prompt_cache_retention when env flag is unset (safe default against upstream 400)", async () => {
		const transformed = await transformFresh();
		expect(transformed.prompt_cache_retention).toBeUndefined();
	});

	it("forwards 24h when env flag is explicitly 24h", async () => {
		process.env[FLAG] = "24h";
		const transformed = await transformFresh();
		expect(transformed.prompt_cache_retention).toBe("24h");
	});

	it("forwards in_memory when env flag is explicitly in_memory", async () => {
		process.env[FLAG] = "in_memory";
		const transformed = await transformFresh();
		expect(transformed.prompt_cache_retention).toBe("in_memory");
	});

	it("ignores unrecognized values so typos cannot reach the wire", async () => {
		process.env[FLAG] = "24hr";
		const transformed = await transformFresh();
		expect(transformed.prompt_cache_retention).toBeUndefined();
	});

	it("strips a pre-existing body.prompt_cache_retention when flag is unset so stale values cannot leak", async () => {
		const body: RequestBody = { model: "gpt-5.4", prompt_cache_retention: "24h" };
		const transformed = await transformRequestBody(body, createCodexModel(body.model));
		expect(transformed.prompt_cache_retention).toBeUndefined();
	});
});
