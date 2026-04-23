import { describe, expect, it } from "bun:test";
import {
	isCodexWebSocketFatalError,
	isCodexWebSocketTimeoutError,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";

// Guards the soft-fallback contract: connection-timeout errors are classified as timeouts
// (soft fallback this request, WS stays enabled for next) rather than fatal (permanent SSE
// exile). Without this, a single startup-induced timeout disables the WebSocket for the rest
// of the session and kills the `previous_response_id` append-chain optimization for every
// continuation turn.

describe("openai-codex ws error classification", () => {
	const TRANSPORT_PREFIX = "Codex websocket transport error";

	it("classifies connection timeout as timeout-only, not fatal", () => {
		const err = new Error(`${TRANSPORT_PREFIX}: connection timeout`);
		expect(isCodexWebSocketTimeoutError(err)).toBe(true);
		expect(isCodexWebSocketFatalError(err)).toBe(false);
	});

	it("classifies a 'websocket error:' prefix as fatal, not timeout", () => {
		const err = new Error(`${TRANSPORT_PREFIX}: websocket error: tls handshake`);
		expect(isCodexWebSocketFatalError(err)).toBe(true);
		expect(isCodexWebSocketTimeoutError(err)).toBe(false);
	});

	it("classifies 'websocket closed before open' as fatal, not timeout", () => {
		const err = new Error(`${TRANSPORT_PREFIX}: websocket closed before open (1006)`);
		expect(isCodexWebSocketFatalError(err)).toBe(true);
		expect(isCodexWebSocketTimeoutError(err)).toBe(false);
	});

	it("returns false from both classifiers for unrelated errors", () => {
		const err = new Error("idle timeout waiting for websocket");
		expect(isCodexWebSocketFatalError(err)).toBe(false);
		expect(isCodexWebSocketTimeoutError(err)).toBe(false);
	});

	it("is case-insensitive in the message scan", () => {
		const err = new Error(`${TRANSPORT_PREFIX}: CONNECTION TIMEOUT`);
		expect(isCodexWebSocketTimeoutError(err)).toBe(true);
		expect(isCodexWebSocketFatalError(err)).toBe(false);
	});
});
