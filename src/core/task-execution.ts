import { randomUUID } from "node:crypto";
import type { BudgetConfig } from "./types";
import { assertSafeOpaqueId } from "./safe-path";
import { normalizeOptionalSeconds } from "./deadline";

export type TaskOperation = "new" | "reuse" | "resume" | "continue" | "retry";

export interface TaskExecutionPlan {
	taskId: string;
	executionId: string;
	task: string;
	selectedBy: "user" | "main_agent";
	operation: TaskOperation;
	parentTaskId?: string;
	parentExecutionId?: string;
	/** Absolute deadline assigned when the execution starts; omitted means no hard deadline. */
	deadlineAt?: string;
	budget: {
		maxCostUsd: number;
		maxIterations: number;
		maxTurns?: number;
		maxInputTokens?: number;
		maxParallel?: number;
		maxWallClockMs?: number;
	};
}

export function createTaskExecutionPlan(input: {
	task: string;
	selectedBy: "user" | "main_agent";
	budget: BudgetConfig;
	taskId?: string;
	executionId?: string;
	operation?: TaskOperation;
	parentTaskId?: string;
	parentExecutionId?: string;
}): TaskExecutionPlan {
	const task = input.task.trim();
	if (!task) throw new Error("Task cannot be empty");
	if (input.budget.max_cost_per_task <= 0) throw new Error("Task budget must be greater than 0");
	const taskId = assertSafeOpaqueId(input.taskId ?? `task-${randomUUID()}`, "taskId");
	const parentTaskId = input.parentTaskId
		? assertSafeOpaqueId(input.parentTaskId, "parentTaskId")
		: undefined;
	const executionId = assertSafeOpaqueId(input.executionId ?? taskId, "executionId");
	const parentExecutionId = input.parentExecutionId
		? assertSafeOpaqueId(input.parentExecutionId, "parentExecutionId")
		: parentTaskId;
	return {
		taskId,
		executionId,
		task,
		selectedBy: input.selectedBy,
		operation: input.operation ?? "new",
		parentTaskId,
		parentExecutionId,
		budget: {
			maxCostUsd: input.budget.max_cost_per_task,
			maxIterations: Math.max(1, input.budget.max_iterations),
			maxTurns: input.budget.max_turns_per_task,
			maxInputTokens: input.budget.max_input_tokens_per_task,
			maxParallel: input.budget.max_parallel_agents,
			maxWallClockMs: normalizeOptionalSeconds(input.budget.max_wall_clock_seconds, "budget.max_wall_clock_seconds"),
		},
	};
}

/** 恢复重放原 Task 需求；不能让新提示正文悄悄替换 checkpoint 的执行语义。 */
export function resolvePreparedTaskText(operation: TaskOperation, sourceTask: string | undefined, explicitTask?: string, fallbackTask?: string): string {
	if (operation === "resume") {
		if (!sourceTask?.trim()) throw new Error("Resume requires a source task");
		if (explicitTask !== undefined && explicitTask.trim() !== sourceTask.trim()) {
			throw new Error("Resume cannot replace the source task; use new, continue or reuse for changed requirements");
		}
		return sourceTask.trim();
	}
	return explicitTask?.trim() || sourceTask || fallbackTask || "";
}

export function formatTaskExecutionPlan(plan: TaskExecutionPlan): string {
	return [
		`Task ${plan.taskId}`,
		`  execution ${plan.executionId} · operation ${plan.operation}${plan.parentExecutionId ? ` · parent execution ${plan.parentExecutionId}` : ""}`,
		`  selected by ${plan.selectedBy}`,
		`  budget $${plan.budget.maxCostUsd.toFixed(4)} · ${plan.budget.maxWallClockMs === undefined ? "no deadline" : `${Math.round(plan.budget.maxWallClockMs / 1000)}s`} · ${plan.budget.maxIterations} iterations${plan.budget.maxTurns === undefined ? "" : ` · ${plan.budget.maxTurns} turns`}${plan.budget.maxParallel === undefined ? "" : ` · ${plan.budget.maxParallel} parallel`}`,
	].join("\n");
}
