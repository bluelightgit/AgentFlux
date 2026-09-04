import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { markAgentRunRunning, registerAgentRun } from "../../src/core/run-registry";
import { loadLiveConfig } from "./live-config";

/**
 * Built-extension owner-fence regression.  A real Main Pi owns a running
 * Task/Execution while a real helper child is killed and represented as a
 * stale persistent Run.  A fresh recovery Pi must fail only that child, leave
 * the live parent running, release no-longer-valid recovery fences, and allow
 * Main to register a replacement child under the same parent execution.
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-owner-fence-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-owner-fence-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const ACTIVE = new Set(["starting", "running", "stop_requested"]);

interface ProcessEvidence {
	pid?: number;
	aliveBefore: boolean;
	terminated: boolean;
	command?: string;
	commandStatus?: number | null;
	commandError?: string;
}

interface PiState { stdout: string; stderr: string; }
interface PiResult { exitCode: number; signal: NodeJS.Signals | null; timedOut: boolean; state: PiState; }
interface PiHandle { child: ChildProcess; state: PiState; result: Promise<PiResult>; }

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trimEnd(); }
	catch { return ""; }
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function sleep(ms: number): Promise<void> { return new Promise(resolveSleep => setTimeout(resolveSleep, ms)); }

function isAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error: any) { return error?.code === "EPERM" || error?.code === "EACCES"; }
}

function stopTree(target: ChildProcess | number, descendants = true): ProcessEvidence {
	const pid = typeof target === "number" ? target : target.pid ?? undefined;
	const evidence: ProcessEvidence = { pid, aliveBefore: isAlive(pid), terminated: false };
	if (!pid) return evidence;
	if (process.platform === "win32") {
		const command = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe");
		evidence.command = command;
		for (let attempt = 0; attempt < 4 && isAlive(pid); attempt++) {
			try {
				const result = spawnSync(command, ["/PID", String(pid), ...(descendants ? ["/T"] : []), "/F"], {
					windowsHide: true, stdio: "ignore", timeout: 10_000,
				});
				evidence.commandStatus = result.status;
				evidence.commandError = result.error?.message;
			} catch (error) { evidence.commandError = String(error); }
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
		}
	} else {
		try { process.kill(descendants ? -pid : pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
	}
	evidence.terminated = !isAlive(pid);
	return evidence;
}

function launch(extensionEntry: string, sessionId: string, prompt: string, config: ReturnType<typeof loadLiveConfig>, timeoutMs: number): PiHandle {
	const child = spawn(process.execPath, [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "read,grep,find,ls,bash,flux_agent", "--session-dir", join(fixtureRoot, "sessions"),
		"--session-id", sessionId, ...config.cliArgs(config.mainModel), prompt,
	], { cwd: fixtureRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: config.env });
	const state: PiState = { stdout: "", stderr: "" };
	child.stdout?.on("data", value => { state.stdout += value.toString(); });
	child.stderr?.on("data", value => { state.stderr += value.toString(); });
	const result = new Promise<PiResult>(resolveResult => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			stopTree(child);
			resolveResult({ exitCode: 124, signal: "SIGTERM", timedOut: true, state });
		}, timeoutMs);
		child.once("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			state.stderr += `\n${error.message}`;
			resolveResult({ exitCode: 1, signal: null, timedOut: false, state });
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ exitCode: code ?? 1, signal, timedOut: false, state });
		});
	});
	return { child, state, result };
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

/** Do not count the echoed user prompt as a success marker. */
function hasAssistantText(state: PiState, marker: string): boolean {
	return state.stdout.split(/\r?\n/).some(line => {
		if (!line.trim()) return false;
		try {
			const event = JSON.parse(line);
			if (event?.type !== "message_end" || event.message?.role !== "assistant") return false;
			return (event.message.content ?? []).some((block: any) => block?.type === "text" && String(block.text ?? "").includes(marker));
		} catch { return false; }
	});
}

async function main(): Promise<void> {
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("owner-fence live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	const config = loadLiveConfig("p0-07-owner-fence");
	const startedAt = Date.now();
	const branch = git(["branch", "--show-current"]);
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const changedFiles = git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
	let mainPi: PiHandle | undefined;
	let recoveryPi: PiHandle | undefined;
	let helper: ChildProcess | undefined;
	let mainResult: PiResult | undefined;
	let recoveryResult: PiResult | undefined;
	let helperTermination: ProcessEvidence | undefined;
	let parentTask: any;
	let parentExecution: any;
	let staleRun: any;
	try {
		mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
		mkdirSync(join(fixtureRoot, "sessions"), { recursive: true });
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		cpSync(join(sourceRoot, "dist", "extension"), join(fixtureRoot, "dist", "extension"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux owner fence fixture\n", "utf8");
		writeJson(join(fixtureRoot, ".agentflux", "agentflux.json"), {
			budget: { max_cost_per_task: 0.30, max_iterations: 3, max_turns_per_task: 32, max_input_tokens_per_task: 60_000, max_wall_clock_seconds: null, max_parallel_agents: 4 },
			health: { waiting_provider_after_ms: 2_000, quiet_after_ms: 4_000, suspected_stall_after_ms: 8_000, warning_cooldown_ms: 2_000 },
			pricing: { enable_remote_fetch: false },
		});
		const models: any = config.fluxModelsJson();
		models.roles.implementer.tools = ["read", "grep", "find", "ls", "bash"];
		writeJson(join(fixtureRoot, ".agentflux", "models.json"), models);
		const extensionEntry = join(fixtureRoot, "dist", "extension", "entry.js");
		mainPi = launch(extensionEntry, "owner-fence-main", [
			"严格按顺序调用 AgentFlux 工具，不要自行完成任务。",
			"1) 调用 flux_agent action=create，name=owner-fence-live，role=implementer，scope=project。",
			"2) 调用 bash 执行 node -e \"setTimeout(() => {}, 30000)\"，等待命令完成。",
			"3) 调用 flux_agent action=run，agent=owner-fence-live，background=false，task=只回复 OWNER_FENCE_REPLACEMENT_OK，然后结束。",
			"4) 最后只输出 P0_07_OWNER_FENCE_MAIN_OK。",
		].join("\n"), config, 120_000);

		const taskPath = join(fixtureRoot, ".agentflux", "runtime", "tasks.json");
		const agentsPath = join(fixtureRoot, ".agentflux", "runtime", "agents.json");
		const deadline = Date.now() + 45_000;
		while (Date.now() < deadline) {
			const tasksStore = readJson(taskPath);
			const executions = tasksStore?.executions ?? [];
			parentTask = (tasksStore?.tasks ?? []).find((task: any) => task.status === "running"
				&& executions.find((execution: any) => execution.id === task.executionId && execution.ownerPid === mainPi?.child.pid && execution.status === "running"));
			parentExecution = parentTask ? executions.find((execution: any) => execution.id === parentTask.executionId) : undefined;
			const ownerFenceAgent = (readJson(agentsPath)?.agents ?? []).find((agent: any) => agent.name === "owner-fence-live");
			if (parentTask && parentExecution && ownerFenceAgent && mainPi.state.stdout.includes("setTimeout") && mainPi.state.stdout.includes("tool_execution_start")) break;
			await sleep(250);
		}
		if (!parentTask || !parentExecution) throw new Error("live Main did not persist a running owner Task/Execution");
		if (!mainPi.state.stdout.includes("setTimeout") || !mainPi.state.stdout.includes("tool_execution_start")) {
			throw new Error("live Main did not enter the expected long bash tool before stale-child injection");
		}

		// The helper is a real process whose PID is persisted in the stale Run;
		// killing it gives recovery an independently verifiable dead child while
		// the production Main owner remains alive in its own bash call.
		helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
			cwd: fixtureRoot, windowsHide: true, stdio: "ignore", detached: true,
		});
		if (!helper.pid) throw new Error("owner-fence helper did not expose a PID");
		const helperPid = helper.pid;
		for (let attempt = 0; attempt < 20 && !isAlive(helperPid); attempt++) await sleep(50);
		if (!isAlive(helperPid)) throw new Error(`owner-fence helper was not alive: pid=${helperPid}`);
		const fluxDir = join(fixtureRoot, ".agentflux");
		registerAgentRun(fluxDir, {
			id: "owner-fence-stale-child", sessionId: "owner-fence-main", agent: "owner-fence-live", role: "implementer",
			currentTask: "stale child under a live owner", kind: "persistent", taskId: parentTask.id, executionId: parentExecution.id,
		});
		markAgentRunRunning(fluxDir, "owner-fence-stale-child", helperPid, 1, { model: config.workerModel, provider: config.providerId });
		helperTermination = stopTree(helper, true);
		helper = undefined;
		if (!helperTermination.aliveBefore || !helperTermination.terminated) throw new Error(`owner-fence helper termination was not verified: ${JSON.stringify(helperTermination)}`);
		const runsPath = join(fluxDir, "runtime", "runs.json");
		const runsStore = readJson(runsPath);
		staleRun = runsStore?.runs?.find((run: any) => run.id === "owner-fence-stale-child");
		if (!staleRun) throw new Error("stale child Run was not persisted");
		const staleTimestamp = new Date(Date.now() - 120_000).toISOString();
		staleRun.heartbeatAt = staleTimestamp;
		staleRun.updatedAt = staleTimestamp;
		staleRun.lastActivityAt = staleTimestamp;
		writeJson(runsPath, runsStore);
		const agentsStore = readJson(agentsPath);
		const liveAgent = agentsStore?.agents?.find((agent: any) => agent.name === "owner-fence-live");
		if (!liveAgent) throw new Error("owner-fence-live Agent was not persisted");
		liveAgent.status = "running";
		liveAgent.updatedAt = new Date().toISOString();
		liveAgent.lastTask = "stale child under a live owner";
		writeJson(agentsPath, agentsStore);

		recoveryPi = launch(extensionEntry, "owner-fence-recovery", [
			"严格只调用 AgentFlux flux_agent 工具，不要调用其他工具。",
			"1) action=inspect，agent=owner-fence-live，last=5。",
			"2) action=list。",
			"完成后只输出 P0_07_OWNER_FENCE_RECOVERY_OK。",
		].join("\n"), config, 90_000);
		recoveryResult = await recoveryPi.result;
		await sleep(500);
		const afterRecoveryRuns = readJson(runsPath);
		const afterRecoveryTasks = readJson(taskPath);
		const afterRecoveryRun = afterRecoveryRuns?.runs?.find((run: any) => run.id === "owner-fence-stale-child");
		const afterRecoveryTask = afterRecoveryTasks?.tasks?.find((task: any) => task.id === parentTask.id);
		const afterRecoveryExecution = afterRecoveryTasks?.executions?.find((execution: any) => execution.id === parentExecution.id);
		const afterRecoveryAgent = (readJson(agentsPath)?.agents ?? []).find((agent: any) => agent.name === "owner-fence-live");
		const recoveryMarker = hasAssistantText(recoveryResult.state, "P0_07_OWNER_FENCE_RECOVERY_OK");
		const ownerDeferred = afterRecoveryRun?.status === "failed"
			&& afterRecoveryRun?.error === "runtime heartbeat expired before terminal convergence"
			&& afterRecoveryTask?.status === "running"
			&& afterRecoveryExecution?.status === "running"
			&& afterRecoveryExecution?.ownerPid === mainPi.child.pid
			&& (afterRecoveryRuns?.recoveryFences ?? []).length === 0;
		if (!ownerDeferred) {
			throw new Error(`owner-fence recovery did not defer safely: ${JSON.stringify({ afterRecoveryRun, afterRecoveryTask, afterRecoveryExecution, fences: afterRecoveryRuns?.recoveryFences })}`);
		}

		mainResult = await mainPi.result;
		await sleep(500);
		const finalRuns = readJson(runsPath);
		const finalTasks = readJson(taskPath);
		const replacementRun = (finalRuns?.runs ?? []).find((run: any) => run.agent === "owner-fence-live" && run.id !== "owner-fence-stale-child");
		const finalTask = (finalTasks?.tasks ?? []).find((task: any) => task.id === parentTask.id);
		const finalExecution = (finalTasks?.executions ?? []).find((execution: any) => execution.id === parentExecution.id);
		const mainMarker = hasAssistantText(mainResult.state, "P0_07_OWNER_FENCE_MAIN_OK");
		const replacementAllowed = Boolean(replacementRun && replacementRun.status === "completed");
		const passed = recoveryResult.exitCode === 0 && !recoveryResult.timedOut && recoveryMarker && ownerDeferred
			&& mainResult.exitCode === 0 && !mainResult.timedOut && mainMarker && replacementAllowed
			&& finalTask?.status === "completed" && finalExecution?.status === "completed"
			&& (finalRuns?.recoveryFences ?? []).length === 0;
		const evidence = {
			updatedAt: new Date().toISOString(), branch, sourceCommit, changedFiles,
			profile: config.profileName, configPath: config.configPath, provider: config.providerId,
			models: { main: config.mainModel, planner: config.plannerModel, worker: config.workerModel, judge: config.judgeModel },
			thinking: config.thinking, builtExtension: true, wallClockMs: Date.now() - startedAt,
			main: { pid: mainPi.child.pid, exitCode: mainResult.exitCode, timedOut: mainResult.timedOut },
			recovery: { pid: recoveryPi.child.pid, exitCode: recoveryResult.exitCode, timedOut: recoveryResult.timedOut, marker: recoveryMarker },
			helperTermination, parentTask, parentExecution, staleRun,
			afterRecovery: { run: afterRecoveryRun, task: afterRecoveryTask, execution: afterRecoveryExecution, agent: afterRecoveryAgent, fences: afterRecoveryRuns?.recoveryFences ?? [] },
			replacementRun, finalTask, finalExecution, finalFences: finalRuns?.recoveryFences ?? [],
			ownerDeferred, replacementAllowed, recoveryMarker, mainMarker, passed,
			stdoutTail: { main: mainResult.state.stdout.slice(-5000), recovery: recoveryResult.state.stdout.slice(-4000) },
			stderrTail: { main: mainResult.state.stderr.slice(-3000), recovery: recoveryResult.state.stderr.slice(-2000) },
		};
		writeJson(reportPath, evidence);
		console.log(JSON.stringify(evidence, null, 2));
		if (!passed) throw new Error(`owner-fence production evidence failed; report=${reportPath}`);
	} catch (error) {
		const failure = {
			updatedAt: new Date().toISOString(), branch, sourceCommit, changedFiles,
			profile: config.profileName, configPath: config.configPath, provider: config.providerId,
			models: { main: config.mainModel, planner: config.plannerModel, worker: config.workerModel, judge: config.judgeModel },
			thinking: config.thinking, builtExtension: true, wallClockMs: Date.now() - startedAt,
			main: mainResult ? { pid: mainPi?.child.pid, exitCode: mainResult.exitCode, timedOut: mainResult.timedOut } : { pid: mainPi?.child.pid },
			recovery: recoveryResult ? { pid: recoveryPi?.child.pid, exitCode: recoveryResult.exitCode, timedOut: recoveryResult.timedOut } : { pid: recoveryPi?.child.pid },
			helperTermination, parentTask, parentExecution, staleRun,
			observedRuns: readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [],
			observedTasks: readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json")),
			stdoutTail: { main: mainPi?.state.stdout.slice(-5000), recovery: recoveryPi?.state.stdout.slice(-4000) },
			stderrTail: { main: mainPi?.state.stderr.slice(-3000), recovery: recoveryPi?.state.stderr.slice(-2000) },
			passed: false, error: String(error instanceof Error ? error.message : error),
		};
		try { writeJson(reportPath, failure); } catch {}
		throw error;
	} finally {
		if (helper) stopTree(helper, true);
		if (mainPi) stopTree(mainPi.child, true);
		if (recoveryPi) stopTree(recoveryPi.child, true);
		try { rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
		catch (error) { console.warn(`owner-fence fixture cleanup deferred: ${String(error)}`); }
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
