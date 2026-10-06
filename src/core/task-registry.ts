import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJsonStore } from "./json-store";
import { updateReferenceStore as updateJsonStore } from "./agent-reference-fence";
import { assertAgentReference } from "./agent-reference-target";
import { dirname } from "node:path";
import type { TaskOperation, TaskExecutionPlan } from "./task-execution";
import { assertSafeOpaqueId } from "./safe-path";
import type { InvocationOutcome } from "./task-outcome";
import { withWorkflowReference } from "../workflows/workflow-registry";
import { getProcessIdentity, type ProcessIdentity } from "./process-identity";

export type TaskStatus = "created" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface TaskRecord {
	id: string;
	executionId: string;
	sessionId: string;
	task: string;
	selectedBy: "user" | "main_agent";
	operation: TaskOperation;
	parentTaskId?: string;
	parentExecutionId?: string;
	status: TaskStatus;
	/** Absolute execution deadline; absent means no hard wall-clock limit. */
	deadlineAt?: string;
	resource?: { type: "issue" | "workflow"; id: string; version?: number };
	/** 单次 Workflow 的显式执行正文；不重写活动父 Task 或重新分配预算。 */
	workflowRequest?: { task: string; action: "run" | "reuse" | "modify"; selector?: string };
	team?: Array<{ name: string; agentId?: string; role?: string; persistent?: boolean }>;
	createdAt: string;
	updatedAt: string;
}

export interface TaskExecutionRecord {
	id: string;
	taskId: string;
	/** PID of the Main/Workflow process that owns this execution while running. */
	ownerPid?: number;
	ownerIdentity?: ProcessIdentity;
	sessionId: string;
	operation: TaskOperation;
	parentTaskId?: string;
	parentExecutionId?: string;
	status: TaskStatus;
	/** Absolute execution deadline; absent means no hard wall-clock limit. */
	deadlineAt?: string;
	budget?: TaskExecutionPlan["budget"];
	costUsd: number;
	/** 工具调用终态回执；同一 toolCallId 幂等，不另建执行器/账本。 */
	invocationOutcomes?: Array<InvocationOutcome & { id: string }>;
	/** complete 仅表示本地回执齐全，不证明 Provider 价格正确。 */
	costAccounting?: { mainCostUsd: number; invocationCostUsd: number; complete: boolean; attributionComplete?: boolean; provisional?: boolean };
	/** Main 会话侧逐轮累计 usage（turn_end 从 pi message_end 读取） */
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		costUsd: number;
		model?: string;
	};
	outcome?: {
		status: "success" | "failure" | "partial" | "cancelled" | "timeout" | "unknown";
		error?: string;
	};
	createdAt: string;
	updatedAt: string;
	finishedAt?: string;
}

interface TaskStore { version: 2; tasks: TaskRecord[]; executions: TaskExecutionRecord[]; }
interface LegacyTaskStore { version: 1; tasks: Array<Omit<TaskRecord, "executionId"> & { executionId?: string }>; }

function storePath(fluxDir: string): string { return join(fluxDir, "runtime", "tasks.json"); }
const createStore = (): TaskStore => ({ version: 2, tasks: [], executions: [] });
const isStoredValue = (value: unknown): value is TaskStore | LegacyTaskStore => {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { version?: unknown; tasks?: unknown; executions?: unknown };
	return (candidate.version === 1 || candidate.version === 2)
		&& Array.isArray(candidate.tasks)
		&& (candidate.version === 1 || Array.isArray(candidate.executions));
};

function normalizeStore(value: TaskStore | LegacyTaskStore): TaskStore {
	const tasks = value.tasks.map(task => ({
		...task,
		executionId: task.executionId ?? task.id,
		operation: task.operation ?? "new",
	})) as TaskRecord[];
	if (value.version === 2) return { version: 2, tasks, executions: value.executions };
	return {
		version: 2,
		tasks,
		executions: tasks.map(task => ({
			id: task.executionId,
			taskId: task.id,
			sessionId: task.sessionId,
			operation: task.operation,
			parentTaskId: task.parentTaskId,
			parentExecutionId: task.parentExecutionId ?? task.parentTaskId,
			status: task.status,
			deadlineAt: task.deadlineAt,
			costUsd: 0,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			finishedAt: ["completed", "failed", "cancelled", "timed_out"].includes(task.status) ? task.updatedAt : undefined,
		})),
	};
}

function readStore(fluxDir: string): TaskStore {
	return normalizeStore(readJsonStore(storePath(fluxDir), createStore, isStoredValue));
}

function updateStore<R>(fluxDir: string, update: (store: TaskStore) => R): R {
	return updateJsonStore<TaskStore | LegacyTaskStore, R>(
		storePath(fluxDir),
		createStore,
		isStoredValue,
		rawStore => {
			const store = normalizeStore(rawStore);
			Object.assign(rawStore, store);
			return update(rawStore as TaskStore);
		},
	);
}

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled", "timed_out"]);

export function listTasks(fluxDir: string, sessionId?: string): TaskRecord[] {
	return readStore(fluxDir).tasks.slice().reverse()
		.filter(task => !sessionId || task.sessionId === sessionId)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getTask(fluxDir: string, taskId: string): TaskRecord | undefined {
	return readStore(fluxDir).tasks.find(task => task.id === taskId);
}

export function listTaskExecutions(fluxDir: string, taskId?: string): TaskExecutionRecord[] {
	return readStore(fluxDir).executions
		.filter(execution => !taskId || execution.taskId === taskId)
		.slice()
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getTaskExecution(fluxDir: string, executionId: string): TaskExecutionRecord | undefined {
	return readStore(fluxDir).executions.find(execution => execution.id === executionId);
}

export function resolveTask(fluxDir: string, selector: string | undefined, sessionId: string): TaskRecord | undefined {
	const tasks = listTasks(fluxDir, sessionId);
	if (!selector || selector === "latest") return tasks[0];
	return tasks.find(task => task.id === selector);
}

export function registerTask(
	fluxDir: string,
	sessionId: string,
	plan: TaskExecutionPlan,
	status: TaskStatus = "running",
	options: { ownerPid?: number } = {},
): TaskRecord {
	assertSafeOpaqueId(plan.taskId, "taskId");
	assertSafeOpaqueId(plan.executionId, "executionId");
	if (options.ownerPid !== undefined && (!Number.isInteger(options.ownerPid) || options.ownerPid <= 0)) {
		throw new Error("Task execution ownerPid must be a positive integer");
	}
	const ownerIdentity = options.ownerPid === undefined ? undefined : getProcessIdentity(options.ownerPid);
	if (plan.parentTaskId) assertSafeOpaqueId(plan.parentTaskId, "parentTaskId");
	if (plan.parentExecutionId) assertSafeOpaqueId(plan.parentExecutionId, "parentExecutionId");
	return updateStore(fluxDir, store => {
		const now = new Date().toISOString();
		const deadlineAt = plan.deadlineAt
			?? (plan.budget.maxWallClockMs === undefined ? undefined : new Date(Date.parse(now) + plan.budget.maxWallClockMs).toISOString());
		const existing = store.tasks.find(task => task.id === plan.taskId);
		if (existing) {
			if (TERMINAL_STATUSES.has(existing.status)) {
				if (existing.status !== status) {
					throw new Error(`Historical task is immutable: ${plan.taskId} is ${existing.status}`);
				}
				return existing;
			}
			if (existing.sessionId !== sessionId || existing.executionId !== plan.executionId) {
				throw new Error(`Task identity conflict: ${plan.taskId}`);
			}
			const priorOwner = store.executions.find(item => item.id === plan.executionId);
			if (options.ownerPid !== undefined && priorOwner?.ownerPid !== undefined
				&& (priorOwner.ownerPid !== options.ownerPid
					|| (priorOwner.ownerIdentity !== undefined && !isDeepStrictEqual(priorOwner.ownerIdentity, ownerIdentity)))) {
				throw new Error(`Task execution process owner is immutable: ${plan.executionId}`);
			}
			existing.task = plan.task;
			existing.selectedBy = plan.selectedBy;
			existing.operation = plan.operation;
			existing.parentTaskId = plan.parentTaskId;
			existing.parentExecutionId = plan.parentExecutionId;
			if (existing.deadlineAt === undefined) existing.deadlineAt = deadlineAt;
			existing.status = status;
			existing.updatedAt = now;
		} else {
			const record: TaskRecord = {
				id: plan.taskId,
				executionId: plan.executionId,
				sessionId,
				task: plan.task,
				selectedBy: plan.selectedBy,
				operation: plan.operation,
				parentTaskId: plan.parentTaskId,
				parentExecutionId: plan.parentExecutionId,
				status,
				deadlineAt,
				createdAt: now,
				updatedAt: now,
			};
			store.tasks.push(record);
		}
		const execution = store.executions.find(item => item.id === plan.executionId);
		if (execution) {
			if (execution.taskId !== plan.taskId || execution.sessionId !== sessionId) {
				throw new Error(`Execution identity conflict: ${plan.executionId}`);
			}
			if (TERMINAL_STATUSES.has(execution.status) && execution.status !== status) {
				throw new Error(`Historical execution is immutable: ${plan.executionId} is ${execution.status}`);
			}
			if (execution.ownerPid === undefined && options.ownerPid !== undefined) {
				execution.ownerPid = options.ownerPid;
				execution.ownerIdentity = ownerIdentity;
			}
			execution.operation = plan.operation;
			execution.parentTaskId = plan.parentTaskId;
			execution.parentExecutionId = plan.parentExecutionId;
			if (execution.deadlineAt === undefined) execution.deadlineAt = deadlineAt;
			if (execution.budget === undefined) execution.budget = structuredClone(plan.budget);
			execution.status = status;
			execution.updatedAt = now;
		} else {
			store.executions.push({
				id: plan.executionId,
				taskId: plan.taskId,
				sessionId,
				ownerPid: options.ownerPid,
				ownerIdentity,
				operation: plan.operation,
				parentTaskId: plan.parentTaskId,
				parentExecutionId: plan.parentExecutionId,
				status,
				deadlineAt,
				budget: structuredClone(plan.budget),
				costUsd: 0,
				createdAt: now,
				updatedAt: now,
			});
		}
		return store.tasks.find(task => task.id === plan.taskId)!;
	});
}

/** Main 在线绝对快照；历史终态不回写，预算读取与子 Run 共享同一 Execution 事实。 */
export function updateTaskMainUsage(fluxDir: string, taskId: string, usage: NonNullable<TaskExecutionRecord["usage"]>, coverage?: { complete: boolean; attributionComplete: boolean; provisional: boolean }): boolean {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "costUsd"] as const) {
		if (!Number.isFinite(usage[key]) || usage[key] < 0) throw new Error(`Invalid Main usage ${key}`);
	}
	return updateStore(fluxDir, store => {
		const task = store.tasks.find(item => item.id === taskId);
		const execution = task ? store.executions.find(item => item.id === task.executionId) : undefined;
		if (!task || !execution || TERMINAL_STATUSES.has(task.status) || TERMINAL_STATUSES.has(execution.status)) return false;
		execution.usage = { ...usage };
		execution.costUsd = usage.costUsd + (execution.invocationOutcomes ?? []).reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
		if (coverage) {
			const invocations = execution.invocationOutcomes ?? [];
			execution.costAccounting = { mainCostUsd: usage.costUsd, invocationCostUsd: invocations.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
				complete: coverage.complete && invocations.every(item => item.costUsd !== undefined && item.costComplete === true),
				attributionComplete: coverage.attributionComplete && invocations.every(item => item.attributionComplete === true), provisional: coverage.provisional };
		}
		execution.updatedAt = task.updatedAt = new Date().toISOString();
		return true;
	});
}

export function updateTaskStatus(
	fluxDir: string,
	taskId: string,
	status: TaskStatus,
	details: {
		executionId?: string;
		costUsd?: number;
		usage?: TaskExecutionRecord["usage"];
		costAccounting?: TaskExecutionRecord["costAccounting"];
		outcome?: TaskExecutionRecord["outcome"];
	} = {},
): TaskRecord | undefined {
	return updateStore(fluxDir, store => {
		const task = store.tasks.find(item => item.id === taskId);
		if (!task) return undefined;
		if (TERMINAL_STATUSES.has(task.status) && task.status !== status) {
			throw new Error(`Historical task is immutable: ${taskId} is ${task.status}`);
		}
		const executionId = details.executionId ?? task.executionId;
		const execution = store.executions.find(item => item.id === executionId);
		if (!execution) throw new Error(`Execution not found: ${executionId}`);
		if (execution.taskId !== taskId) throw new Error(`Execution ${executionId} does not belong to task ${taskId}`);
		if (TERMINAL_STATUSES.has(execution.status) && execution.status !== status) {
			throw new Error(`Historical execution is immutable: ${executionId} is ${execution.status}`);
		}
		if (TERMINAL_STATUSES.has(task.status) || TERMINAL_STATUSES.has(execution.status)) {
			const same = (value: unknown, stored: unknown) => value === undefined
				|| isDeepStrictEqual(JSON.parse(JSON.stringify(value)), stored);
			if (task.status !== status || execution.status !== status
				|| !same(details.costUsd, execution.costUsd) || !same(details.usage, execution.usage)
				|| !same(details.costAccounting, execution.costAccounting)
				|| !same(details.outcome, execution.outcome)) {
				throw new Error(`Historical execution is immutable: ${executionId} terminal facts differ`);
			}
			return task; // 相同事实幂等重放，不刷新终态时间。
		}
		const now = new Date().toISOString();
		task.status = status;
		task.updatedAt = now;
		execution.status = status;
		execution.updatedAt = now;
		if (details.costUsd !== undefined) execution.costUsd = details.costUsd;
		if (details.usage) execution.usage = details.usage;
		if (details.costAccounting) execution.costAccounting = details.costAccounting;
		if (details.outcome) execution.outcome = details.outcome;
		if (TERMINAL_STATUSES.has(status)) execution.finishedAt = now;
		return task;
	});
}

export function recordTaskInvocationOutcome(fluxDir: string, taskId: string, id: string, outcome: InvocationOutcome): void {
	updateStore(fluxDir, store => {
		const task = store.tasks.find(item => item.id === taskId);
		const execution = store.executions.find(item => item.id === task?.executionId);
		if (!task || !execution) throw new Error(`Task invocation parent missing: ${taskId}`);
		const record = JSON.parse(JSON.stringify({ id, action: outcome.action, status: outcome.status, error: outcome.error, costUsd: outcome.costUsd, costComplete: outcome.costComplete, attributionComplete: outcome.attributionComplete }));
		if (typeof id !== "string" || !id.trim() || !["success", "failure", "cancelled", "timeout"].includes(record.status)
			|| (record.costComplete !== undefined && typeof record.costComplete !== "boolean")
			|| (record.attributionComplete !== undefined && typeof record.attributionComplete !== "boolean")
			|| (record.error !== undefined && typeof record.error !== "string")
			|| record.action !== (record.status === "success" ? "completed" : record.status === "cancelled" ? "cancelled" : "failed")
			|| (record.costUsd !== undefined && (!Number.isFinite(record.costUsd) || record.costUsd < 0))) throw new Error("Invalid invocation outcome");
		const previous = execution.invocationOutcomes?.find(item => item.id === id);
		if (previous) {
			if (!isDeepStrictEqual(previous, record)) throw new Error(`Invocation outcome is immutable: ${id}`);
			return;
		}
		if (TERMINAL_STATUSES.has(task.status) || TERMINAL_STATUSES.has(execution.status)) throw new Error(`Historical execution is immutable: ${execution.id}`);
		(execution.invocationOutcomes ??= []).push(record);
	});
}

export function updateTaskMetadata(fluxDir: string, taskId: string, metadata: Pick<TaskRecord, "resource" | "team" | "workflowRequest">): TaskRecord | undefined {
	if (metadata.resource?.type === "workflow") return withWorkflowReference(fluxDir, metadata.resource, () => updateTaskMetadataInternal(fluxDir, taskId, metadata));
	return updateTaskMetadataInternal(fluxDir, taskId, metadata);
}

function updateTaskMetadataInternal(fluxDir: string, taskId: string, metadata: Pick<TaskRecord, "resource" | "team" | "workflowRequest">): TaskRecord | undefined {
	return updateStore(fluxDir, store => {
		const task = store.tasks.find(item => item.id === taskId);
		if (!task) return undefined;
		if (TERMINAL_STATUSES.has(task.status)) {
			throw new Error(`Historical task is immutable: ${taskId} is ${task.status}`);
		}
		if (metadata.workflowRequest) {
			const request = JSON.parse(JSON.stringify(metadata.workflowRequest));
			if (!request.task?.trim() || !["run", "reuse", "modify"].includes(request.action)) throw new Error("Invalid Workflow request");
			if (task.workflowRequest && !isDeepStrictEqual(task.workflowRequest, request)) throw new Error("Workflow request is immutable for this invocation");
			task.workflowRequest = request;
		}
		if (metadata.resource) {
			if (task.resource?.type === "workflow" && !isDeepStrictEqual(task.resource, metadata.resource)) throw new Error("Active Workflow binding cannot be replaced");
			task.resource = metadata.resource;
		}
		if (metadata.team) task.team = metadata.team.map(member => {
			if (member.agentId === undefined) return { ...member }; // 兼容逻辑队员；persistent 并非注册身份的证明。
			const agent = assertAgentReference(dirname(fluxDir), member.agentId, task.sessionId);
			return { ...member, name: agent.name };
		});
		task.updatedAt = new Date().toISOString();
		return task;
	});
}

export function formatTasks(tasks: TaskRecord[]): string {
	if (tasks.length === 0) return "No AgentFlux tasks.";
	return ["AgentFlux tasks:", ...tasks.map(task =>
		`  ${task.status.padEnd(9)} ${task.id} · ${task.operation}${task.parentTaskId ? ` ← ${task.parentTaskId}` : ""}${task.resource ? ` · ${task.resource.type}:${task.resource.id}${task.resource.version ? `@${task.resource.version}` : ""}` : ""}${task.deadlineAt ? ` · deadline ${task.deadlineAt}` : ""}\n    ${task.task.slice(0, 160)}${task.team?.length ? `\n    team ${task.team.map(member => member.name).join(", ")}` : ""}`,
	)].join("\n");
}
