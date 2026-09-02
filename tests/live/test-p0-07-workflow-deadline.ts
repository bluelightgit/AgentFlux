import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadLiveConfig } from "./live-config";

/**
 * P0-07/P0-01/P0-04 production-dist Workflow evidence:
 *
 * 1. A fresh Main Pi calls action=run (not reuse), so a real planner creates a
 *    DAG, a real node runs, and a real quality-gate judge returns a verifiable
 *    pass.
 * 2. A separate fresh Main Pi uses an explicit short parent deadline and a
 *    real long bash command; the child must converge to timed_out with an
 *    absolute deadline in Run Registry rather than being reported as success.
 *
 * Both scenarios inspect durable Task/Execution/Workflow/Run/checkpoint facts,
 * not only the Main model's final text. They require the built extension.
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-workflow-deadline-${process.pid}`);
const workflowRoot = join(fixtureRoot, "workflow");
const propagationRoot = join(fixtureRoot, "propagation");
const parentTimeoutRoot = join(fixtureRoot, "parent-timeout");
const deadlineRoot = join(fixtureRoot, "deadline");
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-workflow-deadline-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const ACTIVE = new Set(["starting", "running", "stop_requested"]);

type PiResult = { pid?: number; exitCode: number; stdout: string; stderr: string; timedOut: boolean };
type PiHandle = { child: ChildProcess; result: Promise<PiResult> };

function sleep(ms: number): Promise<void> { return new Promise(resolveSleep => setTimeout(resolveSleep, ms)); }

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function readRuns(root: string): any[] {
	return readJson(join(root, ".agentflux", "runtime", "runs.json"))?.runs ?? [];
}

function killTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	} else {
		try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
	}
}

function git(args: string[]): string {
	try { return requireGit(args); } catch { return ""; }
}

function requireGit(args: string[]): string {
	const result = spawnSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return String(result.stdout).trimEnd();
}

function setupFixture(root: string, config: ReturnType<typeof loadLiveConfig>, budget: Record<string, unknown>, options: { bash?: boolean; qualityGate?: boolean; qualityGateTimeoutMs?: number } = {}): void {
	mkdirSync(join(root, ".agentflux"), { recursive: true });
	cpSync(join(sourceRoot, "dist", "extension"), join(root, "dist", "extension"), { recursive: true });
	writeFileSync(join(root, "README.md"), "# AgentFlux built Workflow fixture\nThe first line is the only content the node must inspect.\n");
	const fluxConfig: Record<string, unknown> = {
		budget,
		health: {
			waiting_provider_after_ms: 2_000,
			quiet_after_ms: 4_000,
			suspected_stall_after_ms: 8_000,
			suspected_loop_repeats: 3,
			warning_cooldown_ms: 2_000,
			context_pressure_percent: 0.85,
		},
		pricing: { enable_remote_fetch: false },
	};
	if (options.qualityGate) fluxConfig.quality_gate = { model: config.judgeModel, timeout_ms: options.qualityGateTimeoutMs ?? 180_000 };
	writeFileSync(join(root, ".agentflux", "agentflux.json"), JSON.stringify(fluxConfig, null, 2));
	const models: any = config.fluxModelsJson();
	for (const model of [config.mainModel, config.plannerModel, config.workerModel, config.judgeModel]) {
		models.models[model] = {
			...models.models[model],
			pricing: { input: 0.00000009, output: 0.00000018, cacheRead: 0.00000002, cacheWrite: 0.00000009 },
		};
	}
	if (options.bash) models.roles.implementer.tools = ["read", "grep", "find", "ls", "bash"];
	if (options.bash || options.qualityGate) models.roles.implementer = { ...models.roles.implementer, model: config.workerModel, thinking: config.thinking };
	if (options.qualityGate) models.roles.planner = { ...models.roles.planner, model: config.plannerModel, thinking: config.thinking };
	writeFileSync(join(root, ".agentflux", "models.json"), JSON.stringify(models, null, 2));
}

function launch(root: string, extensionEntry: string, tools: string, model: string, config: ReturnType<typeof loadLiveConfig>, prompt: string, timeoutMs: number): PiHandle {
	const args = [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", tools, ...config.cliArgs(model), prompt,
	];
	const child = spawn(process.execPath, args, {
		cwd: root,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...config.env,
			HOME: root,
			USERPROFILE: root,
			PI_CODING_AGENT_DIR: config.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
		},
	});
	let stdout = "";
	let stderr = "";
	const result = new Promise<PiResult>(resolveResult => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			killTree(child.pid);
			resolveResult({ pid: child.pid, exitCode: 124, stdout, stderr, timedOut: true });
		}, timeoutMs);
		child.stdout?.on("data", value => { stdout += value.toString(); });
		child.stderr?.on("data", value => { stderr += value.toString(); });
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

async function waitForPi(root: string, handle: PiHandle, snapshots: any[], timeoutMs: number): Promise<PiResult> {
	let closed = false;
	handle.child.once("close", () => { closed = true; });
	let lastSignature = "";
	const deadline = Date.now() + timeoutMs;
	while (!closed && Date.now() < deadline) {
		const runs = readRuns(root);
		const signature = JSON.stringify(runs.map(run => [run.id, run.status, run.phase, run.turns, run.input, run.output, run.costUsd, run.health, run.updatedAt]));
		if (signature !== lastSignature && runs.length > 0) {
			lastSignature = signature;
			snapshots.push(runs.map(run => ({
				id: run.id, agent: run.agent, role: run.role, status: run.status, phase: run.phase,
				health: run.health, deadlineAt: run.deadlineAt, turns: run.turns, input: run.input,
				output: run.output, costUsd: run.costUsd, lastActivityType: run.lastActivityType,
				lastActivitySummary: run.lastActivitySummary, updatedAt: run.updatedAt,
			})));
		}
		await sleep(100);
	}
	return handle.result;
}

function latestRun(runs: any[], predicate: (run: any) => boolean): any | undefined {
	return runs.filter(predicate).sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
}

function safeRead(path: string): any | undefined {
	try { return readJson(path); } catch { return undefined; }
}

async function main(): Promise<void> {
	const config = loadLiveConfig("p0-07-workflow-deadline");
	const startedAt = Date.now();
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const branch = git(["branch", "--show-current"]);
	const changedFiles = git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
	const evidence: any = {
		updatedAt: new Date().toISOString(), branch, sourceCommit, changedFiles,
		profile: config.profileName, configPath: config.configPath,
		provider: config.providerId, model: config.mainModel, plannerModel: config.plannerModel,
		thinking: config.thinking, builtExtension: process.env.AGENTFLUX_LIVE_BUILT === "1",
		reportPath, workflow: {}, deadline: {}, passed: false,
	};
	let workflowPi: PiHandle | undefined;
	let propagationPi: PiHandle | undefined;
	let parentTimeoutPi: PiHandle | undefined;
	let deadlinePi: PiHandle | undefined;
	try {
		if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("built Workflow/deadline live test requires AGENTFLUX_LIVE_BUILT=1");
		if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js")) || !existsSync(join(sourceRoot, "dist", "extension", "subagent-entry.js"))) {
			throw new Error("production dist entries are missing; run npm run build first");
		}
		mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
		setupFixture(workflowRoot, config, {
			max_cost_per_task: 1,
			max_iterations: 4,
			// The real planner may need several bounded turns to inspect its runtime
			// contract before returning the intentionally minimal one-node DAG. Keep
			// this finite, but leave room for the node and quality-gate child runs.
			max_turns_per_task: 32,
			max_input_tokens_per_task: 100_000,
			max_parallel_agents: 2,
			max_wall_clock_seconds: null,
		}, { qualityGate: true });
		const workflowPrompt = [
			"Use an AgentFlux Workflow for this repeatable task; do not perform the work directly in Main.",
			"Create and execute a brand-new minimal Workflow. The generated DAG must contain exactly one implementer node and no planner, reviewer, or tester nodes. The node description must instruct the implementer to use the read tool on the first line of README.md and then respond with exactly BUILT_WORKFLOW_NODE_OK. Its acceptanceCriteria must be exactly one output-check criterion requiring the node output to contain BUILT_WORKFLOW_NODE_OK; do not put DAG-structure requirements into the node acceptance criteria. Do not reuse an existing Workflow.",
			"Wait for the Workflow and quality gate result; output BUILT_WORKFLOW_MAIN_OK only after DAG Execution is PASSED.",
		].join("\n");
		const workflowSnapshots: any[] = [];
		workflowPi = launch(workflowRoot, join(workflowRoot, "dist", "extension", "entry.js"), "read,grep,find,ls,flux_task,flux_workflow", config.mainModel, config, workflowPrompt, 600_000);
		const workflowResult = await waitForPi(workflowRoot, workflowPi, workflowSnapshots, 600_000);
		const workflowRuns = readRuns(workflowRoot);
		const workflowStore = readJson(join(workflowRoot, ".agentflux", "runtime", "workflows.json")) ?? { definitions: [] };
		const taskStore = readJson(join(workflowRoot, ".agentflux", "runtime", "tasks.json")) ?? { tasks: [], executions: [] };
		const workflowDefinition = (workflowStore.definitions ?? []).slice(-1)[0];
		const workflowTask = latestRun(taskStore.tasks ?? [], task => task.resource?.type === "workflow");
		const execution = workflowTask ? (taskStore.executions ?? []).find((item: any) => item.id === workflowTask.executionId) : undefined;
		const executionId = workflowTask?.executionId;
		const dag = executionId ? safeRead(join(workflowRoot, ".agentflux", "runtime", "runs", executionId, "dag.json")) : undefined;
		const checkpoint = executionId ? safeRead(join(workflowRoot, ".agentflux", "runtime", "runs", executionId, "checkpoint.json")) : undefined;
		const plannerRun = latestRun(workflowRuns, run => run.agent === "dag-planner" && (run.role === "planner" || run.role === "dag-planner"));
		const nodeRuns = workflowRuns.filter(run => run.agent?.startsWith("dag-") && run.agent !== "dag-planner");
		const terminalNodeRuns = nodeRuns.filter(run => !ACTIVE.has(run.status));
		const gateResults = (checkpoint?.taskResults ?? []).map((entry: any) => entry?.[1]?.gateResult).filter(Boolean);
		const qualityGate = gateResults.find((gate: any) => gate.status === "passed" && gate.passed === true && Array.isArray(gate.criteriaResults) && gate.criteriaResults.length > 0);
		const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
		const implementerNodes = nodes.filter((node: any) => node.role === "implementer");
		const nodeSpec = implementerNodes[0];
		const nodeSpecContainsMarker = typeof nodeSpec?.description === "string" && nodeSpec.description.includes("BUILT_WORKFLOW_NODE_OK")
			&& Array.isArray(nodeSpec.acceptanceCriteria) && nodeSpec.acceptanceCriteria.some((criterion: any) => typeof criterion === "string" && criterion.includes("BUILT_WORKFLOW_NODE_OK"));
		const nodesWithCompletedRuns = nodes.filter((node: any) => nodeRuns.some(run => run.agent === `dag-${node.id}` && run.status === "completed" && (run.turns ?? 0) > 0));
		const workflowMarker = workflowResult.stdout.includes("BUILT_WORKFLOW_MAIN_OK") || workflowResult.stderr.includes("BUILT_WORKFLOW_MAIN_OK");
		const workflowPassedMarker = workflowResult.stdout.includes("[DAG Execution: PASSED]") || workflowResult.stderr.includes("[DAG Execution: PASSED]");
		const plannerCompleted = plannerRun?.status === "completed" && (plannerRun.turns ?? 0) > 0 && plannerRun.phase === "terminal";
		const workflowFactsConsistent = workflowTask?.status === "completed" && execution?.status === "completed"
			&& execution.taskId === workflowTask.id && workflowTask.resource?.type === "workflow"
			&& workflowDefinition && nodes.length === 1 && implementerNodes.length === 1 && nodeSpecContainsMarker
			&& terminalNodeRuns.length === nodeRuns.length && nodesWithCompletedRuns.length === nodes.length;
		evidence.workflow = {
			main: { pid: workflowResult.pid, exitCode: workflowResult.exitCode, timedOut: workflowResult.timedOut },
			marker: workflowMarker,
			passedMarker: workflowPassedMarker,
			plannerCompleted,
			plannerRun,
			nodeCount: nodes.length,
			implementerNodeCount: implementerNodes.length,
			nodeSpecContainsMarker,
			nodeSpec: nodeSpec ? { id: nodeSpec.id, role: nodeSpec.role, description: nodeSpec.description, acceptanceCriteria: nodeSpec.acceptanceCriteria } : undefined,
			nodeRuns,
			nodesWithCompletedRuns: nodesWithCompletedRuns.map((node: any) => node.id),
			workflowDefinition: workflowDefinition ? { id: workflowDefinition.id, name: workflowDefinition.name, version: workflowDefinition.version } : undefined,
			task: workflowTask,
			execution,
			checkpoint: checkpoint ? { executionId, status: checkpoint.status, completed: checkpoint.completed, failed: checkpoint.failed } : undefined,
			qualityGate,
			qualityGateCount: gateResults.length,
			snapshotCount: workflowSnapshots.length,
			snapshots: workflowSnapshots,
			stdoutTail: workflowResult.stdout.slice(-6000),
			stderrTail: workflowResult.stderr.slice(-5000),
			factsConsistent: Boolean(workflowFactsConsistent),
		};

		setupFixture(propagationRoot, config, {
			max_cost_per_task: 1,
			max_iterations: 4,
			max_turns_per_task: 32,
			max_input_tokens_per_task: 100_000,
			max_parallel_agents: 1,
			max_wall_clock_seconds: 240,
		}, { qualityGate: true });
		const propagationPrompt = [
			"Use AgentFlux Workflow and do not perform the work directly in Main.",
			"Create and execute a brand-new minimal Workflow. Override any generic planner guidance about creating 2-5 nodes: the generated DAG MUST contain exactly one node total, an implementer node, and no planner, reviewer, tester, or validation/waiting nodes. The quality gate is executed by AgentFlux after the node; do not model it as a DAG node.",
			"The only node must read the first line of README.md and respond with exactly PARENT_DEADLINE_PROPAGATION_NODE_OK. Its acceptanceCriteria must contain exactly one output-check criterion requiring that marker. Do not put DAG-structure or quality-gate requirements into the node acceptance criteria.",
			"Wait for the real quality gate and DAG result. After the Workflow returns, output PARENT_DEADLINE_PROPAGATION_MAIN_OK only if its result is terminal (passed or timed_out); do not claim success from an unfinished run.",
		].join("\n");
		writeFileSync(join(propagationRoot, "README.md"), "# Parent deadline propagation fixture\\n");
		const propagationSnapshots: any[] = [];
		propagationPi = launch(propagationRoot, join(propagationRoot, "dist", "extension", "entry.js"), "read,grep,find,ls,flux_task,flux_workflow", config.mainModel, config, propagationPrompt, 600_000);
		const propagationResult = await waitForPi(propagationRoot, propagationPi, propagationSnapshots, 600_000);
		const propagationRuns = readRuns(propagationRoot);
		const propagationStore = readJson(join(propagationRoot, ".agentflux", "runtime", "tasks.json")) ?? { tasks: [], executions: [] };
		const propagationTask = latestRun(propagationStore.tasks ?? [], task => task.resource?.type === "workflow");
		const propagationExecution = propagationTask ? (propagationStore.executions ?? []).find((item: any) => item.id === propagationTask.executionId) : undefined;
		const propagationDag = propagationTask?.executionId
			? safeRead(join(propagationRoot, ".agentflux", "runtime", "runs", propagationTask.executionId, "dag.json"))
			: undefined;
		const propagationNodes = Array.isArray(propagationDag?.nodes) ? propagationDag.nodes : [];
		const propagationSingleNode = propagationNodes.length === 1 && propagationNodes[0]?.role === "implementer"
			&& Array.isArray(propagationNodes[0]?.acceptanceCriteria) && propagationNodes[0].acceptanceCriteria.length === 1;
		const propagationParentDeadline = propagationTask?.deadlineAt ? Date.parse(propagationTask.deadlineAt) : NaN;
		const propagationPhaseRuns = propagationRuns.filter(run => run.taskId === propagationTask?.id);
		const propagationPlanner = propagationPhaseRuns.find(run => run.agent === "dag-planner");
		const propagationNodeRuns = propagationPhaseRuns.filter(run => run.agent?.startsWith("dag-") && run.agent !== "dag-planner");
		const propagationCheckpoint = propagationTask?.executionId
			? safeRead(join(propagationRoot, ".agentflux", "runtime", "runs", propagationTask.executionId, "checkpoint.json"))
			: undefined;
		const propagationGate = (propagationCheckpoint?.taskResults ?? [])
			.map((entry: any) => entry?.[1]?.gateResult)
			.find((gate: any) => gate && Array.isArray(gate.criteriaResults));
		const propagationGatePassed = propagationGate?.status === "passed"
			&& propagationGate.passed === true
			&& Array.isArray(propagationGate.criteriaResults)
			&& propagationGate.criteriaResults.length > 0;
		const propagationNodeIds = new Set(propagationNodeRuns.map(run => run.agent));
		const propagationNodeCompleted = propagationNodeIds.size === 1
			&& propagationNodeRuns.some(run => run.status === "completed" && (run.turns ?? 0) > 0)
			&& propagationNodeRuns.every(run => !ACTIVE.has(run.status));
		const propagationDeadlinesMatch = Number.isFinite(propagationParentDeadline)
			&& propagationSingleNode
			&& propagationNodeCompleted
			&& propagationPhaseRuns.length > 0
			&& propagationPhaseRuns.every(run => Date.parse(String(run.deadlineAt ?? "")) === propagationParentDeadline)
			&& propagationGatePassed
			&& propagationGate.deadlineAt === propagationParentDeadline;
		const propagationMarker = propagationResult.stdout.includes("PARENT_DEADLINE_PROPAGATION_MAIN_OK") || propagationResult.stderr.includes("PARENT_DEADLINE_PROPAGATION_MAIN_OK");
		const propagationTerminal = propagationTask && propagationExecution
			&& ["completed", "failed", "cancelled", "timed_out"].includes(propagationTask.status)
			&& propagationExecution.status === propagationTask.status;
		const propagationNoFalseCompletion = !(propagationTask?.status === "completed" && Number.isFinite(propagationParentDeadline)
			&& Date.parse(propagationTask.updatedAt) > propagationParentDeadline);
		evidence.parentDeadlinePropagation = {
			main: { pid: propagationResult.pid, exitCode: propagationResult.exitCode, timedOut: propagationResult.timedOut },
			marker: propagationMarker,
			parentDeadlineAt: propagationTask?.deadlineAt,
			planner: propagationPlanner,
			nodeRuns: propagationNodeRuns,
			qualityGate: propagationGate,
			dag: propagationDag ? { description: propagationDag.description, nodes: propagationNodes } : undefined,
			singleImplementerNode: propagationSingleNode,
			nodeCompleted: propagationNodeCompleted,
			checkpoint: propagationCheckpoint ? { status: propagationCheckpoint.status, completed: propagationCheckpoint.completed, failed: propagationCheckpoint.failed } : undefined,
			task: propagationTask,
			execution: propagationExecution,
			deadlinesMatch: Boolean(propagationDeadlinesMatch),
			terminal: Boolean(propagationTerminal),
			noFalseCompletion: propagationNoFalseCompletion,
			snapshotCount: propagationSnapshots.length,
			snapshots: propagationSnapshots,
			factsConsistent: Boolean(propagationDeadlinesMatch && propagationTerminal && propagationNoFalseCompletion),
			stdoutTail: propagationResult.stdout.slice(-5000),
			stderrTail: propagationResult.stderr.slice(-4000),
		};

		setupFixture(parentTimeoutRoot, config, {
			max_cost_per_task: 1,
			max_iterations: 3,
			// Leave the real planner enough bounded turns to start the child; the
			// 90-second parent deadline still expires before the 120-second command.
			max_turns_per_task: 32,
			max_input_tokens_per_task: 100_000,
			max_parallel_agents: 1,
			max_wall_clock_seconds: 90,
		}, { bash: true });
		const parentTimeoutPrompt = [
			"Use AgentFlux Workflow and do not perform the work directly in Main.",
			"Create and execute a brand-new minimal Workflow. Override generic planner guidance: the generated DAG MUST contain exactly one implementer node and no planner, reviewer, tester, or waiting nodes.",
			"The only implementer node must call bash with node -e \"setTimeout(() => {}, 120000)\" and must not finish before the command ends. Its acceptanceCriteria may contain one output marker, but the inherited parent deadline is expected to interrupt the node before quality-gate completion.",
			"Wait for the Workflow result. Output PARENT_DEADLINE_TIMEOUT_MAIN_OK only after the result is terminal and its status is TIMED_OUT; never claim success for an unfinished or failed result.",
		].join("\n");
		const parentTimeoutSnapshots: any[] = [];
		parentTimeoutPi = launch(parentTimeoutRoot, join(parentTimeoutRoot, "dist", "extension", "entry.js"), "read,grep,find,ls,bash,flux_task,flux_workflow", config.mainModel, config, parentTimeoutPrompt, 240_000);
		const parentTimeoutResult = await waitForPi(parentTimeoutRoot, parentTimeoutPi, parentTimeoutSnapshots, 240_000);
		const parentTimeoutRuns = readRuns(parentTimeoutRoot);
		const parentTimeoutStore = readJson(join(parentTimeoutRoot, ".agentflux", "runtime", "tasks.json")) ?? { tasks: [], executions: [] };
		const parentTimeoutTask = latestRun(parentTimeoutStore.tasks ?? [], task => task.resource?.type === "workflow");
		const parentTimeoutExecution = parentTimeoutTask ? (parentTimeoutStore.executions ?? []).find((item: any) => item.id === parentTimeoutTask.executionId) : undefined;
		const parentTimeoutDag = parentTimeoutTask?.executionId
			? safeRead(join(parentTimeoutRoot, ".agentflux", "runtime", "runs", parentTimeoutTask.executionId, "dag.json"))
			: undefined;
		const parentTimeoutNodes = Array.isArray(parentTimeoutDag?.nodes) ? parentTimeoutDag.nodes : [];
		const parentTimeoutNodeRuns = parentTimeoutRuns.filter(run => run.taskId === parentTimeoutTask?.id && run.agent?.startsWith("dag-") && run.agent !== "dag-planner");
		const parentTimeoutNode = parentTimeoutNodeRuns.find(run => run.status === "timed_out") ?? parentTimeoutNodeRuns[0];
		const parentTimeoutCheckpoint = parentTimeoutTask?.executionId
			? safeRead(join(parentTimeoutRoot, ".agentflux", "runtime", "runs", parentTimeoutTask.executionId, "checkpoint.json"))
			: undefined;
		const parentTimeoutMarker = `${parentTimeoutResult.stdout}\n${parentTimeoutResult.stderr}`.includes("PARENT_DEADLINE_TIMEOUT_MAIN_OK");
		const parentTimeoutDagTimedOut = parentTimeoutCheckpoint?.status === "timed_out"
			|| parentTimeoutTask?.executionId && safeRead(join(parentTimeoutRoot, ".agentflux", "runtime", "runs", parentTimeoutTask.executionId, "dag-state.json"))?.status === "timed_out";
		const parentTimeoutFactsConsistent = parentTimeoutResult.exitCode === 0
			&& !parentTimeoutResult.timedOut
			&& parentTimeoutMarker
			&& parentTimeoutNodes.length === 1
			&& parentTimeoutNodes[0]?.role === "implementer"
			&& parentTimeoutNode?.status === "timed_out"
			&& parentTimeoutDagTimedOut
			&& parentTimeoutTask?.status === "timed_out"
			&& parentTimeoutExecution?.status === "timed_out"
			&& parentTimeoutExecution?.outcome?.status === "timeout"
			&& parentTimeoutTask?.status === parentTimeoutExecution?.status;
		evidence.parentDeadlineTimeout = {
			main: { pid: parentTimeoutResult.pid, exitCode: parentTimeoutResult.exitCode, timedOut: parentTimeoutResult.timedOut },
			marker: parentTimeoutMarker,
			dag: parentTimeoutDag ? { description: parentTimeoutDag.description, nodes: parentTimeoutNodes } : undefined,
			nodeRuns: parentTimeoutNodeRuns,
			timedOutNode: parentTimeoutNode,
			checkpoint: parentTimeoutCheckpoint ? { status: parentTimeoutCheckpoint.status, completed: parentTimeoutCheckpoint.completed, failed: parentTimeoutCheckpoint.failed } : undefined,
			task: parentTimeoutTask,
			execution: parentTimeoutExecution,
			dagTimedOut: Boolean(parentTimeoutDagTimedOut),
			snapshotCount: parentTimeoutSnapshots.length,
			snapshots: parentTimeoutSnapshots,
			factsConsistent: Boolean(parentTimeoutFactsConsistent),
			stdoutTail: parentTimeoutResult.stdout.slice(-5000),
			stderrTail: parentTimeoutResult.stderr.slice(-4000),
		};

		setupFixture(deadlineRoot, config, {
			max_cost_per_task: 1,
			max_iterations: 2,
			max_wall_clock_seconds: 45,
			max_parallel_agents: 1,
		}, { bash: true });
		const deadlinePrompt = [
			"必须严格调用 AgentFlux 工具，不要自行完成子任务。",
			"调用 flux_agent action=create，name=explicit-deadline-live，role=implementer，scope=project。",
			"然后调用 flux_agent action=run，agent=explicit-deadline-live，background=false；任务必须调用 bash 执行 node -e \"setTimeout(() => {}, 60000)\"，并把 bash 工具 timeout 明确设置为 60 秒，不要在命令结束前回复。",
			"该调用预期因显式 deadline 超时；返回后只输出 BUILT_DEADLINE_MAIN_OK，不要把子 Agent 失败说成成功。",
		].join("\n");
		const deadlineSnapshots: any[] = [];
		deadlinePi = launch(deadlineRoot, join(deadlineRoot, "dist", "extension", "entry.js"), "read,grep,find,ls,bash,flux_task,flux_agent", config.mainModel, config, deadlinePrompt, 180_000);
		const deadlineResult = await waitForPi(deadlineRoot, deadlinePi, deadlineSnapshots, 180_000);
		const deadlineRuns = readRuns(deadlineRoot);
		const deadlineRun = latestRun(deadlineRuns, run => run.agent === "explicit-deadline-live");
		const deadlineMarker = deadlineResult.stdout.includes("BUILT_DEADLINE_MAIN_OK") || deadlineResult.stderr.includes("BUILT_DEADLINE_MAIN_OK");
		const deadlineActive = deadlineSnapshots.flat().find((run: any) => run.agent === "explicit-deadline-live" && ACTIVE.has(run.status) && run.deadlineAt);
		const deadlineTimeoutEvent = Array.isArray(deadlineRun?.recentEvents)
			&& deadlineRun.recentEvents.some((event: any) => event.type === "timeout" && String(event.summary ?? "").toLowerCase().includes("timeout"));
		const deadlineFactsConsistent = deadlineRun?.status === "timed_out" && deadlineRun.phase === "terminal"
			&& typeof deadlineRun.deadlineAt === "string" && Number.isFinite(Date.parse(deadlineRun.deadlineAt))
			&& deadlineRun.finishedAt && deadlineTimeoutEvent && deadlineRun.error?.toLowerCase().includes("explicit deadline")
			&& Boolean(deadlineActive);
		evidence.deadline = {
			main: { pid: deadlineResult.pid, exitCode: deadlineResult.exitCode, timedOut: deadlineResult.timedOut },
			marker: deadlineMarker,
			activeSnapshot: deadlineActive,
			timeoutEvent: deadlineTimeoutEvent,
			run: deadlineRun,
			snapshotCount: deadlineSnapshots.length,
			snapshots: deadlineSnapshots,
			factsConsistent: Boolean(deadlineFactsConsistent),
			stdoutTail: deadlineResult.stdout.slice(-5000),
			stderrTail: deadlineResult.stderr.slice(-4000),
		};
		evidence.builtEntryMtimeMs = statSync(join(sourceRoot, "dist", "extension", "entry.js")).mtimeMs;
		evidence.wallClockMs = Date.now() - startedAt;
		evidence.passed = workflowResult.exitCode === 0 && !workflowResult.timedOut
			&& workflowMarker && workflowPassedMarker && plannerCompleted && qualityGate && workflowFactsConsistent
			&& propagationResult.exitCode === 0 && !propagationResult.timedOut
			&& propagationMarker && evidence.parentDeadlinePropagation.factsConsistent
			&& evidence.parentDeadlineTimeout.factsConsistent
			&& deadlineResult.exitCode === 0 && !deadlineResult.timedOut && deadlineMarker && deadlineFactsConsistent;
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		if (!evidence.passed) throw new Error(`built Workflow/planner/quality-gate/deadline live evidence failed; report=${reportPath}`);
		console.log(JSON.stringify({ ...evidence, reportPath }, null, 2));
	} catch (error: any) {
		evidence.error = String(error?.message ?? error);
		evidence.wallClockMs = Date.now() - startedAt;
		try { writeFileSync(reportPath, JSON.stringify(evidence, null, 2)); } catch {}
		throw error;
	} finally {
		if (workflowPi) killTree(workflowPi.child.pid);
		if (propagationPi) killTree(propagationPi.child.pid);
		if (parentTimeoutPi) killTree(parentTimeoutPi.child.pid);
		if (deadlinePi) killTree(deadlinePi.child.pid);
		try { rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
		catch (error) { console.warn(`Workflow/deadline fixture cleanup deferred: ${String(error)}`); }
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
