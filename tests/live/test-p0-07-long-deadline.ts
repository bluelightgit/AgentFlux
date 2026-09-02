import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadLiveConfig } from "./live-config";

/**
 * P0-07 production-dist long-run evidence：真实 Agent 在没有显式 deadline 时，
 * 执行超过旧 600 秒限制的 bash 工具，并在最后正常收敛；host 只读取 Core 事实。
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-long-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-long-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const ACTIVE = new Set(["starting", "running", "stop_requested"]);

interface PiResult {
	pid?: number;
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function readRun(): any | undefined {
	return readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs?.find((run: any) => run.agent === "long-live");
}

function killTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	else {
		try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
	}
}

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trimEnd(); }
	catch { return ""; }
}

function launch(extensionEntry: string, config: ReturnType<typeof loadLiveConfig>, prompt: string): { child: ChildProcess; result: Promise<PiResult> } {
	const args = [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "read,grep,find,ls,flux_agent", ...config.cliArgs(config.mainModel), prompt,
	];
	const child = spawn(process.execPath, args, {
		cwd: fixtureRoot,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...config.env,
			HOME: fixtureRoot,
			USERPROFILE: fixtureRoot,
			PI_CODING_AGENT_DIR: config.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
		},
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
			killTree(child.pid);
			resolveResult({ pid: child.pid, exitCode: 124, stdout, stderr, timedOut: true });
		}, 720_000);
		child.on("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ pid: child.pid, exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false });
		});
		child.on("close", code => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ pid: child.pid, exitCode: code ?? 1, stdout, stderr, timedOut: false });
		});
	});
	return { child, result };
}

async function main(): Promise<void> {
	const config = loadLiveConfig("p0-07-long");
	const startedAt = Date.now();
	const useBuiltExtension = process.env.AGENTFLUX_LIVE_BUILT === "1";
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const branch = git(["branch", "--show-current"]);
	const changedFiles = git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
	let pi: { child: ChildProcess; result: Promise<PiResult> } | undefined;
	const snapshots: any[] = [];
	try {
		mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		if (!useBuiltExtension) throw new Error("P0-07 long-run live test requires AGENTFLUX_LIVE_BUILT=1");
		if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js")) || !existsSync(join(sourceRoot, "dist", "extension", "subagent-entry.js"))) {
			throw new Error("production dist entries are missing; run npm run build first");
		}
		cpSync(join(sourceRoot, "dist", "extension"), join(fixtureRoot, "dist", "extension"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux P0-07 long-run fixture\n");
		const models: any = config.fluxModelsJson();
		models.models[config.workerModel] = {
			...models.models[config.workerModel],
			pricing: { input: 0.00000009, output: 0.00000018, cacheRead: 0.00000002, cacheWrite: 0.00000009 },
		};
		models.roles.implementer.tools = ["read", "grep", "find", "ls", "bash"];
		models.roles.implementer.systemPrompt = [
			"You are the implementer in a long-run reliability test.",
			"When the task specifies an exact bash command and timeout, call bash with those exact JSON arguments.",
			"Never shorten, omit, or replace the requested delay; do not answer until the command has completed.",
		].join(" ");
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(models, null, 2));
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: {
				max_cost_per_task: 0.15,
				max_iterations: 3,
				max_wall_clock_seconds: null,
				max_parallel_agents: 4,
			},
			health: {
				waiting_provider_after_ms: 5_000,
				quiet_after_ms: 15_000,
				suspected_stall_after_ms: 30_000,
				suspected_loop_repeats: 3,
				warning_cooldown_ms: 5_000,
				context_pressure_percent: 0.85,
			},
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		const prompt = [
			"只能按顺序调用 AgentFlux flux_agent 工具，不要调用其他工具。",
			"1) action=create，name=long-live，role=implementer，scope=project。",
			"2) action=run，agent=long-live，role=implementer，background=false。task 必须原样使用：",
			"调用 bash，参数必须是 command=node -e \"setTimeout(() => process.exit(0), 605000)\" 且 timeout=610；等待这个命令完整结束，在命令结束前不要回复；命令结束后只回复 LONG_NO_DEADLINE_DONE。",
			"run 返回后只输出 LONG_MAIN_DONE。",
		].join("\n");
		pi = launch(join(fixtureRoot, "dist", "extension", "entry.js"), config, prompt);
		let closed = false;
		pi.child.once("close", () => { closed = true; });
		let lastSignature = "";
		let maxActiveMs = 0;
		let sawWarning = false;
		while (!closed) {
			const run = readRun();
			if (run) {
				if (ACTIVE.has(run.status)) {
					const age = Date.now() - Date.parse(run.createdAt);
					if (Number.isFinite(age)) maxActiveMs = Math.max(maxActiveMs, age);
				}
				sawWarning ||= (run.healthWarningCount ?? 0) > 0 || ["quiet", "suspected_stall", "suspected_loop", "context_pressure"].includes(run.health);
				const signature = [run.status, run.phase, run.health, run.turns, run.input, run.output, run.costUsd, run.lastProgressType, run.updatedAt].join("|");
				if (signature !== lastSignature) {
					lastSignature = signature;
					snapshots.push({
						at: new Date().toISOString(),
						status: run.status,
						phase: run.phase,
						health: run.health,
						healthWarningCount: run.healthWarningCount,
						turns: run.turns,
						input: run.input,
						output: run.output,
						costUsd: run.costUsd,
						lastProgressAt: run.lastProgressAt,
						lastProgressType: run.lastProgressType,
						lastActivityType: run.lastActivityType,
						updatedAt: run.updatedAt,
					});
				}
			}
			await sleep(1_000);
		}
		const result = await pi.result;
		await sleep(1_000);
		const run = readRun();
		const durationMs = run?.createdAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : maxActiveMs;
		const marker = result.stdout.includes("LONG_MAIN_DONE") || result.stderr.includes("LONG_MAIN_DONE");
		const sawTool = snapshots.some(snapshot => snapshot.lastProgressType === "tool_start" || snapshot.phase === "tool");
		const completedNormally = result.exitCode === 0 && !result.timedOut && run?.status === "completed" && run.phase === "terminal" && run.pid === undefined;
		const noDeadline = run?.deadlineAt === undefined;
		const nonzeroUsage = (run?.turns ?? 0) > 0 && ((run?.input ?? 0) + (run?.output ?? 0)) > 0 && (run?.costUsd ?? 0) > 0;
		const passed = useBuiltExtension && marker && completedNormally && noDeadline && nonzeroUsage && sawTool && sawWarning && durationMs >= 600_000;
		const report = {
			updatedAt: new Date().toISOString(),
			branch,
			sourceCommit,
			changedFiles,
			profile: config.profileName,
			configPath: config.configPath,
			provider: config.providerId,
			model: config.workerModel,
			thinking: config.thinking,
			builtExtension: useBuiltExtension,
			extensionEntry: join(fixtureRoot, "dist", "extension", "entry.js"),
			subagentEntry: join(fixtureRoot, "dist", "extension", "subagent-entry.js"),
			main: { pid: result.pid, exitCode: result.exitCode, timedOut: result.timedOut },
			wallClockMs: Date.now() - startedAt,
			runDurationMs: durationMs,
			maxActiveMs,
			marker,
			sawTool,
			sawWarning,
			noDeadline,
			nonzeroUsage,
			completedNormally,
			run,
			snapshotCount: snapshots.length,
			snapshots,
			stdoutTail: result.stdout.slice(-5000),
			stderrTail: result.stderr.slice(-5000),
			passed,
		};
		writeFileSync(reportPath, JSON.stringify(report, null, 2));
		if (!passed) throw new Error(`P0-07 long-run live evidence failed; report=${reportPath}`);
		console.log(JSON.stringify({ ...report, reportPath }, null, 2));
	} finally {
		if (pi) killTree(pi.child.pid);
		try { rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
		catch (error) { console.warn(`long-run fixture cleanup deferred: ${String(error)}`); }
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
