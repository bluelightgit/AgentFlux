import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createEphemeralRecord, finishEphemeralRecord, startEphemeralRecord } from "./agents/agent-lifecycle";
import { formatAgentRunResult, runAgent, type AgentRunResult, type AgentTemplate } from "./agents/agent-runner";
import { archivePersistentAgent, formatPersistentAgents, listPersistentAgents, registerPersistentAgent, resetPersistentAgentStatus, runPersistentAgent, type PersistentAgentContext } from "./agents/persistent-agent";
import { getForkCandidates, handleForkCommand, registerSessionFork } from "./agents/session-fork";
import { loadAllRoles } from "./agents/templates";
import { createIssue, claimIssue, commentOnIssue, formatIssue, formatIssueTimeline, getIssue, listIssues, resolveIssue, reviewClaim, submitClaim } from "./core/community";
import { loadConfig, loadModelsConfig, resolveSharedSkills, validateConfig } from "./core/config";
import { MessageBus, type DeliveredMessageV2 } from "./core/message-bus";
import { SharedBoard } from "./core/shared-board";
import { formatLifecycleGcReport, runLifecycleGc } from "./core/lifecycle-gc";
import { loadPricing, type PricingTable } from "./core/pricing";
import { createTaskExecutionPlan, formatTaskExecutionPlan, type TaskExecutionPlan } from "./core/task-execution";
import { resolvePathInsideExistingRoot } from "./core/safe-path";
import { parseAgentFluxTaskEnvelope, type AgentFluxTaskEnvelope } from "./core/task-envelope";
import { formatTasks, getTask, listTasks, registerTask, resolveTask, updateTaskMetadata, updateTaskStatus, type TaskStatus } from "./core/task-registry";
import { analyzeCompaction, formatCompactionAdvice, registerCompactionAdvisor } from "./extension/compaction-advisor";
import { FLUX_HELP, getFluxArgumentCompletions, parseFluxCommand } from "./extension/commands";
import { applyPrefixLayout } from "./extension/prefix-layout";
import { showAgentTuiMenu, showFluxTuiMenu, showForkTuiMenu, showIssueTuiMenu, showMessageTuiMenu, showTaskTuiMenu, showWorkflowTuiMenu, type FluxTuiMenuData } from "./extension/tui-menu";
import { installSlashArgumentAutocompleteBridge } from "./extension/tui-autocomplete-bridge";
import { TelemetryWriter } from "./telemetry/events";
import { executeDAG, formatDAGResult, generateTaskDAG, resolveDAGRoleModel, setDagLogSink, type DAGExecutionResult, type TaskDAG } from "./workflows/dag-executor";
import { createWorkflowDefinition, formatWorkflowDefinitions, getWorkflowDefinition, listWorkflowDefinitions, reviseWorkflowDefinition } from "./workflows/workflow-registry";

interface RuntimeContext {
	cwd: string;
	fluxDir: string;
	config: ReturnType<typeof loadConfig>;
	modelsConfig: any;
	sharedSkills: string[];
	pricing?: PricingTable;
}
function notify(ctx: any, text: string, level: "info" | "warning" | "error" = "info", maxLines = 1): void {
	const cleaned = cleanNotifyText(text, maxLines);
	if (ctx.hasUI) {
		// 统一走 info 级: pi 的 showStatus 在对话最底部渲染浅灰色小字（dim）,
		// 连续通知会原地更新不堆积; warning/error 级别用前缀区分（不用彩色大字）
		const prefixed = level === "error" ? `⚠ ${cleaned}` : level === "warning" ? `△ ${cleaned}` : cleaned;
		ctx.ui.notify(prefixed, "info");
	} else (level === "error" ? console.error : console.log)(cleaned);
}

/**
 * 任务生命周期结束通知: 与普通提示一致, 对话最底部浅灰色小字（单行摘要）。
 * print/无 UI 模式回退到 console。
 */
function taskNotify(ctx: any, text: string, level: "info" | "warning" | "error" = "info"): void {
	notify(ctx, text, level, 1);
}

/**
 * 解析任务信封的防御包装: 解析失败（畸形/恶意输入）降级为普通消息,
 * 不让 input/before_agent_start hook 抛错中断对话处理。
 */
function safeParseEnvelope(text: string): AgentFluxTaskEnvelope | null {
	try {
		return parseAgentFluxTaskEnvelope(text);
	} catch {
		return null;
	}
}

/**
 * TUI 通知文本清洗: pi 的 ctx.ui.notify 向聊天流末尾追加文本, 多行会折行堆积在输入区上方。
 * 事件通知默认单行 (maxLines=1), 查询类输出可显式放宽 (如 12 行) 并附折叠提示。
 */
function cleanNotifyText(text: string, maxLines: number): string {
	const lines = String(text ?? "").split("\n").map(line => line.length > 200 ? `${line.slice(0, 200)}…` : line);
	if (lines.length <= maxLines) return lines.join("\n");
	return [...lines.slice(0, maxLines), `…（共 ${lines.length} 行, 已折叠）`].join("\n");
}

/** DAG 执行结果一行摘要 (完整详情在 checkpoint/artifact 文件中)。 */
function dagResultSummary(r: DAGExecutionResult): string {
	const total = r.taskResults.size;
	return `DAG ${r.status}: ${r.completedNodes.length}/${total} nodes passed · wall ${(r.wallClockMs / 1000).toFixed(1)}s · $${r.totalCost.toFixed(4)} · run ${r.executionId}`;
}

function formatMessageGroups(groups: ReturnType<SharedBoard["listGroups"]>): string {
	if (groups.length === 0) return "No AgentFlux message groups.";
	return ["AgentFlux message groups:", ...groups.map(group =>
		`  ${group.id} · ${group.name} · ${group.type}\n    ${group.members.join(", ")}`,
	)].join("\n");
}

function formatInbox(messages: DeliveredMessageV2[]): string {
	if (messages.length === 0) return "Inbox is empty.";
	return ["AgentFlux inbox:", ...messages.map(({ envelope, delivery }) =>
		`  ${envelope.id} · ${envelope.priority} · ${delivery.status} · from ${envelope.from} · ${envelope.channel.type}:${envelope.channel.id}\n    ${envelope.content}`,
	)].join("\n");
}

function templateFromRole(runtime: RuntimeContext, roleName: string, name = roleName): AgentTemplate {
	const roles = loadAllRoles(runtime.cwd, runtime.modelsConfig);
	const role = roles.get(roleName);
	if (!role) {
		throw new Error(`Unknown Agent template: ${roleName}. Use a registered template id (${[...roles.keys()].join(", ") || "none available"}); role is not a free-form description.`);
	}
	return {
		name,
		role: roleName,
		description: role.description ?? roleName,
		model: role.model,
		provider: role.model ? runtime.modelsConfig.models?.[role.model]?.provider : undefined,
		tools: role.tools,
		skills: [...new Set([...runtime.sharedSkills, ...(role.skills ?? [])])],
		mcpServers: role.mcpServers,
		workspace: role.workspace,
		systemPrompt: role.systemPrompt ?? `You are the ${roleName} Agent.`,
		thinking: role.thinking,
		communication: role.communication,
	};
}

export default function agentFlux(pi: ExtensionAPI) {
	installSlashArgumentAutocompleteBridge();
	let runtime: RuntimeContext | null = null;
	let telemetry: TelemetryWriter | null = null;
	let sessionId = "main";
	let turnIndex = 0;
	let currentPlan: TaskExecutionPlan | null = null;
	let implicitPlan: TaskExecutionPlan | null = null;
	let implicitTask: { taskId: string; task: string } | null = null;
	let lastAgentRunFailed = false;
	type ExecutionOutcome = { action: "completed" | "failed" | "cancelled"; status: "success" | "failure" | "cancelled" | "timeout"; error?: string; costUsd?: number };
	let executionOutcome: ExecutionOutcome | null = null;
	let pendingTaskEnvelope: AgentFluxTaskEnvelope | null = null;
	const activeRuns = new Map<string, AbortController>();
	const persistentControllers = new Map<string, AbortController>();
	const workflowInvocations = new Set<string>();

	const operatingProtocol = [
		"AgentFlux operating protocol:",
		"- The user only needs to describe the desired outcome; never ask them to explain AgentFlux.",
		"- There are no work-style modes: execute in the main Agent or spawn subagents as the task demands; AgentFlux decides nothing for you.",
		"- Use flux_workflow (fixed DAG) or flux_issue (Issue/Claim collaboration) when the task is better served by that execution approach.",
		"- When the user asks to reuse, resume, or continue prior work, call flux_task with that matching action before doing the work; use list/inspect only when the user is asking about history.",
		"- When the user asks to change a saved Workflow definition, call flux_workflow with action=modify and its saved selector; do not use action=run and do not create DAG nodes that edit AgentFlux registry files.",
		"- Only one project-level execution may be active at a time: a Workflow run or a Community activity cannot overlap another. Internal session, task, run, and Agent identifiers are managed by AgentFlux; do not request or invent them.",
	].join("\n");

	function startPlan(plan: TaskExecutionPlan, writeCreated = true): TaskExecutionPlan {
		if (!telemetry || !runtime) return plan;
		registerTask(runtime.fluxDir, sessionId, plan, "running");
		const lineage = {
			executionId: plan.executionId,
			parentTaskId: plan.parentTaskId,
			parentExecutionId: plan.parentExecutionId,
			runId: plan.executionId,
		};
		if (writeCreated) telemetry.writeTaskExecution({ sessionId, taskId: plan.taskId, action: "created", selectedBy: plan.selectedBy, task: plan.task, operation: plan.operation, ...lineage });
		telemetry.writeTaskExecution({ sessionId, taskId: plan.taskId, action: "started", selectedBy: plan.selectedBy, task: plan.task, operation: plan.operation, ...lineage });
		return plan;
	}

	function finishCurrentPlan(outcome: ExecutionOutcome): void {
		if (!telemetry || !runtime) return;
		const plan = currentPlan ?? implicitPlan ?? (implicitTask
			? createTaskExecutionPlan({ task: implicitTask.task, taskId: implicitTask.taskId, selectedBy: "main_agent", budget: runtime.config.budget })
			: null);
		if (!plan) return;
		if (!currentPlan && !implicitPlan) startPlan(plan);
		telemetry.writeTaskExecution({
			sessionId,
			taskId: plan.taskId,
			action: outcome.action,
			selectedBy: plan.selectedBy,
			task: plan.task,
			operation: plan.operation,
			executionId: plan.executionId,
			parentTaskId: plan.parentTaskId,
			parentExecutionId: plan.parentExecutionId,
			runId: plan.executionId,
			costUsd: outcome.costUsd,
			outcome: { status: outcome.status, success: outcome.action === "completed", error: outcome.error },
		});
		const registryStatus: TaskStatus = outcome.action === "completed"
			? "completed"
			: outcome.action === "cancelled"
				? "cancelled"
				: outcome.status === "timeout"
					? "timed_out"
					: "failed";
		updateTaskStatus(runtime.fluxDir, plan.taskId, registryStatus, {
			executionId: plan.executionId,
			costUsd: outcome.costUsd,
			outcome: { status: outcome.status, error: outcome.error },
		});
		currentPlan = null;
		implicitPlan = null;
		implicitTask = null;
		executionOutcome = null;
		lastAgentRunFailed = false;
	}

	function ensureImplicitPlan(): TaskExecutionPlan | null {
		if (currentPlan) return currentPlan;
		if (implicitPlan) return implicitPlan;
		if (runtime && telemetry && implicitTask) {
			implicitPlan = startPlan(createTaskExecutionPlan({ task: implicitTask.task, taskId: implicitTask.taskId, selectedBy: "main_agent", budget: runtime.config.budget }));
		}
		return implicitPlan;
	}

	const persistentContext = (maxCostUsd = runtime?.config.budget.max_cost_per_task): PersistentAgentContext => {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		return { cwd: runtime.cwd, modelsConfig: runtime.modelsConfig, telemetry: telemetry ?? undefined, pricing: runtime.pricing, sessionId, taskId: ensureImplicitPlan()?.taskId, executionId: ensureImplicitPlan()?.executionId, sharedSkills: runtime.sharedSkills, prefixLayout: runtime.config.cache.prefix_layout === "static_first", timeoutMs: runtime.config.budget.max_wall_clock_seconds * 1000, maxCostUsd };
	};

	const tuiMenuData = (ctx: any): FluxTuiMenuData => {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		const persistent = listPersistentAgents(runtime.cwd);
		const persistentNames = new Set(persistent.map(agent => agent.name));
		const board = new SharedBoard(runtime.fluxDir);
		const shared = board.listAgents().filter(agent => agent.name !== "main" && !persistentNames.has(agent.name));
		const mainInbox = new MessageBus(runtime.fluxDir).peek("main");
		return {
			agents: [
				{ name: "main", kind: "main", role: "lead", status: currentPlan || implicitTask ? "running" : "idle", model: ctx.model?.id, provider: ctx.model?.provider, sessionId, callCount: turnIndex, totalCostUsd: 0, capabilityGeneration: 1, lastTask: currentPlan?.task ?? implicitTask?.task, communication: "current_chat" },
				...persistent.map(agent => ({ ...agent, kind: "subagent" as const, communication: agent.status === "archived" || agent.status === "running" ? "none" as const : "persistent_session" as const })),
				...shared.map(agent => ({ name: agent.name, kind: "subagent" as const, role: agent.role, status: agent.status, model: agent.model, provider: agent.provider, sessionId: agent.sessionFile, callCount: 1, totalCostUsd: 0, capabilityGeneration: 1, lastTask: agent.currentTask, communication: ["idle", "running", "blocked"].includes(agent.status) ? "message" as const : "none" as const })),
			],
			roles: [...loadAllRoles(runtime.cwd, runtime.modelsConfig).keys()].sort(),
			issues: listIssues(runtime.cwd).map(issue => ({ id: issue.id, title: issue.title, status: issue.status, claims: issue.claims.map(claim => ({ id: claim.id, agent: claim.agent, scope: claim.scope, status: claim.status })) })),
			forkPoints: getForkCandidates(ctx, 5),
			activeTaskIds: [...activeRuns.keys()],
			tasks: listTasks(runtime.fluxDir, sessionId).slice(0, 10),
			workflows: listWorkflowDefinitions(runtime.fluxDir).map(definition => ({
				id: definition.id,
				name: definition.name,
				version: definition.version,
				description: definition.description,
				nodeCount: definition.dag.nodes.length,
			})),
			groups: board.listGroups(),
			mainInbox: mainInbox.map(({ envelope, delivery }) => ({
				id: envelope.id,
				from: envelope.from,
				channel: `${envelope.channel.type}:${envelope.channel.id}`,
				content: envelope.content,
				priority: envelope.priority,
				status: delivery.status,
			})),
		};
	};

	async function runEphemeral(role: string, name: string, task: string, signal?: AbortSignal, lockFiles?: string[], taskId?: string): Promise<AgentRunResult> {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		const template = templateFromRole(runtime, role, name);
		const runId = `subagent-${randomUUID()}`;
		const record = createEphemeralRecord({ name, role, sessionId, taskId, runId, currentTask: task.slice(0, 200), model: template.model, telemetry: telemetry ?? undefined });
		startEphemeralRecord(record, { sessionId, taskId, runId, currentTask: task, model: template.model, telemetry: telemetry ?? undefined });
		const result = await runAgent({ cwd: runtime.cwd, agent: template, task, sessionId, telemetry: telemetry ?? undefined, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, persistent: false, timeoutMs: runtime.config.budget.max_wall_clock_seconds * 1000, maxRetries: 1, maxCostUsd: runtime.config.budget.max_cost_per_task, signal, lockFiles, taskId, executionId: ensureImplicitPlan()?.executionId, runId });
		finishEphemeralRecord(record, result.exitCode, result.usage.cost, telemetry ?? undefined, sessionId, taskId, runId);
		return result;
	}

	async function runWorkflow(
		plan: TaskExecutionPlan,
		signal?: AbortSignal,
		request: { action?: "run" | "reuse" | "modify"; selector?: string; name?: string } = {},
	): Promise<DAGExecutionResult> {
		if (!runtime || !telemetry) throw new Error("AgentFlux is not initialized");
		const resumeExecutionId = plan.operation === "resume"
			? plan.parentExecutionId ?? plan.parentTaskId
			: undefined;
		const runsDir = join(runtime.fluxDir, "runtime", "runs");
		const resumeDagPath = resumeExecutionId && existsSync(runsDir)
			? resolvePathInsideExistingRoot(runsDir, resumeExecutionId, "dag.json")
			: undefined;
		if (resumeDagPath && existsSync(resumeDagPath)) {
			const dag = JSON.parse(readFileSync(resumeDagPath, "utf-8")) as TaskDAG;
			const source = plan.parentTaskId ? getTask(runtime.fluxDir, plan.parentTaskId) : undefined;
			if (source?.resource?.type === "workflow") updateTaskMetadata(runtime.fluxDir, plan.taskId, { resource: source.resource });
			mkdirSync(runsDir, { recursive: true });
			const runDir = resolvePathInsideExistingRoot(runsDir, plan.executionId);
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "dag.json"), JSON.stringify(dag, null, 2));
			return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, maxWallClockMs: plan.budget.maxWallClockMs, maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: 3, executionId: plan.executionId, taskId: plan.taskId, resumeFromExecutionId: resumeExecutionId, qualityGate: runtime.config.quality_gate ? { model: runtime.config.quality_gate.model, timeoutMs: runtime.config.quality_gate.timeout_ms } : undefined });
		}
		if (plan.operation === "resume") throw new Error(`Workflow checkpoint is unavailable for ${plan.parentTaskId ?? "the selected task"}`);
		let action = request.action ?? "run";
		let selector = request.selector;
		if (action === "run" && plan.operation === "reuse" && plan.parentTaskId) {
			const source = getTask(runtime.fluxDir, plan.parentTaskId);
			if (source?.resource?.type === "workflow") {
				action = "reuse";
				selector = source.resource.version
					? `${source.resource.id}@${source.resource.version}`
					: source.resource.id;
			}
		}
		if (action === "reuse") {
			if (!selector) throw new Error("Workflow reuse requires a saved Workflow selector");
			const definition = getWorkflowDefinition(runtime.fluxDir, selector);
			if (!definition) throw new Error(`Workflow not found: ${selector}`);
			if (plan.operation === "new") {
				plan.operation = "reuse";
				plan.parentTaskId = definition.sourceTaskId;
				registerTask(runtime.fluxDir, sessionId, plan, "running");
			}
			const dag = structuredClone(definition.dag);
			delete dag.planningCostUsd;
			mkdirSync(runsDir, { recursive: true });
			const runDir = resolvePathInsideExistingRoot(runsDir, plan.taskId);
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "dag.json"), JSON.stringify(dag, null, 2));
			updateTaskMetadata(runtime.fluxDir, plan.taskId, { resource: { type: "workflow", id: definition.id, version: definition.version } });
			return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, maxWallClockMs: plan.budget.maxWallClockMs, maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: 3, executionId: plan.executionId, taskId: plan.taskId, qualityGate: runtime.config.quality_gate ? { model: runtime.config.quality_gate.model, timeoutMs: runtime.config.quality_gate.timeout_ms } : undefined });
		}
		const previous = action === "modify"
			? getWorkflowDefinition(runtime.fluxDir, selector ?? "")
			: undefined;
		if (action === "modify" && !previous) throw new Error(`Workflow not found: ${selector ?? ""}`);
		if (previous && plan.operation === "new") {
			plan.operation = "continue";
			plan.parentTaskId = previous.sourceTaskId;
			registerTask(runtime.fluxDir, sessionId, plan, "running");
		}
		const planner = resolveDAGRoleModel(runtime.cwd, runtime.modelsConfig, "planner");
		const startedAt = Date.now();
		const plannerAgentId = `agent-${plan.taskId}-planner`;
		telemetry.writeAgentLifecycle({ sessionId, taskId: plan.taskId, agentId: plannerAgentId, agent: "dag-planner", kind: "subagent", origin: "fresh", status: "running", action: "started", role: "planner", currentTask: `Plan Workflow: ${plan.task}`.slice(0, 200), model: planner.model });
		let dag;
		try {
			const planningTask = previous
				? [
					"Produce the replacement executable DAG for this saved Workflow.",
					"The DAG nodes must perform the user's intended work. They must not edit the Workflow registry, modify .agentflux, invoke AgentFlux control tools, or describe the act of revising a Workflow.",
					"Apply the requested structural change to the current DAG, preserving unaffected business steps and dependencies.",
					"",
					`Requested change:\n${plan.task}`,
					"",
					`Current executable DAG:\n${JSON.stringify(previous.dag, null, 2)}`,
				].join("\n")
				: plan.task;
			dag = await generateTaskDAG(planningTask, { cwd: runtime.cwd, model: planner.model, provider: planner.provider, thinking: planner.thinking, models: runtime.modelsConfig.models, pricing: runtime.pricing, telemetry, sessionId, prefixLayout: runtime.config.cache.prefix_layout === "static_first", signal, maxCostUsd: plan.budget.maxCostUsd, timeoutMs: plan.budget.maxWallClockMs, taskId: plan.taskId, executionId: plan.executionId });
			mkdirSync(runsDir, { recursive: true });
			const runDir = resolvePathInsideExistingRoot(runsDir, plan.taskId);
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "dag.json"), JSON.stringify(dag, null, 2));
			const defaultName = plan.task.slice(0, 64);
			const name = request.name?.trim() || (listWorkflowDefinitions(runtime.fluxDir).some(item => item.name === defaultName)
				? `${defaultName} · ${plan.taskId.slice(-8)}`
				: defaultName);
			const definition = previous
				? reviseWorkflowDefinition(runtime.fluxDir, previous.id, { dag, sourceTaskId: plan.taskId, name: request.name })
				: createWorkflowDefinition(runtime.fluxDir, { name, dag, sourceTaskId: plan.taskId });
			updateTaskMetadata(runtime.fluxDir, plan.taskId, { resource: { type: "workflow", id: definition.id, version: definition.version } });
			telemetry.writeAgentLifecycle({ sessionId, taskId: plan.taskId, agentId: plannerAgentId, agent: "dag-planner", kind: "subagent", origin: "fresh", status: "done", action: "completed", role: "planner", currentTask: `Plan Workflow: ${plan.task}`.slice(0, 200), model: planner.model });
		} catch (error) {
			telemetry.writeAgentLifecycle({ sessionId, taskId: plan.taskId, agentId: plannerAgentId, agent: "dag-planner", kind: "subagent", origin: "fresh", status: signal?.aborted ? "cancelled" : "failed", action: signal?.aborted ? "cancelled" : "failed", role: "planner", currentTask: `Plan Workflow: ${plan.task}`.slice(0, 200), model: planner.model });
			throw error;
		}
		return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, maxWallClockMs: Math.max(1, plan.budget.maxWallClockMs - (Date.now() - startedAt)), maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: 3, executionId: plan.executionId, taskId: plan.taskId, qualityGate: runtime.config.quality_gate ? { model: runtime.config.quality_gate.model, timeoutMs: runtime.config.quality_gate.timeout_ms } : undefined });
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		const config = loadConfig(ctx.cwd);
		const warnings = validateConfig(config);
		const modelsConfig = loadModelsConfig(ctx.cwd);
		const fluxDir = join(ctx.cwd, ".agentflux");
		telemetry = new TelemetryWriter(fluxDir);
		sessionId = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.() ?? `main-${randomUUID()}`;
		runtime = { cwd: ctx.cwd, fluxDir, config, modelsConfig, sharedSkills: resolveSharedSkills(config, modelsConfig) };
		setDagLogSink(ctx.hasUI ? null : console.error);
		try { runtime.pricing = await loadPricing(fluxDir, config.pricing, ctx.hasUI ? undefined : ctx.model?.id); } catch {}
		for (const warning of warnings) notify(ctx, warning, "warning");
		notify(ctx, "AgentFlux ready · main + subagents · workflow · community", "info");
	});

	pi.on("before_provider_request", async (event: any) => runtime ? applyPrefixLayout(event.payload, runtime.config.cache).payload : undefined);
	pi.on("input", async (event: any) => {
		const envelope = safeParseEnvelope(event.text);
		if (!envelope) return undefined;
		pendingTaskEnvelope = envelope;
		return { action: "transform", text: envelope.task, images: event.images };
	});
	pi.on("before_agent_start", async (event: any) => {
		if (!currentPlan) {
			if (!runtime) return undefined;
			const envelope = pendingTaskEnvelope ?? safeParseEnvelope(event.prompt);
			pendingTaskEnvelope = null;
			const task = envelope?.task ?? event.prompt;
			if (envelope) {
				executionOutcome = null;
				lastAgentRunFailed = false;
				currentPlan = startPlan(createTaskExecutionPlan({ task, taskId: envelope.taskId, selectedBy: "user", budget: runtime.config.budget }));
			} else {
				implicitTask = { taskId: `task-${randomUUID()}`, task };
				implicitPlan = null;
			}
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${operatingProtocol}` };
	});
	pi.on("turn_end", async () => { turnIndex += 1; });
	pi.on("agent_end", async (event: any) => {
		const lastAssistant = [...(event?.messages ?? [])].reverse().find((message: any) => message?.role === "assistant");
		lastAgentRunFailed = lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted";
	});
	pi.on("agent_settled", async () => {
		const terminal = executionOutcome ?? (lastAgentRunFailed
			? { action: "failed" as const, status: "failure" as const }
			: { action: "completed" as const, status: "success" as const });
		finishCurrentPlan(terminal);
	});
	pi.on("session_shutdown", async () => {
		for (const controller of activeRuns.values()) controller.abort();
		activeRuns.clear();
		if (currentPlan || implicitPlan || implicitTask) {
			finishCurrentPlan(executionOutcome ?? {
				action: "cancelled",
				status: "cancelled",
				error: "Session closed before task settled",
			});
		}
	});

	registerSessionFork(pi, () => ({ sessionId, telemetry }));
	registerCompactionAdvisor(pi, () => ({ sessionId, telemetry }));

	pi.registerTool({
		name: "flux_task",
		label: "Task History",
		description: "List or inspect prior AgentFlux tasks, or prepare a new, reused, resumed, continued, or retried task without exposing runtime identifiers in the prompt.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("inspect"), Type.Literal("new"), Type.Literal("reuse"), Type.Literal("resume"), Type.Literal("continue"), Type.Literal("retry")]),
			selector: Type.Optional(Type.String()),
			task: Type.Optional(Type.String()),
			}),
		async execute(_id, params) {
			if (!runtime || !telemetry) throw new Error("AgentFlux is not initialized");
			if (params.action === "list") {
				const tasks = listTasks(runtime.fluxDir, sessionId).slice(0, 10);
				return { content: [{ type: "text", text: formatTasks(tasks) }], details: { ok: true } };
			}
			const source = params.action === "new" ? undefined : resolveTask(runtime.fluxDir, params.selector, sessionId);
			if (params.action === "inspect") {
				if (!source) throw new Error("No matching AgentFlux task in the current session");
				return { content: [{ type: "text", text: formatTasks([source]) }], details: { ok: true } };
			}
			if (params.action !== "new" && !source) throw new Error("No matching AgentFlux task in the current session");
			if (params.action === "resume" && source && !["failed", "cancelled", "timed_out", "running"].includes(source.status)) {
				throw new Error(`Cannot resume a ${source.status} task; use continue or reuse`);
			}
			const activePlan = currentPlan ?? implicitPlan;
			if (source && activePlan?.taskId === source.id) {
				throw new Error("Cannot reuse, resume, continue or retry the currently active task");
			}
			const preparedTaskId = activePlan?.taskId;
			const task = params.task?.trim() || implicitTask?.task || source?.task;
			if (!task) throw new Error("new requires task");
			currentPlan = startPlan(createTaskExecutionPlan({
				task,
				taskId: preparedTaskId,
				selectedBy: "main_agent",
				budget: runtime.config.budget,
				operation: params.action,
				parentTaskId: source?.id,
				parentExecutionId: source?.executionId,
			}), !preparedTaskId);
			implicitPlan = null;
			const next = `${source?.resource?.type === "workflow" ? "Call flux_workflow; resume uses the saved checkpoint when available." : source?.resource?.type === "issue" ? `Use flux_issue to continue the existing Issue: ${source.resource.id}.` : "Continue in the main Agent."}`;
			return { content: [{ type: "text", text: `${params.action} prepared. ${next}` }], details: { ok: true } };
		},
	});

	pi.registerTool({
		name: "flux_agent",
		label: "Agent",
		description: "Create, run, stop, retry, list or archive an Agent. Ephemeral Agents terminate after one task; persistent Agents keep a stable identity and session.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("run_ephemeral"), Type.Literal("create_persistent"), Type.Literal("run_persistent"), Type.Literal("retry"), Type.Literal("stop"), Type.Literal("list"), Type.Literal("archive")]), name: Type.Optional(Type.String()), role: Type.Optional(Type.String()), task: Type.Optional(Type.String()), lockFiles: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params, signal) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			if (params.action === "list") return { content: [{ type: "text", text: formatPersistentAgents(listPersistentAgents(runtime.cwd)) }], details: { ok: true } };
			if (!params.name) throw new Error(`${params.action} requires name`);
			if (params.action === "create_persistent") { if (!params.role) throw new Error("create_persistent requires role"); const agent = registerPersistentAgent(runtime.cwd, params.name, params.role, runtime.modelsConfig); telemetry?.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "subagent", origin: "template", status: "idle", action: "created" }); return { content: [{ type: "text", text: `Created persistent Agent ${agent.name} (${agent.role})` }], details: { ok: true } }; }
			if (params.action === "archive") { const agent = archivePersistentAgent(runtime.cwd, params.name); telemetry?.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "subagent", origin: agent.lineage.origin, status: "archived", action: "archived" }); return { content: [{ type: "text", text: `Archived ${agent.name}` }], details: { ok: true } }; }
			if (params.action === "stop") {
				const record = listPersistentAgents(runtime.cwd).find(agent => agent.name === params.name);
				if (!record || record.status === "archived") throw new Error(`Persistent Agent not found: ${params.name}`);
				const controller = persistentControllers.get(params.name);
				if (controller) {
					controller.abort();
					return { content: [{ type: "text", text: `Stop requested for ${params.name}` }], details: { ok: true } };
				}
				if (record.status === "running") {
					resetPersistentAgentStatus(runtime.cwd, params.name, "idle");
					return { content: [{ type: "text", text: `${params.name} was marked running without a live run; status reset to idle.` }], details: { ok: true } };
				}
				throw new Error(`Persistent Agent is not running: ${params.name}`);
			}
			const isPersistentRun = params.action === "run_persistent" || params.action === "retry";
			const record = isPersistentRun ? listPersistentAgents(runtime.cwd).find(agent => agent.name === params.name && agent.status !== "archived") : undefined;
			if (isPersistentRun && !record) throw new Error(`Persistent Agent not found: ${params.name}`);
			let task = params.task;
			if (params.action === "retry") {
				task = task ?? record?.lastTask ?? "";
				if (!task) throw new Error(`retry requires a previous task (lastTask is empty for ${params.name})`);
			}
			if (!task) throw new Error(`${params.action} requires task`);
			let result: AgentRunResult;
			const controller = new AbortController();
			const forwardAbort = () => controller.abort();
			if (isPersistentRun) persistentControllers.set(params.name, controller);
			signal?.addEventListener("abort", forwardAbort, { once: true });
			try {
				result = params.action === "run_ephemeral"
					? await runEphemeral(params.role ?? params.name, params.name, task, controller.signal, params.lockFiles, ensureImplicitPlan()?.taskId)
					: await runPersistentAgent(params.name, task, persistentContext(), controller.signal);
			} catch (error: any) {
				executionOutcome = controller.signal.aborted
					? { action: "cancelled", status: "cancelled", error: "Agent cancelled" }
					: { action: "failed", status: "failure", error: String(error?.message ?? error).slice(0, 500) };
				throw error;
			} finally {
				signal?.removeEventListener("abort", forwardAbort);
				if (isPersistentRun) persistentControllers.delete(params.name);
			}
			if (result.exitCode !== 0 || result.errorMessage) {
				executionOutcome = result.exitCode === 130 || controller.signal.aborted
					? { action: "cancelled", status: "cancelled", error: result.errorMessage ?? "Agent cancelled", costUsd: result.usage.cost }
					: result.exitCode === 124
						? { action: "failed", status: "timeout", error: result.errorMessage ?? "Agent timed out", costUsd: result.usage.cost }
						: { action: "failed", status: "failure", error: result.errorMessage ?? `Agent exited ${result.exitCode}`, costUsd: result.usage.cost };
			} else {
				executionOutcome = { action: "completed", status: "success", costUsd: result.usage.cost };
			}
			return { content: [{ type: "text", text: formatAgentRunResult(result) }], details: { ok: result.exitCode === 0 && !result.errorMessage } };
		},
	});

	pi.registerTool({
		name: "flux_workflow",
		label: "Workflow",
		description: "List, inspect, create, reuse or revise saved fixed-DAG Workflows. For action=run, pass only natural-language task requirements and optional name; AgentFlux plans the DAG. workflow is a saved selector string only for show/reuse/modify, never a DAG or object.",
		parameters: Type.Object({
			action: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("list"), Type.Literal("show"), Type.Literal("reuse"), Type.Literal("modify")])),
			task: Type.Optional(Type.String({ description: "Natural-language work requirements. Required for a new action=run Workflow." })),
			workflow: Type.Optional(Type.String({ description: "Saved Workflow selector such as id, name, or id@version. Only for show/reuse/modify; never pass a DAG/object." })),
			name: Type.Optional(Type.String({ description: "Optional stable name for a newly created Workflow." })),
		}),
		async execute(_id, params, signal): Promise<any> {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			const action = params.action ?? "run";
			if (action === "list") {
				const definitions = listWorkflowDefinitions(runtime.fluxDir);
				return { content: [{ type: "text", text: formatWorkflowDefinitions(definitions) }], details: { definitions } };
			}
			if (action === "show") {
				if (!params.workflow) throw new Error("Workflow show requires workflow");
				const definition = getWorkflowDefinition(runtime.fluxDir, params.workflow);
				if (!definition) throw new Error(`Workflow not found: ${params.workflow}`);
				return { content: [{ type: "text", text: formatWorkflowDefinitions([definition], true) }], details: { definition } };
			}
			const plan = ensureImplicitPlan()
				?? createTaskExecutionPlan({ task: params.task ?? "", selectedBy: "main_agent", budget: runtime.config.budget });
			if ((action === "reuse" || action === "modify") && !params.workflow && plan.operation !== "reuse") {
				throw new Error(`Workflow ${action} requires workflow`);
			}
			if (workflowInvocations.has(plan.taskId)) {
				throw new Error(`Workflow execution already started for task ${plan.taskId}`);
			}
			workflowInvocations.add(plan.taskId);
			try {
				const result = await runWorkflow(plan, signal, { action, selector: params.workflow, name: params.name });
				executionOutcome = result.status === "passed"
					? { action: "completed", status: "success", costUsd: result.totalCost }
					: result.status === "cancelled"
						? { action: "cancelled", status: "cancelled", error: "Workflow cancelled", costUsd: result.totalCost }
						: { action: "failed", status: result.status === "timed_out" ? "timeout" : "failure", error: `Workflow ${result.status}`, costUsd: result.totalCost };
				const resource = getTask(runtime.fluxDir, plan.taskId)?.resource;
				return { content: [{ type: "text", text: `${formatTaskExecutionPlan(plan)}${resource ? `\n  saved ${resource.type} ${resource.id}` : ""}\n\n${formatDAGResult(result)}` }], details: { ...result, resource } };
			} catch (error: any) {
				executionOutcome = signal?.aborted
					? { action: "cancelled", status: "cancelled", error: "Workflow cancelled" }
					: { action: "failed", status: "failure", error: String(error?.message ?? error).slice(0, 500) };
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "flux_issue", label: "Community Issue", description: "Create, discuss, claim, submit, review and resolve Community work.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("show"), Type.Literal("comment"), Type.Literal("claim"), Type.Literal("submit"), Type.Literal("review"), Type.Literal("resolve")]), issueId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), body: Type.Optional(Type.String()), agent: Type.Optional(Type.String()), scope: Type.Optional(Type.String()), claimId: Type.Optional(Type.String()), verdict: Type.Optional(Type.String()), acceptanceCriteria: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			if (params.action === "list") { const issues = listIssues(runtime.cwd); return { content: [{ type: "text", text: issues.length ? issues.map(formatIssue).join("\n\n") : "No Community issues." }], details: { ok: true } }; }
			if (params.action === "create") { const issue = createIssue(runtime.cwd, { title: params.title ?? "", description: params.body ?? "", acceptanceCriteria: params.acceptanceCriteria }); const taskId = ensureImplicitPlan()?.taskId; if (taskId) updateTaskMetadata(runtime.fluxDir, taskId, { resource: { type: "issue", id: issue.id } }); return { content: [{ type: "text", text: formatIssue(issue) }], details: { ok: true } }; }
			if (!params.issueId) throw new Error(`${params.action} requires issueId`);
			const issue = params.action === "show" ? getIssue(runtime.cwd, params.issueId)
				: params.action === "comment" ? commentOnIssue(runtime.cwd, params.issueId, params.agent ?? "main", params.body ?? "")
					: params.action === "claim" ? claimIssue(runtime.cwd, params.issueId, params.agent ?? "main", params.scope ?? "")
						: params.action === "submit" ? submitClaim(runtime.cwd, params.issueId, params.claimId ?? "")
							: params.action === "review" ? reviewClaim(runtime.cwd, params.issueId, params.claimId ?? "", params.verdict === "rework" ? "rework" : "pass", params.agent ?? "main", params.body ?? "")
								: resolveIssue(runtime.cwd, params.issueId);
			if (!issue) throw new Error(`Issue not found: ${params.issueId}`);
			const taskId = ensureImplicitPlan()?.taskId;
			if (taskId) updateTaskMetadata(runtime.fluxDir, taskId, { resource: { type: "issue", id: issue.id } });
			const timeline = params.action === "show" ? `\n\n${formatIssueTimeline(issue)}` : "";
			return { content: [{ type: "text", text: formatIssue(issue) + timeline }], details: { ok: true } };
		},
	});

	pi.registerTool({
		name: "flux_message",
		label: "Agent Message",
		description: "Create/list Agent groups, send direct or group Message V2, inspect inboxes and acknowledge delivery.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("send"), Type.Literal("poll"), Type.Literal("ack"),
				Type.Literal("group_create"), Type.Literal("group_list"), Type.Literal("group_send"),
			]),
			sender: Type.Optional(Type.String()),
			target: Type.Optional(Type.String()),
			content: Type.Optional(Type.String()),
			messageId: Type.Optional(Type.String()),
			group: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			members: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 100 })),
			priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("critical")])),
		}),
		async execute(_id, params) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			const board = new SharedBoard(runtime.fluxDir);
			if (params.action === "group_list") {
				const groups = board.listGroups();
				return { content: [{ type: "text", text: formatMessageGroups(groups) }], details: { groups } };
			}
			const bus = new MessageBus(runtime.fluxDir);
			const sender = params.sender ?? "main";
			const taskId = ensureImplicitPlan()?.taskId;
			let result: unknown;
			if (params.action === "group_create") {
				if (!params.name || !params.members?.length) throw new Error("group_create requires name and members");
				result = board.createGroup(params.name, [...new Set([sender, ...params.members])], "team", sender);
			} else if (params.action === "group_send") {
				if (!params.group || !params.content) throw new Error("group_send requires group and content");
				result = bus.sendGroup(sender, params.group, "message", params.content, { taskId, priority: params.priority });
			} else if (params.action === "send") {
				if (!params.target || !params.content) throw new Error("send requires target and content");
				result = bus.sendDirect(sender, params.target, "message", params.content, { taskId, priority: params.priority });
			} else if (params.action === "poll") {
				result = bus.poll(params.target ?? sender);
			} else {
				if (!params.target || !params.messageId) throw new Error("ack requires target and messageId");
				result = bus.acknowledge(params.target, params.messageId);
			}
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});

	async function dispatchTuiWorkflow(
		plan: TaskExecutionPlan,
		ctx: any,
		request: { action?: "run" | "reuse" | "modify"; selector?: string } = {},
	): Promise<void> {
		if (!runtime || !telemetry) throw new Error("AgentFlux is not initialized");
		const controller = new AbortController();
		activeRuns.set(plan.taskId, controller);
		const finish = (result: DAGExecutionResult) => {
			const action = result.status === "passed" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed";
			const status = result.status === "passed" ? "success" : result.status === "timed_out" ? "timeout" : result.status === "cancelled" ? "cancelled" : "failure";
			telemetry!.writeTaskExecution({ sessionId, taskId: plan.taskId, executionId: plan.executionId, runId: plan.executionId, action, selectedBy: plan.selectedBy, task: plan.task, operation: plan.operation, parentTaskId: plan.parentTaskId, parentExecutionId: plan.parentExecutionId, outcome: { status, success: action === "completed" } });
			updateTaskStatus(runtime!.fluxDir, plan.taskId, action === "completed" ? "completed" : action === "cancelled" ? "cancelled" : status === "timeout" ? "timed_out" : "failed", { executionId: plan.executionId, costUsd: result.totalCost, outcome: { status } });
		};
		if (ctx.mode === "print") {
			try {
				const result = await runWorkflow(plan, controller.signal, request);
				finish(result);
				taskNotify(ctx, dagResultSummary(result));
			} finally {
				activeRuns.delete(plan.taskId);
			}
			return;
		}
		taskNotify(ctx, `Workflow dispatched: ${plan.task.slice(0, 80)}`);
		void runWorkflow(plan, controller.signal, request)
			.then(result => { finish(result); taskNotify(ctx, dagResultSummary(result)); })
				.catch(error => { updateTaskStatus(runtime!.fluxDir, plan.taskId, "failed", { executionId: plan.executionId, outcome: { status: "failure", error: String(error?.message ?? error) } }); taskNotify(ctx, `Workflow failed: ${error?.message ?? error}`, "error"); })
			.finally(() => activeRuns.delete(plan.taskId));
	}

	pi.registerCommand("flux", { description: "Open AgentFlux Workbench or run a command", getArgumentCompletions: getFluxArgumentCompletions, handler: async (input: string, ctx: any) => {
		try {
			if (!runtime || !telemetry) throw new Error("AgentFlux is not initialized");
			if (!input.trim()) {
				const menuCommand = await showFluxTuiMenu(ctx, tuiMenuData(ctx));
				if (menuCommand === undefined) return notify(ctx, FLUX_HELP);
				if (menuCommand === null) return;
				input = menuCommand;
			}
			if (input.trim() === "agent") {
				const menuCommand = await showAgentTuiMenu(ctx, tuiMenuData(ctx));
				if (menuCommand === null) return;
				input = menuCommand ?? "agent list";
			}
			if (input.trim() === "task") {
				const menuCommand = await showTaskTuiMenu(ctx, tuiMenuData(ctx));
				if (menuCommand === null) return;
				input = menuCommand ?? "task list";
			}
			if (input.trim() === "workflow") {
				const menuCommand = await showWorkflowTuiMenu(ctx, tuiMenuData(ctx));
				if (menuCommand === null) return;
				input = menuCommand ?? "workflow list";
			}
			if (input.trim() === "issue") {
				const menuCommand = await showIssueTuiMenu(ctx, tuiMenuData(ctx));
				if (menuCommand === null) return;
				input = menuCommand ?? "issue list";
			}
			if (input.trim() === "message") {
				const menuCommand = await showMessageTuiMenu(ctx, tuiMenuData(ctx));
				if (menuCommand === null) return;
				input = menuCommand ?? "message group list";
			}
			if (input.trim() === "fork") {
				const menuCommand = await showForkTuiMenu(ctx, tuiMenuData(ctx));
				if (menuCommand === null) return;
				if (menuCommand) input = menuCommand;
			}
			const command = parseFluxCommand(input);
			if (command.kind === "help") return notify(ctx, FLUX_HELP);
			if (command.kind === "compact") return notify(ctx, formatCompactionAdvice(analyzeCompaction(ctx)));
			if (command.kind === "status") return notify(ctx, [`task ${currentPlan?.taskId ?? "idle"}`, `active runs ${activeRuns.size}`, formatPersistentAgents(listPersistentAgents(runtime.cwd)), `issues ${listIssues(runtime.cwd).length}`].join("\n"), "info", 12);
			if (command.kind === "task") {
				const [action = "list", selector, ...taskParts] = command.args;
				if (action === "list") return notify(ctx, formatTasks(listTasks(runtime.fluxDir, sessionId).slice(0, 10)), "info", 12);
				if (action === "new") {
					const task = [...(selector ? [selector] : []), ...taskParts].join(" ").trim();
					if (!task) throw new Error("Usage: /flux task new <task>");
					const plan = startPlan(createTaskExecutionPlan({ task, selectedBy: "user", budget: runtime.config.budget }));
					currentPlan = plan;
					const previousTurn = turnIndex;
					pi.sendUserMessage(task);
					if (ctx.mode === "print") {
						const deadline = Date.now() + 5_000;
						while (ctx.isIdle?.() && turnIndex === previousTurn && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
						if (!ctx.isIdle?.()) await ctx.waitForIdle?.();
						else if (turnIndex === previousTurn) throw new Error("AgentFlux could not start the delegated main turn");
					}
					return;
				}
				const source = resolveTask(runtime.fluxDir, selector, sessionId);
				if (action === "show") {
					if (!source) throw new Error("No matching AgentFlux task in the current session");
					return notify(ctx, formatTasks([source]), "info", 12);
				}
				if (!["reuse", "resume", "continue", "retry"].includes(action) || !source) throw new Error("Usage: /flux task list|show [selector]|reuse|resume|continue|retry [selector] [task]");
				if (action === "retry" && !["failed", "cancelled", "timed_out"].includes(source.status)) throw new Error(`Cannot retry a ${source.status} task`);
				if (action === "resume" && !["failed", "cancelled", "timed_out", "running"].includes(source.status)) throw new Error(`Cannot resume a ${source.status} task; use continue or reuse`);
				const task = taskParts.join(" ").trim() || source.task;
				const plan = startPlan(createTaskExecutionPlan({ task, selectedBy: "user", budget: runtime.config.budget, operation: action as "reuse" | "resume" | "continue" | "retry", parentTaskId: source.id, parentExecutionId: source.executionId }));
				currentPlan = plan;
				notify(ctx, `${action} prepared.`);
				const previousTurn = turnIndex;
				pi.sendUserMessage(task);
				if (ctx.mode === "print") {
					const deadline = Date.now() + 5_000;
					while (ctx.isIdle?.() && turnIndex === previousTurn && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
					if (!ctx.isIdle?.()) await ctx.waitForIdle?.();
				}
				return;
			}
			if (command.kind === "workflow") {
				const [action = "list", selector, ...taskParts] = command.args;
				if (action === "list") return notify(ctx, formatWorkflowDefinitions(listWorkflowDefinitions(runtime.fluxDir)), "info", 12);
				if (!selector) throw new Error("Usage: /flux workflow list|show <selector>|reuse <selector> <task>|modify <selector> <change>");
				const definition = getWorkflowDefinition(runtime.fluxDir, selector);
				if (!definition) throw new Error(`Workflow not found: ${selector}`);
				if (action === "show") return notify(ctx, formatWorkflowDefinitions([definition], true), "info", 12);
				if (!["reuse", "modify"].includes(action)) throw new Error("Invalid /flux workflow command");
				const task = taskParts.join(" ").trim();
				if (!task) throw new Error(`Workflow ${action} requires a task`);
				const plan = startPlan(createTaskExecutionPlan({
					task,
					selectedBy: "user",
					budget: runtime.config.budget,
					operation: action === "reuse" ? "reuse" : "continue",
					parentTaskId: definition.sourceTaskId,
					parentExecutionId: definition.sourceTaskId
						? getTask(runtime.fluxDir, definition.sourceTaskId)?.executionId
						: undefined,
				}));
				await dispatchTuiWorkflow(plan, ctx, { action: action as "reuse" | "modify", selector: definition.id });
				return;
			}
			if (command.kind === "fork") return notify(ctx, await handleForkCommand(command.args, ctx));
			if (command.kind === "message") {
				const [action, subject, ...rest] = command.args;
				const bus = new MessageBus(runtime.fluxDir);
				const board = new SharedBoard(runtime.fluxDir);
				if (!action) {
					const menuCommand = await showMessageTuiMenu(ctx, tuiMenuData(ctx));
					if (!menuCommand) return;
					return pi.sendUserMessage(`/flux ${menuCommand}`);
				}
				if (action === "send") {
					const content = rest.join(" ").trim();
					if (!subject || !content) throw new Error("Usage: /flux message send <agent> <text>");
					const result = bus.sendDirect("main", subject, "message", content, { taskId: ensureImplicitPlan()?.taskId });
					return notify(ctx, `Message sent to ${subject}: ${result.envelope.id}`);
				}
				if (action === "inbox") {
					const recipient = subject ?? "main";
					return notify(ctx, formatInbox(bus.poll(recipient)), "info", 12);
				}
				if (action === "ack") {
					const messageId = rest[0];
					if (!subject || !messageId) throw new Error("Usage: /flux message ack <agent> <messageId>");
					const delivery = bus.acknowledge(subject, messageId);
					return notify(ctx, `Acknowledged ${delivery.messageId} for ${delivery.recipient}.`);
				}
				if (action === "group") {
					const [groupAction, groupSubject, ...groupRest] = [subject, ...rest];
					if (groupAction === "list") return notify(ctx, formatMessageGroups(board.listGroups()), "info", 12);
					if (groupAction === "create") {
						const members = groupRest.join("").split(",").map(item => item.trim()).filter(Boolean);
						if (!groupSubject || members.length === 0) throw new Error("Usage: /flux message group create <name> <member,...>");
						const group = board.createGroup(groupSubject, [...new Set(["main", ...members])], "team", "main");
						return notify(ctx, `Created group ${group.name}: ${group.id}\n${group.members.join(", ")}`);
					}
					if (groupAction === "send") {
						const content = groupRest.join(" ").trim();
						if (!groupSubject || !content) throw new Error("Usage: /flux message group send <groupId> <text>");
						const result = bus.sendGroup("main", groupSubject, "message", content, { taskId: ensureImplicitPlan()?.taskId });
						return notify(ctx, `Group message sent to ${result.deliveries.length} recipient(s): ${result.envelope.id}`);
					}
				}
				throw new Error("Usage: /flux message send|inbox|ack|group");
			}
			if (command.kind === "gc") return notify(ctx, formatLifecycleGcReport(runLifecycleGc(runtime.fluxDir, runtime.config.retention, { dryRun: command.dryRun, activeRunIds: [...activeRuns.keys()] })), "info", 12);
			if (command.kind === "cancel") { const ids = command.taskId ? [command.taskId] : [...activeRuns.keys()]; for (const id of ids) activeRuns.get(id)?.abort(); return notify(ctx, ids.length ? `Cancellation requested: ${ids.join(", ")}` : "No active runs."); }
			if (command.kind === "agent") {
				const [action, name, roleOrTask, ...rest] = command.args;
				if (action === "list") return notify(ctx, formatPersistentAgents(listPersistentAgents(runtime.cwd)), "info", 12);
				if (action === "create" && name && roleOrTask) {
					const agent = registerPersistentAgent(runtime.cwd, name, roleOrTask, runtime.modelsConfig);
					telemetry.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "subagent", origin: "template", status: "idle", action: "created" });
					return notify(ctx, `Created ${agent.name}`);
				}
				if (action === "archive" && name) {
					const agent = archivePersistentAgent(runtime.cwd, name);
					telemetry.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "subagent", origin: agent.lineage.origin, status: "archived", action: "archived" });
					return notify(ctx, `Archived ${agent.name}`);
				}
				if (action === "run" && name && roleOrTask) return notify(ctx, formatAgentRunResult(await runPersistentAgent(name, [roleOrTask, ...rest].join(" "), persistentContext())), "info", 12);
				if (action === "retry" && name) {
					const record = listPersistentAgents(runtime.cwd).find(agent => agent.name === name && agent.status !== "archived");
					if (!record) throw new Error(`Persistent Agent not found: ${name}`);
					const task = [roleOrTask, ...rest].filter(Boolean).join(" ") || record.lastTask;
					if (!task) throw new Error(`retry requires a previous task (lastTask is empty for ${name})`);
					return notify(ctx, formatAgentRunResult(await runPersistentAgent(name, task, persistentContext())), "info", 12);
				}
				if (action === "stop" && name) {
					const record = listPersistentAgents(runtime.cwd).find(agent => agent.name === name);
					if (!record || record.status === "archived") throw new Error(`Persistent Agent not found: ${name}`);
					const controller = persistentControllers.get(name);
					if (controller) { controller.abort(); return notify(ctx, `Stop requested for ${name}`, "info"); }
					if (record.status === "running") { resetPersistentAgentStatus(runtime.cwd, name, "idle"); return notify(ctx, `${name} was marked running without a live run; status reset to idle.`, "info"); }
					throw new Error(`Persistent Agent is not running: ${name}`);
				}
				throw new Error("Usage: /flux agent list|create <name> <role>|run <name> <task>|retry <name> [task]|stop <name>|archive <name>");
			}
			if (command.kind === "issue") {
				const [action, id, ...rest] = command.args;
				if (action === "list") return notify(ctx, listIssues(runtime.cwd).map(formatIssue).join("\n\n") || "No Community issues.", "info", 12);
				if (action === "create") return notify(ctx, formatIssue(createIssue(runtime.cwd, { title: [id, ...rest].filter(Boolean).join(" "), description: "" })), "info", 12);
				if (action === "show" && id) { const issue = getIssue(runtime.cwd, id); if (!issue) throw new Error(`Issue not found: ${id}`); return notify(ctx, formatIssue(issue), "info", 12); }
				if (action === "comment" && id) return notify(ctx, formatIssue(commentOnIssue(runtime.cwd, id, "main", rest.join(" "))), "info", 12);
				if (action === "claim" && id && rest.length >= 2) return notify(ctx, formatIssue(claimIssue(runtime.cwd, id, rest[0], rest.slice(1).join(" "))), "info", 12);
				if (action === "submit" && id && rest[0]) return notify(ctx, formatIssue(submitClaim(runtime.cwd, id, rest[0])), "info", 12);
				if (action === "review" && id && rest[0]) return notify(ctx, formatIssue(reviewClaim(runtime.cwd, id, rest[0], rest[1] === "rework" ? "rework" : "pass", "main", rest.slice(2).join(" "))), "info", 12);
				if (action === "resolve" && id) return notify(ctx, formatIssue(resolveIssue(runtime.cwd, id)), "info", 12);
				throw new Error("Invalid /flux issue command");
			}

		} catch (error: any) { notify(ctx, error?.message ?? String(error), "error"); }
	} });
}
