import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getPiCliPath, loadLiveConfig, type LiveConfig } from "./live-config";
import {
	compactError,
	isPidAlive,
	isSafeChildPath,
	persistCoreSmokeProcessEvidence,
	portableReportPath,
	productionDistEvidence,
	snapshotCoreSmokeFacts,
	stopOwnedProcess,
	validateCoreSmokeCase,
	waitForOwnedProcesses,
	type CoreSmokeCaseExpectation,
	type CoreSmokeFacts,
	type CoreSmokeProcessHandle,
	type CoreSmokeProcessResult,
} from "../helpers/core-smoke-evidence";

/**
 * 默认 Core live smoke：每个场景都是一个全新 print Pi，但四个场景共享同一个
 * 保留 fixture，以便报告同时看到 Main Task/Execution、Agent Run、Workflow 和 Issue。
 * Pi 只加载本轮 production dist 的两个入口；模型执行没有默认 wall-clock deadline，
 * 外层 watchdog 仅负责测试进程收敛并在退出回执中单独标注。
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const piCli = getPiCliPath();
const resultsRoot = join(sourceRoot, ".agentflux", "test-results");
const workspaceRoot = join(sourceRoot, ".agentflux", "test-workspaces");
const runId = `${Date.now()}-${process.pid}-${randomUUID()}`;
const requestedIteration = (process.env.AGENTFLUX_LIVE_ITERATION?.trim() || "core-smoke").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64);
const iteration = `${requestedIteration}-${runId}`;
const fixtureRoot = join(workspaceRoot, `core-live-${iteration}`);
const artifactRoot = join(resultsRoot, `core-smoke-artifacts-${iteration}`);
const reportPath = join(resultsRoot, `core-smoke-${iteration}.json`);
const latestReportPath = join(resultsRoot, "core-live-latest.json");
const failureReportPath = join(resultsRoot, `core-smoke-failed-${iteration}.json`);
const supervisorExitPath = join(artifactRoot, "supervisor-exit.json");
const watchdogTimeoutMs = 300_000;

const MARKERS: Record<string, string> = {
	direct: "CORE_SMOKE_DIRECT_OK",
	agents: "CORE_SMOKE_AGENTS_OK",
	workflow: "CORE_SMOKE_WORKFLOW_OK",
	community: "CORE_SMOKE_COMMUNITY_OK",
};

type SmokeCase = keyof typeof MARKERS;
const CASE_ORDER: SmokeCase[] = ["direct", "agents", "workflow", "community"];

interface PiHandle extends CoreSmokeProcessHandle {
	child: ChildProcess;
}

let config: LiveConfig | undefined;
let fixtureReady = false;
const handles: PiHandle[] = [];
const processEvidence = new Map<string, any>();
let evidence: any = {
	status: "running",
	iteration,
	startedAt: new Date().toISOString(),
	fixtureRoot,
	outputArtifactDirectory: artifactRoot,
	reportPaths: { unique: reportPath, latest: latestReportPath, failure: failureReportPath },
	watchdog: { kind: "fixture-process-watchdog", timeoutMs: watchdogTimeoutMs },
	modelDeadline: null,
	fixtureBudget: { max_wall_clock_seconds: null },
	cases: [],
	passed: false,
};

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trimEnd(); }
	catch { return ""; }
}

function writeReport(status: "running" | "passed" | "failed", error?: unknown): void {
	evidence.status = status;
	evidence.updatedAt = new Date().toISOString();
	if (error !== undefined) evidence.error = compactError(error);
	const serialized = JSON.stringify(evidence, null, 2);
	mkdirSync(resultsRoot, { recursive: true });
	writeFileSync(reportPath, serialized, "utf8");
	// latest is a convenience pointer; the iteration-specific report is never overwritten.
	writeFileSync(latestReportPath, serialized, "utf8");
	if (status === "failed") writeFileSync(failureReportPath, serialized, "utf8");
}

function selectedCases(): SmokeCase[] {
	const requested = (process.env.AGENTFLUX_LIVE_CASES ?? "direct,agents,workflow,community")
		.split(",").map(value => value.trim()).filter(Boolean);
	const unknown = requested.filter(value => !CASE_ORDER.includes(value as SmokeCase));
	if (unknown.length > 0) throw new Error(`unknown core smoke case(s): ${unknown.join(", ")}`);
	const selected = CASE_ORDER.filter(value => requested.includes(value));
	if (selected.length === 0) throw new Error("AGENTFLUX_LIVE_CASES selected no cases");
	return selected;
}

function setup(configValue: LiveConfig): void {
	if (!isSafeChildPath(workspaceRoot, fixtureRoot)) throw new Error(`unsafe fixture path: ${fixtureRoot}`);
	mkdirSync(workspaceRoot, { recursive: true });
	mkdirSync(fixtureRoot); // unique iteration: an existing directory is never replaced.
	mkdirSync(join(fixtureRoot, ".agentflux", "runtime"), { recursive: true });
	mkdirSync(join(fixtureRoot, "dist", "extension"), { recursive: true });
	writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux core smoke fixture\n", "utf8");
	mkdirSync(join(fixtureRoot, ".pi"), { recursive: true });
	writeFileSync(join(fixtureRoot, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: false }, cacheWarming: "off" }), "utf8");
	writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
		subagent_runtime: configValue.subagentRuntime,
		budget: {
			max_cost_per_task: 0.25,
			max_iterations: 3,
			max_wall_clock_seconds: null,
			max_turns_per_task: 32,
			max_input_tokens_per_task: 60_000,
			max_parallel_agents: 2,
		},
		pricing: { enable_remote_fetch: false },
	}, null, 2), "utf8");
	writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(configValue.fluxModelsJson(), null, 2), "utf8");
	for (const entry of ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"]) {
		const source = join(sourceRoot, "dist", "extension", entry);
		if (!existsSync(source)) throw new Error(`production dist entry is missing: ${source}; run npm run build before live validation`);
		cpSync(source, join(fixtureRoot, "dist", "extension", entry));
	}
	fixtureReady = true;
}

function taskToken(label: SmokeCase): string {
	return `CORE_SMOKE_TASK_${iteration}_${label}`;
}

function finalInstruction(marker: string): string {
	return `On any tool error or failed persistent fact, stop immediately and report failure; do not retry, diagnose, inspect .agentflux, or access parent workspaces. Never emit the success marker on failure. Only after all steps succeed, the final assistant text must be exactly one line: ${marker}. No quotes, explanations, lists, or other text.`;
}

function promptFor(label: SmokeCase): { prompt: string; model: string; expectation: CoreSmokeCaseExpectation } {
	const token = taskToken(label);
	const marker = MARKERS[label];
	if (label === "direct") {
		return {
			model: config!.mainModel,
			prompt: [
				`持久相关标识 ${token}。这是一个最小 direct Main 任务。不要调用任何 AgentFlux 协作工具，只完成一次简单确认。`,
				finalInstruction(marker),
			].join("\n"),
			expectation: { label, marker, taskToken: token },
		};
	}
	if (label === "agents") {
		const agentRunSuffix = runId.replace(/[^a-zA-Z0-9-]/g, "-").slice(-8);
		const reviewer = `core-smoke-reviewer-${agentRunSuffix}`;
		const tester = `core-smoke-tester-${agentRunSuffix}`;
		return {
			model: config!.mainModel,
			prompt: [
				`Correlation token: ${token}. Execute exactly these five calls in order, using each JSON object verbatim. No other tools.`,
				`flux_agent ${JSON.stringify({ action: "create", name: reviewer, role: "reviewer", scope: "project" })}`,
				`flux_agent ${JSON.stringify({ action: "create", name: tester, role: "tester", scope: "project" })}`,
				`flux_message ${JSON.stringify({ action: "send", sender: "main", target: reviewer, content: `${token}_MESSAGE` })}`,
				`flux_agent ${JSON.stringify({ action: "run", agent: reviewer, role: "reviewer", background: false, task: "Only reply AGENT_REVIEWER_OK" })}`,
				`flux_agent ${JSON.stringify({ action: "run", agent: tester, role: "tester", background: false, task: "Only reply AGENT_TESTER_OK" })}`,
				finalInstruction(marker),
			].join("\n"),
			expectation: {
				label, marker, taskToken: token, minRuns: 2, agentNames: [reviewer, tester], requireDelivery: true,
				requiredToolStarts: [
					{ toolName: "flux_agent", action: "create" },
					{ toolName: "flux_agent", action: "run" },
					{ toolName: "flux_message", action: "send" },
				],
			},
		};
	}
	if (label === "workflow") {
		return {
			model: config!.plannerModel,
			prompt: [
				`持久相关标识 ${token}。必须实际调用 flux_workflow action=run，不要把 DAG 步骤直接在 Main 中完成。`,
				`传给 flux_workflow 的 task 正文必须包含标识 ${token}，并要求一个固定的三节点只读流程：规划节点不调用任何工具，只输出简短固定计划及 PLAN_READY；执行节点依赖规划节点，仅使用 read 读取 README.md 第一行并产出该行和 EXEC_PASS；独立审查节点依赖前两节点，仅根据传入的 Dependency artifacts 核对 PLAN_READY、EXEC_PASS 两个标记，不调用工具、不读取 .agentflux 或其他文件，核对通过后产出 REVIEW_PASS。不可合并节点，每个节点的验收 criteria 只检查输出包含对应标记。不要修改文件，等待 Workflow 成功。`,
				finalInstruction(marker),
			].join("\n"),
			expectation: { label, marker, taskToken: token, resourceType: "workflow", minRuns: 4, expectedWorkflowNodes: 3, requiredToolStarts: [{ toolName: "flux_workflow", action: "run" }] },
		};
	}
	return {
		model: config!.mainModel,
		prompt: [
			`持久相关标识 ${token}。必须实际调用 flux_issue 完成完整 Community 生命周期，不要只查询或口头描述。`,
			`依次 create 一个 README 审计事项（title 含 ${token}，acceptanceCriteria 包含 COMMUNITY_ACCEPTED），保存返回的 issueId；claim 该 issue，agent=community-smoke，scope=${token}，plan=COMMUNITY_PLAN；submit 该 claim，plan=COMMUNITY_SUBMITTED，costUsd=0；review 该 claim，verdict=pass，agent=community-reviewer，body=COMMUNITY_REVIEW_PASS；最后 resolve 该 issue，body=COMMUNITY_RESOLVED。必须真实完成 submit -> review pass -> resolve。`,
			finalInstruction(marker),
		].join("\n"),
		expectation: {
			label, marker, taskToken: token, resourceType: "issue",
			requiredToolStarts: [
				{ toolName: "flux_issue", action: "create" },
				{ toolName: "flux_issue", action: "claim" },
				{ toolName: "flux_issue", action: "submit" },
				{ toolName: "flux_issue", action: "review" },
				{ toolName: "flux_issue", action: "resolve" },
			],
		},
	};
}

function launch(label: string, model: string, prompt: string): PiHandle {
	if (!config) throw new Error("live config is not initialized");
	const extensionEntry = join(fixtureRoot, "dist", "extension", "host-entry.ts");
	const args = [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "--no-context-files", "--no-prompt-templates", "-e", extensionEntry,
		"--no-skills", "--tools", "read,grep,find,ls,bash,flux_task,flux_agent,flux_workflow,flux_issue,flux_message",
		...config.cliArgs(model), `${prompt}\n${finalInstruction(MARKERS[label])}`,
	];
	const startedAt = new Date().toISOString();
	const child = spawn(process.execPath, args, {
		cwd: fixtureRoot,
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		env: config.env,
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let settled = false;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let hardStop: ReturnType<typeof setTimeout> | undefined;
	const result = new Promise<CoreSmokeProcessResult>(resolveResult => {
		const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			if (watchdog) clearTimeout(watchdog);
			if (hardStop) clearTimeout(hardStop);
			resolveResult({ label, pid: child.pid, exitCode, signal, stdout, stderr, timedOut, startedAt, finishedAt: new Date().toISOString(), watchdogTimeoutMs });
		};
		watchdog = setTimeout(() => {
			timedOut = true;
			stopOwnedProcess(child);
			// A broken descendant must not hold the supervisor forever; the receipt
			// records timedOut separately from this fixture-only hard stop.
			hardStop = setTimeout(() => finish(124, child.signalCode), 15_000);
		}, watchdogTimeoutMs);
		child.stdout?.on("data", value => { stdout += value.toString(); });
		child.stderr?.on("data", value => { stderr += value.toString(); });
		child.once("error", error => { stderr += `\n${error.message}`; finish(timedOut ? 124 : 1, child.signalCode); });
		child.once("close", (code, signal) => finish(timedOut ? 124 : code ?? 1, signal));
	});
	return { label, child, result, snapshot: () => ({ stdout, stderr }) };
}

function safeFacts(): CoreSmokeFacts | undefined {
	if (!fixtureReady) return undefined;
	try { return snapshotCoreSmokeFacts(fixtureRoot, sourceRoot); }
	catch (error) {
		evidence.coreFactsSnapshotError = compactError(error);
		return undefined;
	}
}

async function runCase(label: SmokeCase): Promise<void> {
	const { prompt, model, expectation } = promptFor(label);
	const handle = launch(label, model, prompt);
	handles.push(handle);
	const result = await handle.result;
	const persisted = persistCoreSmokeProcessEvidence(result, expectation.marker, sourceRoot, artifactRoot);
	processEvidence.set(label, persisted);
	const facts = safeFacts();
	const check = facts ? validateCoreSmokeCase({ ...expectation, requireCostAccounting: true }, result, facts) : { passed: false, reason: "Core snapshot unavailable" };
	const record = {
		label,
		model,
		provider: config?.providerId,
		thinking: config?.thinking,
		watchdogTimeoutMs,
		process: { pid: result.pid ?? null, exitCode: result.exitCode, signal: result.signal ?? null, timedOut: result.timedOut },
		outputEvidence: persisted,
		coreFactCounts: facts?.coreFactConsistency.counts ?? null,
		check,
	};
	evidence.cases.push(record);
	writeReport("running");
	if (!check.passed) throw new Error(`${label} smoke evidence failed; report=${reportPath}`);
}

async function settleAndStopOwnedProcesses(): Promise<void> {
	for (const handle of handles) stopOwnedProcess(handle.child);
	await waitForOwnedProcesses(handles.map(handle => handle.child), 15_000);
	await Promise.allSettled(handles.map(handle => handle.result));
}

async function main(): Promise<void> {
	mkdirSync(resultsRoot, { recursive: true });
	mkdirSync(artifactRoot, { recursive: true });
	evidence.sourceCommit = git(["rev-parse", "HEAD"]);
	evidence.branch = git(["branch", "--show-current"]);
	evidence.changedFiles = git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
	writeReport("running");
	try {
		if (!isSafeChildPath(resultsRoot, artifactRoot)) throw new Error(`unsafe artifact path: ${artifactRoot}`);
		config = loadLiveConfig("core");
		const cases = selectedCases();
		evidence.profile = config.profileName;
		evidence.configPath = config.configPath;
		evidence.models = { main: config.mainModel, planner: config.plannerModel, worker: config.workerModel, judge: config.judgeModel };
		evidence.provider = config.providerId;
		evidence.thinking = config.thinking;
		evidence.selectedCases = cases;
		setup(config);
		evidence.productionDist = productionDistEvidence(sourceRoot, fixtureRoot);
		if (!evidence.productionDist.builtExtension) throw new Error("production entries and the background preload must be present and copied byte-for-byte");
		for (const label of cases) await runCase(label);
		evidence.coreFacts = safeFacts();
		if (!evidence.coreFacts?.coreFactConsistency?.passed) throw new Error("final Core fact consistency failed");
		evidence.processEvidence = Object.fromEntries(processEvidence);
		evidence.passed = evidence.cases.length === cases.length && evidence.cases.every((item: any) => item.check?.passed === true);
		if (!evidence.passed) throw new Error("one or more core smoke cases failed");
		writeReport("passed");
		process.stdout.write(`${JSON.stringify({ ok: true, iteration, reportPath, cases }, null, 2)}\n`);
	} catch (error) {
		evidence.passed = false;
		evidence.coreFacts = safeFacts();
		evidence.processEvidence = Object.fromEntries(processEvidence);
		writeReport("failed", error);
		throw error;
	} finally {
		await settleAndStopOwnedProcesses();
		const processExit = handles.map(handle => ({ label: handle.label, pid: handle.child.pid ?? null, alive: isPidAlive(handle.child.pid), exitCode: handle.child.exitCode, signal: handle.child.signalCode }));
		const cleanupPassed = processExit.every(item => !item.alive);
		evidence.cleanup = {
			workspacePath: fixtureRoot,
			workspaceRemoved: false,
			workspaceRetainedForAudit: true,
			ownedProcessesOnly: true,
			processes: processExit,
			passed: cleanupPassed,
		};
		if (!cleanupPassed) {
			evidence.passed = false;
			evidence.error = `${evidence.error ? `${evidence.error}; ` : ""}owned Pi process remained alive`;
		}
		try {
			mkdirSync(artifactRoot, { recursive: true });
			writeFileSync(supervisorExitPath, JSON.stringify({
				iteration,
				status: evidence.passed === true ? "passed" : "failed",
				exitCode: evidence.passed === true ? 0 : 1,
				observedAt: new Date().toISOString(),
				processes: processExit,
			}, null, 2), "utf8");
			evidence.supervisorExit = { path: portableReportPath(sourceRoot, supervisorExitPath), exitCode: evidence.passed === true ? 0 : 1 };
		} catch (receiptError) {
			evidence.supervisorExitError = compactError(receiptError);
			evidence.passed = false;
		}
		try { config?.cleanup(); } catch (cleanupError) { evidence.configCleanupError = compactError(cleanupError); evidence.passed = false; }
		writeReport(evidence.passed === true ? "passed" : "failed");
		if (evidence.passed !== true) process.exitCode = 1;
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
