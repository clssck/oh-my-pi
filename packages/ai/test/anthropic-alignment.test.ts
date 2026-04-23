import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import {
	type AnthropicSystemBlock,
	applyClaudeToolPrefix,
	buildAnthropicClientOptions,
	buildAnthropicHeaders,
	buildAnthropicSystemBlocks,
	claudeCodeHeaders,
	claudeCodeSystemInstruction,
	claudeCodeVersion,
	generateClaudeCloakingUserId,
	isClaudeCloakingUserId,
	mapStainlessArch,
	mapStainlessOs,
	streamAnthropic,
	stripClaudeToolPrefix,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import {
	derivePromptCacheKey,
	splitVolatileTail,
	stripVolatileTail,
} from "@oh-my-pi/pi-ai/providers/openai-responses-shared";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";

const ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(overrides)) {
		previous.set(key, Bun.env[key]);
	}
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
		await fn();
	} finally {
		for (const [key, value] of previous.entries()) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

function captureAnthropicPayload(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: { isOAuth?: boolean; metadata?: { user_id?: string } },
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: options?.isOAuth ?? true,
		signal: createAbortedSignal(),
		metadata: options?.metadata,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("Anthropic request fingerprint alignment", () => {
	it("uses updated Claude Code header defaults", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
		});

		expect(headers["Anthropic-Beta"]).toContain("context-management-2025-06-27");
		expect(headers["Anthropic-Beta"]).toContain("prompt-caching-scope-2026-01-05");
		expect(headers["Anthropic-Beta"]).not.toContain("fine-grained-tool-streaming-2025-05-14");
		expect(headers["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);
		expect(claudeCodeHeaders["X-Stainless-Package-Version"]).toBe("0.74.0");
		expect("X-Stainless-Helper-Method" in claudeCodeHeaders).toBe(false);
	});

	it("maps Stainless OS and arch values from explicit inputs", () => {
		expect(mapStainlessOs("darwin")).toBe("MacOS");
		expect(mapStainlessOs("windows")).toBe("Windows");
		expect(mapStainlessOs("linux")).toBe("Linux");
		expect(mapStainlessOs("freebsd")).toBe("FreeBSD");
		expect(mapStainlessOs("solaris")).toBe("Other::solaris");

		expect(mapStainlessArch("x64")).toBe("x64");
		expect(mapStainlessArch("amd64")).toBe("x64");
		expect(mapStainlessArch("arm64")).toBe("arm64");
		expect(mapStainlessArch("386")).toBe("x86");
		expect(mapStainlessArch("x86")).toBe("x86");
		expect(mapStainlessArch("sparc64")).toBe("other::sparc64");
	});

	it("uses runtime Stainless OS and arch mappings in Anthropic headers", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
		});

		expect(headers["X-Stainless-Os"]).toBe(mapStainlessOs(process.platform));
		expect(headers["X-Stainless-Arch"]).toBe(mapStainlessArch(process.arch));
	});

	it("injects billing header and Claude Agent SDK identity block", () => {
		const blocks = buildAnthropicSystemBlocks("Stay concise.", {
			includeClaudeCodeInstruction: true,
			extraInstructions: ["Use citations when possible"],
		});

		expect(blocks).toBeDefined();
		expect(blocks?.[0]?.text.startsWith(`x-anthropic-billing-header: cc_version=${claudeCodeVersion}.`)).toBe(true);
		expect(blocks?.[0]?.text).toMatch(/cc_entrypoint=cli; cch=[0-9a-f]{5};$/);
		expect(blocks?.[1]).toEqual({
			type: "text",
			text: claudeCodeSystemInstruction,
		});
		expect(blocks?.[2]).toEqual({
			type: "text",
			text: "Use citations when possible",
		});
		expect(blocks?.[3]).toEqual({
			type: "text",
			text: "Stay concise.",
		});
	});

	it("applies cache_control to system blocks when cacheControl option is set", () => {
		const blocks = buildAnthropicSystemBlocks("Stay concise.", {
			includeClaudeCodeInstruction: true,
			extraInstructions: ["Use citations when possible"],
			cacheControl: { type: "ephemeral" },
		});

		expect(blocks).toBeDefined();
		expect(blocks?.[2]).toEqual({
			type: "text",
			text: "Use citations when possible",
			cache_control: { type: "ephemeral" },
		});
		expect(blocks?.[3]).toEqual({
			type: "text",
			text: "Stay concise.",
			cache_control: { type: "ephemeral" },
		});
	});

	it("uses Bearer auth for non-Anthropic API bases with api-key credentials", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://proxy.example.com",
			stream: true,
		});

		expect(headers.Authorization).toBe("Bearer sk-ant-api-test");
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("forwards only prefix-matching Claude Code User-Agent values", () => {
		const forwardedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli/2.1.63 (external, cli)" },
		});
		expect(forwardedHeaders["User-Agent"]).toBe("claude-cli/2.1.63 (external, cli)");

		// Test variant without slash
		const forwardedNoSlashHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli-dev" },
		});
		expect(forwardedNoSlashHeaders["User-Agent"]).toBe("claude-cli-dev");

		const normalizedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "curl/8.7.1" },
		});
		expect(normalizedHeaders["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);

		const embeddedClaudeCliHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "my-client claude-cli/2.1.63" },
		});
		expect(embeddedClaudeCliHeaders["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);
	});

	it("splits the standard volatile cwd+date tail into its own uncached block", () => {
		const PROMPT =
			"You are helpful. Do things.\nThe current working directory is '/tmp/foo'.\nToday is '2026-04-23'. Begin now.";
		const blocks = buildAnthropicSystemBlocks(PROMPT, { cacheControl: { type: "ephemeral" } });
		expect(blocks).toBeDefined();
		expect(blocks?.length).toBe(2);
		expect(blocks?.[0]).toEqual({
			type: "text",
			text: "You are helpful. Do things.",
			cache_control: { type: "ephemeral" },
		});
		expect(blocks?.[1]).toEqual({
			type: "text",
			text: "\nThe current working directory is '/tmp/foo'.\nToday is '2026-04-23'. Begin now.",
		});
		expect(blocks?.[1]).not.toHaveProperty("cache_control");
	});

	it("splits the custom-prompt volatile tail into its own uncached block", () => {
		const PROMPT = "System instructions here.\nCurrent date: 2026-04-23\nCurrent working directory: /tmp/bar";
		const blocks = buildAnthropicSystemBlocks(PROMPT, { cacheControl: { type: "ephemeral" } });
		expect(blocks).toBeDefined();
		expect(blocks?.length).toBe(2);
		expect(blocks?.[0]?.text).toBe("System instructions here.");
		expect(blocks?.[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(blocks?.[1]?.text).toBe("\nCurrent date: 2026-04-23\nCurrent working directory: /tmp/bar");
		expect(blocks?.[1]?.cache_control).toBeUndefined();
	});

	it("does not split when no known volatile tail is present", () => {
		const PROMPT = "You are helpful. Stay concise.";
		const blocks = buildAnthropicSystemBlocks(PROMPT, { cacheControl: { type: "ephemeral" } });
		expect(blocks).toBeDefined();
		expect(blocks?.length).toBe(1);
		expect(blocks?.[0]).toEqual({ type: "text", text: PROMPT, cache_control: { type: "ephemeral" } });
	});

	it("does not split when cacheControl is not provided (no caching)", () => {
		const PROMPT =
			"You are helpful.\nThe current working directory is '/tmp/foo'.\nToday is '2026-04-23'. Begin now.";
		const blocks = buildAnthropicSystemBlocks(PROMPT);
		expect(blocks).toBeDefined();
		expect(blocks?.length).toBe(1);
		expect(blocks?.[0]?.text).toBe(PROMPT);
		expect(blocks?.[0]?.cache_control).toBeUndefined();
	});

	it("splits correctly when the system prompt uses CRLF line endings (Windows checkout)", () => {
		const PROMPT =
			"You are helpful.\r\nStay concise.\r\nThe current working directory is '/tmp/foo'.\r\nToday is '2026-04-23'. Begin now.";
		const blocks = buildAnthropicSystemBlocks(PROMPT, { cacheControl: { type: "ephemeral" } });
		expect(blocks).toBeDefined();
		expect(blocks?.length).toBe(2);
		// stable ends just before the matched \n (i.e. at the \r of the CRLF)
		expect(blocks?.[0]?.text).toBe("You are helpful.\r\nStay concise.\r");
		expect(blocks?.[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(blocks?.[1]?.text).toBe(
			"\nThe current working directory is '/tmp/foo'.\r\nToday is '2026-04-23'. Begin now.",
		);
		expect(blocks?.[1]?.cache_control).toBeUndefined();
		// Critical: concatenated bytes match the original input exactly.
		expect((blocks ?? []).map(b => b.text).join("")).toBe(PROMPT);
	});

	it("falls back to single block when stable prefix would be empty", () => {
		// Pathological case: prompt starts with marker directly, so splitting
		// would yield stable="" which Anthropic rejects. Must fall back.
		const PROMPT = "\nThe current working directory is '/tmp'.\nToday is '2026-04-23'. Begin now.";
		const blocks = buildAnthropicSystemBlocks(PROMPT, { cacheControl: { type: "ephemeral" } });
		expect(blocks).toBeDefined();
		expect(blocks?.length).toBe(1);
		expect(blocks?.[0]?.text).toBe(PROMPT);
		expect(blocks?.[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("splits regardless of trailing whitespace after 'Begin now.'", () => {
		for (const trail of ["", "\n", "\n\n\n", "  ", "\t", " \n \n"]) {
			const PROMPT = `Header.\nThe current working directory is '/tmp'.\nToday is '2026-04-23'. Begin now.${trail}`;
			const blocks = buildAnthropicSystemBlocks(PROMPT, { cacheControl: { type: "ephemeral" } });
			expect(blocks?.length).toBe(2);
			expect(blocks?.[0]?.text).toBe("Header.");
		}
	});

	it("keeps billing block and Claude Code identity when splitting volatile tail", () => {
		const PROMPT =
			"You are helpful.\nThe current working directory is '/tmp/foo'.\nToday is '2026-04-23'. Begin now.";
		const blocks = buildAnthropicSystemBlocks(PROMPT, {
			includeClaudeCodeInstruction: true,
			cacheControl: { type: "ephemeral" },
		});
		expect(blocks).toBeDefined();
		// [0] billing header, [1] claudeCodeSystemInstruction, [2] stable-prefix+CC, [3] volatile-tail no CC
		expect(blocks?.length).toBe(4);
		expect(blocks?.[0]?.text.startsWith("x-anthropic-billing-header:")).toBe(true);
		expect(blocks?.[1]?.text).toBe(claudeCodeSystemInstruction);
		expect(blocks?.[2]?.text).toBe("You are helpful.");
		expect(blocks?.[2]?.cache_control).toEqual({ type: "ephemeral" });
		expect(blocks?.[3]?.text).toBe(
			"\nThe current working directory is '/tmp/foo'.\nToday is '2026-04-23'. Begin now.",
		);
		expect(blocks?.[3]?.cache_control).toBeUndefined();
	});

	it("skips Claude Code instruction injection for claude-3-5-haiku models", async () => {
		const payload = (await captureAnthropicPayload(
			{ ...ANTHROPIC_MODEL, id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
			{
				systemPrompt: "Stay concise.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
		)) as { system?: Array<{ type: string; text?: string }> };

		expect(Array.isArray(payload.system)).toBe(true);
		const systemBlocks = payload.system ?? [];
		expect(systemBlocks.some(block => block.text?.startsWith("x-anthropic-billing-header:"))).toBe(false);
		expect(systemBlocks[0]?.text).toBe("Stay concise.");
	});

	it("accepts uppercase hex in the user hash segment", () => {
		const userId =
			"user_ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD_account_12345678-1234-1234-1234-1234567890ab_session_abcdefab-cdef-abcd-efab-cdefabcdef12";
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("generates cloaking-compatible user IDs", () => {
		const userId = generateClaudeCloakingUserId();
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("injects generated metadata.user_id for OAuth requests when missing", async () => {
		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: "Stay concise.",
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		})) as { metadata?: { user_id?: string } };
		const userId = payload.metadata?.user_id;
		expect(typeof userId).toBe("string");
		expect(isClaudeCloakingUserId(userId ?? "")).toBe(true);
	});

	it("does not inject metadata.user_id for non-OAuth requests without caller metadata", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: "Stay concise.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ isOAuth: false },
		)) as { metadata?: { user_id?: string } };
		expect(payload.metadata).toBeUndefined();
	});

	it("preserves valid caller metadata.user_id for OAuth requests", async () => {
		const userId = generateClaudeCloakingUserId();
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: "Stay concise.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).toBe(userId);
	});

	it("replaces invalid caller metadata.user_id for OAuth requests", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: "Stay concise.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: "invalid-user-id" } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).not.toBe("invalid-user-id");
		expect(isClaudeCloakingUserId(payload.metadata?.user_id ?? "")).toBe(true);
	});
	it("drops fine-grained tool-streaming beta from default Anthropic client options", () => {
		const options = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-oat-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		const beta = options.defaultHeaders["Anthropic-Beta"];
		expect(beta).toContain("context-management-2025-06-27");
		expect(beta).not.toContain("fine-grained-tool-streaming-2025-05-14");
	});

	it("applies Claude Code TLS profile for direct Anthropic transport", () => {
		const options = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-oat-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		const tlsOptions = (
			options.fetchOptions as
				| {
						tls?: {
							rejectUnauthorized?: boolean;
							serverName?: string;
							ciphers?: string;
						};
				  }
				| undefined
		)?.tls;
		expect(tlsOptions).toBeDefined();
		expect(tlsOptions?.rejectUnauthorized).toBe(true);
		expect(tlsOptions?.serverName).toBe("api.anthropic.com");
		expect(tlsOptions?.ciphers).toBe(tls.DEFAULT_CIPHERS);
	});

	it("uses Foundry base URL, Bearer auth, and custom headers when enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_CUSTOM_HEADERS: "user-id: alice, x-route: engineering",
			},
			() => {
				const options = buildAnthropicClientOptions({
					model: ANTHROPIC_MODEL,
					apiKey: "foundry-token",
					extraBetas: [],
					stream: true,
					interleavedThinking: false,
					dynamicHeaders: {},
				});

				expect(options.baseURL).toBe("https://foundry.example.com/anthropic");
				expect(options.defaultHeaders.Authorization).toBe("Bearer foundry-token");
				expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
				expect(options.defaultHeaders["user-id"]).toBe("alice");
				expect(options.defaultHeaders["x-route"]).toBe("engineering");
			},
		);
	});

	it("loads Foundry mTLS and CA material from file paths", async () => {
		const tmpDir = path.join(os.tmpdir(), `pi-ai-foundry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		const caPath = path.join(tmpDir, "ca.pem");
		const certPath = path.join(tmpDir, "client-cert.pem");
		const keyPath = path.join(tmpDir, "client-key.pem");
		fs.writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n", "utf8");

		try {
			await withEnv(
				{
					CLAUDE_CODE_USE_FOUNDRY: "1",
					FOUNDRY_BASE_URL: "https://foundry.example.com",
					NODE_EXTRA_CA_CERTS: caPath,
					CLAUDE_CODE_CLIENT_CERT: certPath,
					CLAUDE_CODE_CLIENT_KEY: keyPath,
				},
				() => {
					const options = buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					});

					const tlsOptions = (
						options.fetchOptions as
							| {
									tls?: {
										serverName?: string;
										ca?: string | string[];
										cert?: string;
										key?: string;
									};
							  }
							| undefined
					)?.tls;
					expect(tlsOptions?.serverName).toBe("foundry.example.com");
					expect(Array.isArray(tlsOptions?.ca)).toBe(true);
					const caValues = (tlsOptions?.ca ?? []) as string[];
					expect(caValues.length).toBeGreaterThanOrEqual(tls.rootCertificates.length + 1);
					expect(caValues.slice(0, tls.rootCertificates.length)).toEqual([...tls.rootCertificates]);
					expect(caValues.at(-1)).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.cert).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.key).toContain("BEGIN PRIVATE KEY");
				},
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("throws when Foundry mTLS cert/key pair is incomplete", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com",
				CLAUDE_CODE_CLIENT_CERT: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n",
				CLAUDE_CODE_CLIENT_KEY: undefined,
			},
			() => {
				expect(() =>
					buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					}),
				).toThrow("Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.");
			},
		);
	});

	it("resolves Anthropic Foundry API key when Foundry mode is enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				ANTHROPIC_FOUNDRY_API_KEY: "foundry-env-token",
				ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-should-not-win",
				ANTHROPIC_API_KEY: "sk-ant-api-should-not-win",
			},
			() => {
				expect(getEnvApiKey("anthropic")).toBe("foundry-env-token");
			},
		);
	});

	it("treats tool prefix helpers as no-ops when prefix is empty", () => {
		expect(applyClaudeToolPrefix("Read", "")).toBe("Read");
		expect(stripClaudeToolPrefix("proxy_Read", "")).toBe("proxy_Read");
	});

	it("does not prefix built-in Anthropic tool names when prefix is configured", () => {
		expect(applyClaudeToolPrefix("web_search", "proxy_")).toBe("web_search");
		expect(applyClaudeToolPrefix("CODE_EXECUTION", "proxy_")).toBe("CODE_EXECUTION");
		expect(applyClaudeToolPrefix("Text_Editor", "proxy_")).toBe("Text_Editor");
		expect(applyClaudeToolPrefix("computer", "proxy_")).toBe("computer");
	});

	it("prefixes custom tool names when prefix is configured", () => {
		expect(applyClaudeToolPrefix("Read", "proxy_")).toBe("proxy_Read");
		expect(applyClaudeToolPrefix("proxy_Read", "proxy_")).toBe("proxy_Read");
		expect(stripClaudeToolPrefix("proxy_Read", "proxy_")).toBe("Read");
	});
});

describe("D19: volatile tail split under realistic user-agent compositions", () => {
	// ── Fixtures & helpers ──

	// Approximates the main OMP system prompt template. Size and shape matter —
	// the real default prompt is ~3-4KB, so tests that only exercise 100-byte
	// prompts can mask hot-spots the full one exposes.
	function renderDefaultPrompt(cwd: string, date: string): string {
		return [
			"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
			"",
			"═══════════ Identity ═══════════",
			"",
			"Distinguished staff engineer. High agency, principled judgment, decisive.",
			"Expertise: debugging, refactoring, and system design.",
			"",
			"═══════════ Rules ═══════════",
			"",
			"# Contract",
			"- MUST NOT yield unless the deliverable is complete.",
			"- MUST NOT fabricate outputs that were not observed.",
			"- MUST search for existing examples before implementing a new pattern.",
			"",
			"# Procedure",
			"1. Scope → read skills, plan, delegate when possible.",
			"2. Verify → run focused tests, typechecks, linters.",
			"",
			"═══════════ Now ═══════════",
			"",
			`The current working directory is '${cwd}'.`,
			`Today is '${date}'. Begin now.`,
		].join("\n");
	}

	// Seed-stable PRNG so adversarial/fuzz iterations are reproducible without
	// pulling in a seeded-random dependency.
	function mulberry32(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function hash(s: string): string {
		return Bun.hash(s).toString(36);
	}

	function stableBlockText(blocks: AnthropicSystemBlock[] | undefined): string {
		return blocks?.[0]?.text ?? "";
	}

	// Composition shim mirroring main.ts:523-530 (the third branch is the D19 target).
	function composePrompt(opts: { system?: string; default?: string; append?: string }): string {
		if (opts.system && opts.append) return `${opts.system}\n\n${opts.append}`;
		if (opts.system) return opts.system;
		if (opts.default && opts.append) return `${opts.default}\n\n${opts.append}`;
		return opts.default ?? "";
	}

	const ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" } as const;
	const CWDS = [
		"/home/coder/shared/oh-my-pi",
		"/home/coder/shared/oh-my-pi/packages/ai",
		"/home/coder/shared/oh-my-pi/packages/coding-agent",
		"/Users/alice/projects/my-app",
	];
	const DATES = ["2026-04-22", "2026-04-23", "2026-04-24", "2026-04-25"];

	// ── Baseline: default prompt without append (regression guard) ──

	it("baseline: default OMP prompt still splits at the same stable boundary across cwd+date rotation", () => {
		const hashes = new Set<string>();
		for (const cwd of CWDS) {
			for (const date of DATES) {
				const prompt = renderDefaultPrompt(cwd, date);
				const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
				expect(blocks?.length).toBe(2);
				expect(blocks?.[0]?.cache_control).toEqual(ANTHROPIC_CACHE_CONTROL);
				expect(blocks?.[1]?.cache_control).toBeUndefined();
				expect((blocks ?? []).map(b => b.text).join("")).toBe(prompt); // byte-exact roundtrip
				hashes.add(hash(blocks?.[0]?.text ?? ""));
			}
		}
		// Stable block must be byte-identical across all 16 rotation combinations.
		expect(hashes.size).toBe(1);
	});

	// ── Core D19 target: append-system-prompt composition ──

	it("append-only path: default + --append-system-prompt splits and keeps stable block constant across rotation", () => {
		const appendPrompt = "Extra instructions: never commit without explicit approval.";
		const hashes = new Set<string>();
		for (const cwd of CWDS) {
			for (const date of DATES) {
				const prompt = composePrompt({ default: renderDefaultPrompt(cwd, date), append: appendPrompt });
				const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
				expect(blocks?.length).toBe(2);
				expect(blocks?.[0]?.cache_control).toEqual(ANTHROPIC_CACHE_CONTROL);
				expect(blocks?.[1]?.cache_control).toBeUndefined();
				expect((blocks ?? []).map(b => b.text).join("")).toBe(prompt); // byte-exact
				// The tail block carries cwd+date AND the trailing append bytes.
				expect(blocks?.[1]?.text.includes(`The current working directory is '${cwd}'`)).toBe(true);
				expect(blocks?.[1]?.text.includes(`Today is '${date}'`)).toBe(true);
				expect(blocks?.[1]?.text.endsWith(appendPrompt)).toBe(true);
				hashes.add(hash(blocks?.[0]?.text ?? ""));
			}
		}
		expect(hashes.size).toBe(1);
	});

	it("append-only path with multi-paragraph append content (code fences, bullets, blanks)", () => {
		const appendPrompt = [
			"# Extra rules",
			"",
			"- Never modify `packages/coding-agent/src/prompts/`.",
			"- Prefer `bun fmt:ts` over `biome format` at repo root.",
			"",
			"```ts",
			"// Example of an acceptable Bun.file usage:",
			"const text = await Bun.file(path).text();",
			"```",
			"",
			"End of extra rules.",
		].join("\n");
		const hashes = new Set<string>();
		for (const date of DATES) {
			const prompt = composePrompt({
				default: renderDefaultPrompt("/repo", date),
				append: appendPrompt,
			});
			const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
			expect(blocks?.length).toBe(2);
			expect((blocks ?? []).map(b => b.text).join("")).toBe(prompt);
			expect(blocks?.[1]?.text.endsWith("End of extra rules.")).toBe(true);
			hashes.add(hash(blocks?.[0]?.text ?? ""));
		}
		expect(hashes.size).toBe(1);
	});

	it("append-only path with trailing whitespace and newlines (tolerates messy append content)", () => {
		for (const trail of ["", "\n", "\n\n\n", "  ", "\t", " \n \n", "\n\t\n\t\n"]) {
			const appendPrompt = `Extra: be concise.${trail}`;
			const prompt = composePrompt({
				default: renderDefaultPrompt("/repo", "2026-04-23"),
				append: appendPrompt,
			});
			const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
			expect(blocks?.length).toBe(2);
			expect((blocks ?? []).map(b => b.text).join("")).toBe(prompt);
			expect(blocks?.[0]?.cache_control).toEqual(ANTHROPIC_CACHE_CONTROL);
			expect(blocks?.[1]?.cache_control).toBeUndefined();
		}
	});

	// ── Custom-prompt (Current date / Current working directory) composition ──

	function renderCustomPrompt(cwd: string, date: string, preamble = "Custom system instructions."): string {
		return [preamble, `Current date: ${date}`, `Current working directory: ${cwd}`].join("\n");
	}

	it("custom tail + --append-system-prompt splits correctly with stable block constant across rotation", () => {
		const appendPrompt = "Additional rules for this session.";
		const hashes = new Set<string>();
		for (const cwd of CWDS) {
			for (const date of DATES) {
				const prompt = composePrompt({
					system: renderCustomPrompt(cwd, date),
					append: appendPrompt,
				});
				const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
				expect(blocks?.length).toBe(2);
				expect(blocks?.[0]?.text).toBe("Custom system instructions.");
				expect(blocks?.[0]?.cache_control).toEqual(ANTHROPIC_CACHE_CONTROL);
				expect(blocks?.[1]?.cache_control).toBeUndefined();
				expect((blocks ?? []).map(b => b.text).join("")).toBe(prompt);
				expect(blocks?.[1]?.text.endsWith(appendPrompt)).toBe(true);
				hashes.add(hash(blocks?.[0]?.text ?? ""));
			}
		}
		expect(hashes.size).toBe(1);
	});

	it("custom tail baseline (no append) still splits at the correct boundary", () => {
		const prompt = renderCustomPrompt("/tmp/bar", "2026-04-23");
		const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
		expect(blocks?.length).toBe(2);
		expect(blocks?.[0]?.text).toBe("Custom system instructions.");
		expect(blocks?.[1]?.text).toBe("\nCurrent date: 2026-04-23\nCurrent working directory: /tmp/bar");
	});

	// ── Safety: adversarial patterns that must NOT trigger a false-positive split ──

	it("does not split when marker appears inside quoted prose with no real newline prefix", () => {
		const prompts = [
			// Single-line paragraphs that embed the marker text without a leading `\n`.
			"Documentation example: 'The current working directory is '/foo'. Today is 'x'. Begin now.'",
			"Config reference: \"The current working directory is '/bar'. Today is 'y'. Begin now.\"",
			"Inline code: `The current working directory is '/baz'. Today is 'z'. Begin now.`",
		];
		for (const p of prompts) {
			const blocks = buildAnthropicSystemBlocks(p, { cacheControl: ANTHROPIC_CACHE_CONTROL });
			expect(blocks?.length).toBe(1);
			expect(blocks?.[0]?.text).toBe(p);
		}
	});

	it("does not split when marker is present but structure is broken (no date line)", () => {
		const broken = [
			"Intro.\nThe current working directory is '/here'. Then unrelated text.",
			"Intro.\nThe current working directory is '/here'.\nSome other line.\nBegin now.",
			"Intro.\nThe current working directory is '/here'.\nToday is 'x'. But no Begin now here.",
		];
		for (const p of broken) {
			const blocks = buildAnthropicSystemBlocks(p, { cacheControl: ANTHROPIC_CACHE_CONTROL });
			expect(blocks?.length).toBe(1);
			expect(blocks?.[0]?.text).toBe(p);
		}
	});

	it("does not split when no marker present at all", () => {
		const p = "You are helpful. Stay concise. No cwd or date context.";
		const blocks = buildAnthropicSystemBlocks(p, { cacheControl: ANTHROPIC_CACHE_CONTROL });
		expect(blocks?.length).toBe(1);
		expect(blocks?.[0]?.text).toBe(p);
	});

	it("picks the last tail via lastIndexOf when the prompt contains two tail-shaped segments", () => {
		const prompt = [
			"Prior session ended with:",
			"The current working directory is '/old'.",
			"Today is '2026-04-22'. Begin now.",
			"",
			"Resumed new session:",
			"The current working directory is '/new'.",
			"Today is '2026-04-23'. Begin now.",
		].join("\n");
		const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
		expect(blocks?.length).toBe(2);
		expect((blocks ?? []).map(b => b.text).join("")).toBe(prompt);
		// Last match wins: stable ends right before the second tail.
		expect(blocks?.[0]?.text.endsWith("Resumed new session:")).toBe(true);
		expect(blocks?.[1]?.text.startsWith("\nThe current working directory is '/new'")).toBe(true);
	});

	// ── splitVolatileTail contract invariants ──

	it("splitVolatileTail returns byte-exact roundtrip for every fuzz sample", () => {
		const rand = mulberry32(0x1337beef);
		for (let i = 0; i < 200; i++) {
			const pathLen = Math.floor(rand() * 256) + 1;
			const cwd = Array.from({ length: pathLen }, () => {
				const chars = "abcdefghijklmnopqrstuvwxyz0123456789-_./";
				return chars[Math.floor(rand() * chars.length)];
			}).join("");
			const date = `2026-${String(Math.floor(rand() * 12) + 1).padStart(2, "0")}-${String(Math.floor(rand() * 28) + 1).padStart(2, "0")}`;
			const prompt = renderDefaultPrompt(cwd, date);
			const appendLen = Math.floor(rand() * 4);
			const appendPrompt =
				appendLen > 0
					? Array.from({ length: appendLen }, () => `Rule #${Math.floor(rand() * 1000)}.`).join("\n")
					: "";
			const composed = appendPrompt ? `${prompt}\n\n${appendPrompt}` : prompt;
			const { stable, tail } = splitVolatileTail(composed);
			expect(stable + tail).toBe(composed);
			// When append is present, tail should still begin with the cwd marker.
			if (appendPrompt) {
				expect(tail.startsWith("\nThe current working directory is '")).toBe(true);
				expect(tail.endsWith(appendPrompt)).toBe(true);
			}
			// Stable bytes are constant for a given cwd-independent skeleton.
		}
	});

	it("splitVolatileTail stable bytes are invariant to cwd and date (with or without append content)", () => {
		const rand = mulberry32(0xfeedface);
		for (let i = 0; i < 100; i++) {
			const appendPrompt =
				rand() > 0.5 ? `Seed-${i}: ${Array.from({ length: (i % 7) + 1 }, () => "lorem ipsum ").join("")}` : "";
			const stables = new Set<string>();
			for (const cwd of CWDS) {
				for (const date of DATES) {
					const prompt = appendPrompt
						? `${renderDefaultPrompt(cwd, date)}\n\n${appendPrompt}`
						: renderDefaultPrompt(cwd, date);
					const { stable } = splitVolatileTail(prompt);
					stables.add(stable);
				}
			}
			expect(stables.size).toBe(1); // One stable value across all cwd+date combos for this append
		}
	});

	it("splitVolatileTail and stripVolatileTail always agree on the stable portion", () => {
		const rand = mulberry32(0xc0ffee);
		const samples = [
			renderDefaultPrompt("/x", "2026-04-23"),
			`${renderDefaultPrompt("/x", "2026-04-23")}\n\nextra`,
			renderCustomPrompt("/y", "2026-04-23"),
			`${renderCustomPrompt("/y", "2026-04-23")}\n\nextra`,
			"no tail here",
			"\nThe current working directory is '/z'.\nToday is '2026-04-23'. Begin now.",
		];
		for (let i = 0; i < 50; i++) {
			samples.push(`prefix${rand()}\n\n${renderDefaultPrompt(`/path-${i}`, "2026-04-23")}\n\ntrail${rand()}`);
		}
		for (const s of samples) {
			const { stable } = splitVolatileTail(s);
			expect(stripVolatileTail(s)).toBe(stable);
		}
	});

	// ── Multi-turn simulation: mimic a real agent session with rotation events ──

	it("multi-turn simulation: stable block hash stays byte-identical across mid-session cwd swap and date roll", () => {
		const appendPrompt = "Session-scoped rules: defer side effects, surface uncertainty.";
		const turns: Array<{ label: string; cwd: string; date: string }> = [
			{ label: "T1 fresh", cwd: "/home/me/app", date: "2026-04-22" },
			{ label: "T2 continue", cwd: "/home/me/app", date: "2026-04-22" },
			{ label: "T3 continue", cwd: "/home/me/app", date: "2026-04-22" },
			{ label: "T4 cwd swap", cwd: "/home/me/app/packages/server", date: "2026-04-22" },
			{ label: "T5 cwd continue", cwd: "/home/me/app/packages/server", date: "2026-04-22" },
			{ label: "T6 midnight", cwd: "/home/me/app/packages/server", date: "2026-04-23" },
			{ label: "T7 cwd back", cwd: "/home/me/app", date: "2026-04-23" },
			{ label: "T8 continue", cwd: "/home/me/app", date: "2026-04-23" },
		];
		const stableHashes = new Set<string>();
		const blockCounts = new Set<number>();
		for (const turn of turns) {
			const prompt = composePrompt({
				default: renderDefaultPrompt(turn.cwd, turn.date),
				append: appendPrompt,
			});
			const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
			expect(blocks?.length).toBe(2);
			// Every turn: stable has CC, tail does not, byte-exact roundtrip.
			expect(blocks?.[0]?.cache_control).toEqual(ANTHROPIC_CACHE_CONTROL);
			expect(blocks?.[1]?.cache_control).toBeUndefined();
			expect((blocks ?? []).map(b => b.text).join("")).toBe(prompt);
			stableHashes.add(hash(stableBlockText(blocks)));
			blockCounts.add(blocks?.length ?? -1);
		}
		expect(stableHashes.size).toBe(1); // stable block bytes constant through cwd swap + date roll
		expect(blockCounts.size).toBe(1); // block count stable (2) every turn
	});

	it("multi-turn simulation without append: existing Finding 2 behavior preserved (no regression)", () => {
		const turns = [
			{ cwd: "/home/me/app", date: "2026-04-22" },
			{ cwd: "/home/me/app/sub", date: "2026-04-22" },
			{ cwd: "/home/me/app/sub", date: "2026-04-23" },
			{ cwd: "/home/me/app", date: "2026-04-24" },
		];
		const stableHashes = new Set<string>();
		for (const turn of turns) {
			const prompt = renderDefaultPrompt(turn.cwd, turn.date);
			const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
			expect(blocks?.length).toBe(2);
			stableHashes.add(hash(stableBlockText(blocks)));
		}
		expect(stableHashes.size).toBe(1);
	});

	// ── buildAnthropicSystemBlocks invariants with cache_control under full composition ──

	it("never emits an empty text block when split is engaged (Anthropic API rejects empty blocks)", () => {
		const rand = mulberry32(0xdecafbad);
		for (let i = 0; i < 100; i++) {
			const stableLen = Math.floor(rand() * 500) + 1; // never zero: pre-tail content guaranteed
			const pre = "x".repeat(stableLen);
			const cwd = `/path/${Math.floor(rand() * 1000)}`;
			const date = "2026-04-23";
			const append = rand() > 0.5 ? `\n\nappend-${i}` : "";
			const prompt = `${pre}\nThe current working directory is '${cwd}'.\nToday is '${date}'. Begin now.${append}`;
			const blocks = buildAnthropicSystemBlocks(prompt, { cacheControl: ANTHROPIC_CACHE_CONTROL });
			expect(blocks).toBeDefined();
			for (const b of blocks ?? []) {
				expect(b.text.length).toBeGreaterThan(0);
			}
		}
	});

	it("preserves Claude Code identity block placement when split engages with append content", () => {
		const prompt = composePrompt({
			default: renderDefaultPrompt("/tmp/foo", "2026-04-23"),
			append: "Extra: always wrap CLI calls in $which.",
		});
		const blocks = buildAnthropicSystemBlocks(prompt, {
			includeClaudeCodeInstruction: true,
			cacheControl: ANTHROPIC_CACHE_CONTROL,
		});
		expect(blocks).toBeDefined();
		// Expected block order: [billing, claudeCodeInstruction, stable+CC, tail (no CC)]
		expect(blocks?.length).toBe(4);
		expect(blocks?.[0]?.text.startsWith("x-anthropic-billing-header:")).toBe(true);
		expect(blocks?.[1]?.text).toBe(claudeCodeSystemInstruction);
		expect(blocks?.[2]?.cache_control).toEqual(ANTHROPIC_CACHE_CONTROL);
		expect(blocks?.[3]?.cache_control).toBeUndefined();
		// Byte preservation across the prompt-visible portion ([2] stable + [3] tail).
		expect((blocks?.[2]?.text ?? "") + (blocks?.[3]?.text ?? "")).toBe(prompt);
		expect(blocks?.[3]?.text.endsWith("Extra: always wrap CLI calls in $which.")).toBe(true);
	});

	it("no cacheControl → no split even for append-composed prompts (strip-only code path)", () => {
		const prompt = composePrompt({
			default: renderDefaultPrompt("/x", "2026-04-23"),
			append: "Extra.",
		});
		const blocks = buildAnthropicSystemBlocks(prompt);
		expect(blocks?.length).toBe(1);
		expect(blocks?.[0]?.text).toBe(prompt);
		expect(blocks?.[0]?.cache_control).toBeUndefined();
	});

	// ── OpenAI-side cross-check: derivePromptCacheKey must still strip cleanly ──

	it("derivePromptCacheKey is invariant to cwd+date rotation for append-composed prompts", () => {
		const appendPrompt = "Per-session rules.";
		const keys = new Set<string>();
		for (const cwd of CWDS) {
			for (const date of DATES) {
				const prompt = composePrompt({
					default: renderDefaultPrompt(cwd, date),
					append: appendPrompt,
				});
				const key = derivePromptCacheKey("gpt-5.4", prompt, "session-xyz");
				if (key !== undefined) keys.add(key);
			}
		}
		expect(keys.size).toBe(1); // One cache key across all rotation variants for the same append content
	});

	it("derivePromptCacheKey collapses append variants onto the same routing key (append lives in tail)", () => {
		// The OpenAI routing key hashes only the stable prefix. Different append
		// contents share the same stable prefix, so they collapse onto the same
		// routing key — and that's correct: OpenAI still discriminates by content
		// hash server-side. What we want from the routing key is that cwd/date
		// rotation doesn't scatter warm prefixes.
		const defaultForKey = renderDefaultPrompt("/repo", "2026-04-23");
		const keyA = derivePromptCacheKey("gpt-5.4", `${defaultForKey}\n\nAppend A.`, "session-xyz");
		const keyB = derivePromptCacheKey("gpt-5.4", `${defaultForKey}\n\nAppend B.`, "session-xyz");
		const keyNone = derivePromptCacheKey("gpt-5.4", defaultForKey, "session-xyz");
		expect(keyA).toBe(keyB);
		expect(keyA).toBe(keyNone);
	});

	it("derivePromptCacheKey differs when the stable prefix itself differs", () => {
		const base = renderDefaultPrompt("/repo", "2026-04-23");
		const key1 = derivePromptCacheKey("gpt-5.4", base, "session-xyz");
		// Change stable content — a different system header before the tail marker.
		const different = base.replace("You are a Claude agent", "You are a DIFFERENT agent");
		const key2 = derivePromptCacheKey("gpt-5.4", different, "session-xyz");
		expect(key1).not.toBe(key2);
	});

	it("derivePromptCacheKey differs per model (routing isolation)", () => {
		const prompt = `${renderDefaultPrompt("/repo", "2026-04-23")}\n\nSome append.`;
		const keyA = derivePromptCacheKey("gpt-5.4", prompt, "session-xyz");
		const keyB = derivePromptCacheKey("gpt-4o", prompt, "session-xyz");
		expect(keyA).not.toBe(keyB);
	});
});
