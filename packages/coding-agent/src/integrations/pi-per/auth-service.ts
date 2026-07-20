import { Buffer } from "node:buffer";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { getOAuthProviders, type OAuthAuthInfo, type OAuthPrompt, type OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth";
import { PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai/registry";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog";
import type { ModelRegistry } from "../../config/model-registry";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { RpcAuthProvider } from "../../modes/rpc/rpc-types";

interface AuthModelSession {
	modelRegistry: ModelRegistry;
}

export interface PiPerAuthServiceOptions {
	readonly session: AuthModelSession;
	readonly ui: ExtensionUIContext;
	readonly outputAuthUrl: (info: { url: string; launchUrl?: string; instructions?: string }) => void;
}

interface AuthProvider extends RpcAuthProvider {
	credentialId: string;
}

const DEEPINFRA_SOURCE = "pi-per:deepinfra";

export class PiPerAuthService {
	readonly #session: AuthModelSession;
	readonly #ui: ExtensionUIContext;
	readonly #outputAuthUrl: PiPerAuthServiceOptions["outputAuthUrl"];
	readonly #providers: AuthProvider[];

	constructor(options: PiPerAuthServiceOptions) {
		this.#session = options.session;
		this.#ui = options.ui;
		this.#outputAuthUrl = options.outputAuthUrl;
		this.#providers = this.#buildProviders();
	}
	async initialize(): Promise<void> {
		const key = await this.#session.modelRegistry.authStorage.peekApiKey("deepinfra");
		if (key) this.#registerDeepInfra(key);
	}

	listProviders(): RpcAuthProvider[] {
		return this.#providers.map(({ credentialId: _credentialId, ...provider }) => ({
			...provider,
			authenticated: this.#session.modelRegistry.authStorage.hasAuth(_credentialId),
		}));
	}

	/** Preserve the original RPC login-provider contract for existing clients. */
	listLoginProviders(): Array<{
		id: string;
		name: string;
		available: boolean;
		authenticated: boolean;
	}> {
		return getOAuthProviders().map(provider => ({
			id: provider.id,
			name: provider.name,
			available: provider.available,
			authenticated: this.#session.modelRegistry.authStorage.hasAuth(provider.id),
		}));
	}

	async login(providerId: string): Promise<void> {
		const provider = this.#provider(providerId);
		if (!provider.supportsOAuth) throw new Error("Provider does not support OAuth authentication");
		await this.#session.modelRegistry.authStorage.login(provider.id as never, {
			onAuth: (info: OAuthAuthInfo) => this.#outputAuthUrl(info),
			onProgress: (message: string) => this.#ui.notify(message, "info"),
			onPrompt: async (prompt: OAuthPrompt) => {
				const value = await this.#ui.input(
					prompt.message,
					prompt.placeholder,
					{ timeout: 600_000 },
					prompt.allowEmpty,
				);
				if (value === undefined) throw new LoginCancelledError("OAuth login cancelled");
				return value;
			},
		});
		await this.#session.modelRegistry.refresh();
	}

	async setApiKey(providerId: string, rawKey: string): Promise<void> {
		const provider = this.#provider(providerId);
		if (!provider.supportsApiKey) throw new Error("Provider does not support API-key authentication");
		const key = rawKey.trim();
		if (!key) throw new Error("API key cannot be empty");
		if (Buffer.byteLength(key, "utf8") > 4096) throw new Error("API key exceeds 4096 bytes");
		const storage = this.#session.modelRegistry.authStorage;
		await storage.set(provider.id, { type: "api_key", key, source: "login" });
		if (provider.id === "deepinfra") this.#registerDeepInfra(key);
		await this.#session.modelRegistry.refresh().catch(() => undefined);
	}

	async logout(providerId: string): Promise<void> {
		const provider = this.#provider(providerId);
		if (!provider.supportsOAuth && !provider.supportsApiKey)
			throw new Error("Provider does not support authentication");
		await this.#session.modelRegistry.authStorage.remove(provider.credentialId);
		if (provider.id === "deepinfra") this.#session.modelRegistry.clearSourceRegistrations(DEEPINFRA_SOURCE);
		const stillAuthenticated = this.#session.modelRegistry.authStorage.hasAuth(provider.credentialId);
		await this.#session.modelRegistry.refresh().catch(() => undefined);
		if (stillAuthenticated) {
			throw new Error("Provider credentials are managed outside Pi Per and remain active");
		}
	}

	#provider(providerId: string): AuthProvider {
		const provider = this.#providers.find(candidate => candidate.id === providerId);
		if (!provider) throw new Error("Unknown auth provider");
		return provider;
	}

	#buildProviders(): AuthProvider[] {
		const oauth = new Map<string, OAuthProviderInfo>(
			getOAuthProviders().map((provider: OAuthProviderInfo) => [provider.id, provider]),
		);
		const apiKeyIds = new Set(
			(CATALOG_PROVIDERS as ReadonlyArray<{ id: string; envVars?: readonly string[] }>)
				.filter(definition => definition.envVars?.length === 1)
				.map(definition => definition.id),
		);
		const providers: AuthProvider[] = [];
		for (const definition of PROVIDER_REGISTRY) {
			const oauthProvider = oauth.get(definition.id);
			const supportsApiKey = apiKeyIds.has(definition.id);
			if (!oauthProvider && !supportsApiKey) continue;
			providers.push({
				id: definition.id,
				name: oauthProvider?.name ?? definition.name,
				available: oauthProvider?.available ?? definition.available ?? true,
				authenticated: false,
				supportsOAuth: oauthProvider !== undefined,
				supportsApiKey,
				credentialId: oauthProvider?.storeCredentialsAs ?? definition.storeCredentialsAs ?? definition.id,
			});
		}
		for (const oauthProvider of oauth.values()) {
			if (providers.some(provider => provider.id === oauthProvider.id)) continue;
			providers.push({
				id: oauthProvider.id,
				name: oauthProvider.name,
				available: oauthProvider.available,
				authenticated: false,
				supportsOAuth: true,
				supportsApiKey: apiKeyIds.has(oauthProvider.id),
				credentialId: oauthProvider.storeCredentialsAs ?? oauthProvider.id,
			});
		}
		if (!providers.some(provider => provider.id === "deepinfra")) {
			providers.push({
				id: "deepinfra",
				name: "DeepInfra",
				available: true,
				authenticated: false,
				supportsOAuth: false,
				supportsApiKey: true,
				credentialId: "deepinfra",
			});
		}
		return providers;
	}

	#registerDeepInfra(apiKey: string): void {
		this.#session.modelRegistry.clearSourceRegistrations(DEEPINFRA_SOURCE);
		this.#session.modelRegistry.registerProvider(
			"deepinfra",
			{
				baseUrl: "https://api.deepinfra.com/v1/openai",
				apiKey,
				api: "openai-completions",
				models: [
					{
						id: "deepseek-ai/DeepSeek-V4-Flash",
						name: "DeepSeek V4 Flash",
						reasoning: false,
						input: ["text"],
						supportsTools: true,
						cost: { input: 0.09, output: 0.18, cacheRead: 0.018, cacheWrite: 0 },
						contextWindow: 1_048_576,
						maxTokens: 65_536,
						compat: {
							supportsStore: false,
							supportsReasoningEffort: false,
							maxTokensField: "max_tokens",
						},
					},
				],
			},
			DEEPINFRA_SOURCE,
		);
		this.#session.modelRegistry.authStorage.removeConfigApiKey("deepinfra");
	}
}

export function createPiPerAuthService(options: PiPerAuthServiceOptions): PiPerAuthService {
	return new PiPerAuthService(options);
}
