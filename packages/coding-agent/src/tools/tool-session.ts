import type { ToolChoice } from "@oh-my-pi/pi-ai";
import type { AsyncJobManager } from "../async";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { Skill } from "../extensibility/skills";
import type { InternalUrlRouter } from "../internal-urls";
import type { DiscoverableMCPSearchIndex, DiscoverableMCPTool } from "../mcp/discoverable-tool-metadata";
import type { MCPManager } from "../mcp/manager";
import type { PlanModeState } from "../plan-mode/state";
import type { AuthStorage } from "../session/auth-storage";
import type { CustomMessage } from "../session/messages";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import type { AgentOutputManager } from "../task/output-manager";
import type { EventBus } from "../utils/event-bus";
import type { CheckpointState } from "./checkpoint";
import type { TodoPhase } from "./todo-write";

export interface ContextFileEntry {
	path: string;
	content: string;
	depth?: number;
}

/** Session context shared by tool factories and tool implementations. */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** Whether UI is available */
	hasUI: boolean;
	/** Skip Python kernel availability check and warmup */
	skipPythonPreflight?: boolean;
	/** Force Python prelude warmup even when test env would normally skip it */
	forcePythonWarmup?: boolean;
	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded skills */
	skills?: Skill[];
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Whether an edit-capable tool is available in this session (controls hashline output) */
	hasEditTool?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the submit_result tool by default */
	requireSubmitResultTool?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Get session file */
	getSessionFile(): string | null;
	/** Get Python kernel owner ID for session-scoped retained-kernel cleanup */
	getPythonKernelOwnerId?: () => string | null;
	/** Reject new Python work once session disposal has started. */
	assertPythonExecutionAllowed?: () => void;
	/** Track tool-owned Python work so session disposal can await/abort it like direct session Python runs. */
	trackPythonExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Get artifacts directory for artifact:// URLs */
	getArtifactsDir?: () => string | null;
	/** Allocate a new artifact path and ID for session-scoped truncated output. */
	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;
	/** Get session spawns */
	getSessionSpawns(): string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: ModelRegistry;
	/** MCP manager for proxying MCP calls through parent */
	mcpManager?: MCPManager;
	/** Internal URL router for protocols like agent://, skill://, and mcp:// */
	internalRouter?: InternalUrlRouter;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/** Async background job manager for bash/task async execution */
	asyncJobManager?: AsyncJobManager;
	/** Settings instance for passing to subagents */
	settings: Settings;
	/** Plan mode state (if active) */
	getPlanModeState?: () => PlanModeState | undefined;
	/** Get compact conversation context for subagents (excludes tool results, system prompts) */
	getCompactContext?: () => string;
	/** Get cached todo phases for this session. */
	getTodoPhases?: () => TodoPhase[];
	/** Replace cached todo phases for this session. */
	setTodoPhases?: (phases: TodoPhase[]) => void;
	/** Whether MCP tool discovery is active for this session. */
	isMCPDiscoveryEnabled?: () => boolean;
	/** Get hidden-but-discoverable MCP tools for search_tool_bm25 prompts and fallbacks. */
	getDiscoverableMCPTools?: () => DiscoverableMCPTool[];
	/** Get the cached discoverable MCP search index for search_tool_bm25 execution. */
	getDiscoverableMCPSearchIndex?: () => DiscoverableMCPSearchIndex;
	/** Get MCP tools activated by prior search_tool_bm25 calls. */
	getSelectedMCPToolNames?: () => string[];
	/** Merge MCP tool selections into the active session tool set. */
	activateDiscoveredMCPTools?: (toolNames: string[]) => Promise<string[]>;
	/** The tool-choice queue used to force forthcoming tool invocations and carry invocation handlers. */
	getToolChoiceQueue?(): ToolChoiceQueue;
	/** Build a model-provider-specific ToolChoice that targets the named tool, or undefined if unsupported. */
	buildToolChoice?(toolName: string): ToolChoice | undefined;
	/** Steer a hidden custom message into the conversation (e.g. a preview reminder). */
	steer?(message: { customType: string; content: string; details?: unknown }): void;
	/** Peek the currently in-flight tool-choice queue directive's invocation handler. Used by the `resolve` tool to dispatch to the pending action. */
	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Get active checkpoint state if any. */
	getCheckpointState?: () => CheckpointState | undefined;
	/** Set or clear active checkpoint state. */
	setCheckpointState?: (state: CheckpointState | null) => void;
	/** Queue a hidden message to be injected at the next agent turn. */
	queueDeferredMessage?(message: CustomMessage): void;
}
