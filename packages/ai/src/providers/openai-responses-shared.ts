import { structuredCloneJSON } from "@oh-my-pi/pi-utils";
import type OpenAI from "openai";
import type {
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "openai/resources/responses/responses";
import { calculateCost } from "../models";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { normalizeResponsesToolCallId } from "../utils";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { parseStreamingJson } from "../utils/json-parse";

// The system prompt templates end with one of two known volatile tails,
// substituted at render time:
//
// 1. system-prompt.md (default)
//
//      The current working directory is '{{cwd}}'.
//      Today is '{{date}}'. Begin now.
//
// 2. custom-system-prompt.md (when the caller supplies a --custom-prompt)
//
//      Current date: {{date}}
//      Current working directory: {{cwd}}
//
// Both forms embed values that rotate (cwd varies per project, date rolls
// every midnight), so including them in the hash input rotates the OpenAI
// prompt_cache_key and scatters otherwise-identical prefixes across
// routing shards. Strip whichever tail is present before hashing.
//
// A regex like `'[^']*'` would break on cwds that contain an apostrophe
// (e.g. `/home/me/my's project`) — the closing `'` match would fire inside
// the cwd value, the full tail regex would fail, and the user would silently
// regress to pre-fix behavior. Use position-based stripping via `lastIndexOf`
// on a stable marker so value contents never break the strip.
const STANDARD_TAIL_MARKER = "\nThe current working directory is '";
// Relaxed from `...\s*$` to tolerate trailing content. When a caller composes
// the default prompt with `--append-system-prompt <text>`, the resulting string
// has the tail in the middle, not at end-of-string. Under the prior strict
// anchor the structure regex rejected those compositions and the split fell
// through, silently regressing those users to the pre-cache-split behaviour.
// The lazy middle quantifier (`*?`) keeps matching deterministic and prevents
// pathological backtracking on long inputs.
const STANDARD_TAIL_STRUCTURE = /'\.\r?\nToday is '[\s\S]*?'\.\s*Begin now\./;

const CUSTOM_TAIL_MARKER = "\nCurrent date: ";
// Relaxed symmetrically for the custom-prompt composition. We still require
// the tail to begin with a single-line date value followed by the working
// directory marker; anything after is treated as post-tail content.
const CUSTOM_TAIL_STRUCTURE = /^[^\r\n]+\r?\nCurrent working directory: /;

function stripByMarker(systemPrompt: string, marker: string, structure: RegExp): string | null {
	const idx = systemPrompt.lastIndexOf(marker);
	if (idx < 0) return null;
	const tail = systemPrompt.slice(idx + marker.length);
	if (!structure.test(tail)) return null;
	return systemPrompt.slice(0, idx);
}

/**
 * Split the system prompt into its stable prefix and its volatile tail.
 *
 * The Oh My Pi prompt templates end with one of two known variable tails
 * (cwd + date). Callers that cache-key on the system prompt need the stable
 * prefix; callers that cache the *content* (Anthropic) need both parts as
 * separate blocks so the tail's per-day/per-cwd churn doesn't invalidate the
 * stable prefix's cache breakpoint.
 *
 * The structure regexes are anchored at tail-start but not tail-end, so a
 * composed prompt like `${defaultPrompt}\n\n${appendPrompt}` (produced by
 * `--append-system-prompt` without an explicit `--system-prompt`) still
 * splits correctly: the stable prefix is everything before the tail marker,
 * and the returned `tail` carries the cwd+date lines plus the trailing
 * append content. The model-visible bytes are preserved — `stable + tail`
 * is always byte-identical to the input.
 *
 * Returns `tail === ""` when no known tail is present, so callers can treat a
 * non-empty `tail` as the signal to split.
 */
export function splitVolatileTail(systemPrompt: string): { stable: string; tail: string } {
	const stripped =
		stripByMarker(systemPrompt, STANDARD_TAIL_MARKER, STANDARD_TAIL_STRUCTURE) ??
		stripByMarker(systemPrompt, CUSTOM_TAIL_MARKER, CUSTOM_TAIL_STRUCTURE);
	if (stripped === null) return { stable: systemPrompt, tail: "" };
	return { stable: stripped, tail: systemPrompt.slice(stripped.length) };
}

export function stripVolatileTail(systemPrompt: string): string {
	return splitVolatileTail(systemPrompt).stable;
}

/**
 * Derive a stable prompt_cache_key for OpenAI-style Responses endpoints.
 *
 * Prior to this helper each caller passed `options?.sessionId` — a UUIDv7
 * generated fresh per OMP session — which meant every new session was cold
 * against OpenAI's / Azure's / Codex's prompt cache router. Hashing
 * `(modelId, systemPrompt)` collapses distinct sessionIds onto one cache
 * route per `(model, systemPrompt)` tuple. Repeat fresh sessions with the
 * same system prompt share a cache slot and hit on turn 1.
 *
 * Additional stabilization: the system prompt template ends with a volatile
 * two-line tail naming the current working directory and today's date. If
 * those substituted values participate in the hash, the routing key rotates
 * every midnight and every time the user switches project cwd, forcing a
 * cold miss on what would otherwise be a warm prefix. Strip that known tail
 * before hashing so the key stays stable when only cwd/date change.
 *
 * Opt-outs:
 * - `sessionId === undefined` returns `undefined` so callers that want no
 *   cache routing (the pre-existing test contract) keep that behavior.
 * - Empty `systemPrompt` returns `sessionId` verbatim so callers that pass
 *   a sessionId without a system prompt still get a routing value.
 */
export function derivePromptCacheKey(
	modelId: string,
	systemPrompt: string | undefined,
	sessionId: string | undefined,
): string | undefined {
	if (!sessionId) return undefined;
	if (!systemPrompt) return sessionId;
	const stable = stripVolatileTail(systemPrompt);
	return `omp-${Bun.hash(`${modelId}\u0000${stable}`).toString(36)}`;
}

export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

export function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export function encodeResponsesToolCallId(callId: string, itemId: string | null | undefined): string {
	const stableItemId = itemId && itemId.length > 0 ? itemId : `fc_${Bun.hash(callId).toString(36)}`;
	return `${callId}|${stableItemId}`;
}

export function normalizeResponsesToolCallIdForTransform(
	id: string,
	model?: Model<Api>,
	source?: AssistantMessage,
): string {
	if (!id.includes("|")) return id;
	const isForeignToolCall =
		source != null && model != null && (source.provider !== model.provider || source.api !== model.api);
	if (isForeignToolCall) {
		const [callId, itemId] = id.split("|");
		const normalizeIdPart = (part: string): string => {
			const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
			const truncated = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
			return truncated.replace(/_+$/, "");
		};
		const normalizedCallId = normalizeIdPart(callId);
		let normalizedItemId = `fc_${Bun.hash(itemId).toString(36)}`;
		if (normalizedItemId.length > 64) normalizedItemId = normalizedItemId.slice(0, 64);
		return `${normalizedCallId}|${normalizedItemId}`;
	}
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId}`;
}

export function collectKnownCallIds(messages: ResponseInput): Set<string> {
	const knownCallIds = new Set<string>();
	for (const item of messages) {
		if (item.type === "function_call" && typeof item.call_id === "string") {
			knownCallIds.add(item.call_id);
		} else if (
			(item as { type?: string }).type === "custom_tool_call" &&
			typeof (item as { call_id?: string }).call_id === "string"
		) {
			knownCallIds.add((item as { call_id: string }).call_id);
		}
	}
	return knownCallIds;
}

/** Scan replay items for call_ids that were originally custom tool calls. */
export function collectCustomCallIds(messages: ResponseInput): Set<string> {
	const customCallIds = new Set<string>();
	for (const item of messages) {
		if (
			(item as { type?: string }).type === "custom_tool_call" &&
			typeof (item as { call_id?: string }).call_id === "string"
		) {
			customCallIds.add((item as { call_id: string }).call_id);
		}
	}
	return customCallIds;
}

export function convertResponsesInputContent(
	content: string | Array<TextContent | ImageContent>,
	supportsImages: boolean,
): ResponseInputContent[] | undefined {
	if (typeof content === "string") {
		if (content.trim().length === 0) return undefined;
		return [{ type: "input_text", text: content.toWellFormed() } satisfies ResponseInputText];
	}

	const normalizedContent = content
		.map((item): ResponseInputContent => {
			if (item.type === "text") {
				return {
					type: "input_text",
					text: item.text.toWellFormed(),
				} satisfies ResponseInputText;
			}
			return {
				type: "input_image",
				detail: "auto",
				image_url: `data:${item.mimeType};base64,${item.data}`,
			} satisfies ResponseInputImage;
		})
		.filter(item => supportsImages || item.type !== "input_image")
		.filter(item => item.type !== "input_text" || item.text.trim().length > 0);

	return normalizedContent.length > 0 ? normalizedContent : undefined;
}

export function convertResponsesAssistantMessage<TApi extends Api>(
	assistantMsg: AssistantMessage,
	model: Model<TApi>,
	msgIndex: number,
	knownCallIds: Set<string>,
	includeThinkingSignatures = true,
	customCallIds?: Set<string>,
): ResponseInput {
	const outputItems: ResponseInput = [];
	const isDifferentModel =
		assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;

	for (const block of assistantMsg.content) {
		if (block.type === "thinking" && assistantMsg.stopReason !== "error") {
			if (!includeThinkingSignatures) {
				continue;
			}
			if (block.thinkingSignature) {
				outputItems.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
			}
			continue;
		}

		if (block.type === "text") {
			const parsedSignature = parseTextSignature(block.textSignature);
			let msgId = parsedSignature?.id;
			if (!msgId) {
				msgId = `msg_${msgIndex}`;
			} else if (msgId.length > 64) {
				msgId = `msg_${Bun.hash(msgId).toString(36)}`;
			}
			outputItems.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
				status: "completed",
				id: msgId,
				phase: parsedSignature?.phase,
			} satisfies ResponseOutputMessage);
			continue;
		}

		if (block.type !== "toolCall") {
			continue;
		}

		const normalized = normalizeResponsesToolCallId(block.id);
		let itemId: string | undefined = normalized.itemId;
		if (isDifferentModel && (itemId?.startsWith("fc_") || itemId?.startsWith("fcr_"))) {
			itemId = undefined;
		}
		knownCallIds.add(normalized.callId);
		if (block.customWireName) {
			const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input : "";
			customCallIds?.add(normalized.callId);
			outputItems.push({
				type: "custom_tool_call",
				id: itemId,
				call_id: normalized.callId,
				name: block.customWireName,
				input: rawInput,
			} as ResponseInput[number]);
			continue;
		}
		outputItems.push({
			type: "function_call",
			id: itemId,
			call_id: normalized.callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
		});
	}

	return outputItems;
}

export function appendResponsesToolResultMessages<TApi extends Api>(
	messages: ResponseInput,
	toolResult: ToolResultMessage,
	model: Model<TApi>,
	strictResponsesPairing: boolean,
	knownCallIds: ReadonlySet<string>,
	customCallIds?: ReadonlySet<string>,
): void {
	const textResult = toolResult.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const hasImages = toolResult.content.some((block): block is ImageContent => block.type === "image");
	const normalized = normalizeResponsesToolCallId(toolResult.toolCallId);
	if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
		return;
	}

	const output = (textResult.length > 0 ? textResult : "(see attached image)").toWellFormed();
	if (customCallIds?.has(normalized.callId)) {
		messages.push({
			type: "custom_tool_call_output",
			call_id: normalized.callId,
			output,
		} as ResponseInput[number]);
	} else {
		messages.push({
			type: "function_call_output",
			call_id: normalized.callId,
			output,
		});
	}

	if (!hasImages || !model.input.includes("image")) {
		return;
	}

	const contentParts: ResponseInputContent[] = [
		{ type: "input_text", text: "Attached image(s) from tool result:" } satisfies ResponseInputText,
	];
	for (const block of toolResult.content) {
		if (block.type === "image") {
			contentParts.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${block.mimeType};base64,${block.data}`,
			} satisfies ResponseInputImage);
		}
	}
	messages.push({ role: "user", content: contentParts });
}

export interface ProcessResponsesStreamOptions {
	onFirstToken?: () => void;
	onOutputItemDone?: (item: ResponseOutputItem) => void;
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: ProcessResponsesStreamOptions,
): Promise<void> {
	let currentItem:
		| ResponseReasoningItem
		| ResponseOutputMessage
		| ResponseFunctionToolCall
		| ResponseCustomToolCall
		| null = null;
	let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	let sawFirstToken = false;

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			if (!sawFirstToken) {
				sawFirstToken = true;
				options?.onFirstToken?.();
			}
			const item = event.item;
			if (item.type === "reasoning") {
				currentItem = item;
				currentBlock = { type: "thinking", thinking: "", itemId: item.id };
				output.content.push(currentBlock);
				stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "message") {
				currentItem = item;
				currentBlock = { type: "text", text: "" };
				output.content.push(currentBlock);
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "function_call") {
				currentItem = item;
				currentBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "custom_tool_call") {
				currentItem = item;
				currentBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					// Preserve the raw wire name (e.g. `apply_patch`). The agent-loop
					// dispatcher matches it against both `Tool.name` and
					// `Tool.customWireName`, so this stays wire-accurate through
					// history replay while still routing to the right handler.
					name: item.name,
					arguments: { input: item.input ?? "" },
					customWireName: item.name,
					// Custom tools stream a raw string, but we reuse `partialJson` as the
					// accumulation buffer so later code that inspects the field still works.
					partialJson: item.input ?? "",
				};
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			if (currentItem?.type === "reasoning") {
				currentItem.summary = currentItem.summary || [];
				currentItem.summary.push(event.part);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += "\n\n";
					lastPart.text += "\n\n";
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_text.delta") {
			// Raw reasoning text delta from local providers that stream thinking
			// directly rather than via the OpenAI summary tracking protocol.
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			if (currentItem?.type === "message") {
				currentItem.content = currentItem.content || [];
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					currentItem.content.push(event.part);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				const lastPart = currentItem.content?.[currentItem.content.length - 1];
				if (lastPart?.type === "output_text") {
					currentBlock.text += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.refusal.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				const lastPart = currentItem.content?.[currentItem.content.length - 1];
				if (lastPart?.type === "refusal") {
					currentBlock.text += event.delta;
					lastPart.refusal += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson += event.delta;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson = event.arguments;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			if (currentItem?.type === "custom_tool_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson += event.delta;
				currentBlock.arguments = { input: currentBlock.partialJson };
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.custom_tool_call_input.done") {
			if (currentItem?.type === "custom_tool_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson = event.input;
				currentBlock.arguments = { input: event.input };
			}
		} else if (event.type === "response.output_item.done") {
			const item = structuredCloneJSON(event.item);
			options?.onOutputItemDone?.(item);
			if (item.type === "reasoning") {
				const thinking =
					item.summary?.length > 0
						? item.summary.map(part => part.text).join("\n\n")
						: item.content?.[0]?.type === "reasoning_text"
							? (item.content[0].text ?? "")
							: "";
				const reasoningBlock = output.content.find(
					b => b.type === "thinking" && (b as ThinkingContent).itemId === item.id,
				) as ThinkingContent | undefined;
				if (reasoningBlock) {
					reasoningBlock.thinking = thinking;
					reasoningBlock.thinkingSignature = JSON.stringify(item);
					const reasoningBlockIndex = output.content.indexOf(reasoningBlock);
					stream.push({
						type: "thinking_end",
						contentIndex: reasoningBlockIndex,
						content: thinking,
						partial: output,
					});
				}
				if ((currentBlock as ThinkingContent | null)?.itemId === item.id) currentBlock = null;
			} else if (item.type === "message" && currentBlock?.type === "text") {
				currentBlock.text = item.content
					.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? "")))
					.join("");
				currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: blockIndex(),
					content: currentBlock.text,
					partial: output,
				});
				currentBlock = null;
			} else if (item.type === "function_call") {
				const args =
					currentBlock?.type === "toolCall" && currentBlock.partialJson
						? parseStreamingJson(currentBlock.partialJson)
						: parseStreamingJson(item.arguments || "{}");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: args,
				};
				currentBlock = null;
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
			} else if (item.type === "custom_tool_call") {
				const rawInput =
					currentBlock?.type === "toolCall" && currentBlock.partialJson
						? currentBlock.partialJson
						: (item.input ?? "");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: { input: rawInput },
					customWireName: item.name,
				};
				currentBlock = null;
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
			}
		} else if (event.type === "response.completed") {
			const response = event.response;
			if (response?.id) {
				output.responseId = response.id;
			}
			if (response?.usage) {
				const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					input: (response.usage.input_tokens || 0) - cachedTokens,
					output: response.usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: response.usage.total_tokens || 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}
			calculateCost(model, output.usage);
			output.stopReason = mapOpenAIResponsesStopReason(response?.status);
			if (output.content.some(block => block.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const message = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(message);
		}
	}
}

export function mapOpenAIResponsesStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${exhaustive}`);
		}
	}
}
