export type FluxCommand =
	| { kind: "help" }
	| { kind: "task"; args: string[] }
	| { kind: "workflow"; args: string[] }
	| { kind: "agent"; args: string[] }
	| { kind: "fork"; args: string[] }
	| { kind: "issue"; args: string[] }
	| { kind: "message"; args: string[] }
	| { kind: "cancel"; taskId?: string }
	| { kind: "gc"; dryRun: boolean }
	| { kind: "status" }
	| { kind: "space" }
	| { kind: "usage" }
	| { kind: "compact" };

export interface FluxCompletionItem { value: string; label: string; description: string; }

const TOP_LEVEL_COMPLETIONS: FluxCompletionItem[] = [
		{ value: "task", label: "task", description: "List, reuse, resume, or continue prior tasks" },
	{ value: "workflow", label: "workflow", description: "View, reuse, or modify saved fixed DAG definitions" },
	{ value: "agent", label: "agent", description: "Manage Agents" },
	{ value: "fork", label: "fork", description: "Create a branch from the current session context" },
	{ value: "issue", label: "issue", description: "Manage Community Issues and Claims" },
	{ value: "message", label: "message", description: "Send Message V2 messages to running Agents" },
	{ value: "status", label: "status", description: "View task, Agent, and Issue status" },
	{ value: "space", label: "space", description: "View workflow/community space and execution timeline" },
	{ value: "usage", label: "usage", description: "View per-turn Main token usage, cache hits, and cost" },
	{ value: "cancel", label: "cancel", description: "Cancel active tasks" },
	{ value: "gc", label: "gc", description: "Collect terminal Agents, messages, and orphaned sessions" },
	{ value: "compact", label: "compact", description: "View context compaction advice" },
	{ value: "help", label: "help", description: "Show full command help" },
];

function completions(prefix: string, options: Array<[string, string]>): FluxCompletionItem[] {
	if (options.some(([value]) => value === prefix)) return [];
	return options
		.filter(([value]) => value.startsWith(prefix))
		.map(([value, description]) => ({ value, label: value.split(" ").at(-1) ?? value, description }));
}

export function getFluxArgumentCompletions(argumentPrefix: string): FluxCompletionItem[] | null {
	const prefix = argumentPrefix.trimStart();
	// 当前字段为空（尾随空格）：不提供候选，让列表立即关闭。
	// 原因：候选列表的显示位置与生命周期由 pi 主进程控制，扩展无法移动或定时关闭；
	// 空参数自动弹出会让“建议文本”长时间占据输入框区域。打字中（非空字段）仍提示。
	if (prefix.endsWith(" ")) return null;
	if (!prefix.includes(" ")) {
		if (TOP_LEVEL_COMPLETIONS.some(item => item.value === prefix)) return null;
		const found = TOP_LEVEL_COMPLETIONS.filter(item => item.value.startsWith(prefix));
		return found.length ? found : null;
	}
	if (prefix.startsWith("task ")) return completions(prefix, [
		["task list", "List tasks in the current session"], ["task show", "Inspect a task"],
		["task reuse", "Reuse a prior task's execution approach"], ["task resume", "Resume an unfinished task"],
		["task continue", "Continue from a prior result"],
	]);
	if (prefix.startsWith("workflow ")) return completions(prefix, [
		["workflow list", "List saved Workflows"], ["workflow show", "View a Workflow DAG"],
		["workflow reuse", "Create a run from the saved version"], ["workflow modify", "Create and run a new version"],
		["workflow delete", "Delete a saved Workflow definition"],
	]);
	if (prefix.startsWith("agent ")) return completions(prefix, [
		["agent list", "List Agents"], ["agent inspect", "View the live Run, health, and recent transcript"], ["agent create", "Create an Agent (default, role template, or fork)"],
		["agent run", "Talk to an Agent and optionally choose its role"], ["agent steer", "Queue an instruction for a running Agent via Message V2"], ["agent stop", "Stop a running Agent"], ["agent retry", "Re-run the last task"],
		["agent delete", "Delete an Agent"], ["agent gc", "Run GC and keep the latest k Agents"],
	]);
	if (prefix.startsWith("issue ")) return completions(prefix, [
		["issue list", "List Issues"], ["issue create", "Create an Issue"], ["issue show", "View an Issue"],
		["issue comment", "Add a comment"], ["issue propose", "Propose a plan"], ["issue support", "Support a proposal"], ["issue oppose", "Oppose a proposal"],
		["issue claim", "Claim work (optionally binding proposals and a plan)"], ["issue submit", "Submit a Claim"],
		["issue review", "Review a submitted Claim (pass/rework)"], ["issue resolve", "Close a completed Issue"],
		["issue delete", "Delete a completed Issue"],
	]);
	if (prefix.startsWith("fork ")) return completions(prefix, [["fork last", "Create a branch from the latest user message"]]);
	if (prefix.startsWith("message ")) return completions(prefix, [
		["message send", "Send a message to a running Agent"],
		["message inbox", "Read the Main Agent inbox"],
		["message ack", "Acknowledge a received message"],
		["message group list", "List message groups"],
		["message group create", "Create a message group"],
		["message group send", "Send a message to the other group members"],
	]);
	if (prefix.startsWith("gc ")) return completions(prefix, [["gc dry-run", "Preview changes without modifying data"]]);
	return null;
}

/** 解析 --model <m> / --thinking <t> / --role <role> / --roles <r1,r2> / --session-mode <shared|fresh> / --background / --sync 覆盖参数，其余参数保持位置语义。 */
export function parseAgentFlags(rest: string[]): { flags: Record<string, string>; positional: string[] } {
	const flags: Record<string, string> = {};
	const positional: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const item = rest[index];
		if (item === "--model" || item === "--thinking" || item === "--role" || item === "--roles" || item === "--session-mode") {
			const value = rest[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`${item} requires a value`);
			const key = item === "--session-mode" ? "sessionMode" : item.slice(2);
			flags[key] = value;
			index++;
		} else if (item === "--background" || item === "--sync") {
			flags[item.slice(2)] = "true";
		} else {
			positional.push(item);
		}
	}
	return { flags, positional };
}

export function parseFluxCommand(input: string): FluxCommand {
	const parts = input.trim().replace(/^\/flux(?:\s+|$)/, "").split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts[0] === "help") return { kind: "help" };
	if (parts[0] === "agent") return { kind: "agent", args: parts.slice(1) };
	if (parts[0] === "task") return { kind: "task", args: parts.slice(1) };
	if (parts[0] === "workflow") return { kind: "workflow", args: parts.slice(1) };
	if (parts[0] === "fork") return { kind: "fork", args: parts.slice(1) };
	if (parts[0] === "issue") return { kind: "issue", args: parts.slice(1) };
	if (parts[0] === "message") return { kind: "message", args: parts.slice(1) };
	if (parts[0] === "cancel") return { kind: "cancel", taskId: parts[1] };
	if (parts[0] === "gc") {
		if (parts[1] && parts[1] !== "dry-run") throw new Error("Usage: /flux gc [dry-run]");
		return { kind: "gc", dryRun: parts[1] === "dry-run" };
	}
	if (parts[0] === "status") return { kind: "status" };
	if (parts[0] === "space") return { kind: "space" };
	if (parts[0] === "usage") return { kind: "usage" };
	if (parts[0] === "compact") return { kind: "compact" };
	throw new Error(`Unknown /flux command: ${parts[0]}`);
}

export const FLUX_HELP = [
	"AgentFlux",
	"  /flux task list|show [selector]|reuse|resume|continue|retry [selector] [task]",
	"  /flux workflow list|show <selector>|reuse <selector> <task>|modify <selector> <change>|delete <selector>",
	"  /flux agent list|inspect <name> [last]|create <name> [role] [--roles <role1,role2>]|run <name> <task> [--role <role>] [--session-mode <shared|fresh>] [--model <m>] [--thinking <t>] [--sync]|steer <name> <instruction>|stop <name>|retry <name>|delete <name>|gc [keepLatestK]",
	"  /flux fork [last|index|entryId]",
	"  /flux issue list|create <title>|show <id>|comment <id> <text>|propose <id> <title> <body>|support|oppose <id> <proposalId>|claim <id> <agent> <scope> [--plan <text>] [--props <id1,id2>]|submit <id> <claimId> [--plan <text>]|review <id> <claimId> pass|rework [feedback]|resolve <id>|delete <id>",
	"  /flux message send <agent> <text>|inbox [agent]|ack <agent> <messageId>",
	"  /flux message group list|create <name> <member,...>|send <groupId> <text>",
	"  /flux cancel [taskId]",
	"  /flux gc [dry-run]",
	"  /flux status",
	"  /flux space",
	"  /flux usage",
	"  /flux compact",
].join("\n");
