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

interface PiResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
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

function stopTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	else {
		try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
	}
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
			stopTree(child);
			resolveResult({ status: 124, signal: "SIGTERM", stdout, stderr, timedOut: true });
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
	let first: PiHandle | undefined;
	let recovery: PiHandle | undefined;
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
		stopTree(first.child);
		const firstResult = await first.result;
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
		const recoveryResult = await recovery.result;
		await sleep(500);
		const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [];
		const recoveredRun = runs.find((run: any) => run.id === orphanRunId);
		const agents = readJson(join(fixtureRoot, ".agentflux", "runtime", "agents.json"))?.agents ?? [];
		const recoveredAgent = agents.find((agent: any) => agent.name === "restart-live");
		const tasks = readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json"))?.tasks ?? [];
		const marker = `${recoveryResult.stdout}\n${recoveryResult.stderr}`.includes("P0_07_RESTART_RECOVERY_OK");
		const recovered = recoveredRun?.status === "failed"
			&& recoveredRun.pid === undefined
			&& recoveredRun.error === "runtime heartbeat expired before terminal convergence"
			&& recoveredRun.recentEvents?.some((event: any) => event.type === "heartbeat_expired")
			&& recoveredAgent?.status === "idle";
		const passed = Boolean(orphanRunId) && ACTIVE.has(beforeRecovery?.status) && recoveryResult.status === 0 && marker && recovered;
		const evidence = {
			updatedAt: new Date().toISOString(),
			branch: git(["branch", "--show-current"]),
			sourceCommit: git(["rev-parse", "HEAD"]),
			changedFiles: git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line),
			profile: config.profileName,
			configPath: config.configPath,
			provider: config.providerId,
			models: { main: config.mainModel, planner: config.plannerModel, worker: config.workerModel, judge: config.judgeModel },
			thinking: config.thinking,
			builtExtension: true,
			wallClockMs: Date.now() - startedAt,
			firstPi: { pid: first.child.pid, exitCode: firstResult.status, signal: firstResult.signal, stdoutTail: firstResult.stdout.slice(-5000), stderrTail: firstResult.stderr.slice(-3000) },
			recoveryPi: { pid: recoveryResult.status === 0 ? recovery.child.pid : recovery.child.pid, exitCode: recoveryResult.status, signal: recoveryResult.signal, marker, stdoutTail: recoveryResult.stdout.slice(-5000), stderrTail: recoveryResult.stderr.slice(-3000) },
			orphanBeforeRecovery: beforeRecovery,
			recoveredRun,
			recoveredAgent,
			tasks,
			orphanRunId,
			recovered,
			passed,
		};
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		console.log(JSON.stringify(evidence, null, 2));
		if (!passed) throw new Error(`restart/orphan recovery evidence failed; report=${reportPath}`);
	} finally {
		if (first) stopTree(first.child);
		if (recovery) stopTree(recovery.child);
		rmSync(fixtureRoot, { recursive: true, force: true });
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
