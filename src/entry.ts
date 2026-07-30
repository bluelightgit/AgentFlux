import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createEphemeralRecord, finishEphemeralRecord, startEphemeralRecord } from "./agents/agent-lifecycle";
import { formatAgentRunResult, formatParallelAgentResults, runAgent, runAgentsParallel, type AgentRunResult, type AgentTemplate, type ParallelAgentTask } from "./agents/agent-runner";
import { archivePersistentAgent, formatPersistentAgents, listPersistentAgents, registerPersistentAgent, runPersistentAgent, type PersistentAgentContext } from "./agents/persistent-agent";
import { getForkCandidates, handleForkCommand, registerSessionFork } from "./agents/session-fork";
import { loadAllRoles } from "./agents/templates";
import { createIssue, claimIssue, commentOnIssue, formatIssue, getIssue, listIssues, resolveIssue, submitClaim } from "./core/community";
import { loadConfig, loadModelsConfig, parseWorkStyle, resolveSharedSkills, validateConfig } from "./core/config";
import { MessageBus, type DeliveredMessageV2 } from "./core/message-bus";
import { SharedBoard } from "./core/shared-board";
import { formatLifecycleGcReport, runLifecycleGc } from "./core/lifecycle-gc";
import { loadPricing, type PricingTable } from "./core/pricing";
import { createTaskExecutionPlan, formatTaskExecutionPlan, type TaskExecutionPlan } from "./core/task-execution";
import { resolvePathInsideExistingRoot } from "./core/safe-path";
import { parseAgentFluxTaskEnvelope, type AgentFluxTaskEnvelope } from "./core/task-envelope";
import { formatTasks, getTask, listTasks, registerTask, resolveTask, updateTaskMetadata, updateTaskStatus, type TaskStatus } from "./core/task-registry";
import type { WorkStyle } from "./core/types";
import { assertWorkStyleAllows, type WorkStyleCapability } from "./core/workstyle-policy";
import { analyzeCompaction, formatCompactionAdvice, registerCompactionAdvisor } from "./extension/compaction-advisor";
import { FLUX_HELP, getFluxArgumentCompletions, parseFluxCommand } from "./extension/commands";
import { applyMask } from "./extension/mask";
import { applyPrefixLayout } from "./extension/prefix-layout";
import { showAgentTuiMenu, showFluxTuiMenu, showForkTuiMenu, showIssueTuiMenu, showMessageTuiMenu, showTaskTuiMenu, showWorkflowTuiMenu, showWorkTuiMenu, type FluxTuiMenuData } from "./extension/tui-menu";
import { installSlashArgumentAutocompleteBridge } from "./extension/tui-autocomplete-bridge";
import { TelemetryWriter } from "./telemetry/events";
import { executeDAG, formatDAGResult, generateTaskDAG, resolveDAGRoleModel, type DAGExecutionResult, type TaskDAG } from "./workflows/dag-executor";
import { createWorkflowDefinition, formatWorkflowDefinitions, getWorkflowDefinition, listWorkflowDefinitions, reviseWorkflowDefinition } from "./workflows/workflow-registry";

interface RuntimeContext {
	cwd: string;
	fluxDir: string;
	config: ReturnType<typeof loadConfig>;
	modelsConfig: any;
	sharedSkills: string[];
	pricing?: PricingTable;
}
function notify(ctx: any, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else (level === "error" ? console.error : console.log)(text);
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
	const workflowInvocations = new Set<string>();

	const operatingProtocol = [
		"AgentFlux operating protocol:",
		"- The user only needs to describe the desired outcome; never ask them to explain AgentFlux.",
		"- Work styles are cumulative: Direct is main-Agent execution; Team adds dynamic Agents; Workflow and Community both build on Team, adding either a fixed DAG or Issue/Claim collaboration that evolves with the work.",
		"- Choose Direct for small cohesive work, Team for bounded independent responsibilities, Workflow for stable dependencies, and Community when responsibilities must emerge through discussion and claims.",
		"- When the user asks to reuse, resume, or continue prior work, call flux_task with that matching action before doing the work; use list/inspect only when the user is asking about history.",
		"- When the user asks to change a saved Workflow definition, call flux_workflow with action=modify and its saved selector; do not use action=run and do not create DAG nodes that edit AgentFlux registry files.",
		"- Keep one top-level work style per task. Internal session, task, run, and Agent identifiers are managed by AgentFlux; do not request or invent them.",
	].join("\n");

	function workStyleInstruction(style: WorkStyle): string {
		return style === "direct"
			? "AgentFlux Direct mode: work in the main Agent and do not create another Agent."
			: style === "team"
				? "AgentFlux Team mode: use main-Agent execution plus a small set of bounded Agent tasks, then integrate and verify their results. In flux_team, role is an optional registered template id, not a free-form role description; omit it when name already matches a template."
				: style === "workflow"
					? "AgentFlux Workflow mode: use Team capabilities under one fixed dependency graph; call flux_workflow exactly once with action=run and task as natural-language requirements. Do not pass a DAG or object in workflow; workflow is only a saved selector string for show/reuse/modify."
					: "AgentFlux Community mode: use Team capabilities under an evolving Issue; moderate discussion, claims, submissions, and resolution.";
	}

	function startPlan(plan: TaskExecutionPlan, writeCreated = true): TaskExecutionPlan {
		if (!telemetry || !runtime) return plan;
		registerTask(runtime.fluxDir, sessionId, plan, "running");
		const lineage = {
			executionId: plan.executionId,
			parentTaskId: plan.parentTaskId,
			parentExecutionId: plan.parentExecutionId,
			runId: plan.executionId,
		};
		if (writeCreated) telemetry.writeTaskExecution({ sessionId, taskId: plan.taskId, action: "created", workStyle: plan.workStyle, selectedBy: plan.selectedBy, task: plan.task, operation: plan.operation, ...lineage });
		telemetry.writeTaskExecution({ sessionId, taskId: plan.taskId, action: "started", workStyle: plan.workStyle, selectedBy: plan.selectedBy, task: plan.task, operation: plan.operation, ...lineage });
		return plan;
	}

	function finishCurrentPlan(outcome: ExecutionOutcome): void {
		if (!telemetry || !runtime) return;
		const plan = currentPlan ?? implicitPlan ?? (implicitTask
			? createTaskExecutionPlan({ task: implicitTask.task, taskId: implicitTask.taskId, workStyle: "direct", selectedBy: "main_agent", budget: runtime.config.budget })
			: null);
		if (!plan) return;
		if (!currentPlan && !implicitPlan) startPlan(plan);
		telemetry.writeTaskExecution({
			sessionId,
			taskId: plan.taskId,
			action: outcome.action,
			workStyle: plan.workStyle,
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

	function selectImplicitWorkStyle(style: WorkStyle): TaskExecutionPlan | null {
		if (!runtime || !telemetry || currentPlan || !implicitTask) return null;
		if (implicitPlan) return implicitPlan;
		implicitPlan = startPlan(createTaskExecutionPlan({ task: implicitTask.task, taskId: implicitTask.taskId, workStyle: style, selectedBy: "main_agent", budget: runtime.config.budget }));
		return implicitPlan;
	}

	function requireWorkStyleCapability(
		capability: WorkStyleCapability,
		implicitStyle: WorkStyle,
		operation: string,
	): TaskExecutionPlan | null {
		const activePlan = currentPlan ?? implicitPlan;
		if (activePlan) {
			assertWorkStyleAllows(activePlan.workStyle, capability, operation);
			return activePlan;
		}
		return selectImplicitWorkStyle(implicitStyle);
	}

	const persistentContext = (maxCostUsd = runtime?.config.budget.max_cost_per_task): PersistentAgentContext => {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		return { cwd: runtime.cwd, modelsConfig: runtime.modelsConfig, telemetry: telemetry ?? undefined, pricing: runtime.pricing, sessionId, taskId: currentPlan?.taskId ?? implicitPlan?.taskId, executionId: currentPlan?.executionId ?? implicitPlan?.executionId, sharedSkills: runtime.sharedSkills, prefixLayout: runtime.config.cache.prefix_layout === "static_first", timeoutMs: runtime.config.budget.max_wall_clock_seconds * 1000, maxCostUsd };
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
				...persistent.map(agent => ({ ...agent, communication: agent.status === "archived" || agent.status === "running" ? "none" as const : "persistent_session" as const })),
				...shared.map(agent => ({ name: agent.name, kind: "ephemeral" as const, role: agent.role, status: agent.status, model: agent.model, provider: agent.provider, sessionId: agent.sessionFile, callCount: 1, totalCostUsd: 0, capabilityGeneration: 1, lastTask: agent.currentTask, communication: ["idle", "running", "blocked"].includes(agent.status) ? "message" as const : "none" as const })),
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
		const result = await runAgent({ cwd: runtime.cwd, agent: template, task, sessionId, telemetry: telemetry ?? undefined, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, persistent: false, timeoutMs: runtime.config.budget.max_wall_clock_seconds * 1000, maxRetries: 1, maxCostUsd: runtime.config.budget.max_cost_per_task, signal, lockFiles, taskId, executionId: currentPlan?.executionId ?? implicitPlan?.executionId, runId });
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
			return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, maxWallClockMs: plan.budget.maxWallClockMs, maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: 3, executionId: plan.executionId, taskId: plan.taskId, resumeFromExecutionId: resumeExecutionId });
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
			return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, maxWallClockMs: plan.budget.maxWallClockMs, maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: 3, executionId: plan.executionId, taskId: plan.taskId });
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
		telemetry.writeAgentLifecycle({ sessionId, taskId: plan.taskId, agentId: plannerAgentId, agent: "dag-planner", kind: "ephemeral", origin: "fresh", status: "running", action: "started", role: "planner", currentTask: `Plan Workflow: ${plan.task}`.slice(0, 200), model: planner.model });
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
			telemetry.writeAgentLifecycle({ sessionId, taskId: plan.taskId, agentId: plannerAgentId, agent: "dag-planner", kind: "ephemeral", origin: "fresh", status: "done", action: "completed", role: "planner", currentTask: `Plan Workflow: ${plan.task}`.slice(0, 200), model: planner.model });
		} catch (error) {
			telemetry.writeAgentLifecycle({ sessionId, taskId: plan.taskId, agentId: plannerAgentId, agent: "dag-planner", kind: "ephemeral", origin: "fresh", status: signal?.aborted ? "cancelled" : "failed", action: signal?.aborted ? "cancelled" : "failed", role: "planner", currentTask: `Plan Workflow: ${plan.task}`.slice(0, 200), model: planner.model });
			throw error;
		}
		return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, maxWallClockMs: Math.max(1, plan.budget.maxWallClockMs - (Date.now() - startedAt)), maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: 3, executionId: plan.executionId, taskId: plan.taskId });
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		const config = loadConfig(ctx.cwd);
		const warnings = validateConfig(config);
		const modelsConfig = loadModelsConfig(ctx.cwd);
		const fluxDir = join(ctx.cwd, ".agentflux");
		telemetry = new TelemetryWriter(fluxDir);
		sessionId = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.() ?? `main-${randomUUID()}`;
		runtime = { cwd: ctx.cwd, fluxDir, config, modelsConfig, sharedSkills: resolveSharedSkills(config, modelsConfig) };
		try { runtime.pricing = await loadPricing(fluxDir, config.pricing, ctx.model?.id); } catch {}
		for (const warning of warnings) notify(ctx, warning, "warning");
		notify(ctx, "AgentFlux ready · Direct / Team / Workflow / Community", "info");
	});

	pi.on("context", async (event: any) => {
		if (!runtime) return undefined;
		const result = applyMask(event.messages, runtime.config.context, null);
		return result.result.applied ? { messages: result.messages } : undefined;
	});
	pi.on("before_provider_request", async (event: any) => runtime ? applyPrefixLayout(event.payload, runtime.config.cache).payload : undefined);
	pi.on("input", async (event: any) => {
		const envelope = parseAgentFluxTaskEnvelope(event.text);
		if (!envelope) return undefined;
		pendingTaskEnvelope = envelope;
		return { action: "transform", text: envelope.task, images: event.images };
	});
	pi.on("before_agent_start", async (event: any) => {
		if (!currentPlan) {
			if (!runtime) return undefined;
			const envelope = pendingTaskEnvelope ?? parseAgentFluxTaskEnvelope(event.prompt);
			pendingTaskEnvelope = null;
			const task = envelope?.task ?? event.prompt;
			const fixedWorkStyle = envelope
				? parseWorkStyle(envelope.workStyle)
				: parseWorkStyle(process.env.AGENTFLUX_WORK_STYLE);
			if (fixedWorkStyle) {
				executionOutcome = null;
				lastAgentRunFailed = false;
				currentPlan = startPlan(createTaskExecutionPlan({ task, taskId: envelope?.taskId, workStyle: fixedWorkStyle, selectedBy: "user", budget: runtime.config.budget }));
			} else {
				implicitTask = { taskId: envelope?.taskId ?? `task-${randomUUID()}`, task };
				implicitPlan = null;
				return { systemPrompt: `${event.systemPrompt}\n\n${operatingProtocol}` };
			}
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${operatingProtocol}\n${workStyleInstruction(currentPlan.workStyle)}` };
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
			workStyle: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("team"), Type.Literal("workflow"), Type.Literal("community")])),
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
			const requestedWorkStyle = params.workStyle ?? source?.workStyle;
			if (activePlan && requestedWorkStyle && activePlan.workStyle !== requestedWorkStyle) {
				throw new Error(
					`${activePlan.workStyle} is already active for this task; cannot switch to ${requestedWorkStyle}`,
				);
			}
			const preparedTaskId = activePlan?.taskId;
			const task = params.task?.trim() || implicitTask?.task || source?.task;
			const workStyle = activePlan?.workStyle ?? requestedWorkStyle;
			if (!task || !workStyle) throw new Error("new requires task and workStyle");
			currentPlan = startPlan(createTaskExecutionPlan({
				task,
				taskId: preparedTaskId,
				workStyle,
				selectedBy: "main_agent",
				budget: runtime.config.budget,
				operation: params.action,
				parentTaskId: source?.id,
				parentExecutionId: source?.executionId,
			}), !preparedTaskId);
			implicitPlan = null;
			const next = workStyle === "direct" ? "Continue in the main Agent."
				: workStyle === "team" ? `Call flux_team with the responsibilities needed for this continuation.${source?.team?.length ? ` Prior team: ${source.team.map(member => `${member.name}${member.role ? `(${member.role})` : ""}`).join(", ")}.` : ""}`
					: workStyle === "workflow" ? "Call flux_workflow once; resume uses the saved checkpoint when available."
						: `Use flux_issue to continue the existing Issue or create a linked Issue when needed.${source?.resource?.type === "issue" ? ` Existing Issue: ${source.resource.id}.` : ""}`;
			return { content: [{ type: "text", text: `${params.action} prepared for ${workStyle}. ${next}` }], details: { ok: true } };
		},
	});

	pi.registerTool({
		name: "flux_agent",
		label: "Agent",
		description: "Create, run, list or archive an Agent. Ephemeral Agents terminate after one task; persistent Agents keep a stable identity and session.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("run_ephemeral"), Type.Literal("create_persistent"), Type.Literal("run_persistent"), Type.Literal("list"), Type.Literal("archive")]), name: Type.Optional(Type.String()), role: Type.Optional(Type.String()), task: Type.Optional(Type.String()), lockFiles: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params, signal) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			if (params.action === "list") return { content: [{ type: "text", text: formatPersistentAgents(listPersistentAgents(runtime.cwd)) }], details: { ok: true } };
			requireWorkStyleCapability("team", "team", `${params.action} an Agent`);
			if (!params.name) throw new Error(`${params.action} requires name`);
			if (params.action === "create_persistent") { if (!params.role) throw new Error("create_persistent requires role"); const agent = registerPersistentAgent(runtime.cwd, params.name, params.role, runtime.modelsConfig); telemetry?.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "persistent", origin: "template", status: "idle", action: "created" }); return { content: [{ type: "text", text: `Created persistent Agent ${agent.name} (${agent.role})` }], details: { ok: true } }; }
			if (params.action === "archive") { const agent = archivePersistentAgent(runtime.cwd, params.name); telemetry?.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "persistent", origin: agent.lineage.origin, status: "archived", action: "archived" }); return { content: [{ type: "text", text: `Archived ${agent.name}` }], details: { ok: true } }; }
			if (!params.task) throw new Error(`${params.action} requires task`);
			let result: AgentRunResult;
			try {
				result = params.action === "run_persistent"
					? await runPersistentAgent(params.name, params.task, persistentContext(), signal)
					: await runEphemeral(params.role ?? params.name, params.name, params.task, signal, params.lockFiles, currentPlan?.taskId ?? implicitPlan?.taskId);
			} catch (error: any) {
				executionOutcome = signal?.aborted
					? { action: "cancelled", status: "cancelled", error: "Agent cancelled" }
					: { action: "failed", status: "failure", error: String(error?.message ?? error).slice(0, 500) };
				throw error;
			}
			if (result.exitCode !== 0 || result.errorMessage) {
				executionOutcome = result.exitCode === 130 || signal?.aborted
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
		name: "flux_team",
		label: "Agent Team",
		description: "Run a small set of independent Agent tasks in parallel. The main Agent remains lead and integrates the results. Each role, when provided, must be a registered template id; put free-form responsibility details in task.",
		parameters: Type.Object({ tasks: Type.Array(Type.Object({
			name: Type.String({ description: "Agent instance name. When role is omitted, this must also match a registered template id." }),
			role: Type.Optional(Type.String({ description: "Optional registered Agent template id, never a free-form role description." })),
			task: Type.String({ description: "Complete natural-language responsibility for this Agent." }),
			persistent: Type.Optional(Type.Boolean()),
			workspace: Type.Optional(Type.String({ description: "Exact working directory for this Agent. Relative lockFiles resolve from this directory." })),
			lockFiles: Type.Optional(Type.Array(Type.String({ description: "Only these files may be edited; relative paths resolve from workspace." }))),
			model: Type.Optional(Type.String({ description: "Explicit per-run model override." })),
			provider: Type.Optional(Type.String({ description: "Explicit per-run provider override." })),
			thinking: Type.Optional(Type.Union([
				Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
				Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"),
			])),
		}), { minItems: 1, maxItems: 5 }) }),
		async execute(_id, params, signal) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			requireWorkStyleCapability("team", "team", "run an Agent Team");
			const teamTaskId = currentPlan?.taskId ?? implicitPlan?.taskId;
			if (teamTaskId) updateTaskMetadata(runtime.fluxDir, teamTaskId, { team: params.tasks.map(item => ({ name: item.name, role: item.role, persistent: item.persistent })) });
			const ephemeral: ParallelAgentTask[] = [];
			const locks: Record<string, string[]> = {};
			const persistentTasks: Array<Promise<AgentRunResult>> = [];
			const perMemberBudget = runtime.config.budget.max_cost_per_task / params.tasks.length;
			const teamAbort = new AbortController();
			const abortTeam = () => teamAbort.abort();
			if (signal?.aborted) teamAbort.abort();
			else signal?.addEventListener("abort", abortTeam, { once: true });
			for (const item of params.tasks) {
				if (item.persistent) {
					persistentTasks.push(
						runPersistentAgent(item.name, item.task, persistentContext(perMemberBudget), teamAbort.signal)
							.catch(error => {
								teamAbort.abort();
								throw error;
							}),
					);
				}
				else {
					ephemeral.push({
						agent: templateFromRole(runtime, item.role ?? item.name, item.name),
						task: item.task,
						label: item.name,
						workspaceCwd: item.workspace,
						lockFiles: item.lockFiles,
						model: item.model,
						provider: item.provider,
						thinking: item.thinking,
					});
					if (item.lockFiles) locks[item.name] = item.lockFiles;
				}
			}
			const parallelPromise = ephemeral.length
				? runAgentsParallel(ephemeral, { cwd: runtime.cwd, sessionId, telemetry: telemetry ?? undefined, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, timeoutMs: runtime.config.budget.max_wall_clock_seconds * 1000, maxRetries: 1, lockFiles: locks, signal: teamAbort.signal, maxCostUsd: perMemberBudget * ephemeral.length, taskId: currentPlan?.taskId ?? implicitPlan?.taskId, executionId: currentPlan?.executionId ?? implicitPlan?.executionId })
				: Promise.resolve(null);
			// Attach handlers to both branches before either can reject. Waiting for
			// ephemeral work first left an immediately rejected persistent run
			// unobserved long enough for Node to terminate the host process.
			const [parallelSettlement, persistentSettlement] = await Promise.allSettled([
				parallelPromise.catch(error => {
					teamAbort.abort();
					throw error;
				}),
				Promise.all(persistentTasks),
			]);
			signal?.removeEventListener("abort", abortTeam);
			if (parallelSettlement.status === "rejected" || persistentSettlement.status === "rejected") {
				const error = parallelSettlement.status === "rejected"
					? parallelSettlement.reason
					: persistentSettlement.status === "rejected"
						? persistentSettlement.reason
						: new Error("Team execution failed");
				executionOutcome = signal?.aborted
					? { action: "cancelled", status: "cancelled", error: "Team cancelled" }
					: { action: "failed", status: "failure", error: String(error?.message ?? error).slice(0, 500) };
				throw error;
			}
			const parallel = parallelSettlement.value;
			const persistentResults = persistentSettlement.value;
			const failedResults = [
				...(parallel?.results ?? []),
				...persistentResults,
			].filter(result => result.exitCode !== 0 || result.errorMessage);
			const teamCostUsd = (parallel?.totalCost ?? 0)
				+ persistentResults.reduce((total, result) => total + result.usage.cost, 0);
			if (failedResults.length > 0) {
				const timedOut = failedResults.every(result => result.exitCode === 124);
				const cancelled = signal?.aborted || failedResults.every(result => result.exitCode === 130);
				executionOutcome = cancelled
					? { action: "cancelled", status: "cancelled", error: "Team cancelled", costUsd: teamCostUsd }
					: timedOut
						? { action: "failed", status: "timeout", error: "Team timed out", costUsd: teamCostUsd }
						: { action: "failed", status: "failure", error: failedResults.map(result => result.errorMessage ?? `${result.agent} exit ${result.exitCode}`).join("; ").slice(0, 500), costUsd: teamCostUsd };
			} else {
				executionOutcome = { action: "completed", status: "success", costUsd: teamCostUsd };
			}
			const text = [parallel ? formatParallelAgentResults(parallel) : "", ...persistentResults.map(formatAgentRunResult)].filter(Boolean).join("\n\n");
			return { content: [{ type: "text", text }], details: { parallel, persistentResults } };
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
			const plan = requireWorkStyleCapability("workflow", "workflow", "start a fixed Workflow")
				?? createTaskExecutionPlan({ task: params.task ?? "", workStyle: "workflow", selectedBy: "main_agent", budget: runtime.config.budget });
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
		name: "flux_issue", label: "Community Issue", description: "Create, discuss, claim, submit and resolve Community work.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("show"), Type.Literal("comment"), Type.Literal("claim"), Type.Literal("submit"), Type.Literal("resolve")]), issueId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), body: Type.Optional(Type.String()), agent: Type.Optional(Type.String()), scope: Type.Optional(Type.String()), claimId: Type.Optional(Type.String()), acceptanceCriteria: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			if (params.action === "list") { const issues = listIssues(runtime.cwd); return { content: [{ type: "text", text: issues.length ? issues.map(formatIssue).join("\n\n") : "No Community issues." }], details: { ok: true } }; }
			if (params.action !== "show") requireWorkStyleCapability("community", "community", `${params.action} a Community Issue`);
			if (params.action === "create") { const issue = createIssue(runtime.cwd, { title: params.title ?? "", description: params.body ?? "", acceptanceCriteria: params.acceptanceCriteria }); const taskId = currentPlan?.taskId ?? implicitPlan?.taskId; if (taskId) updateTaskMetadata(runtime.fluxDir, taskId, { resource: { type: "issue", id: issue.id } }); return { content: [{ type: "text", text: formatIssue(issue) }], details: { ok: true } }; }
			if (!params.issueId) throw new Error(`${params.action} requires issueId`);
			const issue = params.action === "show" ? getIssue(runtime.cwd, params.issueId)
				: params.action === "comment" ? commentOnIssue(runtime.cwd, params.issueId, params.agent ?? "main", params.body ?? "")
					: params.action === "claim" ? claimIssue(runtime.cwd, params.issueId, params.agent ?? "main", params.scope ?? "")
						: params.action === "submit" ? submitClaim(runtime.cwd, params.issueId, params.claimId ?? "")
							: resolveIssue(runtime.cwd, params.issueId);
			if (!issue) throw new Error(`Issue not found: ${params.issueId}`);
			const taskId = currentPlan?.taskId ?? implicitPlan?.taskId;
			if (taskId) updateTaskMetadata(runtime.fluxDir, taskId, { resource: { type: "issue", id: issue.id } });
			return { content: [{ type: "text", text: formatIssue(issue) }], details: { ok: true } };
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
			requireWorkStyleCapability("team", "team", `${params.action} Agent messages`);
			const bus = new MessageBus(runtime.fluxDir);
			const sender = params.sender ?? "main";
			const taskId = currentPlan?.taskId ?? implicitPlan?.taskId;
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
			telemetry!.writeTaskExecution({ sessionId, taskId: plan.taskId, executionId: plan.executionId, runId: plan.executionId, action, workStyle: plan.workStyle, selectedBy: plan.selectedBy, task: plan.task, operation: plan.operation, parentTaskId: plan.parentTaskId, parentExecutionId: plan.parentExecutionId, outcome: { status, success: action === "completed" } });
			updateTaskStatus(runtime!.fluxDir, plan.taskId, action === "completed" ? "completed" : action === "cancelled" ? "cancelled" : status === "timeout" ? "timed_out" : "failed", { executionId: plan.executionId, costUsd: result.totalCost, outcome: { status } });
		};
		if (ctx.mode === "print") {
			try {
				const result = await runWorkflow(plan, controller.signal, request);
				finish(result);
				notify(ctx, formatDAGResult(result));
			} finally {
				activeRuns.delete(plan.taskId);
			}
			return;
		}
		notify(ctx, `${formatTaskExecutionPlan(plan)}\nDispatched.`);
		void runWorkflow(plan, controller.signal, request)
			.then(result => { finish(result); notify(ctx, formatDAGResult(result)); })
				.catch(error => { updateTaskStatus(runtime!.fluxDir, plan.taskId, "failed", { executionId: plan.executionId, outcome: { status: "failure", error: String(error?.message ?? error) } }); notify(ctx, `Workflow failed: ${error?.message ?? error}`, "error"); })
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
			if (input.trim() === "work") {
				const menuCommand = await showWorkTuiMenu(ctx);
				if (menuCommand === undefined) return notify(ctx, "Usage: /flux work <direct|team|workflow|community> <task>");
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
			if (command.kind === "status") return notify(ctx, [`work style ${currentPlan?.workStyle ?? "idle"}`, `active runs ${activeRuns.size}`, formatPersistentAgents(listPersistentAgents(runtime.cwd)), `issues ${listIssues(runtime.cwd).length}`].join("\n"));
			if (command.kind === "task") {
				const [action = "list", selector, ...taskParts] = command.args;
				if (action === "list") return notify(ctx, formatTasks(listTasks(runtime.fluxDir, sessionId).slice(0, 10)));
				const source = resolveTask(runtime.fluxDir, selector, sessionId);
				if (action === "show") {
					if (!source) throw new Error("No matching AgentFlux task in the current session");
					return notify(ctx, formatTasks([source]));
				}
				if (!["reuse", "resume", "continue", "retry"].includes(action) || !source) throw new Error("Usage: /flux task list|show [selector]|reuse|resume|continue|retry [selector] [task]");
				if (action === "retry" && !["failed", "cancelled", "timed_out"].includes(source.status)) throw new Error(`Cannot retry a ${source.status} task`);
				if (action === "resume" && !["failed", "cancelled", "timed_out", "running"].includes(source.status)) throw new Error(`Cannot resume a ${source.status} task; use continue or reuse`);
				const task = taskParts.join(" ").trim() || source.task;
				const plan = startPlan(createTaskExecutionPlan({ task, workStyle: source.workStyle, selectedBy: "user", budget: runtime.config.budget, operation: action as "reuse" | "resume" | "continue" | "retry", parentTaskId: source.id, parentExecutionId: source.executionId }));
				currentPlan = plan;
				notify(ctx, `${action} prepared for ${source.workStyle}.`);
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
				if (action === "list") return notify(ctx, formatWorkflowDefinitions(listWorkflowDefinitions(runtime.fluxDir)));
				if (!selector) throw new Error("Usage: /flux workflow list|show <selector>|reuse <selector> <task>|modify <selector> <change>");
				const definition = getWorkflowDefinition(runtime.fluxDir, selector);
				if (!definition) throw new Error(`Workflow not found: ${selector}`);
				if (action === "show") return notify(ctx, formatWorkflowDefinitions([definition], true));
				if (!["reuse", "modify"].includes(action)) throw new Error("Invalid /flux workflow command");
				const task = taskParts.join(" ").trim();
				if (!task) throw new Error(`Workflow ${action} requires a task`);
				const plan = startPlan(createTaskExecutionPlan({
					task,
					workStyle: "workflow",
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
					const result = bus.sendDirect("main", subject, "message", content, { taskId: currentPlan?.taskId ?? implicitPlan?.taskId });
					return notify(ctx, `Message sent to ${subject}: ${result.envelope.id}`);
				}
				if (action === "inbox") {
					const recipient = subject ?? "main";
					return notify(ctx, formatInbox(bus.poll(recipient)));
				}
				if (action === "ack") {
					const messageId = rest[0];
					if (!subject || !messageId) throw new Error("Usage: /flux message ack <agent> <messageId>");
					const delivery = bus.acknowledge(subject, messageId);
					return notify(ctx, `Acknowledged ${delivery.messageId} for ${delivery.recipient}.`);
				}
				if (action === "group") {
					const [groupAction, groupSubject, ...groupRest] = [subject, ...rest];
					if (groupAction === "list") return notify(ctx, formatMessageGroups(board.listGroups()));
					if (groupAction === "create") {
						const members = groupRest.join("").split(",").map(item => item.trim()).filter(Boolean);
						if (!groupSubject || members.length === 0) throw new Error("Usage: /flux message group create <name> <member,...>");
						const group = board.createGroup(groupSubject, [...new Set(["main", ...members])], "team", "main");
						return notify(ctx, `Created group ${group.name}: ${group.id}\n${group.members.join(", ")}`);
					}
					if (groupAction === "send") {
						const content = groupRest.join(" ").trim();
						if (!groupSubject || !content) throw new Error("Usage: /flux message group send <groupId> <text>");
						const result = bus.sendGroup("main", groupSubject, "message", content, { taskId: currentPlan?.taskId ?? implicitPlan?.taskId });
						return notify(ctx, `Group message sent to ${result.deliveries.length} recipient(s): ${result.envelope.id}`);
					}
				}
				throw new Error("Usage: /flux message send|inbox|ack|group");
			}
			if (command.kind === "gc") return notify(ctx, formatLifecycleGcReport(runLifecycleGc(runtime.fluxDir, runtime.config.retention, { dryRun: command.dryRun, activeRunIds: [...activeRuns.keys()] })));
			if (command.kind === "cancel") { const ids = command.taskId ? [command.taskId] : [...activeRuns.keys()]; for (const id of ids) activeRuns.get(id)?.abort(); return notify(ctx, ids.length ? `Cancellation requested: ${ids.join(", ")}` : "No active runs."); }
			if (command.kind === "agent") {
				const [action, name, roleOrTask, ...rest] = command.args;
				if (action === "list") return notify(ctx, formatPersistentAgents(listPersistentAgents(runtime.cwd)));
				if (action === "create" && name && roleOrTask) {
					const agent = registerPersistentAgent(runtime.cwd, name, roleOrTask, runtime.modelsConfig);
					telemetry.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "persistent", origin: "template", status: "idle", action: "created" });
					return notify(ctx, `Created ${agent.name}`);
				}
				if (action === "archive" && name) {
					const agent = archivePersistentAgent(runtime.cwd, name);
					telemetry.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "persistent", origin: agent.lineage.origin, status: "archived", action: "archived" });
					return notify(ctx, `Archived ${agent.name}`);
				}
				if (action === "run" && name && roleOrTask) return notify(ctx, formatAgentRunResult(await runPersistentAgent(name, [roleOrTask, ...rest].join(" "), persistentContext())));
				throw new Error("Usage: /flux agent list|create <name> <role>|run <name> <task>|archive <name>");
			}
			if (command.kind === "issue") {
				const [action, id, ...rest] = command.args;
				if (action === "list") return notify(ctx, listIssues(runtime.cwd).map(formatIssue).join("\n\n") || "No Community issues.");
				if (action === "create") return notify(ctx, formatIssue(createIssue(runtime.cwd, { title: [id, ...rest].filter(Boolean).join(" "), description: "" })));
				if (action === "show" && id) { const issue = getIssue(runtime.cwd, id); if (!issue) throw new Error(`Issue not found: ${id}`); return notify(ctx, formatIssue(issue)); }
				if (action === "comment" && id) return notify(ctx, formatIssue(commentOnIssue(runtime.cwd, id, "main", rest.join(" "))));
				if (action === "claim" && id && rest.length >= 2) return notify(ctx, formatIssue(claimIssue(runtime.cwd, id, rest[0], rest.slice(1).join(" "))));
				if (action === "submit" && id && rest[0]) return notify(ctx, formatIssue(submitClaim(runtime.cwd, id, rest[0])));
				if (action === "resolve" && id) return notify(ctx, formatIssue(resolveIssue(runtime.cwd, id)));
				throw new Error("Invalid /flux issue command");
			}
			if (command.kind === "work") {
				const plan = startPlan(createTaskExecutionPlan({ task: command.task, workStyle: command.style, selectedBy: "user", budget: runtime.config.budget }));
				if (plan.workStyle === "workflow") {
					await dispatchTuiWorkflow(plan, ctx);
					return;
				}
				if (plan.workStyle === "community") { const issue = createIssue(runtime.cwd, { title: plan.task.slice(0, 100), description: plan.task, acceptanceCriteria: [] }); updateTaskMetadata(runtime.fluxDir, plan.taskId, { resource: { type: "issue", id: issue.id } }); notify(ctx, `${formatTaskExecutionPlan(plan)}\nCreated ${issue.id}`); }
				else notify(ctx, `${formatTaskExecutionPlan(plan)}\nApplied.`);
				currentPlan = plan;
				const previousTurn = turnIndex;
				pi.sendUserMessage(plan.workStyle === "community" ? `Moderate and execute Community issue for: ${plan.task}` : plan.task);
				if (ctx.mode === "print") {
					const deadline = Date.now() + 5_000;
					while (ctx.isIdle?.() && turnIndex === previousTurn && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
					if (!ctx.isIdle?.()) await ctx.waitForIdle?.();
					else if (turnIndex === previousTurn) throw new Error("AgentFlux could not start the delegated main turn");
				}
				return;
			}
		} catch (error: any) { notify(ctx, error?.message ?? String(error), "error"); }
	} });
}
