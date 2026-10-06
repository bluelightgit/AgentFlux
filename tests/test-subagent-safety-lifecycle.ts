import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedBoard } from "../src/core/shared-board";
import { formatAgentRunResult, getActiveAgentRunIds, isProviderQuotaError, loadAgentTemplate, runAgent, selectFallbackModel, type AgentTemplate } from "../src/agents/agent-runner";
import { TelemetryWriter } from "../src/telemetry/events";
import { readAgentRunStop, requestAgentRunStop } from "../src/agents/agent-run-control";

const root = mkdtempSync(join(tmpdir(), "agentflux-subagent-safe-"));
const fluxDir = join(root, ".agentflux");
mkdirSync(fluxDir, { recursive: true });
const telemetry = new TelemetryWriter(fluxDir, true);
const agent: AgentTemplate = { name: "implementer", description: "test", systemPrompt: "", tools: [] };
const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: string) {
	checks.push({ name, passed, detail });
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
}

async function main() {
try {
	check("path traversal agent names are rejected", loadAgentTemplate(root, "../models") === null, "../models rejected");
	const failedSummary = formatAgentRunResult({
		agent: "implementer", exitCode: 1, output: "", model: null,
		usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
		errorMessage: "provider compatibility: 406",
	});
	check("failed subagent result is explicit", failedSummary.includes("FAILED (exit=1)") && failedSummary.includes("error: provider compatibility: 406"), failedSummary.split("\n").slice(0, 3).join(" | "));
	check("failed subagent result gives a bounded next action", failedSummary.includes("do not repeat the same failed delegation"), failedSummary.split("\n").slice(0, 5).join(" | "));
	check("provider quota errors are terminal rather than generic rate limits",
		isProviderQuotaError('402 {"message":"Insufficient Balance"}')
		&& isProviderQuotaError("Monthly usage limit reached. Resets in 8 days")
		&& !isProviderQuotaError("429 rate limit, retry after 2 seconds"),
		"402/monthly=true, transient 429=false");
	const zeroExitProviderFailure = await runAgent({
		cwd: root, agent, task: "provider failure with zero process exit", sessionId: "test-session", telemetry,
		prefixLayout: false, maxRetries: 0,
		invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "provider-error-exit-zero.cjs")] },
	});
	check("provider error message cannot be reported as exit-code zero success",
		zeroExitProviderFailure.exitCode !== 0 && zeroExitProviderFailure.errorMessage?.includes("Monthly usage limit") === true,
		`exit=${zeroExitProviderFailure.exitCode} error=${zeroExitProviderFailure.errorMessage}`);
	for (const mode of ["recovered", "error", "abort", "limit"]) {
		const result = await runAgent({
			cwd: root, agent, task: `assistant retry ${mode}`, sessionId: "test-session", telemetry,
			prefixLayout: false, maxRetries: 0, ...(mode === "limit" ? { maxTurns: 1 } : {}),
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests/helpers/assistant-retry-subagent.cjs"), mode] },
		});
		const correct = mode === "recovered" ? result.exitCode === 0 && !result.errorMessage && result.output === "RECOVERED" && result.usage.turns === 3 && result.usage.cost === 0.003
			: mode === "limit" ? result.exitCode === 74 && result.errorMessage?.includes("turn limit reached") === true
			: result.exitCode !== 0 && result.errorMessage?.includes(mode === "error" ? "assistant ended with error" : "assistant aborted") === true;
		check(`assistant retry ${mode}: latest assistant outcome never clears a Host limit`, correct, `exit=${result.exitCode} error=${result.errorMessage} cost=${result.usage.cost}`);
	}
	const fallbackModels = {
		primary: { provider: "provider-a", capability: { coding: 0.9, reasoning: 0.9, speed: 0.8 } },
		sameChannel: { provider: "provider-a", capability: { coding: 0.85, reasoning: 0.85, speed: 0.8 } },
		crossChannel: { provider: "provider-b", capability: { coding: 0.7, reasoning: 0.7, speed: 0.7 } },
	} as any;
	const crossProvider = selectFallbackModel("primary", "provider-a", ["primary"], fallbackModels, { coding: 0.8, reasoning: 0.8 }, true);
	check("quota fallback skips models on the failed provider", crossProvider === "crossChannel", `fallback=${crossProvider}`);

	const aborted = new AbortController();
	aborted.abort("test cancellation");
	const cancelled = await runAgent({
		cwd: root, agent, task: "must never spawn", sessionId: "test-session", telemetry,
		prefixLayout: false, signal: aborted.signal, taskId: "task-correlation-test",
	});
	check("pre-aborted run returns cancelled", cancelled.exitCode === 130 && cancelled.errorMessage?.includes("cancelled") === true, `exit=${cancelled.exitCode}`);
	check("pre-aborted run leaves no process", getActiveAgentRunIds().length === 0, `active=${getActiveAgentRunIds().length}`);

	const target = join(root, "src", "same.ts");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(target, "export {};\n");
	const board = new SharedBoard(fluxDir);
	check("setup competing lock", board.acquireFileLock("other-run", target), "lock acquired");
	const conflicted = await runAgent({
		cwd: root, agent, task: "must not edit locked file", sessionId: "test-session", telemetry,
		prefixLayout: false, lockFiles: [target],
	});
	check("lock conflict is fail-closed", conflicted.exitCode === 73 && conflicted.errorMessage?.includes("file lock conflict") === true, `exit=${conflicted.exitCode}`);
	check("lock conflict leaves no process", getActiveAgentRunIds().length === 0, `active=${getActiveAgentRunIds().length}`);

	// ─── 文件锁过期偷锁的进程存活保护（与 fs-lock “活进程锁不可偷”一致） ───
	const lockFiles = readdirSync(join(fluxDir, "shared", "locks")).filter(file => file.endsWith(".lock"));
	check("competing lock file exists", lockFiles.length === 1, `locks=${lockFiles.join(",")}`);
	const lockPath = join(fluxDir, "shared", "locks", lockFiles[0]);
	const lockObj = JSON.parse(readFileSync(lockPath, "utf-8"));
	lockObj.expiresAt = Date.now() - 1000;
	writeFileSync(lockPath, JSON.stringify(lockObj));
	check("expired lock held by a live process is not stealable",
		board.acquireFileLock("other-run-2", target) === false, "live owner blocks steal");
	lockObj.ownerId = "other-run:99999999-dead-uuid";
	writeFileSync(lockPath, JSON.stringify(lockObj));
	check("mismatched birth and owner PID cannot authorize stealing",
		board.acquireFileLock("other-run-3", target) === false, "inconsistent ownership is unknown");
	delete lockObj.ownerIdentity; // This positive case intentionally represents a legacy dead owner.
	writeFileSync(lockPath, JSON.stringify(lockObj));
	check("expired lock held by a dead process is stealable",
		board.acquireFileLock("other-run-3", target) === true, "dead owner allows steal");
	board.releaseFileLock(target, "other-run-3");

	// 数字开头 agent 名（如 123worker）的 ownerId 不应被误判为 pid（旧实现逐段 /^\d+/ 会把 123worker 读成 pid 123 → 误偷活锁）
	lockObj.ownerId = `123worker:${process.pid}-dead-uuid`;
	writeFileSync(lockPath, JSON.stringify(lockObj));
	check("数字开头 agent 名 lockOwnerId 解析到真实 pid（存活进程锁不可偷）",
		board.acquireFileLock("other-run-4", target) === false, "ownerId 123worker:<livepid>-... 解析出的是持有进程 pid 而非 123");

	const pidFile = join(root, "process-tree.json");
	const controller = new AbortController();
	const running = runAgent({
		cwd: root,
		agent,
		task: "deterministic process tree cancellation",
		sessionId: "test-session",
		telemetry,
		prefixLayout: false,
		signal: controller.signal,
		runId: "process-tree-test",
		timeoutMs: 10_000,
		maxRetries: 2,
		invocationOverride: {
			command: process.execPath,
			args: [join(process.cwd(), "tests", "helpers", "hanging-process-tree.cjs"), pidFile],
		},
	});
	for (let attempt = 0; attempt < 100 && (!existsSync(pidFile) || !getActiveAgentRunIds().includes("process-tree-test")); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	check("real child process becomes observable", existsSync(pidFile) && getActiveAgentRunIds().includes("process-tree-test"), `active=${getActiveAgentRunIds().join(",")}`);
	const processTree = JSON.parse(readFileSync(pidFile, "utf-8")) as { parent: number; child: number };
	controller.abort("test process tree cancellation");
	const terminated = await running;
	check("in-flight abort returns exit 130 without retry", terminated.exitCode === 130 && terminated.retryCount === 0, `exit=${terminated.exitCode}, retries=${terminated.retryCount}`);
	check("in-flight abort clears active process registry", !getActiveAgentRunIds().includes("process-tree-test"), `active=${getActiveAgentRunIds().join(",")}`);
	const isAlive = (pid: number): boolean => {
		try { process.kill(pid, 0); return true; } catch { return false; }
	};
	for (let attempt = 0; attempt < 50 && (isAlive(processTree.parent) || isAlive(processTree.child)); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	check("abort terminates parent and descendant process", !isAlive(processTree.parent) && !isAlive(processTree.child), `parent=${processTree.parent}, child=${processTree.child}`);

	const controlPidFile = join(root, "control-process-tree.json");
	const controlled = runAgent({
		cwd: root,
		agent,
		task: "cross-process control-file cancellation",
		sessionId: "test-session",
		telemetry,
		prefixLayout: false,
		runId: "control-file-test",
		timeoutMs: 10_000,
		maxRetries: 2,
		invocationOverride: {
			command: process.execPath,
			args: [join(process.cwd(), "tests", "helpers", "hanging-process-tree.cjs"), controlPidFile],
		},
	});
	for (let attempt = 0; attempt < 100 && !getActiveAgentRunIds().includes("control-file-test"); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	requestAgentRunStop(root, "control-file-test");
	check("control-file stop request is observable across processes", readAgentRunStop(root, "control-file-test")?.runId === "control-file-test", "request persisted");
	const controlResult = await controlled;
	check("control-file stop returns cancelled without retry", controlResult.exitCode === 130 && controlResult.retryCount === 0, `exit=${controlResult.exitCode}, retries=${controlResult.retryCount}`);
	check("control-file stop request is cleared after convergence", readAgentRunStop(root, "control-file-test") === undefined, "request cleared");

	const events = readFileSync(telemetry.path, "utf-8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
	check("cancel outcome is observable", events.some(event => event.outcome?.status === "cancelled" && event.runId), `${events.length} telemetry events`);
	check("subagent telemetry preserves parent task correlation", events.some(event => event.type === "subagent.run" && event.taskId === "task-correlation-test"), `${events.length} telemetry events`);
	check("lock failure outcome is observable", events.some(event => event.exitCode === 73 && event.outcome?.status === "failure"), `${events.length} telemetry events`);
} finally {
	rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter(item => !item.passed);
console.log(`\nSubagent safety lifecycle: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
