import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentFlux from "../src/entry";
import { showAgentTuiMenu, showFluxTuiMenu } from "../src/extension/tui-menu";
import { isSlashArgumentBoundary, shouldContinueSlashCompletion } from "../src/extension/tui-autocomplete-bridge";

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
		let menuSelections: string[] = [];
		let menuInputs: string[] = [];
		const ctx: any = { cwd: root, hasUI: true, mode: "tui", model: { id: "test" }, ui: { notify: (text: string) => notices.push(text), select: async () => menuSelections.shift(), input: async () => menuInputs.shift() }, sessionManager: { getSessionFile: () => "tui-session", getBranch: () => [{ type: "message", id: "entry-1", message: { role: "user", content: [{ type: "text", text: "seed context" }] } }] }, fork: async () => ({ cancelled: false }) };
		for (const hook of pi.hooks.get("session_start") ?? []) await hook({}, ctx);
		check(pi.tools.has("flux_agent") && pi.tools.has("flux_team") && pi.tools.has("flux_workflow") && pi.tools.has("flux_issue"), "TUI 注册四条核心工具链");
		check(isSlashArgumentBoundary("/flux work ", " ") && !isSlashArgumentBoundary("plain text ", " "), "空格可触发 slash command 参数补全而不影响普通输入");
		check(shouldContinueSlashCompletion("/flux work", "\t") && !shouldContinueSlashCompletion("/flux work ", "\t"), "Tab 补全 slash 字段后继续显示下级选单");
		const flux = pi.commands.get("flux");
		const rootCompletions = await flux.getArgumentCompletions("");
		check(rootCompletions.some((item: any) => item.value === "work") && rootCompletions.some((item: any) => item.value === "agent"), "输入 /flux 空格显示顶层补全");
		check(await flux.getArgumentCompletions("agent") === null && await flux.getArgumentCompletions("work") === null, "补全为完整字段后退出候选态，Enter 可提交并打开菜单");
		const workCompletions = await flux.getArgumentCompletions("work ");
		check(workCompletions.map((item: any) => item.value).includes("work community"), "work 子命令补全显示四种工作方式");
		check((await flux.getArgumentCompletions("agent list"))?.length === 0, "完整子命令退出候选态，Enter 可直接执行");
		menuSelections = ["team · dynamic Agent collaboration"]; menuInputs = ["coordinate review"];
		await flux.handler("work", ctx);
		check(pi.sent.at(-1) === "coordinate review", "补全后的 /flux work 打开工作方式菜单");
		menuSelections = ["Work · start a task", "direct · Main Agent executes"]; menuInputs = ["menu task"];
		await flux.handler("", ctx);
		check(pi.sent.at(-1) === "menu task", "直接输入 /flux 可从 Workbench 菜单创建任务");
		await flux.handler("work direct implement core", ctx);
		check(pi.sent.at(-1) === "implement core" && notices.some(text => text.includes("work style direct")), "TUI Direct 将任务交给 Main Agent");
		await flux.handler("agent create reviewer-main reviewer", ctx);
		await flux.handler("agent list", ctx);
		check(notices.some(text => text.includes("reviewer-main")), "TUI 创建并列出 Persistent Agent");
		menuSelections = ["reviewer-main · persistent · reviewer · idle", "Details · show information"];
		await flux.handler("agent", ctx);
		check(notices.some(text => text.includes("Agent reviewer-main") && text.includes("capability")), "不带参数的 /flux agent 显示 Agent 列表与详细信息");
		menuSelections = ["reviewer-main · persistent · reviewer · idle", "Talk · continue Persistent session"]; menuInputs = ["review this change"];
		const talkCommand = await showAgentTuiMenu(ctx, { agents: [{ name: "reviewer-main", kind: "persistent", role: "reviewer", status: "idle", callCount: 0, totalCostUsd: 0, capabilityGeneration: 1, communication: "persistent_session" }], roles: ["reviewer"], issues: [], forkPoints: [], activeTaskIds: [] });
		check(talkCommand === "agent run reviewer-main review this change", "选择 Agent 后可直接输入消息并生成对话命令");
		menuSelections = ["worker-live · ephemeral · tester · running", "Message · send to active Agent"]; menuInputs = ["please report status"];
		const messageCommand = await showAgentTuiMenu(ctx, { agents: [{ name: "worker-live", kind: "ephemeral", role: "tester", status: "running", callCount: 1, totalCostUsd: 0, capabilityGeneration: 1, communication: "message" }], roles: [], issues: [], forkPoints: [], activeTaskIds: [] });
		check(messageCommand === "message worker-live please report status", "运行中的 Ephemeral Agent 可从列表发送 Message V2");
		const menuData = { agents: [], roles: ["reviewer"], issues: [], forkPoints: [{ entryId: "entry-1", preview: "seed context" }], activeTaskIds: ["task-running"] };
		menuSelections = ["Community · Issues and Claims", "+ Create Community Issue"]; menuInputs = ["new issue"];
		check(await showFluxTuiMenu(ctx, menuData) === "issue create new issue", "Workbench Community 子菜单可创建 Issue");
		menuSelections = ["Fork · branch from session context", "entry-1 · seed context"];
		check(await showFluxTuiMenu(ctx, menuData) === "fork entry-1", "Workbench Fork 子菜单可选择分支点");
		menuSelections = ["Runtime · status or cancel", "Cancel task", "task-running"];
		check(await showFluxTuiMenu(ctx, menuData) === "cancel task-running", "Workbench Runtime 子菜单可选择运行任务");
		menuSelections = ["Maintenance · lifecycle GC", "Dry run · preview only"];
		check(await showFluxTuiMenu(ctx, menuData) === "gc dry-run", "Workbench Maintenance 子菜单可选择 GC 操作");
		await flux.handler("work community coordinate fix", ctx);
		check(pi.sent.at(-1)?.includes("Community issue") && notices.some(text => text.includes("Created issue-")), "TUI Community 创建 Issue 并交给 Main moderator");
		await flux.handler("fork last", ctx);
		check(notices.some(text => text.includes("fork success")), "TUI 从会话 entry 创建 fork");
		for (const hook of pi.hooks.get("session_before_fork") ?? []) await hook({ targetEntryId: "entry-1" }, ctx);
		const forkEvent = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "agent.lifecycle" && event.origin === "fork");
		check(forkEvent?.kind === "main" && forkEvent?.forkPoint === "entry-1", "Fork lineage 写入 Agent lifecycle telemetry");
		await flux.handler("status", ctx);
		check(notices.some(text => text.includes("active runs")), "TUI 状态汇总可用");
		await flux.handler("gc dry-run", ctx);
		check(notices.some(text => text.includes("Lifecycle GC dry-run")), "TUI 生命周期 GC dry-run 可用");
		console.log(`\n${passed} TUI core checks passed`);
	} finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
