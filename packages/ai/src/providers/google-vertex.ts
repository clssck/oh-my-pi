import { resolveVertexEndpointHost } from "@oh-my-pi/pi-catalog/hosts";
import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Context, Model, StreamFunction } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { getVertexAccessToken } from "./google-auth";
import {
	buildGoogleGenerateContentParams,
	type GoogleGenAIRequestPlan,
	type GoogleSharedStreamOptions,
	streamGoogleGenAI,
} from "./google-shared";

export interface GoogleVertexOptions extends GoogleSharedStreamOptions {
	project?: string;
	location?: string;
}

const API_VERSION = "v1";

export interface VertexBrokerCredential {
	token: string;
	projectId?: string;
	location?: string;
}

export function parseVertexBrokerCredential(value: string | undefined): VertexBrokerCredential | undefined {
	if (!value?.trimStart().startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new AIError.ConfigurationError("Vertex broker credential contains invalid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new AIError.ConfigurationError("Vertex broker credential must be a JSON object");
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.token !== "string" || record.token.length === 0) {
		throw new AIError.ConfigurationError("Vertex broker credential is missing token");
	}
	if (record.projectId !== undefined && typeof record.projectId !== "string") {
		throw new AIError.ConfigurationError("Vertex broker credential has an invalid projectId");
	}
	if (record.location !== undefined && typeof record.location !== "string") {
		throw new AIError.ConfigurationError("Vertex broker credential has an invalid location");
	}
	return {
		token: record.token,
		...(record.projectId ? { projectId: record.projectId } : {}),
		...(record.location ? { location: record.location } : {}),
	};
}

export const streamGoogleVertex: StreamFunction<"google-vertex"> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	return streamGoogleGenAI({
		model,
		options,
		api: "google-vertex",
		retainTextSignature: true,
		prepare: async (): Promise<GoogleGenAIRequestPlan> => {
			const credential = resolveApiKey(options);
			const brokerCredential = parseVertexBrokerCredential(credential);
			const params = buildGoogleGenerateContentParams(model, context, options ?? {});
			params.config ||= {};
			if (!params.config.safetySettings) {
				params.config.safetySettings = [
					{
						category: "HARM_CATEGORY_HATE_SPEECH",
						threshold: "OFF",
					},
					{
						category: "HARM_CATEGORY_DANGEROUS_CONTENT",
						threshold: "OFF",
					},
					{
						category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
						threshold: "OFF",
					},
					{
						category: "HARM_CATEGORY_HARASSMENT",
						threshold: "OFF",
					},
				];
			}
			const baseHeaders: Record<string, string> = {
				...(model.headers ?? {}),
				...(options?.headers ?? {}),
			};
			// Vertex AI ignores a `serviceTier` request-body field (unlike the direct
			// Gemini API); priority must travel as a request header. Only `priority`
			// has a documented Vertex request control — `flex` has none, so it's a no-op.
			if (options?.serviceTier === "priority") {
				baseHeaders["X-Vertex-AI-LLM-Shared-Request-Type"] = "priority";
			}

			if (brokerCredential) {
				const project = resolveProject(options, brokerCredential.projectId);
				const location = resolveLocation(options, brokerCredential.location);
				const host = resolveVertexEndpointHost(location);
				const url = `https://${host}/${API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
				return {
					params,
					url,
					headers: { ...baseHeaders, Authorization: `Bearer ${brokerCredential.token}` },
					fetch: options?.fetch,
				};
			}
			if (credential) {
				// Explicit `location` is a deliberate residency choice: honor it and let
				// a 404 surface. An ambient env-derived region falls back to the global
				// endpoint so a stray GOOGLE_*_LOCATION never breaks a previously-working
				// global-only request.
				const explicitLocation = options?.location;
				const location = explicitLocation ?? resolveAmbientLocation() ?? "global";
				const host = resolveVertexEndpointHost(location);
				const path = `${API_VERSION}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
				const useGlobalFallback = !explicitLocation && host !== "aiplatform.googleapis.com";
				return {
					params,
					url: `https://${host}/${path}`,
					fallbackUrl: useGlobalFallback ? `https://aiplatform.googleapis.com/${path}` : undefined,
					headers: {
						...baseHeaders,
						"x-goog-api-key": credential,
					},
					fetch: options?.fetch,
				};
			}

			const project = resolveProject(options);
			const location = resolveLocation(options);
			const accessToken = await getVertexAccessToken({ signal: options?.signal, fetch: options?.fetch });
			const host = resolveVertexEndpointHost(location);
			const url = `https://${host}/${API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
			return {
				params,
				url,
				headers: { ...baseHeaders, Authorization: `Bearer ${accessToken}` },
				fetch: options?.fetch,
			};
		},
	});
};

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	// options.apiKey may contain sentinel values like "<authenticated>" or "N/A"
	// leaked from the agent loop — only use it if it looks like a real API key.
	const optKey = options?.apiKey;
	const realKey = optKey && !optKey.startsWith("<") && optKey !== "N/A" ? optKey : undefined;
	return realKey || $env.GOOGLE_CLOUD_API_KEY;
}

function resolveProject(options: GoogleVertexOptions | undefined, credentialProject?: string): string {
	const project =
		options?.project || credentialProject || $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	if (!project) {
		throw new AIError.ConfigurationError(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCP_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveAmbientLocation(): string | undefined {
	return $env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION || undefined;
}
function resolveOptionalLocation(options?: GoogleVertexOptions, credentialLocation?: string): string | undefined {
	return options?.location || credentialLocation || resolveAmbientLocation();
}
function resolveLocation(options?: GoogleVertexOptions, credentialLocation?: string): string {
	const location = resolveOptionalLocation(options, credentialLocation);
	if (!location) {
		throw new AIError.ConfigurationError(
			"Vertex AI requires a location. Set GOOGLE_VERTEX_LOCATION/GOOGLE_CLOUD_LOCATION/VERTEX_LOCATION or pass location in options.",
		);
	}
	return location;
}
