/**
 * Google Vertex service-account flow: the broker stores the service-account
 * JSON as the OAuth `refresh` slot and mints short-lived access tokens from
 * it; clients only ever see the structured bearer metadata (no refresh).
 */
import { $env } from "@oh-my-pi/pi-utils";
import { mintVertexServiceAccountAccessToken, parseVertexServiceAccountJson } from "../../providers/google-auth";
import type { OAuthController, OAuthCredentials } from "./types";

export async function loginGoogleVertexHook(callbacks: OAuthController): Promise<OAuthCredentials> {
	if (!callbacks.onPrompt) {
		throw new Error("Vertex service-account login requires an interactive prompt");
	}
	const onPrompt = callbacks.onPrompt;
	const input = await onPrompt({
		message: "Paste the Google Cloud service-account JSON",
		placeholder: '{"type":"service_account",...}',
	});
	const serviceAccount = parseVertexServiceAccountJson(input.trim());
	const projectId =
		serviceAccount.project_id || $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	if (!projectId) {
		throw new Error("Vertex service-account credential is missing project_id");
	}
	const location =
		$env.GOOGLE_VERTEX_LOCATION ||
		$env.GOOGLE_CLOUD_LOCATION ||
		$env.VERTEX_LOCATION ||
		(
			await onPrompt({
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

export async function refreshGoogleVertexToken(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
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
	const token = await mintVertexServiceAccountAccessToken(serviceAccount, { signal });
	return {
		...credentials,
		access: token.accessToken,
		expires: Date.now() + token.expiresInMs,
		projectId,
		email: credentials.email || serviceAccount.client_email,
	};
}

export const refreshGoogleVertexHook = refreshGoogleVertexToken;
