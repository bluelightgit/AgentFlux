import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { archivePersistentAgent, listPersistentAgents, registerPersistentAgent, runPersistentAgent } from "../agents/persistent-agent";
import { runAgentsParallel, type AgentCompletionProof, type AgentTemplate, type ParallelRunResult } from "../agents/agent-runner";
import { requestAgentRunStop } from "../agents/agent-run-control";
import { loadAllRoles } from "../agents/templates";
import { loadEffectiveCapabilitySnapshot, loadRegisteredCapabilityOverride } from "../core/capability-policy";
import { claimIssue, commentOnIssue, createIssue, getIssue, listIssues, resolveIssue, submitClaim } from "../core/community";
import { loadConfig, loadModelsConfig, resolveSharedSkills, validateConfig } from "../core/config";
import { runLifecycleGc, type LifecycleGcOptions } from "../core/lifecycle-gc";
import { MessageBus } from "../core/message-bus";
import type { DeliveredMessageV2, MessagePriority, SendMessageV2Result } from "../core/message-bus";
import { SharedBoard } from "../core/shared-board";
import { getTask, listTaskExecutions, listTasks, registerTask, updateTaskMetadata, updateTaskStatus, type TaskStatus } from "../core/task-registry";
import { createTaskExecutionPlan } from "../core/task-execution";
import { assertSafeOpaqueId, resolvePathInsideExistingRoot } from "../core/safe-path";
import { loadPricing } from "../core/pricing";
import { getAgentRun, listAgentRuns, markAgentRunStopRequested, reconcileStaleAgentRuns } from "../core/run-registry";
import type { FluxEvent } from "../telemetry/events";
import { TelemetryWriter } from "../telemetry/events";
import { listWorkflowDefinitions } from "../workflows/workflow-registry";

export interface AgentFluxProjectSnapshot {
	config: ReturnType<typeof loadConfig>;
	warnings: string[];
	roles: ReturnType<typeof loadAllRoles> extends Map<string, infer T> ? T[] : never[];
	persistentAgents: ReturnType<typeof listPersistentAgents>;
	issues: ReturnType<typeof listIssues>;
	workflows: ReturnType<typeof listWorkflowDefinitions>;
	workflowRuns: AgentFluxWorkflowRunView[];
	groups: ReturnType<SharedBoard["listGroups"]>;
	tasks: ReturnType<typeof listTasks>;
	executions: ReturnType<typeof listTaskExecutions>;
	runs: ReturnType<typeof listAgentRuns>;
	history: {
		limit: number;
		totalTasks: number;
		totalExecutions: number;
		totalRuns: number;
		truncated: boolean;
	};
	messages: Array<{
		envelope: ReturnType<MessageBus["listEnvelopes"]>[number];
		deliveries: NonNullable<ReturnType<MessageBus["getDelivery"]>>[];
	}>;
	persistentAgentCapabilities: AgentFluxPersistentCapabilityView[];
}

export interface AgentFluxWorkflowRunNodeView {
	nodeId: string;
	passed: boolean;
	retryCount: number;
	exitCode: number;
	error?: string;
	model?: string;
	costUsd: number;
	gate: null | {
		status: "passed" | "failed" | "indeterminate";
		passed: boolean;
		feedback: string;
		criteriaResults: Array<{ criterion: string; met: boolean }>;
		costUsd: number;
		model?: string;
	};
}

export interface AgentFluxWorkflowRunView {
	taskId: string;
	executionId: string;
	status: "running" | "passed" | "failed" | "cancelled" | "budget_exceeded" | "timed_out";
	completed: string[];
	failed: string[];
	totalCostUsd: number;
	iterationCount: number;
	updatedAt: number;
	artifactPaths: Record<string, string>;
	nodes: AgentFluxWorkflowRunNodeView[];
}

export interface AgentFluxPersistentCapabilityView {
	agentName: string;
	role: string;
	model?: string;
	provider?: string;
	thinking?: AgentTemplate["thinking"];
	tools: string[];
	skills: string[];
	mcpServers: string[];
	communicationEnabled: boolean;
	capabilityGeneration: number;
	overrideRevision: number;
	sessionId?: string;
	effectiveSessionId?: string;
	cacheImpact: "stable" | "new_generation";
}

export interface AgentFluxEventPage {
	events: FluxEvent[];
	nextCursor: number;
	hasMore: boolean;
	invalidEvents: number;
}

export interface AgentFluxTaskHistoryPage {
	tasks: ReturnType<typeof listTasks>;
	offset: number;
	limit: number;
	total: number;
	nextOffset?: number;
}

export interface AgentFluxTaskDetail {
	task: NonNullable<ReturnType<typeof getTask>>;
	executions: ReturnType<typeof listTaskExecutions>;
	runs: ReturnType<typeof listAgentRuns>;
	messages: AgentFluxProjectSnapshot["messages"];
	workflowRun?: AgentFluxWorkflowRunView;
}

export interface AgentFluxTeamTaskSpec {
	name: string;
	role: string;
	task: string;
	workspace: string;
	lockFiles?: string[];
	model?: string;
	provider?: string;
	thinking?: AgentTemplate["thinking"];
	maxTurns?: number;
	maxInputTokens?: number;
	completionProof?: AgentCompletionProof;
}

export interface AgentFluxTeamSpec {
	sessionId?: string;
	taskId?: string;
	task?: string;
	allowCommits?: boolean;
	maxRetries?: number;
	executionProfile?: "default" | "low_cost_test";
	tasks: AgentFluxTeamTaskSpec[];
}

export interface AgentFluxTeamTaskRuntime {
	model?: string;
	provider?: string;
	thinking?: AgentTemplate["thinking"];
	maxTurns?: number;
	maxInputTokens?: number;
}

const LOW_COST_TEST_RUNTIME: Required<AgentFluxTeamTaskRuntime> = {
	model: "deepseek-v4-flash",
	provider: "octopus-completions",
	thinking: "off",
	maxTurns: 6,
	maxInputTokens: 12_000,
};

export function resolveAgentFluxTeamTaskRuntime(
	spec: Pick<AgentFluxTeamSpec, "executionProfile">,
	item: Pick<AgentFluxTeamTaskSpec, "model" | "provider" | "thinking" | "maxTurns" | "maxInputTokens">,
	defaults: Pick<AgentFluxTeamTaskRuntime, "model" | "provider" | "thinking">,
): AgentFluxTeamTaskRuntime {
	if (spec.executionProfile !== "low_cost_test") {
		return {
			model: item.model ?? defaults.model,
			provider: item.provider ?? defaults.provider,
			thinking: item.thinking ?? defaults.thinking,
			maxTurns: item.maxTurns,
			maxInputTokens: item.maxInputTokens,
		};
	}
	return {
		...LOW_COST_TEST_RUNTIME,
		maxTurns: Math.min(LOW_COST_TEST_RUNTIME.maxTurns, item.maxTurns ?? LOW_COST_TEST_RUNTIME.maxTurns),
		maxInputTokens: Math.min(
			LOW_COST_TEST_RUNTIME.maxInputTokens,
			item.maxInputTokens ?? LOW_COST_TEST_RUNTIME.maxInputTokens,
		),
	};
}

export function resolveAgentFluxTeamStatus(result: ParallelRunResult): TaskStatus {
	if (result.allSucceeded) return "completed";
	const failed = result.results.filter(item => item.exitCode !== 0 || item.errorMessage);
	if (failed.length > 0 && failed.every(item => item.exitCode === 130)) return "cancelled";
	if (failed.length > 0 && failed.every(item => item.exitCode === 124)) return "timed_out";
	return "failed";
}

export interface AgentFluxSendMessageInput {
	taskId: string;
	target: string;
	content: string;
	priority?: MessagePriority;
}

export interface AgentFluxSendGroupMessageInput {
	taskId: string;
	groupId: string;
	content: string;
	priority?: MessagePriority;
}

export type AgentFluxSendMessageResult = SendMessageV2Result;

export interface AgentFluxInboxInput {
	recipient?: string;
	limit?: number;
}

export interface AgentFluxEphemeralActionInput {
	taskId: string;
	agent: string;
	runId?: string;
}

export interface AgentFluxEphemeralActionResult {
	agent: string;
	action: "stop" | "retry";
	status: string;
	taskId?: string;
	executionId?: string;
	runId?: string;
	result?: ParallelRunResult;
}

export interface AgentFluxPersistentRunInput {
	agent: string;
	task?: string;
	taskId?: string;
}

export interface AgentFluxPersistentActionResult {
	agent: string;
	action: "run" | "wake" | "retry" | "stop" | "archive";
	status: string;
	result?: Awaited<ReturnType<typeof runPersistentAgent>>;
}

export interface AgentFluxCreateGroupInput {
	name: string;
	members: string[];
}

export type AgentFluxCommunityActionInput =
	| { action: "create"; title: string; body?: string; acceptanceCriteria?: string[] }
	| { action: "comment"; issueId: string; body: string; agent?: string }
	| { action: "claim"; issueId: string; agent: string; scope: string }
	| { action: "submit"; issueId: string; claimId: string }
	| { action: "resolve"; issueId: string };

const activePersistentRuns = new Map<string, AbortController>();

function persistentRunKey(cwd: string, agent: string): string {
	return `${cwd.toLowerCase()}\0${agent.toLowerCase()}`;
}

function readPersistentCapabilityViews(cwd: string): AgentFluxPersistentCapabilityView[] {
	const fluxDir = join(cwd, ".agentflux");
	const modelsConfig = loadModelsConfig(cwd);
	const roles = loadAllRoles(cwd, modelsConfig);
	return listPersistentAgents(cwd).map(agent => {
		const role = roles.get(agent.role);
		const registered = loadRegisteredCapabilityOverride(fluxDir, agent.name);
		const effective = loadEffectiveCapabilitySnapshot(fluxDir, agent.name);
		const effectiveTools = effective?.effective.tools ?? role?.tools ?? [];
		const effectiveSkills = effective?.effective.skills ?? role?.skills ?? [];
		const effectiveMcp = effective?.effective.mcpServers ?? role?.mcpServers ?? [];
		const effectiveSessionId = effective
			? `${agent.sessionId}-cap-${createHash("sha256").update(JSON.stringify({
				tools: effectiveTools,
				skills: effectiveSkills,
				mcpServers: effectiveMcp,
			})).digest("hex").slice(0, 12)}`
			: undefined;
		return {
			agentName: agent.name,
			role: agent.role,
			model: role?.model ?? agent.model,
			provider: agent.provider,
			thinking: role?.thinking,
			tools: effectiveTools,
			skills: effectiveSkills,
			mcpServers: effectiveMcp,
			communicationEnabled: effective?.effective.communication.enabled ?? role?.communication?.enabled ?? true,
			capabilityGeneration: agent.capabilityGeneration,
			overrideRevision: registered?.revision ?? 0,
			sessionId: agent.sessionId,
			effectiveSessionId,
			cacheImpact: registered && registered.revision >= agent.capabilityGeneration ? "new_generation" : "stable",
		};
	});
}

function readWorkflowRunViews(
	fluxDir: string,
	tasks: ReturnType<typeof listTasks>,
): AgentFluxWorkflowRunView[] {
	const views: AgentFluxWorkflowRunView[] = [];
	for (const task of tasks) {
		if (task.workStyle !== "workflow") continue;
		const executionId = task.executionId ?? task.id;
		const runsDir = join(fluxDir, "runtime", "runs");
		if (!existsSync(runsDir)) continue;
		let checkpointPath: string;
		try {
			assertSafeOpaqueId(executionId, "executionId");
			checkpointPath = resolvePathInsideExistingRoot(runsDir, executionId, "checkpoint.json");
		} catch {
			continue;
		}
		if (!existsSync(checkpointPath)) continue;
		try {
			const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf-8")) as any;
			const nodes = (Array.isArray(checkpoint.taskResults) ? checkpoint.taskResults : [])
				.map((entry: any): AgentFluxWorkflowRunNodeView | null => {
					if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1]) return null;
					const result = entry[1];
					const subagent = result.subagentResult ?? {};
					const gate = result.gateResult;
					return {
						nodeId: entry[0],
						passed: result.passed === true,
						retryCount: Number(result.retryCount ?? 0),
						exitCode: Number(subagent.exitCode ?? -1),
						error: typeof subagent.errorMessage === "string" ? subagent.errorMessage : undefined,
						model: typeof subagent.model === "string" ? subagent.model : undefined,
						costUsd: Number(subagent.usage?.cost ?? 0),
						gate: gate ? {
							status: gate.status,
							passed: gate.passed === true,
							feedback: String(gate.feedback ?? ""),
							criteriaResults: Array.isArray(gate.criteriaResults) ? gate.criteriaResults : [],
							costUsd: Number(gate.gateCost ?? 0),
							model: typeof gate.gateModel === "string" ? gate.gateModel : undefined,
						} : null,
					};
				})
				.filter((node: AgentFluxWorkflowRunNodeView | null): node is AgentFluxWorkflowRunNodeView => !!node);
			views.push({
				taskId: task.id,
				executionId,
				status: checkpoint.status,
				completed: Array.isArray(checkpoint.completed) ? checkpoint.completed : [],
				failed: Array.isArray(checkpoint.failed) ? checkpoint.failed : [],
				totalCostUsd: Number(checkpoint.totalCost ?? 0),
				iterationCount: Number(checkpoint.iterationCount ?? 0),
				updatedAt: Number(checkpoint.timestamp ?? 0),
				artifactPaths: checkpoint.artifactPaths && typeof checkpoint.artifactPaths === "object"
					? checkpoint.artifactPaths
					: {},
				nodes,
			});
		} catch {}
	}
	return views;
}

export function readAgentFluxProject(cwd: string, options: { historyLimit?: number } = {}): AgentFluxProjectSnapshot {
	const config = loadConfig(cwd);
	const modelsConfig = loadModelsConfig(cwd);
	const fluxDir = join(cwd, ".agentflux");
	const historyLimit = Math.max(1, Math.min(1_000, Math.trunc(options.historyLimit ?? 200)));
	const messageBus = new MessageBus(fluxDir);
	reconcileStaleAgentRuns(fluxDir);
	const allMessages = messageBus.listEnvelopes();
	const messages = allMessages.slice(-historyLimit).map(envelope => ({
		envelope,
		deliveries: envelope.recipients
			.map(recipient => messageBus.getDelivery(envelope.id, recipient))
			.filter((delivery): delivery is NonNullable<typeof delivery> => !!delivery),
	}));
	const allTasks = listTasks(fluxDir);
	const allExecutions = listTaskExecutions(fluxDir);
	const allRuns = listAgentRuns(fluxDir);
	const tasks = allTasks.slice(0, historyLimit);
	return {
		config,
		warnings: validateConfig(config),
		roles: [...loadAllRoles(cwd, modelsConfig).values()],
		persistentAgents: listPersistentAgents(cwd),
		issues: listIssues(cwd),
		// Desktop must be able to resolve the exact frozen Workflow version
		// referenced by a historical task instead of silently showing latest.
		workflows: listWorkflowDefinitions(fluxDir, true),
		workflowRuns: readWorkflowRunViews(fluxDir, tasks),
		groups: new SharedBoard(fluxDir).listGroups(),
		tasks,
		executions: allExecutions.slice(0, historyLimit),
		runs: allRuns.slice(0, historyLimit),
		history: {
			limit: historyLimit,
			totalTasks: allTasks.length,
			totalExecutions: allExecutions.length,
			totalRuns: allRuns.length,
			truncated: allTasks.length > historyLimit
				|| allExecutions.length > historyLimit
				|| allRuns.length > historyLimit
				|| allMessages.length > historyLimit,
		},
		messages,
		persistentAgentCapabilities: readPersistentCapabilityViews(cwd),
	};
}

export function readAgentFluxTaskHistory(
	cwd: string,
	options: { sessionId?: string; offset?: number; limit?: number } = {},
): AgentFluxTaskHistoryPage {
	const offset = Math.max(0, Math.trunc(options.offset ?? 0));
	const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
	const allTasks = listTasks(join(cwd, ".agentflux"), options.sessionId);
	const tasks = allTasks.slice(offset, offset + limit);
	return {
		tasks,
		offset,
		limit,
		total: allTasks.length,
		nextOffset: offset + tasks.length < allTasks.length ? offset + tasks.length : undefined,
	};
}

export function readAgentFluxTaskDetail(cwd: string, taskId: string): AgentFluxTaskDetail {
	assertSafeOpaqueId(taskId, "taskId");
	const fluxDir = join(cwd, ".agentflux");
	const task = getTask(fluxDir, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	const messageBus = new MessageBus(fluxDir);
	const messages = messageBus.listEnvelopes()
		.filter(envelope => envelope.taskId === taskId)
		.map(envelope => ({
			envelope,
			deliveries: envelope.recipients
				.map(recipient => messageBus.getDelivery(envelope.id, recipient))
				.filter((delivery): delivery is NonNullable<typeof delivery> => !!delivery),
		}));
	return {
		task,
		executions: listTaskExecutions(fluxDir, taskId),
		runs: listAgentRuns(fluxDir, { taskId }),
		messages,
		workflowRun: readWorkflowRunViews(fluxDir, [task])[0],
	};
}

export function readAgentFluxEvents(cwd: string, cursor = 0, limit = 500): AgentFluxEventPage {
	const path = join(cwd, ".agentflux", "events.jsonl");
	if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("AgentFlux event cursor must be a non-negative integer");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error("AgentFlux event limit must be an integer between 1 and 5000");
	if (!existsSync(path)) return { events: [], nextCursor: 0, hasMore: false, invalidEvents: 0 };
	const size = statSync(path).size;
	const fd = openSync(path, "r");
	const events: FluxEvent[] = [];
	let nextCursor = 0;
	let invalidEvents = 0;
	let fileOffset = 0;
	let carry = "";
	let hasMore = false;
	const chunk = Buffer.allocUnsafe(64 * 1024);
	try {
		while (fileOffset < size) {
			const bytesRead = readSync(fd, chunk, 0, chunk.length, fileOffset);
			if (bytesRead <= 0) break;
			fileOffset += bytesRead;
			carry += chunk.toString("utf-8", 0, bytesRead);
			const lines = carry.split(/\r?\n/);
			carry = lines.pop() ?? "";
			for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
				const line = lines[lineIndex];
				if (!line) continue;
				if (nextCursor++ < cursor) continue;
				try { events.push(JSON.parse(line) as FluxEvent); }
				catch { invalidEvents++; }
				if (events.length + invalidEvents >= limit) {
					hasMore = lineIndex < lines.length - 1 || carry.trim().length > 0 || fileOffset < size;
					return { events, nextCursor, hasMore, invalidEvents };
				}
			}
		}
		if (carry.trim()) {
			if (nextCursor++ >= cursor) {
				try { events.push(JSON.parse(carry) as FluxEvent); }
				catch { invalidEvents++; }
			}
		}
	} finally {
		closeSync(fd);
	}
	return { events, nextCursor, hasMore, invalidEvents };
}

/**
 * 直接执行结构化 Team 清单，不经过主模型再次解释任务。
 * 供 Desktop、自动化测试和仓库维护使用；数组长度就是精确 Agent 数量。
 */
export async function runAgentFluxTeam(cwd: string, spec: AgentFluxTeamSpec): Promise<ParallelRunResult> {
	if (!Array.isArray(spec.tasks) || spec.tasks.length < 1 || spec.tasks.length > 5) {
		throw new Error("AgentFlux Team requires 1-5 exact tasks");
	}
	const names = new Set<string>();
	const config = loadConfig(cwd);
	const fluxDir = join(cwd, ".agentflux");
	const sessionId = spec.sessionId ?? "host-team";
	const taskId = spec.taskId ?? `task-${randomUUID()}`;
	const taskSummary = spec.task?.trim() || spec.tasks.map(item => `${item.name}: ${item.task}`).join("\n");
	const plan = createTaskExecutionPlan({
		taskId,
		task: taskSummary,
		workStyle: "team",
		selectedBy: "user",
		budget: config.budget,
	});
	const telemetry = new TelemetryWriter(fluxDir);
	registerTask(fluxDir, sessionId, plan, "running");
	telemetry.writeTaskExecution({
		sessionId,
		taskId,
		executionId: plan.executionId,
		runId: plan.executionId,
		action: "created",
		workStyle: "team",
		selectedBy: "user",
		task: taskSummary,
		operation: "new",
	});
	telemetry.writeTaskExecution({
		sessionId,
		taskId,
		executionId: plan.executionId,
		runId: plan.executionId,
		action: "started",
		workStyle: "team",
		selectedBy: "user",
		task: taskSummary,
		operation: "new",
	});
	try {
		const modelsConfig = loadModelsConfig(cwd);
		const roles = loadAllRoles(cwd, modelsConfig);
		const sharedSkills = resolveSharedSkills(config, modelsConfig);
		const tasks = spec.tasks.map(item => {
			if (!item.name.trim() || names.has(item.name)) throw new Error(`Invalid or duplicate Agent name: ${item.name}`);
			names.add(item.name);
			if (!item.task.trim()) throw new Error(`Agent task is empty: ${item.name}`);
			const role = roles.get(item.role);
			if (!role) throw new Error(`Unknown Agent template: ${item.role}`);
			const runtime = resolveAgentFluxTeamTaskRuntime(spec, item, {
				model: role.model,
				provider: role.model ? modelsConfig.models?.[role.model]?.provider : undefined,
				thinking: role.thinking,
			});
			const { model, provider, thinking, maxTurns, maxInputTokens } = runtime;
			const agent: AgentTemplate = {
				name: item.name,
				role: item.role,
				description: role.description ?? item.role,
				model,
				provider,
				tools: role.tools,
				skills: [...new Set([...sharedSkills, ...(role.skills ?? [])])],
				mcpServers: role.mcpServers,
				workspace: role.workspace,
				systemPrompt: role.systemPrompt ?? `You are the ${item.role} Agent.`,
				thinking,
				communication: role.communication,
			};
			const baseTask = spec.executionProfile === "low_cost_test"
				? `${item.task}\n\nKeep analysis and response concise. Do not inspect unrelated files.`
				: item.task;
			const task = spec.allowCommits
				? baseTask
				: `${baseTask}\n\nDo not create a git commit. Leave all changes in the working tree for the caller to inspect.`;
			return {
				agent, task, label: item.name,
				workspaceCwd: item.workspace,
				lockFiles: item.lockFiles,
				model,
				provider,
				thinking,
				maxTurns,
				maxInputTokens,
				completionProof: item.completionProof,
			};
		});
		updateTaskMetadata(fluxDir, taskId, {
			team: spec.tasks.map(item => ({ name: item.name, role: item.role, persistent: false })),
		});
		const result = await runAgentsParallel(tasks, {
			cwd,
			sessionId,
			taskId,
			executionId: plan.executionId,
			telemetry,
			prefixLayout: config.cache.prefix_layout === "static_first",
			timeoutMs: config.budget.max_wall_clock_seconds * 1000,
			maxRetries: spec.executionProfile === "low_cost_test"
				? 0
				: Math.max(0, Math.trunc(spec.maxRetries ?? 0)),
			maxCostUsd: config.budget.max_cost_per_task,
		});
		const status = resolveAgentFluxTeamStatus(result);
		updateTaskStatus(fluxDir, taskId, status, {
			executionId: plan.executionId,
			costUsd: result.totalCost,
			outcome: {
				status: status === "completed" ? "success" : status === "cancelled" ? "cancelled" : status === "timed_out" ? "timeout" : "failure",
				error: result.errors.join("; ").slice(0, 500) || undefined,
			},
		});
		telemetry.writeTaskExecution({
			sessionId,
			taskId,
			executionId: plan.executionId,
			runId: plan.executionId,
			action: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed",
			workStyle: "team",
			selectedBy: "user",
			task: taskSummary,
			operation: "new",
			outcome: {
				status: status === "completed" ? "success" : status === "cancelled" ? "cancelled" : status === "timed_out" ? "timeout" : "failure",
				success: status === "completed",
				error: result.errors.join("; ").slice(0, 500) || undefined,
			},
		});
		return result;
	} catch (error: any) {
		updateTaskStatus(fluxDir, taskId, "failed", {
			executionId: plan.executionId,
			outcome: { status: "failure", error: String(error?.message ?? error).slice(0, 500) },
		});
		telemetry.writeTaskExecution({
			sessionId,
			taskId,
			executionId: plan.executionId,
			runId: plan.executionId,
			action: "failed",
			workStyle: "team",
			selectedBy: "user",
			task: taskSummary,
			operation: "new",
			outcome: {
				status: "failure",
				success: false,
				error: String(error?.message ?? error).slice(0, 500),
			},
		});
		throw error;
	}
}

export {
	archivePersistentAgent,
	claimIssue,
	commentOnIssue,
	createIssue,
	getIssue,
	listIssues,
	listPersistentAgents,
	listWorkflowDefinitions,
	registerPersistentAgent,
	resolveIssue,
	submitClaim,
};

export function sendAgentMessage(cwd: string, input: AgentFluxSendMessageInput): AgentFluxSendMessageResult {
	const fluxDir = join(cwd, ".agentflux");
	const telemetry = new TelemetryWriter(fluxDir);
	if (!input.taskId.trim()) throw new Error("AgentFlux message requires taskId");
	try {
		const result = new MessageBus(fluxDir).sendDirect("operator", input.target, "message", input.content, {
			taskId: input.taskId,
			priority: input.priority ?? "high",
			senderInstanceId: "desktop-operator",
		});
		telemetry.writeMessageProtocol({
			sessionId: "desktop-operator",
			taskId: input.taskId,
			action: "send",
			agent: "operator",
			instanceId: "desktop-operator",
			messageId: result.envelope.id,
			target: input.target,
			result: "success",
			content: input.content,
			deliveryStatus: result.deliveries[0]?.status,
			priority: result.envelope.priority,
			detail: result.deduplicated ? "deduplicated" : undefined,
		});
		return result;
	} catch (error: any) {
		telemetry.writeMessageProtocol({
			sessionId: "desktop-operator",
			taskId: input.taskId,
			action: "send",
			agent: "operator",
			instanceId: "desktop-operator",
			target: input.target,
			result: "failure",
			content: input.content,
			priority: input.priority ?? "high",
			detail: String(error?.message ?? error).slice(0, 500),
		});
		throw error;
	}
}

export function sendAgentGroupMessage(cwd: string, input: AgentFluxSendGroupMessageInput): AgentFluxSendMessageResult {
	const fluxDir = join(cwd, ".agentflux");
	if (!input.taskId.trim()) throw new Error("AgentFlux group message requires taskId");
	return new MessageBus(fluxDir).sendGroup("main", input.groupId, "message", input.content, {
		taskId: input.taskId,
		priority: input.priority ?? "high",
		senderInstanceId: "desktop-operator",
	});
}

export function acknowledgeAgentMessage(cwd: string, agent: string, messageId: string) {
	const fluxDir = join(cwd, ".agentflux");
	const delivery = new MessageBus(fluxDir).acknowledge(agent, messageId);
	new TelemetryWriter(fluxDir).writeMessageProtocol({
		sessionId: "desktop-operator",
		taskId: undefined,
		action: "ack",
		agent,
		instanceId: "desktop-operator",
		messageId,
		result: "success",
		deliveryStatus: delivery.status,
	});
	return delivery;
}

export function pollAgentInbox(cwd: string, input: AgentFluxInboxInput = {}): DeliveredMessageV2[] {
	const fluxDir = join(cwd, ".agentflux");
	const recipient = input.recipient?.trim() || "main";
	const messages = new MessageBus(fluxDir).poll(recipient, {
		limit: Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20))),
	});
	const telemetry = new TelemetryWriter(fluxDir);
	for (const item of messages) {
		telemetry.writeMessageProtocol({
			sessionId: "desktop-operator",
			taskId: item.envelope.taskId,
			action: "poll",
			agent: recipient,
			instanceId: "desktop-operator",
			messageId: item.envelope.id,
			result: "success",
			deliveryStatus: item.delivery.status,
		});
	}
	return messages;
}

function latestEphemeralRun(
	cwd: string,
	input: AgentFluxEphemeralActionInput,
): ReturnType<typeof listAgentRuns>[number] | undefined {
	const fluxDir = join(cwd, ".agentflux");
	if (input.runId) {
		const run = getAgentRun(fluxDir, input.runId);
		return run?.kind === "ephemeral"
			&& run.taskId === input.taskId
			&& run.agent === input.agent
			? run
			: undefined;
	}
	return listAgentRuns(fluxDir, { taskId: input.taskId, agent: input.agent })
		.find(run => run.kind === "ephemeral");
}

export function stopEphemeralAgent(cwd: string, input: AgentFluxEphemeralActionInput): AgentFluxEphemeralActionResult {
	const run = latestEphemeralRun(cwd, input);
	if (!run || !["starting", "running"].includes(run.status)) {
		throw new Error(`Running Ephemeral Agent not found: ${input.agent}`);
	}
	requestAgentRunStop(cwd, run.id);
	markAgentRunStopRequested(join(cwd, ".agentflux"), run.id);
	return { agent: input.agent, action: "stop", status: "stop_requested", runId: run.id };
}

export async function retryEphemeralAgent(
	cwd: string,
	input: AgentFluxEphemeralActionInput,
): Promise<AgentFluxEphemeralActionResult> {
	const task = getTask(join(cwd, ".agentflux"), input.taskId);
	if (!task) throw new Error(`Task not found: ${input.taskId}`);
	if (task.workStyle !== "team") throw new Error("Ephemeral retry is only available for Team tasks");
	const previousRun = latestEphemeralRun(cwd, input);
	if (!previousRun || !["failed", "cancelled", "timed_out"].includes(previousRun.status)) {
		throw new Error(`Retryable Ephemeral Agent not found: ${input.agent}`);
	}
	const modelsConfig = loadModelsConfig(cwd);
	const role = loadAllRoles(cwd, modelsConfig).get(previousRun.role);
	if (!role) throw new Error(`Agent role is unavailable: ${input.agent}`);
	const config = loadConfig(cwd);
	const fluxDir = join(cwd, ".agentflux");
	const retryPlan = createTaskExecutionPlan({
		task: previousRun.currentTask || task.task,
		workStyle: "team",
		selectedBy: "user",
		budget: config.budget,
		operation: "retry",
		parentTaskId: task.id,
		parentExecutionId: task.executionId,
	});
	registerTask(fluxDir, task.sessionId, retryPlan, "running");
	updateTaskMetadata(fluxDir, retryPlan.taskId, {
		team: [{ name: input.agent, role: previousRun.role, persistent: false }],
	});
	const telemetry = new TelemetryWriter(fluxDir);
	telemetry.writeTaskExecution({
		sessionId: task.sessionId,
		taskId: retryPlan.taskId,
		executionId: retryPlan.executionId,
		parentTaskId: retryPlan.parentTaskId,
		parentExecutionId: retryPlan.parentExecutionId,
		runId: retryPlan.executionId,
		action: "started",
		workStyle: "team",
		selectedBy: "user",
		task: retryPlan.task,
		operation: "retry",
	});
	const model = previousRun.model ?? role.model;
	const agent: AgentTemplate = {
		name: input.agent,
		role: previousRun.role,
		description: role.description ?? previousRun.role,
		model,
		provider: model ? modelsConfig.models?.[model]?.provider : undefined,
		tools: role.tools,
		skills: [...new Set([...resolveSharedSkills(config, modelsConfig), ...(role.skills ?? [])])],
		mcpServers: role.mcpServers,
		workspace: role.workspace,
		systemPrompt: role.systemPrompt ?? `You are the ${previousRun.role} Agent.`,
		thinking: role.thinking,
		communication: role.communication,
	};
	let result: ParallelRunResult;
	try {
		result = await runAgentsParallel([{
			agent,
			task: retryPlan.task,
			label: input.agent,
			model,
			provider: agent.provider,
			thinking: role.thinking,
		}], {
			cwd,
			sessionId: task.sessionId,
			taskId: retryPlan.taskId,
			executionId: retryPlan.executionId,
			telemetry,
			prefixLayout: config.cache.prefix_layout === "static_first",
			timeoutMs: config.budget.max_wall_clock_seconds * 1000,
			maxRetries: 0,
			maxCostUsd: config.budget.max_cost_per_task,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		updateTaskStatus(fluxDir, retryPlan.taskId, "failed", {
			executionId: retryPlan.executionId,
			outcome: { status: "failure", error: message.slice(0, 500) },
		});
		telemetry.writeTaskExecution({
			sessionId: task.sessionId,
			taskId: retryPlan.taskId,
			executionId: retryPlan.executionId,
			parentTaskId: retryPlan.parentTaskId,
			parentExecutionId: retryPlan.parentExecutionId,
			runId: retryPlan.executionId,
			action: "failed",
			workStyle: "team",
			selectedBy: "user",
			task: retryPlan.task,
			operation: "retry",
			outcome: { status: "failure", success: false, error: message.slice(0, 500) },
		});
		throw error;
	}
	const status = result.allSucceeded ? "completed" : "failed";
	updateTaskStatus(fluxDir, retryPlan.taskId, status, {
		executionId: retryPlan.executionId,
		costUsd: result.totalCost,
		outcome: {
			status: result.allSucceeded ? "success" : "failure",
			error: result.errors.join("; ").slice(0, 500) || undefined,
		},
	});
	telemetry.writeTaskExecution({
		sessionId: task.sessionId,
		taskId: retryPlan.taskId,
		executionId: retryPlan.executionId,
		parentTaskId: retryPlan.parentTaskId,
		parentExecutionId: retryPlan.parentExecutionId,
		runId: retryPlan.executionId,
		action: result.allSucceeded ? "completed" : "failed",
		workStyle: "team",
		selectedBy: "user",
		task: retryPlan.task,
		operation: "retry",
		outcome: {
			status: result.allSucceeded ? "success" : "failure",
			success: result.allSucceeded,
			error: result.errors.join("; ").slice(0, 500) || undefined,
		},
	});
	return {
		agent: input.agent,
		action: "retry",
		status,
		taskId: retryPlan.taskId,
		executionId: retryPlan.executionId,
		result,
	};
}

async function executePersistentRun(
	cwd: string,
	action: "run" | "wake" | "retry",
	input: AgentFluxPersistentRunInput,
): Promise<AgentFluxPersistentActionResult> {
	const agent = listPersistentAgents(cwd).find(item => item.name === input.agent && item.status !== "archived");
	if (!agent) throw new Error(`Persistent Agent not found: ${input.agent}`);
	const task = action === "retry"
		? agent.lastTask
		: input.task?.trim() || (action === "wake" ? "Process your AgentFlux inbox and report the result briefly." : undefined);
	if (!task) throw new Error(`${action} requires a task`);
	const fluxDir = join(cwd, ".agentflux");
	const taskId = input.taskId?.trim() || `task-${randomUUID()}`;
	const sessionId = `desktop-persistent-${agent.name}`;
	const parent = action === "retry" ? listTasks(fluxDir, sessionId)[0] : undefined;
	const key = persistentRunKey(cwd, agent.name);
	if (activePersistentRuns.has(key)) throw new Error(`Persistent Agent is already running: ${agent.name}`);
	const config = loadConfig(cwd);
	const modelsConfig = loadModelsConfig(cwd);
	const controller = new AbortController();
	activePersistentRuns.set(key, controller);
	const plan = createTaskExecutionPlan({
		taskId,
		task,
		workStyle: "team",
		selectedBy: "user",
		operation: action === "retry" ? "retry" : "new",
		parentTaskId: parent?.id,
		parentExecutionId: parent?.executionId,
		budget: config.budget,
	});
	registerTask(fluxDir, sessionId, plan, "running");
	updateTaskMetadata(fluxDir, taskId, {
		team: [{ name: agent.name, role: agent.role, persistent: true }],
	});
	try {
		const pricing = await loadPricing(fluxDir, config.pricing, agent.model);
		const result = await runPersistentAgent(agent.name, task, {
			cwd,
			modelsConfig,
			telemetry: new TelemetryWriter(fluxDir),
			pricing,
			sessionId,
			taskId,
			executionId: plan.executionId,
			sharedSkills: resolveSharedSkills(config, modelsConfig),
			prefixLayout: config.cache.prefix_layout === "static_first",
			timeoutMs: config.budget.max_wall_clock_seconds * 1000,
			maxCostUsd: config.budget.max_cost_per_task,
		}, controller.signal);
		updateTaskStatus(fluxDir, taskId, result.exitCode === 0 ? "completed" : result.exitCode === 130 ? "cancelled" : "failed");
		return { agent: agent.name, action, status: result.exitCode === 0 ? "idle" : "failed", result };
	} catch (error) {
		updateTaskStatus(fluxDir, taskId, controller.signal.aborted ? "cancelled" : "failed");
		throw error;
	} finally {
		activePersistentRuns.delete(key);
	}
}

export function runPersistentAgentFromHost(cwd: string, input: AgentFluxPersistentRunInput) {
	return executePersistentRun(cwd, "run", input);
}

export function wakePersistentAgent(cwd: string, input: AgentFluxPersistentRunInput) {
	return executePersistentRun(cwd, "wake", input);
}

export function retryPersistentAgent(cwd: string, input: AgentFluxPersistentRunInput) {
	return executePersistentRun(cwd, "retry", input);
}

export function stopPersistentAgent(cwd: string, agent: string): AgentFluxPersistentActionResult {
	const controller = activePersistentRuns.get(persistentRunKey(cwd, agent));
	if (!controller) throw new Error(`Persistent Agent is not running: ${agent}`);
	controller.abort();
	return { agent, action: "stop", status: "cancelling" };
}

export function archivePersistentAgentFromHost(cwd: string, agent: string): AgentFluxPersistentActionResult {
	const record = archivePersistentAgent(cwd, agent);
	return { agent: record.name, action: "archive", status: record.status };
}

export function createAgentGroup(cwd: string, input: AgentFluxCreateGroupInput) {
	if (!input.name.trim() || input.members.length === 0) throw new Error("AgentFlux group requires a name and members");
	return new SharedBoard(join(cwd, ".agentflux")).createGroup(
		input.name.trim(),
		[...new Set(["main", ...input.members])],
		"team",
		"main",
	);
}

export function mutateCommunityIssue(cwd: string, input: AgentFluxCommunityActionInput) {
	if (input.action === "create") return createIssue(cwd, {
		title: input.title,
		description: input.body ?? "",
		acceptanceCriteria: input.acceptanceCriteria,
	});
	if (input.action === "comment") return commentOnIssue(cwd, input.issueId, input.agent ?? "operator", input.body);
	if (input.action === "claim") return claimIssue(cwd, input.issueId, input.agent, input.scope);
	if (input.action === "submit") return submitClaim(cwd, input.issueId, input.claimId);
	return resolveIssue(cwd, input.issueId);
}

export function runAgentFluxGc(cwd: string, options: LifecycleGcOptions) {
	const config = loadConfig(cwd);
	return runLifecycleGc(join(cwd, ".agentflux"), config.retention, options);
}
