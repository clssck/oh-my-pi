import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { SessionObserverOverlayComponent } from "../../../src/modes/components/session-observer-overlay";
import type { ObservableSession, SessionObserverRegistry } from "../../../src/modes/session-observer-registry";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionMessageEntry } from "../../../src/session/session-manager";

const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
let tempFiles: string[] = [];

beforeAll(() => {
	initTheme();
});

afterEach(async () => {
	for (const file of tempFiles) {
		await fs.rm(file, { force: true });
	}
	tempFiles = [];
	if (originalRows) {
		Object.defineProperty(process.stdout, "rows", originalRows);
	} else {
		Reflect.deleteProperty(process.stdout, "rows");
	}
	if (originalColumns) {
		Object.defineProperty(process.stdout, "columns", originalColumns);
	} else {
		Reflect.deleteProperty(process.stdout, "columns");
	}
	vi.restoreAllMocks();
});

function setTerminalSize(rows: number, columns: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
	Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function createToolCall(name: string, args: Record<string, unknown>): ToolCall {
	return {
		type: "toolCall",
		id: `call_${name}`,
		name,
		arguments: args,
	};
}

function createToolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function createEntry(id: string, message: SessionMessageEntry["message"]): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2025-01-01T00:00:00Z",
		message,
	};
}

async function createOverlay(entries: SessionMessageEntry[]): Promise<SessionObserverOverlayComponent> {
	const sessionFile = path.join(
		os.tmpdir(),
		`session-observer-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
	);
	tempFiles.push(sessionFile);
	await Bun.write(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);

	const sessions: ObservableSession[] = [
		{
			id: "subagent-1",
			kind: "subagent",
			label: "Subagent",
			agent: "task",
			status: "active",
			sessionFile,
			lastUpdate: 1,
		},
	];
	const registry = {
		getSessions: () => sessions,
		onChange: () => () => {},
	} as unknown as SessionObserverRegistry;

	return new SessionObserverOverlayComponent(registry, () => {}, []);
}

describe("SessionObserverOverlayComponent", () => {
	it("keeps multiline bash summaries on separate render rows", async () => {
		setTerminalSize(20, 80);
		const toolCall = createToolCall("bash", { command: "echo first\necho second" });
		const toolResult = createToolResult(toolCall.id, toolCall.name, "done");
		const overlay = await createOverlay([
			createEntry("assistant-1", createAssistantMessage([toolCall], "toolUse")),
			createEntry("tool-result-1", toolResult),
		]);

		const lines = overlay.render(80);

		expect(lines.some(line => line.includes("\n"))).toBe(false);
		expect(lines.some(line => line.includes("echo first"))).toBe(true);
		expect(lines.some(line => line.includes("echo second"))).toBe(true);
	});

	it("page down scrolls within a single expanded oversized response", async () => {
		setTerminalSize(20, 80);
		const longText = Array.from({ length: 60 }, (_, index) => `Line ${index + 1}`).join("\n");
		const overlay = await createOverlay([
			createEntry("assistant-1", createAssistantMessage([{ type: "text", text: longText }], "stop")),
		]);

		overlay.handleInput("\n");
		const before = overlay.render(80);
		expect(before.some(line => line.includes("Line 1"))).toBe(true);
		expect(before.some(line => line.includes("Line 20"))).toBe(false);

		overlay.handleInput("\x1b[6~");
		const after = overlay.render(80);
		expect(after.some(line => line.includes("Line 20"))).toBe(true);
	});
});
