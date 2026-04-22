/**
 * Synchronous, partial-write-safe stdout/stderr writes.
 *
 * `process.stdout.write(largeString)` on non-TTY descriptors (pipes, redirected
 * files) can commit only part of the buffer and lose the tail: Node's internal
 * async writer queues the remainder but has been observed under heavy streaming
 * load to let a subsequent `write()` land on top of the partial write's offset.
 * The symptom is a JSONL stream where one event is truncated mid-value and the
 * next event begins directly where the first stopped, with no separator.
 *
 * This helper bypasses the async queue and uses `fs.writeSync` in a retry loop
 * so every byte of `chunk` is committed before returning. Designed for JSONL
 * emitters in `--mode json` / RPC mode where framing correctness is essential.
 */
import * as fs from "node:fs";

/**
 * Write every byte of `chunk` to `fd`, retrying on partial writes. Blocks
 * until the kernel has accepted the entire buffer. Safe to call concurrently
 * from different async contexts within a single process: each call completes
 * before returning, so events remain framed.
 */
export function writeAllSync(fd: number, chunk: string | Uint8Array): void {
	const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
	let written = 0;
	while (written < buf.length) {
		written += fs.writeSync(fd, buf, written, buf.length - written);
	}
}

/** Convenience: serialize `value` as JSON and append `\n`, then write atomically to `fd`. */
export function writeJsonLineSync(fd: number, value: unknown): void {
	writeAllSync(fd, `${JSON.stringify(value)}\n`);
}
