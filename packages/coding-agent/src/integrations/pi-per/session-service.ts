import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { archiveSessionWithArtifacts } from "../../cli/gc-cli";
import type { OmpSessionSummary } from "../../modes/rpc/rpc-types";
import { listSessionsReadOnly, type SessionInfo } from "../../session/session-listing";
import { FileSessionStorage } from "../../session/session-storage";

export interface PiPerSessionServiceSession {
	readonly sessionFile?: string;
	readonly sessionManager: {
		getSessionDir(): string;
	};
	newSession(): Promise<boolean>;
}

export interface PiPerSessionMutationResult {
	path: string;
	activeSessionChanged: boolean;
}

export interface PiPerArchiveResult extends PiPerSessionMutationResult {
	archivedPath: string;
}

export class PiPerSessionService {
	readonly #session: PiPerSessionServiceSession;
	readonly #storage = new FileSessionStorage();
	readonly #onActiveSessionChanged: () => Promise<void>;
	readonly #clearSubagents: () => void;

	constructor(options: {
		session: PiPerSessionServiceSession;
		onActiveSessionChanged?: () => Promise<void>;
		clearSubagents?: () => void;
	}) {
		this.#session = options.session;
		this.#onActiveSessionChanged = options.onActiveSessionChanged ?? (async () => {});
		this.#clearSubagents = options.clearSubagents ?? (() => {});
	}

	async list(): Promise<OmpSessionSummary[]> {
		const sessions = await this.#sessions();
		return sessions.map(session => ({
			path: session.path,
			id: session.id,
			...(session.title ? { title: session.title } : {}),
			firstMessage: session.firstMessage,
			modified: session.modified.toISOString(),
			messageCount: session.messageCount,
			...(session.status ? { status: session.status } : {}),
		}));
	}

	async archive(sessionPath: string): Promise<PiPerArchiveResult> {
		const target = await this.#target(sessionPath);
		const activeSessionChanged = await this.#replaceActiveIfNeeded(target.path);
		const archivedPath = await archiveSessionWithArtifacts(target, this.#session.sessionManager.getSessionDir());
		return { path: target.path, archivedPath, activeSessionChanged };
	}

	async delete(sessionPath: string): Promise<PiPerSessionMutationResult> {
		const target = await this.#target(sessionPath);
		const activeSessionChanged = await this.#replaceActiveIfNeeded(target.path);
		await this.#storage.deleteSessionWithArtifacts(target.path);
		return { path: target.path, activeSessionChanged };
	}

	async #sessions(): Promise<SessionInfo[]> {
		return listSessionsReadOnly(this.#session.sessionManager.getSessionDir(), this.#storage);
	}

	async #target(sessionPath: string): Promise<SessionInfo> {
		const target = (await this.#sessions()).find(session => session.path === sessionPath);
		if (!target) throw new Error("Invalid session target");
		const sessionDirectory = this.#session.sessionManager.getSessionDir();
		const [sessionsRoot, sessionsRootStat, targetPath, stat] = await Promise.all([
			realpath(sessionDirectory).catch(() => undefined),
			lstat(sessionDirectory).catch(() => undefined),
			realpath(target.path).catch(() => undefined),
			lstat(target.path).catch(() => undefined),
		]);
		if (
			!sessionsRoot ||
			!sessionsRootStat?.isDirectory() ||
			sessionsRootStat.isSymbolicLink() ||
			!targetPath ||
			!stat?.isFile() ||
			stat.isSymbolicLink()
		) {
			throw new Error("Invalid session target");
		}
		const relativePath = relative(sessionsRoot, targetPath);
		if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
			throw new Error("Invalid session target");
		}
		return target;
	}

	async #replaceActiveIfNeeded(targetPath: string): Promise<boolean> {
		if (targetPath !== this.#session.sessionFile) return false;
		if (!(await this.#session.newSession())) throw new Error("Session change cancelled");
		this.#clearSubagents();
		await this.#onActiveSessionChanged();
		return true;
	}
}
