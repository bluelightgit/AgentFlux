import { join } from "node:path";
import { readJsonStore, updateJsonStore } from "./json-store";
import type { TaskOperation, TaskExecutionPlan } from "./task-execution";
import { assertSafeOpaqueId } from "./safe-path";

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
	resource?: { type: "issue" | "workflow"; id: string; version?: number };
	team?: Array<{ name: string; role?: string; persistent?: boolean }>;
	createdAt: string;
	updatedAt: string;
}

export interface TaskExecutionRecord {
	id: string;
	taskId: string;
	sessionId: string;
	operation: TaskOperation;
	parentTaskId?: string;
	parentExecutionId?: string;
	status: TaskStatus;
	budget?: TaskExecutionPlan["budget"];
	costUsd: number;
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

export function registerTask(fluxDir: string, sessionId: string, plan: TaskExecutionPlan, status: TaskStatus = "running"): TaskRecord {
	assertSafeOpaqueId(plan.taskId, "taskId");
	assertSafeOpaqueId(plan.executionId, "executionId");
	if (plan.parentTaskId) assertSafeOpaqueId(plan.parentTaskId, "parentTaskId");
	if (plan.parentExecutionId) assertSafeOpaqueId(plan.parentExecutionId, "parentExecutionId");
	return updateStore(fluxDir, store => {
		const now = new Date().toISOString();
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
			existing.task = plan.task;
			existing.selectedBy = plan.selectedBy;
			existing.operation = plan.operation;
			existing.parentTaskId = plan.parentTaskId;
			existing.parentExecutionId = plan.parentExecutionId;
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
			execution.operation = plan.operation;
			execution.parentTaskId = plan.parentTaskId;
			execution.parentExecutionId = plan.parentExecutionId;
			execution.status = status;
			execution.updatedAt = now;
		} else {
			store.executions.push({
				id: plan.executionId,
				taskId: plan.taskId,
				sessionId,
				operation: plan.operation,
				parentTaskId: plan.parentTaskId,
				parentExecutionId: plan.parentExecutionId,
				status,
				budget: structuredClone(plan.budget),
				costUsd: 0,
				createdAt: now,
				updatedAt: now,
			});
		}
		return store.tasks.find(task => task.id === plan.taskId)!;
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
		const now = new Date().toISOString();
		task.status = status;
		task.updatedAt = now;
		execution.status = status;
		execution.updatedAt = now;
		if (details.costUsd !== undefined) execution.costUsd = details.costUsd;
		if (details.usage) execution.usage = details.usage;
		if (details.outcome) execution.outcome = details.outcome;
		if (TERMINAL_STATUSES.has(status)) execution.finishedAt = now;
		return task;
	});
}

export function updateTaskMetadata(fluxDir: string, taskId: string, metadata: Pick<TaskRecord, "resource" | "team">): TaskRecord | undefined {
	return updateStore(fluxDir, store => {
		const task = store.tasks.find(item => item.id === taskId);
		if (!task) return undefined;
		if (TERMINAL_STATUSES.has(task.status)) {
			throw new Error(`Historical task is immutable: ${taskId} is ${task.status}`);
		}
		if (metadata.resource) task.resource = metadata.resource;
		if (metadata.team) task.team = metadata.team;
		task.updatedAt = new Date().toISOString();
		return task;
	});
}

export function formatTasks(tasks: TaskRecord[]): string {
	if (tasks.length === 0) return "No AgentFlux tasks.";
	return ["AgentFlux tasks:", ...tasks.map(task =>
		`  ${task.status.padEnd(9)} ${task.id} · ${task.operation}${task.parentTaskId ? ` ← ${task.parentTaskId}` : ""}${task.resource ? ` · ${task.resource.type}:${task.resource.id}${task.resource.version ? `@${task.resource.version}` : ""}` : ""}\n    ${task.task.slice(0, 160)}${task.team?.length ? `\n    team ${task.team.map(member => member.name).join(", ")}` : ""}`,
	)].join("\n");
}
