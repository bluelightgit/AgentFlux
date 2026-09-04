import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createIssue } from "../../src/core/community";
import { readActiveContext } from "../../src/core/active-context";
import { createWorkflowDefinition } from "../../src/workflows/workflow-registry";
import type { TaskDAG } from "../../src/workflows/dag-executor";
import { loadLiveConfig, type LiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";

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
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const ACTIVE = new Set(["starting", "running", "stop_requested"]);
const WORKFLOW_HOLD_MS = 180_000;
const WORKFLOW_CONFLICT_WAIT_MS = 240_000;

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
	child: ChildProcess;
	result: Promise<PiResult>;
	snapshot(): { stdout: string; stderr: string };
}

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
	if (!child.pid) return;
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
	const args = [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "read,grep,find,ls,bash,flux_agent,flux_workflow,flux_issue",
		...config.cliArgs(model), prompt,
	];
	const child = spawn(process.execPath, args, {
		cwd: fixtureRoot,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: config.env,
	});
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
	return { child, result, snapshot: () => ({ stdout, stderr }) };
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
	toolExecutionStart: any;
	activeWorkflowEntries: any[];
}

/**
 * 等待真实 flux_issue 工具开始执行，并在同一时刻确认 Workflow lease 仍活跃。
 * 仅等待冲突 Pi 进程启动或在完整 stdout 中搜索 call 都无法证明因果关系。
 */
async function waitForWorkflowCommunityConflict(handle: PiHandle, timeoutMs = 240_000): Promise<ConflictObservation> {
	let observation: ConflictObservation | undefined;
	await waitFor(() => {
		const starts = toolExecutionStarts(handle.snapshot().stdout, "flux_issue");
		if (starts.length === 0) return false;
		const activeWorkflowEntries = activeEntriesByContext("workflow");
		observation = {
			observedAt: new Date().toISOString(),
			toolExecutionStart: starts.at(-1),
			activeWorkflowEntries,
		};
		if (activeWorkflowEntries.length === 0) {
			throw new Error("Workflow→Community conflict tool call started after the Workflow lease ended");
		}
		return true;
	}, timeoutMs, "real Workflow→Community flux_issue call while Workflow lease is active");
	if (!observation) throw new Error("Workflow→Community conflict observation was not captured");
	return observation;
}

function compactResult(result: PiResult): any {
	return {
		label: result.label,
		pid: result.pid,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		stdoutTail: result.stdout.slice(-5000),
		stderrTail: result.stderr.slice(-3000),
	};
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
	};
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("P0-02 live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	try {
		const fixture = setup(config);
		const extensionEntry = join(fixtureRoot, "dist", "extension", "entry.js");

		// Phase 1: Main space, then a real cross-space rejection and a same-space parallel Run.
		const mainA = launch("main-a", extensionEntry, [
			"必须实际调用 AgentFlux flux_agent 工具，不要自行完成任务。",
			"1) action=create，name=p0-02-main-a，role=implementer，scope=project。",
			"2) action=run，agent=p0-02-main-a，background=false，task=必须调用 bash 执行 node -e \"setTimeout(() => {}, 25000)\"，等待命令完成后只回复 MAIN_SPACE_A_RUN_DONE。",
			"3) run 返回后只输出 P0_02_MAIN_A_OK。",
		].join("\n"), config, config.mainModel, 180_000);
		handles.push(mainA);
		await waitFor(() => activeEntriesByContext("main").length >= 1, 90_000, "first Main space lease");

		const mainConflict = launch("main-conflict", extensionEntry, [
			"必须严格实际调用以下 AgentFlux 工具，冲突错误是预期结果，收到错误后继续下一步。",
			`1) 调用 flux_workflow action=run，task=\"只读检查 README.md\"；这次必须记录工具返回的跨空间错误。`,
			`2) 调用 flux_issue action=claim，issueId=\"${fixture.issueIds[2]}\"，agent=\"main-conflict\"，scope=\"conflict\"；这次也必须记录工具返回的跨空间错误。`,
			"3) 两次调用都收到错误后只输出 P0_02_MAIN_CONFLICT_OK。",
		].join("\n"), config);
		handles.push(mainConflict);

		const mainB = launch("main-b", extensionEntry, [
			"必须实际调用 AgentFlux flux_agent 工具，不要自行完成任务。",
			"1) action=create，name=p0-02-main-b，role=implementer，scope=project。",
			"2) action=run，agent=p0-02-main-b，background=false，task=必须调用 bash 执行 node -e \"setTimeout(() => {}, 22000)\"，等待命令完成后只回复 MAIN_SPACE_B_RUN_DONE。",
			"3) run 返回后只输出 P0_02_MAIN_B_OK。",
		].join("\n"), config, config.mainModel, 180_000);
		handles.push(mainB);
		await waitFor(() => activeEntriesByContext("main").length >= 2, 90_000, "parallel Main space leases");
		const mainActiveSnapshot = activeEntriesByContext("main").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, context: entry.context }));
		const mainFailure = launch("main-failure", extensionEntry, [
			"必须实际调用 AgentFlux flux_agent 工具，不要自行完成任务。",
			"1) action=create，name=p0-02-main-failure，role=implementer，scope=project。",
			"2) action=run，agent=p0-02-main-failure，model=unknown-live-model，background=false，task=这次模型覆盖预期无效；记录 flux_agent 的显式错误后只回复 MAIN_FAILURE_RUN_DONE。",
			"3) run 返回后只输出 P0_02_MAIN_FAILURE_OK。",
		].join("\n"), config);
		handles.push(mainFailure);
		const mainFailureResult = await mainFailure.result;
		const activeAfterMainFailure = activeEntriesByContext("main").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, context: entry.context }));
		const mainFailureErrors = toolErrors(mainFailureResult.stdout, "flux_agent");
		const mainFailureFacts = runtimeSnapshot().runs.filter((run: any) => run.agent === "p0-02-main-failure");
		const [mainConflictResult, mainAResult, mainBResult] = await Promise.all([mainConflict.result, mainA.result, mainB.result]);
		const mainConflictWorkflowErrors = toolErrors(mainConflictResult.stdout, "flux_workflow");
		const mainConflictIssueErrors = toolErrors(mainConflictResult.stdout, "flux_issue");
		evidence.mainPhase = {
			activeBeforeConflict: mainActiveSnapshot,
			activeAfterFailedRun: activeAfterMainFailure,
			failedRunErrors: mainFailureErrors,
			failedRunFacts: mainFailureFacts,
			processes: [compactResult(mainAResult), compactResult(mainBResult), compactResult(mainConflictResult), compactResult(mainFailureResult)],
			parallelMainCountObserved: 2,
			conflict: {
				workflowCalls: toolCalls(mainConflictResult.stdout, "flux_workflow"),
				workflowErrors: mainConflictWorkflowErrors,
				issueCalls: toolCalls(mainConflictResult.stdout, "flux_issue"),
				issueErrors: mainConflictIssueErrors,
			},
			passed: mainAResult.exitCode === 0 && mainBResult.exitCode === 0 && mainConflictResult.exitCode === 0 && mainFailureResult.exitCode === 0
				&& !mainAResult.timedOut && !mainBResult.timedOut && !mainConflictResult.timedOut && !mainFailureResult.timedOut
				&& marker(mainAResult, "P0_02_MAIN_A_OK") && marker(mainBResult, "P0_02_MAIN_B_OK") && marker(mainConflictResult, "P0_02_MAIN_CONFLICT_OK") && marker(mainFailureResult, "P0_02_MAIN_FAILURE_OK")
				&& mainFailureErrors.some(item => JSON.stringify(item).includes("Unknown model: unknown-live-model"))
				&& mainFailureFacts.length === 0
				&& activeAfterMainFailure.length >= 2 && activeAfterMainFailure.every(entry => entry.pid !== mainFailureResult.pid)
				&& mainConflictWorkflowErrors.some(item => JSON.stringify(item).includes("main 空间活跃"))
				&& mainConflictIssueErrors.some(item => JSON.stringify(item).includes("main 空间活跃")),
		};
		await waitFor(() => activeEntries().length === 0, 30_000, "Main space lease cleanup");

		// Phase 2: two Community Claims share the same space; Workflow is rejected while they live.
		const communityA = launch("community-a", extensionEntry, [
			"必须实际调用 AgentFlux flux_issue 工具，不要自行完成任务。",
			`1) action=claim，issueId=\"${fixture.issueIds[0]}\"，agent=\"community-a\"，scope=\"scope-a\"。`,
			"2) claim 成功后调用 bash 执行 node -e \"setTimeout(() => {}, 20000)\"，等待命令完成。",
			"3) 最后只输出 P0_02_COMMUNITY_A_OK。",
		].join("\n"), config);
		handles.push(communityA);
		await waitFor(() => activeEntriesByContext("community").length >= 1, 60_000, "first Community space lease");
		const communityB = launch("community-b", extensionEntry, [
			"必须实际调用 AgentFlux flux_issue 工具，不要自行完成任务。",
			`1) action=claim，issueId=\"${fixture.issueIds[1]}\"，agent=\"community-b\"，scope=\"scope-b\"。`,
			"2) claim 成功后调用 bash 执行 node -e \"setTimeout(() => {}, 18000)\"，等待命令完成。",
			"3) 最后只输出 P0_02_COMMUNITY_B_OK。",
		].join("\n"), config);
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
		].join("\n"), config);
		handles.push(communityConflict);
		const [communityAResult, communityBResult, communityConflictResult] = await Promise.all([communityA.result, communityB.result, communityConflict.result]);
		const communityWorkflowErrors = toolErrors(communityConflictResult.stdout, "flux_workflow");
		evidence.communityPhase = {
			activeBeforeConflict: communityActiveSnapshot,
			activeAfterFailedClaim: communityAfterFailedClaim,
			failedClaimErrors: communityFailureErrors,
			processes: [compactResult(communityAResult), compactResult(communityBResult), compactResult(communityConflictResult), compactResult(communityFailureResult)],
			parallelCommunityCountObserved: 2,
			conflict: { workflowCalls: toolCalls(communityConflictResult.stdout, "flux_workflow"), workflowErrors: communityWorkflowErrors },
			passed: communityAResult.exitCode === 0 && communityBResult.exitCode === 0 && communityConflictResult.exitCode === 0 && communityFailureResult.exitCode === 0
				&& !communityAResult.timedOut && !communityBResult.timedOut && !communityConflictResult.timedOut && !communityFailureResult.timedOut
				&& marker(communityAResult, "P0_02_COMMUNITY_A_OK") && marker(communityBResult, "P0_02_COMMUNITY_B_OK") && marker(communityConflictResult, "P0_02_COMMUNITY_CONFLICT_OK") && marker(communityFailureResult, "P0_02_COMMUNITY_FAILURE_OK")
				&& communityFailureErrors.some(item => JSON.stringify(item).includes("Scope already claimed"))
				&& communityAfterFailedClaim.length >= 2
				&& communityWorkflowErrors.some(item => JSON.stringify(item).includes("community 空间活跃")),
		};
		await waitFor(() => activeEntries().length === 0, 30_000, "Community space lease cleanup");

		// Phase 3: a real Workflow lease rejects a Community Claim.
		const workflowPi = launch("workflow", extensionEntry, [
			"必须实际调用 AgentFlux flux_workflow 工具，不要自行完成任务。",
			`调用 action=reuse，workflow=\"${fixture.workflowId}\"，task=\"执行 P0-02 空间互斥流程\"；等待流程结束后只输出 P0_02_WORKFLOW_OK。`,
		].join("\n"), config, config.plannerModel, WORKFLOW_CONFLICT_WAIT_MS + 60_000);
		handles.push(workflowPi);
		await waitFor(() => activeEntriesByContext("workflow").length >= 1, 90_000, "Workflow space lease");
		const workflowActiveSnapshot = activeEntriesByContext("workflow").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, scope: entry.scope }));
		// Launch the conflicting Pi immediately after the lease is observed, then wait
		// for the actual tool_execution_start while the Workflow lease remains live.
		const workflowConflict = launch("workflow-community-conflict", extensionEntry, [
			"必须实际调用 flux_issue 工具；跨空间错误是预期结果，收到后只输出 P0_02_WORKFLOW_CONFLICT_OK。",
			`调用 action=claim，issueId=\"${fixture.issueIds[2]}\"，agent=\"workflow-conflict\"，scope=\"workflow-conflict\"，记录显式错误后输出标记。`,
		].join("\n"), config, config.mainModel, WORKFLOW_CONFLICT_WAIT_MS + 60_000);
		handles.push(workflowConflict);
		const workflowFailure = launch("workflow-failure", extensionEntry, [
			"必须实际调用 flux_workflow 工具；这次 reuse 预期因不存在的 selector 失败，记录显式工具错误后只输出 P0_02_WORKFLOW_FAILURE_OK。",
			"调用 action=reuse，workflow=\"workflow-does-not-exist\"，task=\"失败隔离检查\"。",
		].join("\n"), config);
		handles.push(workflowFailure);
		const workflowConflictObservation = await waitForWorkflowCommunityConflict(workflowConflict, WORKFLOW_CONFLICT_WAIT_MS);
		const [workflowResult, workflowConflictResult, workflowFailureResult] = await Promise.all([workflowPi.result, workflowConflict.result, workflowFailure.result]);
		const workflowAfterFailedRun = activeEntriesByContext("workflow").map(entry => ({ leaseId: entry.leaseId, name: entry.name, pid: entry.pid, scope: entry.scope }));
		const workflowFailureErrors = toolErrors(workflowFailureResult.stdout, "flux_workflow");
		const workflowIssueErrors = toolErrors(workflowConflictResult.stdout, "flux_issue");
		evidence.workflowPhase = {
			activeBeforeConflict: workflowActiveSnapshot,
			conflictObservation: workflowConflictObservation,
			activeAfterFailedRun: workflowAfterFailedRun,
			failedRunErrors: workflowFailureErrors,
			processes: [compactResult(workflowResult), compactResult(workflowConflictResult), compactResult(workflowFailureResult)],
			conflict: { issueCalls: toolCalls(workflowConflictResult.stdout, "flux_issue"), issueErrors: workflowIssueErrors },
			passed: workflowResult.exitCode === 0 && workflowConflictResult.exitCode === 0 && workflowFailureResult.exitCode === 0
				&& !workflowResult.timedOut && !workflowConflictResult.timedOut && !workflowFailureResult.timedOut
				&& marker(workflowResult, "P0_02_WORKFLOW_OK") && marker(workflowConflictResult, "P0_02_WORKFLOW_CONFLICT_OK") && marker(workflowFailureResult, "P0_02_WORKFLOW_FAILURE_OK")
				&& workflowFailureErrors.some(item => JSON.stringify(item).includes("Workflow not found"))
				&& workflowAfterFailedRun.length >= 1
				&& workflowConflictObservation.activeWorkflowEntries.length >= 1
				&& workflowIssueErrors.some(item => JSON.stringify(item).includes("workflow 空间活跃")),
		};
		await waitFor(() => activeEntries().length === 0, 30_000, "Workflow space lease cleanup");

		evidence.updatedAt = new Date().toISOString();
		evidence.wallClockMs = Date.now() - startedAt;
		evidence.finalActiveEntries = activeEntries();
		evidence.passed = evidence.mainPhase.passed && evidence.communityPhase.passed && evidence.workflowPhase.passed && evidence.finalActiveEntries.length === 0;
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		if (!evidence.passed) throw new Error(`P0-02 live space isolation evidence failed; report=${reportPath}`);
		console.log(JSON.stringify(evidence, null, 2));
	} catch (error) {
		evidence.updatedAt = new Date().toISOString();
		evidence.wallClockMs = Date.now() - startedAt;
		evidence.finalActiveEntries = activeEntries();
		evidence.passed = false;
		evidence.error = String(error instanceof Error ? error.message : error);
		try {
			writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
			writeFileSync(failureReportPath, JSON.stringify({ ...evidence, failureReportPath }, null, 2));
		} catch {}
		throw error;
	} finally {
		for (const handle of handles) stopTree(handle.child);
		try { rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (error) { console.warn(`P0-02 fixture cleanup deferred: ${String(error)}`); }
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
