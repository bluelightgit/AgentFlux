import { randomUUID } from "node:crypto";
import type { BudgetConfig } from "./types";
import { assertSafeOpaqueId } from "./safe-path";

export type TaskOperation = "new" | "reuse" | "resume" | "continue" | "retry";

export interface TaskExecutionPlan {
	taskId: string;
	executionId: string;
	task: string;
	selectedBy: "user" | "main_agent";
	operation: TaskOperation;
	parentTaskId?: string;
	parentExecutionId?: string;
	budget: {
		maxCostUsd: number;
		maxIterations: number;
		maxWallClockMs: number;
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
			maxWallClockMs: Math.max(1000, input.budget.max_wall_clock_seconds * 1000),
		},
	};
}

export function formatTaskExecutionPlan(plan: TaskExecutionPlan): string {
	return [
		`Task ${plan.taskId}`,
		`  execution ${plan.executionId} · operation ${plan.operation}${plan.parentExecutionId ? ` · parent execution ${plan.parentExecutionId}` : ""}`,
		`  selected by ${plan.selectedBy}`,
		`  budget $${plan.budget.maxCostUsd.toFixed(4)} · ${Math.round(plan.budget.maxWallClockMs / 1000)}s · ${plan.budget.maxIterations} iterations`,
	].join("\n");
}
