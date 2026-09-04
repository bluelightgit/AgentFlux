import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgent, runAgentRecord, type AgentRunContext } from "../src/agents/agent-store";
import { readActiveContext, registerActiveContext, releaseActiveContext } from "../src/core/active-context";

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

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "agentflux-p0-02-space-"));
	try {
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

		const processMain = startContextProcess(root, "main", "process-main", 700);
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
		check(timedResult.exitCode === 124 && afterTimeout.length === 1 && afterTimeout[0].scope === "p0-02-timeout-long", "deadline 超时只释放自身 lease，不误删 long sibling");
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

		const crashSibling = startContextProcess(root, "main", "process-crash-sibling", 1200);
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
