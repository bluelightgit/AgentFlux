import { parseWorkStyle } from "../core/config";
import type { WorkStyle } from "../core/types";

export type FluxCommand =
	| { kind: "help" }
	| { kind: "work"; style: WorkStyle; task: string }
	| { kind: "task"; args: string[] }
	| { kind: "workflow"; args: string[] }
	| { kind: "agent"; args: string[] }
	| { kind: "fork"; args: string[] }
	| { kind: "issue"; args: string[] }
	| { kind: "message"; args: string[] }
	| { kind: "cancel"; taskId?: string }
	| { kind: "gc"; dryRun: boolean }
	| { kind: "status" }
	| { kind: "compact" };

export interface FluxCompletionItem { value: string; label: string; description: string; }

const TOP_LEVEL_COMPLETIONS: FluxCompletionItem[] = [
	{ value: "work", label: "work", description: "启动 Direct / Team / Workflow / Community 任务" },
	{ value: "task", label: "task", description: "查看、复用、恢复或继续历史任务" },
	{ value: "workflow", label: "workflow", description: "查看、复用或修改固定 DAG 定义" },
	{ value: "agent", label: "agent", description: "管理 Persistent Agents" },
	{ value: "fork", label: "fork", description: "从当前会话上下文创建分支" },
	{ value: "issue", label: "issue", description: "管理 Community Issues 与 Claims" },
	{ value: "message", label: "message", description: "向运行中的 Agent 发送 Message V2" },
	{ value: "status", label: "status", description: "查看任务、Agent 与 Issue 状态" },
	{ value: "cancel", label: "cancel", description: "取消运行中的任务" },
	{ value: "gc", label: "gc", description: "回收终态 Agent、消息和孤儿 session" },
	{ value: "compact", label: "compact", description: "查看上下文压缩建议" },
	{ value: "help", label: "help", description: "显示完整命令帮助" },
];

function completions(prefix: string, options: Array<[string, string]>): FluxCompletionItem[] {
	if (options.some(([value]) => value === prefix)) return [];
	return options
		.filter(([value]) => value.startsWith(prefix))
		.map(([value, description]) => ({ value, label: value.split(" ").at(-1) ?? value, description }));
}

export function getFluxArgumentCompletions(argumentPrefix: string): FluxCompletionItem[] | null {
	const prefix = argumentPrefix.trimStart();
	if (!prefix.includes(" ")) {
		if (TOP_LEVEL_COMPLETIONS.some(item => item.value === prefix)) return null;
		const found = TOP_LEVEL_COMPLETIONS.filter(item => item.value.startsWith(prefix));
		return found.length ? found : null;
	}
	if (prefix.startsWith("work ")) return completions(prefix, [
		["work direct", "基础能力：Main Agent 直接执行"],
		["work team", "Direct + 动态创建或调用多个 Agent"],
		["work workflow", "Team + 固定依赖 DAG"],
		["work community", "Team + Issue/Claim 任务驱动协作"],
	]);
	if (prefix.startsWith("task ")) return completions(prefix, [
		["task list", "列出当前会话任务"], ["task show", "查看一个任务"],
		["task reuse", "复用最近任务的工作方式"], ["task resume", "恢复未完成任务"],
		["task continue", "基于最近结果继续"],
	]);
	if (prefix.startsWith("workflow ")) return completions(prefix, [
		["workflow list", "列出已保存 Workflow"], ["workflow show", "查看 Workflow DAG"],
		["workflow reuse", "按原版本创建新执行"], ["workflow modify", "生成新版本并执行"],
	]);
	if (prefix.startsWith("agent ")) return completions(prefix, [
		["agent list", "列出 Persistent Agents"], ["agent create", "从角色模板创建"],
		["agent run", "运行 Persistent Agent"], ["agent archive", "归档 Persistent Agent"],
	]);
	if (prefix.startsWith("issue ")) return completions(prefix, [
		["issue list", "列出 Issues"], ["issue create", "创建 Issue"], ["issue show", "查看 Issue"],
		["issue comment", "发表评论"], ["issue claim", "认领工作范围"], ["issue submit", "提交 Claim"],
		["issue resolve", "关闭已完成 Issue"],
	]);
	if (prefix.startsWith("fork ")) return completions(prefix, [["fork last", "从最近一条用户消息创建分支"]]);
	if (prefix.startsWith("message ")) return completions(prefix, [
		["message send", "向一个运行中的 Agent 发送消息"],
		["message inbox", "接收 Main Agent 收件箱"],
		["message ack", "确认一条已接收消息"],
		["message group list", "列出消息群组"],
		["message group create", "创建消息群组"],
		["message group send", "向群组所有其他成员发送消息"],
	]);
	if (prefix.startsWith("gc ")) return completions(prefix, [["gc dry-run", "仅预览，不修改数据"]]);
	return null;
}

export function parseFluxCommand(input: string): FluxCommand {
	const parts = input.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts[0] === "help") return { kind: "help" };
	if (parts[0] === "work") {
		const style = parseWorkStyle(parts[1]);
		if (!style) throw new Error("Usage: /flux work <direct|team|workflow|community> <task>");
		const task = parts.slice(2).join(" ").trim();
		if (!task) throw new Error("Task cannot be empty");
		return { kind: "work", style, task };
	}
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
	if (parts[0] === "compact") return { kind: "compact" };
	throw new Error(`Unknown /flux command: ${parts[0]}`);
}

export const FLUX_HELP = [
	"AgentFlux",
	"  /flux work <direct|team|workflow|community> <task>",
	"  /flux task list|show [selector]|reuse|resume|continue|retry [selector] [task]",
	"  /flux workflow list|show <selector>|reuse <selector> <task>|modify <selector> <change>",
	"  /flux agent list|create <name> <role>|run <name> <task>|archive <name>",
	"  /flux fork [last|index|entryId]",
	"  /flux issue list|create <title>|show <id>|comment <id> <text>|claim <id> <agent> <scope>|submit <id> <claimId>|resolve <id>",
	"  /flux message send <agent> <text>|inbox [agent]|ack <agent> <messageId>",
	"  /flux message group list|create <name> <member,...>|send <groupId> <text>",
	"  /flux cancel [taskId]",
	"  /flux gc [dry-run]",
	"  /flux status",
	"  /flux compact",
].join("\n");
