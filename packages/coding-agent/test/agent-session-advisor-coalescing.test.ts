import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

const INTERMEDIATE_TEXT = "INTERMEDIATE_ASSISTANT_MARKER";
const TOOL_RESULT_CONTENT = "TOOL_RESULT_MARKER";
const TOOL_RESULT_HISTORY = "→ read(fixture.txt) ⇒ ok · 1 line";
const TERMINAL_TEXT = "TERMINAL_ASSISTANT_MARKER";

interface Harness {
	session: AgentSession;
	advisorMock: MockModel;
	advisorCallsBeforeTerminal: number[];
}

function advisorInput(mock: MockModel, index: number): string {
	const message = mock.calls[index]?.context.messages.at(-1);
	if (message?.role !== "user") throw new Error(`Expected advisor call ${index} to end in a user update`);
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

function readTool(): AgentTool {
	const parameters = type({ path: "string" });
	return {
		name: "read",
		label: "Read",
		description: "Return deterministic fixture contents",
		parameters,
		async execute() {
			return { content: [{ type: "text" as const, text: TOOL_RESULT_CONTENT }] };
		},
	};
}

describe("AgentSession advisor tool-loop coalescing", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-advisor-coalescing-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await tempDir.remove();
		}
	});

	async function createHarness(coalesceToolTurns?: boolean): Promise<Harness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const advisorMock = createMockModel({
			responses: [{ content: ["first review complete"] }, { content: ["second review complete"] }],
		});
		const advisorCallsBeforeTerminal: number[] = [];
		const primaryMock = createMockModel({
			responses: [
				{
					content: [
						INTERMEDIATE_TEXT,
						{ type: "toolCall", id: "read-fixture", name: "read", arguments: { path: "fixture.txt" } },
					],
				},
				() => {
					advisorCallsBeforeTerminal.push(advisorMock.calls.length);
					return { content: [TERMINAL_TEXT], stopReason: "stop" };
				},
			],
		});
		const tool = readTool();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: primaryMock.stream,
		});
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "1",
			...(coalesceToolTurns === undefined ? {} : { "advisor.coalesceToolTurns": coalesceToolTurns }),
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join(`models-${Snowflake.next()}.yml`)),
			toolRegistry: new Map([[tool.name, tool]]),
			builtInToolNames: [tool.name],
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		created.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		expect(created.setAdvisorEnabled(true)).toBe(true);
		session = created;
		return { session: created, advisorMock, advisorCallsBeforeTerminal };
	}

	it("reviews both healthy primary boundaries when coalescing is disabled", async () => {
		const harness = await createHarness(false);

		await harness.session.prompt("inspect the fixture");
		await harness.session.waitForIdle();

		expect(harness.advisorCallsBeforeTerminal).toEqual([1]);
		expect(harness.advisorMock.calls).toHaveLength(2);
		expect(advisorInput(harness.advisorMock, 0)).toContain(INTERMEDIATE_TEXT);
		expect(advisorInput(harness.advisorMock, 0)).toContain(TOOL_RESULT_HISTORY);
		expect(advisorInput(harness.advisorMock, 0)).not.toContain(TERMINAL_TEXT);
		expect(advisorInput(harness.advisorMock, 1)).toContain(TERMINAL_TEXT);
	});

	it("defers the intermediate boundary and reviews the complete tool-loop delta once when enabled", async () => {
		const harness = await createHarness(true);

		await harness.session.prompt("inspect the fixture");
		await harness.session.waitForIdle();

		expect(harness.advisorCallsBeforeTerminal).toEqual([0]);
		expect(harness.advisorMock.calls).toHaveLength(1);
		const input = advisorInput(harness.advisorMock, 0);
		const intermediateIndex = input.indexOf(INTERMEDIATE_TEXT);
		const toolResultIndex = input.indexOf(TOOL_RESULT_HISTORY);
		const terminalIndex = input.indexOf(TERMINAL_TEXT);
		expect(intermediateIndex).toBeGreaterThanOrEqual(0);
		expect(toolResultIndex).toBeGreaterThan(intermediateIndex);
		expect(terminalIndex).toBeGreaterThan(toolResultIndex);
	});
});
