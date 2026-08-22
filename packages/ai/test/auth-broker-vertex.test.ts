import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";
import { refreshGoogleVertexToken } from "../src/registry/google-vertex";

async function generateServiceAccountPem(): Promise<string> {
	const keyPair = (await globalThis.crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
	const body = (
		Buffer.from(pkcs8)
			.toString("base64")
			.match(/.{1,64}/g) ?? []
	).join("\n");
	return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

describe("auth-broker Vertex service-account isolation", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	let clientStorage: AuthStorage | undefined;
	let originalFetch: typeof fetch;
	const brokerToken = "vertex-broker-test-token";

	beforeEach(async () => {
		originalFetch = globalThis.fetch;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-vertex-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.reload();
		const serviceAccountJson = JSON.stringify({
			type: "service_account",
			client_email: "vertex-broker@example.iam.gserviceaccount.com",
			private_key: await generateServiceAccountPem(),
			private_key_id: "broker-key-1",
			project_id: "broker-project",
		});
		await serverStorage.set("google-vertex", {
			type: "oauth",
			refresh: serviceAccountJson,
			access: "cached-access-token",
			expires: Date.now() + 3_600_000,
			projectId: "broker-project",
			location: "europe-west4",
			email: "vertex-broker@example.iam.gserviceaccount.com",
		});
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [brokerToken],
			disableRefresher: true,
		});
		remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token: brokerToken, fetchImpl: originalFetch }),
			streamSnapshots: false,
		});
		await remote.refreshSnapshot();
		clientStorage = new AuthStorage(remote);
		await clientStorage.reload();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clientStorage?.close();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		await removeWithRetries(tempDir);
	});

	test("mints at the broker and exposes only bearer metadata to clients", async () => {
		const tokenRequests: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					const url = input instanceof Request ? input.url : input.toString();
					if (url === "https://oauth2.googleapis.com/token") {
						tokenRequests.push(String(init?.body));
						return Response.json({ access_token: "fresh-broker-token", expires_in: 3600 });
					}
					return originalFetch(input, init);
				},
				{ preconnect: originalFetch.preconnect },
			),
		);

		const brokerClient = new AuthBrokerClient({
			url: handle!.url,
			token: brokerToken,
			fetchImpl: originalFetch,
		});
		const [stored] = remote!.listAuthCredentials("google-vertex");
		if (!stored) throw new Error("expected stored Vertex credential");
		await brokerClient.refreshCredential(stored.id);
		await remote!.refreshSnapshot();

		const apiKey = await clientStorage!.getApiKey("google-vertex");
		expect(tokenRequests).toHaveLength(1);
		expect(apiKey).not.toBe(REMOTE_REFRESH_SENTINEL);
		expect(JSON.parse(apiKey!)).toEqual({
			token: "fresh-broker-token",
			projectId: "broker-project",
			location: "europe-west4",
			expiresAt: expect.any(Number),
			email: "vertex-broker@example.iam.gserviceaccount.com",
		});
		expect(new URLSearchParams(tokenRequests[0]).get("grant_type")).toBe(
			"urn:ietf:params:oauth:grant-type:jwt-bearer",
		);

		const snapshot = await brokerClient.fetchSnapshot();
		if (snapshot.status !== 200) throw new Error("expected snapshot");
		const entry = snapshot.snapshot.credentials.find(candidate => candidate.provider === "google-vertex");
		expect(entry?.credential.type).toBe("oauth");
		if (entry?.credential.type !== "oauth") throw new Error("expected OAuth credential");
		expect(entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		expect(entry.credential.location).toBe("europe-west4");
		expect(JSON.stringify(snapshot.snapshot)).not.toContain("PRIVATE KEY");
		expect(serverStore!.getOAuth("google-vertex")?.refresh).toContain("PRIVATE KEY");
	});
	test("forwards refresh cancellation to the Google token exchange", async () => {
		const serviceAccountJson = JSON.stringify({
			type: "service_account",
			client_email: "vertex-refresh@example.iam.gserviceaccount.com",
			private_key: await generateServiceAccountPem(),
			project_id: "refresh-project",
		});
		const controller = new AbortController();
		let requestSignal: AbortSignal | null | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					requestSignal = init?.signal;
					return Response.json({ access_token: "refreshed-access-token", expires_in: 3600 });
				},
				{ preconnect: originalFetch.preconnect },
			),
		);

		const refreshed = await refreshGoogleVertexToken(
			{
				refresh: serviceAccountJson,
				access: "stale-access-token",
				expires: 0,
				projectId: "refresh-project",
			},
			controller.signal,
		);

		expect(requestSignal).toBe(controller.signal);
		expect(refreshed.access).toBe("refreshed-access-token");
	});
});
