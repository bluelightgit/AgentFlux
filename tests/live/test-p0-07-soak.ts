import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLiveConfig } from "./live-config";

/**
 * Repeated production-dist soak: three independent fresh Pi sessions execute
 * real no-deadline Agent Runs against one registry. The report checks terminal
 * convergence, nonzero usage, bounded recent events/registry growth and the
 * absence of active or accidentally deadline-bound Runs after the cycle.
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-soak-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-soak-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const CYCLES = 3;

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trimEnd(); }
	catch { return ""; }
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function runCycle(config: ReturnType<typeof loadLiveConfig>, extensionEntry: string, cycle: number): ReturnType<typeof spawnSync> {
	const marker = `SOAK_${cycle}_OK`;
	const prompt = [
		"严格只调用 AgentFlux flux_agent 工具，不要调用其他工具。",
		`1) action=create，name=soak-live-${cycle}，role=implementer，scope=project。`,
		`2) action=run，agent=soak-live-${cycle}，background=false，task=只回复 ${marker}。`,
		`完成后只输出 SOAK_MAIN_${cycle}_OK。`,
	].join("\n");
	return spawnSync(process.execPath, [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "flux_agent", "--session-dir", join(fixtureRoot, "sessions"), "--session-id", `soak-${cycle}`,
		...config.cliArgs(config.mainModel), prompt,
	], { cwd: fixtureRoot, encoding: "utf8", windowsHide: true, timeout: 150_000, env: config.env });
}

async function main(): Promise<void> {
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("soak live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	const config = loadLiveConfig("p0-07-soak");
	const startedAt = Date.now();
	const cycleResults: any[] = [];
	try {
		mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		mkdirSync(join(fixtureRoot, "sessions"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux repeated soak fixture\n");
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: { max_cost_per_task: 0.30, max_iterations: 3, max_wall_clock_seconds: null },
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(config.fluxModelsJson(), null, 2));
		const extensionDir = join(fixtureRoot, "dist", "extension");
		mkdirSync(extensionDir, { recursive: true });
		cpSync(join(sourceRoot, "dist", "extension"), extensionDir, { recursive: true });
		const extensionEntry = join(extensionDir, "entry.js");
		for (let cycle = 1; cycle <= CYCLES; cycle++) {
			const result = runCycle(config, extensionEntry, cycle);
			cycleResults.push({ cycle, exitCode: result.status, signal: result.signal, marker: String(result.stdout ?? "").includes(`SOAK_MAIN_${cycle}_OK`) && String(result.stdout ?? "").includes(`SOAK_${cycle}_OK`), stdoutTail: String(result.stdout ?? "").slice(-3500), stderrTail: String(result.stderr ?? "").slice(-2500) });
			if (result.status !== 0) break;
		}
		const registryPath = join(fixtureRoot, ".agentflux", "runtime", "runs.json");
		const taskPath = join(fixtureRoot, ".agentflux", "runtime", "tasks.json");
		const agentsPath = join(fixtureRoot, ".agentflux", "runtime", "agents.json");
		const runs = readJson(registryPath)?.runs ?? [];
		const tasks = readJson(taskPath)?.tasks ?? [];
		const agents = readJson(agentsPath)?.agents ?? [];
		const recentEventCounts = runs.map((run: any) => run.recentEvents?.length ?? 0);
		const terminalRuns = runs.filter((run: any) => run.status === "completed");
		const noDeadline = runs.every((run: any) => run.deadlineAt === undefined);
		const nonzeroUsage = terminalRuns.every((run: any) => run.turns > 0 && run.input > 0);
		const bounded = recentEventCounts.every((count: number) => count <= 20) && statSync(registryPath).size < 2_000_000;
		const noActiveRuns = runs.every((run: any) => !["starting", "running", "stop_requested"].includes(run.status));
		const taskTerminal = tasks.filter((task: any) => task.task.includes("soak-live-")).every((task: any) => task.status === "completed");
		const passed = cycleResults.length === CYCLES && cycleResults.every(item => item.exitCode === 0 && item.marker)
			&& runs.length === CYCLES && terminalRuns.length === CYCLES && noDeadline && nonzeroUsage && bounded && noActiveRuns && taskTerminal;
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
			cycles: cycleResults,
			runs,
			tasks,
			agents,
			resource: { registryBytes: statSync(registryPath).size, maxRecentEvents: recentEventCounts.length ? Math.max(...recentEventCounts) : 0, recentEventCounts, bounded, noActiveRuns },
			noDeadline,
			nonzeroUsage,
			taskTerminal,
			passed,
		};
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		console.log(JSON.stringify(evidence, null, 2));
		if (!passed) throw new Error(`soak evidence failed; report=${reportPath}`);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
