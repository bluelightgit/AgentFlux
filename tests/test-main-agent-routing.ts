import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentFlux from "../src/entry";

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
		console.log(`\n${passed} main-Agent routing checks passed`);
	} finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
