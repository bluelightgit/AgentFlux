import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import agentFlux from "../src/entry";
import { createAgent, runAgentRecord, type AgentRunContext } from "../src/agents/agent-store";
import { readActiveContext, registerActiveContext, releaseActiveContext } from "../src/core/active-context";
import { listTaskExecutions, listTasks } from "../src/core/task-registry";
import { assistantFinalText, assistantMessageTexts, assistantOutputEvidence, hasAssistantFinalMarker, toolExecutionStarts } from "./helpers/pi-json-output";
import { buildProcessOutputEvidence, snapshotP002CoreFacts, validateProcessOutputEvidence, type ExpectedP002TerminalOutcome } from "./helpers/p0-02-evidence";

let passed = 0;
function check(value: unknown, message: string): void {
	if (!value) throw new Error(message);
	passed++;
	console.log(`✓ ${message}`);
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<boolean> {
	for (let index = 0; index < attempts; index++) {
		if (predicate()) return true;
		await new Promise(resolveWait => setTimeout(resolveWait, 20));
	}
	return predicate();
}

type ContextProcess = ChildProcessByStdio<null, Readable, Readable>;

type FakeHook = (event: any, ctx: any) => any;
class FakePi {
	hooks = new Map<string, FakeHook[]>();
	tools = new Map<string, any>();
	commands = new Map<string, any>();
	on(name: string, handler: FakeHook): void { this.hooks.set(name, [...(this.hooks.get(name) ?? []), handler]); }
	registerTool(tool: any): void { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: any): void { this.commands.set(name, command); }
	sendUserMessage(): void {}
}

async function emitFake(pi: FakePi, name: string, event: any, ctx: any): Promise<void> {
	for (const hook of pi.hooks.get(name) ?? []) await hook(event, ctx);
}

function startContextProcess(root: string, context: "main" | "workflow" | "community", name: string, holdMs: number, mode: "normal" | "crash" = "normal"): ContextProcess {
	return spawn(process.execPath, [
		resolve("node_modules/tsx/dist/cli.mjs"),
		resolve("tests/helpers/active-context-process.ts"),
		root,
		context,
		name,
		String(holdMs),
		mode,
	], { stdio: ["ignore", "pipe", "pipe"] });
}

function writeLifecycleSubagent(root: string, name: string): string {
	const path = join(root, `${name}.cjs`);
	writeFileSync(path, `
const delayMs = Math.max(100, Number(process.argv[2] || 700));
const exitCode = Number(process.argv[3] || 0);
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } }) + "\\n");
if (exitCode === 0) {
  setTimeout(() => process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "space-test-model", provider: "space-test-provider", usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 8, cost: { total: 0.001 } }, content: [{ type: "text", text: "space lifecycle complete" }] } }) + "\\n"), 20);
}
setTimeout(() => process.exit(exitCode), delayMs);
`);
	return path;
}

function lifecycleInvocation(root: string, name: string, delayMs: number, exitCode = 0): { command: string; args: string[] } {
	return { command: process.execPath, args: [writeLifecycleSubagent(root, name), String(delayMs), String(exitCode)] };
}

async function readProcessResult(child: ContextProcess): Promise<{ ok: boolean; error?: string }> {
	let buffer = "";
	return new Promise((resolveResult, reject) => {
		let settled = false;
		const settle = (value: { ok: boolean; error?: string }) => { if (!settled) { settled = true; resolveResult(value); } };
		child.stdout.on("data", chunk => {
			buffer += String(chunk);
			const line = buffer.split(/\r?\n/).find(item => item.trim());
			if (!line) return;
			try { settle(JSON.parse(line)); } catch (error) { reject(error); }
		});
		child.once("error", reject);
		child.once("exit", code => {
			if (!settled) reject(new Error(`context helper exited before result (${code}): ${buffer}`));
		});
	});
}

async function waitProcess(child: ContextProcess): Promise<number | null> {
	if (child.exitCode !== null) return child.exitCode;
	return new Promise(resolveExit => child.once("exit", (code) => resolveExit(code)));
}

async function runMainConflictTerminalCase(holderTask: string): Promise<{
	errorMessage: string;
	taskStatus: string | undefined;
	outcomeStatus: string | undefined;
	deadlineAt: string | null | undefined;
	executionDeadlineAt: string | null | undefined;
	siblingPreserved: boolean;
}> {
	const caseRoot = mkdtempSync(join(tmpdir(), "agentflux-p0-02-terminal-classification-"));
	const sessionId = "p0-02-terminal-classification";
	const ctx: any = {
		cwd: caseRoot,
		hasUI: false,
		mode: "print",
		model: { id: "classification-test-model" },
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "classification-session" },
	};
	const pi = new FakePi();
	const lease = { leaseId: "" };
	try {
		mkdirSync(join(caseRoot, ".agentflux"), { recursive: true });
		writeFileSync(join(caseRoot, ".agentflux", "agentflux.json"), JSON.stringify({ budget: { max_cost_per_task: 1, max_iterations: 2, max_wall_clock_seconds: null } }));
		writeFileSync(join(caseRoot, ".agentflux", "models.json"), JSON.stringify({ models: {}, roles: {} }));
		agentFlux(pi as any);
		await emitFake(pi, "session_start", {}, ctx);
		await emitFake(pi, "before_agent_start", { prompt: "attempt a workflow while Main is active", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		const registered = registerActiveContext(caseRoot, { name: "main-holder", context: "main", scope: "holder", task: holderTask });
		lease.leaseId = registered.leaseId;
		let errorMessage = "";
		try {
			await pi.tools.get("flux_workflow").execute("classification-conflict", { action: "run", task: "read README.md" });
		} catch (error: any) {
			errorMessage = String(error?.message ?? error);
		}
		await emitFake(pi, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		await emitFake(pi, "agent_settled", {}, ctx);
		const task = listTasks(join(caseRoot, ".agentflux"), sessionId)[0];
		const execution = task ? listTaskExecutions(join(caseRoot, ".agentflux"), task.id)[0] : undefined;
		const siblingPreserved = readActiveContext(caseRoot).entries.some(entry => entry.leaseId === lease.leaseId);
		return {
			errorMessage,
			taskStatus: task?.status,
			outcomeStatus: execution?.outcome?.status,
			deadlineAt: task?.deadlineAt,
			executionDeadlineAt: execution?.deadlineAt,
			siblingPreserved,
		};
	} finally {
		if (lease.leaseId) {
			try { releaseActiveContext(caseRoot, lease.leaseId); } catch {}
		}
		try { await emitFake(pi, "session_shutdown", {}, ctx); } catch {}
		rmSync(caseRoot, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "agentflux-p0-02-space-"));
	try {
		for (const holderTask of [
			"ordinary work",
			"node -e \\\"setTimeout(() => {}, 120000)\\\"",
			"review deadline requirements",
		]) {
			const result = await runMainConflictTerminalCase(holderTask);
			check(result.errorMessage.includes("main 空间活跃")
				&& result.taskStatus === "failed"
				&& result.outcomeStatus === "failure"
				&& result.deadlineAt == null
				&& result.executionDeadlineAt == null
				&& result.siblingPreserved,
				`普通 Main 空间冲突（持有者文本：${holderTask}）保持 failed/failure 且保留 sibling lease`);
		}
		const echoedMarker = "P0_02_ECHO_ONLY_MARKER";
		const echoedPromptOutput = JSON.stringify({
			type: "agent_end",
			messages: [
				{ role: "user", content: [{ type: "text", text: `提示中包含 ${echoedMarker}，但最终回复不包含它。` }] },
				{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "最终回复没有验收标记。" }] },
			],
		}) + "\n";
		check(!hasAssistantFinalMarker(echoedPromptOutput, "", echoedMarker), "marker 不采信包含在 user prompt 回显中的文本");
		const finalMarker = "P0_02_FINAL_ASSISTANT_MARKER";
		const finalAssistantOutput = JSON.stringify({ type: "toolResult", toolName: "flux_issue", content: [{ type: "text", text: finalMarker }] }) + "\n"
			+ JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: finalMarker }] } }) + "\n";
		check(assistantFinalText(finalAssistantOutput) === finalMarker && hasAssistantFinalMarker(finalAssistantOutput, "", finalMarker), "marker 只采信最终 assistant message_end 文本");
		const negatedFinalOutput = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `条件未满足，因此不会输出 ${finalMarker}` }] } }) + "\n";
		check(!hasAssistantFinalMarker(negatedFinalOutput, "", finalMarker), "最终 assistant 否定提及 marker 不能通过精确判定");
		const whitespaceFinalOutput = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `  ${finalMarker} \n` }] } }) + "\n";
		check(hasAssistantFinalMarker(whitespaceFinalOutput, "", finalMarker), "最终 assistant marker 允许首尾空白但不允许额外文本");
		const persistedAssistantEvidence = JSON.parse(JSON.stringify(assistantOutputEvidence(finalAssistantOutput, "", finalMarker)));
		check(persistedAssistantEvidence.parseable === true && persistedAssistantEvidence.finalAssistantText === finalMarker && persistedAssistantEvidence.markerMatched === true && persistedAssistantEvidence.markerMatchRule === "trimmed-exact", "保存的终态 assistant/marker 证据可独立复核");
		const largeTrailingEventOutput = finalAssistantOutput + JSON.stringify({ type: "provider_trace", payload: "x".repeat(12_000) }) + "\n";
		const reportOutputEvidence = buildProcessOutputEvidence({ label: "report-proof", pid: process.pid, exitCode: 0, stdout: largeTrailingEventOutput, stderr: "", timedOut: false }, finalMarker, root, join(root, "report-artifacts"));
		check(assistantMessageTexts(reportOutputEvidence.stdoutTail ?? "").length === 0 && validateProcessOutputEvidence([JSON.parse(JSON.stringify(reportOutputEvidence))], { "report-proof": finalMarker }, root).passed === true && reportOutputEvidence.finalAssistantText === finalMarker, "报告 artifact 在 tail 截断后仍可独立复核最终 marker");
		const coreRoot = mkdtempSync(join(tmpdir(), "agentflux-p0-02-core-evidence-"));
		try {
			const runtime = join(coreRoot, ".agentflux", "runtime");
			mkdirSync(runtime, { recursive: true });
			const now = new Date().toISOString();
			writeFileSync(join(runtime, "tasks.json"), JSON.stringify({ version: 2, tasks: [{ id: "task-a", executionId: "exec-a", sessionId: "session-a", task: "audit task", selectedBy: "user", operation: "new", status: "completed", createdAt: now, updatedAt: now }], executions: [{ id: "exec-a", taskId: "task-a", sessionId: "session-a", operation: "new", status: "completed", costUsd: 0.01, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01, model: "audit-model" }, createdAt: now, updatedAt: now, finishedAt: now }] }));
			writeFileSync(join(runtime, "runs.json"), JSON.stringify({ version: 1, runs: [{ id: "run-a", taskId: "task-a", executionId: "exec-a", sessionId: "session-a", agent: "agent-a", role: "assistant", currentTask: "audit", kind: "persistent", status: "completed", attempt: 0, turns: 1, input: 2, output: 1, cacheRead: 0, cacheWrite: 0, contextTokens: 3, costUsd: 0.01, phase: "terminal", health: "healthy", lastProgressAt: now, lastProgressType: "message", lastProgressSummary: "done", lastActivityAt: now, lastActivityType: "terminal", lastActivitySummary: "completed", createdAt: now, updatedAt: now, heartbeatAt: now, finishedAt: now }] }));
			writeFileSync(join(runtime, "agents.json"), JSON.stringify({ agents: [{ id: "agent-a", name: "agent-a", scope: "project", role: "assistant", roles: ["assistant"], status: "idle", lineage: { origin: "fresh" }, callCount: 1, totalCostUsd: 0.01, capabilityGeneration: 1, createdAt: now, updatedAt: now }] }));
			writeFileSync(join(coreRoot, ".agentflux", "issues.json"), JSON.stringify({ issues: [{ id: "issue-a", title: "audit issue", description: "audit", status: "open", createdBy: "main", createdAt: now, updatedAt: now, acceptanceCriteria: [], comments: [], claims: [], proposals: [], timeline: [], costUsd: 0 }] }));
			writeFileSync(join(runtime, "workflows.json"), JSON.stringify({ version: 1, definitions: [{ id: "workflow-a", name: "workflow-a", version: 1, description: "audit", dag: { description: "audit", nodes: [] }, createdAt: now, updatedAt: now }] }));
			const coreEvidence = snapshotP002CoreFacts(coreRoot, ["issue-a"], "workflow-a");
			check(coreEvidence.coreFactConsistency.passed === true && coreEvidence.tasks.length === 1 && coreEvidence.executions.length === 1 && coreEvidence.runs.length === 1 && coreEvidence.agents.length === 1 && coreEvidence.issues.length === 1 && coreEvidence.parentLineage.tasks[0].parentTaskId === null && typeof coreEvidence.costUsdTotal === "number", "报告保存 Task/Execution/Run/Agent/Issue、usage/cost 与父谱系事实");
			const expectedFailure: Record<string, ExpectedP002TerminalOutcome> = {
				"audit-case": { marker: "audit task", taskStatus: "failed", outcomeStatus: "failure", deadline: "none" },
			};
			const inconsistentEvidence = snapshotP002CoreFacts(coreRoot, ["issue-a"], "workflow-a", expectedFailure);
			check(inconsistentEvidence.coreFactConsistency.passed === false
				&& inconsistentEvidence.coreFactConsistency.failedChecks.includes("terminalOutcomes")
				&& inconsistentEvidence.terminalOutcomes.checks[0].observedTaskStatus === "completed"
				&& inconsistentEvidence.terminalOutcomes.checks[0].observedOutcomeStatus == null,
				"错误的 Task/Execution 预期会令 Core 一致性判定失败");
		} finally {
			rmSync(coreRoot, { recursive: true, force: true });
		}
		const toolStartOutput = JSON.stringify({ type: "tool_execution_start", toolName: "flux_issue", toolCallId: "call-live", args: { action: "claim" } }) + "\n";
		check(toolExecutionStarts(toolStartOutput, "flux_issue").length === 1, "冲突因果证据只采信真实 tool_execution_start 事件");

		const modelsConfig = { models: {} };
		const context = (sessionId: string, invocationOverride: AgentRunContext["invocationOverride"]): AgentRunContext => ({
			cwd: root,
			modelsConfig,
			sessionId,
			sharedSkills: [],
			prefixLayout: true,
			invocationOverride,
			space: "main",
		});
		const shortInvocation = lifecycleInvocation(root, "space-short", 180);
		const longInvocation = lifecycleInvocation(root, "space-long", 1400);
		const normalShort = createAgent(root, { name: "space-main-short", role: "assistant", modelsConfig });
		const normalLong = createAgent(root, { name: "space-main-long", role: "assistant", modelsConfig });
		const normalShortRun = runAgentRecord(normalShort.name, "main space short", context("p0-02-normal-short", shortInvocation));
		check(await waitFor(() => readActiveContext(root).entries.some(entry => entry.scope === "p0-02-normal-short")), "Main 派发启动时注册 short main-space lease");
		let workflowRejected = false;
		try {
			registerActiveContext(root, { name: "workflow-conflict", context: "workflow", scope: "workflow-conflict", task: "must be rejected" });
		} catch (error: any) {
			workflowRejected = String(error?.message ?? "").includes("main 空间活跃");
		}
		check(workflowRejected, "Main 派发活跃时跨空间 Workflow 被拒绝");
		const normalLongRun = runAgentRecord(normalLong.name, "main space long", context("p0-02-normal-long", longInvocation));
		check(await waitFor(() => readActiveContext(root).entries.filter(entry => entry.context === "main").length === 2), "同一 Main 空间允许并行派发并保留两个 lease");
		const normalShortResult = await normalShortRun;
		const afterNormalShort = readActiveContext(root).entries;
		check(normalShortResult.exitCode === 0 && afterNormalShort.length === 1 && afterNormalShort[0].scope === "p0-02-normal-long", "short Main 正常完成只释放自身 lease，long sibling 仍存活");
		const normalLongResult = await normalLongRun;
		check(normalLongResult.exitCode === 0 && readActiveContext(root).entries.length === 0, "long Main 完成后清空剩余 space lease");

		const processMain = startContextProcess(root, "main", "process-main", 2_000);
		const processMainResult = await readProcessResult(processMain);
		check(processMainResult.ok === true, "独立进程可以原子注册 Main space lease");
		const processConflict = startContextProcess(root, "workflow", "process-workflow-conflict", 100);
		const processConflictResult = await readProcessResult(processConflict);
		check(processConflictResult.ok === false && processConflictResult.error?.includes("main 空间活跃"), "独立进程跨空间注册被拒绝");
		const processSameSpace = startContextProcess(root, "main", "process-main-parallel", 350);
		const processSameSpaceResult = await readProcessResult(processSameSpace);
		check(processSameSpaceResult.ok === true && readActiveContext(root).entries.filter(entry => entry.context === "main").length === 2, "独立进程同空间注册允许并行");
		await Promise.all([waitProcess(processMain), waitProcess(processConflict), waitProcess(processSameSpace)]);
		check(readActiveContext(root).entries.length === 0, "独立进程正常退出后各自 lease 均被释放");

		const timeoutLong = createAgent(root, { name: "space-timeout-long", role: "assistant", modelsConfig });
		const timeoutShort = createAgent(root, { name: "space-timeout-short", role: "assistant", modelsConfig });
		const timeoutLongRun = runAgentRecord(timeoutLong.name, "long sibling during deadline", context("p0-02-timeout-long", lifecycleInvocation(root, "space-timeout-long", 1600)));
		check(await waitFor(() => readActiveContext(root).entries.some(entry => entry.scope === "p0-02-timeout-long")), "deadline 场景先存在 long sibling lease");
		const timeoutShortRun = runAgentRecord(timeoutShort.name, "explicit deadline cleanup", { ...context("p0-02-timeout-short", lifecycleInvocation(root, "space-timeout-short", 1600)), timeoutMs: 100 });
		check(await waitFor(() => readActiveContext(root).entries.filter(entry => entry.context === "main").length === 2), "deadline 场景同时存在两个 Main lease");
		const timedResult = await timeoutShortRun;
		const afterTimeout = readActiveContext(root).entries;
		check(timedResult.exitCode === 124 && timedResult.timedOut === true && afterTimeout.length === 1 && afterTimeout[0].scope === "p0-02-timeout-long", "真实 deadline 超时带有可信 timedOut 运行事实且只释放自身 lease");
		const timeoutLongResult = await timeoutLongRun;
		check(timeoutLongResult.exitCode === 0 && readActiveContext(root).entries.length === 0, "deadline long sibling 完成后清空剩余 lease");

		const cancelLong = createAgent(root, { name: "space-cancel-long", role: "assistant", modelsConfig });
		const cancelShort = createAgent(root, { name: "space-cancel-short", role: "assistant", modelsConfig });
		const cancelLongRun = runAgentRecord(cancelLong.name, "long sibling during cancel", context("p0-02-cancel-long", lifecycleInvocation(root, "space-cancel-long", 1600)));
		check(await waitFor(() => readActiveContext(root).entries.some(entry => entry.scope === "p0-02-cancel-long")), "取消场景先存在 long sibling lease");
		const controller = new AbortController();
		const cancelledPromise = runAgentRecord(cancelShort.name, "cancel cleanup", context("p0-02-cancel-short", lifecycleInvocation(root, "space-cancel-short", 1600)), controller.signal);
		check(await waitFor(() => readActiveContext(root).entries.filter(entry => entry.context === "main").length === 2), "取消场景同时存在两个 Main lease");
		controller.abort();
		const cancelledResult = await cancelledPromise;
		const afterCancel = readActiveContext(root).entries;
		check(cancelledResult.exitCode === 130 && afterCancel.length === 1 && afterCancel[0].scope === "p0-02-cancel-long", "取消只释放自身 lease，不误删 long sibling");
		const cancelLongResult = await cancelLongRun;
		check(cancelLongResult.exitCode === 0 && readActiveContext(root).entries.length === 0, "取消 long sibling 完成后清空剩余 lease");

		const failureLong = createAgent(root, { name: "space-failure-long", role: "assistant", modelsConfig });
		const failureShort = createAgent(root, { name: "space-failure-short", role: "assistant", modelsConfig });
		const failureLongRun = runAgentRecord(failureLong.name, "long sibling during failure", context("p0-02-failure-long", lifecycleInvocation(root, "space-failure-long", 8000)));
		check(await waitFor(() => readActiveContext(root).entries.some(entry => entry.scope === "p0-02-failure-long")), "failure 场景先存在 long sibling lease");
		const failedResult = await runAgentRecord(failureShort.name, "failure cleanup", context("p0-02-failure-short", lifecycleInvocation(root, "space-failure-short", 1600, 1)));
		const afterFailure = readActiveContext(root).entries;
		check(failedResult.exitCode === 1 && afterFailure.length === 1 && afterFailure[0].scope === "p0-02-failure-long", "业务失败只释放自身 lease，不误删 long sibling");
		const failureLongResult = await failureLongRun;
		check(failureLongResult.exitCode === 0 && readActiveContext(root).entries.length === 0, "failure long sibling 完成后清空剩余 lease");

		const crashSibling = startContextProcess(root, "main", "process-crash-sibling", 3_000);
		const crashSiblingResult = await readProcessResult(crashSibling);
		check(crashSiblingResult.ok === true, "真实 crash 场景先注册 sibling lease");
		const crashed = startContextProcess(root, "main", "process-crashed", 250, "crash");
		const crashedReady = await readProcessResult(crashed);
		check(crashedReady.ok === true, "真实子进程 crash 前已注册独立 lease");
		const crashedExit = await waitProcess(crashed);
		const afterCrash = readActiveContext(root).entries;
		check(crashedExit !== 0 && afterCrash.length === 1 && afterCrash[0].name === "process-crash-sibling", "真实 crash 只留下 sibling，死进程 lease 不误删并可被过滤");
		const replacement = registerActiveContext(root, { name: "process-crash-replacement", context: "main", scope: "process-crash-replacement", task: "replacement after crash" });
		check(!!replacement.leaseId && readActiveContext(root).entries.some(entry => entry.leaseId === replacement.leaseId), "真实 crash 后同空间 replacement 可注册");
		releaseActiveContext(root, replacement.leaseId);
		await waitProcess(crashSibling);
		check(readActiveContext(root).entries.length === 0, "真实 crash sibling 正常退出后空间 lease 清空");

		console.log(`\n${passed} P0-02 space isolation checks passed`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch(error => { console.error(error); process.exit(1); });
