import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginRunInfra = createApiKeyLogin({
	providerLabel: "RunInfra",
	authUrl: "https://runinfra.ai",
	instructions: "Create or copy your RunInfra API key",
	promptMessage: "Paste your RunInfra API key",
	placeholder: "RunInfra API key",
	validation: {
		kind: "models-endpoint",
		provider: "runinfra",
		modelsUrl: "https://api.runinfra.ai/v1/models",
	},
});

export const runInfraProvider = {
	id: "runinfra",
	name: "RunInfra",
	login: (callbacks: OAuthLoginCallbacks) => loginRunInfra(callbacks),
} as const satisfies ProviderDefinition;
