export const BUILTIN_TOOL_NAMES = [
	"ast_grep",
	"ast_edit",
	"render_mermaid",
	"ask",
	"bash",
	"debug",
	"python",
	"calc",
	"ssh",
	"edit",
	"gh_repo_view",
	"gh_issue_view",
	"gh_pr_view",
	"gh_pr_diff",
	"gh_pr_checkout",
	"gh_pr_push",
	"gh_run_watch",
	"gh_search_issues",
	"gh_search_prs",
	"find",
	"grep",
	"lsp",
	"notebook",
	"read",
	"inspect_image",
	"browser",
	"checkpoint",
	"rewind",
	"task",
	"cancel_job",
	"poll",
	"todo_write",
	"web_search",
	"search_tool_bm25",
	"write",
] as const;

export type ToolName = (typeof BUILTIN_TOOL_NAMES)[number];

const builtinToolNameSet = new Set<string>(BUILTIN_TOOL_NAMES);

export function isBuiltinToolName(value: string): value is ToolName {
	return builtinToolNameSet.has(value);
}
