import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { formatAgentRunResult, runAgent, type AgentRunResult, type AgentTemplate } from "./agents/agent-runner";
import { createAgent, deleteAgent, deleteSessionAgents, enqueueAgentInstruction, findAgents, formatAgents, formatAgentSessionCommand, formatSubagentStatusLine, gcAgents, getAgentRoles, listAgents, readAgentLastMessage, readAgentLastMessages, rejectQueuedAgentInstructions, resetAgentStatus, runAgentRecord, sortAgentsByActivity, type AgentRunContext } from "./agents/agent-store";
import { getForkCandidates, handleForkCommand, registerSessionFork } from "./agents/session-fork";
import { requestAgentRunStop } from "./agents/agent-run-control";
import { loadAllRoles } from "./agents/templates";
import { createIssue, claimIssue, commentOnIssue, deleteIssue, formatIssue, formatIssueTimeline, getIssue, listIssues, opposeProposal, proposeIssue, resolveIssue, reviewClaim, setCommunityLimits, submitClaim, supportProposal, type CommunityIssue } from "./core/community";
import { loadConfig, loadModelsConfig, resolveSharedSkills, validateConfig } from "./core/config";
import { MessageBus, type DeliveredMessageV2 } from "./core/message-bus";
import { SharedBoard } from "./core/shared-board";
import { formatLifecycleGcReport, runLifecycleGc } from "./core/lifecycle-gc";
import { formatActiveContext, pruneStaleActiveContext, readActiveContext, registerActiveContext, releaseActiveContext } from "./core/active-context";
import { loadPricing, type PricingTable } from "./core/pricing";
import { createTaskExecutionPlan, formatTaskExecutionPlan, type TaskExecutionPlan } from "./core/task-execution";
import { resolvePathInsideExistingRoot } from "./core/safe-path";
import { listAgentRuns, markAgentRunStopRequested, reconcileStaleAgentRuns, type AgentRunRecord } from "./core/run-registry";
import { parseAgentFluxTaskEnvelope, type AgentFluxTaskEnvelope } from "./core/task-envelope";
import { formatTasks, getTask, listTasks, registerTask, resolveTask, updateTaskMetadata, updateTaskStatus, type TaskStatus } from "./core/task-registry";
import { analyzeCompaction, formatCompactionAdvice, registerCompactionAdvisor } from "./extension/compaction-advisor";
import { FLUX_HELP, getFluxArgumentCompletions, parseAgentFlags, parseFluxCommand } from "./extension/commands";
import { applyPrefixLayout } from "./extension/prefix-layout";
import { showAgentTuiMenu, showFluxTuiMenu, showForkTuiMenu, showIssueTuiMenu, showMessageTuiMenu, showTaskTuiMenu, showWorkflowTuiMenu, type FluxTuiMenuData } from "./extension/tui-menu";
import { TelemetryWriter, type MainUsage } from "./telemetry/events";
import { executeDAG, formatDAGResult, generateTaskDAG, resolveDAGRoleModel, setDagLogSink, type DAGExecutionResult, type TaskDAG } from "./workflows/dag-executor";
import { createWorkflowDefinition, deleteWorkflowDefinition, formatWorkflowDefinitions, getWorkflowDefinition, listWorkflowDefinitions, reviseWorkflowDefinition } from "./workflows/workflow-registry";

interface RuntimeContext {
	cwd: string;
	fluxDir: string;
	config: ReturnType<typeof loadConfig>;
	modelsConfig: any;
	sharedSkills: string[];
	/** 当前 Main Agent 模型；没有角色级显式模型时，子代理和 DAG 继承它。 */
	mainModel?: string;
	mainProvider?: string;
	pricing?: PricingTable;
}
function notify(ctx: any, text: string, level: "info" | "warning" | "error" = "info", maxLines = 1): void {
	try {
		const cleaned = cleanNotifyText(text, maxLines);
		if (ctx.hasUI) {
			// 统一走 info 级: pi 的 showStatus 在对话最底部渲染浅灰色小字（dim）,
			// 连续通知会原地更新不堆积; warning/error 级别用前缀区分（不用彩色大字）
			const prefixed = level === "error" ? `⚠ ${cleaned}` : level === "warning" ? `△ ${cleaned}` : cleaned;
			ctx.ui.notify(prefixed, "info");
		} else (level === "error" ? console.error : console.log)(cleaned);
	} catch { /* 会话已销毁时后台回调的通知尽力而为 */ }
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

function isWorkflowTimeoutError(error: unknown): boolean {
	return /(?:deadline|timed[ -]?out|timeout)/i.test(String(error instanceof Error ? error.message : error ?? ""));
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

function formatAgentInspection(
	agent: ReturnType<typeof listAgents>[number],
	run: AgentRunRecord | undefined,
	pending: DeliveredMessageV2[],
	transcript: string[],
): string {
	const age = (timestamp: string | undefined): string => {
		if (!timestamp) return "-";
		const value = Date.parse(timestamp);
		if (!Number.isFinite(value)) return "-";
		const seconds = Math.floor(Math.max(0, Date.now() - value) / 1000);
		return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
	};
	const lines = [
		`Agent ${agent.name} (${agent.id})`,
		`status=${run?.status ?? agent.status} role=${run?.role ?? agent.role}${agent.roles?.length ? ` roles=${agent.roles.join("|")}` : ""}`,
		`run=${run?.id ?? "-"} phase=${run?.phase ?? "-"} health=${run?.health ?? "-"}${run?.healthReason ? ` reason=${run.healthReason}` : ""}`,
		`elapsed=${age(run?.createdAt)} liveness=${age(run?.heartbeatAt)} progress=${age(run?.lastProgressAt)} activity=${age(run?.lastActivityAt)} deadline=${run?.deadlineAt ?? "none"}`,
		`usage turns=${run?.turns ?? 0} input=${run?.input ?? 0} output=${run?.output ?? 0} context=${run?.contextTokens ?? 0} cost=$${(run?.costUsd ?? 0).toFixed(6)}`,
		`model=${run?.model ?? agent.model ?? "default"} provider=${run?.provider ?? agent.provider ?? "-"}`,
		`last progress=${run?.lastProgressType ?? "-"}: ${run?.lastProgressSummary ?? "-"}`,
		`last activity=${run?.lastActivityType ?? "-"}: ${run?.lastActivitySummary ?? "-"}`,
		`warnings=${run?.healthWarningCount ?? 0}${run?.healthWarningAt ? ` (last ${age(run.healthWarningAt)} ago)` : ""} repeat=${run?.repeatActionSignature ?? "-"}×${run?.repeatActionCount ?? 0}`,
		`queued=${pending.length}`,
	];
	if (run?.modelError) lines.push(`model error: ${run.modelError}`);
	if (run?.recentEvents?.length) {
		lines.push("recent events:");
		for (const event of run.recentEvents.slice(-10)) lines.push(`  ${event.at} [${event.phase}/${event.type}] ${event.summary}`);
	} else lines.push("recent events: (none)");
	if (run?.providerError) lines.push(`provider error: ${run.providerError}`);
	if (run?.error) lines.push(`error: ${run.error}`);
	if (transcript.length) {
		lines.push("transcript:");
		for (const text of transcript) lines.push(`  ${text.replace(/\s+/g, " ").slice(0, 500)}`);
	} else lines.push("transcript: (none)");
	if (pending.length) {
		lines.push("pending Message V2:");
		for (const item of pending) lines.push(`  ${item.envelope.id} · ${item.delivery.status} · ${item.envelope.priority} · ${item.envelope.content.slice(0, 300)}`);
	}
	return lines.join("\n");
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
		provider: role.provider ?? (role.model ? runtime.modelsConfig.models?.[role.model]?.provider : undefined),
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
	// Main 会话逐轮 usage 累计：turn_end 从 pi message_end 读取，agent_settled 落盘
	let mainTurnUsage: MainUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
	const resetMainUsage = (): MainUsage => { const usage = mainTurnUsage; mainTurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }; return usage; };
	const activeRuns = new Map<string, AbortController>();
	const persistentControllers = new Map<string, AbortController>();
	let uiCtx: any = null;  // TUI footer 状态行的 UI 上下文（session_start 时注入）
	/** TUI 底部单行状态：subagent: name - status | ...（运行中优先，其次按创建时间；无子代理时清除）。 */
	function updateSubagentStatusLine(): void {
		try {
			if (uiCtx?.ui?.setStatus && runtime) {
				uiCtx.ui.setStatus("agentflux-subagents", formatSubagentStatusLine(listAgents(runtime.cwd, sessionId)));
			}
		} catch { /* footer 更新尽力而为 */ }
	}
	function activeAgentRun(agentName: string): AgentRunRecord | undefined {
		if (!runtime) return undefined;
		return listAgentRuns(runtime.fluxDir, { agent: agentName, activeOnly: true })[0];
	}
	function latestAgentRun(agentName: string): AgentRunRecord | undefined {
		if (!runtime) return undefined;
		return listAgentRuns(runtime.fluxDir, { agent: agentName })[0];
	}
	function stopAgentRun(agentName: string): { run?: AgentRunRecord; stale: boolean; rejected?: number } {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		const run = activeAgentRun(agentName);
		if (run) {
			// Fence the Run before sweeping its queue.  enqueueAgentInstruction uses
			// the same durable stop request plus a post-send status check, so either
			// side winning the race leaves no accepted delivery behind.
			requestAgentRunStop(runtime.cwd, run.id, `main:${sessionId}`);
			try { markAgentRunStopRequested(runtime.fluxDir, run.id); } catch { /* 已经在终止/收敛时由 runner 完成 */ }
			const rejected = rejectQueuedAgentInstructions(runtime.cwd, run, "run stopped before queued instruction was consumed");
			persistentControllers.get(agentName)?.abort();
			return { run, stale: false, rejected };
		}
		const controller = persistentControllers.get(agentName);
		if (controller) {
			controller.abort();
			return { stale: false };
		}
		const record = findAgents(runtime.cwd, agentName, sessionId)[0];
		if (!record) throw new Error(`Agent not found: ${agentName}`);
		if (record.status === "running") {
			resetAgentStatus(runtime.cwd, record.name, "idle", sessionId);
			return { stale: true };
		}
		throw new Error(`Agent is not running: ${agentName}`);
	}
	let progressTimer: any = null;
	/** 子代理运行过程实时显示：TUI 用 working 行（覆盖输入区上方的“正在…”行），持续更新最新一步。 */
	function showSubagentProgress(name: string, event: { type: "message" | "tool"; text: string }): void {
		if (!uiCtx?.ui?.setWorkingMessage) return;
		const prefix = event.type === "tool" ? "⚙" : "💬";
		const text = `${prefix} [子代理 ${name}] ${event.text.replace(/\s+/g, " ").slice(0, 120)}`;
		try {
			uiCtx.ui.setWorkingMessage(text);
			clearTimeout(progressTimer);
			progressTimer = setTimeout(() => { try { uiCtx.ui.setWorkingMessage(undefined); } catch { /* 清理尽力而为 */ } }, 8000);
		} catch { /* working 行更新尽力而为 */ }
	}
	function showSubagentHealth(name: string, event: { health: string; reason?: string; warning: boolean }): void {
		if (!event.warning) return;
		notify(uiCtx, `[subagent ${name}] health=${event.health}${event.reason ? ` · ${event.reason}` : ""} (warning only; Run remains active)`, "warning", 1);
	}
	const workflowInvocations = new Set<string>();

	const operatingProtocol = [
		"AgentFlux operating protocol:",
		"- The user only needs to describe the desired outcome; never ask them to explain AgentFlux.",
		"- There are no work-style modes: execute in the main Agent or spawn subagents as the task demands; AgentFlux decides nothing for you.",
		"- Use flux_workflow (fixed DAG) or flux_issue (Issue/Claim collaboration) when the task is better served by that execution approach.",
		"- When the user asks to reuse, resume, or continue prior work, call flux_task with that matching action before doing the work; use list/inspect only when the user is asking about history.",
		"- When the user asks to change a saved Workflow definition, call flux_workflow with action=modify and its saved selector; do not use action=run and do not create DAG nodes that edit AgentFlux registry files.",
		"- Only one project-level execution may be active at a time: a Workflow run or a Community activity cannot overlap another. Internal session, task, run, and Agent identifiers are managed by AgentFlux; do not request or invent them.",
		"- Execution guidance: run simple or short tasks directly in the main Agent; delegate isolated, independent sub-tasks to subagents (flux_agent); use flux_workflow for multi-step tasks with dependencies, parallelism, or repeatable structure; use flux_issue for collaborative tasks that need proposals, reviews, and decisions. Prefer the lightest approach that fits the task.",
		"- Model guidance: an explicit Agent/role model wins; when none is configured, subagents inherit the Main Agent's current model/provider. Override per run with flux_agent model/thinking only when requested. Workflow roles use the same precedence; capability-and-price affinity is only a fallback when no Main model is available.",
	].join("\n");

	function startPlan(plan: TaskExecutionPlan, writeCreated = true): TaskExecutionPlan {
		if (!telemetry || !runtime) return plan;
		const startedPlan = plan.deadlineAt || plan.budget.maxWallClockMs === undefined
			? plan
			: { ...plan, deadlineAt: new Date(Date.now() + plan.budget.maxWallClockMs).toISOString() };
		registerTask(runtime.fluxDir, sessionId, startedPlan, "running", { ownerPid: process.pid });
		const lineage = {
			executionId: startedPlan.executionId,
			parentTaskId: startedPlan.parentTaskId,
			parentExecutionId: startedPlan.parentExecutionId,
			runId: startedPlan.executionId,
			deadlineAt: startedPlan.deadlineAt,
		};
		if (writeCreated) telemetry.writeTaskExecution({ sessionId, taskId: startedPlan.taskId, action: "created", selectedBy: startedPlan.selectedBy, task: startedPlan.task, operation: startedPlan.operation, ...lineage });
		telemetry.writeTaskExecution({ sessionId, taskId: startedPlan.taskId, action: "started", selectedBy: startedPlan.selectedBy, task: startedPlan.task, operation: startedPlan.operation, ...lineage });
		return startedPlan;
	}

	function finishCurrentPlan(outcome: ExecutionOutcome, usage?: MainUsage): void {
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
			usage,
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
			usage,
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

	/** 以 workflow 空间身份执行 DAG：互斥注册 + finally 释放。 */
	async function runWorkflowWithContext<T>(cwd: string, plan: TaskExecutionPlan, run: () => Promise<T>): Promise<T> {
		const entry = registerActiveContext(cwd, { name: `workflow:${plan.taskId ?? plan.executionId}`, context: "workflow", scope: plan.executionId, task: plan.task });
		try {
			return await run();
		} finally {
			releaseActiveContext(cwd, entry.leaseId);
		}
	}

	/** 空间总览：活跃上下文 + workflow/community 列表 + 最近 agent 活动时间线（只读，不清理/写盘）。 */
	function formatSpaceOverview(cwd: string): string {
		const lines: string[] = [`active context: ${formatActiveContext(readActiveContext(cwd))}`];
		const definitions = runtime ? listWorkflowDefinitions(runtime.fluxDir) : [];
		lines.push(`workflows ${definitions.length > 0 ? definitions.map(def => `${def.name} v${def.version}`).join(", ") : "(none)"}`);
		const issues = listIssues(cwd);
		lines.push(`community issues ${issues.length > 0 ? issues.map(issue => `${issue.id} · ${issue.status} · ${issue.title.slice(0, 40)}`).join("\n  ") : "(none)"}`);
		const eventsPath = join(cwd, ".agentflux", "events.jsonl");
		const events = existsSync(eventsPath) ? readFileSync(eventsPath, "utf-8").trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).filter((event: any) => event?.type === "agent.lifecycle" && (event.action === "started" || event.action === "completed" || event.action === "failed" || event.action === "cancelled")) : [];
		const timeline = events.slice(-10).map((event: any) => `  ${new Date(event.ts ?? event.timestamp ?? event.createdAt).toLocaleTimeString()} [${event.action}] ${event.agent}${event.currentTask ? ` · ${String(event.currentTask).slice(0, 50)}` : ""}`).join("\n");
		lines.push(`recent agent activity:\n${timeline || "  (none)"}`);
		return lines.join("\n");
	}

	/** community 空间启动：claim 内部完成互斥检查与注册（多 issue 并行允许）。 */
	const registerCommunityClaim = claimIssue;

	const persistentContext = (maxCostUsd = runtime?.config.budget.max_cost_per_task): AgentRunContext => {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		// ctx.model 可能在会话中被用户切换；每次调度读取当前值，而不是永久锁定 session_start 的模型。
		if (uiCtx?.model?.id) {
			runtime.mainModel = uiCtx.model.id;
			runtime.mainProvider = uiCtx.model.provider;
		}
		const maxWallClockSeconds = runtime.config.budget.max_wall_clock_seconds;
		const parentPlan = ensureImplicitPlan();
		const parentDeadlineMs = parentPlan?.deadlineAt ? Date.parse(parentPlan.deadlineAt) : undefined;
		return {
			cwd: runtime.cwd, modelsConfig: runtime.modelsConfig, telemetry: telemetry ?? undefined, pricing: runtime.pricing,
			sessionId, taskId: parentPlan?.taskId, executionId: parentPlan?.executionId,
			sharedSkills: runtime.sharedSkills, prefixLayout: runtime.config.cache.prefix_layout === "static_first",
			defaultModel: runtime.mainModel, defaultProvider: runtime.mainProvider,
			// Keep the parent wall-clock contract absolute.  A child may receive a
			// remaining duration for its watchdog, but runAgent must retain this
			// timestamp across retries and nested Workflow boundaries.
			deadlineAt: parentDeadlineMs,
			timeoutMs: parentDeadlineMs === undefined
				? (maxWallClockSeconds == null ? undefined : maxWallClockSeconds * 1000)
				: undefined,
			maxCostUsd, parentMaxCostUsd: parentPlan?.budget.maxCostUsd ?? runtime.config.budget.max_cost_per_task,
			parentMaxTurns: parentPlan?.budget.maxTurns ?? runtime.config.budget.max_turns_per_task,
			parentMaxInputTokens: parentPlan?.budget.maxInputTokens ?? runtime.config.budget.max_input_tokens_per_task,
			parentMaxParallel: parentPlan?.budget.maxParallel ?? runtime.config.budget.max_parallel_agents,
			health: runtime.config.health,
			space: "main",
		};
	};

	const tuiMenuData = (ctx: any): FluxTuiMenuData => {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		const agents = sortAgentsByActivity(listAgents(runtime.cwd, sessionId));
		const cwd = runtime.cwd;
		const activeAgentRuns = listAgentRuns(runtime.fluxDir, { activeOnly: true });
		const latestRunByAgent = new Map<string, (typeof activeAgentRuns)[number]>();
		for (const run of activeAgentRuns) if (!latestRunByAgent.has(run.agent)) latestRunByAgent.set(run.agent, run);
		const ageMs = (timestamp: string | undefined): number | undefined => {
			if (!timestamp) return undefined;
			const value = Date.parse(timestamp);
			return Number.isFinite(value) ? Math.max(0, Date.now() - value) : undefined;
		};
		const board = new SharedBoard(runtime.fluxDir);
		const agentFluxDir = runtime.fluxDir;
		const mainInbox = new MessageBus(agentFluxDir).peek("main");
		return {
			agents: [
				{ name: "main", kind: "main", role: "lead", status: currentPlan || implicitTask ? "running" : "idle", model: ctx.model?.id, provider: ctx.model?.provider, sessionId, callCount: turnIndex, totalCostUsd: 0, capabilityGeneration: 1, lastTask: currentPlan?.task ?? implicitTask?.task, communication: "current_chat" },
				...agents.map(agent => {
					const run = latestRunByAgent.get(agent.name);
					const runError = run?.error ?? run?.modelError ?? run?.providerError;
					return {
						...agent,
						kind: "subagent" as const,
						status: run?.status ?? agent.status,
						model: run?.model ?? agent.model,
						provider: run?.provider ?? agent.provider,
						phase: run?.phase,
						elapsedMs: ageMs(run?.createdAt),
						freshnessMs: ageMs(run?.lastActivityAt),
						turns: run?.turns,
						input: run?.input,
						output: run?.output,
						cacheRead: run?.cacheRead,
						cacheWrite: run?.cacheWrite,
						contextTokens: run?.contextTokens,
						liveCostUsd: run?.costUsd ?? 0,
						health: run?.health,
						healthReason: run?.healthReason,
						progressFreshnessMs: ageMs(run?.lastProgressAt),
						deadlineAt: run?.deadlineAt,
						healthWarningCount: run?.healthWarningCount,
						queuedMessages: run ? new MessageBus(agentFluxDir).peek(agent.name, { limit: 100, correlationId: run.id, includeUncorrelated: false }).filter(item => ["pending", "delivered"].includes(item.delivery.status)).length : 0,
						activity: run?.lastActivitySummary,
						error: runError,
						modelError: run?.modelError,
						providerError: run?.providerError,
						recentEvents: run?.recentEvents,
						runId: run?.id,
						communication: agent.status === "archived" || !!run ? "none" as const : "persistent_session" as const,
						sessionCommand: formatAgentSessionCommand(cwd, agent),
						lastMessage: readAgentLastMessage(cwd, agent),
						lastHistory: readAgentLastMessages(cwd, agent, 3),
					};
				}),
			],
			roles: [...loadAllRoles(runtime.cwd, runtime.modelsConfig).keys()].sort(),
			issues: listIssues(runtime.cwd).map(issue => ({ id: issue.id, title: issue.title, status: issue.status, claims: issue.claims.map(claim => ({ id: claim.id, agent: claim.agent, scope: claim.scope, status: claim.status })), proposals: (issue.proposals ?? []).map(proposal => ({ id: proposal.id, title: proposal.title })) })),
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

	async function runWorkflow(
		plan: TaskExecutionPlan,
		signal?: AbortSignal,
		request: { action?: "run" | "reuse" | "modify"; selector?: string; name?: string } = {},
	): Promise<DAGExecutionResult> {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		return runWorkflowWithContext(runtime.cwd, plan, () => runWorkflowInternal(plan, signal, request));
	}

	async function runWorkflowInternal(
		plan: TaskExecutionPlan,
		signal?: AbortSignal,
		request: { action?: "run" | "reuse" | "modify"; selector?: string; name?: string } = {},
	): Promise<DAGExecutionResult> {
		if (!runtime || !telemetry) throw new Error("AgentFlux is not initialized");
		// flux_workflow can be called with a freshly constructed plan when no
		// implicit Main plan exists. Materialize the deadline exactly once here,
		// before planner execution, and persist it so every downstream phase uses
		// the same absolute parent clock.
		if (plan.deadlineAt === undefined && plan.budget.maxWallClockMs !== undefined) {
			plan = { ...plan, deadlineAt: new Date(Date.now() + plan.budget.maxWallClockMs).toISOString() };
		}
		registerTask(runtime.fluxDir, sessionId, plan, "running", { ownerPid: process.pid });
		const planDeadlineAt = plan.deadlineAt === undefined
			? undefined
			: (() => {
				const value = Date.parse(plan.deadlineAt);
				if (!Number.isFinite(value)) throw new Error(`Task deadlineAt is invalid: ${plan.deadlineAt}`);
				return value;
			})();
		// If startPlan has not materialized a deadline, retain the relative budget
		// only as a fallback. Once an absolute deadline exists it is the sole clock.
		const planTimeoutMs = planDeadlineAt === undefined ? plan.budget.maxWallClockMs : undefined;
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
			return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, deadlineAt: planDeadlineAt, maxWallClockMs: planTimeoutMs, maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: plan.budget.maxParallel ?? 3, parentMaxTurns: plan.budget.maxTurns, parentMaxInputTokens: plan.budget.maxInputTokens, health: runtime.config.health, executionId: plan.executionId, taskId: plan.taskId, defaultModel: runtime.mainModel, defaultProvider: runtime.mainProvider, resumeFromExecutionId: resumeExecutionId, qualityGate: runtime.config.quality_gate ? { model: runtime.config.quality_gate.model, timeoutMs: runtime.config.quality_gate.timeout_ms } : undefined });
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
				registerTask(runtime.fluxDir, sessionId, plan, "running", { ownerPid: process.pid });
			}
			const dag = structuredClone(definition.dag);
			delete dag.planningCostUsd;
			mkdirSync(runsDir, { recursive: true });
			const runDir = resolvePathInsideExistingRoot(runsDir, plan.taskId);
			mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "dag.json"), JSON.stringify(dag, null, 2));
			updateTaskMetadata(runtime.fluxDir, plan.taskId, { resource: { type: "workflow", id: definition.id, version: definition.version } });
			return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, deadlineAt: planDeadlineAt, maxWallClockMs: planTimeoutMs, maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: plan.budget.maxParallel ?? 3, parentMaxTurns: plan.budget.maxTurns, parentMaxInputTokens: plan.budget.maxInputTokens, health: runtime.config.health, executionId: plan.executionId, taskId: plan.taskId, defaultModel: runtime.mainModel, defaultProvider: runtime.mainProvider, qualityGate: runtime.config.quality_gate ? { model: runtime.config.quality_gate.model, timeoutMs: runtime.config.quality_gate.timeout_ms } : undefined });
		}
		const previous = action === "modify"
			? getWorkflowDefinition(runtime.fluxDir, selector ?? "")
			: undefined;
		if (action === "modify" && !previous) throw new Error(`Workflow not found: ${selector ?? ""}`);
		if (previous && plan.operation === "new") {
			plan.operation = "continue";
			plan.parentTaskId = previous.sourceTaskId;
			registerTask(runtime.fluxDir, sessionId, plan, "running", { ownerPid: process.pid });
		}
		const planner = resolveDAGRoleModel(runtime.cwd, runtime.modelsConfig, "planner", { model: runtime.mainModel, provider: runtime.mainProvider });
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
			dag = await generateTaskDAG(planningTask, { cwd: runtime.cwd, model: planner.model, provider: planner.provider, defaultModel: runtime.mainModel, defaultProvider: runtime.mainProvider, thinking: planner.thinking, models: runtime.modelsConfig.models, modelsConfig: runtime.modelsConfig, pricing: runtime.pricing, telemetry, sessionId, prefixLayout: runtime.config.cache.prefix_layout === "static_first", signal, maxCostUsd: plan.budget.maxCostUsd, parentMaxTurns: plan.budget.maxTurns, parentMaxInputTokens: plan.budget.maxInputTokens, deadlineAt: planDeadlineAt, timeoutMs: planTimeoutMs, health: runtime.config.health, taskId: plan.taskId, executionId: plan.executionId });
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
		return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, deadlineAt: planDeadlineAt, maxWallClockMs: planTimeoutMs, maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: plan.budget.maxParallel ?? 3, parentMaxTurns: plan.budget.maxTurns, parentMaxInputTokens: plan.budget.maxInputTokens, health: runtime.config.health, executionId: plan.executionId, taskId: plan.taskId, defaultModel: runtime.mainModel, defaultProvider: runtime.mainProvider, qualityGate: runtime.config.quality_gate ? { model: runtime.config.quality_gate.model, timeoutMs: runtime.config.quality_gate.timeout_ms } : undefined });
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		uiCtx = ctx;
		const config = loadConfig(ctx.cwd);
		const warnings = validateConfig(config);
		const modelsConfig = loadModelsConfig(ctx.cwd);
		const fluxDir = join(ctx.cwd, ".agentflux");
		telemetry = new TelemetryWriter(fluxDir);
		sessionId = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.() ?? `main-${randomUUID()}`;
		runtime = { cwd: ctx.cwd, fluxDir, config, modelsConfig, sharedSkills: resolveSharedSkills(config, modelsConfig), mainModel: ctx.model?.id, mainProvider: ctx.model?.provider };
		let reconciled: AgentRunRecord[] = [];
		try {
			reconciled = reconcileStaleAgentRuns(fluxDir);
		} catch (error) {
			// Run/Task recovery uses separate durable stores.  A Task-store write
			// failure must not suppress the independent Agent idle reconciliation;
			// the exact failed Run is retried on the next startup.
			notify(ctx, `Run recovery incomplete: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`, "warning");
		}
		try {
			const activeAgentNames = new Set(listAgentRuns(fluxDir, { activeOnly: true }).map(run => run.agent));
			for (const agent of listAgents(ctx.cwd, sessionId)) {
				if (agent.status !== "running" || activeAgentNames.has(agent.name)) continue;
				try { resetAgentStatus(ctx.cwd, agent.id, "idle", sessionId); } catch { /* stale Agent cleanup is best-effort */ }
			}
			if (reconciled.length > 0) notify(ctx, `Reconciled ${reconciled.length} stale Agent Run(s) after restart.`, "warning");
		} catch (error) {
			notify(ctx, `Agent recovery unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`, "warning");
		}
		setCommunityLimits({ stallThreshold: config.community_stall_threshold ?? 3, maxCostPerTask: config.budget.max_cost_per_task, maxRounds: config.community_stall_threshold ?? 3 });
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
	pi.on("turn_end", async (event: any) => {
		turnIndex += 1;
		const message = event?.message;
		const u = message?.usage;
		if (u && typeof u.input === "number") {
			mainTurnUsage.input += u.input ?? 0;
			mainTurnUsage.output += u.output ?? 0;
			mainTurnUsage.cacheRead += u.cacheRead ?? 0;
			mainTurnUsage.cacheWrite += u.cacheWrite ?? 0;
			mainTurnUsage.costUsd += u.cost?.total ?? 0;
			if (message.model) mainTurnUsage.model = message.model;
		}
	});
	pi.on("agent_end", async (event: any) => {
		const lastAssistant = [...(event?.messages ?? [])].reverse().find((message: any) => message?.role === "assistant");
		lastAgentRunFailed = lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted";
	});
	pi.on("agent_settled", async () => {
		const terminal = executionOutcome ?? (lastAgentRunFailed
			? { action: "failed" as const, status: "failure" as const }
			: { action: "completed" as const, status: "success" as const });
		finishCurrentPlan(terminal, resetMainUsage());
	});
	pi.on("session_shutdown", async () => {
		for (const controller of activeRuns.values()) controller.abort();
		for (const controller of persistentControllers.values()) controller.abort();
		activeRuns.clear();
		persistentControllers.clear();
		if (runtime) {
			try { deleteSessionAgents(runtime.cwd, sessionId); } catch { /* 清理尽力而为 */ }
		}
		if (currentPlan || implicitPlan || implicitTask) {
			finishCurrentPlan(executionOutcome ?? {
				action: "cancelled",
				status: "cancelled",
				error: "Session closed before task settled",
			}, resetMainUsage());
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
		description: "Create, inspect, run, steer, stop, retry, list, delete or gc Agents. inspect reads the Core Run Registry and recent session transcript; steer always queues a Message V2 instruction to a busy Run. An Agent may bind to multiple registered roles; run selects the role for this Run without changing the Agent identity. run accepts a unique id or name; an unknown name auto-creates a default Agent. run (and retry) is background by default in TUI sessions (returns immediately, result is notified asynchronously and queryable via list); pass background:false to wait synchronously and return the Agent's last message (last(k) for more). In headless/print mode run always executes synchronously (background is meaningless there).",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("inspect"), Type.Literal("run"), Type.Literal("steer"), Type.Literal("stop"), Type.Literal("retry"), Type.Literal("list"), Type.Literal("delete"), Type.Literal("gc")]),
			background: Type.Optional(Type.Boolean()),
			name: Type.Optional(Type.String()),
			agent: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			roles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })),
			sessionMode: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("fresh")])),
			model: Type.Optional(Type.String()),
			thinking: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")])),
			forkFrom: Type.Optional(Type.String()),
			scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("session")])),
			task: Type.Optional(Type.String()),
			last: Type.Optional(Type.Number()),
			keepLatestK: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<any> {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			const context = persistentContext();
			if (params.action === "list") return { content: [{ type: "text", text: formatAgents(listAgents(runtime.cwd, sessionId), runtime.cwd) }], details: { ok: true } };
			if (params.action === "inspect") {
				if (!params.agent) throw new Error("inspect requires agent");
				const record = findAgents(runtime.cwd, params.agent, sessionId)[0];
				if (!record) throw new Error(`Agent not found: ${params.agent}`);
				const run = latestAgentRun(record.name);
				const pending = run
					? new MessageBus(runtime.fluxDir).peek(record.name, { limit: 100, correlationId: run.id, includeUncorrelated: false })
					: [];
				const transcript = readAgentLastMessages(runtime.cwd, record, Math.max(1, Math.min(20, Math.floor(params.last ?? 5))));
				const text = formatAgentInspection(record, run, pending, transcript);
				return { content: [{ type: "text", text }], details: { ok: true, agent: record, run, pending, transcript } };
			}
			if (params.action === "steer") {
				if (!params.agent) throw new Error("steer requires agent");
				if (!params.task?.trim()) throw new Error("steer requires task");
				const queued = enqueueAgentInstruction(params.agent, params.task, context, "high");
				if (!queued) throw new Error(`Agent is not running: ${params.agent}`);
				return { content: [{ type: "text", text: `Steer queued for ${queued.agent.name}: ${queued.message.envelope.id} (pending=${queued.pending}, run=${queued.run.id})` }], details: { ok: true, queued: true, runId: queued.run.id, message: queued.message, pending: queued.pending } };
			}
			if (params.action === "gc") {
				const removed = gcAgents(runtime.cwd, params.keepLatestK ?? 10, new Set(listAgents(runtime.cwd).filter(agent => agent.status === "running").map(agent => agent.name)));
				updateSubagentStatusLine();
				return { content: [{ type: "text", text: removed.length ? `GC removed ${removed.length} Agent(s): ${removed.join(", ")}` : "GC: no Agents to remove." }], details: { ok: true, removed } };
			}
			if (params.action === "create") {
				if (!params.name) throw new Error("create requires name");
				let agent;
				try {
					agent = createAgent(runtime.cwd, { name: params.name, role: params.role, roles: params.roles, model: params.model, thinking: params.thinking, forkFrom: params.forkFrom, scope: params.scope, ownerSessionId: sessionId, modelsConfig: runtime.modelsConfig });
				} catch (error: any) {
					executionOutcome = { action: "failed", status: "failure", error: String(error?.message ?? error).slice(0, 500) };
					throw error;
				}
				telemetry?.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "subagent", origin: agent.lineage.origin, status: "idle", action: "created", role: agent.role, forkPoint: agent.lineage.forkPoint });
				updateSubagentStatusLine();
				return { content: [{ type: "text", text: `Created Agent ${agent.name} (${getAgentRoles(agent).join("|")}, ${agent.scope})${agent.lineage.origin === "fork" ? ` · fork of ${params.forkFrom}` : ""}` }], details: { ok: true, agent: { name: agent.name, role: agent.role, roles: agent.roles, scope: agent.scope } } };
			}
			if (params.action === "delete") {
				if (!params.agent) throw new Error("delete requires agent");
				const agent = deleteAgent(runtime.cwd, params.agent, sessionId);
				telemetry?.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "subagent", origin: agent.lineage.origin, status: "archived", action: "archived" });
				updateSubagentStatusLine();
				return { content: [{ type: "text", text: `Deleted ${agent.name}` }], details: { ok: true } };
			}
			if (params.action === "stop") {
				if (!params.agent) throw new Error("stop requires agent");
				const record = findAgents(runtime.cwd, params.agent, sessionId)[0];
				if (!record) throw new Error(`Agent not found: ${params.agent}`);
				const stopped = stopAgentRun(record.name);
				updateSubagentStatusLine();
				return { content: [{ type: "text", text: stopped.stale ? `${record.name} was marked running without an active Run; status reset to idle.` : `Stop requested for ${record.name}${stopped.run ? ` (run=${stopped.run.id}${stopped.rejected ? `, rejected=${stopped.rejected}` : ""})` : ""}` }], details: { ok: true, runId: stopped.run?.id, stale: stopped.stale, rejected: stopped.rejected ?? 0 } };
			}
			if (params.action === "run" || params.action === "retry") {
				if (!params.agent) throw new Error(`${params.action} requires agent`);
				let matches = findAgents(runtime.cwd, params.agent, sessionId);
				if (params.action === "run" && matches.length === 0) {
					const agent = createAgent(runtime.cwd, { name: params.agent, role: params.role, roles: params.roles, model: params.model, thinking: params.thinking, scope: params.scope, ownerSessionId: sessionId, modelsConfig: runtime.modelsConfig });
					telemetry?.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "subagent", origin: agent.lineage.origin, status: "idle", action: "created", role: agent.role });
					matches = findAgents(runtime.cwd, agent.name, sessionId);
				}
				const selectedRole = params.role ?? (params.action === "retry" ? matches[0]?.lastRole : undefined);
				const runOverrides = { role: selectedRole, sessionMode: params.sessionMode, model: params.model, thinking: params.thinking };
				let task = params.task;
				if (params.action === "retry") {
					task = task ?? matches[0]?.lastTask ?? "";
					if (!task) throw new Error(`retry requires a previous task (lastTask is empty for ${matches[0]?.name ?? params.agent})`);
				}
				if (!task) throw new Error(`${params.action} requires task`);
				const queued = enqueueAgentInstruction(matches[0].name, task, context, "high");
				if (queued) {
					return { content: [{ type: "text", text: `Agent ${queued.agent.name} is busy; instruction queued via Message V2 (${queued.message.envelope.id}, pending=${queued.pending}, run=${queued.run.id}).` }], details: { ok: true, queued: true, runId: queued.run.id, message: queued.message, pending: queued.pending } };
				}
				if (persistentControllers.has(matches[0].name)) throw new Error(`Agent is already starting: ${matches[0].name}`);
				const controller = new AbortController();
				const forwardAbort = () => controller.abort();
				persistentControllers.set(matches[0].name, controller);
				signal?.addEventListener("abort", forwardAbort, { once: true });
				const background = params.background !== false && uiCtx?.hasUI !== false; // TUI 默认后台（结果异步通知）；headless 默认同步（会话立即结束，后台无意义）；background:false 显式同步 / background:true 显式后台
				if (background) {
					// 后台模式：不等待子代理完成，立即返回；结果在完成时 notify + footer 状态行
					const name = matches[0].name;
					void runAgentRecord(name, task, context, controller.signal, undefined, runOverrides, () => updateSubagentStatusLine(), event => showSubagentProgress(name, event), event => showSubagentHealth(name, event))
						.then(result => {
							const ok = result.exitCode === 0 && !result.errorMessage;
							notify(uiCtx, `[subagent ${name}] ${ok ? "completed" : result.exitCode === 130 ? "cancelled" : result.exitCode === 124 ? "timed out" : "failed"} · turns ${result.usage.turns} · $${result.usage.cost.toFixed(4)}`, "info", 1);
						})
						.catch((error: any) => {
							notify(uiCtx, `[subagent ${name}] failed: ${String(error?.message ?? error).slice(0, 200)}`, "info", 1);
						})
						.finally(() => {
							signal?.removeEventListener("abort", forwardAbort);
							persistentControllers.delete(name);
							updateSubagentStatusLine();
						});
					updateSubagentStatusLine();
					return { content: [{ type: "text", text: `后台已启动子代理 ${name}（任务：${task.length > 80 ? `${task.slice(0, 80)}...` : task}）。运行中可用 /flux agent stop ${name} 停止；完成后会通知，可用 flux_agent list 查看最近结果。` }], details: { ok: true, background: true } };
				}
				let result: AgentRunResult;
				const headlessBgNote = params.background === true && !uiCtx?.hasUI ? "（headless 模式不支持后台，已同步执行）\n" : "";
				try {
					result = await runAgentRecord(matches[0].name, task, context, controller.signal, undefined, runOverrides, () => updateSubagentStatusLine(), event => showSubagentProgress(matches[0].name, event), event => showSubagentHealth(matches[0].name, event));
				} catch (error: any) {
					executionOutcome = controller.signal.aborted
						? { action: "cancelled", status: "cancelled", error: "Agent cancelled" }
						: { action: "failed", status: "failure", error: String(error?.message ?? error).slice(0, 500) };
					throw error;
				} finally {
					signal?.removeEventListener("abort", forwardAbort);
					persistentControllers.delete(matches[0].name);
					updateSubagentStatusLine();
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
				updateSubagentStatusLine();
				return { content: [{ type: "text", text: headlessBgNote + formatAgentRunResult(result, Math.max(1, params.last ?? 1)) }], details: { ok: result.exitCode === 0 && !result.errorMessage } };
			}
			throw new Error("Usage: flux_agent list|create|run|stop|retry|delete|gc");
		},
	});

	pi.registerTool({
		name: "flux_workflow",
		label: "Workflow",
		description: "List, inspect, create, reuse or revise saved fixed-DAG Workflows. For action=run, pass only natural-language task requirements and optional name; AgentFlux plans the DAG. workflow is a saved selector string only for show/reuse/modify, never a DAG or object.",
		parameters: Type.Object({
			action: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("list"), Type.Literal("show"), Type.Literal("reuse"), Type.Literal("modify"), Type.Literal("delete")])),
			task: Type.Optional(Type.String({ description: "Natural-language work requirements. Required for a new action=run Workflow." })),
			workflow: Type.Optional(Type.String({ description: "Saved Workflow selector such as id, name, or id@version. Only for show/reuse/modify; never pass a DAG/object." })),
			name: Type.Optional(Type.String({ description: "Optional stable name for a newly created Workflow." })),
		}),
		async execute(_id, params, signal): Promise<any> {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			const action = params.action ?? "run";
			if (action === "delete") {
				if (!params.workflow) throw new Error("delete requires workflow");
				const active = new Set(readActiveContext(runtime.cwd).entries.filter(entry => entry.context === "workflow").map(entry => entry.scope ?? entry.name));
				const removed = deleteWorkflowDefinition(runtime.fluxDir, params.workflow, active);
				return { content: [{ type: "text", text: `Deleted workflow ${removed.name} (v${removed.version})` }], details: { ok: true } };
			}
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
				workflowInvocations.delete(plan.taskId);
				executionOutcome = signal?.aborted
					? { action: "cancelled", status: "cancelled", error: "Workflow cancelled" }
					: isWorkflowTimeoutError(error)
						? { action: "failed", status: "timeout", error: String(error?.message ?? error).slice(0, 500) }
						: { action: "failed", status: "failure", error: String(error?.message ?? error).slice(0, 500) };
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "flux_issue", label: "Community Issue", description: "Create, discuss, claim, submit, review and resolve Community work.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("show"), Type.Literal("comment"), Type.Literal("propose"), Type.Literal("support"), Type.Literal("oppose"), Type.Literal("claim"), Type.Literal("submit"), Type.Literal("review"), Type.Literal("resolve"), Type.Literal("delete")]), issueId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), body: Type.Optional(Type.String()), agent: Type.Optional(Type.String()), scope: Type.Optional(Type.String()), claimId: Type.Optional(Type.String()), verdict: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("rework")])), proposalIds: Type.Optional(Type.Array(Type.String())), plan: Type.Optional(Type.String()), costUsd: Type.Optional(Type.Number()), acceptanceCriteria: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			if (params.action === "list") { const issues = listIssues(runtime.cwd); return { content: [{ type: "text", text: issues.length ? issues.map(formatIssue).join("\n\n") : "No Community issues." }], details: { ok: true } }; }
			if (params.action === "create") { const issue = createIssue(runtime.cwd, { title: params.title ?? "", description: params.body ?? "", acceptanceCriteria: params.acceptanceCriteria }); const taskId = ensureImplicitPlan()?.taskId; if (taskId) updateTaskMetadata(runtime.fluxDir, taskId, { resource: { type: "issue", id: issue.id } }); return { content: [{ type: "text", text: formatIssue(issue) }], details: { ok: true } }; }
			if (!params.issueId) throw new Error(`${params.action} requires issueId`);
			const issue = params.action === "show" ? getIssue(runtime.cwd, params.issueId)
				: params.action === "comment" ? commentOnIssue(runtime.cwd, params.issueId, params.agent ?? "main", params.body ?? "")
					: params.action === "propose" ? proposeIssue(runtime.cwd, params.issueId, { title: params.title ?? "", body: params.body ?? "", createdBy: params.agent ?? "main" })
						: params.action === "support" ? supportProposal(runtime.cwd, params.issueId, params.claimId ?? "", params.agent ?? "main")
							: params.action === "oppose" ? opposeProposal(runtime.cwd, params.issueId, params.claimId ?? "", params.agent ?? "main")
								: params.action === "claim" ? claimIssue(runtime.cwd, params.issueId, params.agent ?? "main", params.scope ?? "", { proposalIds: params.proposalIds, plan: params.plan })
									: params.action === "submit" ? submitClaim(runtime.cwd, params.issueId, params.claimId ?? "", params.plan, params.costUsd)
										: params.action === "review" ? reviewClaim(runtime.cwd, params.issueId, params.claimId ?? "", params.verdict ?? "pass", params.agent ?? "main", params.body ?? "")
											: resolveIssue(runtime.cwd, params.issueId, params.body);
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
		if (!ctx.hasUI) {
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
				.catch(error => {
					const timedOut = isWorkflowTimeoutError(error);
					updateTaskStatus(runtime!.fluxDir, plan.taskId, timedOut ? "timed_out" : "failed", {
						executionId: plan.executionId,
						outcome: { status: timedOut ? "timeout" : "failure", error: String(error?.message ?? error) },
					});
					taskNotify(ctx, `${timedOut ? "Workflow timed out" : "Workflow failed"}: ${error?.message ?? error}`, timedOut ? "warning" : "error");
				})
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
			if (command.kind === "status") return notify(ctx, [`task ${currentPlan?.taskId ?? "idle"}`, `active runs ${activeRuns.size}`, formatAgents(listAgents(runtime.cwd, sessionId), runtime.cwd), `issues ${listIssues(runtime.cwd).length}`].join("\n"), "info", 12);
			if (command.kind === "usage") {
				const usage = mainTurnUsage;
				const total = usage.input + usage.cacheRead;
				const hit = total > 0 ? Math.round((usage.cacheRead / total) * 100) : 0;
				return notify(ctx, `main usage this session: in ${usage.input} · out ${usage.output} · cache read ${usage.cacheRead} (hit ${hit}%) · $${usage.costUsd.toFixed(4)}${usage.model ? ` · ${usage.model}` : ""}`, "info", 1);
			}
			if (command.kind === "space") return notify(ctx, formatSpaceOverview(runtime.cwd), "info", 24);
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
					if (!ctx.hasUI) {
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
				if (!ctx.hasUI) {
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
				if (action === "delete") {
					const active = new Set(readActiveContext(runtime.cwd).entries.filter(entry => entry.context === "workflow").map(entry => entry.scope ?? entry.name));
					const removed = deleteWorkflowDefinition(runtime.fluxDir, selector, active);
					return notify(ctx, `Deleted workflow ${removed.name} (v${removed.version})`);
				}
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
						const members = groupRest.join(",").split(",").map(item => item.trim()).filter(Boolean);
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
				const [action, subject, ...rest] = command.args;
				// 解析 --model <m> 与 --thinking <t> 覆盖参数（与 issue claim --props 同风格）
				const { flags, positional } = parseAgentFlags(rest);
				if (action === "list") return notify(ctx, formatAgents(listAgents(runtime.cwd, sessionId), runtime.cwd), "info", 12);
				if (action === "inspect" && subject) {
					const record = findAgents(runtime.cwd, subject, sessionId)[0];
					if (!record) throw new Error(`Agent not found: ${subject}`);
					const run = latestAgentRun(record.name);
					const pending = new MessageBus(runtime.fluxDir).peek(record.name, { limit: 100 });
					const transcript = readAgentLastMessages(runtime.cwd, record, Math.max(1, Math.min(20, Number(positional[0]) || 5)));
					return notify(ctx, formatAgentInspection(record, run, pending, transcript), "info", 24);
				}
				if (action === "steer" && subject) {
					const task = positional.join(" ").trim();
					if (!task) throw new Error("Usage: /flux agent steer <name> <instruction>");
					const queued = enqueueAgentInstruction(subject, task, persistentContext(), "high");
					if (!queued) throw new Error(`Agent is not running: ${subject}`);
					return notify(ctx, `Steer queued for ${queued.agent.name}: ${queued.message.envelope.id} (pending=${queued.pending}, run=${queued.run.id})`, "info");
				}
				if (action === "create" && subject) {
					const role = positional[0];
					const roles = flags.roles?.split(",").map(item => item.trim()).filter(Boolean);
					const agent = createAgent(runtime.cwd, { name: subject, role, roles, model: flags.model, thinking: flags.thinking as any, scope: positional.find((item): item is "global" | "project" | "session" => ["global", "project", "session"].includes(item)), ownerSessionId: sessionId, modelsConfig: runtime.modelsConfig });
					telemetry.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "subagent", origin: agent.lineage.origin, status: "idle", action: "created", role: agent.role });
					updateSubagentStatusLine();
					return notify(ctx, `Created ${agent.name} (${getAgentRoles(agent).join("|")}, ${agent.scope})${flags.model ? ` · model ${flags.model}` : ""}${flags.thinking ? ` · thinking ${flags.thinking}` : ""}`);
				}
				if (action === "run" && subject) {
					const task = positional.join(" ").trim();
					if (!task) throw new Error("Usage: /flux agent run <name> <task> [--role <role>] [--model <m>] [--thinking <t>] [--sync]");
					const existing = findAgents(runtime.cwd, subject, sessionId);
					const agent = existing[0] ?? createAgent(runtime.cwd, { name: subject, role: flags.role, model: flags.model, thinking: flags.thinking as any, modelsConfig: runtime.modelsConfig });
					const runOverrides = { role: flags.role, sessionMode: flags.sessionMode as "shared" | "fresh" | undefined, model: flags.model, thinking: flags.thinking as any };
					const queued = enqueueAgentInstruction(agent.name, task, persistentContext(), "high");
					if (queued) return notify(ctx, `Agent ${queued.agent.name} is busy; instruction queued via Message V2 (${queued.message.envelope.id}, pending=${queued.pending}, run=${queued.run.id}).`, "info");
					if (persistentControllers.has(agent.name)) throw new Error(`Agent is already starting: ${agent.name}`);
					const background = flags.sync !== "true" && ctx.hasUI; // TUI 默认后台；headless 同步（会话立即结束，后台无意义）；--sync 强制同步；--background 强制后台
					if (flags.background === "true" && !ctx.hasUI) notify(ctx, "headless 模式不支持后台，已同步执行", "info", 1);
					if (background) {
						const controller = new AbortController();
						persistentControllers.set(agent.name, controller);
						void runAgentRecord(agent.name, task, persistentContext(), controller.signal, undefined, runOverrides, () => updateSubagentStatusLine(), event => showSubagentProgress(agent.name, event), event => showSubagentHealth(agent.name, event))
							.then(result => {
								const ok = result.exitCode === 0 && !result.errorMessage;
								notify(ctx, `[subagent ${agent.name}] ${ok ? "completed" : result.exitCode === 130 ? "cancelled" : result.exitCode === 124 ? "timed out" : "failed"} · turns ${result.usage.turns} · $${result.usage.cost.toFixed(4)}`, "info", 1);
							})
							.catch((error: any) => notify(ctx, `[subagent ${agent.name}] failed: ${String(error?.message ?? error).slice(0, 200)}`, "info", 1))
							.finally(() => { persistentControllers.delete(agent.name); updateSubagentStatusLine(); });
						updateSubagentStatusLine();
						return notify(ctx, `后台已启动子代理 ${agent.name}（任务：${task.length > 80 ? `${task.slice(0, 80)}...` : task}）。/flux agent stop ${agent.name} 可停止，/flux agent list 查看最近结果。`, "info", 1);
					}
					updateSubagentStatusLine();
					const syncController = new AbortController();
					persistentControllers.set(agent.name, syncController);
					try {
						return notify(ctx, formatAgentRunResult(await runAgentRecord(agent.name, task, persistentContext(), syncController.signal, undefined, runOverrides, () => updateSubagentStatusLine(), event => showSubagentProgress(agent.name, event), event => showSubagentHealth(agent.name, event)), 1), "info", 12);
					} finally {
						persistentControllers.delete(agent.name);
						updateSubagentStatusLine();
					}
				}
				if (action === "retry" && subject) {
					const record = findAgents(runtime.cwd, subject, sessionId)[0];
					const agentName = record?.name ?? subject;
					const task = positional.join(" ").trim() || record?.lastTask;
					if (!task) throw new Error(`retry requires a previous task (lastTask is empty for ${subject})`);
					const retryOverrides = { role: flags.role ?? record?.lastRole, sessionMode: flags.sessionMode as "shared" | "fresh" | undefined, model: flags.model, thinking: flags.thinking as any };
					const queued = enqueueAgentInstruction(agentName, task, persistentContext(), "high");
					if (queued) return notify(ctx, `Agent ${queued.agent.name} is busy; retry instruction queued via Message V2 (${queued.message.envelope.id}, pending=${queued.pending}, run=${queued.run.id}).`, "info");
					if (persistentControllers.has(agentName)) throw new Error(`Agent is already starting: ${agentName}`);
					const controller = new AbortController();
					persistentControllers.set(agentName, controller);
					try {
						return notify(ctx, formatAgentRunResult(await runAgentRecord(subject, task, persistentContext(), controller.signal, undefined, retryOverrides, () => updateSubagentStatusLine(), event => showSubagentProgress(agentName, event), event => showSubagentHealth(agentName, event)), 1), "info", 12);
					} finally {
						persistentControllers.delete(agentName);
						updateSubagentStatusLine();
					}
				}
				if (action === "stop" && subject) {
					const record = findAgents(runtime.cwd, subject, sessionId)[0];
					if (!record) throw new Error(`Agent not found: ${subject}`);
					const stopped = stopAgentRun(record.name);
					return notify(ctx, stopped.stale ? `${record.name} was marked running without an active Run; status reset to idle.` : `Stop requested for ${record.name}${stopped.run ? ` (run=${stopped.run.id}${stopped.rejected ? `, rejected=${stopped.rejected}` : ""})` : ""}`, "info");
				}
				if (action === "delete" && subject) {
					const agent = deleteAgent(runtime.cwd, subject, sessionId);
					telemetry.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "subagent", origin: agent.lineage.origin, status: "archived", action: "archived" });
					return notify(ctx, `Deleted ${agent.name}`);
				}
				if (action === "gc") {
					const removed = gcAgents(runtime.cwd, Number(subject) || 10, new Set(listAgents(runtime.cwd).filter(agent => agent.status === "running").map(agent => agent.name)));
					return notify(ctx, removed.length ? `GC removed ${removed.length} Agent(s): ${removed.join(", ")}` : "GC: no Agents to remove.", "info");
				}
				throw new Error("Usage: /flux agent list|create <name> [role]|run <name> <task>|retry <name> [task]|stop <name>|delete <name>|gc [k]");
			}
			if (command.kind === "issue") {
				const [action, id, ...rest] = command.args;
				if (action === "list") return notify(ctx, listIssues(runtime.cwd).map(formatIssue).join("\n\n") || "No Community issues.", "info", 12);
				if (action === "create") return notify(ctx, formatIssue(createIssue(runtime.cwd, { title: [id, ...rest].filter(Boolean).join(" "), description: "" })), "info", 12);
				if (action === "show" && id) { const issue = getIssue(runtime.cwd, id); if (!issue) throw new Error(`Issue not found: ${id}`); return notify(ctx, formatIssue(issue), "info", 12); }
				if (action === "comment" && id) return notify(ctx, formatIssue(commentOnIssue(runtime.cwd, id, "main", rest.join(" "))), "info", 12);
				if (action === "propose" && id && rest[0]) return notify(ctx, formatIssue(proposeIssue(runtime.cwd, id, { title: rest[0], body: rest.slice(1).join(" ") })), "info", 12);
				if (action === "support" && id && rest[0]) return notify(ctx, formatIssue(supportProposal(runtime.cwd, id, rest[0], "main")), "info", 12);
				if (action === "oppose" && id && rest[0]) return notify(ctx, formatIssue(opposeProposal(runtime.cwd, id, rest[0], "main")), "info", 12);
				if (action === "claim" && id && rest.length >= 2) {
					const args = rest.slice(2).join(" ");
					const propsMatch = args.match(/--props\s+([^\s]+)/);
					const plan = args.replace(/--props\s+[^\s]+/g, "").replace(/^--plan\s+/, "").trim();
					return notify(ctx, formatIssue(registerCommunityClaim(runtime.cwd, id, rest[0], rest[1], { proposalIds: propsMatch ? propsMatch[1].split(",").map(item => item.trim()).filter(Boolean) : undefined, plan })), "info", 12);
				}
				if (action === "resolve" && id) return notify(ctx, formatIssue(resolveIssue(runtime.cwd, id, rest.join(" "))), "info", 12);
				if (action === "delete" && id) return notify(ctx, `Deleted issue ${deleteIssue(runtime.cwd, id).id}`);
				if (action === "submit" && id && rest[0]) return notify(ctx, formatIssue(submitClaim(runtime.cwd, id, rest[0], rest.slice(1).join(" ").replace(/^--plan\s+/, ""))), "info", 12);
				if (action === "review" && id && rest[0]) { if (rest[1] !== "rework" && rest[1] !== "pass") throw new Error("Usage: /flux issue review <id> <claimId> pass|rework [feedback]"); return notify(ctx, formatIssue(reviewClaim(runtime.cwd, id, rest[0], rest[1], "main", rest.slice(2).join(" "))), "info", 12); }
				throw new Error("Invalid /flux issue command");
			}

		} catch (error: any) { notify(ctx, error?.message ?? String(error), "error"); }
	} });
}
