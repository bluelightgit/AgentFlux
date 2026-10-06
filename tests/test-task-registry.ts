import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/core/types";
import { createTaskExecutionPlan, formatTaskExecutionPlan } from "../src/core/task-execution";
import { createWorkflowDefinition, reviseWorkflowDefinition } from "../src/workflows/workflow-registry";
import { getTask, getTaskExecution, listTaskExecutions, listTasks, registerTask, resolveTask, updateTaskMetadata, updateTaskStatus } from "../src/core/task-registry";

let passed = 0;
function check(message: string, fn: () => void): void { fn(); passed++; console.log(`✓ ${message}`); }

const root = mkdtempSync(join(tmpdir(), "agentflux-task-registry-"));
try {
	const first = createTaskExecutionPlan({ taskId: "task-one", task: "review module", selectedBy: "user", budget: DEFAULT_CONFIG.budget });
	registerTask(root, "pi-session-1", first);
	updateTaskMetadata(root, first.taskId, { team: [{ name: "reviewer", role: "reviewer" }, { name: "tester", persistent: true }] });
	const definition = createWorkflowDefinition(root, { name: "workflow-one", dag: { description: "task binding", nodes: [] } });
	reviseWorkflowDefinition(root, definition.id, { dag: definition.dag });
	updateTaskMetadata(root, first.taskId, { resource: { type: "workflow", id: definition.id, version: 2 } });
	updateTaskStatus(root, first.taskId, "completed", {
		executionId: first.executionId,
		costUsd: 0.25,
		outcome: { status: "success" },
	});
	const continuation = createTaskExecutionPlan({ taskId: "task-two", task: "apply review feedback", selectedBy: "main_agent", budget: DEFAULT_CONFIG.budget, operation: "continue", parentTaskId: first.taskId });
	registerTask(root, "pi-session-1", continuation);

	check("Task Registry persists operation and parent lineage", () => {
		assert.equal(getTask(root, "task-two")?.operation, "continue");
		assert.equal(getTask(root, "task-two")?.parentTaskId, "task-one");
		assert.equal(getTask(root, "task-two")?.parentExecutionId, first.executionId);
		assert.equal(getTaskExecution(root, continuation.executionId)?.parentExecutionId, first.executionId);
		assert.equal(listTaskExecutions(root, continuation.taskId).length, 1);
	});
	check("Execution Registry persists budget, cost, and outcome separately from the task", () => {
		const execution = getTaskExecution(root, first.executionId);
		assert.equal(execution?.budget?.maxCostUsd, DEFAULT_CONFIG.budget.max_cost_per_task);
		assert.equal(execution?.costUsd, 0.25);
		assert.equal(execution?.outcome?.status, "success");
		assert.ok(execution?.finishedAt);
	});
	check("Execution plan formatting exposes operation and execution lineage", () => {
		const formatted = formatTaskExecutionPlan(continuation);
		assert.match(formatted, /operation continue/);
		assert.match(formatted, new RegExp(`parent execution ${first.executionId}`));
	});
	check("Terminal task and execution history cannot be reopened or edited", () => {
		assert.throws(() => updateTaskStatus(root, first.taskId, "running"), /Historical task is immutable/);
		assert.throws(() => updateTaskMetadata(root, first.taskId, { team: [{ name: "replacement" }] }), /Historical task is immutable/);
		assert.equal(getTask(root, first.taskId)?.status, "completed");
		assert.deepEqual(getTask(root, first.taskId)?.team?.map(item => item.name), ["reviewer", "tester"]);
	});
	check("Same-terminal replay is immutable and idempotent", () => {
		const path = join(root, "runtime", "tasks.json");
		const before = readFileSync(path, "utf8");
		for (const details of [{ costUsd: 99 }, { outcome: { status: "failure" as const } }, { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 42 } }]) {
			assert.throws(() => updateTaskStatus(root, first.taskId, "completed", details), /Historical execution is immutable/);
			assert.equal(readFileSync(path, "utf8"), before);
		}
		updateTaskStatus(root, first.taskId, "completed", { costUsd: 0.25, outcome: { status: "success" } });
		updateTaskStatus(root, first.taskId, "completed");
		assert.equal(readFileSync(path, "utf8"), before);
	});
	check("Task Registry preserves reusable Team structure", () => assert.deepEqual(getTask(root, "task-one")?.team?.map(item => item.name), ["reviewer", "tester"]));
	check("Task Registry preserves the exact Workflow version", () => assert.equal(getTask(root, first.taskId)?.resource?.version, 2));
	check("Task selectors remain scoped to the Pi session", () => {
		assert.equal(resolveTask(root, "task-two", "pi-session-1")?.id, "task-two");
		assert.equal(resolveTask(root, "latest", "another-session"), undefined);
	});
	check("Task history orders the newest task first", () => assert.deepEqual(listTasks(root, "pi-session-1").map(task => task.id), ["task-two", "task-one"]));
	check("Task Registry keeps a previous atomic backup", () => assert.equal(existsSync(join(root, "runtime", "tasks.json.bak")), true));

	const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
	const worker = resolve("tests/helpers/transactional-store-worker.ts");
	await Promise.all(Array.from({ length: 6 }, (_, workerIndex) => new Promise<void>((resolveWorker, rejectWorker) => {
		const child = spawn(process.execPath, [tsxCli, worker, "task", root, `w${workerIndex}`, "10"], {
			cwd: process.cwd(),
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", chunk => { stderr += chunk.toString(); });
		child.on("error", rejectWorker);
		child.on("exit", code => code === 0 ? resolveWorker() : rejectWorker(new Error(`task registry worker exited ${code}: ${stderr}`)));
	})));
	check("Concurrent Task Registry writers preserve every task", () => {
		const ids = new Set(listTasks(root).map(task => task.id));
		for (let workerIndex = 0; workerIndex < 6; workerIndex++) {
			for (let index = 0; index < 10; index++) assert.equal(ids.has(`task-w${workerIndex}-${index}`), true);
		}
	});

	const corruptRoot = mkdtempSync(join(tmpdir(), "agentflux-task-registry-corrupt-"));
	try {
		const corruptPath = join(corruptRoot, "runtime", "tasks.json");
		mkdirSync(join(corruptRoot, "runtime"), { recursive: true });
		writeFileSync(corruptPath, "{\"version\":1,\"tasks\":[", "utf-8");
		assert.throws(() => listTasks(corruptRoot), /corrupt and was not overwritten/);
		check("Corrupt Task Registry fails closed without erasing evidence", () => {
			assert.equal(readFileSync(corruptPath, "utf-8"), "{\"version\":1,\"tasks\":[");
		});
	} finally {
		rmSync(corruptRoot, { recursive: true, force: true });
	}
	console.log(`\n${passed} task registry checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
