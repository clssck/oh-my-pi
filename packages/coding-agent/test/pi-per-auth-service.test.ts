import { afterEach, describe, expect, it } from "bun:test";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import {
	getOAuthProvider,
	type OAuthAuthInfo,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
	registerOAuthProvider,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai/oauth";
import { PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai/registry";
import type { ExtensionUIContext } from "../src/extensibility/extensions";
import { PiPerAuthService } from "../src/integrations/pi-per/auth-service";

const SOURCE_ID = "test://pi-per-auth-service";
const OAUTH_CREDENTIALS: OAuthCredentials = {
	access: "test-access-token",
	refresh: "test-refresh-token",
	expires: Number.MAX_SAFE_INTEGER,
};

type InputHandler = ExtensionUIContext["input"];

interface InputCall {
	title: string;
	placeholder: string | undefined;
	dialogOptions: Parameters<InputHandler>[2];
	allowEmpty: boolean | undefined;
}

class FakeAuthStorage {
	readonly activeCredentialIds = new Set<string>();
	readonly managedCredentialIds = new Set<string>();
	readonly loginProviderIds: string[] = [];
	readonly removedCredentialIds: string[] = [];

	hasAuth(providerId: string): boolean {
		return this.activeCredentialIds.has(providerId);
	}

	async login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void> {
		this.loginProviderIds.push(providerId);
		const provider = getOAuthProvider(providerId as never);
		if (!provider) throw new Error(`Missing test OAuth provider: ${providerId}`);

		const credentials = await provider.login(callbacks);
		if (typeof credentials === "string") {
			if (credentials) this.activeCredentialIds.add(providerId);
			return;
		}
		this.activeCredentialIds.add(provider.storeCredentialsAs ?? providerId);
	}

	async remove(providerId: string): Promise<void> {
		this.removedCredentialIds.push(providerId);
		if (!this.managedCredentialIds.has(providerId)) {
			this.activeCredentialIds.delete(providerId);
		}
	}
}

function registerTestProvider(
	id: string,
	login: OAuthProviderInterface["login"],
	options: { storeCredentialsAs?: string } = {},
): void {
	registerOAuthProvider({
		id: id as never,
		name: `Pi Per test ${id}`,
		sourceId: SOURCE_ID,
		...options,
		login,
	});
}

function createService(options: { input?: InputHandler } = {}) {
	const authStorage = new FakeAuthStorage();
	const inputCalls: InputCall[] = [];
	const authUrls: OAuthAuthInfo[] = [];
	let refreshCalls = 0;
	const input: InputHandler = async (title, placeholder, dialogOptions, allowEmpty) => {
		inputCalls.push({ title, placeholder, dialogOptions, allowEmpty });
		return options.input?.(title, placeholder, dialogOptions, allowEmpty);
	};

	const service = new PiPerAuthService({
		session: {
			modelRegistry: {
				authStorage,
				refresh: async () => {
					refreshCalls += 1;
				},
			} as never,
		},
		ui: {
			input,
			notify: () => {},
		} as unknown as ExtensionUIContext,
		outputAuthUrl: (info: OAuthAuthInfo) => authUrls.push(info),
	});

	return {
		service,
		authStorage,
		inputCalls,
		authUrls,
		get refreshCalls() {
			return refreshCalls;
		},
	};
}

afterEach(() => {
	unregisterOAuthProviders(SOURCE_ID);
});

describe("PiPerAuthService", () => {
	it("forwards empty pre-auth prompt responses when the provider allows them", async () => {
		const providerId = "pi-per-test-pre-auth-prompt";
		const events: string[] = [];
		let promptValue: string | undefined;
		registerTestProvider(providerId, async callbacks => {
			events.push("login");
			promptValue = await callbacks.onPrompt({
				message: "Optional organization",
				placeholder: "Leave empty for personal account",
				allowEmpty: true,
			});
			events.push("prompt");
			callbacks.onAuth({ url: "https://example.test/authorize" });
			events.push("auth");
			return { ...OAUTH_CREDENTIALS };
		});
		const fixture = createService({ input: async () => "" });

		await fixture.service.login(providerId);

		expect(fixture.inputCalls).toEqual([
			{
				title: "Optional organization",
				placeholder: "Leave empty for personal account",
				dialogOptions: { timeout: 600_000 },
				allowEmpty: true,
			},
		]);
		expect(promptValue).toBe("");
		expect(events).toEqual(["login", "prompt", "auth"]);
		expect(fixture.authUrls).toEqual([{ url: "https://example.test/authorize" }]);
		expect(fixture.authStorage.loginProviderIds).toEqual([providerId]);
		expect(fixture.refreshCalls).toBe(1);
	});

	it("rejects UI prompt cancellation with LoginCancelledError without retrying", async () => {
		const providerId = "pi-per-test-cancelled-prompt";
		let loginCalls = 0;
		registerTestProvider(providerId, async callbacks => {
			loginCalls += 1;
			await callbacks.onPrompt({ message: "Enter verification code" });
			throw new Error("OAuth login continued after cancellation");
		});
		const fixture = createService({ input: async () => undefined });

		await expect(fixture.service.login(providerId)).rejects.toBeInstanceOf(LoginCancelledError);

		expect(loginCalls).toBe(1);
		expect(fixture.inputCalls).toHaveLength(1);
		expect(fixture.refreshCalls).toBe(0);
		expect(fixture.authStorage.hasAuth(providerId)).toBe(false);
	});

	it("lists, routes, and removes dynamically registered OAuth credentials by their storage alias", async () => {
		const providerId = "pi-per-test-dynamic-oauth";
		const credentialId = "pi-per-test-shared-credential";
		let loginCalls = 0;
		expect(PROVIDER_REGISTRY.some(provider => provider.id === providerId)).toBe(false);
		registerTestProvider(
			providerId,
			async callbacks => {
				loginCalls += 1;
				callbacks.onAuth({ url: "https://example.test/dynamic-authorize" });
				return { ...OAUTH_CREDENTIALS };
			},
			{ storeCredentialsAs: credentialId },
		);
		const fixture = createService();

		expect(fixture.service.listProviders().find(provider => provider.id === providerId)).toEqual({
			id: providerId,
			name: `Pi Per test ${providerId}`,
			available: true,
			authenticated: false,
			supportsOAuth: true,
			supportsApiKey: false,
		});

		await fixture.service.login(providerId);

		expect(loginCalls).toBe(1);
		expect(fixture.authStorage.loginProviderIds).toEqual([providerId]);
		expect(fixture.authStorage.hasAuth(credentialId)).toBe(true);
		expect(fixture.service.listProviders().find(provider => provider.id === providerId)?.authenticated).toBe(true);

		await fixture.service.logout(providerId);

		expect(fixture.authStorage.removedCredentialIds).toEqual([credentialId]);
		expect(fixture.authStorage.hasAuth(credentialId)).toBe(false);
		expect(fixture.service.listProviders().find(provider => provider.id === providerId)?.authenticated).toBe(false);
		expect(fixture.refreshCalls).toBe(2);
	});

	it("rejects logout when an externally managed credential remains active", async () => {
		const providerId = "pi-per-test-managed-credential";
		registerTestProvider(providerId, async () => ({ ...OAUTH_CREDENTIALS }));
		const fixture = createService();
		fixture.authStorage.activeCredentialIds.add(providerId);
		fixture.authStorage.managedCredentialIds.add(providerId);

		await expect(fixture.service.logout(providerId)).rejects.toThrow(
			"Provider credentials are managed outside Pi Per and remain active",
		);

		expect(fixture.authStorage.removedCredentialIds).toEqual([providerId]);
		expect(fixture.authStorage.hasAuth(providerId)).toBe(true);
		expect(fixture.refreshCalls).toBe(1);
	});
});
