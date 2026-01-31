import * as fs from "node:fs/promises";
import {
	getRecentErrors as dbGetRecentErrors,
	getRecentRequests as dbGetRecentRequests,
	getFileOffset,
	getMessageById,
	getMessageCount,
	getOverallStats,
	getStatsByFolder,
	getStatsByModel,
	getTimeSeries,
	initDb,
	insertMessageStats,
	setFileOffset,
} from "./db";
import { getSessionEntryWithContext, listAllSessionFiles, parseSessionFile } from "./parser";
import type { DashboardStats, MessageStats, RequestDetails } from "./types";

/**
 * Sync a single session file to the database.
 * Only processes new entries since the last sync.
 */
async function syncSessionFile(sessionFile: string): Promise<number> {
	// Get file stats
	let fileStats: Awaited<ReturnType<typeof fs.stat>>;
	try {
		fileStats = await fs.stat(sessionFile);
	} catch {
		return 0;
	}

	const lastModified = fileStats.mtimeMs;

	// Check if file has changed since last sync
	const stored = getFileOffset(sessionFile);
	if (stored && stored.lastModified >= lastModified) {
		return 0; // File hasn't changed
	}

	// Parse file from last offset
	const fromOffset = stored?.offset ?? 0;
	const { stats, newOffset } = await parseSessionFile(sessionFile, fromOffset);

	if (stats.length > 0) {
		insertMessageStats(stats);
	}

	// Update offset tracker
	setFileOffset(sessionFile, newOffset, lastModified);

	return stats.length;
}

/**
 * Sync all session files to the database.
 * Returns the number of new entries processed.
 */
export async function syncAllSessions(): Promise<{ processed: number; files: number }> {
	await initDb();

	const files = await listAllSessionFiles();
	let totalProcessed = 0;
	let filesProcessed = 0;

	for (const file of files) {
		const count = await syncSessionFile(file);
		if (count > 0) {
			totalProcessed += count;
			filesProcessed++;
		}
	}

	return { processed: totalProcessed, files: filesProcessed };
}

/**
 * Get all dashboard stats.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
	await initDb();

	return {
		overall: getOverallStats(),
		byModel: getStatsByModel(),
		byFolder: getStatsByFolder(),
		timeSeries: getTimeSeries(24),
	};
}

export async function getRecentRequests(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentRequests(limit);
}

export async function getRecentErrors(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentErrors(limit);
}

export async function getRequestDetails(id: number): Promise<RequestDetails | null> {
	await initDb();
	const msg = getMessageById(id);
	if (!msg) return null;

	// Get the entry with its parent context chain (user prompt -> assistant response)
	const contextChain = await getSessionEntryWithContext(msg.sessionFile, msg.entryId);
	if (contextChain.length === 0) return null;

	// The last entry should be the assistant message we're looking for
	const entry = contextChain[contextChain.length - 1];
	if (!entry || entry.type !== "message") return null;

	return {
		...msg,
		messages: contextChain,
		output: (entry as any).message,
	};
}

/**
 * Get the current message count in the database.
 */
export async function getTotalMessageCount(): Promise<number> {
	await initDb();
	return getMessageCount();
}
