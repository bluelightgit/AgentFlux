import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createIssue } from "../../src/core/community";
import { readActiveContext } from "../../src/core/active-context";
import { isProcessAlive } from "../../src/core/fs-lock";
import { createWorkflowDefinition } from "../../src/workflows/workflow-registry";
import type { TaskDAG } from "../../src/workflows/dag-executor";
import { getPiCliPath, loadLiveConfig, type LiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";
import { buildProcessOutputEvidence, snapshotP002CoreFacts, validateProcessOutputEvidence, type ExpectedP002TerminalOutcome } from "../helpers/p0-02-evidence";

/**
 * P0-02 真实多进程空间互斥：
 * - Main persistent dispatch 与同空间并行；
 * - Main ↔ Workflow/Community 的跨空间拒绝；
 * - Workflow ↔ Community 的跨空间拒绝；
 * - Community Claim 的同空间并行和进程退出清理。
 * 所有 Pi 必须加载本轮 production dist，状态从 active-context.json、Task/Run 和
 * toolResult 事实核对，不用最终自然语言推断冲突是否发生。
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-02-space-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-02-space-isolation-latest.json");
const failureReportPath = join(sourceRoot, ".agentflux", "test-results", `p0-02-space-isolation-failed-${Date.now()}-${process.pid}.json`);
const piCli = getPiCliPath();
const ACTIVE = new Set(["starting", "running", "stop_requested"]);
const MAIN_HOLD_MS = 240_000;
const COMMUNITY_HOLD_MS = 180_000;
const WORKFLOW_HOLD_MS = 180_000;
const CONFLICT_WAIT_MS = 240_000;
const outputArtifactRoot = join(sourceRoot, ".agentflux", "test-results", `p0-02-space-isolation-artifacts-${Date.now()}-${process.pid}`);
const EXPECTED_MARKERS: Record<string, string> = {
	"main-a": "P0_02_MAIN_A_OK",
	"main-b": "P0_02_MAIN_B_OK",
	"main-conflict": "P0_02_MAIN_CONFLICT_OK",
	"main-failure": "P0_02_MAIN_FAILURE_OK",
	"main-issue-failure": "P0_02_MAIN_ISSUE_FAILURE_OK",
	"community-a": "P0_02_COMMUNITY_A_OK",
	"community-b": "P0_02_COMMUNITY_B_OK",
	"community-conflict": "P0_02_COMMUNITY_CONFLICT_OK",
	"community-failure": "P0_02_COMMUNITY_FAILURE_OK",
	workflow: "P0_02_WORKFLOW_OK",
	"workflow-community-conflict": "P0_02_WORKFLOW_CONFLICT_OK",
	"workflow-failure": "P0_02_WORKFLOW_FAILURE_OK",
};

const EXPECTED_TERMINAL_OUTCOMES: Record<string, ExpectedP002TerminalOutcome> = Object.fromEntries(
	Object.entries(EXPECTED_MARKERS).map(([label, marker]) => [label, {
		marker,
		taskStatus: ["main-a", "main-b", "community-a", "community-b", "workflow"].includes(label) ? "completed" : "failed",
		outcomeStatus: ["main-a", "main-b", "community-a", "community-b", "workflow"].includes(label) ? "success" : "failure",
		deadline: "none",
	}]),
) as Record<string, ExpectedP002TerminalOutcome>;

const TERMINAL_OUTCOME_PHASES: Record<"mainPhase" | "communityPhase" | "workflowPhase", string[]> = {
	mainPhase: ["main-a", "main-b", "main-conflict", "main-failure", "main-issue-failure"],
	communityPhase: ["community-a", "community-b", "community-conflict", "community-failure"],
	workflowPhase: ["workflow", "workflow-community-conflict", "workflow-failure"],
};

type ContextName = "main" | "workflow" | "community";

interface PiResult {
	label: string;
	pid?: number;
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

interface PiHandle {
	label: string;
	child: ChildProcess;
	result: Promise<PiResult>;
	snapshot(): { stdout: string; stderr: string };
}

const outputEvidenceByLabel = new Map<string, any>();

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trimEnd(); }
	catch { return ""; }
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function stopTree(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	} else {
		try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
	}
}

function launch(
	label: string,
	extensionEntry: string,
	prompt: string,
	config: LiveConfig,
	model = config.mainModel,
	timeoutMs = 180_000,
): PiHandle {
	const finalInstruction = EXPECTED_MARKERS[label]
		? `\n工具错误和 Registry 由外部监督器自动保存，不要在最终回复中复述或解释。严格执行上述工具调用后，最终正文必须只有这一行（不得加引号/说明/列表）：${EXPECTED_MARKERS[label]}`
		: "";
	const args = [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "read,grep,find,ls,bash,flux_agent,flux_workflow,flux_issue",
		...config.cliArgs(model), prompt + finalInstruction,
	];
	const child = spawn(process.execPath, args, {
		cwd: fixtureRoot,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: config.env,
	});
	if (child.pid && EXPECTED_TERMINAL_OUTCOMES[label]) EXPECTED_TERMINAL_OUTCOMES[label].ownerPid = child.pid;
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", value => { stdout += value.toString(); });
	child.stderr?.on("data", value => { stderr += value.toString(); });
	const result = new Promise<PiResult>(resolveResult => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			stopTree(child);
			resolveResult({ label, pid: child.pid, exitCode: 124, stdout, stderr, timedOut: true });
		}, timeoutMs);
		child.on("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ label, pid: child.pid, exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false });
		});
		child.on("close", code => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ label, pid: child.pid, exitCode: code ?? 1, stdout, stderr, timedOut: false });
		});
	});
	return { label, child, result, snapshot: () => ({ stdout, stderr }) };
}

function activeEntries(): any[] {
	return readActiveContext(fixtureRoot).entries;
}

function activeEntriesByContext(context: ContextName): any[] {
	return activeEntries().filter(entry => entry.context === context);
}

function runtimeSnapshot(): any {
	const tasks = readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json"));
	const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"));
	return {
		tasks: (tasks?.tasks ?? []).map((task: any) => ({ id: task.id, status: task.status, operation: task.operation, executionId: task.executionId })),
		executions: (tasks?.executions ?? []).map((execution: any) => ({ id: execution.id, taskId: execution.taskId, status: execution.status, outcome: execution.outcome })),
		runs: (runs?.runs ?? []).map((run: any) => ({ id: run.id, agent: run.agent, status: run.status, phase: run.phase, exitCode: run.exitCode, error: run.error, taskId: run.taskId, executionId: run.executionId })),
	};
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(250);
	}
	throw new Error(`timeout waiting for ${label}; active=${JSON.stringify(activeEntries())}`);
}

function parseJsonLines(stdout: string): any[] {
	return stdout.split(/\r?\n/).flatMap(line => {
		if (!line.trim()) return [];
		try { return [JSON.parse(line)]; } catch { return []; }
	});
}

function collectNested(value: unknown, predicate: (candidate: any) => boolean, found: any[] = []): any[] {
	if (!value || typeof value !== "object") return found;
	if (predicate(value)) found.push(value);
	if (Array.isArray(value)) {
		for (const item of value) collectNested(item, predicate, found);
	} else {
		for (const item of Object.values(value as Record<string, unknown>)) collectNested(item, predicate, found);
	}
	return found;
}

function toolArguments(call: any): any {
	if (call?.arguments && typeof call.arguments === "object") return call.arguments;
	if (typeof call?.arguments === "string") {
		try { return JSON.parse(call.arguments); } catch { return undefined; }
	}
	return undefined;
}

function toolErrors(stdout: string, toolName: string): any[] {
	const roots = parseJsonLines(stdout);
	return roots.flatMap(root => collectNested(root, candidate =>
		(candidate?.role === "toolResult" || candidate?.type === "toolResult")
		&& candidate?.toolName === toolName
		&& candidate?.isError === true,
	)).map(result => ({
		toolName: result.toolName,
		toolCallId: result.toolCallId,
		isError: result.isError,
		content: result.content,
		details: result.details,
	}));
}

function toolCalls(stdout: string, toolName: string): any[] {
	const roots = parseJsonLines(stdout);
	return roots.flatMap(root => collectNested(root, candidate =>
		candidate?.type === "toolCall" && candidate?.name === toolName,
	)).map(call => ({ id: call.id, name: call.name, arguments: toolArguments(call) }));
}

function marker(result: PiResult, text: string): boolean {
	return hasAssistantFinalMarker(result.stdout, result.stderr, text);
}

interface ConflictObservation {
	observedAt: string;
	toolName: string;
	toolExecutionStart: any;
	activeEntries: any[];
}

/**
 * 等待真实工具开始执行，并在同一时刻确认目标空间 lease 仍活跃。
 * 仅等待冲突 Pi 进程启动或在完整 stdout 中搜索 call 都无法证明因果关系。
 */
async function waitForToolWhileContext(
	handle: PiHandle,
	toolName: string,
	context: ContextName,
	timeoutMs = CONFLICT_WAIT_MS,
	action?: string,
): Promise<ConflictObservation> {
	let observation: ConflictObservation | undefined;
	await waitFor(() => {
		const starts = toolExecutionStarts(handle.snapshot().stdout, toolName)
			.filter(event => action === undefined || (event.args ?? toolArguments(event))?.action === action);
		if (starts.length === 0) return false;
		const activeEntries = activeEntriesByContext(context);
		observation = {
			observedAt: new Date().toISOString(),
			toolName,
			toolExecutionStart: starts.at(-1),
			activeEntries,
		};
		if (activeEntries.length === 0) {
			throw new Error(`${context}→conflict ${toolName} call started after the ${context} lease ended`);
		}
		return true;
	}, timeoutMs, `real ${context} ${toolName} call while ${context} lease is active`);
	if (!observation) throw new Error(`${context} ${toolName} conflict observation was not captured`);
	return observation;
}

function compactResult(result: PiResult, expectedMarker?: string): any {
	const outputEvidence = buildProcessOutputEvidence(result, expectedMarker, sourceRoot, outputArtifactRoot);
	outputEvidenceByLabel.set(result.label, outputEvidence);
	return outputEvidence;
}

/** 在失败或超时路径也保存已经产生的完整输出，避免只留下不可解析的 tail。 */
function persistPartialOutputEvidence(handles: PiHandle[]): void {
	for (const handle of handles) {
		if (outputEvidenceByLabel.has(handle.label)) continue;
		const snapshot = handle.snapshot();
		if (!snapshot.stdout && !snapshot.stderr) continue;
		const partial: PiResult = {
			label: handle.label,
			pid: handle.child.pid,
			exitCode: handle.child.exitCode ?? 124,
			stdout: snapshot.stdout,
			stderr: snapshot.stderr,
			timedOut: handle.child.exitCode === null,
		};
		const outputEvidence = buildProcessOutputEvidence(partial, EXPECTED_MARKERS[handle.label], sourceRoot, outputArtifactRoot);
		outputEvidenceByLabel.set(handle.label, outputEvidence);
	}
}

function setup(config: LiveConfig): { workflowId: string; issueIds: string[] } {
	mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
	cpSync(join(sourceRoot, "dist", "extension"), join(fixtureRoot, "dist", "extension"), { recursive: true });
	mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
	writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux P0-02 space fixture\n");
	writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
		budget: {
			max_cost_per_task: 0.30,
			max_iterations: 3,
			max_wall_clock_seconds: null,
			max_turns_per_task: 32,
			max_input_tokens_per_task: 60_000,
			max_parallel_agents: 4,
		},
		pricing: { enable_remote_fetch: false },
	}, null, 2));
	const models: any = config.fluxModelsJson();
	for (const role of ["implementer", "planner", "reviewer", "tester"]) {
		if (models.roles?.[role]) models.roles[role].tools = ["read", "grep", "find", "ls", "bash"];
	}
	writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(models, null, 2));
	const workflow: TaskDAG = {
		description: "P0-02 long workflow space lease",
		nodes: [{
			id: "space-hold",
			title: "hold workflow space",
			role: "implementer",
			dependsOn: [],
			parallelizable: false,
			acceptanceCriteria: [],
			files: [],
			description: `Use bash to run node -e "setTimeout(() => {}, ${WORKFLOW_HOLD_MS})" and wait for it to finish before replying WORKFLOW_NODE_DONE`,
		}],
	};
	const definition = createWorkflowDefinition(join(fixtureRoot, ".agentflux"), { name: "p0-02-space-workflow", dag: workflow });
	const issueIds = ["community-a", "community-b", "community-conflict"].map(label => createIssue(fixtureRoot, { title: `P0-02 ${label}`, description: "space isolation fixture" }).id);
	return { workflowId: definition.id, issueIds };
}

async function main(): Promise<void> {
	const config = loadLiveConfig("p0-02-space-isolation");
	const startedAt = Date.now();
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const branch = git(["branch", "--show-current"]);
	const changedFiles = git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
	const handles: PiHandle[] = [];
	let fixture: ReturnType<typeof setup> | undefined;
	let evidence: any = {
		updatedAt: new Date().toISOString(),
		branch,
		sourceCommit,
		changedFiles,
		profile: config.profileName,
		configPath: config.configPath,
		provider: config.providerId,
		models: { main: config.mainModel, planner: config.plannerModel, worker: config.workerModel, judge: config.judgeModel },
		thinking: config.thinking,
		builtExtension: true,
		outputArtifactDirectory: outputArtifactRoot,
	};
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("P0-02 live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	try {
		fixture = setup(config);
		const extensionEntry = join(fixtureRoot, "dist", "extension", "host-entry.ts");

		// Supervisor barrier 保持两个 siblings 活着；不能用更长 sleep 猜模型耗时。
		const mainHoldTask = (marker: string) => `必须调用 bash 执行 node -e "const fs=require('fs'); const d=setTimeout(()=>{clearInterval(t);process.exitCode=1},${MAIN_HOLD_MS}); const t=setInterval(()=>{if(fs.existsSync('.agentflux/main-holders-release')){clearInterval(t);clearTimeout(d)}},250)"，命令成功后只回复 ${marker}。`;
		// Phase 1: Main space, then a real cross-space rejection and a same-space parallel Run.
		const mainA = launch("main-a", extensionEntry, [
			"必须实际调用 AgentFlux flux_agent 工具，不要自行完成任务。",
			"1) action=create，name=p0-02-main-a，role=implementer，scope=project。",
			`2) action=run，agent=p0-02-main-a，background=false，task=${mainHoldTask("MAIN_SPACE_A_RUN_DONE")}`,
			"3) run 返回后只输出 P0_02_MAIN_A_OK。",
		].join("\n"), config, config.mainModel, CONFLICT_WAIT_MS + 60_000);
		handles.push(mainA);
		await waitFor(() => activeEntriesByContext("main").length >= 1, 90_000, "first Main space lease");

		const mainConflict = launch("main-conflict", extensionEntry, [
			"必须严格实际调用以下 AgentFlux 工具，冲突错误是预期结果，收到错误后继续下一步。",
			`1) 调用 flux_workflow action=run，task=\"只读检查 README.md\"；这次必须记录工具返回的跨空间错误。`,
			`2) 调用 flux_issue action=claim，issueId=\"${fixture.issueIds[2]}\"，agent=\"main-conflict\"，scope=\"conflict\"；这次也必须记录工具返回的跨空间错误。`,
			"3) 两次调用都收到错误后只输出 P0_02_MAIN_CONFLICT_OK。",
		].join("\n"), config, config.mainModel, CONFLICT_WAIT_MS + 60_000);
		handles.push(mainConflict);

		const mainB = launch("main-b", extensionEntry, [
			"必须实际调用 AgentFlux flux_agent 工具，不要自行完成任务。",
			"1) action=create，name=p0-02-main-b，role=implementer，scope=project。",
			`2) action=run，agent=p0-02-main-b，background=false，task=${mainHoldTask("MAIN_SPACE_B_RUN_DONE")}`,
			"3) run 返回后只输出 P0_02_MAIN_B_OK。",
		].join("\n"), config, config.mainModel, CONFLICT_WAIT_MS + 60_000);
		handles.push(mainB);
		await waitFor(() => activeEntriesByContext("main").length >= 2, 90_000, "parallel Main space leases");
		const mainActiveSnapshot = activeEntriesByContext("main").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, context: entry.context }));
		const mainFailure = launch("main-failure", extensionEntry, [
			"必须实际调用 AgentFlux 工具；预期的错误不能改用其他工具替代。",
			"1) flux_agent action=create，name=main-failure，role=implementer，不传 model。",
			"2) flux_agent action=run，agent=main-failure，background=false，model=nonexistent-p0-02-model，task=预期模型校验失败。",
			"3) 收到 Unknown model 错误后只输出 P0_02_MAIN_FAILURE_OK。",
		].join("\n"), config);
		handles.push(mainFailure);
		const mainFailureObservation = await waitForToolWhileContext(mainFailure, "flux_agent", "main", CONFLICT_WAIT_MS, "run");
		const mainFailureResult = await mainFailure.result;
		const activeAfterMainFailure = activeEntriesByContext("main").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, context: entry.context }));
		const mainFailureErrors = toolErrors(mainFailureResult.stdout, "flux_agent");
		const mainFailureFacts = runtimeSnapshot().runs.filter((run: any) => run.agent === "main-failure");
		const siblingsPreserved = mainActiveSnapshot.length >= 2 && mainActiveSnapshot.every(before =>
			mainFailureObservation.activeEntries.some((entry: any) => entry.leaseId === before.leaseId && entry.pid === before.pid)
			&& activeAfterMainFailure.some(entry => entry.leaseId === before.leaseId && entry.pid === before.pid)
			&& isProcessAlive(before.pid));
		const mainConflictWorkflowObservationPromise = waitForToolWhileContext(mainConflict, "flux_workflow", "main");
		const mainConflictIssueObservationPromise = waitForToolWhileContext(mainConflict, "flux_issue", "main");
		const [mainConflictWorkflowObservation, mainConflictIssueObservation] = await Promise.all([
			mainConflictWorkflowObservationPromise,
			mainConflictIssueObservationPromise,
		]);
		const mainConflictResult = await mainConflict.result;
		writeFileSync(join(fixtureRoot, ".agentflux", "main-holders-release"), "release after failure and conflicts observed");
		const [mainAResult, mainBResult] = await Promise.all([mainA.result, mainB.result]);
		await waitFor(() => activeEntriesByContext("main").length === 0, 30_000, "Main holder cleanup before failure scenario");
		const mainIssueFailure = launch("main-issue-failure", extensionEntry, [
			"必须调用 flux_issue action=claim，issueId=missing-main-failure-issue，agent=main-issue-failure，scope=failure。",
			"收到 Issue not found 错误后只输出 P0_02_MAIN_ISSUE_FAILURE_OK。",
		].join("\n"), config);
		handles.push(mainIssueFailure);
		const mainIssueFailureResult = await mainIssueFailure.result;
		const mainIssueFailureErrors = toolErrors(mainIssueFailureResult.stdout, "flux_issue");
		const mainConflictWorkflowErrors = toolErrors(mainConflictResult.stdout, "flux_workflow");
		const mainConflictIssueErrors = toolErrors(mainConflictResult.stdout, "flux_issue");
		evidence.mainPhase = {
			activeBeforeConflict: mainActiveSnapshot,
			activeAfterFailedRun: activeAfterMainFailure,
			failedRunErrors: mainFailureErrors,
			failedRunFacts: mainFailureFacts,
			failedRunObservation: mainFailureObservation,
			siblingsPreserved,
			issueFailure: { process: compactResult(mainIssueFailureResult, EXPECTED_MARKERS["main-issue-failure"]), errors: mainIssueFailureErrors },
			processes: [compactResult(mainAResult, EXPECTED_MARKERS["main-a"]), compactResult(mainBResult, EXPECTED_MARKERS["main-b"]), compactResult(mainConflictResult, EXPECTED_MARKERS["main-conflict"]), compactResult(mainFailureResult, EXPECTED_MARKERS["main-failure"])],
			parallelMainCountObserved: 2,
			conflict: {
				workflowCalls: toolCalls(mainConflictResult.stdout, "flux_workflow"),
				workflowErrors: mainConflictWorkflowErrors,
				issueCalls: toolCalls(mainConflictResult.stdout, "flux_issue"),
				issueErrors: mainConflictIssueErrors,
				workflowObservation: mainConflictWorkflowObservation,
				issueObservation: mainConflictIssueObservation,
			},
			passed: mainAResult.exitCode === 0 && mainBResult.exitCode === 0 && mainConflictResult.exitCode === 0 && mainFailureResult.exitCode === 0
				&& !mainAResult.timedOut && !mainBResult.timedOut && !mainConflictResult.timedOut && !mainFailureResult.timedOut
				&& marker(mainAResult, "P0_02_MAIN_A_OK") && marker(mainBResult, "P0_02_MAIN_B_OK") && marker(mainConflictResult, "P0_02_MAIN_CONFLICT_OK") && marker(mainFailureResult, "P0_02_MAIN_FAILURE_OK")
				&& mainFailureErrors.some(item => JSON.stringify(item).includes("Unknown model: nonexistent-p0-02-model"))
				&& mainFailureFacts.length === 0
				&& siblingsPreserved && activeAfterMainFailure.length >= 2
				&& mainIssueFailureResult.exitCode === 0 && !mainIssueFailureResult.timedOut
				&& marker(mainIssueFailureResult, EXPECTED_MARKERS["main-issue-failure"])
				&& mainIssueFailureErrors.some(item => JSON.stringify(item).includes("Issue not found: missing-main-failure-issue"))
				&& mainConflictWorkflowObservation.activeEntries.length >= 1
				&& mainConflictIssueObservation.activeEntries.length >= 1
				&& mainConflictWorkflowErrors.some(item => JSON.stringify(item).includes("active main space"))
				&& mainConflictIssueErrors.some(item => JSON.stringify(item).includes("active main space")),
		};
		await waitFor(() => activeEntries().length === 0, 30_000, "Main space lease cleanup");

		// Phase 2: two Community Claims share the same space; Workflow is rejected while they live.
		const communityA = launch("community-a", extensionEntry, [
			"必须实际调用 AgentFlux flux_issue 工具，不要自行完成任务。",
			`1) action=claim，issueId=\"${fixture.issueIds[0]}\"，agent=\"community-a\"，scope=\"scope-a\"。`,
			`2) claim 成功后调用 bash 执行 node -e "setTimeout(() => {}, ${COMMUNITY_HOLD_MS})"，等待命令完成。`,
			"3) 最后只输出 P0_02_COMMUNITY_A_OK。",
		].join("\n"), config, config.mainModel, CONFLICT_WAIT_MS + 60_000);
		handles.push(communityA);
		await waitFor(() => activeEntriesByContext("community").length >= 1, 60_000, "first Community space lease");
		const communityB = launch("community-b", extensionEntry, [
			"必须实际调用 AgentFlux flux_issue 工具，不要自行完成任务。",
			`1) action=claim，issueId=\"${fixture.issueIds[1]}\"，agent=\"community-b\"，scope=\"scope-b\"。`,
			`2) claim 成功后调用 bash 执行 node -e "setTimeout(() => {}, ${COMMUNITY_HOLD_MS})"，等待命令完成。`,
			"3) 最后只输出 P0_02_COMMUNITY_B_OK。",
		].join("\n"), config, config.mainModel, CONFLICT_WAIT_MS + 60_000);
		handles.push(communityB);
		await waitFor(() => activeEntriesByContext("community").length >= 2, 60_000, "parallel Community space leases");
		const communityActiveSnapshot = activeEntriesByContext("community").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, scope: entry.scope }));
		const communityFailure = launch("community-failure", extensionEntry, [
			"必须实际调用 flux_issue 工具；这次 claim 预期因相同 scope 已被占用而失败，记录显式错误后只输出 P0_02_COMMUNITY_FAILURE_OK。",
			`调用 action=claim，issueId=\"${fixture.issueIds[0]}\"，agent=\"community-failure\"，scope=\"scope-a\"。`,
		].join("\n"), config);
		handles.push(communityFailure);
		const communityFailureResult = await communityFailure.result;
		const communityAfterFailedClaim = activeEntriesByContext("community").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, scope: entry.scope }));
		const communityFailureErrors = toolErrors(communityFailureResult.stdout, "flux_issue");
		const communityConflict = launch("community-conflict", extensionEntry, [
			"必须实际调用 flux_workflow 工具；跨空间错误是预期结果，收到后只输出 P0_02_COMMUNITY_CONFLICT_OK。",
			"调用 action=run，task=\"只读检查 README.md\"，记录显式错误后输出标记。",
		].join("\n"), config, config.mainModel, CONFLICT_WAIT_MS + 60_000);
		handles.push(communityConflict);
		const communityConflictObservation = await waitForToolWhileContext(communityConflict, "flux_workflow", "community");
		const [communityAResult, communityBResult, communityConflictResult] = await Promise.all([communityA.result, communityB.result, communityConflict.result]);
		const communityWorkflowErrors = toolErrors(communityConflictResult.stdout, "flux_workflow");
		evidence.communityPhase = {
			activeBeforeConflict: communityActiveSnapshot,
			activeAfterFailedClaim: communityAfterFailedClaim,
			failedClaimErrors: communityFailureErrors,
			processes: [compactResult(communityAResult, EXPECTED_MARKERS["community-a"]), compactResult(communityBResult, EXPECTED_MARKERS["community-b"]), compactResult(communityConflictResult, EXPECTED_MARKERS["community-conflict"]), compactResult(communityFailureResult, EXPECTED_MARKERS["community-failure"])],
			parallelCommunityCountObserved: 2,
			conflict: { workflowCalls: toolCalls(communityConflictResult.stdout, "flux_workflow"), workflowErrors: communityWorkflowErrors, observation: communityConflictObservation },
			passed: communityAResult.exitCode === 0 && communityBResult.exitCode === 0 && communityConflictResult.exitCode === 0 && communityFailureResult.exitCode === 0
				&& !communityAResult.timedOut && !communityBResult.timedOut && !communityConflictResult.timedOut && !communityFailureResult.timedOut
				&& marker(communityAResult, "P0_02_COMMUNITY_A_OK") && marker(communityBResult, "P0_02_COMMUNITY_B_OK") && marker(communityConflictResult, "P0_02_COMMUNITY_CONFLICT_OK") && marker(communityFailureResult, "P0_02_COMMUNITY_FAILURE_OK")
				&& communityFailureErrors.some(item => JSON.stringify(item).includes("Scope already claimed"))
				&& communityAfterFailedClaim.length >= 2
				&& communityConflictObservation.activeEntries.length >= 2
				&& communityWorkflowErrors.some(item => JSON.stringify(item).includes("active community space")),
		};
		await waitFor(() => activeEntries().length === 0, 30_000, "Community space lease cleanup");

		// Phase 3: a real Workflow lease rejects a Community Claim.
		const workflowPi = launch("workflow", extensionEntry, [
			"必须实际调用 AgentFlux flux_workflow 工具，不要自行完成任务。",
			`调用 action=reuse，workflow=\"${fixture.workflowId}\"，task=\"执行 P0-02 空间互斥流程\"；等待流程结束后只输出 P0_02_WORKFLOW_OK。`,
		].join("\n"), config, config.plannerModel, CONFLICT_WAIT_MS + 60_000);
		handles.push(workflowPi);
		await waitFor(() => activeEntriesByContext("workflow").length >= 1, 90_000, "Workflow space lease");
		const workflowActiveSnapshot = activeEntriesByContext("workflow").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, scope: entry.scope }));
		// Launch the conflicting Pi immediately after the lease is observed, then wait
		// for the actual tool_execution_start while the Workflow lease remains live.
		const workflowConflict = launch("workflow-community-conflict", extensionEntry, [
			"必须实际调用 flux_issue 工具；跨空间错误是预期结果，收到后只输出 P0_02_WORKFLOW_CONFLICT_OK。",
			`调用 action=claim，issueId=\"${fixture.issueIds[2]}\"，agent=\"workflow-conflict\"，scope=\"workflow-conflict\"，记录显式错误后输出标记。`,
		].join("\n"), config, config.mainModel, CONFLICT_WAIT_MS + 60_000);
		handles.push(workflowConflict);
		const workflowFailure = launch("workflow-failure", extensionEntry, [
			"必须实际调用 flux_workflow 工具；这次 reuse 预期因不存在的 selector 失败，记录显式工具错误后只输出 P0_02_WORKFLOW_FAILURE_OK。",
			"调用 action=reuse，workflow=\"workflow-does-not-exist\"，task=\"失败隔离检查\"。",
		].join("\n"), config);
		handles.push(workflowFailure);
		const workflowConflictObservation = await waitForToolWhileContext(workflowConflict, "flux_issue", "workflow", CONFLICT_WAIT_MS);
		const workflowFailureResult = await workflowFailure.result;
		const workflowAfterFailedRun = activeEntriesByContext("workflow").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, scope: entry.scope }));
		const [workflowResult, workflowConflictResult] = await Promise.all([workflowPi.result, workflowConflict.result]);
		const workflowFailureErrors = toolErrors(workflowFailureResult.stdout, "flux_workflow");
		const workflowIssueErrors = toolErrors(workflowConflictResult.stdout, "flux_issue");
		evidence.workflowPhase = {
			activeBeforeConflict: workflowActiveSnapshot,
			conflictObservation: workflowConflictObservation,
			activeAfterFailedRun: workflowAfterFailedRun,
			failedRunErrors: workflowFailureErrors,
			processes: [compactResult(workflowResult, EXPECTED_MARKERS.workflow), compactResult(workflowConflictResult, EXPECTED_MARKERS["workflow-community-conflict"]), compactResult(workflowFailureResult, EXPECTED_MARKERS["workflow-failure"])],
			conflict: { issueCalls: toolCalls(workflowConflictResult.stdout, "flux_issue"), issueErrors: workflowIssueErrors },
			passed: workflowResult.exitCode === 0 && workflowConflictResult.exitCode === 0 && workflowFailureResult.exitCode === 0
				&& !workflowResult.timedOut && !workflowConflictResult.timedOut && !workflowFailureResult.timedOut
				&& marker(workflowResult, "P0_02_WORKFLOW_OK") && marker(workflowConflictResult, "P0_02_WORKFLOW_CONFLICT_OK") && marker(workflowFailureResult, "P0_02_WORKFLOW_FAILURE_OK")
				&& workflowFailureErrors.some(item => JSON.stringify(item).includes("Workflow not found"))
				&& workflowAfterFailedRun.length >= 1
				&& workflowConflictObservation.activeEntries.length >= 1
				&& workflowIssueErrors.some(item => JSON.stringify(item).includes("active workflow space")),
		};
		await waitFor(() => activeEntries().length === 0, 30_000, "Workflow space lease cleanup");

		const coreFacts = snapshotP002CoreFacts(fixtureRoot, fixture.issueIds, fixture.workflowId, EXPECTED_TERMINAL_OUTCOMES);
		const terminalChecksByLabel = new Map<string, any>((coreFacts.terminalOutcomes?.checks ?? []).map((check: any) => [check.label, check]));
		for (const [phaseName, labels] of Object.entries(TERMINAL_OUTCOME_PHASES) as Array<[keyof typeof TERMINAL_OUTCOME_PHASES, string[]]>) {
			const checks = labels.map(label => terminalChecksByLabel.get(label) ?? { label, passed: false, missing: true });
			const phase = evidence[phaseName];
			phase.terminalOutcomes = checks;
			phase.passed = phase.passed === true && checks.every(check => check.passed === true);
		}
		const outputEvidence = [...outputEvidenceByLabel.values()];
		const outputEvidenceConsistency = validateProcessOutputEvidence(outputEvidence, EXPECTED_MARKERS, sourceRoot);
		Object.assign(evidence, coreFacts, { outputEvidence, outputEvidenceConsistency });
		evidence.updatedAt = new Date().toISOString();
		evidence.wallClockMs = Date.now() - startedAt;
		evidence.finalActiveEntries = coreFacts.activeContextAtSnapshot;
		evidence.passed = evidence.mainPhase.passed && evidence.communityPhase.passed && evidence.workflowPhase.passed
			&& evidence.finalActiveEntries.length === 0
			&& coreFacts.coreFactConsistency.passed
			&& outputEvidenceConsistency.passed;
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		if (!evidence.passed) throw new Error(`P0-02 live space isolation evidence failed; report=${reportPath}`);
		console.log(JSON.stringify(evidence, null, 2));
	} catch (error) {
		persistPartialOutputEvidence(handles);
		evidence.outputEvidence = [...outputEvidenceByLabel.values()];
		evidence.outputEvidenceConsistency = validateProcessOutputEvidence(evidence.outputEvidence, EXPECTED_MARKERS, sourceRoot);
		try {
			if (fixture) Object.assign(evidence, snapshotP002CoreFacts(fixtureRoot, fixture.issueIds, fixture.workflowId, EXPECTED_TERMINAL_OUTCOMES));
		} catch (snapshotError) {
			evidence.coreFactsSnapshotError = String(snapshotError instanceof Error ? snapshotError.message : snapshotError);
		}
		evidence.updatedAt = new Date().toISOString();
		evidence.wallClockMs = Date.now() - startedAt;
		try { evidence.finalActiveEntries = activeEntries(); } catch { evidence.finalActiveEntries = []; }
		evidence.passed = false;
		evidence.error = String(error instanceof Error ? error.message : error);
		try {
			writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
			writeFileSync(failureReportPath, JSON.stringify({ ...evidence, failureReportPath }, null, 2));
		} catch {}
		throw error;
	} finally {
		persistPartialOutputEvidence(handles);
		for (const handle of handles) stopTree(handle.child);
		let cleanupError: string | undefined;
		try {
			await waitFor(() => handles.every(handle => !handle.child.pid || !isProcessAlive(handle.child.pid)), 10_000, "owned Pi process exit");
			config.cleanup();
		} catch (error) { cleanupError = String(error instanceof Error ? error.message : error); }
		evidence.cleanup = {
			workspacePath: fixtureRoot,
			workspaceRemoved: false,
			workspaceRetainedForAudit: true,
			processes: handles.map(handle => ({ label: handle.label, pid: handle.child.pid, alive: handle.child.pid ? isProcessAlive(handle.child.pid) : false })),
			artifactDirectory: outputArtifactRoot,
			passed: !cleanupError,
			error: cleanupError ?? null,
		};
		if (cleanupError && evidence.passed) {
			evidence.passed = false;
			evidence.error = cleanupError;
		}
		try {
			writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
			if (evidence.passed !== true) writeFileSync(failureReportPath, JSON.stringify({ ...evidence, failureReportPath }, null, 2));
		} catch (error) { console.warn(`P0-02 report finalization failed: ${String(error)}`); }
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
