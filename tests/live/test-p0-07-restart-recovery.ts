import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLiveConfig } from "./live-config";

/**
 * Built-extension restart/orphan validation. Pi A starts a real persistent Run,
 * is forcibly terminated, and Pi B starts after the heartbeat grace period.
 * Startup recovery must converge the dead Run and stale Agent without deleting
 * the durable identity or inventing a parallel execution.
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-restart-recovery-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-restart-recovery-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const ACTIVE = new Set(["starting", "running", "stop_requested"]);

interface ProcessTerminationEvidence {
	pid?: number;
	aliveBefore: boolean;
	terminated: boolean;
	attempts: number;
	command?: string;
	commandStatus?: number | null;
	commandSignal?: NodeJS.Signals | null;
	commandError?: string;
	stdout?: string;
	stderr?: string;
}

interface PiResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	termination?: ProcessTerminationEvidence;
}

interface PiHandle {
	child: ChildProcess;
	result: Promise<PiResult>;
}

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trimEnd(); }
	catch { return ""; }
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function sleep(ms: number): Promise<void> { return new Promise(resolveSleep => setTimeout(resolveSleep, ms)); }
function blockSleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM" || error?.code === "EACCES";
	}
}

/**
 * Kill the requested process (and optionally its descendants), then verify the
 * PID is actually gone. A successful taskkill exit code alone is not evidence: on
 * Windows it can race with process creation or be unavailable in the host PATH.
 */
function stopTree(target: ChildProcess | number, includeDescendants = true): ProcessTerminationEvidence {
	const pid = typeof target === "number" ? target : target.pid ?? undefined;
	const evidence: ProcessTerminationEvidence = { pid, aliveBefore: isProcessAlive(pid), terminated: false, attempts: 0 };
	if (!pid) return evidence;
	const command = process.platform === "win32"
		? ((process.env.SystemRoot || process.env.WINDIR)
			? join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe")
			: "taskkill.exe")
		: undefined;
	evidence.command = command;
	for (let attempt = 0; attempt < 4; attempt++) {
		evidence.attempts = attempt + 1;
		if (!isProcessAlive(pid)) { evidence.terminated = true; return evidence; }
		if (process.platform === "win32") {
			try {
				const killed = spawnSync(command ?? "taskkill.exe", ["/PID", String(pid), ...(includeDescendants ? ["/T"] : []), "/F"], {
					windowsHide: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 10_000,
				});
				evidence.commandStatus = killed.status;
				evidence.commandSignal = killed.signal;
				evidence.commandError = killed.error?.message;
				evidence.stdout = String(killed.stdout ?? "").slice(-2000);
				evidence.stderr = String(killed.stderr ?? "").slice(-2000);
			} catch (error) {
				evidence.commandError = String(error instanceof Error ? error.message : error);
			}
		} else {
			try { process.kill(includeDescendants ? -pid : pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
		}
		if (typeof target !== "number" && isProcessAlive(pid)) {
			try { target.kill("SIGKILL"); } catch {}
		}
		blockSleep(250);
	}
	evidence.terminated = !isProcessAlive(pid);
	return evidence;
}

function launch(config: ReturnType<typeof loadLiveConfig>, extensionEntry: string, sessionId: string, prompt: string, timeoutMs: number): PiHandle {
	const child = spawn(process.execPath, [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "flux_agent", "--session-dir", join(fixtureRoot, "sessions"), "--session-id", sessionId,
		...config.cliArgs(config.mainModel), prompt,
	], { cwd: fixtureRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: config.env });
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", value => { stdout += value.toString(); });
	child.stderr?.on("data", value => { stderr += value.toString(); });
	const result = new Promise<PiResult>(resolveResult => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			const termination = stopTree(child);
			resolveResult({ status: 124, signal: "SIGTERM", stdout, stderr, timedOut: true, termination });
		}, timeoutMs);
		child.on("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ status: 1, signal: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false });
		});
		child.on("close", (status, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ status, signal, stdout, stderr, timedOut: false });
		});
	});
	return { child, result };
}

async function main(): Promise<void> {
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("restart recovery live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	const config = loadLiveConfig("p0-07-restart-recovery");
	const startedAt = Date.now();
	const branch = git(["branch", "--show-current"]);
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const changedFiles = git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
	let first: PiHandle | undefined;
	let recovery: PiHandle | undefined;
	let firstResult: PiResult | undefined;
	let recoveryResult: PiResult | undefined;
	let mainTermination: ProcessTerminationEvidence | undefined;
	let runTermination: ProcessTerminationEvidence | undefined;
	mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
	try {
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		mkdirSync(join(fixtureRoot, "sessions"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux restart recovery fixture\n");
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: { max_cost_per_task: 0.30, max_iterations: 3, max_wall_clock_seconds: null },
			health: { waiting_provider_after_ms: 2_000, quiet_after_ms: 4_000, suspected_stall_after_ms: 8_000, warning_cooldown_ms: 2_000 },
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		const models: any = config.fluxModelsJson();
		models.roles.implementer.tools = ["read", "grep", "find", "ls", "bash"];
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(models, null, 2));
		const extensionDir = join(fixtureRoot, "dist", "extension");
		mkdirSync(extensionDir, { recursive: true });
		cpSync(join(sourceRoot, "dist", "extension"), extensionDir, { recursive: true });
		const extensionEntry = join(extensionDir, "entry.js");
		first = launch(config, extensionEntry, "restart-live", [
			"严格只调用 AgentFlux flux_agent 工具。",
			"1) action=create，name=restart-live，role=implementer，scope=project。",
			"2) action=run，agent=restart-live，background=false，task=必须调用 bash 执行 node -e \"setTimeout(() => {}, 120000)\"，保持运行，不要提前结束。",
		].join("\n"), 150_000);
		let orphan: any;
		const activeDeadline = Date.now() + 75_000;
		while (Date.now() < activeDeadline) {
			const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [];
			orphan = runs.find((run: any) => run.agent === "restart-live" && ACTIVE.has(run.status) && run.pid && run.phase !== "starting");
			if (orphan) break;
			await sleep(250);
		}
		if (!orphan) throw new Error("restart fixture did not expose an active persistent Run");
		const orphanRunId = orphan.id;
		const firstPid = first.child.pid;
		const orphanPid = typeof orphan.pid === "number" ? orphan.pid : undefined;
		if (!isProcessAlive(firstPid) || !isProcessAlive(orphanPid)) {
			throw new Error(`restart fixture lost the live Pi/Run before kill: mainPid=${firstPid} runPid=${orphanPid}`);
		}
		// Kill Pi A without /T first so its child Run remains an orphan long enough
		// to exercise durable heartbeat recovery. Then terminate the actual child
		// process tree and verify both PIDs are gone.
		mainTermination = stopTree(first.child, false);
		runTermination = stopTree(orphanPid ?? 0, true);
		if (!runTermination.terminated || !mainTermination.terminated) {
			throw new Error(`restart fixture could not terminate Pi A process tree: main=${JSON.stringify(mainTermination)} run=${JSON.stringify(runTermination)}`);
		}
		firstResult = await Promise.race([
			first.result,
			sleep(15_000).then(() => ({ status: 124, signal: "SIGTERM" as NodeJS.Signals, stdout: "", stderr: "first Pi did not close after verified kill", timedOut: true })),
		]);
		if (firstResult.timedOut) throw new Error("restart fixture Pi A result timed out after process-tree termination");
		// reconcileStaleAgentRuns deliberately has a 30s grace period and protects
		// live PIDs, so wait beyond that window after the forced process-tree stop.
		await sleep(35_000);
		const beforeRecovery = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs?.find((run: any) => run.id === orphanRunId);
		recovery = launch(config, extensionEntry, "restart-recovery", [
			"严格按顺序调用 AgentFlux flux_agent 工具，不要调用其他工具。",
			"1) action=inspect，agent=restart-live，last=5。",
			"2) action=list。",
			"完成后只输出 P0_07_RESTART_RECOVERY_OK。",
		].join("\n"), 120_000);
		recoveryResult = await recovery.result;
		await sleep(500);
		const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [];
		const recoveredRun = runs.find((run: any) => run.id === orphanRunId);
		const agents = readJson(join(fixtureRoot, ".agentflux", "runtime", "agents.json"))?.agents ?? [];
		const recoveredAgent = agents.find((agent: any) => agent.name === "restart-live");
		const taskStore = readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json")) ?? {};
		const tasks = taskStore.tasks ?? [];
		const executions = taskStore.executions ?? [];
		const recoveredTask = tasks.find((task: any) => task.id === recoveredRun?.taskId);
		const recoveredExecution = executions.find((execution: any) => execution.id === recoveredRun?.executionId);
		const marker = `${recoveryResult.stdout}\n${recoveryResult.stderr}`.includes("P0_07_RESTART_RECOVERY_OK");
		const recovered = recoveredRun?.status === "failed"
			&& recoveredRun.pid === undefined
			&& recoveredRun.error === "runtime heartbeat expired before terminal convergence"
			&& recoveredRun.recentEvents?.some((event: any) => event.type === "heartbeat_expired")
			&& recoveredAgent?.status === "idle"
			&& recoveredTask?.status === "failed"
			&& recoveredExecution?.status === "failed"
			&& recoveredExecution?.outcome?.error === recoveredRun.error;
		const passed = Boolean(orphanRunId)
			&& ACTIVE.has(beforeRecovery?.status)
			&& beforeRecovery?.pid === orphanPid
			&& mainTermination?.aliveBefore === true && mainTermination.terminated
			&& runTermination?.terminated === true
			&& firstResult.status !== 124 && !firstResult.timedOut
			&& recoveryResult.status === 0 && !recoveryResult.timedOut && marker && recovered;
		const evidence = {
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
			wallClockMs: Date.now() - startedAt,
			firstPi: { pid: first.child.pid, exitCode: firstResult.status, signal: firstResult.signal, timedOut: firstResult.timedOut, stdoutTail: firstResult.stdout.slice(-5000), stderrTail: firstResult.stderr.slice(-3000), processTreeTermination: mainTermination, childRunTermination: runTermination },
			recoveryPi: { pid: recoveryResult.status === 0 ? recovery.child.pid : recovery.child.pid, exitCode: recoveryResult.status, signal: recoveryResult.signal, timedOut: recoveryResult.timedOut, marker, stdoutTail: recoveryResult.stdout.slice(-5000), stderrTail: recoveryResult.stderr.slice(-3000) },
			orphanBeforeRecovery: beforeRecovery,
			recoveredRun,
			recoveredAgent,
			tasks,
			executions,
			recoveredTask,
			recoveredExecution,
			orphanRunId,
			recovered,
			passed,
		};
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		console.log(JSON.stringify(evidence, null, 2));
		if (!passed) throw new Error(`restart/orphan recovery evidence failed; report=${reportPath}`);
	} catch (error) {
		// Preserve a kill/launch failure as first-class evidence. In particular, a
		// harness timeout must never overwrite the fact that Pi A was not killed.
		const failureEvidence = {
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
			wallClockMs: Date.now() - startedAt,
			firstPi: firstResult ? { pid: first?.child.pid, exitCode: firstResult.status, signal: firstResult.signal, timedOut: firstResult.timedOut, stdoutTail: firstResult.stdout.slice(-5000), stderrTail: firstResult.stderr.slice(-3000) } : { pid: first?.child.pid },
			recoveryPi: recoveryResult ? { pid: recovery?.child.pid, exitCode: recoveryResult.status, signal: recoveryResult.signal, timedOut: recoveryResult.timedOut } : undefined,
			processTreeTermination: mainTermination,
			childRunTermination: runTermination,
			passed: false,
			error: String(error instanceof Error ? error.message : error),
		};
		try { writeFileSync(reportPath, JSON.stringify(failureEvidence, null, 2)); } catch {}
		throw error;
	} finally {
		if (first) stopTree(first.child);
		if (recovery) stopTree(recovery.child);
		rmSync(fixtureRoot, { recursive: true, force: true });
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
