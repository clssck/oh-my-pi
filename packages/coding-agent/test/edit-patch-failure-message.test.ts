import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	DEFAULT_FUZZY_THRESHOLD,
	EditTool,
	executePatchSingle,
	executeReplaceSingle,
	type PatchEditEntry,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { FileDiagnosticsResult } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FORBIDDEN_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/u;

function makeSession(cwd: string, editMode: "patch" | "apply_patch" | "replace" = "patch"): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": editMode }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

const noopBeginDeferred = (_path: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

async function persistentWritethrough(
	destination: string,
	content: string,
): Promise<FileDiagnosticsResult | undefined> {
	await Bun.write(destination, content);
	return undefined;
}

async function executePatchForTest(
	session: ToolSession,
	filePath: string,
	params: PatchEditEntry,
	payloadHash?: string,
): Promise<void> {
	await executePatchSingle({
		session,
		path: filePath,
		params,
		payloadHash,
		allowFuzzy: false,
		fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
		writethrough: persistentWritethrough,
		beginDeferredDiagnosticsForPath: noopBeginDeferred,
	});
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
	try {
		await action();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`Expected Error, received ${String(error)}`);
	}
	throw new Error("Expected operation to fail");
}

function resultText(result: AgentToolResult): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function sectionLines(message: string, heading: string): string[] {
	const lines = message.split("\n");
	const start = lines.indexOf(heading);
	if (start < 0) throw new Error(`Missing failure-message section: ${heading}`);
	const blank = lines.indexOf("", start + 1);
	return lines.slice(start + 1, blank < 0 ? lines.length : blank);
}

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-failure-message-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("executePatchSingle match-failure recovery", () => {
	test("preserves bounded source context while recovering with a caller-facing path and selector", async () => {
		const relPath = "nested/target.txt";
		const absolutePath = path.join(tempDir, relPath);
		await fs.mkdir(path.dirname(absolutePath), { recursive: true });
		const lines = Array.from({ length: 12 }, (_, index) => `source line ${index + 1}`);
		lines[6] = absolutePath;
		await fs.writeFile(absolutePath, `${lines.join("\n")}\n`);

		const error = await captureError(() =>
			executePatchForTest(makeSession(tempDir), relPath, {
				op: "update",
				diff: `@@\n-${absolutePath}-stale\n+replacement`,
			}),
		);
		const closestHeading = error.message
			.split("\n")
			.find(line => line.startsWith("Closest actual") && line.endsWith(", line 7):"));
		if (!closestHeading) throw new Error("Missing closest-actual heading");
		const changedPatchAt = error.message.indexOf("re-issue a changed patch using the closest actual text above");
		const readCallAt = error.message.indexOf(`read(path=${JSON.stringify(relPath)}, selector="5+5")`);

		expect(error.message).toContain(`Why: Could not find a close enough match in ${relPath}.`);
		expect(sectionLines(error.message, closestHeading)).toEqual([
			"  5 | source line 5",
			"  6 | source line 6",
			`  7 | ${absolutePath}`,
			"  8 | source line 8",
			"  9 | source line 9",
		]);
		expect(error.message).toContain("Expected at line 7:");
		expect(error.message).not.toContain("Expected lines:");
		expect(changedPatchAt).toBeGreaterThanOrEqual(0);
		expect(readCallAt).toBeGreaterThan(changedPatchAt);
		expect(error.message).not.toContain(`read(path=${JSON.stringify(absolutePath)}`);
		expect(error.message).toContain("Do NOT retry this unchanged payload; issue a changed patch.");
	});

	test("a changed failing payload starts a fresh recovery opportunity", async () => {
		const relPath = "target.txt";
		await fs.writeFile(path.join(tempDir, relPath), "alpha\nbravo current\ncharlie\n");
		const session = makeSession(tempDir);

		const first = await captureError(() =>
			executePatchForTest(session, relPath, { op: "update", diff: "@@\n-bravo stale one\n+next" }),
		);
		const changed = await captureError(() =>
			executePatchForTest(session, relPath, { op: "update", diff: "@@\n-bravo stale two\n+next" }),
		);
		const originalAgain = await captureError(() =>
			executePatchForTest(session, relPath, { op: "update", diff: "@@\n-bravo stale one\n+next" }),
		);

		expect(first.message).toContain("Do NOT retry this unchanged payload; issue a changed patch.");
		expect(changed.message).not.toStartWith("STOP.");
		expect(changed.message).toContain("bravo stale two");
		expect(originalAgain.message).not.toStartWith("STOP.");
	});

	test("a successful corrected patch resets the prior failure", async () => {
		const relPath = "target.txt";
		await fs.writeFile(path.join(tempDir, relPath), "bravo current\n");
		const session = makeSession(tempDir);
		const stale = { op: "update" as const, diff: "@@\n-bravo stale\n+bravo next" };

		await captureError(() => executePatchForTest(session, relPath, stale));
		await executePatchForTest(session, relPath, { op: "update", diff: "@@\n-bravo current\n+bravo corrected" });
		const afterSuccess = await captureError(() => executePatchForTest(session, relPath, stale));

		expect(await fs.readFile(path.join(tempDir, relPath), "utf8")).toBe("bravo corrected\n");
		expect(afterSuccess.message).not.toStartWith("STOP.");
		expect(afterSuccess.message).toContain("Do NOT retry this unchanged payload; issue a changed patch.");
	});

	test("a successful rename resets failure state for both source and destination", async () => {
		const source = "source.txt";
		const destination = "destination.txt";
		await fs.writeFile(path.join(tempDir, source), "source current\n");
		await fs.writeFile(path.join(tempDir, destination), "destination current\n");
		const session = makeSession(tempDir);
		const sourceFailure = { op: "update" as const, diff: "@@\n-source stale\n+unused" };
		const destinationFailure = { op: "update" as const, diff: "@@\n-destination stale\n+unused" };

		await captureError(() => executePatchForTest(session, source, sourceFailure, "source-payload"));
		await captureError(() => executePatchForTest(session, destination, destinationFailure, "destination-payload"));
		await fs.unlink(path.join(tempDir, destination));
		await executePatchForTest(session, source, {
			op: "update",
			rename: destination,
			diff: "@@\n-source current\n+moved current",
		});
		await fs.writeFile(path.join(tempDir, source), "source current\n");

		const sourceAfterRename = await captureError(() =>
			executePatchForTest(session, source, sourceFailure, "source-payload"),
		);
		const destinationAfterRename = await captureError(() =>
			executePatchForTest(session, destination, destinationFailure, "destination-payload"),
		);

		expect(await fs.readFile(path.join(tempDir, destination), "utf8")).toBe("moved current\n");
		expect(sourceAfterRename.message).not.toStartWith("STOP.");
		expect(destinationAfterRename.message).not.toStartWith("STOP.");
	});

	test("the same payload on another file or session has independent failure state", async () => {
		await fs.writeFile(path.join(tempDir, "a.txt"), "current\n");
		await fs.writeFile(path.join(tempDir, "b.txt"), "current\n");
		const firstSession = makeSession(tempDir);
		const secondSession = makeSession(tempDir);
		const failure = { op: "update" as const, diff: "@@\n-stale\n+next" };

		const firstFile = await captureError(() => executePatchForTest(firstSession, "a.txt", failure, "same-payload"));
		const otherFile = await captureError(() => executePatchForTest(firstSession, "b.txt", failure, "same-payload"));
		const otherSession = await captureError(() =>
			executePatchForTest(secondSession, "a.txt", failure, "same-payload"),
		);
		const repeatedFirstFile = await captureError(() =>
			executePatchForTest(firstSession, "a.txt", failure, "same-payload"),
		);

		expect(firstFile.message).not.toStartWith("STOP.");
		expect(otherFile.message).not.toStartWith("STOP.");
		expect(otherSession.message).not.toStartWith("STOP.");
		expect(repeatedFirstFile.message).toStartWith("STOP.");
	});
});

describe("EditTool failure-loop recovery", () => {
	test("patch mode hard-errors on the second identical failure", async () => {
		await fs.writeFile(path.join(tempDir, "target.txt"), "current\n");
		const tool = new EditTool(makeSession(tempDir, "patch"));
		const params = { path: "target.txt", edits: [{ op: "update" as const, diff: "@@\n-stale\n+next" }] };

		const first = await captureError(() => tool.execute("patch-failure-1", params));
		const second = await captureError(() => tool.execute("patch-failure-2", params));

		expect(first.message).toContain("Do NOT retry this unchanged payload; issue a changed patch.");
		expect(second.message).toStartWith("STOP.");
		expect(second.message).toContain("failed 2 times in a row");
		expect(second.message).toContain("Cease re-issuing this payload");
		expect(second.message).toContain("target.txt");
		expect(second.message).not.toContain(tempDir);
	});

	test("apply_patch mode hard-errors on the second identical failure", async () => {
		await fs.writeFile(path.join(tempDir, "target.txt"), "current\n");
		const tool = new EditTool(makeSession(tempDir, "apply_patch"));
		const params = {
			input: "*** Begin Patch\n*** Update File: target.txt\n@@\n-stale\n+next\n*** End Patch\n",
		};

		const first = await captureError(() => tool.execute("apply-patch-failure-1", params));
		const second = await captureError(() => tool.execute("apply-patch-failure-2", params));

		expect(first.message).toContain("Do NOT retry this unchanged payload; issue a changed patch.");
		expect(second.message).toStartWith("STOP.");
		expect(second.message).toContain("failed 2 times in a row");
		expect(second.message).toContain("Cease re-issuing this payload");
		expect(second.message).toContain("target.txt");
		expect(second.message).not.toContain(tempDir);
	});

	test("multi-file apply_patch entries retain per-file state and distinguish raw envelopes", async () => {
		await fs.writeFile(path.join(tempDir, "a.txt"), "a old\n");
		await fs.writeFile(path.join(tempDir, "b.txt"), "b current\n");
		const tool = new EditTool(makeSession(tempDir, "apply_patch"));
		const envelope =
			"*** Begin Patch\n" +
			"*** Update File: a.txt\n" +
			"@@\n" +
			"-a old\n" +
			"+a new\n" +
			"*** Update File: b.txt\n" +
			"@@\n" +
			"-b stale\n" +
			"+b new\n" +
			"*** End Patch";

		const first = await tool.execute("multi-file-1", { input: envelope });
		await fs.writeFile(path.join(tempDir, "a.txt"), "a old\n");
		const changedEnvelope = await tool.execute("multi-file-2", { input: `\n${envelope}\n` });
		await fs.writeFile(path.join(tempDir, "a.txt"), "a old\n");
		const repeatedChangedEnvelope = await tool.execute("multi-file-3", { input: `\n${envelope}\n` });

		expect(first.isError).toBe(true);
		expect(resultText(first)).toContain("Error editing b.txt:");
		expect(resultText(first)).not.toContain("STOP.");
		expect(changedEnvelope.isError).toBe(true);
		expect(resultText(changedEnvelope)).not.toContain("STOP.");
		expect(repeatedChangedEnvelope.isError).toBe(true);
		expect(resultText(repeatedChangedEnvelope)).toContain("Error editing b.txt: STOP.");
		expect(await fs.readFile(path.join(tempDir, "a.txt"), "utf8")).toBe("a new\n");
	});
});

describe("replace-mode failure sanitation", () => {
	test("sanitizes and bounds hostile closest-match text at the observable error boundary", async () => {
		const hostile = `shared\t\x1b[31mred\x1b[0m\x00\x07\x1f\x7f\x85\x9b31m${"x".repeat(TRUNCATE_LENGTHS.LINE * 2)}`;
		await fs.writeFile(path.join(tempDir, "replace.txt"), `${hostile} actual\n`);

		const error = await captureError(() =>
			executeReplaceSingle({
				session: makeSession(tempDir, "replace"),
				path: "replace.txt",
				params: { old_text: `${hostile} expected`, new_text: "replacement" },
				allowFuzzy: false,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				writethrough: persistentWritethrough,
				beginDeferredDiagnosticsForPath: noopBeginDeferred,
			}),
		);
		const lines = error.message.split("\n");

		expect(error.message).toContain("Closest match");
		expect(error.message).not.toContain("\t");
		expect(error.message).not.toContain("\x1b");
		expect(lines.every(line => line.length <= TRUNCATE_LENGTHS.LINE)).toBe(true);
		expect(lines.every(line => !FORBIDDEN_CONTROL.test(line))).toBe(true);
	});
});
