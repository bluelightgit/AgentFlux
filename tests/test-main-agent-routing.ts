import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentFlux from "../src/entry";
import { createAgentFluxTaskEnvelope, encodeAgentFluxTaskEnvelope } from "../src/core/task-envelope";

type Handler = (...args: any[]) => any;
class FakePi {
	hooks = new Map<string, Handler[]>(); tools = new Map<string, any>(); commands = new Map<string, any>();
	on(name: string, handler: Handler) { this.hooks.set(name, [...(this.hooks.get(name) ?? []), handler]); }
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	sendUserMessage() {}
}

let passed = 0;
function check(value: unknown, message: string): void { if (!value) throw new Error(message); passed++; console.log(`✓ ${message}`); }

async function emit(pi: FakePi, name: string, event: any, ctx: any): Promise<any[]> {
	const results = [];
	for (const hook of pi.hooks.get(name) ?? []) results.push(await hook(event, ctx));
	return results;
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "agentflux-routing-"));
	try {
		mkdirSync(join(root, ".agentflux"), { recursive: true });
		writeFileSync(join(root, ".agentflux", "agentflux.json"), JSON.stringify({ pricing: { enable_remote_fetch: false } }));
		writeFileSync(join(root, ".agentflux", "models.json"), JSON.stringify({ models: {}, roles: {} }));
		const pi = new FakePi(); agentFlux(pi as any);
		const ctx: any = { cwd: root, hasUI: false, mode: "print", model: { id: "test" }, sessionManager: { getSessionFile: () => "routing-session" } };
		await emit(pi, "session_start", {}, ctx);
		const promptResults = await emit(pi, "before_agent_start", { prompt: "检查一个小问题并回答", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		const systemPrompt = promptResults.find(result => result?.systemPrompt)?.systemPrompt ?? "";
		check(systemPrompt.includes("Choose Direct") && systemPrompt.includes("Choose Team") && systemPrompt.includes("Choose Workflow") && systemPrompt.includes("Choose Community"), "自然任务开始前注入完整工作方式协议");
		check(systemPrompt.includes("never ask them to explain AgentFlux"), "提示词明确用户无需解释 AgentFlux");
		await emit(pi, "agent_end", { isError: false }, ctx);
		const directEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line)).filter(event => event.type === "task.execution");
		check(directEvents.some(event => event.workStyle === "direct" && event.selectedBy === "main_agent" && event.action === "completed"), "未调用调度工具的自然任务记录为 Main Agent 选择 Direct");

		await emit(pi, "before_agent_start", { prompt: "职责不明确，需要认领后完成", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		await pi.tools.get("flux_issue").execute("tool-1", { action: "create", title: "协调检查", body: "认领后完成" });
		await emit(pi, "agent_end", { isError: false }, ctx);
		const allEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line));
		check(allEvents.some(event => event.type === "task.execution" && event.workStyle === "community" && event.selectedBy === "main_agent" && event.action === "started"), "Main Agent 调用 Community 工具时记录实际调度方式");

		const desktopPrompt = encodeAgentFluxTaskEnvelope(createAgentFluxTaskEnvelope({ taskId: "desktop-team-1", workStyle: "team", task: "并行检查实现与测试" }));
		const desktopResults = await emit(pi, "before_agent_start", { prompt: desktopPrompt, systemPrompt: "base", systemPromptOptions: {} }, ctx);
		const desktopSystemPrompt = desktopResults.find(result => result?.systemPrompt)?.systemPrompt ?? "";
		check(desktopSystemPrompt.includes("work style team") && desktopSystemPrompt.includes("lead Agent"), "Desktop 逐任务 envelope 固定 Team 工作方式");
		await emit(pi, "agent_end", { isError: false }, ctx);
		const desktopEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line));
		check(desktopEvents.some(event => event.type === "task.execution" && event.taskId === "desktop-team-1" && event.task === "并行检查实现与测试" && event.workStyle === "team"), "Desktop envelope 保留 taskId 且 telemetry 不记录协议头");

		process.env.AGENTFLUX_WORK_STYLE = "workflow";
		const fixedResults = await emit(pi, "before_agent_start", { prompt: "按固定依赖完成发布", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		const fixedPrompt = fixedResults.find(result => result?.systemPrompt)?.systemPrompt ?? "";
		check(fixedPrompt.includes("work style workflow") && fixedPrompt.includes("Use flux_workflow exactly once"), "Desktop 固定工作方式通过运行时契约注入 Main Agent");
		await emit(pi, "agent_end", { isError: false }, ctx);
		delete process.env.AGENTFLUX_WORK_STYLE;
		console.log(`\n${passed} main-Agent routing checks passed`);
	} finally { delete process.env.AGENTFLUX_WORK_STYLE; rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
