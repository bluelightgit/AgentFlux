import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkflowDefinition } from "../../src/workflows/workflow-registry";
import { getPiCliPath, loadLiveConfig } from "./live-config";

/**
 * P0-05 production-dist 真实链路：在全新 Pi 中运行真实 Provider Agent，
 * 监督进程在 child 尚未结束时轮询 Core Run Registry，核对 usage/cost、
 * heartbeat、阶段、最近活动、provider/model 以及最终单调收敛。
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `run-telemetry-${Date.now()}-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", `run-telemetry-${Date.now()}-${process.pid}.json`);
const latestReportPath = join(sourceRoot, ".agentflux", "test-results", "run-telemetry-latest.json");
const piCli = getPiCliPath();
const ACTIVE = new Set(["starting", "running", "stop_requested"]);

interface RunFact {
	id: string;
	taskId?: string;
	executionId?: string;
	status: string;
	phase?: string;
	pid?: number;
	backend?: "process" | "sdk";
	sdkSessionId?: string;
	sdkOwner?: { host: { pid: number; birth: string }; generation: string };
	attempt?: number;
	turns?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	contextTokens?: number;
	costUsd?: number;
	model?: string;
	provider?: string;
	lastActivityAt?: string;
	lastActivityType?: string;
	lastActivitySummary?: string;
	heartbeatAt?: string;
	updatedAt?: string;
	finishedAt?: string;
	error?: string;
	modelError?: string;
	providerError?: string;
}

function readRun(): RunFact | undefined {
	const path = join(fixtureRoot, ".agentflux", "runtime", "runs.json");
	if (!existsSync(path)) return undefined;
	try {
		const store = JSON.parse(readFileSync(path, "utf8"));
		return store?.runs?.find((run: any) => run.agent === "telemetry-live");
	} catch {
		// Atomic replacement can briefly race a Windows reader; retry on next poll.
		return undefined;
	}
}

function killTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
	else {
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
}

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trimEnd(); }
	catch { return ""; }
}

async function main(): Promise<void> {
	const config = loadLiveConfig("run-telemetry");
	const startedAt = Date.now();
	const useBuiltExtension = process.env.AGENTFLUX_LIVE_BUILT === "1";
	const sourceCommit = git(["rev-parse", "HEAD"]);
	const branch = git(["branch", "--show-current"]);
	const changedFiles = git(["status", "--porcelain", "--untracked-files=all"])
		.split("\n").filter(Boolean).map(line => line.length > 3 ? line.slice(3) : line);
	let stdout = "";
	let stderr = "";
	let piPid: number | undefined;
	const snapshots: RunFact[] = [];
	try {
		mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		if (useBuiltExtension) cpSync(join(sourceRoot, "dist", "extension"), join(fixtureRoot, "dist", "extension"), { recursive: true });
		else cpSync(join(sourceRoot, "src"), join(fixtureRoot, "src"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux P0-05 live telemetry fixture\n");
		const models = config.fluxModelsJson() as any;
		const unavailableModel = "agentflux-live-model-not-found";
		models.models[config.workerModel] = {
			...models.models[config.workerModel],
			capability: { coding: 0.8, reasoning: 0.8, speed: 0.9, context: 0.8, cost_eff: 0.9 },
			pricing: {
				input: 0.00000009,
				output: 0.00000018,
				cacheRead: 0.00000002,
				cacheWrite: 0.00000009,
			},
		};
		models.models[unavailableModel] = {
			provider: config.providerId,
			contextWindow: 1_000_000,
			capability: { coding: 1, reasoning: 1, speed: 1, context: 1, cost_eff: 1 },
		};
		models.roles.implementer.tools = ["read", "grep", "find", "ls", "bash"];
		models.roles["failure-recovery"] = { model: unavailableModel, provider: config.providerId, thinking: "off", tools: [] };
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			subagent_runtime: config.subagentRuntime,
			budget: { max_cost_per_task: 0.15, max_iterations: 3, max_wall_clock_seconds: 180 },
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(models, null, 2));
		createWorkflowDefinition(join(fixtureRoot, ".agentflux"), {
			name: "p0-05-provider-recovery",
			dag: {
				description: "Reject an unavailable explicit model before spawning; never silently downgrade",
				nodes: [{
					id: "recover", title: "Recover model", role: "failure-recovery", dependsOn: [],
					parallelizable: false, acceptanceCriteria: [], files: [],
					description: "Only reply RUN_RECOVERY_AGENT_OK.",
				}],
			},
		});
		const prompt = [
			"必须严格按顺序实际调用 AgentFlux 工具，不要调用 issue 或 message。",
			"1) flux_agent action=create，name=telemetry-live，roles=[implementer]，scope=project。",
			"2) flux_agent action=run，agent=telemetry-live，role=implementer，background=false。task 必须原样使用：先调用 bash 工具执行 node -e \"setTimeout(()=>process.exit(0),3000)\"；工具结束后再次调用 bash 执行同一命令；第二次工具结束后只回复 RUN_TELEMETRY_AGENT_OK。",
			"3) Agent 成功后调用 flux_workflow，action=reuse，workflow=p0-05-provider-recovery。该固定 Workflow 的显式模型故意不存在，必须被拒绝。这是预期负例，不重试，不诊断，不改模型，不把 Workflow 失败说成成功。",
			"只有前两步成功且第三步准确拒绝后，只输出 RUN_TELEMETRY_EXPECTED_REJECTION_OK。",
		].join("\n");
		const extensionEntry = useBuiltExtension
			? join(fixtureRoot, "dist", "extension", "host-entry.ts")
			: join(fixtureRoot, "src", "entry.ts");
		const args = [
			piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
			"--no-skills", "--tools", "read,grep,find,ls,flux_task,flux_agent,flux_workflow",
			...config.cliArgs(config.mainModel), prompt,
		];
		// 隔离用户资源 discovery，真实凭据/typed runtime 仍来自显式 agentDir。
		// 显式不可用模型必须在运行前拒绝，不能靠能力排序更换通道。
		const childEnv: NodeJS.ProcessEnv = {
			...config.env,
			HOME: fixtureRoot,
			USERPROFILE: fixtureRoot,
			PI_CODING_AGENT_DIR: config.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
		};
		const child = spawn(process.execPath, args, {
			cwd: fixtureRoot,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnv,
		});
		piPid = child.pid;
		child.stdout.on("data", value => { stdout += value.toString(); });
		child.stderr.on("data", value => { stderr += value.toString(); });
		let closed = false;
		let timedOut = false;
		const exitPromise = new Promise<number>((resolveExit, reject) => {
			child.on("error", reject);
			child.on("close", code => { closed = true; resolveExit(code ?? 1); });
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			killTree(child.pid);
		}, 240_000);
		let lastSignature = "";
		while (!closed) {
			const run = readRun();
			if (run) {
				const signature = [run.updatedAt, run.heartbeatAt, run.status, run.phase, run.turns, run.input, run.output, run.costUsd].join("|");
				if (signature !== lastSignature) {
					lastSignature = signature;
					snapshots.push(structuredClone(run));
				}
			}
			await new Promise(resolveWait => setTimeout(resolveWait, 50));
		}
		clearTimeout(timeout);
		const exitCode = await exitPromise;
		const terminal = readRun();
		if (terminal) snapshots.push(structuredClone(terminal));
		let recoveryRun: RunFact | undefined;
		try {
			const store = JSON.parse(readFileSync(join(fixtureRoot, ".agentflux", "runtime", "runs.json"), "utf8"));
			recoveryRun = store?.runs?.find((run: any) => run.role === "failure-recovery");
		} catch {}
		const activeSnapshots = snapshots.filter(snapshot => ACTIVE.has(snapshot.status));
		const onlineNonzero = activeSnapshots.find(snapshot =>
			(snapshot.turns ?? 0) > 0
			&& (snapshot.input ?? 0) + (snapshot.output ?? 0) > 0
			&& (snapshot.costUsd ?? 0) > 0
			&& (config.subagentRuntime === "sdk" ? snapshot.backend === "sdk" && snapshot.pid === undefined && snapshot.sdkOwner?.host.pid === piPid && !!snapshot.sdkSessionId : !!snapshot.pid)
			&& !!snapshot.lastActivityAt
			&& !!snapshot.heartbeatAt,
		);
		const heartbeatValues = new Set(activeSnapshots.map(snapshot => snapshot.heartbeatAt).filter(Boolean));
		const maximum = (field: keyof RunFact): number => Math.max(0, ...activeSnapshots.map(snapshot => Number(snapshot[field] ?? 0)));
		const monotonic = activeSnapshots.every((snapshot, index) => index === 0 || [
			"turns", "input", "output", "cacheRead", "cacheWrite", "contextTokens", "costUsd",
		].every(field => Number(snapshot[field as keyof RunFact] ?? 0) >= Number(activeSnapshots[index - 1][field as keyof RunFact] ?? 0)));
		const evidence = {
			updatedAt: new Date().toISOString(),
			branch,
			sourceCommit,
			changedFiles,
			profile: config.profileName,
			configPath: config.configPath,
			provider: config.providerId,
			model: config.workerModel,
			thinking: config.thinking,
			backend: config.subagentRuntime,
			builtExtension: useBuiltExtension,
			extensionEntry,
			subagentEntry: useBuiltExtension ? join(fixtureRoot, "dist", "extension", "subagent-entry.js") : join(fixtureRoot, "src", "subagent-entry.ts"),
			exitCode,
			piPid,
			timedOut,
			wallClockMs: Date.now() - startedAt,
			marker: stdout.includes("RUN_TELEMETRY_EXPECTED_REJECTION_OK"),
			sawActiveRun: activeSnapshots.length > 0,
			sawToolPhase: activeSnapshots.some(snapshot => snapshot.phase === "tool" || snapshot.lastActivityType === "tool_start"),
			sawOnlineNonzero: !!onlineNonzero,
			heartbeatUpdates: heartbeatValues.size,
			monotonic,
			onlineNonzero,
			terminal,
			recoveryRun,
			snapshotCount: snapshots.length,
			snapshots,
			stdoutTail: stdout.slice(-5000),
			stderrTail: stderr.slice(-5000),
		};
		const terminalConsistent = !!terminal
			&& terminal.status === "completed"
			&& terminal.phase === "terminal"
			&& !!terminal.finishedAt
			&& terminal.pid === undefined
			&& (terminal.backend ?? "process") === config.subagentRuntime
			&& (config.subagentRuntime !== "sdk" || (terminal.sdkOwner?.host.pid === piPid && !!terminal.sdkSessionId))
			&& (terminal.turns ?? 0) >= maximum("turns")
			&& (terminal.input ?? 0) >= maximum("input")
			&& (terminal.output ?? 0) >= maximum("output")
			&& (terminal.cacheRead ?? 0) >= maximum("cacheRead")
			&& (terminal.cacheWrite ?? 0) >= maximum("cacheWrite")
			&& (terminal.contextTokens ?? 0) >= maximum("contextTokens")
			&& (terminal.costUsd ?? 0) >= maximum("costUsd")
			&& (terminal.costUsd ?? 0) > 0
			&& terminal.model === config.workerModel
			&& terminal.provider === config.providerId;
		const taskStore = JSON.parse(readFileSync(join(fixtureRoot, ".agentflux/runtime/tasks.json"), "utf8"));
		const expectedRejection = taskStore.executions.some((execution: any) => execution.status === "failed"
			&& execution.invocationOutcomes?.some((outcome: any) => outcome.status === "failure"));
		const recoveryConsistent = recoveryRun === undefined && expectedRejection
			&& !JSON.parse(readFileSync(join(fixtureRoot, ".agentflux/runtime/runs.json"), "utf8")).runs.some((run: any) => run.model === unavailableModel);
		const passed = !(timedOut || exitCode !== 0 || !useBuiltExtension || !evidence.marker || !evidence.sawActiveRun
			|| !evidence.sawToolPhase || !evidence.sawOnlineNonzero || heartbeatValues.size < 2
			|| !monotonic || !terminalConsistent || !recoveryConsistent || !terminal?.taskId || !terminal.executionId);
		const report = { ...evidence, terminalConsistent, recoveryConsistent, passed };
		writeFileSync(reportPath, JSON.stringify(report, null, 2));
		writeFileSync(latestReportPath, JSON.stringify(report, null, 2));
		if (!passed) throw new Error(`P0-05 live telemetry evidence failed; report=${reportPath}`);
		console.log(JSON.stringify({ ...report, reportPath }, null, 2));
	} finally {
		// 成功/失败都保留原始进程流和工作区，不用删除负证据制造通过。
		writeFileSync(join(fixtureRoot, "pi.stdout.jsonl"), stdout);
		writeFileSync(join(fixtureRoot, "pi.stderr.log"), stderr);
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
