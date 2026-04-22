import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { writeAllSync, writeJsonLineSync } from "../src/stdio-sync";

describe("writeAllSync", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes all bytes in one call when the syscall accepts everything", () => {
		const spy = vi.spyOn(fs, "writeSync").mockImplementation((_fd, _buf, _off, len) => len as number);
		writeAllSync(1, "hello world");
		expect(spy).toHaveBeenCalledTimes(1);
		const call = spy.mock.calls[0];
		expect(call[3]).toBe(Buffer.byteLength("hello world", "utf8"));
	});

	it("retries from the correct offset when the syscall returns a partial write", () => {
		// Simulate a pipe that only accepts 4 bytes per call until all bytes flushed.
		const chunks: Array<{ off: number; len: number }> = [];
		vi.spyOn(fs, "writeSync").mockImplementation(
			// @ts-expect-error — fs.writeSync has many overloads; we only exercise (fd, buf, off, len)
			(_fd: number, _buf: Buffer, off: number, len: number) => {
				const written = Math.min(4, len);
				chunks.push({ off, len: written });
				return written;
			},
		);

		const input = "abcdefghij"; // 10 bytes
		writeAllSync(5, input);

		// Expect offsets 0, 4, 8 with lengths 4, 4, 2 (total 10).
		expect(chunks).toEqual([
			{ off: 0, len: 4 },
			{ off: 4, len: 4 },
			{ off: 8, len: 2 },
		]);
	});

	it("accepts Uint8Array directly without re-encoding", () => {
		const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
		const captured: Buffer[] = [];
		vi.spyOn(fs, "writeSync").mockImplementation((_fd, buf, _off, len) => {
			captured.push(Buffer.from(buf as Uint8Array));
			return len as number;
		});
		writeAllSync(1, bytes);
		expect(captured[0]).toEqual(Buffer.from(bytes));
	});

	it("is a no-op on empty input", () => {
		const spy = vi.spyOn(fs, "writeSync").mockImplementation((_fd, _buf, _off, len) => len as number);
		writeAllSync(1, "");
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("writeJsonLineSync", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("serializes JSON and appends a single trailing newline", () => {
		let captured = "";
		vi.spyOn(fs, "writeSync").mockImplementation((_fd, buf, off, len) => {
			const slice = Buffer.from(buf as Uint8Array).slice(off, off + len);
			captured += slice.toString("utf8");
			return len as number;
		});
		writeJsonLineSync(1, { type: "hello", n: 42 });
		expect(captured).toBe(`${JSON.stringify({ type: "hello", n: 42 })}\n`);
		expect(captured.endsWith("\n")).toBe(true);
		// exactly one newline at the end
		expect(captured.split("\n").length).toBe(2);
	});

	it("frames a large event across multiple partial writes without losing bytes", () => {
		// Large payload with an embedded base64-ish string that mimics the corrupted event.
		const payload = {
			type: "message_update",
			thinkingSignature: "A".repeat(8192),
		};
		const expected = `${JSON.stringify(payload)}\n`;

		let captured = "";
		vi.spyOn(fs, "writeSync").mockImplementation(
			// Accept at most 100 bytes per call to force retries.
			// @ts-expect-error — fs.writeSync has many overloads; we only exercise (fd, buf, off, len)
			(_fd: number, buf: Buffer, off: number, len: number) => {
				const written = Math.min(100, len);
				captured += Buffer.from(buf)
					.slice(off, off + written)
					.toString("utf8");
				return written;
			},
		);

		writeJsonLineSync(1, payload);
		expect(captured).toBe(expected);
	});
});
