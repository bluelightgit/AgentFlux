import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assistantOutputEvidence, parseJsonLines, type AssistantOutputEvidence } from "./pi-json-output";

export interface TaskCoreSnapshot {
	tasks: any[];
	executions: any[];
	runs: any[];
	agents: any[];
	events: any[];
}

export interface ToolEvidence {
	starts: any[];
	ends: any[];
	errors: any[];
}

export function parseOutputEvents(stdout: string, stderr = ""): any[] {
	return parseJsonLines(`${stdout}\n${stderr}`);
}

export function toolEvidence(stdout: string, stderr: string, toolName: string): ToolEvidence {
	const events = parseOutputEvents(stdout, stderr);
	const starts = events.filter(event => event?.type === "tool_execution_start" && event.toolName === toolName);
	const ends = events.filter(event => event?.type === "tool_execution_end" && event.toolName === toolName);
	return { starts, ends, errors: ends.filter(event => event.isError === true) };
}

export function exactAssistantEvidence(stdout: string, stderr: string, marker: string): AssistantOutputEvidence {
	const evidence = assistantOutputEvidence(stdout, stderr, marker);
	assert.equal(evidence.parseable, true, "JSONL output must contain an assistant message");
	assert.equal(evidence.markerMatched, true, `final assistant output must exactly equal ${marker}`);
	return evidence;
}

export function readJsonIfExists(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
}

export function readTaskCore(fluxDir: string): TaskCoreSnapshot {
	const runtime = join(fluxDir, "runtime");
	const taskStore = readJsonIfExists(join(runtime, "tasks.json"));
	assert.ok(taskStore && Array.isArray(taskStore.tasks) && Array.isArray(taskStore.executions), `Task Registry is missing or invalid: ${join(runtime, "tasks.json")}`);
	return {
		tasks: taskStore.tasks,
		executions: taskStore.executions,
		runs: readJsonIfExists(join(runtime, "runs.json"))?.runs ?? [],
		agents: readJsonIfExists(join(runtime, "agents.json"))?.agents ?? [],
		events: existsSync(join(fluxDir, "events.jsonl"))
			? readFileSync(join(fluxDir, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
			: [],
	};
}

export function taskFor(core: TaskCoreSnapshot, sessionId: string, predicate: (task: any) => boolean = () => true): any | undefined {
	return core.tasks
		.filter(task => task.sessionId === sessionId && predicate(task))
		.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
}

export function executionFor(core: TaskCoreSnapshot, task: any): any {
	const execution = core.executions.find(candidate => candidate.id === task?.executionId);
	assert.ok(execution, `Execution is missing for Task ${task?.id ?? "<unknown>"}`);
	return execution;
}

export function assertNoDeadline(core: TaskCoreSnapshot): void {
	for (const task of core.tasks) assert.equal(task.deadlineAt, undefined, `Task ${task.id} must not receive a default deadline`);
	for (const execution of core.executions) assert.equal(execution.deadlineAt, undefined, `Execution ${execution.id} must not receive a default deadline`);
	for (const run of core.runs) assert.equal(run.deadlineAt, undefined, `Run ${run.id} must not receive a default deadline`);
}

export function assertTerminalTask(core: TaskCoreSnapshot, task: any, status: "completed" | "failed"): any {
	assert.ok(task, "expected Task is missing from Core");
	assert.equal(task.selectedBy, "main_agent", `Task ${task.id} must retain the Main selector identity`);
	assert.equal(task.status, status, `Task ${task.id} has unexpected status`);
	const execution = executionFor(core, task);
	assert.equal(execution.taskId, task.id);
	assert.equal(execution.status, status);
	assert.equal(Number.isFinite(execution.costUsd), true, `Task ${task.id} must retain a finite Core cost`);
	assert.ok(execution.costUsd >= 0, `Task ${task.id} must retain a non-negative Core cost`);
	if (status === "completed") {
		assert.equal(execution.outcome?.status, "success");
	} else {
		assert.equal(execution.outcome?.status, "failure");
		assert.ok(typeof execution.outcome?.error === "string" && execution.outcome.error.length > 0, "failed Task must retain its failure reason");
	}
	if (core.events.length > 0) {
		const taskEvents = core.events.filter(event => event?.type === "task.execution" && event.taskId === task.id);
		assert.ok(taskEvents.some(event => event.action === "created" || event.action === "started"), `Task ${task.id} lifecycle identity is missing from Core events`);
		const terminal = taskEvents.filter(event => ["completed", "failed", "cancelled"].includes(event.action)).at(-1);
		assert.ok(terminal, `Task ${task.id} terminal event is missing from Core events`);
		assert.equal(terminal.action, status === "completed" ? "completed" : "failed");
	}
	return execution;
}

export function assertLineage(core: TaskCoreSnapshot, child: any, parent: any, operation: string): any {
	assert.ok(child && parent, "Task lineage requires both child and parent");
	assert.notEqual(child.id, parent.id, "history operation must create a new Task identity");
	assert.notEqual(child.executionId, parent.executionId, "history operation must create a new Execution identity");
	assert.equal(child.sessionId, parent.sessionId, "history lineage must remain in the logical Main session");
	assert.equal(child.operation, operation);
	assert.equal(child.parentTaskId, parent.id);
	assert.equal(child.parentExecutionId, parent.executionId);
	const execution = executionFor(core, child);
	assert.equal(execution.operation, operation);
	assert.equal(execution.parentTaskId, parent.id);
	assert.equal(execution.parentExecutionId, parent.executionId);
	return execution;
}

export function assertUnchanged(before: any, after: any, message: string): void {
	assert.deepEqual(after, before, message);
}

export function assertNoChildOperation(core: TaskCoreSnapshot, parentId: string, operation: string): void {
	assert.equal(core.tasks.filter(task => task.parentTaskId === parentId && task.operation === operation).length, 0,
		`rejected ${operation} must not create a child Task`);
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function hasOnlyExpectedToolErrors(evidence: ToolEvidence, expectedErrorCount: number): void {
	assert.equal(evidence.errors.length, expectedErrorCount, "unexpected tool errors or missing rejection evidence");
}
