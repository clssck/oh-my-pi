import { describe, expect, test } from "bun:test";
import {
	formatAmbiguousEditFailureMessage,
	formatEditFailureMessage,
	formatReadSelector,
	selectLineWindow,
} from "@oh-my-pi/pi-coding-agent/edit";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

const FORBIDDEN_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/u;

function sectionLines(message: string, heading: string): string[] {
	const lines = message.split("\n");
	const start = lines.indexOf(heading);
	if (start < 0) throw new Error(`Missing failure-message section: ${heading}`);
	const blank = lines.indexOf("", start + 1);
	return lines.slice(start + 1, blank < 0 ? lines.length : blank);
}

describe("edit failure formatter", () => {
	test("keeps bounded actual context and a compact expected-line cue before schema-native recovery", () => {
		const source = Array.from({ length: 12 }, (_, index) => `source line ${index + 1}`);
		source[5] = "shared line";
		source[6] = "actual line";
		const window = selectLineWindow(source, 6);

		const message = formatEditFailureMessage({
			path: "src/example.ts",
			why: "Expected text was not present.",
			expectedLines: ["shared line", "expected line"],
			closestActualLines: window.lines,
			closestLine: 6,
			closestActualStartLine: window.startLine,
			actualDiffLines: ["shared line", "actual line"],
			actualDiffStartLine: 6,
			similarity: 91,
			readStartLine: window.startLine,
			readLineCount: window.lines.length,
			totalLines: source.length,
		});
		const closestHeading = "Closest actual (91%, line 6):";
		const changedPatchAt = message.indexOf("re-issue a changed patch using the closest actual text above");
		const readCallAt = message.indexOf('read(path="src/example.ts", selector="4+5")');

		expect(sectionLines(message, closestHeading)).toEqual([
			"  4 | source line 4",
			"  5 | source line 5",
			"  6 | shared line",
			"  7 | actual line",
			"  8 | source line 8",
		]);
		expect(message).toContain("Expected at line 7: expected line");
		expect(message).not.toContain("Expected lines:");
		expect(changedPatchAt).toBeGreaterThanOrEqual(0);
		expect(readCallAt).toBeGreaterThan(changedPatchAt);
		expect(message).toContain("Do NOT retry this unchanged payload; issue a changed patch.");
	});

	test("keeps bounded expected evidence and a schema-native read call when no candidate exists", () => {
		const expectedLines = Array.from({ length: 7 }, (_, index) => `expected line ${index + 1}`);
		const message = formatEditFailureMessage({
			path: "src/no-candidate.ts",
			why: "Expected text was not present.",
			expectedLines,
			readStartLine: 9,
			readLineCount: 5,
			totalLines: 12,
		});

		expect(sectionLines(message, "Expected lines:")).toEqual([
			"  expected line 1",
			"  expected line 2",
			"  expected line 3",
			"  expected line 4",
			"  … 3 more line(s)",
		]);
		expect(message).not.toContain("Closest actual");
		expect(message).toContain('read(path="src/no-candidate.ts", selector="9+4")');
		expect(message).toContain("re-issue a changed patch using the observed current text");
	});

	test("clamps a requested read range beyond EOF to the final readable line", () => {
		expect(formatReadSelector("src/example.ts", 10_000, 10_000, 23)).toBe("src/example.ts:23+1");
	});

	test("independently bounds and sanitizes why, closest, and compact expected-line cues", () => {
		const hostile = `safe\t\x1b[31mred\x1b[0m\x00\x07\x1f\x7f\x85\x9b31m${"x".repeat(TRUNCATE_LENGTHS.LINE * 2)}`;
		const message = formatEditFailureMessage({
			path: "src/example.ts",
			why: `why-${hostile}`,
			expectedLines: [`expected-${hostile}`],
			closestActualLines: [`closest-${hostile}`],
			closestLine: 4,
			actualDiffLines: [`actual-${hostile}`],
			actualDiffStartLine: 4,
			readStartLine: 4,
			readLineCount: 1,
			totalLines: 4,
		});
		const lines = message.split("\n");

		expect(lines.find(line => line.startsWith("Why: why-safe"))?.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
		expect(lines.find(line => line.startsWith("  4 | closest-safe"))?.length).toBeLessThanOrEqual(
			TRUNCATE_LENGTHS.LINE,
		);
		expect(lines.find(line => line.startsWith("Expected at line 4: expected-safe"))?.length).toBeLessThanOrEqual(
			TRUNCATE_LENGTHS.LINE,
		);
		expect(message).not.toContain("Expected lines:");
		expect(message).not.toContain("\t");
		expect(message).not.toContain("\x1b");
		expect(lines.every(line => !FORBIDDEN_CONTROL.test(line))).toBe(true);
	});

	test("bounds and sanitizes ambiguous evidence before schema-native recovery", () => {
		const candidates = Array.from({ length: 10 }, (_, index) => {
			const ordinal = String(index + 1).padStart(2, "0");
			return `candidate-${ordinal}\t\x1b[32m\x00\x85${"z".repeat(TRUNCATE_LENGTHS.LINE * 2)}`;
		}).join("\n");
		const message = formatAmbiguousEditFailureMessage({
			path: "src/example.ts",
			why: "The target is ambiguous.",
			expectedLines: ["target"],
			candidatePreviews: [candidates],
			readStartLine: 8,
			readLineCount: 5,
			totalLines: 10,
		});
		const candidateLines = sectionLines(message, "Closest actual candidates:");

		expect(sectionLines(message, "Expected lines:")).toEqual(["  target"]);
		expect(candidateLines).toHaveLength(5);
		expect(candidateLines.slice(0, 4).every(line => line.length <= TRUNCATE_LENGTHS.LINE)).toBe(true);
		expect(candidateLines[4]).toBe("… 6 more preview line(s)");
		expect(message).toContain("candidate-01");
		expect(message).not.toContain("candidate-05");
		expect(message).toContain('read(path="src/example.ts", selector="8+3")');
		expect(message).toContain("make the hunk unique");
		expect(message).not.toContain("\t");
		expect(message).not.toContain("\x1b");
		expect(message.split("\n").every(line => !FORBIDDEN_CONTROL.test(line))).toBe(true);
	});
});
