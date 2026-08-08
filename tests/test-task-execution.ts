/**
 * Comprehensive unit tests for src/core/task-execution.ts
 * Covers: createTaskExecutionPlan, formatTaskExecutionPlan
 */
import { strict as assert } from "node:assert";
import {
	createTaskExecutionPlan,
	formatTaskExecutionPlan,
	type TaskExecutionPlan,
} from "../src/core/task-execution";
import { DEFAULT_CONFIG, type BudgetConfig } from "../src/core/types";

let passed = 0;
let failed = 0;

function check(description: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${description}`);
	} catch (error: any) {
		failed++;
		console.log(`  ✗ ${description}: ${error.message}`);
	}
}

const budget: BudgetConfig = { max_cost_per_task: 2, max_iterations: 5, max_wall_clock_seconds: 600 };

// ─── createTaskExecutionPlan ──────────────────────────────────────────

console.log("\n--- createTaskExecutionPlan ---");

check("creates a valid plan with minimal input", () => {
	const plan = createTaskExecutionPlan({
		task: "implement feature",
		workStyle: "direct",
		selectedBy: "user",
		budget,
	});
	assert.ok(plan.taskId.startsWith("task-"));
	assert.strictEqual(plan.task, "implement feature");
	assert.strictEqual(plan.workStyle, "direct");
	assert.strictEqual(plan.selectedBy, "user");
	assert.strictEqual(plan.operation, "new");
	assert.strictEqual(plan.parentTaskId, undefined);
});

check("preserves explicit taskId", () => {
	const plan = createTaskExecutionPlan({
		taskId: "my-custom-id",
		task: "test",
		workStyle: "team",
		selectedBy: "main_agent",
		budget,
	});
	assert.strictEqual(plan.taskId, "my-custom-id");
});

check("supports custom operation and parentTaskId", () => {
	const plan = createTaskExecutionPlan({
		task: "continue work",
		workStyle: "workflow",
		selectedBy: "user",
		budget,
		operation: "continue",
		parentTaskId: "task-parent-123",
	});
	assert.strictEqual(plan.operation, "continue");
	assert.strictEqual(plan.parentTaskId, "task-parent-123");
});

check("trims task whitespace", () => {
	const plan = createTaskExecutionPlan({
		task: "  implement feature  ",
		workStyle: "direct",
		selectedBy: "user",
		budget,
	});
	assert.strictEqual(plan.task, "implement feature");
});

check("throws on empty task", () => {
	assert.throws(
		() => createTaskExecutionPlan({ task: "", workStyle: "direct", selectedBy: "user", budget }),
		/empty/,
	);
});

check("throws on whitespace-only task", () => {
	assert.throws(
		() => createTaskExecutionPlan({ task: "   ", workStyle: "direct", selectedBy: "user", budget }),
		/empty/,
	);
});

check("throws on zero budget", () => {
	assert.throws(
		() => createTaskExecutionPlan({
			task: "test", workStyle: "direct", selectedBy: "user",
			budget: { ...budget, max_cost_per_task: 0 },
		}),
		/greater than 0/,
	);
});

check("throws on negative budget", () => {
	assert.throws(
		() => createTaskExecutionPlan({
			task: "test", workStyle: "direct", selectedBy: "user",
			budget: { ...budget, max_cost_per_task: -1 },
		}),
		/greater than 0/,
	);
});

check("clamps maxIterations to at least 1", () => {
	const plan = createTaskExecutionPlan({
		task: "test", workStyle: "direct", selectedBy: "user",
		budget: { ...budget, max_iterations: 0 },
	});
	assert.strictEqual(plan.budget.maxIterations, 1);
});

check("clamps maxIterations for negative values", () => {
	const plan = createTaskExecutionPlan({
		task: "test", workStyle: "direct", selectedBy: "user",
		budget: { ...budget, max_iterations: -5 },
	});
	assert.strictEqual(plan.budget.maxIterations, 1);
});

check("converts maxWallClockSeconds to ms with minimum 1000", () => {
	const plan = createTaskExecutionPlan({
		task: "test", workStyle: "direct", selectedBy: "user",
		budget: { ...budget, max_wall_clock_seconds: 0 },
	});
	assert.strictEqual(plan.budget.maxWallClockMs, 1000);
});

check("converts maxWallClockSeconds correctly", () => {
	const plan = createTaskExecutionPlan({
		task: "test", workStyle: "direct", selectedBy: "user",
		budget: { ...budget, max_wall_clock_seconds: 300 },
	});
	assert.strictEqual(plan.budget.maxWallClockMs, 300000);
});

check("defaults operation to 'new' when not specified", () => {
	const plan = createTaskExecutionPlan({
		task: "test", workStyle: "direct", selectedBy: "main_agent", budget,
	});
	assert.strictEqual(plan.operation, "new");
});

check("accepts all work styles", () => {
	for (const style of ["direct", "team", "workflow", "community"] as const) {
		const plan = createTaskExecutionPlan({ task: style, workStyle: style, selectedBy: "user", budget });
		assert.strictEqual(plan.workStyle, style);
	}
});

// ─── formatTaskExecutionPlan ──────────────────────────────────────────

console.log("\n--- formatTaskExecutionPlan ---");

check("formats a basic plan correctly", () => {
	const plan: TaskExecutionPlan = {
		taskId: "task-123", task: "do work", workStyle: "direct",
		selectedBy: "user", operation: "new",
		budget: { maxCostUsd: 2.5, maxIterations: 5, maxWallClockMs: 600000 },
	};
	const formatted = formatTaskExecutionPlan(plan);
	assert.ok(formatted.includes("task-123"));
	assert.ok(formatted.includes("direct"));
	assert.ok(formatted.includes("user"));
	assert.ok(formatted.includes("$2.5000"));
	assert.ok(formatted.includes("600s"));
	assert.ok(formatted.includes("5 iterations"));
});

check("formats with continuation operation and parent", () => {
	const plan: TaskExecutionPlan = {
		taskId: "task-456", task: "fix bugs", workStyle: "team",
		selectedBy: "main_agent", operation: "continue", parentTaskId: "task-123",
		budget: { maxCostUsd: 1, maxIterations: 3, maxWallClockMs: 300000 },
	};
	const formatted = formatTaskExecutionPlan(plan);
	assert.ok(formatted.includes("continue"));
	assert.ok(formatted.includes("$1.0000"));
});

console.log(`\n=== Task Execution Tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
