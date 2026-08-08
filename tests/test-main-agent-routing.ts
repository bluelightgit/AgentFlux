import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentFlux from "../src/entry";
import { createAgentFluxTaskEnvelope, encodeAgentFluxTaskEnvelope } from "../src/core/task-envelope";
import { getTask } from "../src/core/task-registry";
import { createWorkflowDefinition, reviseWorkflowDefinition } from "../src/workflows/workflow-registry";

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

async function checkRejects(action: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
	let error: unknown;
	try { await action(); } catch (caught) { error = caught; }
	check(error instanceof Error && pattern.test(error.message), message);
}

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
		const ctx: any = { cwd: root, hasUI: false, mode: "print", model: { id: "test" }, sessionManager: { getSessionId: () => "pi-session-v7", getSessionFile: () => "routing-session" } };
		await emit(pi, "session_start", {}, ctx);
		const savedWorkflow = createWorkflowDefinition(join(root, ".agentflux"), {
			name: "empty-review",
			dag: { description: "empty deterministic Workflow", nodes: [] },
			sourceTaskId: "seed-task",
		});
		const promptResults = await emit(pi, "before_agent_start", { prompt: "检查一个小问题并回答", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		const systemPrompt = promptResults.find(result => result?.systemPrompt)?.systemPrompt ?? "";
		check(systemPrompt.includes("Work styles are cumulative") && systemPrompt.includes("Direct") && systemPrompt.includes("Team") && systemPrompt.includes("Workflow") && systemPrompt.includes("Community"), "自然任务开始前注入稳定递进工作方式协议");
		check(systemPrompt.includes("never ask them to explain AgentFlux"), "提示词明确用户无需解释 AgentFlux");
		check(!systemPrompt.includes("task-"), "稳定系统提示词不包含动态 taskId");
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, ctx);
		const routingEventPath = join(root, ".agentflux", "events.jsonl");
		const routingEvents = existsSync(routingEventPath)
			? readFileSync(routingEventPath, "utf-8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === "task.execution")
			: [];
		check(!routingEvents.some(event => event.action === "completed" || event.action === "failed"), "agent_end 自动重试边界不会提前写任务终态");
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		const directEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line)).filter(event => event.type === "task.execution");
		check(directEvents.some(event => event.workStyle === "direct" && event.selectedBy === "main_agent" && event.action === "completed"), "未调用调度工具的自然任务记录为 Main Agent 选择 Direct");
		const workflowList = await pi.tools.get("flux_workflow").execute("workflow-list", { action: "list" });
		check(workflowList.content[0].text.includes("empty-review"), "Main 可跨工作方式列出已保存 Workflow");
		const workflowShow = await pi.tools.get("flux_workflow").execute("workflow-show", { action: "show", workflow: savedWorkflow.id });
		check(workflowShow.content[0].text.includes("empty deterministic Workflow"), "Main 可查看指定 Workflow DAG");
		const revisedWorkflow = reviseWorkflowDefinition(join(root, ".agentflux"), savedWorkflow.id, {
			dag: { description: "empty deterministic Workflow v2", nodes: [] },
			sourceTaskId: "seed-task-v2",
		});
		const historicalWorkflow = await pi.tools.get("flux_workflow").execute("workflow-show-v1", { action: "show", workflow: `${savedWorkflow.id}@1` });
		check(revisedWorkflow.version === 2 && historicalWorkflow.details.definition.version === 1, "Workflow 修改后保留 v1 历史定义并生成 v2");

		const failedPrompt = encodeAgentFluxTaskEnvelope(createAgentFluxTaskEnvelope({ taskId: "desktop-failed-1", workStyle: "direct", task: "触发最终提供方错误" }));
		await emit(pi, "before_agent_start", { prompt: failedPrompt, systemPrompt: "base", systemPromptOptions: {} }, ctx);
		await checkRejects(
			() => pi.tools.get("flux_agent").execute("direct-agent", { action: "archive", name: "missing" }),
			/direct work style cannot archive an Agent/,
			"Direct 在运行时拒绝 Agent 管理与调用",
		);
		await checkRejects(
			() => pi.tools.get("flux_issue").execute("direct-issue", { action: "create", title: "must reject" }),
			/direct work style cannot create a Community Issue/,
			"Direct 在运行时拒绝 Community 写操作",
		);
		await checkRejects(
			() => pi.tools.get("flux_workflow").execute("direct-workflow", { task: "must reject" }),
			/direct work style cannot start a fixed Workflow/,
			"Direct 在运行时拒绝固定 DAG",
		);
		await checkRejects(
			() => pi.tools.get("flux_message").execute("direct-message", { action: "poll", target: "main" }),
			/direct work style cannot poll Agent messages/,
			"Direct 在运行时拒绝 Agent 消息能力",
		);
		await checkRejects(
			() => pi.tools.get("flux_task").execute("direct-switch", { action: "new", task: "switch", workStyle: "team" }),
			/direct is already active for this task; cannot switch to team/,
			"固定任务不能通过 flux_task 中途切换工作方式",
		);
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		const failedEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line));
		check(failedEvents.some(event => event.type === "task.execution" && event.taskId === "desktop-failed-1" && event.action === "failed" && event.outcome?.status === "failure"), "提供方最终错误在 agent_settled 后记录为失败而非完成");
		await pi.tools.get("flux_task").execute("task-retry", { action: "retry", selector: "desktop-failed-1" });
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		const retriedEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line));
		check(retriedEvents.some(event => event.type === "task.execution" && event.operation === "retry" && event.parentTaskId === "desktop-failed-1" && event.action === "completed"), "失败任务可精确重试并保留父任务关系");
		await pi.tools.get("flux_task").execute("task-resume", { action: "resume", selector: "desktop-failed-1", task: "继续失败的 Direct 任务" });
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		const resumedEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line));
		check(resumedEvents.some(event => event.type === "task.execution" && event.operation === "resume" && event.parentTaskId === "desktop-failed-1" && event.action === "completed"), "Direct 可在同一 Main 会话中恢复失败任务并保留父任务关系");

		const failedAgentPrompt = encodeAgentFluxTaskEnvelope(createAgentFluxTaskEnvelope({ taskId: "desktop-agent-failed", workStyle: "team", task: "运行一个配置错误的 Agent" }));
		await emit(pi, "input", { text: failedAgentPrompt, images: undefined }, ctx);
		await emit(pi, "before_agent_start", { prompt: "运行一个配置错误的 Agent", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		await checkRejects(
			() => pi.tools.get("flux_agent").execute("failed-agent", { action: "run_ephemeral", name: "missing-agent", role: "missing-role", task: "must fail" }),
			/Unknown Agent template/,
			"单 Agent 配置失败会显式返回错误",
		);
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		check(getTask(join(root, ".agentflux"), "desktop-agent-failed")?.status === "failed", "单 Agent 工具失败不能被 Main 最终文字覆盖为成功");

		await emit(pi, "before_agent_start", { prompt: "职责不明确，需要认领后完成", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		await pi.tools.get("flux_issue").execute("tool-1", { action: "create", title: "协调检查", body: "认领后完成" });
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		const allEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line));
		check(allEvents.some(event => event.type === "task.execution" && event.workStyle === "community" && event.selectedBy === "main_agent" && event.action === "started"), "Main Agent 调用 Community 工具时记录实际调度方式");

		const desktopPrompt = encodeAgentFluxTaskEnvelope(createAgentFluxTaskEnvelope({ taskId: "desktop-team-1", workStyle: "team", task: "并行检查实现与测试" }));
		const inputResults = await emit(pi, "input", { text: desktopPrompt, images: undefined }, ctx);
		check(inputResults.some(result => result?.action === "transform" && result.text === "并行检查实现与测试"), "任务信封在 Pi 持久化和 provider 请求前剥离");
		const desktopResults = await emit(pi, "before_agent_start", { prompt: "并行检查实现与测试", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		const desktopSystemPrompt = desktopResults.find(result => result?.systemPrompt)?.systemPrompt ?? "";
		check(desktopSystemPrompt.includes("AgentFlux Team mode") && !desktopSystemPrompt.includes("desktop-team-1"), "Desktop 逐任务 envelope 固定 Team 且不污染系统提示词");
		await checkRejects(
			() => pi.tools.get("flux_task").execute("self-continue", { action: "continue", selector: "desktop-team-1" }),
			/Cannot reuse, resume, continue or retry the currently active task/,
			"运行中的 task 不能把自身写成 parentTaskId",
		);
		await checkRejects(
			() => pi.tools.get("flux_workflow").execute("team-workflow", { task: "must reject" }),
			/team work style cannot start a fixed Workflow/,
			"Team 不能越级启动 Workflow",
		);
		await checkRejects(
			() => pi.tools.get("flux_issue").execute("team-issue", { action: "create", title: "must reject" }),
			/team work style cannot create a Community Issue/,
			"Team 不能越级写入 Community",
		);
		const createdGroup = await pi.tools.get("flux_message").execute("team-group-create", {
			action: "group_create",
			name: "desktop-review",
			members: ["reviewer", "tester"],
		});
		const groupSend = await pi.tools.get("flux_message").execute("team-group-send", {
			action: "group_send",
			group: createdGroup.details.id,
			content: "share review status",
			priority: "high",
		});
		check(createdGroup.details.members.includes("main") && groupSend.details.envelope.taskId === "desktop-team-1" && groupSend.details.deliveries.length === 2, "Main 可创建任务群组并发送带 taskId 的 Message V2");
		const teamPoll = await pi.tools.get("flux_message").execute("team-message", { action: "poll", target: "main" });
		check(Array.isArray(teamPoll.details), "Team 保留 Agent 消息能力");
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		const desktopEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line));
		check(desktopEvents.some(event => event.type === "task.execution" && event.sessionId === "pi-session-v7" && event.taskId === "desktop-team-1" && event.task === "并行检查实现与测试" && event.workStyle === "team"), "Pi 原生 sessionId 与 envelope taskId 只进入控制面 telemetry");
		const secondTeamPrompt = encodeAgentFluxTaskEnvelope(createAgentFluxTaskEnvelope({ taskId: "desktop-team-2", workStyle: "team", task: "另一个完全不同的 Team 任务" }));
		await emit(pi, "input", { text: secondTeamPrompt }, ctx);
		const secondTeamResults = await emit(pi, "before_agent_start", { prompt: "另一个完全不同的 Team 任务", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		const secondTeamSystemPrompt = secondTeamResults.find(result => result?.systemPrompt)?.systemPrompt ?? "";
		check(secondTeamSystemPrompt === desktopSystemPrompt, "同一工作方式跨任务复用完全一致的 system prompt");
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);

		process.env.AGENTFLUX_WORK_STYLE = "workflow";
		const fixedResults = await emit(pi, "before_agent_start", { prompt: "按固定依赖完成发布", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		const fixedPrompt = fixedResults.find(result => result?.systemPrompt)?.systemPrompt ?? "";
		check(fixedPrompt.includes("AgentFlux Workflow mode") && fixedPrompt.includes("flux_workflow exactly once") && !fixedPrompt.includes("Task task-"), "Desktop 固定工作方式使用稳定模式提示词");
		await checkRejects(
			() => pi.tools.get("flux_issue").execute("workflow-issue", { action: "create", title: "must reject" }),
			/workflow work style cannot create a Community Issue/,
			"Workflow 与 Community 保持平级互斥",
		);
		const entrySource = readFileSync(join(process.cwd(), "src", "entry.ts"), "utf-8");
		check(entrySource.includes('const plan = requireWorkStyleCapability("workflow", "workflow"'), "Workflow 工具复用 Desktop 外层 taskId 而不创建第二个 execution");
		const reusedWorkflow = await pi.tools.get("flux_workflow").execute("workflow-reuse", { action: "reuse", workflow: savedWorkflow.id });
		check(reusedWorkflow.content[0].text.includes("[DAG Execution: PASSED]"), "已保存 Workflow 可跳过 planner 直接创建新执行");
		await checkRejects(
			() => pi.tools.get("flux_workflow").execute("workflow-repeated", { action: "reuse", workflow: savedWorkflow.id }),
			/Workflow execution already started/,
			"同一 task 不能重复启动 Workflow execution 或生成额外版本",
		);
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		const workflowTasks = JSON.parse(readFileSync(join(root, ".agentflux", "runtime", "tasks.json"), "utf-8")).tasks;
		check(workflowTasks.some((task: any) => task.workStyle === "workflow" && task.resource?.id === savedWorkflow.id && task.resource?.version === 2), "Workflow execution 的 Task Registry 冻结稳定定义 ID 与执行版本");
		check(workflowTasks.some((task: any) => task.workStyle === "workflow" && task.operation === "reuse" && task.parentTaskId === revisedWorkflow.sourceTaskId), "直接调用 Workflow reuse 也会修正 task operation 与父任务谱系");
		delete process.env.AGENTFLUX_WORK_STYLE;
		const reusableTask = workflowTasks.find((task: any) => task.workStyle === "workflow" && task.resource?.id === savedWorkflow.id);
		reviseWorkflowDefinition(join(root, ".agentflux"), savedWorkflow.id, {
			dag: { description: "empty deterministic Workflow v3", nodes: [] },
			sourceTaskId: "seed-task-v3",
		});
		await pi.tools.get("flux_task").execute("workflow-task-reuse", { action: "reuse", selector: reusableTask.id, task: "再次执行保存的流程" });
		const inferredReuse = await pi.tools.get("flux_workflow").execute("workflow-inferred-reuse", {});
		check(inferredReuse.content[0].text.includes("[DAG Execution: PASSED]"), "flux_task reuse 会自动解析并复用关联 Workflow 定义");
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		const versionedTasks = JSON.parse(readFileSync(join(root, ".agentflux", "runtime", "tasks.json"), "utf-8")).tasks;
		check(versionedTasks.some((task: any) => task.operation === "reuse" && task.parentTaskId === reusableTask.id && task.resource?.version === 2), "历史 task reuse 冻结原执行版本，不漂移到最新 Workflow");

		const communityPrompt = encodeAgentFluxTaskEnvelope(createAgentFluxTaskEnvelope({ taskId: "desktop-community-1", workStyle: "community", task: "动态认领任务" }));
		await emit(pi, "input", { text: communityPrompt }, ctx);
		await emit(pi, "before_agent_start", { prompt: "动态认领任务", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		await checkRejects(
			() => pi.tools.get("flux_workflow").execute("community-workflow", { task: "must reject" }),
			/community work style cannot start a fixed Workflow/,
			"Community 与 Workflow 保持平级互斥",
		);
		await emit(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emit(pi, "agent_settled", {}, ctx);
		check(pi.tools.has("flux_task"), "Main Agent 可查询并准备复用、恢复与继续任务");
		const listed = await pi.tools.get("flux_task").execute("task-list", { action: "list" });
		check(listed.content[0].text.includes("AgentFlux tasks"), "Task Registry 可列出当前 Pi 会话历史");
		const shutdownPrompt = encodeAgentFluxTaskEnvelope(createAgentFluxTaskEnvelope({ taskId: "desktop-shutdown-1", workStyle: "team", task: "关闭前仍在运行" }));
		await emit(pi, "input", { text: shutdownPrompt }, ctx);
		await emit(pi, "before_agent_start", { prompt: "关闭前仍在运行", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		await emit(pi, "session_shutdown", {}, ctx);
		check(getTask(join(root, ".agentflux"), "desktop-shutdown-1")?.status === "cancelled", "会话关闭会把未收敛任务标记为 cancelled 而非永久 running");
		console.log(`\n${passed} main-Agent routing checks passed`);
	} finally { delete process.env.AGENTFLUX_WORK_STYLE; rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
