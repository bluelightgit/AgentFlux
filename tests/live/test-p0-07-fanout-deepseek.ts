import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkflowDefinition } from "../../src/workflows/workflow-registry";
import { loadLiveConfig } from "./live-config";

/**
 * P0-07 production-dist fan-out：一个真实 Main Pi 复用四节点并行 Workflow，
 * 由 Core Run Registry 核对四个 child 的在线 usage/health，以及父 Task 聚合轮次预算。
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-fanout-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-fanout-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const nodeAgents = ["dag-a", "dag-b", "dag-c", "dag-d"];
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

function readRuns(): any[] {
	return readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [];
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
		"--no-skills", "--tools", "read,grep,find,ls,flux_agent,flux_workflow", ...config.cliArgs(config.modelFlash), prompt,
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
		}, 180_000);
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
	const config = loadLiveConfig();
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
		if (!useBuiltExtension) throw new Error("P0-07 fan-out live test requires AGENTFLUX_LIVE_BUILT=1");
		if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js")) || !existsSync(join(sourceRoot, "dist", "extension", "subagent-entry.js"))) {
			throw new Error("production dist entries are missing; run npm run build first");
		}
		cpSync(join(sourceRoot, "dist", "extension"), join(fixtureRoot, "dist", "extension"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux P0-07 fan-out fixture\n");
		const models: any = config.fluxModelsJson();
		models.models[config.modelFlash] = {
			...models.models[config.modelFlash],
			pricing: { input: 0.00000009, output: 0.00000018, cacheRead: 0.00000002, cacheWrite: 0.00000009 },
		};
		models.roles.implementer.tools = ["read", "grep", "find", "ls", "bash"];
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(models, null, 2));
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: {
				max_cost_per_task: 1,
				// Each child normally emits one tool-call and one final assistant turn.
				// Leave enough aggregate headroom for all four children so this fixture
				// validates successful fan-out rather than intentional budget rejection.
				max_turns_per_task: 16,
				max_input_tokens_per_task: 100_000,
				max_wall_clock_seconds: null,
				max_parallel_agents: 4,
			},
			health: {
				waiting_provider_after_ms: 2_000,
				quiet_after_ms: 4_000,
				suspected_stall_after_ms: 8_000,
				suspected_loop_repeats: 3,
				warning_cooldown_ms: 2_000,
				context_pressure_percent: 0.85,
			},
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		createWorkflowDefinition(join(fixtureRoot, ".agentflux"), {
			name: "p0-07-four-agent-fanout",
			dag: {
				description: "Four real parallel children for aggregate parent budget evidence",
				nodes: nodeAgents.map((suffix, index) => ({
					id: String.fromCharCode(97 + index),
					title: suffix,
					role: "implementer",
					dependsOn: [],
					parallelizable: true,
					acceptanceCriteria: [],
					files: [],
					description: `必须调用 bash 执行 node -e "setTimeout(() => process.exit(0), 5000)"；工具结束后只回复 FANOUT_${suffix.toUpperCase()}_DONE。`,
				})),
			},
		});
		const prompt = [
			"必须实际调用 AgentFlux 工具，不要调用其他工具。",
			"调用 flux_workflow，action=reuse，workflow=p0-07-four-agent-fanout；等待 Workflow 返回。",
			"该固定 DAG 有四个可并行的 implementer child；不要改成单节点或自行完成子任务。",
			"Workflow 返回后调用 flux_agent action=list 核对 Agent 状态，然后只输出 P0_07_FANOUT_MAIN_DONE。",
		].join("\n");
		pi = launch(join(fixtureRoot, "dist", "extension", "entry.js"), config, prompt);
		let closed = false;
		pi.child.once("close", () => { closed = true; });
		let lastSignature = "";
		let maxActive = 0;
		while (!closed) {
			const runs = readRuns().filter(run => nodeAgents.includes(run.agent));
			maxActive = Math.max(maxActive, runs.filter(run => ACTIVE.has(run.status)).length);
			const signature = JSON.stringify(runs.map(run => [run.id, run.status, run.phase, run.turns, run.input, run.output, run.costUsd, run.health, run.updatedAt]));
			if (signature !== lastSignature) {
				lastSignature = signature;
				if (runs.length > 0) snapshots.push(runs.map(run => ({
					id: run.id, agent: run.agent, status: run.status, phase: run.phase, health: run.health,
					turns: run.turns, input: run.input, output: run.output, costUsd: run.costUsd,
					lastProgressAt: run.lastProgressAt, lastProgressType: run.lastProgressType, updatedAt: run.updatedAt,
				})));
			}
			await sleep(50);
		}
		const result = await pi.result;
		await sleep(500);
		const runs = readRuns().filter(run => nodeAgents.includes(run.agent));
		const terminalRuns = runs.filter(run => !ACTIVE.has(run.status));
		const nonzeroRuns = runs.filter(run => (run.turns ?? 0) > 0 && ((run.input ?? 0) + (run.output ?? 0)) > 0 && (run.costUsd ?? 0) > 0);
		const parentBudgetRuns = runs.filter(run => run.recentEvents?.some((event: any) => event.type === "parent_budget_exhausted") || String(run.error ?? "").includes("parent task budget"));
		const agentsWithNonzeroRun = new Set(nonzeroRuns.map(run => run.agent));
		const latestByAgent = new Map<string, any>();
		for (const run of runs) {
			const previous = latestByAgent.get(run.agent);
			if (!previous || String(run.updatedAt ?? "") > String(previous.updatedAt ?? "")) latestByAgent.set(run.agent, run);
		}
		const successfulAgents = new Set([...latestByAgent.values()]
			.filter(run => run.status === "completed" && (run.turns ?? 0) > 0 && (run.costUsd ?? 0) > 0)
			.map(run => run.agent));
		const aggregateUsage = runs.reduce((sum, run) => ({
			turns: sum.turns + (Number.isFinite(run.turns) ? run.turns : 0),
			input: sum.input + (Number.isFinite(run.input) ? run.input : 0),
			costUsd: sum.costUsd + (Number.isFinite(run.costUsd) ? run.costUsd : 0),
		}), { turns: 0, input: 0, costUsd: 0 });
		const parentBudget = { maxTurns: 16, maxInputTokens: 100_000, maxCostUsd: 1, maxParallel: 4 };
		const withinParentBudgets = aggregateUsage.turns <= parentBudget.maxTurns
			&& aggregateUsage.input <= parentBudget.maxInputTokens
			&& aggregateUsage.costUsd <= parentBudget.maxCostUsd;
		const marker = result.stdout.includes("P0_07_FANOUT_MAIN_DONE") || result.stderr.includes("P0_07_FANOUT_MAIN_DONE");
		const noDeadlines = runs.length >= 4 && runs.every(run => run.deadlineAt === undefined);
		const terminalAndCorrelated = terminalRuns.length === runs.length && nodeAgents.every(agent => runs.some(run => run.agent === agent))
			&& runs.every(run => run.taskId && run.executionId && run.taskId === run.executionId);
		const successfulFanout = nodeAgents.every(agent => successfulAgents.has(agent));
		const passed = result.exitCode === 0 && !result.timedOut && marker && nodeAgents.every(agent => agentsWithNonzeroRun.has(agent)) && maxActive >= 4
			&& noDeadlines && terminalAndCorrelated && successfulFanout && withinParentBudgets;
		const report = {
			updatedAt: new Date().toISOString(),
			branch,
			sourceCommit,
			changedFiles,
			provider: config.providerId,
			model: config.modelFlash,
			thinking: config.thinking,
			builtExtension: useBuiltExtension,
			extensionEntry: join(fixtureRoot, "dist", "extension", "entry.js"),
			subagentEntry: join(fixtureRoot, "dist", "extension", "subagent-entry.js"),
			main: { pid: result.pid, exitCode: result.exitCode, timedOut: result.timedOut },
			wallClockMs: Date.now() - startedAt,
			marker,
			maxActive,
			runCount: runs.length,
			nonzeroRunCount: nonzeroRuns.length,
			agentsWithNonzeroRun: [...agentsWithNonzeroRun].sort(),
			successfulAgents: [...successfulAgents].sort(),
			parentBudget,
			aggregateUsage,
			withinParentBudgets,
			parentBudgetRunCount: parentBudgetRuns.length,
			noDeadlines,
			terminalAndCorrelated,
			runs,
			snapshotCount: snapshots.length,
			snapshots,
			stdoutTail: result.stdout.slice(-5000),
			stderrTail: result.stderr.slice(-5000),
			passed,
		};
		writeFileSync(reportPath, JSON.stringify(report, null, 2));
		if (!passed) throw new Error(`P0-07 fan-out live evidence failed; report=${reportPath}`);
		console.log(JSON.stringify({ ...report, reportPath }, null, 2));
	} finally {
		if (pi) killTree(pi.child.pid);
		try { rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
		catch (error) { console.warn(`fan-out fixture cleanup deferred: ${String(error)}`); }
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
