import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import taskPrompt from "../../src/prompts/tools/task.md" with { type: "text" };

describe("task tool prompt", () => {
	it("includes required description fields in example tasks", () => {
		const rendered = prompt.render(taskPrompt, {
			agents: [],
			asyncEnabled: true,
			contextEnabled: true,
			customSchemaEnabled: true,
			defaultMode: true,
			independentMode: false,
			isolationEnabled: false,
			schemaFreeMode: false,
		});

		expect(rendered).toContain("<description>Rename the export in parser.ts</description>");
		expect(rendered).toContain("<description>Update import and call sites in consuming modules</description>");
	});
});
