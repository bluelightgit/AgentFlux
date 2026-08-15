import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentFlux from "../src/entry";
import { MessageBus } from "../src/core/message-bus";
import { SharedBoard } from "../src/core/shared-board";
import { showAgentTuiMenu, showFluxTuiMenu } from "../src/extension/tui-menu";
import { isSlashArgumentBoundary, shouldContinueSlashCompletion } from "../src/extension/tui-autocomplete-bridge";
import { Editor } from "@earendil-works/pi-tui";

type Handler = (...args: any[]) => any;
class FakePi {
	hooks = new Map<string, Handler[]>(); tools = new Map<string, any>(); commands = new Map<string, any>(); sent: string[] = [];
	on(name: string, handler: Handler) { this.hooks.set(name, [...(this.hooks.get(name) ?? []), handler]); }
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	sendUserMessage(message: string) { this.sent.push(message); }
}

let passed = 0;
function check(value: unknown, message: string): void { if (!value) throw new Error(message); passed++; console.log(`✓ ${message}`); }

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "agentflux-tui-"));
	try {
		mkdirSync(join(root, ".agentflux"), { recursive: true });
		writeFileSync(join(root, ".agentflux", "agentflux.json"), JSON.stringify({ pricing: { enable_remote_fetch: false } }));
		writeFileSync(join(root, ".agentflux", "models.json"), JSON.stringify({ models: {}, roles: {} }));
		const pi = new FakePi(); agentFlux(pi as any);
		const notices: string[] = [];
		const noticeLevels: string[] = [];
		const statuses: string[] = [];
		let menuSelections: string[] = [];
		let menuInputs: string[] = [];
		const ctx: any = { cwd: root, hasUI: true, mode: "tui", model: { id: "test" }, ui: { notify: (text: string, level?: string) => { notices.push(text); noticeLevels.push(level ?? "info"); }, setStatus: (_k: string, t?: string) => { if (t !== undefined) statuses.push(t); }, select: async () => menuSelections.shift(), input: async () => menuInputs.shift() }, sessionManager: { getSessionFile: () => "tui-session", getBranch: () => [{ type: "message", id: "entry-1", message: { role: "user", content: [{ type: "text", text: "seed context" }] } }] }, fork: async () => ({ cancelled: false }) };
		const fluxStderr: string[] = [];
		const originalConsoleError = console.error;
		console.error = (msg: unknown) => { const text = String(msg); if (text.includes("[flux")) fluxStderr.push(text); };
		try {
			for (const hook of pi.hooks.get("session_start") ?? []) await hook({}, ctx);
		} finally { console.error = originalConsoleError; }
		check(fluxStderr.length === 0, "TUI 会话启动不向 stderr 输出诊断日志（不挡输入区）");		check(pi.tools.has("flux_task") && pi.tools.has("flux_agent") && pi.tools.has("flux_workflow") && pi.tools.has("flux_issue") && pi.tools.has("flux_message"), "TUI 注册任务历史与核心工具链（flux_team 已移除）");
		let envelopeResult: unknown = undefined;
		for (const h of pi.hooks.get("input") ?? []) {
			envelopeResult = (await h({ text: `agentflux-task-v1:not-valid-base64url!\ntask` })) ?? envelopeResult;
		}
		check(envelopeResult === undefined, "畸形任务信封降级为普通消息（input hook 不抛错）");
		check(
			!pi.tools.has("flux_team")
				&& pi.tools.get("flux_workflow")?.description.includes("never a DAG or object"),
			"flux_team 已移除；Workflow 工具说明约束 selector 参数，减少模型参数误用",
		);
		check(isSlashArgumentBoundary("/flux work ", " ") && !isSlashArgumentBoundary("plain text ", " "), "空格可触发 slash command 参数补全而不影响普通输入");
		check(shouldContinueSlashCompletion("/flux work", "\t") && !shouldContinueSlashCompletion("/flux work ", "\t"), "Tab 补全 slash 字段后继续显示下级选单");
		// bridge 安装后：候选列表渲染被移到输入行上方，且打开后自动关闭定时器存在
		const bridgeMark = Symbol.for("agentflux.slash-argument-autocomplete");
		const bridgePatched = (Editor.prototype as any)[bridgeMark] === true;
		check(bridgePatched, "bridge 已安装到真实 pi-tui Editor 原型");
		const proto = Editor.prototype as any;
		const fakeEditor: any = {
			state: { lines: ["/flux task "], cursorLine: 0, cursorCol: 11 },
			autocompleteState: "regular",
			autocompleteList: { render: () => ["→ list", "  show", "  reuse"] },
			paddingX: 1,
			lastWidth: 0,
			borderColor: (s: string) => s,
			layoutText: () => [{ text: "/flux task ", hasCursor: true, cursorPos: 11 }],
			scrollOffset: 0,
			segment: (s: string) => [{ segment: s }],
			focused: false,
			tui: { terminal: { rows: 32 }, requestRender: () => undefined },
			visibleWidth: (s: string) => s.length,
			getBestAutocompleteMatchIndex: () => -1,
			createAutocompleteList: () => ({ setSelectedIndex: () => undefined }),
			cancelAutocompleteRequest: () => undefined,
			clearAutocompleteUi: () => undefined,
		};
		const rendered = (proto.render ?? (() => [])).call(fakeEditor, 120);
		check(rendered[0].includes("list"), "候选列表渲染在输入行上方（第一行即候选，而非底部）");
		const apply = proto.applyAutocompleteSuggestions;
		if (typeof apply === "function") {
			apply.call(fakeEditor, { items: [{ value: "list" }] }, "regular");
			check(fakeEditor[Symbol.for("agentflux.autocomplete-auto-close-timer")] !== undefined, "候选打开后注册自动关闭定时器");
			const cancel = proto.cancelAutocomplete;
			if (typeof cancel === "function") cancel.call(fakeEditor);
			check(fakeEditor[Symbol.for("agentflux.autocomplete-auto-close-timer")] === undefined, "取消候选时清除自动关闭定时器");
		}
		const flux = pi.commands.get("flux");
		const rootCompletions = await flux.getArgumentCompletions("");
		check(!rootCompletions.some((item: any) => item.value === "work") && rootCompletions.some((item: any) => item.value === "task") && rootCompletions.some((item: any) => item.value === "workflow") && rootCompletions.some((item: any) => item.value === "agent"), "输入 /flux 空格显示顶层补全（work 模式选择已移除）");
		check(await flux.getArgumentCompletions("agent") === null && await flux.getArgumentCompletions("task") === null, "补全为完整字段后退出候选态，Enter 可提交并打开菜单");
		// 空参数（尾随空格）不提供候选：候选列表由 pi 主进程控制，自动弹出会长时间占据输入框区域
		check(await flux.getArgumentCompletions("work ") === null && await flux.getArgumentCompletions("task ") === null, "空参数退出候选态，避免建议文本长时间显示在输入框区域");
		const workflowCompletions = await flux.getArgumentCompletions("workflow l");
		check(workflowCompletions?.map((item: any) => item.value).includes("workflow list"), "输入中（非空参数）仍显示 workflow 子命令候选");
		check((await flux.getArgumentCompletions("agent list"))?.length === 0, "完整子命令退出候选态，Enter 可直接执行");
		menuSelections = ["New task · describe outcome"]; menuInputs = ["menu task"];
		await flux.handler("", ctx);
		check(pi.sent.at(-1) === "menu task", "直接输入 /flux 可从 Workbench 菜单创建任务");
		menuSelections = ["Spaces · workflow/community and timeline"];
		await flux.handler("", ctx);
		check(notices.some(text => text.includes("active context")), "Workbench 菜单 Spaces 项输出空间总览（活跃上下文+workflow+issues+时间线）");
		check(notices.some(text => text.includes("recent agent activity")), "space 总览包含最近 Agent 活动时间线");
		await flux.handler("agent create reviewer-main reviewer", ctx);
		await flux.handler("agent list", ctx);
		check(notices.some(text => text.includes("reviewer-main")), "TUI 创建并列出 Persistent Agent");
		let mark = notices.length;
		await flux.handler("agent stop reviewer-main", ctx);
		check(notices.slice(mark).some(text => text.includes("not running")), "stop 空闲 Agent 报 not running");
		mark = notices.length;
		await flux.handler("agent stop ghost-agent", ctx);
		check(notices.slice(mark).some(text => text.includes("not found")), "stop 不存在的 Agent 报 not found");
		mark = notices.length;
		await flux.handler("agent retry reviewer-main", ctx);
		check(notices.slice(mark).some(text => text.includes("lastTask is empty")), "retry 无 lastTask 报错（不空跑子进程）");
		// 孤儿 running 状态（无本进程句柄）→ stop 重置为 idle
		const registryFile = join(root, ".agentflux", "runtime", "agents.json");
		const registry = JSON.parse(readFileSync(registryFile, "utf-8"));
		registry.agents = registry.agents.map((agent: any) => agent.name === "reviewer-main" ? { ...agent, status: "running" } : agent);
		writeFileSync(registryFile, JSON.stringify(registry, null, 2));
		await flux.handler("agent stop reviewer-main", ctx);
		const afterStop = JSON.parse(readFileSync(registryFile, "utf-8"));
		check(afterStop.agents.find((agent: any) => agent.name === "reviewer-main")?.status === "idle"
			&& notices.some(text => text.includes("reset to idle")), "孤儿 running 通过 stop 恢复控制权并重置为 idle");
		menuSelections = ["reviewer-main · subagent · reviewer · idle", "Details · show information"];
		await flux.handler("agent", ctx);
		check(notices.some(text => text.includes("Agent reviewer-main") && text.includes("capability")), "不带参数的 /flux agent 显示 Agent 列表与详细信息");
		menuSelections = ["reviewer-main · subagent · reviewer · idle", "Talk · continue Agent session"]; menuInputs = ["review this change"];
		const talkCommand = await showAgentTuiMenu(ctx, { agents: [{ name: "reviewer-main", kind: "subagent", role: "reviewer", status: "idle", callCount: 0, totalCostUsd: 0, capabilityGeneration: 1, communication: "persistent_session" }], roles: ["reviewer"], issues: [], forkPoints: [], activeTaskIds: [] });
		check(talkCommand === "agent run reviewer-main review this change", "选择 Agent 后可直接输入消息并生成对话命令");
		menuSelections = ["worker-live · subagent · tester · running", "Message · send to active Agent"]; menuInputs = ["please report status"];
		const messageCommand = await showAgentTuiMenu(ctx, { agents: [{ name: "worker-live", kind: "subagent", role: "tester", status: "running", callCount: 1, totalCostUsd: 0, capabilityGeneration: 1, communication: "message" }], roles: [], issues: [], forkPoints: [], activeTaskIds: [] });
		check(messageCommand === "message send worker-live please report status", "运行中的子代理可从列表发送 Message V2");
		const menuData = { agents: [], roles: ["reviewer"], issues: [], forkPoints: [{ entryId: "entry-1", preview: "seed context" }], activeTaskIds: ["task-running"], tasks: [{ id: "history-task", task: "previous review", status: "completed", operation: "new" }], workflows: [{ id: "workflow-one", name: "release-review", version: 2, description: "release", nodeCount: 3 }] };
		menuSelections = ["Tasks · reuse, resume or continue", "completed · previous review", "Continue"];
		check(await showFluxTuiMenu(ctx, menuData) === "task continue history-task", "Workbench Tasks 子菜单可继续历史任务");
		menuSelections = ["Workflows · saved fixed DAGs", "release-review · v2 · 3 nodes", "Show DAG"];
		check(await showFluxTuiMenu(ctx, menuData) === "workflow show workflow-one", "Workbench Workflows 子菜单可查看固定 DAG");
		menuSelections = ["Community · Issues and Claims", "+ Create Community Issue"]; menuInputs = ["new issue"];
		check(await showFluxTuiMenu(ctx, menuData) === "issue create new issue", "Workbench Community 子菜单可创建 Issue");
		menuSelections = ["Messages · groups and Main inbox", "Groups · list, create or send", "+ Create group"]; menuInputs = ["release-room", "reviewer-main,worker-live"];
		check(await showFluxTuiMenu(ctx, menuData) === "message group create release-room reviewer-main,worker-live", "Workbench Messages 子菜单可创建群组");
		await flux.handler("message group create release-room reviewer-main,worker-live", ctx);
		const group = new SharedBoard(join(root, ".agentflux")).listGroups().find(item => item.name === "release-room");
		check(group?.members.includes("main") && group.members.includes("reviewer-main"), "TUI 群组自动包含 Main 并保存成员");
		await flux.handler(`message group send ${group?.id} release ready`, ctx);
		const workerInbox = new MessageBus(join(root, ".agentflux")).peek("worker-live");
		check(workerInbox[0]?.envelope.channel.type === "group" && workerInbox[0]?.envelope.content === "release ready", "TUI 群发写入成员的 Message V2 inbox");
		const reply = new MessageBus(join(root, ".agentflux")).sendDirect("worker-live", "main", "message", "review complete");
		await flux.handler("message inbox main", ctx);
		check(new MessageBus(join(root, ".agentflux")).getDelivery(reply.envelope.id, "main")?.status === "delivered", "TUI Main inbox 接收消息并进入 delivered");
		await flux.handler(`message ack main ${reply.envelope.id}`, ctx);
		check(new MessageBus(join(root, ".agentflux")).getDelivery(reply.envelope.id, "main")?.status === "acknowledged", "TUI 可确认 Main inbox 消息");
		menuSelections = ["Fork · branch from session context", "entry-1 · seed context"];
		check(await showFluxTuiMenu(ctx, menuData) === "fork entry-1", "Workbench Fork 子菜单可选择分支点");
		menuSelections = ["Runtime · status or cancel", "Cancel task", "task-running"];
		check(await showFluxTuiMenu(ctx, menuData) === "cancel task-running", "Workbench Runtime 子菜单可选择运行任务");
		menuSelections = ["Maintenance · lifecycle GC", "Dry run · preview only"];
		check(await showFluxTuiMenu(ctx, menuData) === "gc dry-run", "Workbench Maintenance 子菜单可选择 GC 操作");
		await flux.handler("issue create coordinate fix", ctx);
		check(notices.some(text => text.includes("coordinate fix")), "TUI 直接创建 Community Issue（无模式选择）");
		await flux.handler("task list", ctx);
		check(notices.some(text => text.includes("AgentFlux tasks")), "TUI 可列出当前 Pi 会话的 Task Registry");
		// Main 会话 usage 落盘：turn_end 累计 → agent_settled 写入 telemetry 与任务 executions
		for (const h of pi.hooks.get("before_agent_start") ?? []) await h({ prompt: "report usage", systemPrompt: "base" }, ctx);
		for (const h of pi.hooks.get("turn_end") ?? []) await h({ turnIndex: 1, message: { role: "assistant", model: "oa/deepseek-v4-flash", usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 5, totalTokens: 120, cost: { total: 0.0004 } } } }, ctx);
		await flux.handler("usage", ctx);
		check(notices.some(text => text.includes("main usage this session") && text.includes("hit 44%")), "/flux usage 显示 Main 侧 token/缓存命中/成本");
		for (const h of pi.hooks.get("agent_settled") ?? []) await h({}, ctx);
		const usageEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line)).filter((event: any) => event.type === "task.execution" && event.usage);
		check(usageEvents.some((event: any) => event.usage.input === 100 && event.usage.cacheRead === 80 && event.usage.costUsd === 0.0004 && event.usage.model === "oa/deepseek-v4-flash"), "turn_end usage 累计落入 task.execution 事件");
		const tasksAfterUsage = JSON.parse(readFileSync(join(root, ".agentflux", "runtime", "tasks.json"), "utf-8"));
		check(tasksAfterUsage.executions.some((execution: any) => execution.usage?.input === 100 && execution.usage.costUsd === 0.0004), "执行记录持久化 Main usage（token/缓存/成本）");
		await flux.handler("fork last", ctx);
		check(notices.some(text => text.includes("fork success")), "TUI 从会话 entry 创建 fork");
		for (const hook of pi.hooks.get("session_before_fork") ?? []) await hook({ targetEntryId: "entry-1" }, ctx);
		const forkEvent = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "agent.lifecycle" && event.origin === "fork");
		check(forkEvent?.kind === "main" && forkEvent?.forkPoint === "entry-1", "Fork lineage 写入 Agent lifecycle telemetry");
		await flux.handler("status", ctx);
		check(notices.some(text => text.includes("active runs")), "TUI 状态汇总可用");
		await flux.handler("gc dry-run", ctx);
		check(notices.some(text => text.includes("Lifecycle GC dry-run")), "TUI 生命周期 GC dry-run 可用");
		check(noticeLevels.length > 0 && noticeLevels.every(level => level === "info"), `所有通知统一 info 级（对话底部浅灰小字样式）, 共 ${noticeLevels.length} 条`);
		console.log(`\n${passed} TUI core checks passed`);
	} finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
