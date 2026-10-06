// 全仓审查反例的正向回归：真实 Core/入口 handler + 隔离 Pi 事件，不调用 Provider。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import agentFlux from "../src/entry";
import { showWorkflowTuiMenu } from "../src/extension/tui-menu";
import { claimIssue, createIssue, getIssue, reviewClaim, submitClaim } from "../src/core/community";
import { createAgent, gcAgents, listAgents } from "../src/agents/agent-store";
import { createWorkflowDefinition, getWorkflowDefinition, reviseWorkflowDefinition } from "../src/workflows/workflow-registry";
import { runLifecycleGc } from "../src/core/lifecycle-gc";
import { listTasks, listTaskExecutions, recordTaskInvocationOutcome, updateTaskMetadata, registerTask, updateTaskStatus } from "../src/core/task-registry";
import { DEFAULT_CONFIG } from "../src/core/types";
import { AgentMessageRuntime } from "../src/core/agent-message-runtime";
import { MessageBus } from "../src/core/message-bus";
import { SharedBoard } from "../src/core/shared-board";
import { resolveCommunicationPolicy, evaluateCommunicationContract } from "../src/core/communication-policy";
import { RpcInboxPump } from "../src/extension/rpc-inbox-pump";
import { executeDAG, type TaskDAG } from "../src/workflows/dag-executor";
import { TelemetryWriter } from "../src/telemetry/events";
import { listAgentRuns } from "../src/core/run-registry";
import { registerActiveContext, releaseActiveContext } from "../src/core/active-context";
import { aggregateInvocationOutcomes } from "../src/core/task-outcome";
import { createTaskExecutionPlan } from "../src/core/task-execution";

class FakePi {
	hooks = new Map<string, any[]>(); tools = new Map<string, any>(); commands = new Map<string, any>();
	messages: any[] = [];
	on(name: string, handler: any) { this.hooks.set(name, [...(this.hooks.get(name) ?? []), handler]); }
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	sendUserMessage(message: any) { this.messages.push(message); }
}
const root = mkdtempSync(join(tmpdir(), "agentflux-review-fix-"));
const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
process.env.HOME = root; process.env.USERPROFILE = root;
assert.equal(homedir(), root, "GC fixtures must not access the user's global registry");
const hosts: Array<{ emit: (name: string, event?: any) => Promise<void> }> = [];
async function host(name: string) {
	const cwd = join(root, name), fluxDir = join(cwd, ".agentflux");
	mkdirSync(fluxDir, { recursive: true });
	writeFileSync(join(fluxDir, "agentflux.json"), JSON.stringify({ pricing: { enable_remote_fetch: false } }));
	writeFileSync(join(fluxDir, "models.json"), JSON.stringify({ models: {}, roles: {} }));
	const pi = new FakePi(); agentFlux(pi as any);
	let toolIndex = 0;
	const ctx: any = { cwd, hasUI: false, mode: "print", sessionManager: { getSessionId: () => name, getBranch: () => [] } };
	const emit = async (n: string, event: any = {}) => { for (const handler of pi.hooks.get(n) ?? []) await handler(event, ctx); };
	await emit("session_start"); hosts.push({ emit });
	return { cwd, fluxDir, pi, ctx, emit, tool: (n: string, p: any) => pi.tools.get(n).execute(`regression-${toolIndex++}`, p) };
}
let checks = 0;
function passed(name: string) { checks++; console.log(`✓ ${name}`); }
try {
	const menu = await host("menu");
	menu.ctx.hasUI = true; menu.ctx.mode = "tui";
	let body = "agent delete innocent\n这只是谈话正文";
	menu.ctx.ui = { select: async (_title: string, options: string[]) => options[0], input: async () => body, notify() {} };
	await menu.pi.commands.get("flux").handler("agent", menu.ctx);
	assert.deepEqual(menu.pi.messages, [body]);
	body = "只读检查 README\n固定工作流需求";
	assert.deepEqual(await showWorkflowTuiMenu(menu.ctx, { agents: [], roles: [], issues: [], forkPoints: [], activeTaskIds: [], workflows: [] }), { kind: "new_workflow", task: body });
	passed("R01 Main Talk preserves control-like text as conversation; new Workflow emits a typed intent");

	const h = await host("issue");
	const issue = createIssue(h.cwd, { title: "review", description: "" });
	const claim = claimIssue(h.cwd, issue.id, "review-worker", "README").claims[0];
	submitClaim(h.cwd, issue.id, claim.id);
	const issuePath = join(h.fluxDir, "issues.json"), before = readFileSync(issuePath, "utf8");
	const leasePath = join(h.fluxDir, "runtime", "active-context.json"), leaseBefore = readFileSync(leasePath, "utf8");
	for (const verdict of [undefined, "unknown", null]) {
		await assert.rejects(h.tool("flux_issue", { action: "review", issueId: issue.id, claimId: claim.id, verdict }), /requires verdict/);
		assert.throws(() => reviewClaim(h.cwd, issue.id, claim.id, verdict as any, "main"), /requires verdict/);
		assert.equal(readFileSync(issuePath, "utf8"), before);
		assert.equal(readFileSync(leasePath, "utf8"), leaseBefore);
	}
	await assert.rejects(h.tool("flux_issue", { action: "delete", issueId: issue.id }), /active or submitted/);
	assert.equal(readFileSync(issuePath, "utf8"), before);
	await h.tool("flux_issue", { action: "review", issueId: issue.id, claimId: claim.id, verdict: "pass" });
	await h.tool("flux_issue", { action: "resolve", issueId: issue.id });
	await h.tool("flux_issue", { action: "delete", issueId: issue.id });
	assert.equal(getIssue(h.cwd, issue.id), undefined);
	const open = createIssue(h.cwd, { title: "delete open", description: "" });
	await h.tool("flux_issue", { action: "delete", issueId: open.id });
	assert.equal(getIssue(h.cwd, open.id), undefined);
	await assert.rejects(h.tool("flux_issue", { action: "unsupported", issueId: "missing" }), /Unknown Issue action/);
	passed("R02 invalid verdict preserves Issue/lease; tool delete is physical and respects active claims");

	const wf = await host("explicit-workflow");
	const saved = createWorkflowDefinition(wf.fluxDir, { name: "saved-empty", dag: { description: "saved description", nodes: [] }, sourceTaskId: "seed-workflow" });
	await wf.emit("before_agent_start", { prompt: "原始宽泛需求 A", systemPrompt: "base" });
	await wf.tool("flux_workflow", { action: "reuse", workflow: saved.id, task: "明确子任务 B" });
	const explicit = listTasks(wf.fluxDir)[0];
	assert.equal(explicit.task, "明确子任务 B"); assert.equal(explicit.workflowRequest?.task, "明确子任务 B");
	assert.equal(explicit.operation, "reuse"); assert.equal(explicit.parentTaskId, "seed-workflow");
	await wf.emit("agent_settled");
	await wf.tool("flux_task", { action: "new", task: "必须保留的父任务 A" });
	const parent = listTasks(wf.fluxDir)[0];
	await wf.tool("flux_workflow", { action: "reuse", workflow: saved.id, task: "第二次明确子任务 C" });
	const preserved = listTasks(wf.fluxDir).find(task => task.id === parent.id)!;
	assert.equal(preserved.task, parent.task); assert.equal(preserved.operation, parent.operation);
	assert.equal(preserved.parentTaskId, parent.parentTaskId); assert.equal(preserved.executionId, parent.executionId);
	assert.equal(preserved.workflowRequest?.task, "第二次明确子任务 C");
	assert.throws(() => updateTaskMetadata(wf.fluxDir, parent.id, { workflowRequest: { task: "attempted overwrite", action: "reuse" } }), /immutable/);
	const invalidWorkflow = await host("invalid-workflow");
	await invalidWorkflow.emit("before_agent_start", { prompt: "不得隐式变成 Workflow 正文", systemPrompt: "base" });
	for (const action of ["run", "modify"]) await assert.rejects(invalidWorkflow.tool("flux_workflow", { action }), /requires task/);
	assert.equal(listTasks(invalidWorkflow.fluxDir).length, 0);
	passed("R03 explicit Workflow body wins; frozen invocation preserves active parent identity/budget and missing requests fail before execution");

	for (const malformed of [{ action: "completed", status: "unknown" }, { action: "completed", status: "failure" }, { action: "completed", status: "success", costUsd: -1 }, { action: "completed", status: "success", costUsd: 1, costComplete: "true" }, { action: "completed", status: "success", costUsd: 1, attributionComplete: 1 }]) {
		assert.throws(() => aggregateInvocationOutcomes([malformed as any]), /Invalid invocation outcome/);
	}
	const partialCoverage = aggregateInvocationOutcomes([{ status: "success", action: "completed", costUsd: 1, costComplete: true, attributionComplete: true }, { status: "success", action: "completed", costUsd: 2 }]);
	assert.equal(partialCoverage.costUsd, 3); assert.equal(partialCoverage.costComplete, false); assert.equal(partialCoverage.attributionComplete, false);
	for (const reason of ["error", "aborted", "stop-forward", "stop-reverse"]) {
		const outcomes = await host(`outcomes-${reason}`);
		const definition = createWorkflowDefinition(outcomes.fluxDir, { name: "empty", dag: { description: "empty", nodes: [] } });
		await outcomes.emit("before_agent_start", { prompt: "parent", systemPrompt: "base" });
		await outcomes.tool("flux_workflow", { action: "reuse", workflow: definition.id, task: "successful child" });
		const task = listTasks(outcomes.fluxDir)[0];
		const receipts = [
			{ id: "child-success", action: "completed" as const, status: "success" as const, costUsd: 1 },
			{ id: "child-second", action: reason.startsWith("stop") ? "failed" as const : "completed" as const, status: reason.startsWith("stop") ? "failure" as const : "success" as const, costUsd: 2, error: reason.startsWith("stop") ? "child failed" : undefined },
		];
		const known = reason === "stop-forward";
		if (known) for (const receipt of receipts) Object.assign(receipt, { costComplete: true, attributionComplete: true });
		if (reason === "stop-reverse") receipts.reverse();
		for (const { id, ...value } of receipts) recordTaskInvocationOutcome(outcomes.fluxDir, task.id, id, value);
		const { id, ...same } = receipts[0];
		recordTaskInvocationOutcome(outcomes.fluxDir, task.id, id, same); // 幂等回执不重复计费。
		assert.throws(() => recordTaskInvocationOutcome(outcomes.fluxDir, task.id, "invalid-flags", { ...same, costComplete: "true" } as any), /Invalid invocation outcome/);
		assert.throws(() => recordTaskInvocationOutcome(outcomes.fluxDir, task.id, id, { ...same, costUsd: 99 }), /immutable/);
		await outcomes.emit("turn_end", { message: { role: "assistant", provider: "fixture", model: "fixture-chat", usage: { input: 5, output: 2, cost: { total: 0.5 } } } });
		await outcomes.emit("agent_end", { messages: [{ role: "assistant", stopReason: reason.startsWith("stop") ? "stop" : reason }] });
		await outcomes.emit("agent_settled");
		const execution = listTaskExecutions(outcomes.fluxDir, task.id)[0];
		assert.equal(execution.status, reason === "aborted" ? "cancelled" : "failed");
		assert.equal(execution.costUsd, 3.5); assert.equal(execution.usage?.costUsd, 0.5);
		assert.deepEqual(execution.costAccounting, { mainCostUsd: 0.5, invocationCostUsd: 3, complete: known, attributionComplete: known });
	}
	// 实际后台入口在 Main settled 之后才拿到 pre-spawn 失败，父 Task 不得提前 completed。
	const bg = await host("background-outcome"); bg.ctx.hasUI = true; bg.ctx.mode = "tui";
	createAgent(bg.cwd, { name: "background-invalid", modelsConfig: { models: {} } });
	await bg.emit("before_agent_start", { prompt: "background parent", systemPrompt: "base" });
	const launch = bg.tool("flux_agent", { action: "run", agent: "background-invalid", model: "unknown-model", task: "must reject before spawn", background: true });
	const settling = bg.emit("agent_settled");
	assert.equal(listTasks(bg.fluxDir)[0].status, "running");
	await launch; await settling;
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(listTasks(bg.fluxDir)[0].status, "failed");
	assert.equal(listTaskExecutions(bg.fluxDir)[0].invocationOutcomes?.length, 1);
	passed("R04 Main error/abort and child failures survive either completion order; durable receipts sum once and background failure delays parent settlement");

	const t = await host("task-history");
	await t.tool("flux_task", { action: "new", task: "first task" });
	const first = listTasks(t.fluxDir)[0];
	const firstBytes = readFileSync(join(t.fluxDir, "runtime", "tasks.json"), "utf8");
	await assert.rejects(t.tool("flux_task", { action: "new", task: "must not retarget" }), /Cannot replace an active task/);
	assert.equal(readFileSync(join(t.fluxDir, "runtime", "tasks.json"), "utf8"), firstBytes);
	await t.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }); await t.emit("agent_settled");
	await assert.rejects(t.tool("flux_task", { action: "retry", selector: first.id }), /Cannot retry a completed task/);
	await t.tool("flux_task", { action: "new", task: "second task" });
	const second = listTasks(t.fluxDir).find(task => task.id !== first.id)!;
	assert.equal(second.task, "second task"); assert.notEqual(first.executionId, second.executionId);
	assert.equal(listTasks(t.fluxDir).find(task => task.id === first.id)?.task, "first task");
	assert.equal(listTaskExecutions(t.fluxDir).length, 2);
	passed("R05 active invocation cannot be retargeted; new after settled creates distinct history and retry validates status");

	const cp = await host("checkpoint");
	const dag: TaskDAG = { description: "checkpoint proof", planningCostUsd: 1.25, nodes: [{ id: "done", title: "done", description: "done", role: "implementer", dependsOn: [], parallelizable: false, acceptanceCriteria: [], files: [] }] };
	const options = { cwd: cp.cwd, fluxDir: cp.fluxDir, modelsConfig: { models: { "fixture-chat": { provider: "fixture", contextWindow: 128000 } }, roles: {} }, telemetry: new TelemetryWriter(cp.fluxDir), sessionId: "checkpoint", prefixLayout: false, enableQualityGate: false, maxRetries: 0, invocationOverride: { command: process.execPath, args: [resolve("tests/helpers/successful-subagent.cjs")] } };
	await executeDAG(dag, { ...options, executionId: "checkpoint-parent" });
	const checkpointPath = join(cp.fluxDir, "runtime/runs/checkpoint-parent/checkpoint.json");
	const parentBytes = readFileSync(checkpointPath, "utf8"), parentState = JSON.parse(parentBytes);
	const mutations = [
		(value: any) => { delete value.version; },
		(value: any) => { value.taskResults = []; },
		(value: any) => { value.taskResults[0][1].subagentResult.output = "forged output without matching artifact"; },
		(value: any) => { value.completed = ["missing"]; },
		(value: any) => { value.artifactHashes.done = "0".repeat(64); },
		(value: any) => { value.dagFingerprint = "different"; },
		(value: any) => { value.totalCost = -1; },
		(value: any) => { value.totalCost += 1; },
		(value: any) => { value.artifactPaths.done = join(cp.cwd, "outside.md"); },
	];
	for (let i = 0; i < mutations.length; i++) {
		const value = structuredClone(parentState); mutations[i](value);
		const bytes = JSON.stringify(value); writeFileSync(checkpointPath, bytes);
		await assert.rejects(executeDAG(dag, { ...options, executionId: `rejected-${i}`, resumeFromExecutionId: "checkpoint-parent" }), /checkpoint|artifact/i);
		assert.equal(readFileSync(checkpointPath, "utf8"), bytes);
		assert.equal(listAgentRuns(cp.fluxDir).length, 1, "invalid evidence must reject before spawning");
	}
	writeFileSync(checkpointPath, parentBytes);
	await assert.rejects(executeDAG(dag, { ...options, executionId: "checkpoint-parent", resume: true }), /In-place resume/);
	await assert.rejects(executeDAG(dag, { ...options, executionId: "checkpoint-parent", resumeFromExecutionId: "checkpoint-parent" }), /new executionId/);
	const resumed = await executeDAG(dag, { ...options, executionId: "checkpoint-child", resumeFromExecutionId: "checkpoint-parent", maxCostUsd: 2 });
	assert.equal(resumed.status, "passed"); assert.equal(resumed.totalCost, 1.25); assert.equal(resumed.attemptCostUsd, 0);
	assert.equal(readFileSync(checkpointPath, "utf8"), parentBytes); assert.equal(listAgentRuns(cp.fluxDir).length, 1);
	assert.ok(resumed.artifactPaths.done.includes("checkpoint-child"));
	const exhausted = await executeDAG(dag, { ...options, executionId: "checkpoint-budget", resumeFromExecutionId: "checkpoint-parent", maxCostUsd: 1 });
	assert.equal(exhausted.status, "budget_exceeded"); assert.equal(listAgentRuns(cp.fluxDir).length, 1);
	await assert.rejects(executeDAG(dag, { ...options, executionId: "checkpoint-child" }), /already exists/);
	const plannerExhausted = await executeDAG({ description: "planner already exhausted budget", nodes: [], planningCostUsd: 2 }, { ...options, executionId: "planner-budget", maxCostUsd: 1 });
	assert.equal(plannerExhausted.status, "budget_exceeded");
	const concurrent = executeDAG({ description: "one writer", nodes: [] }, { ...options, executionId: "checkpoint-concurrent" });
	await assert.rejects(executeDAG({ description: "second writer", nodes: [] }, { ...options, executionId: "checkpoint-concurrent" }), /lock timeout|already exists/);
	await concurrent;
	const failedWrite = await host("checkpoint-write-failure");
	mkdirSync(join(failedWrite.fluxDir, "runtime/dag-state.json"), { recursive: true });
	await assert.rejects(executeDAG({ description: "write failure", nodes: [] }, { ...options, cwd: failedWrite.cwd, fluxDir: failedWrite.fluxDir, telemetry: new TelemetryWriter(failedWrite.fluxDir), executionId: "write-failure" }), /EISDIR|EPERM|EACCES/);
	assert.equal(listAgentRuns(failedWrite.fluxDir).length, 0);
	passed("R08 checkpoint schema/DAG/artifact proof fails closed; resume preserves parent and cumulative cost, new attempt is not double charged, persistence errors stay visible");

	const recovery = await host("resume-entry");
	const seedPlan = createTaskExecutionPlan({ task: "源父任务 A", selectedBy: "user", budget: DEFAULT_CONFIG.budget });
	registerTask(recovery.fluxDir, "resume-entry", seedPlan, "running");
	const seedDefinition = createWorkflowDefinition(recovery.fluxDir, { name: "resume-source", dag });
	updateTaskMetadata(recovery.fluxDir, seedPlan.taskId, { resource: { type: "workflow", id: seedDefinition.id, version: 1 }, workflowRequest: { task: "已冻结执行 B", action: "run" } });
	const seedDag = { ...dag, planningCostUsd: 1.25000019, invocationTask: "已冻结执行 B" };
	const seedDir = join(recovery.fluxDir, "runtime/runs", seedPlan.executionId);
	mkdirSync(seedDir, { recursive: true }); writeFileSync(join(seedDir, "dag.json"), JSON.stringify(seedDag));
	const seedResult = await executeDAG(seedDag, { ...options, cwd: recovery.cwd, fluxDir: recovery.fluxDir, telemetry: new TelemetryWriter(recovery.fluxDir), taskId: seedPlan.taskId, executionId: seedPlan.executionId });
	assert.equal(seedResult.totalCost, seedDag.planningCostUsd, "DAG result must not round Core costs to display precision");
	assert.equal(seedResult.attemptCostUsd, seedDag.planningCostUsd);
	updateTaskStatus(recovery.fluxDir, seedPlan.taskId, "failed", { costUsd: seedDag.planningCostUsd, outcome: { status: "failure", error: "Main failed after Workflow" } });
	reviseWorkflowDefinition(recovery.fluxDir, seedDefinition.id, { dag: { ...dag, description: "new version" } });
	const seedTask = listTasks(recovery.fluxDir).find(t => t.id === seedPlan.taskId);
	const seedExecution = listTaskExecutions(recovery.fluxDir).find(e => e.id === seedPlan.executionId);
	const seedFiles = ["dag.json", "checkpoint.json"].map(file => ({ file, bytes: readFileSync(join(seedDir, file), "utf8") }));
	await recovery.emit("before_agent_start", { prompt: "当前恢复提示，不是执行输入", systemPrompt: "base" });
	const preparationBytes = readFileSync(join(recovery.fluxDir, "runtime/tasks.json"), "utf8");
	await assert.rejects(recovery.tool("flux_task", { action: "resume", selector: seedPlan.taskId, task: "改变任务 C" }), /Resume cannot replace/);
	assert.equal(readFileSync(join(recovery.fluxDir, "runtime/tasks.json"), "utf8"), preparationBytes);
	const notices: string[] = [];
	recovery.ctx.hasUI = true; recovery.ctx.ui = { notify: (text: string) => notices.push(text) };
	await recovery.pi.commands.get("flux").handler(`task resume ${seedPlan.taskId} 改变任务 C`, recovery.ctx);
	assert.ok(notices.some(text => text.includes("Resume cannot replace")));
	assert.equal(readFileSync(join(recovery.fluxDir, "runtime/tasks.json"), "utf8"), preparationBytes);
	recovery.ctx.hasUI = false;
	const seen = new Set([seedPlan.taskId]);
	const beginResume = async () => {
		await recovery.tool("flux_task", { action: "resume", selector: seedPlan.taskId });
		const target = listTasks(recovery.fluxDir).find(t => !seen.has(t.id))!; seen.add(target.id);
		assert.equal(target.task, seedPlan.task, "resume must not inherit the current conversational prompt");
		assert.equal(target.parentExecutionId, seedPlan.executionId); return target;
	};
	for (const request of [
		{ task: "冲突执行 C" }, { workflow: seedDefinition.id },
		{ action: "modify", workflow: `${seedDefinition.id}@1`, task: "已冻结执行 B" },
		{ action: "reuse", workflow: `${seedDefinition.id}@1`, task: "已冻结执行 B" },
		{ name: "must not rename" },
	]) {
		const target = await beginResume();
		await assert.rejects(recovery.tool("flux_workflow", { action: "run", ...request }), /Workflow resume/);
		assert.equal(existsSync(join(recovery.fluxDir, "runtime/runs", target.executionId)), false);
		assert.equal(listAgentRuns(recovery.fluxDir).length, 1, "rejected recovery must not launch planner/worker");
		assert.equal(listTasks(recovery.fluxDir).find(t => t.id === target.id)?.resource, undefined);
		await recovery.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }); await recovery.emit("agent_settled");
	}
	for (const invocationTask of [null, 42, "不一致的历史输入"]) {
		const bytes = JSON.stringify({ ...seedDag, invocationTask });
		writeFileSync(join(seedDir, "dag.json"), bytes);
		const target = await beginResume();
		await assert.rejects(recovery.tool("flux_workflow", { action: "run" }), /Workflow resume input/);
		assert.equal(readFileSync(join(seedDir, "dag.json"), "utf8"), bytes);
		assert.equal(existsSync(join(recovery.fluxDir, "runtime/runs", target.executionId)), false);
		await recovery.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }); await recovery.emit("agent_settled");
	}
	writeFileSync(join(seedDir, "dag.json"), seedFiles.find(entry => entry.file === "dag.json")!.bytes);
	for (const task of [undefined, "已冻结执行 B"]) {
		const target = await beginResume();
		const result = await recovery.tool("flux_workflow", { action: "run", workflow: `${seedDefinition.id}@1`, task });
		assert.equal(result.details.status, "passed"); assert.equal(result.details.totalCost, seedDag.planningCostUsd); assert.equal(result.details.attemptCostUsd, 0);
		assert.equal(listTasks(recovery.fluxDir).find(t => t.id === target.id)?.workflowRequest?.task, "已冻结执行 B");
		assert.equal(listAgentRuns(recovery.fluxDir).length, 1, "proven completed node must not execute twice");
		await recovery.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }); await recovery.emit("agent_settled");
	}
	assert.deepEqual(listTasks(recovery.fluxDir).find(t => t.id === seedPlan.taskId), seedTask);
	assert.deepEqual(listTaskExecutions(recovery.fluxDir).find(e => e.id === seedPlan.executionId), seedExecution);
	for (const { file, bytes } of seedFiles) assert.equal(readFileSync(join(seedDir, file), "utf8"), bytes);
	passed("R03/R08 resume handler rejects changed body/action/version before artifacts or spawn; exact/omitted input restores proven results and immutable lineage");

	const deletion = await host("workflow-delete");
	const liveDefinition = createWorkflowDefinition(deletion.fluxDir, { name: "live-definition", dag: { description: "live", nodes: [] } });
	await deletion.tool("flux_task", { action: "new", task: "live Workflow reference" });
	const liveTask = listTasks(deletion.fluxDir)[0];
	updateTaskMetadata(deletion.fluxDir, liveTask.id, { resource: { type: "workflow", id: liveDefinition.id, version: 1 } });
	const liveLease = registerActiveContext(deletion.cwd, { name: "workflow-delete-fixture", context: "workflow", scope: liveTask.executionId, task: liveTask.task });
	const definitionPath = join(deletion.fluxDir, "runtime/workflows.json"), definitionBytes = readFileSync(definitionPath, "utf8");
	for (const selector of [liveDefinition.id, liveDefinition.name, `${liveDefinition.id}@1`]) {
		await assert.rejects(deletion.tool("flux_workflow", { action: "delete", workflow: selector }), /currently running/);
		assert.equal(readFileSync(definitionPath, "utf8"), definitionBytes);
	}
	assert.throws(() => updateTaskMetadata(deletion.fluxDir, liveTask.id, { resource: { type: "issue", id: "retarget" } }), /binding cannot be replaced/);
	for (let i = 0; i < 12; i++) reviseWorkflowDefinition(deletion.fluxDir, liveDefinition.id, { dag: liveDefinition.dag });
	assert.ok(getWorkflowDefinition(deletion.fluxDir, `${liveDefinition.id}@1`), "version retention must not evict an active binding");
	releaseActiveContext(deletion.cwd, liveLease.leaseId); await deletion.emit("agent_settled");
	await deletion.tool("flux_workflow", { action: "delete", workflow: liveDefinition.id });
	assert.equal(getWorkflowDefinition(deletion.fluxDir, liveDefinition.id), undefined);
	// 两个真实 Node 进程竞争启动绑定/删除；允许任一方胜出，绝不能产生指向已删除定义的活动绑定。
	const race = await host("workflow-reference-race");
	const raceDefinition = createWorkflowDefinition(race.fluxDir, { name: "race", dag: { description: "race", nodes: [] } });
	await race.tool("flux_task", { action: "new", task: "race parent" });
	const raceTask = listTasks(race.fluxDir)[0];
	const exits = await Promise.all(["workflow-bind", "workflow-delete"].map(mode => new Promise<{ code: number | null; error: string }>((done, reject) => {
		const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("tests/helpers/transactional-store-worker.ts"), mode, race.fluxDir, raceTask.id, "1", raceDefinition.id], { stdio: ["ignore", "ignore", "pipe"] });
		let error = ""; child.stderr.on("data", chunk => { error += chunk; });
		child.on("error", reject); child.on("close", code => done({ code, error }));
	})));
	assert.equal(exits.filter(exit => exit.code === 0).length, 1);
	assert.match(exits.find(exit => exit.code !== 0)!.error, /Workflow not found|currently running/);
	const raceBound = listTasks(race.fluxDir)[0].resource;
	assert.equal(!!raceBound, !!getWorkflowDefinition(race.fluxDir, raceDefinition.id));
	passed("R15 Core rejects active definition deletion/retarget/version eviction; cross-process binding and deletion share one fence");

	const g = await host("gc");
	const publicAgent = createAgent(g.cwd, { name: "keep-memory", modelsConfig: { models: {} } });
	const globalMemory = createAgent(g.cwd, { name: "global-memory", scope: "global", modelsConfig: { models: {} } });
	const freshKey = `${publicAgent.sessionId}-fresh-current`;
	const agentPath = join(g.fluxDir, "runtime", "agents.json");
	const registry = JSON.parse(readFileSync(agentPath, "utf8")); registry.agents[0].lastSessionId = freshKey;
	writeFileSync(agentPath, JSON.stringify(registry));
	const sessionsDir = join(g.fluxDir, "runtime", "sessions"); mkdirSync(sessionsDir, { recursive: true });
	const old = new Date(Date.now() - 10 * 86400000);
	const sessionFiles = [publicAgent.sessionId, freshKey, globalMemory.sessionId].map(key => join(sessionsDir, `2025-01-01_${key}-cap-123456789abc.jsonl`));
	for (const file of sessionFiles) { writeFileSync(file, "{\"type\":\"session\"}\n"); utimesSync(file, old, old); }
	const gcReport = runLifecycleGc(g.fluxDir, DEFAULT_CONFIG.retention);
	for (const file of sessionFiles) assert.ok(existsSync(file));
	assert.equal(gcReport.removed.orphanSessions.length, 0);
	passed("R09 referenced idle shared/fresh/global sessions survive actual lifecycle GC");

	const a = createAgent(g.cwd, { name: "owner-a", scope: "session", ownerSessionId: "gc", modelsConfig: { models: {} } });
	const b = createAgent(g.cwd, { name: "owner-b", scope: "session", ownerSessionId: "other", modelsConfig: { models: {} } });
	const global = createAgent(g.cwd, { name: "global-retained", scope: "global", modelsConfig: { models: {} } });
	const referenced = createAgent(g.cwd, { name: "dag-retained", modelsConfig: { models: {} } });
	createWorkflowDefinition(g.fluxDir, { name: "keep-agent", dag: { description: "reference", nodes: [{ id: "node", title: "check", role: "assistant", agentId: referenced.id, dependsOn: [], parallelizable: false, files: [], acceptanceCriteria: [] }] } });
	assert.ok(!listAgents(g.cwd, "gc").some(x => x.id === b.id));
	await g.tool("flux_agent", { action: "gc", keepLatestK: 0 });
	const survivors = listAgents(g.cwd);
	assert.ok(!survivors.some(x => x.id === a.id));
	for (const kept of [b, global, referenced]) assert.ok(survivors.some(x => x.id === kept.id));
	gcAgents(g.cwd, 0); // 没有 owner 时不得将 session Agent 当作可回收的 project Agent。
	assert.ok(listAgents(g.cwd).some(x => x.id === b.id));
	assert.throws(() => gcAgents(g.cwd, -1), /non-negative/);
	const currentAgents = JSON.parse(readFileSync(agentPath, "utf8"));
	const invisible = currentAgents.agents.find((agent: any) => agent.id === b.id);
	invisible.status = "failed"; invisible.updatedAt = "2020-01-01T00:00:00.000Z";
	writeFileSync(agentPath, JSON.stringify(currentAgents));
	runLifecycleGc(g.fluxDir, DEFAULT_CONFIG.retention, { ownerSessionId: "gc" });
	assert.ok(listAgents(g.cwd).some(agent => agent.id === b.id), "maintenance GC also respects ownerSessionId");
	passed("R10 tool/maintenance GC honors owner visibility, global boundary and saved DAG references");
	const names = await host("concurrent-names");
	await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((done, reject) => {
		const child = spawn(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), join(process.cwd(), "tests/helpers/transactional-store-worker.ts"), "agent", names.cwd, "same-name", "1"], { stdio: ["ignore", "ignore", "pipe"] });
		let error = ""; child.stderr.on("data", chunk => { error += chunk; });
		child.on("error", reject); child.on("close", code => code === 0 ? done() : reject(new Error(`name worker ${code}: ${error}`)));
	})));
	const createdNames = listAgents(names.cwd).filter(agent => agent.scope !== "global").map(agent => agent.name).sort();
	assert.deepEqual(createdNames, ["same-name", "same-name-2", "same-name-3", "same-name-4", "same-name-5", "same-name-6"]);
	const namesPath = join(names.fluxDir, "runtime/agents.json"), namesBefore = readFileSync(namesPath, "utf8");
	for (const invalid of ["worker(1)", "worker name", "中文代理", "_leading", ".leading"]) {
		assert.throws(() => createAgent(names.cwd, { name: invalid, modelsConfig: { models: {} } }), /Agent name/);
		assert.equal(readFileSync(namesPath, "utf8"), namesBefore, "非法新身份必须在持久化前拒绝");
	}
	passed("R11 six concurrent processes reserve distinct valid names; invalid explicit identities never persist");

	const mdir = join(root, "peer-messages");
	const policy = resolveCommunicationPolicy({ maxMessagesPerRun: 4 });
	const alice = new AgentMessageRuntime(mdir, { agent: "alice", instanceId: "a", runId: "alice-run" }, policy);
	const bob = new AgentMessageRuntime(mdir, { agent: "bob", instanceId: "b", runId: "bob-run" }, policy);
	const board = new SharedBoard(mdir), bus = new MessageBus(mdir);
	board.registerRuntimeAgent({ name: "alice", role: "rpc-runtime", status: "idle", instanceId: "a" });
	board.registerRuntimeAgent({ name: "bob", role: "rpc-runtime", status: "idle", instanceId: "b" });
	const group = board.createGroup("peers", ["alice", "bob"], "team", "alice");
	for (const target of ["bob", `group:${group.id}`, "broadcast"]) alice.execute({ action: "send", target, content: `to ${target}` });
	const messages = bob.execute({ action: "poll" }) as any[];
	assert.equal(messages.length, 3);
	for (const message of messages) {
		assert.equal(message.envelope.senderRunId, "alice-run");
		bob.execute({ action: "ack", messageId: message.envelope.id });
		assert.equal(bus.getDelivery(message.envelope.id, "bob")?.status, "acknowledged");
	}
	let injected = "";
	alice.execute({ action: "send", target: "bob", content: "RPC path" });
	const pump = new RpcInboxPump({ fluxDir: mdir, recipient: "bob", runId: "bob-run", isIdle: () => true, sendUserMessage: content => { injected = content; } });
	assert.equal(await pump.tick(), 1);
	pump.onAgentStart(1);
	pump.onMessageStart({ role: "user", content: injected }); pump.onAssistantMessageEnd(true);
	assert.equal(pump.onAgentBeforeSettle({ generation: 1, outcome: "completed" }), true);
	assert.equal(pump.onAgentSettled(), 1); pump.stop();
	assert.throws(() => alice.execute({ action: "send", target: "bob", content: "over quota" }), /message limit/);
	assert.ok(evaluateCommunicationContract({ bus, policy: resolveCommunicationPolicy({ requiredSendTo: ["bob"] }), sender: "alice", runId: "alice-run" }).passed);
	assert.ok(!evaluateCommunicationContract({ bus, policy: resolveCommunicationPolicy({ requiredSendTo: ["bob"] }), sender: "alice", runId: "replacement-run" }).passed);
	passed("R06 direct/group/broadcast peer delivery and RPC ACK work across Run IDs; quota/contracts retain sender identity");
	console.log(`${checks} review regression groups passed`);
} finally {
	for (const h of hosts) await h.emit("session_shutdown");
	if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
	if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
	rmSync(root, { recursive: true, force: true });
}
