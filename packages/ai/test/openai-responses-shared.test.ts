import { describe, expect, it } from "bun:test";
import { derivePromptCacheKey } from "../src/providers/openai-responses-shared";

describe("derivePromptCacheKey", () => {
	it("returns undefined when sessionId is undefined (opt-out)", () => {
		expect(derivePromptCacheKey("gpt-5.4", "sys", undefined)).toBeUndefined();
	});

	it("returns undefined when sessionId is empty string (opt-out)", () => {
		expect(derivePromptCacheKey("gpt-5.4", "sys", "")).toBeUndefined();
	});

	it("returns the literal sessionId when systemPrompt is undefined", () => {
		expect(derivePromptCacheKey("gpt-5.4", undefined, "literal-xyz")).toBe("literal-xyz");
	});

	it("returns the literal sessionId when systemPrompt is empty string", () => {
		expect(derivePromptCacheKey("gpt-5.4", "", "literal-xyz")).toBe("literal-xyz");
	});

	it("returns the deterministic omp- hash of (model, systemPrompt) when both are present", () => {
		const key = derivePromptCacheKey("gpt-5.4", "You are helpful.", "session-ignored");
		expect(key).toMatch(/^omp-[0-9a-z]+$/);
		// Exact value pins the algorithm so a silent change to Bun.hash or the
		// separator scheme is caught by tests.
		expect(key).toBe(`omp-${Bun.hash("gpt-5.4\u0000You are helpful.").toString(36)}`);
	});

	it("produces the same key for repeat calls (stability across invocations)", () => {
		const a = derivePromptCacheKey("gpt-5.4", "sys", "session-A");
		const b = derivePromptCacheKey("gpt-5.4", "sys", "session-B");
		expect(a).toBe(b);
		expect(a).toMatch(/^omp-[0-9a-z]+$/);
	});

	it("produces distinct keys for different models with the same systemPrompt", () => {
		const a = derivePromptCacheKey("gpt-5.4", "sys", "shared");
		const b = derivePromptCacheKey("gpt-5.1-codex", "sys", "shared");
		expect(a).not.toBe(b);
		expect(a).toMatch(/^omp-[0-9a-z]+$/);
		expect(b).toMatch(/^omp-[0-9a-z]+$/);
	});

	it("produces distinct keys for the same model with different systemPrompts", () => {
		const a = derivePromptCacheKey("gpt-5.4", "prompt A", "shared");
		const b = derivePromptCacheKey("gpt-5.4", "prompt B", "shared");
		expect(a).not.toBe(b);
	});

	it("uses a null byte separator so `model=a,prompt=b` cannot collide with `model=ab,prompt=` patterns", () => {
		// If the separator were omitted or concatenated naively, ("foo", "bar") would
		// produce the same input bytes as ("foob", "ar"). The \u0000 separator prevents
		// the collision regardless of model.id vs systemPrompt content.
		const a = derivePromptCacheKey("foo", "bar", "s");
		const b = derivePromptCacheKey("foob", "ar", "s");
		expect(a).not.toBe(b);
	});

	it("strips the trailing cwd/date system-prompt tail before hashing so midnight rotation does not rotate the cache route", () => {
		// Same prompt body with different substituted cwd + date at the tail.
		// This mirrors what the system-prompt.md template produces across different
		// days or different project directories.
		const head = "You are a helpful coding assistant.\nFollow all instructions.\n";
		const promptToday = `${head}\nThe current working directory is '/home/a/projX'.\nToday is '2026-04-23'. Begin now.`;
		const promptYesterday = `${head}\nThe current working directory is '/home/a/projX'.\nToday is '2026-04-22'. Begin now.`;
		const promptDifferentCwd = `${head}\nThe current working directory is '/tmp/other'.\nToday is '2026-04-23'. Begin now.`;

		const a = derivePromptCacheKey("gpt-5.4", promptToday, "session-A");
		const b = derivePromptCacheKey("gpt-5.4", promptYesterday, "session-B");
		const c = derivePromptCacheKey("gpt-5.4", promptDifferentCwd, "session-C");

		expect(a).toMatch(/^omp-[0-9a-z]+$/);
		expect(b).toBe(a);
		expect(c).toBe(a);
	});

	it("leaves prompts without the volatile tail structure unchanged (regex degrades gracefully)", () => {
		// If the template ever changes so the regex no longer matches, the key should
		// fall back to hashing the full prompt verbatim (i.e., today's behavior).
		const promptNoTail = "You are helpful.";
		const key = derivePromptCacheKey("gpt-5.4", promptNoTail, "session-X");
		expect(key).toBe(`omp-${Bun.hash("gpt-5.4\u0000You are helpful.").toString(36)}`);
	});

	it("only strips the tail when both cwd and date lines are present in the expected shape", () => {
		// A prompt that mentions "current working directory" elsewhere, but does not
		// end with the full two-line tail, must not have anything stripped.
		const promptPartial = "You are helpful.\nThe current working directory is '/somewhere'. But no date follows.";
		const key = derivePromptCacheKey("gpt-5.4", promptPartial, "session-Y");
		expect(key).toBe(`omp-${Bun.hash(`gpt-5.4\u0000${promptPartial}`).toString(36)}`);
	});
});
