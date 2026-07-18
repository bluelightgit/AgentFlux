import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentFlux from "../src/entry";

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
		let menuSelection: string | undefined;
		let menuInput: string | undefined;
		const ctx: any = { cwd: root, hasUI: true, mode: "tui", model: { id: "test" }, ui: { notify: (text: string) => notices.push(text), select: async () => menuSelection, input: async () => menuInput }, sessionManager: { getSessionFile: () => "tui-session", getBranch: () => [{ type: "message", id: "entry-1", message: { role: "user", content: [{ type: "text", text: "seed context" }] } }] }, fork: async () => ({ cancelled: false }) };
		for (const hook of pi.hooks.get("session_start") ?? []) await hook({}, ctx);
		check(pi.tools.has("flux_agent") && pi.tools.has("flux_team") && pi.tools.has("flux_workflow") && pi.tools.has("flux_issue"), "TUI 注册四条核心工具链");
		const flux = pi.commands.get("flux");
		const rootCompletions = await flux.getArgumentCompletions("");
		check(rootCompletions.some((item: any) => item.value === "work") && rootCompletions.some((item: any) => item.value === "agent"), "输入 /flux 空格显示顶层补全");
		const workCompletions = await flux.getArgumentCompletions("work ");
		check(workCompletions.map((item: any) => item.value).includes("work community"), "work 子命令补全显示四种工作方式");
		menuSelection = "Direct · Main Agent 直接执行"; menuInput = "menu task";
		await flux.handler("", ctx);
		check(pi.sent.at(-1) === "menu task", "直接输入 /flux 可从 Workbench 菜单创建任务");
		await flux.handler("work direct implement core", ctx);
		check(pi.sent.at(-1) === "implement core" && notices.some(text => text.includes("work style direct")), "TUI Direct 将任务交给 Main Agent");
		await flux.handler("agent create reviewer-main reviewer", ctx);
		await flux.handler("agent list", ctx);
		check(notices.some(text => text.includes("reviewer-main")), "TUI 创建并列出 Persistent Agent");
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
