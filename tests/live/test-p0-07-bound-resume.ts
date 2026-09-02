import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadLiveConfig } from "./live-config";

/**
 * Production-dist Workflow coverage for the remaining bound-Agent and checkpoint
 * contracts. The fixture deliberately seeds only durable Workflow definitions;
 * both execution scenarios still enter through fresh Main Pi processes and the
 * public flux_agent/flux_workflow/flux_task tools.
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-bound-resume-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-bound-resume-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const config = loadLiveConfig("p0-07-bound-resume");
const ACTIVE = new Set(["starting", "running", "stop_requested"]);

interface PiResult {
	label: string;
	pid?: number;
	exitCode: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trimEnd(); }
	catch { return ""; }
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch { return undefined; }
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function stopTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	} else {
		try { process.kill(-child.pid, "SIGKILL"); }
		catch { try { child.kill("SIGKILL"); } catch {} }
	}
}

function launch(label: string, extensionEntry: string, sessionId: string, prompt: string, timeoutMs: number): { child: ChildProcess; result: Promise<PiResult> } {
	const args = [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "read,grep,find,ls,bash,flux_agent,flux_task,flux_workflow",
		"--session-dir", join(fixtureRoot, "sessions"), "--session-id", sessionId,
		...config.cliArgs(config.mainModel), prompt,
	];
	const child = spawn(process.execPath, args, {
		cwd: fixtureRoot,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: config.env,
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
			stopTree(child);
			resolveResult({ label, pid: child.pid, exitCode: 124, signal: "SIGTERM", stdout, stderr, timedOut: true });
		}, timeoutMs);
		child.on("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ label, pid: child.pid, exitCode: 1, signal: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false });
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ label, pid: child.pid, exitCode: code ?? 1, signal, stdout, stderr, timedOut: false });
		});
	});
	return { child, result };
}

function writeWorkflow(definition: any): void {
	const path = join(fixtureRoot, ".agentflux", "runtime", "workflows.json");
	const current = readJson(path) ?? { version: 1, definitions: [] };
	current.definitions = [...(current.definitions ?? []).filter((item: any) => item.id !== definition.id), definition];
	writeFileSync(path, JSON.stringify(current, null, 2));
}

function taskFor(tasks: any[], sessionId: string, operation?: string): any | undefined {
	return tasks
		.filter(task => task.sessionId === sessionId && (!operation || task.operation === operation))
		.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
}

async function main(): Promise<void> {
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("P0-07 bound/resume live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	const startedAt = Date.now();
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const branch = git(["branch", "--show-current"]);
	const changedFiles = git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
	let seedPi: { child: ChildProcess; result: Promise<PiResult> } | undefined;
	let boundPi: { child: ChildProcess; result: Promise<PiResult> } | undefined;
	let checkpointSeedPi: { child: ChildProcess; result: Promise<PiResult> } | undefined;
	let checkpointResumePi: { child: ChildProcess; result: Promise<PiResult> } | undefined;
	mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
	try {
		cpSync(join(sourceRoot, "dist", "extension"), join(fixtureRoot, "dist", "extension"), { recursive: true });
		mkdirSync(join(fixtureRoot, ".agentflux", "runtime"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux bound and checkpoint fixture\n");
		const liveModels: any = config.fluxModelsJson();
		liveModels.roles.implementer.tools = ["read", "grep", "find", "ls", "bash"];
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(liveModels, null, 2));
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: { max_cost_per_task: 0.5, max_iterations: 4, max_wall_clock_seconds: null, max_parallel_agents: 2 },
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		const extensionEntry = join(fixtureRoot, "dist", "extension", "entry.js");

		seedPi = launch("bound-agent-seed", extensionEntry, "bound-agent-seed", [
			"严格只调用一次 AgentFlux flux_agent 工具，不要调用其他工具。",
			"action=create，name=bound-live，role=implementer，scope=project。成功后只输出 BOUND_AGENT_CREATED。",
		].join("\n"), 120_000);
		const seedResult = await seedPi.result;
		const seededAgents = readJson(join(fixtureRoot, ".agentflux", "runtime", "agents.json"))?.agents ?? [];
		const boundAgent = seededAgents.find((agent: any) => agent.name === "bound-live");
		if (seedResult.exitCode !== 0 || !seedResult.stdout.includes("BOUND_AGENT_CREATED") || !boundAgent?.id) {
			throw new Error(`bound Agent seed failed: ${JSON.stringify({ result: seedResult, agents: seededAgents })}`);
		}

		const now = new Date().toISOString();
		writeWorkflow({
			id: "workflow-bound-live",
			name: "bound-live-workflow",
			version: 1,
			description: "Bound Agent shared/fresh production validation",
			dag: {
				description: "Bound Agent shared and fresh session validation",
				nodes: [
					{ id: "shared", title: "bound shared", role: "implementer", agentId: boundAgent.id, sessionMode: "shared", dependsOn: [], parallelizable: false, acceptanceCriteria: [], files: [], description: "Read README.md first line, then reply BOUND_SHARED_OK." },
					{ id: "fresh", title: "bound fresh", role: "implementer", agentId: boundAgent.id, sessionMode: "fresh", dependsOn: ["shared"], parallelizable: false, acceptanceCriteria: [], files: [], description: "Read README.md first line, then reply BOUND_FRESH_OK." },
				],
			},
			createdAt: now,
			updatedAt: now,
		});
		boundPi = launch("bound-workflow", extensionEntry, "bound-workflow", [
			"严格只调用一次 AgentFlux flux_workflow 工具，不要调用其他工具。",
			"调用 action=reuse，workflow=bound-live-workflow；等待两个绑定节点都完成后，只输出 BOUND_WORKFLOW_OK。",
		].join("\n"), 180_000);
		const boundResult = await boundPi.result;
		const boundAgentsAfter = readJson(join(fixtureRoot, ".agentflux", "runtime", "agents.json"))?.agents ?? [];
		const boundAfter = boundAgentsAfter.find((agent: any) => agent.id === boundAgent.id);
		const boundRuns = (readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [])
			.filter((run: any) => run.agent === "bound-live");
		const boundTasks = readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json"))?.tasks ?? [];
		const boundWorkflowTask = taskFor(boundTasks, "bound-workflow", "reuse");
		const sharedRun = boundRuns.find((run: any) => run.status === "completed" && run.lastProgressSummary?.includes("BOUND_SHARED_OK"));
		const freshRun = boundRuns.find((run: any) => run.status === "completed" && run.lastProgressSummary?.includes("BOUND_FRESH_OK"));
		const boundValid = boundResult.exitCode === 0
			&& boundResult.stdout.includes("BOUND_WORKFLOW_OK")
			&& boundWorkflowTask?.status === "completed"
			&& boundRuns.length === 2
			&& boundRuns.every((run: any) => run.status === "completed" && run.role === "implementer")
			&& !!sharedRun && !!freshRun
			&& boundAfter?.status === "idle"
			&& typeof boundAfter.lastSessionId === "string" && boundAfter.lastSessionId.includes("-fresh-");

		writeFileSync(join(fixtureRoot, "resume-once.flag"), "sleep once\n");
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: { max_cost_per_task: 0.5, max_iterations: 4, max_wall_clock_seconds: 25, max_parallel_agents: 2 },
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		writeWorkflow({
			id: "workflow-checkpoint-live",
			name: "checkpoint-live-workflow",
			version: 1,
			description: "Checkpoint resume production validation",
			dag: {
				description: "Checkpoint resume validation",
				nodes: [{
					id: "resume-node",
					title: "resume once",
					role: "implementer",
					dependsOn: [],
					parallelizable: false,
					acceptanceCriteria: [],
					files: [],
					description: "Use bash with exactly this command: node -e \"const fs=require('fs');const p='resume-once.flag';if(fs.existsSync(p)){fs.unlinkSync(p);setTimeout(()=>{},60000)}else{console.log('CHECKPOINT_RESUME_NODE_OK')}\". Do not reply until the command finishes. On a later resumed attempt, reply CHECKPOINT_RESUME_NODE_OK.",
				}],
			},
			createdAt: now,
			updatedAt: new Date().toISOString(),
		});
		checkpointSeedPi = launch("checkpoint-seed", extensionEntry, "checkpoint-live", [
			"严格只调用一次 AgentFlux flux_workflow 工具，不要调用其他工具。",
			"调用 action=reuse，workflow=checkpoint-live-workflow；等待该 Workflow 返回失败/超时结果后只输出 CHECKPOINT_SEED_DONE。",
		].join("\n"), 120_000);
		const checkpointSeedResult = await checkpointSeedPi.result;
		const afterSeedTasks = readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json"))?.tasks ?? [];
		const seedTask = taskFor(afterSeedTasks, "checkpoint-live", "reuse");
		const seedExecutionId = seedTask?.executionId;
		const seedCheckpoint = seedExecutionId ? readJson(join(fixtureRoot, ".agentflux", "runtime", "runs", seedExecutionId, "checkpoint.json")) : undefined;
		const seedRuns = seedTask ? (readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? []).filter((run: any) => run.taskId === seedTask.id) : [];
		const seedFailed = seedTask && ["failed", "timed_out"].includes(seedTask.status)
			&& seedCheckpoint?.failed?.includes("resume-node")
			&& seedRuns.some((run: any) => ["failed", "timed_out"].includes(run.status));

		checkpointResumePi = launch("checkpoint-resume", extensionEntry, "checkpoint-live", [
			"严格按顺序实际调用 AgentFlux 工具，不要调用其他工具。",
			"1) 调用 flux_task，action=resume，selector=latest。",
			"2) 工具成功后调用 flux_workflow，action=run；不要重新设计或复用其他 Workflow，等待 checkpoint resume 完成。",
			"3) 成功后只输出 CHECKPOINT_RESUME_OK。",
		].join("\n"), 180_000);
		const checkpointResumeResult = await checkpointResumePi.result;
		const finalTaskStore = readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json")) ?? {};
		const finalTasks = finalTaskStore.tasks ?? [];
		const resumeTask = taskFor(finalTasks, "checkpoint-live", "resume");
		const resumeExecution = resumeTask?.executionId ? (finalTaskStore.executions ?? []).find((execution: any) => execution.id === resumeTask.executionId) : undefined;
		const resumeCheckpoint = resumeTask?.executionId ? readJson(join(fixtureRoot, ".agentflux", "runtime", "runs", resumeTask.executionId, "checkpoint.json")) : undefined;
		const finalRuns = resumeTask ? (readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? []).filter((run: any) => run.taskId === resumeTask.id) : [];
		const resumedNodeRun = finalRuns.find((run: any) => run.status === "completed" && String(run.lastProgressSummary ?? "").includes("CHECKPOINT_RESUME_NODE_OK"));
		const resumeValid = checkpointSeedResult.stdout.includes("CHECKPOINT_SEED_DONE")
			&& checkpointResumeResult.exitCode === 0
			&& checkpointResumeResult.stdout.includes("CHECKPOINT_RESUME_OK")
			&& !!seedTask && !!resumeTask && seedFailed
			&& resumeTask.status === "completed"
			&& resumeTask.parentTaskId === seedTask.id
			&& resumeTask.parentExecutionId === seedTask.executionId
			&& resumeExecution?.parentTaskId === seedTask.id
			&& resumeExecution?.parentExecutionId === seedTask.executionId
			&& resumeCheckpoint?.resumedFromExecutionId === seedTask.executionId
			&& !!resumedNodeRun;

		const evidence = {
			updatedAt: new Date().toISOString(), branch, sourceCommit, changedFiles,
			profile: config.profileName, configPath: config.configPath, provider: config.providerId,
			models: { main: config.mainModel, planner: config.plannerModel, worker: config.workerModel, judge: config.judgeModel },
			thinking: config.thinking, builtExtension: true, wallClockMs: Date.now() - startedAt,
			boundAgent: { id: boundAgent.id, name: boundAgent.name, status: boundAfter?.status, callCount: boundAfter?.callCount, lastSessionId: boundAfter?.lastSessionId },
			bound: {
				pi: { pid: boundResult.pid, exitCode: boundResult.exitCode, timedOut: boundResult.timedOut },
				workflowTask: boundWorkflowTask,
				runs: boundRuns.map((run: any) => ({ id: run.id, status: run.status, role: run.role, sessionId: run.sessionId, turns: run.turns, input: run.input, costUsd: run.costUsd, lastProgressSummary: run.lastProgressSummary, recentEvents: run.recentEvents })),
				sharedRunId: sharedRun?.id, freshRunId: freshRun?.id, valid: boundValid,
				stdoutTail: boundResult.stdout.slice(-6000), stderrTail: boundResult.stderr.slice(-3000),
			},
			checkpoint: {
				seedPi: { pid: checkpointSeedResult.pid, exitCode: checkpointSeedResult.exitCode, timedOut: checkpointSeedResult.timedOut },
				resumePi: { pid: checkpointResumeResult.pid, exitCode: checkpointResumeResult.exitCode, timedOut: checkpointResumeResult.timedOut },
				seedTask, seedCheckpoint, seedRuns: seedRuns.map((run: any) => ({ id: run.id, status: run.status, phase: run.phase, turns: run.turns, input: run.input, costUsd: run.costUsd, error: run.error, recentEvents: run.recentEvents })),
				resumeTask, resumeExecution, resumeCheckpoint,
				resumedNodeRun: resumedNodeRun ? { id: resumedNodeRun.id, status: resumedNodeRun.status, turns: resumedNodeRun.turns, input: resumedNodeRun.input, costUsd: resumedNodeRun.costUsd, lastProgressSummary: resumedNodeRun.lastProgressSummary, recentEvents: resumedNodeRun.recentEvents } : undefined,
				seedFailed: Boolean(seedFailed), valid: resumeValid,
				stdoutTail: { seed: checkpointSeedResult.stdout.slice(-5000), resume: checkpointResumeResult.stdout.slice(-6000) },
				stderrTail: { seed: checkpointSeedResult.stderr.slice(-2500), resume: checkpointResumeResult.stderr.slice(-2500) },
			},
			passed: boundValid && resumeValid,
		};
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		if (!evidence.passed) throw new Error(`P0-07 bound/resume live evidence failed; report=${reportPath}`);
		console.log(JSON.stringify(evidence, null, 2));
	} finally {
		for (const handle of [seedPi, boundPi, checkpointSeedPi, checkpointResumePi]) if (handle) stopTree(handle.child);
		try { rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
		catch (error) { console.warn(`bound/resume fixture cleanup deferred: ${String(error)}`); }
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
