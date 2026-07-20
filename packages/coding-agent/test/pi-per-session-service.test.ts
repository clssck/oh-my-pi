import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getConfigRootDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { PiPerSessionService } from "../src/integrations/pi-per/session-service";

const SESSION_TIMESTAMP = "2025-02-03T04:05:06.000Z";
const SESSION_MTIME = new Date(SESSION_TIMESTAMP);
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const symlinkIt = process.platform === "win32" ? it.skip : it;

let root: string;
let agentDir: string;
let sessionDir: string;

interface SessionFixtureOptions {
	id?: string;
	title?: string;
	firstMessage?: string;
	modified?: Date;
}

interface TreeSnapshotEntry {
	relativePath: string;
	type: "directory" | "file" | "symlink";
	content?: string;
	target?: string;
}

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-pi-per-session-service-"));
	agentDir = path.join(root, "agent");
	setAgentDir(agentDir);
	sessionDir = path.join(getSessionsDir(agentDir), "project");
	await fsp.mkdir(sessionDir, { recursive: true });
});

afterEach(async () => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await fsp.rm(root, { recursive: true, force: true });
});

async function writeSessionIn(directory: string, name: string, options: SessionFixtureOptions = {}): Promise<string> {
	await fsp.mkdir(directory, { recursive: true });
	const sessionPath = path.join(directory, `${name}.jsonl`);
	const id = options.id ?? `${name}-id`;
	const title = options.title ?? `${name} title`;
	const firstMessage = options.firstMessage ?? `First message for ${name}`;
	const entries = [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: SESSION_TIMESTAMP,
			cwd: "/workspace/pi-per",
			title,
		}),
		JSON.stringify({ type: "message", message: { role: "user", content: firstMessage } }),
		JSON.stringify({
			type: "message",
			message: { role: "assistant", content: "Session complete." },
		}),
	];
	await fsp.writeFile(sessionPath, `${entries.join("\n")}\n`);
	const modified = options.modified ?? SESSION_MTIME;
	await fsp.utimes(sessionPath, modified, modified);
	return sessionPath;
}

function writeSession(name: string, options: SessionFixtureOptions = {}): Promise<string> {
	return writeSessionIn(sessionDir, name, options);
}

function artifactsDir(sessionPath: string): string {
	return sessionPath.slice(0, -".jsonl".length);
}

async function writeArtifact(sessionPath: string, name = "0.bash.log"): Promise<string> {
	const artifactPath = path.join(artifactsDir(sessionPath), name);
	await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
	await fsp.writeFile(artifactPath, `artifact for ${path.basename(sessionPath)}`);
	return artifactPath;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fsp.lstat(target);
		return true;
	} catch {
		return false;
	}
}

async function snapshotTree(directory: string, treeRoot = directory): Promise<TreeSnapshotEntry[]> {
	const entries = await fsp.readdir(directory, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const snapshot: TreeSnapshotEntry[] = [];
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		const relativePath = path.relative(treeRoot, entryPath);
		if (entry.isDirectory()) {
			snapshot.push({ relativePath, type: "directory" });
			snapshot.push(...(await snapshotTree(entryPath, treeRoot)));
		} else if (entry.isSymbolicLink()) {
			snapshot.push({ relativePath, type: "symlink", target: await fsp.readlink(entryPath) });
		} else {
			snapshot.push({ relativePath, type: "file", content: await fsp.readFile(entryPath, "utf8") });
		}
	}
	return snapshot;
}

function createService(
	options: {
		sessionFile?: string;
		sessionDirectory?: string;
		newSession?: () => Promise<boolean>;
		onActiveSessionChanged?: () => Promise<void>;
		clearSubagents?: () => void;
	} = {},
): PiPerSessionService {
	return new PiPerSessionService({
		session: {
			sessionFile: options.sessionFile,
			sessionManager: { getSessionDir: () => options.sessionDirectory ?? sessionDir },
			newSession: options.newSession ?? (async () => true),
		},
		...(options.onActiveSessionChanged ? { onActiveSessionChanged: options.onActiveSessionChanged } : {}),
		...(options.clearSubagents ? { clearSubagents: options.clearSubagents } : {}),
	});
}

async function expectInvalidTargetWithoutMutation(service: PiPerSessionService, target: string): Promise<void> {
	const before = await snapshotTree(root);
	await expect(service.delete(target)).rejects.toThrow("Invalid session target");
	expect(await snapshotTree(root)).toEqual(before);
}

describe("PiPerSessionService", () => {
	it("maps a real JSONL session into an OmpSessionSummary", async () => {
		const sessionPath = await writeSession("inventory", {
			id: "inventory-id",
			title: "Pi Per inventory",
			firstMessage: "Reconnect the desktop client",
		});

		await expect(createService().list()).resolves.toEqual([
			{
				path: sessionPath,
				id: "inventory-id",
				title: "Pi Per inventory",
				firstMessage: "Reconnect the desktop client",
				modified: SESSION_TIMESTAMP,
				messageCount: 2,
				status: "complete",
			},
		]);
	});

	it("rejects arbitrary, unlisted, and missing targets without mutation", async () => {
		const listedPath = await writeSession("listed");
		const arbitraryPath = await writeSessionIn(path.join(root, "arbitrary"), "outside");
		const unlistedPath = path.join(sessionDir, "not-a-session.jsonl");
		const missingPath = path.join(sessionDir, "missing.jsonl");
		await fsp.writeFile(unlistedPath, '{"type":"not-a-session"}\n');

		let newSessionCalls = 0;
		let activeSessionChangedCalls = 0;
		let clearSubagentsCalls = 0;
		const service = createService({
			sessionFile: listedPath,
			newSession: async () => {
				newSessionCalls++;
				return true;
			},
			onActiveSessionChanged: async () => {
				activeSessionChangedCalls++;
			},
			clearSubagents: () => {
				clearSubagentsCalls++;
			},
		});

		for (const target of [arbitraryPath, unlistedPath, missingPath]) {
			await expectInvalidTargetWithoutMutation(service, target);
		}

		expect(await pathExists(listedPath)).toBe(true);
		expect(newSessionCalls).toBe(0);
		expect(activeSessionChangedCalls).toBe(0);
		expect(clearSubagentsCalls).toBe(0);
	});

	symlinkIt("rejects a final symlink session target without mutation", async () => {
		const sessionPath = await writeSession("listed");
		const symlinkPath = path.join(sessionDir, "linked.jsonl");
		await fsp.symlink(sessionPath, symlinkPath);
		const service = createService();

		await expectInvalidTargetWithoutMutation(service, symlinkPath);

		expect(await pathExists(sessionPath)).toBe(true);
		expect(await pathExists(symlinkPath)).toBe(true);
	});

	symlinkIt("rejects a listed session below a symlinked session directory without mutation", async () => {
		const externalSessionDir = path.join(root, "external-sessions");
		const externalSessionPath = await writeSessionIn(externalSessionDir, "escaped", {
			id: "escaped-id",
		});
		const linkedSessionDir = path.join(root, "linked-sessions");
		await fsp.symlink(externalSessionDir, linkedSessionDir);
		const targetPath = path.join(linkedSessionDir, path.basename(externalSessionPath));
		const service = createService({ sessionDirectory: linkedSessionDir });

		expect(await service.list()).toEqual([expect.objectContaining({ path: targetPath, id: "escaped-id" })]);
		await expectInvalidTargetWithoutMutation(service, targetPath);

		expect(await pathExists(externalSessionPath)).toBe(true);
	});

	it("deletes an inactive listed transcript and its sibling artifacts", async () => {
		const inactivePath = await writeSession("inactive", { id: "inactive-id" });
		const artifactPath = await writeArtifact(inactivePath);
		const activePath = await writeSession("active", { id: "active-id" });
		let newSessionCalls = 0;
		let activeSessionChangedCalls = 0;
		let clearSubagentsCalls = 0;
		const service = createService({
			sessionFile: activePath,
			newSession: async () => {
				newSessionCalls++;
				return true;
			},
			onActiveSessionChanged: async () => {
				activeSessionChangedCalls++;
			},
			clearSubagents: () => {
				clearSubagentsCalls++;
			},
		});

		expect((await service.list()).map(session => session.path)).toContain(inactivePath);
		await expect(service.delete(inactivePath)).resolves.toEqual({
			path: inactivePath,
			activeSessionChanged: false,
		});

		expect(await pathExists(inactivePath)).toBe(false);
		expect(await pathExists(artifactsDir(inactivePath))).toBe(false);
		expect(await pathExists(artifactPath)).toBe(false);
		expect(await pathExists(activePath)).toBe(true);
		expect(newSessionCalls).toBe(0);
		expect(activeSessionChangedCalls).toBe(0);
		expect(clearSubagentsCalls).toBe(0);
	});

	it("rotates an active session before deleting it and notifies its callbacks", async () => {
		const activePath = await writeSession("active", { id: "active-id" });
		await writeArtifact(activePath);
		const freshPath = path.join(sessionDir, "fresh.jsonl");
		let activeSessionPath: string | undefined = activePath;
		const events: string[] = [];
		const service = new PiPerSessionService({
			session: {
				get sessionFile() {
					return activeSessionPath;
				},
				sessionManager: { getSessionDir: () => sessionDir },
				newSession: async () => {
					events.push("new-session");
					await writeSession("fresh", { id: "fresh-id" });
					activeSessionPath = freshPath;
					return true;
				},
			},
			clearSubagents: () => {
				events.push("clear-subagents");
			},
			onActiveSessionChanged: async () => {
				events.push("active-session-changed");
				expect(activeSessionPath).toBe(freshPath);
				expect(await pathExists(activePath)).toBe(true);
			},
		});

		await expect(service.delete(activePath)).resolves.toEqual({
			path: activePath,
			activeSessionChanged: true,
		});

		expect(events).toEqual(["new-session", "clear-subagents", "active-session-changed"]);
		expect(activeSessionPath).toBe(freshPath);
		expect(await pathExists(freshPath)).toBe(true);
		expect(await pathExists(activePath)).toBe(false);
		expect(await pathExists(artifactsDir(activePath))).toBe(false);
	});

	it("archives a listed transcript as gzip and moves its sibling artifacts", async () => {
		const sessionPath = await writeSession("archive", { id: "archive-id" });
		const artifactPath = await writeArtifact(sessionPath);
		const sourceContents = await fsp.readFile(sessionPath, "utf8");
		const archivedPath = path.join(agentDir, "archive", "sessions", "archive.jsonl.gz");
		const archivedArtifactPath = path.join(archivedPath.slice(0, -".jsonl.gz".length), path.basename(artifactPath));

		await expect(createService().archive(sessionPath)).resolves.toEqual({
			path: sessionPath,
			archivedPath,
			activeSessionChanged: false,
		});

		expect(await pathExists(sessionPath)).toBe(false);
		expect(await pathExists(artifactsDir(sessionPath))).toBe(false);
		expect(await pathExists(archivedPath)).toBe(true);
		expect(new TextDecoder().decode(gunzipSync(await fsp.readFile(archivedPath)))).toBe(sourceContents);
		expect(await fsp.readFile(archivedArtifactPath, "utf8")).toBe(`artifact for ${path.basename(sessionPath)}`);
	});
});
