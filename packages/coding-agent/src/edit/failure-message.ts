import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

const MAX_FAILURE_LINES = 5;
const DEFAULT_READ_LINES = 5;
const DEFAULT_WINDOW_CONTEXT = 2;

export interface FirstDifferentLine {
	lineOffset: number;
	expected: string;
	actual: string;
}

export interface LineWindow {
	startLine: number;
	lines: readonly string[];
}

export interface EditFailureMessageInput {
	path: string;
	why: string;
	expectedLines?: readonly string[];
	/** Expected lines aligned with `actualDiffLines` when the display window differs. */
	expectedDiffLines?: readonly string[];
	closestActualLines?: readonly string[];
	/** Actual line where the closest match begins. */
	closestLine?: number;
	/** First line represented by `closestActualLines`. */
	closestActualStartLine?: number;
	actualDiffLines?: readonly string[];
	actualDiffStartLine?: number;
	similarity?: number;
	readStartLine?: number;
	readLineCount?: number;
	totalLines?: number;
	nextAction?: string;
	doNotRetryNote?: string;
}

export interface AmbiguousEditFailureMessageInput {
	path: string;
	why: string;
	expectedLines?: readonly string[];
	candidatePreviews?: readonly string[];
	readStartLine?: number;
	readLineCount?: number;
	totalLines?: number;
	nextAction?: string;
	doNotRetryNote?: string;
}

export interface EditFailureLoopDiagnosticInput {
	path: string;
	count: number;
	reason: string;
	readStartLine?: number;
	readLineCount?: number;
	totalLines?: number;
}

/** Sanitize and visually bound one model/TUI-facing failure line. */
export function sanitizeFailureLine(line: string): string {
	const singleLine = line.replace(/\r\n|\r|\n/gu, " ");
	return truncateToWidth(replaceTabs(sanitizeText(Bun.stripANSI(singleLine))), TRUNCATE_LENGTHS.LINE);
}

function finalizeFailureMessage(lines: readonly string[]): string {
	return lines
		.flatMap(line => line.split("\n"))
		.map(sanitizeFailureLine)
		.join("\n");
}

export function findFirstDifferentLine(
	expectedLines: readonly string[],
	actualLines: readonly string[],
): FirstDifferentLine {
	const max = Math.max(expectedLines.length, actualLines.length);
	for (let i = 0; i < max; i++) {
		const expected = expectedLines[i] ?? "";
		const actual = actualLines[i] ?? "";
		if (expected !== actual) {
			return { lineOffset: i, expected, actual };
		}
	}
	return { lineOffset: 0, expected: expectedLines[0] ?? "", actual: actualLines[0] ?? "" };
}

export function selectLineWindow(
	lines: readonly string[],
	centerLine: number,
	context: number = DEFAULT_WINDOW_CONTEXT,
): LineWindow {
	if (lines.length === 0) return { startLine: 1, lines: [] };

	const safeCenter = Number.isFinite(centerLine) ? Math.max(1, Math.min(lines.length, Math.floor(centerLine))) : 1;
	const safeContext = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : DEFAULT_WINDOW_CONTEXT;
	const maxLines = Math.min(MAX_FAILURE_LINES, lines.length);
	let startLine = Math.max(1, safeCenter - safeContext);
	let endLine = Math.min(lines.length, startLine + maxLines - 1);
	startLine = Math.max(1, endLine - maxLines + 1);
	endLine = Math.min(lines.length, startLine + maxLines - 1);

	return {
		startLine,
		lines: lines.slice(startLine - 1, endLine),
	};
}

export function formatReadSelector(
	path: string,
	startLine: number,
	lineCount: number = DEFAULT_READ_LINES,
	totalLines?: number,
): string {
	const requestedStart = Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : 1;
	let safeStart = requestedStart;
	let safeCount = Number.isFinite(lineCount) ? Math.max(1, Math.floor(lineCount)) : DEFAULT_READ_LINES;
	if (totalLines !== undefined && Number.isFinite(totalLines)) {
		const safeTotal = Math.max(1, Math.floor(totalLines));
		safeStart = Math.min(safeStart, safeTotal);
		safeCount = Math.min(safeCount, safeTotal - safeStart + 1);
	}
	return `${path}:${safeStart}+${safeCount}`;
}

export function formatFailureLines(startLine: number, lines: readonly string[]): string {
	return lines
		.slice(0, MAX_FAILURE_LINES)
		.map((line, index) => sanitizeFailureLine(`  ${startLine + index} | ${line}`))
		.join("\n");
}

function clippedExpectedLines(lines: readonly string[]): string[] {
	if (lines.length <= MAX_FAILURE_LINES) return lines.map(line => sanitizeFailureLine(`  ${line}`));
	return [
		...lines.slice(0, MAX_FAILURE_LINES - 1).map(line => sanitizeFailureLine(`  ${line}`)),
		sanitizeFailureLine(`  … ${lines.length - (MAX_FAILURE_LINES - 1)} more line(s)`),
	];
}

function clippedCandidatePreviewLines(previews: readonly string[]): string[] {
	const lines = previews.filter(preview => preview.length > 0).flatMap(preview => preview.split(/\r\n|\r|\n/u));
	if (lines.length <= MAX_FAILURE_LINES) return lines.map(sanitizeFailureLine);
	return [
		...lines.slice(0, MAX_FAILURE_LINES - 1).map(sanitizeFailureLine),
		sanitizeFailureLine(`… ${lines.length - (MAX_FAILURE_LINES - 1)} more preview line(s)`),
	];
}

const FAILED_DO_NOT_RETRY_NOTE = "Do NOT retry this unchanged payload; issue a changed patch.";
const AMBIGUOUS_DO_NOT_RETRY_NOTE = "Do NOT retry this unchanged payload; resolve the ambiguity first.";

function formatReadCall(input: {
	path: string;
	readStartLine?: number;
	readLineCount?: number;
	totalLines?: number;
}): string {
	const qualifiedSelector = formatReadSelector(
		input.path,
		input.readStartLine ?? 1,
		input.readLineCount ?? DEFAULT_READ_LINES,
		input.totalLines,
	);
	const selector = qualifiedSelector.slice(input.path.length + 1);
	return `read(path=${JSON.stringify(input.path)}, selector=${JSON.stringify(selector)})`;
}

function defaultNextAction(input: {
	path: string;
	readStartLine?: number;
	readLineCount?: number;
	totalLines?: number;
	suffix: string;
	useClosestActual?: boolean;
}): string {
	const readCall = formatReadCall(input);
	if (input.useClosestActual) {
		return [
			"Recovery: re-issue a changed patch using the closest actual text above.",
			`Need context? Call ${readCall}.`,
		].join("\n");
	}
	return [`Recovery: call ${readCall}.`, `Then ${input.suffix}`].join("\n");
}

export function formatEditFailureMessage(input: EditFailureMessageInput): string {
	const parts: string[] = [`Why: ${input.why}`];
	const expectedLines = input.expectedLines ?? [];
	const actualLines = input.closestActualLines?.slice(0, MAX_FAILURE_LINES) ?? [];

	if (actualLines.length > 0) {
		const closestLine = input.closestLine ?? input.closestActualStartLine ?? 1;
		const actualStartLine = input.closestActualStartLine ?? closestLine;
		const matchLocation =
			input.similarity === undefined
				? `line ${closestLine}`
				: `${Math.round(input.similarity)}%, line ${closestLine}`;
		parts.push("", `Closest actual (${matchLocation}):`, formatFailureLines(actualStartLine, actualLines));

		const expectedDiffLines = input.expectedDiffLines ?? expectedLines;
		if (expectedDiffLines.length > 0) {
			const diff = findFirstDifferentLine(expectedDiffLines, input.actualDiffLines ?? actualLines);
			const actualLine = input.actualDiffStartLine ?? input.closestLine ?? input.closestActualStartLine ?? 1;
			parts.push("", `Expected at line ${actualLine + diff.lineOffset}: ${diff.expected}`);
		}
	} else if (expectedLines.length > 0) {
		parts.push("", "Expected lines:", ...clippedExpectedLines(expectedLines));
	}

	parts.push(
		"",
		input.nextAction ??
			defaultNextAction({
				path: input.path,
				readStartLine: input.readStartLine ?? input.closestActualStartLine ?? input.closestLine,
				readLineCount: input.readLineCount ?? (actualLines.length || DEFAULT_READ_LINES),
				totalLines: input.totalLines,
				suffix: "re-issue a changed patch using the observed current text.",
				useClosestActual: actualLines.length > 0,
			}),
		input.doNotRetryNote ?? FAILED_DO_NOT_RETRY_NOTE,
	);

	return finalizeFailureMessage(parts);
}

export function formatAmbiguousEditFailureMessage(input: AmbiguousEditFailureMessageInput): string {
	const parts: string[] = [`Why: ${input.why}`];
	const expectedLines = input.expectedLines ?? [];
	if (expectedLines.length > 0) {
		parts.push("", "Expected lines:", ...clippedExpectedLines(expectedLines));
	}

	const candidateLines = clippedCandidatePreviewLines(input.candidatePreviews ?? []);
	if (candidateLines.length > 0) {
		parts.push("", "Closest actual candidates:", ...candidateLines);
	}

	parts.push(
		"",
		input.nextAction ??
			defaultNextAction({
				path: input.path,
				readStartLine: input.readStartLine,
				readLineCount: input.readLineCount,
				totalLines: input.totalLines,
				suffix: "add enough surrounding context or @@ anchors to make the hunk unique.",
			}),
		input.doNotRetryNote ?? AMBIGUOUS_DO_NOT_RETRY_NOTE,
	);

	return finalizeFailureMessage(parts);
}

export function formatPatchUnchangedMessage(path: string): string {
	return finalizeFailureMessage([
		`edit appeared successful but file content did not change on disk: ${path}`,
		"",
		"Why: The write path reported success, but the file bytes are unchanged on disk.",
		`Next action: read ${formatReadSelector(path, 1, DEFAULT_READ_LINES)}, then verify current content before another edit.`,
		"Do NOT retry this exact payload unchanged; change the anchor/body or move on if the intended change is already present.",
	]);
}

export function formatEditFailureLoopDiagnostic(input: EditFailureLoopDiagnosticInput): string {
	const selector = formatReadSelector(
		input.path,
		input.readStartLine ?? 1,
		input.readLineCount ?? DEFAULT_READ_LINES,
		input.totalLines,
	);
	const reason =
		input.reason
			.split(/\r\n|\r|\n/u)
			.find(line => line.trim().length > 0)
			?.trim() ?? "edit failure";
	return finalizeFailureMessage([
		`STOP. This exact edit payload for ${input.path} has failed ${input.count} times in a row for the same file.`,
		`Last failure: ${reason}.`,
		"Cease re-issuing this payload; it will keep being rejected until it changes.",
		`Next action: read ${selector} and author a different patch using the current file text.`,
	]);
}
