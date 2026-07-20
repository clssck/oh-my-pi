import { describe, expect, it } from "bun:test";
import * as AIError from "../src/error";
import { OAuthCallbackFlow } from "../src/registry/oauth/callback-server";
import type { OAuthCredentials } from "../src/registry/oauth/types";
import { withEnv } from "./helpers";

class ModeFlow extends OAuthCallbackFlow {
	redirect?: string;

	constructor(onManualCodeInput: () => Promise<string>) {
		super(
			{ onManualCodeInput, onAuth: () => {} },
			{ preferredPort: 0, redirectUri: "https://example.test/callback" },
		);
	}

	async generateAuthUrl(_state: string, redirectUri: string): Promise<{ url: string }> {
		this.redirect = redirectUri;
		return { url: "https://example.test/authorize" };
	}

	async exchangeToken(_code: string, _state: string, _redirectUri: string): Promise<OAuthCredentials> {
		return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
	}
}

describe("generic OAuth callback mode", () => {
	it("uses manual input when explicitly enabled", async () => {
		await withEnv({ PI_OAUTH_CALLBACK_MODE: "manual" }, async () => {
			const flow = new ModeFlow(async () => "code");
			await expect(flow.login()).resolves.toMatchObject({ access: "access" });
			expect(flow.redirect).toBe("https://example.test/callback");
		});
	});

	it("preserves manual cancellation instead of retrying", async () => {
		await withEnv({ PI_OAUTH_CALLBACK_MODE: "manual" }, async () => {
			const flow = new ModeFlow(async () => "");
			await expect(flow.login()).rejects.toBeInstanceOf(AIError.LoginCancelledError);
		});
	});

	it("propagates manual input failures instead of retrying forever", async () => {
		await withEnv({ PI_OAUTH_CALLBACK_MODE: "manual" }, async () => {
			let attempts = 0;
			const flow = new ModeFlow(async () => {
				attempts += 1;
				throw new Error("manual input failed");
			});
			await expect(flow.login()).rejects.toThrow("manual input failed");
			expect(attempts).toBe(1);
		});
	});
});
