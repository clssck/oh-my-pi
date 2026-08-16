import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env } from "@oh-my-pi/pi-utils";
import { mintVertexServiceAccountAccessToken, parseVertexServiceAccountJson } from "../providers/google-auth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import { AUTHENTICATED_SENTINEL, type ProviderDefinition } from "./types";

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		const gacPath = $env.GOOGLE_APPLICATION_CREDENTIALS;
		if (gacPath) {
			cachedVertexAdcCredentialsExists = fs.existsSync(gacPath);
		} else {
			cachedVertexAdcCredentialsExists = fs.existsSync(
				path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

export async function loginGoogleVertex(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const input = await callbacks.onPrompt({
		message: "Paste the Google Cloud service-account JSON",
		placeholder: '{"type":"service_account",...}',
	});
	const serviceAccount = parseVertexServiceAccountJson(input.trim());
	const projectId = serviceAccount.project_id || $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	if (!projectId) {
		throw new Error("Vertex service-account credential is missing project_id");
	}
	const location =
		$env.GOOGLE_VERTEX_LOCATION ||
		$env.GOOGLE_CLOUD_LOCATION ||
		$env.VERTEX_LOCATION ||
		(
			await callbacks.onPrompt({
				message: "Vertex location (leave blank for global)",
				placeholder: "global",
				allowEmpty: true,
			})
		).trim() ||
		"global";
	const token = await mintVertexServiceAccountAccessToken(serviceAccount, {
		signal: callbacks.signal,
		fetch: callbacks.fetch,
	});
	return {
		refresh: JSON.stringify(serviceAccount),
		access: token.accessToken,
		expires: Date.now() + token.expiresInMs,
		projectId,
		location,
		email: serviceAccount.client_email,
	};
}

export async function refreshGoogleVertexToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const serviceAccount = parseVertexServiceAccountJson(credentials.refresh);
	const projectId =
		credentials.projectId ||
		serviceAccount.project_id ||
		$env.GOOGLE_CLOUD_PROJECT ||
		$env.GCP_PROJECT ||
		$env.GCLOUD_PROJECT;
	if (!projectId) {
		throw new Error("Vertex service-account credential is missing project_id");
	}
	const token = await mintVertexServiceAccountAccessToken(serviceAccount);
	return {
		...credentials,
		access: token.accessToken,
		expires: Date.now() + token.expiresInMs,
		projectId,
		email: credentials.email || serviceAccount.client_email,
	};
}

export const googleVertexProvider = {
	id: "google-vertex",
	name: "Google Vertex AI",
	login: loginGoogleVertex,
	refreshToken: refreshGoogleVertexToken,
	// Vertex AI supports either GOOGLE_CLOUD_API_KEY or Application Default Credentials.
	envKeys: () => {
		if ($env.GOOGLE_CLOUD_API_KEY) {
			return $env.GOOGLE_CLOUD_API_KEY;
		}
		const hasCredentials = hasVertexAdcCredentials();
		const hasProject = !!($env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT);
		const hasLocation = !!($env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION);
		if (hasCredentials && hasProject && hasLocation) {
			return AUTHENTICATED_SENTINEL;
		}
	},
} as const satisfies ProviderDefinition;
