import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { isProcessAlive } from "../../src/core/fs-lock";
import {
	assertLineage,
	assertNoChildOperation,
	assertNoDeadline,
	assertTerminalTask,
	assertUnchanged,
	exactAssistantEvidence,
	executionFor,
	readTaskCore,
	sha256File,
	toolEvidence,
	parseOutputEvents,
	type TaskCoreSnapshot,
} from "../helpers/task-history-evidence";

/**
 * P2-04 production Task history fixture.
 *
 * Every phase starts a new Pi process and loads the copied production entry
 * (never a TypeScript source entry).  A stable logical session id is used with --no-session
 * so Core selector scoping is exercised without reusing a Main transcript.
 * Workspaces, raw stdout/stderr, Core snapshots and failed phases are retained.
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const iteration = `${Date.now()}-${process.pid}`;
const root = join(sourceRoot, ".agentflux", "test-workspaces", `task-history-${iteration}`);
const results = join(sourceRoot, ".agentflux", "test-results");
const reportPath = join(results, `task-history-${iteration}.json`);
const piCli = getPiCliPath();
const watchdogMs = 360_000;

interface PhaseCall {
	tool: "flux_task" | "flux_agent" | "flux_workflow";
	args: Record<string, unknown>;
	expectError?: boolean;
}

interface PhaseSpec {
	label: string;
	sessionId: string;
	calls: PhaseCall[];
	marker: string;
	expectFailure: boolean;
}

interface PhaseResult {
	spec: PhaseSpec;
	stdout: string;
	stderr: string;
	core: TaskCoreSnapshot;
	row: any;
}

const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function stopTree(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	} else {
		try { process.kill(-child.pid, "SIGKILL"); }
		catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
	}
}

function phasePrompt(spec: PhaseSpec): string {
	const instructions = spec.calls.map((call, index) => [
		`第 ${index + 1} 步只调用 ${call.tool}。`,
		`参数必须逐字段使用这个 JSON：${JSON.stringify(call.args)}。`,
		call.expectError ? "这个调用必须被拒绝；这是预期负例，不要重试或改写参数。" : "这个调用必须成功，不要重复调用。",
	].join(" "));
	return [
		"这是 AgentFlux Task history 的确定性 fixture。只能调用下面列出的工具，不要调用 read、bash 或任何其他工具。",
		...instructions,
		`严格按顺序完成 ${spec.calls.length} 步；禁止增加、删除、重排或修改任何 JSON 字段。`,
		spec.expectFailure
			? "如果出现预期拒绝，只确认拒绝事实，不要把拒绝说成成功，也不要自行寻找替代操作。"
			: "所有工具成功后再结束。",
		`最终 assistant 正文必须仅为 ${spec.marker}，不得有前缀、后缀、解释或 Markdown。`,
	].join("\n");
}

function coreOrEmpty(): TaskCoreSnapshot {
	const taskStorePath = join(root, ".agentflux", "runtime", "tasks.json");
	if (!existsSync(taskStorePath)) return { tasks: [], executions: [], runs: [], agents: [], events: [] };
	return readTaskCore(join(root, ".agentflux"));
}

function validateToolSequence(result: PhaseResult): void {
	const events = parseOutputEvents(result.stdout, result.stderr).filter(event => event?.type === "tool_execution_start");
	assert.equal(events.length, result.spec.calls.length, `${result.spec.label} must have exactly the declared tool calls`);
	for (const [index, expected] of result.spec.calls.entries()) {
		const start = events[index];
		assert.equal(start.toolName, expected.tool, `${result.spec.label} tool order differs at step ${index + 1}`);
		assert.deepEqual(start.args, expected.args, `${result.spec.label} JSON args differ at step ${index + 1}`);
		const end = parseOutputEvents(result.stdout, result.stderr).find(event => event?.type === "tool_execution_end" && event.toolName === expected.tool && event.toolCallId === start.toolCallId);
		assert.ok(end, `${result.spec.label} has no terminal receipt for ${expected.tool} step ${index + 1}`);
		if (expected.expectError) assert.equal(end.isError, true, `${result.spec.label} expected a rejected ${expected.tool} call`);
		else assert.notEqual(end.isError, true, `${result.spec.label} unexpected ${expected.tool} error`);
	}
}

function assertNoFalseSuccessForRejectedPhase(before: TaskCoreSnapshot, after: TaskCoreSnapshot): void {
	const beforeIds = new Set(before.tasks.map(task => task.id));
	for (const task of after.tasks.filter(candidate => !beforeIds.has(candidate.id))) {
		assert.notEqual(task.status, "completed", `a rejected tool call must not be converted into successful Task ${task.id}`);
		const execution = executionFor(after, task);
		assert.notEqual(execution.outcome?.status, "success", `a rejected tool call must retain failure for Task ${task.id}`);
	}
}

function assertRejectedPreparation(before: TaskCoreSnapshot, after: TaskCoreSnapshot): void {
	const ids = new Set(before.tasks.map(task => task.id));
	for (const task of after.tasks.filter(task => !ids.has(task.id))) {
		assert.equal(task.operation, "new", "a rejected preparation cannot create the requested child operation");
		assert.equal(task.parentTaskId, undefined); assert.equal(task.parentExecutionId, undefined);
	}
	assert.deepEqual(after.runs, before.runs, "preparation rejection must launch no Run");
	assert.deepEqual(after.agents, before.agents, "preparation rejection must create no Agent");
	for (const task of before.tasks) assertUnchanged(task, after.tasks.find(row => row.id === task.id), "preparation rejection must preserve every prior Task");
	for (const execution of before.executions) assertUnchanged(execution, after.executions.find(row => row.id === execution.id), "preparation rejection must preserve every prior Execution");
}

async function runPhase(config: ReturnType<typeof loadLiveConfig>, report: any, spec: PhaseSpec): Promise<PhaseResult> {
	const label = spec.label;
	const phasePromptText = phasePrompt(spec);
	const stdoutPath = join(root, `${label}.stdout.jsonl`);
	const stderrPath = join(root, `${label}.stderr.log`);
	writeFileSync(stdoutPath, "");
	writeFileSync(stderrPath, "");
	const coreBeforePath = join(root, `${label}.core-before.json`);
	const coreAfterPath = join(root, `${label}.core.json`);
	const before = coreOrEmpty();
	writeFileSync(coreBeforePath, JSON.stringify(before, null, 2));
	const row: any = {
		label,
		sessionId: spec.sessionId,
		freshMain: true,
		noSession: true,
		pid: undefined,
		watchdogMs,
		watchdogExpired: false,
		marker: spec.marker,
		expectFailure: spec.expectFailure,
		calls: spec.calls,
		prompt: phasePromptText,
		stdoutPath,
		stderrPath,
		coreBeforePath,
		coreAfterPath,
		passed: false,
	};
	report.phases.push(row);
	let stdout = "";
	let stderr = "";
	const runPids = new Set<number>();
	const child = spawn(process.execPath, [
		piCli,
		"--mode", "json", "-p", "--approve", "--no-extensions", "-e", join(root, "dist", "extension", "host-entry.ts"),
		"--no-skills", "--tools", [...new Set(spec.calls.map(call => call.tool))].join(","),
		"--no-session", "--session-id", spec.sessionId,
		...config.cliArgs(config.mainModel),
		phasePromptText,
	], {
		cwd: root,
		env: config.env,
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	row.pid = child.pid;
	if (child.pid) runPids.add(child.pid);
	child.stdout?.on("data", chunk => {
		const text = chunk.toString();
		stdout += text;
		appendFileSync(stdoutPath, text);
	});
	child.stderr?.on("data", chunk => {
		const text = chunk.toString();
		stderr += text;
		appendFileSync(stderrPath, text);
	});
	const stop = () => stopTree(child);
	const monitor = setInterval(() => {
		try {
			const runsPath = join(root, ".agentflux", "runtime", "runs.json");
			if (!existsSync(runsPath)) return;
			for (const run of json(runsPath).runs ?? []) if (typeof run.pid === "number" && run.pid > 0) runPids.add(run.pid);
		} catch { /* retain raw output; final Core validation reports parse failures */ }
	}, 200);
	const watchdog = setTimeout(() => {
		row.watchdogExpired = true;
		stop();
	}, watchdogMs);
	try {
		const close = await new Promise<{ code: number; signal: NodeJS.Signals | null; spawnError?: string }>(resolveClose => {
			child.once("error", error => resolveClose({ code: 1, signal: null, spawnError: String(error.message ?? error) }));
			child.once("close", (code, signal) => resolveClose({ code: code ?? 1, signal }));
		});
		row.exitCode = close.code;
		row.signal = close.signal;
		if (close.spawnError) row.spawnError = close.spawnError;
	} finally {
		clearTimeout(watchdog);
		clearInterval(monitor);
		stop();
		const until = Date.now() + 10_000;
		while ([...runPids].some(pid => isProcessAlive(pid)) && Date.now() < until) await sleep(50);
		row.mainAlive = child.pid ? isProcessAlive(child.pid) : false;
		row.observedPids = [...runPids].map(pid => ({ pid, main: pid === child.pid, alive: isProcessAlive(pid) }));
	}
	const core = coreOrEmpty();
	writeFileSync(coreAfterPath, JSON.stringify(core, null, 2));
	row.core = core;
	const outputEvidence = exactAssistantEvidence(stdout, stderr, spec.marker);
	row.output = outputEvidence;
	row.toolEvidence = Object.fromEntries([...new Set(spec.calls.map(call => call.tool))].map(tool => [tool, toolEvidence(stdout, stderr, tool)]));
	assert.equal(row.exitCode, 0, `${label} fresh Main exited unsuccessfully`);
	assert.equal(row.watchdogExpired, false, `${label} watchdog expired`);
	assert.equal(row.mainAlive, false, `${label} Main PID remains alive`);
	assert.ok(row.observedPids.every((entry: any) => !entry.alive), `${label} an observed child Run PID remains alive`);
	assert.equal(row.freshMain, true);
	assert.equal(row.noSession, true);
	validateToolSequence({ spec, stdout, stderr, core, row });
	assertNoDeadline(core);
	row.passed = true;
	return { spec, stdout, stderr, core, row };
}

function expectNewTask(core: TaskCoreSnapshot, sessionId: string, taskText: string): any {
	const task = core.tasks.find(candidate => candidate.sessionId === sessionId && candidate.operation === "new" && candidate.task === taskText);
	assertTerminalTask(core, task, "completed");
	assert.equal(task.parentTaskId, undefined);
	assert.equal(task.parentExecutionId, undefined);
	return task;
}

function expectFailedNewTask(core: TaskCoreSnapshot, sessionId: string, taskText: string): any {
	const task = core.tasks.find(candidate => candidate.sessionId === sessionId && candidate.operation === "new" && candidate.task === taskText);
	const execution = assertTerminalTask(core, task, "failed");
	assert.ok(execution.invocationOutcomes?.some((outcome: any) => outcome.status === "failure"), "failed source must retain the invocation failure");
	return task;
}

async function expectRejectedWorkflowResume(
	config: ReturnType<typeof loadLiveConfig>,
	report: any,
	label: string,
	sessionId: string,
	source: any,
	sourceSnapshot: any,
	sourceExecutionSnapshot: any,
	workflowArgs: Record<string, unknown>,
	marker: string,
): Promise<void> {
	const before = readTaskCore(join(root, ".agentflux"));
	const result = await runPhase(config, report, {
		label,
		sessionId,
		calls: [
			{ tool: "flux_task", args: { action: "resume", selector: source.id, task: source.task } },
			{ tool: "flux_workflow", args: workflowArgs, expectError: true },
		],
		marker,
		expectFailure: true,
	});
	const resumed = result.core.tasks.find(task => task.sessionId === sessionId && task.operation === "resume" && task.parentTaskId === source.id && task.id !== source.id);
	assertTerminalTask(result.core, resumed, "failed");
	assertLineage(result.core, resumed, source, "resume");
	assert.equal(resumed.task, source.task, "Workflow resume preparation must retain source.task");
	assert.equal(resumed.resource, undefined, `${label} must not bind a Workflow without a proven checkpoint`);
	assert.equal(resumed.workflowRequest, undefined, `${label} must not persist a rejected Workflow request`);
	assertUnchanged(sourceSnapshot, result.core.tasks.find(task => task.id === source.id), `${label} must not rewrite source Task`);
	assertUnchanged(sourceExecutionSnapshot, executionFor(result.core, source), `${label} must not rewrite source cost or outcome`);
	const resumeRunDir = join(root, ".agentflux", "runtime", "runs", resumed.executionId);
	assert.equal(existsSync(join(resumeRunDir, "checkpoint.json")), false, `${label} must not fabricate a checkpoint`);
	assert.equal(existsSync(resumeRunDir), false, `${label} must not create a fake recovery run`);
	assert.ok((executionFor(result.core, resumed).invocationOutcomes ?? []).some((outcome: any) => outcome.status === "failure"), `${label} must retain the rejection receipt`);
	assertNoFalseSuccessForRejectedPhase(before, result.core);
}

async function main(): Promise<void> {
	const config = loadLiveConfig("history");
	mkdirSync(join(root, ".agentflux"), { recursive: true });
	mkdirSync(results, { recursive: true });
	const report: any = {
		startedAt: new Date().toISOString(),
		root,
		reportPath,
		passed: false,
		workspaceRetained: true,
		productionDist: true,
		provider: config.providerId,
		models: { main: config.mainModel, planner: config.plannerModel, worker: config.workerModel, judge: config.judgeModel },
		thinking: config.thinking,
		pricingAuthoritative: false,
		defaultModelDeadline: null,
		phases: [],
		coverage: {
			new: false,
			continue: false,
			reuse: false,
			retryFailedSource: false,
			retryCompletedRejected: false,
			activeContinueRejected: false,
			activeReuseRejected: false,
			activeResumeRejected: false,
			activeRetryRejected: false,
			resumeTaskMismatchRejected: false,
			resumeWithoutCheckpointRejected: false,
		},
	};
	try {
		assert.equal(process.env.AGENTFLUX_LIVE_BUILT, "1", "Task history requires the caller to provide a production build");
		assert.ok(existsSync(join(sourceRoot, "dist", "extension", "entry.js")), "production dist entry is missing");
		assert.ok(existsSync(join(sourceRoot, "dist", "extension", "subagent-entry.js")), "production subagent entry is missing");
		cpSync(join(sourceRoot, "dist", "extension"), join(root, "dist", "extension"), { recursive: true });
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(join(root, "README.md"), "# AgentFlux production Task history fixture\n");
		writeFileSync(join(root, ".agentflux", "models.json"), JSON.stringify(config.fluxModelsJson(), null, 2));
		writeFileSync(join(root, ".agentflux", "agentflux.json"), JSON.stringify({
			subagent_runtime: config.subagentRuntime,
			budget: {
				max_cost_per_task: 0.35,
				max_iterations: 3,
				max_turns_per_task: 8,
				max_input_tokens_per_task: 60_000,
				max_parallel_agents: 2,
				max_wall_clock_seconds: null,
			},
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		report.dist = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"].map(name => ({ name, sha256: sha256File(join(root, "dist", "extension", name)) }));
		report.configPath = config.configPath;

		const chainSession = `history-chain-${iteration}`;
		const newTaskText = "TASK_HISTORY_NEW_SOURCE: complete this short direct task.";
		const continueTaskText = "TASK_HISTORY_CONTINUE_BODY: continue with a new execution without changing the source history.";
		const reuseTaskText = "TASK_HISTORY_REUSE_BODY: reuse the source context for this independent execution.";
		const newResult = await runPhase(config, report, {
			label: "01-new",
			sessionId: chainSession,
			calls: [{ tool: "flux_task", args: { action: "new", task: newTaskText } }],
			marker: "TASK_HISTORY_NEW_OK",
			expectFailure: false,
		});
		const newSource = expectNewTask(newResult.core, chainSession, newTaskText);
		const newSourceSnapshot = structuredClone(newSource);
		const newSourceExecutionSnapshot = structuredClone(executionFor(newResult.core, newSource));
		report.coverage.new = true;

		const continueResult = await runPhase(config, report, {
			label: "02-continue",
			sessionId: chainSession,
			calls: [{ tool: "flux_task", args: { action: "continue", selector: newSource.id, task: continueTaskText } }],
			marker: "TASK_HISTORY_CONTINUE_OK",
			expectFailure: false,
		});
		const continued = continueResult.core.tasks.find(task => task.sessionId === chainSession && task.operation === "continue" && task.parentTaskId === newSource.id && task.task === continueTaskText);
		assertTerminalTask(continueResult.core, continued, "completed");
		assertLineage(continueResult.core, continued, newSource, "continue");
		assertUnchanged(newSourceSnapshot, continueResult.core.tasks.find(task => task.id === newSource.id), "continue must not rewrite the source Task");
		assertUnchanged(newSourceExecutionSnapshot, executionFor(continueResult.core, newSource), "continue must not rewrite source cost or outcome");
		report.coverage.continue = true;

		const reuseResult = await runPhase(config, report, {
			label: "03-reuse",
			sessionId: chainSession,
			calls: [{ tool: "flux_task", args: { action: "reuse", selector: newSource.id, task: reuseTaskText } }],
			marker: "TASK_HISTORY_REUSE_OK",
			expectFailure: false,
		});
		const reused = reuseResult.core.tasks.find(task => task.sessionId === chainSession && task.operation === "reuse" && task.parentTaskId === newSource.id && task.task === reuseTaskText);
		assertTerminalTask(reuseResult.core, reused, "completed");
		assertLineage(reuseResult.core, reused, newSource, "reuse");
		assertUnchanged(newSourceSnapshot, reuseResult.core.tasks.find(task => task.id === newSource.id), "reuse must not rewrite the source Task");
		assertUnchanged(newSourceExecutionSnapshot, executionFor(reuseResult.core, newSource), "reuse must not rewrite source cost or outcome");
		report.coverage.reuse = true;

		const retrySession = `history-retry-${iteration}`;
		const failedTaskText = "TASK_HISTORY_FAILED_SOURCE: this Task must retain the real AgentFlux failure.";
		const invalidModel = `${config.workerModel}-task-history-unregistered`;
		const failedResult = await runPhase(config, report, {
			label: "04-failed-source",
			sessionId: retrySession,
			calls: [
				{ tool: "flux_task", args: { action: "new", task: failedTaskText } },
				{ tool: "flux_agent", args: { action: "create", name: `task-history-invalid-${iteration}`, role: "implementer", model: invalidModel, scope: "project" }, expectError: true },
			],
			marker: "TASK_HISTORY_FAILED_SOURCE_OK",
			expectFailure: true,
		});
		const failedSource = expectFailedNewTask(failedResult.core, retrySession, failedTaskText);
		const failedSourceSnapshot = structuredClone(failedSource);
		const failedSourceExecutionSnapshot = structuredClone(executionFor(failedResult.core, failedSource));
		const failedInvocation = executionFor(failedResult.core, failedSource).invocationOutcomes ?? [];
		assert.ok(failedInvocation.some((outcome: any) => outcome.status === "failure" && typeof outcome.error === "string"), "raw failed invocation evidence is required");

		const retryResult = await runPhase(config, report, {
			label: "05-retry-failed",
			sessionId: retrySession,
			calls: [{ tool: "flux_task", args: { action: "retry", selector: failedSource.id } }],
			marker: "TASK_HISTORY_RETRY_OK",
			expectFailure: false,
		});
		const retried = retryResult.core.tasks.find(task => task.sessionId === retrySession && task.operation === "retry" && task.parentTaskId === failedSource.id);
		assertTerminalTask(retryResult.core, retried, "completed");
		assertLineage(retryResult.core, retried, failedSource, "retry");
		assert.equal(retried.task, failedSource.task, "retry without task must preserve the failed source body");
		assertUnchanged(failedSourceSnapshot, retryResult.core.tasks.find(task => task.id === failedSource.id), "retry must not rewrite the failed source Task");
		assertUnchanged(failedSourceExecutionSnapshot, executionFor(retryResult.core, failedSource), "retry must not rewrite failed source cost or outcome");
		report.coverage.retryFailedSource = true;

		const completedRetryBefore = readTaskCore(join(root, ".agentflux"));
		const completedRetryResult = await runPhase(config, report, {
			label: "06-retry-completed-rejected",
			sessionId: chainSession,
			calls: [{ tool: "flux_task", args: { action: "retry", selector: newSource.id }, expectError: true }],
			marker: "TASK_HISTORY_COMPLETED_RETRY_REJECTED_OK",
			expectFailure: true,
		});
		assertUnchanged(newSourceSnapshot, completedRetryResult.core.tasks.find(task => task.id === newSource.id), "completed retry rejection must not rewrite the source Task");
		assertUnchanged(newSourceExecutionSnapshot, executionFor(completedRetryResult.core, newSource), "completed retry rejection must not rewrite source cost or outcome");
		assertNoChildOperation(completedRetryResult.core, newSource.id, "retry");
		assertRejectedPreparation(completedRetryBefore, completedRetryResult.core);
		report.coverage.retryCompletedRejected = true;

		const activeSession = `history-active-${iteration}`;
		const activeTaskText = "TASK_HISTORY_ACTIVE_SOURCE: reject every replacement while this Task is active.";
		const activeResult = await runPhase(config, report, {
			label: "07-active-rejections",
			sessionId: activeSession,
			calls: [
				{ tool: "flux_task", args: { action: "new", task: activeTaskText } },
				{ tool: "flux_task", args: { action: "continue", selector: "latest", task: "TASK_HISTORY_ACTIVE_CONTINUE" }, expectError: true },
				{ tool: "flux_task", args: { action: "reuse", selector: "latest", task: "TASK_HISTORY_ACTIVE_REUSE" }, expectError: true },
				{ tool: "flux_task", args: { action: "resume", selector: "latest" }, expectError: true },
				{ tool: "flux_task", args: { action: "retry", selector: "latest" }, expectError: true },
			],
			marker: "TASK_HISTORY_ACTIVE_REJECTIONS_OK",
			expectFailure: true,
		});
		const activeTask = activeResult.core.tasks.find(task => task.sessionId === activeSession && task.operation === "new" && task.task === activeTaskText);
		assertTerminalTask(activeResult.core, activeTask, "completed");
		for (const operation of ["continue", "reuse", "resume", "retry"]) assertNoChildOperation(activeResult.core, activeTask.id, operation);
		assert.equal((executionFor(activeResult.core, activeTask).invocationOutcomes ?? []).length, 0, "rejected preparation must not fabricate an executed invocation");
		assert.equal(activeResult.core.tasks.filter(task => task.sessionId === activeSession).length, 1, "active task identity must not be replaced");
		report.coverage.activeContinueRejected = true;
		report.coverage.activeReuseRejected = true;
		report.coverage.activeResumeRejected = true;
		report.coverage.activeRetryRejected = true;

		const resumeMismatchBefore = readTaskCore(join(root, ".agentflux"));
		const resumeMismatchTask = "TASK_HISTORY_RESUME_WRONG_BODY: must be rejected and never replace the source.";
		const mismatchResult = await runPhase(config, report, {
			label: "08-resume-task-mismatch",
			sessionId: retrySession,
			calls: [{ tool: "flux_task", args: { action: "resume", selector: failedSource.id, task: resumeMismatchTask }, expectError: true }],
			marker: "TASK_HISTORY_RESUME_MISMATCH_REJECTED_OK",
			expectFailure: true,
		});
		assertUnchanged(failedSourceSnapshot, mismatchResult.core.tasks.find(task => task.id === failedSource.id), "resume mismatch must leave source.task unchanged");
		assertUnchanged(failedSourceExecutionSnapshot, executionFor(mismatchResult.core, failedSource), "resume mismatch must leave source cost or outcome unchanged");
		assert.equal(mismatchResult.core.tasks.filter(task => task.operation === "resume" && task.parentTaskId === failedSource.id).length, 0);
		assertRejectedPreparation(resumeMismatchBefore, mismatchResult.core);
		report.coverage.resumeTaskMismatchRejected = true;

		// 无 checkpoint 的源不能证明 Workflow 输入/selector/action guard；这些由专用恢复夹具覆盖。
		await expectRejectedWorkflowResume(
			config,
			report,
			"12-resume-no-checkpoint",
			retrySession,
			failedSource,
			failedSourceSnapshot,
			failedSourceExecutionSnapshot,
			{ action: "run", task: failedSource.task },
			"TASK_HISTORY_RESUME_NO_CHECKPOINT_REJECTED_OK",
		);
		report.coverage.resumeWithoutCheckpointRejected = true;

		report.finalCorePath = join(root, "final.core.json");
		const finalCore = readTaskCore(join(root, ".agentflux"));
		writeFileSync(report.finalCorePath, JSON.stringify(finalCore, null, 2));
		report.tasks = finalCore.tasks;
		report.executions = finalCore.executions;
		report.runs = finalCore.runs;
		report.events = finalCore.events;
		report.allDeadlinesAbsent = true;
		report.passed = Object.values(report.coverage).every(Boolean);
		assert.equal(report.passed, true);
	} catch (error) {
		report.error = error instanceof Error ? error.stack : String(error);
		process.exitCode = 1;
	} finally {
		report.finishedAt = new Date().toISOString();
		writeFileSync(reportPath, JSON.stringify(report, null, 2));
		writeFileSync(join(results, "task-history-latest.json"), JSON.stringify(report, null, 2));
		config.cleanup();
		console.log(JSON.stringify({ passed: report.passed, error: report.error, reportPath, workspace: root }));
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
