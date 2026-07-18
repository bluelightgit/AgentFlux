import { randomUUID } from "node:crypto";
import type { BudgetConfig, WorkStyle } from "./types";

export interface TaskExecutionPlan {
	taskId: string;
	task: string;
	workStyle: WorkStyle;
	selectedBy: "user" | "main_agent";
	budget: {
		maxCostUsd: number;
		maxIterations: number;
		maxWallClockMs: number;
	};
}

export function createTaskExecutionPlan(input: {
	task: string;
	workStyle: WorkStyle;
	selectedBy: "user" | "main_agent";
	budget: BudgetConfig;
	taskId?: string;
}): TaskExecutionPlan {
	const task = input.task.trim();
	if (!task) throw new Error("Task cannot be empty");
	if (input.budget.max_cost_per_task <= 0) throw new Error("Task budget must be greater than 0");
	return {
		taskId: input.taskId ?? `task-${randomUUID()}`,
		task,
		workStyle: input.workStyle,
		selectedBy: input.selectedBy,
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
		`  work style ${plan.workStyle} · selected by ${plan.selectedBy}`,
		`  budget $${plan.budget.maxCostUsd.toFixed(4)} · ${Math.round(plan.budget.maxWallClockMs / 1000)}s · ${plan.budget.maxIterations} iterations`,
	].join("\n");
}
