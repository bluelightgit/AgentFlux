import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";
import { isProcessAlive } from "../../src/core/fs-lock";
import { observeProcessAsync, type ProcessIdentity } from "../../src/core/process-identity";

/**
 * 真实 Pi/Provider 多角色链路：Main 创建一个绑定 planner+reviewer 的 Agent，
 * 再按两个不同 role 顺序运行，最后核对注册表与 Run Registry 的事实。
 * provider、角色模型和 thinking 由 live-test-config.json 与环境变量决定。
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `multirole-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "multirole-latest.json");
const piCli = getPiCliPath();

async function main(): Promise<void> {
	const config = loadLiveConfig("multirole");
	const startedAt = Date.now();
	mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
	mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
	const useBuiltExtension = process.env.AGENTFLUX_LIVE_BUILT === "1";
	const backgroundTools = process.env.AGENTFLUX_LIVE_BACKGROUND_TOOLS === "1";
	const verifyBirth = process.env.AGENTFLUX_LIVE_PROCESS_IDENTITY === "1";
	if (verifyBirth && !useBuiltExtension) throw new Error("Process birth validation requires production dist");
	if (backgroundTools && !useBuiltExtension) throw new Error("Background tool validation requires production dist");
	if (useBuiltExtension) cpSync(join(sourceRoot, "dist", "extension"), join(fixtureRoot, "dist", "extension"), { recursive: true });
	else cpSync(join(sourceRoot, "src"), join(fixtureRoot, "src"), { recursive: true });
	writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux multirole fixture\n");
	writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
		subagent_runtime: config.subagentRuntime,
		// 验证默认无模型执行 deadline；外层测试 watchdog 仅限制本次夹具。
		budget: { max_cost_per_task: 0.15, max_iterations: 3, max_wall_clock_seconds: null, max_turns_per_task: 12, max_input_tokens_per_task: 100_000 },
		pricing: { enable_remote_fetch: false },
	}, null, 2));
	writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(config.fluxModelsJson(), null, 2));
	const prompt = [
		"Call flux_agent exactly three times in order. Do not call flux_workflow, flux_issue, or other collaboration tools.",
		'1) {"action":"create","name":"multirole-live","roles":["planner","reviewer"],"scope":"project"}',
		JSON.stringify({ action: "run", agent: "multirole-live", role: "planner", background: false, task: `${backgroundTools ? 'Use find with pattern README.md and path ., then grep with pattern AgentFlux and path README.md. Both tools must succeed. Do not use any other tool. ' : ''}Only reply PLAN_LIVE_OK.` }),
		JSON.stringify({ action: "run", agent: "multirole-live", role: "reviewer", background: false, task: `${backgroundTools ? 'Use find with pattern README.md and path ., then grep with pattern AgentFlux and path README.md. Both tools must succeed. Do not use any other tool. ' : ''}Only reply REVIEW_LIVE_OK.` }),
		"After all three calls succeed, only output MULTIROLE_LIVE_OK.",
	].join("\n");
	const extensionEntry = useBuiltExtension
		? join(fixtureRoot, "dist", "extension", "host-entry.ts")
		: join(fixtureRoot, "src", "entry.ts");
	const args = [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "read,grep,find,ls,flux_task,flux_agent", ...config.cliArgs(config.mainModel), prompt,
	];
	let stdout = "";
	let stderr = "";
	let piPid: number | undefined;
	const uniqueReportPath = join(sourceRoot, ".agentflux", "test-results", `multirole-${startedAt}-${process.pid}.json`);
	const evidence: any = { startedAt, fixtureRoot, uniqueReportPath, passed: false };
	const birthChecks: Array<{ runId: string; expected: ProcessIdentity; observed: unknown; passed: boolean }> = [];
	let birthTimer: ReturnType<typeof setInterval> | undefined;
	let birthSampling: Promise<void> | undefined;
	let mainBirth: Awaited<ReturnType<typeof observeProcessAsync>> | undefined;
	try {
		const child = spawn(process.execPath, args, { cwd: fixtureRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: config.env });
		piPid = child.pid;
		child.stdout.on("data", value => { stdout += value.toString(); });
		child.stderr.on("data", value => { stderr += value.toString(); });
		const mainBirthPromise = verifyBirth && child.pid ? observeProcessAsync(child.pid).then(value => { mainBirth = value; }) : Promise.resolve();
		if (verifyBirth) birthTimer = setInterval(() => {
			if (birthSampling) return;
			birthSampling = (async () => {
				const path = join(fixtureRoot, ".agentflux", "runtime", "runs.json");
				if (!existsSync(path)) return;
				const candidates = JSON.parse(readFileSync(path, "utf8")).runs.filter((run: any) => {
					const expected = run.backend === "sdk" ? run.sdkOwner?.host : run.processIdentity;
					return run.agent === "multirole-live" && expected && !birthChecks.some(check => check.runId === run.id && check.expected.pid === expected.pid && check.expected.birth === expected.birth && check.passed);
				});
				for (const run of candidates) {
					const expected = run.backend === "sdk" ? run.sdkOwner.host : run.processIdentity;
					const observed = await observeProcessAsync(expected.pid);
					birthChecks.push({ runId: run.id, expected, observed, passed: observed.state === "alive" && observed.identity.pid === expected.pid && observed.identity.birth === expected.birth && observed.identity.platform === expected.platform });
				}
			})().catch(error => { evidence.birthSamplingError = String(error); }).finally(() => { birthSampling = undefined; });
		}, 250);
		const exitCode = await new Promise<number>((resolveExit, reject) => {
			const timer = setTimeout(() => {
				if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
				else child.kill("SIGKILL");
				reject(new Error("multi-role live test timeout"));
			}, 240_000);
			child.on("error", reject);
			child.on("close", code => { clearTimeout(timer); resolveExit(code ?? 1); });
		});
		if (birthTimer) clearInterval(birthTimer);
		await mainBirthPromise;
		await birthSampling;
		const agentsPath = join(fixtureRoot, ".agentflux", "runtime", "agents.json");
		const runsPath = join(fixtureRoot, ".agentflux", "runtime", "runs.json");
		const tasksPath = join(fixtureRoot, ".agentflux", "runtime", "tasks.json");
		const agents = existsSync(agentsPath) ? JSON.parse(readFileSync(agentsPath, "utf-8")) : undefined;
		const runs = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, "utf-8")) : undefined;
		const tasks = existsSync(tasksPath) ? JSON.parse(readFileSync(tasksPath, "utf-8")) : undefined;
		const agent = agents?.agents?.find((item: any) => item.name === "multirole-live");
		const roleRuns = runs?.runs?.filter((item: any) => item.agent === "multirole-live") ?? [];
		const taskItems = Array.isArray(tasks?.tasks) ? tasks.tasks : [];
		const task = taskItems.slice().sort((a: any, b: any) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
		const execution = tasks?.executions?.find((item: any) => item.id === task?.executionId);
		const noExecutionDeadline = !!task && !!execution && task.deadlineAt === undefined && execution.deadlineAt === undefined
			&& execution.budget?.maxWallClockMs === undefined && roleRuns.length === 2 && roleRuns.every((run: any) => run.deadlineAt === undefined);
		const backgroundToolEvidence: any[] = [];
		if (backgroundTools) {
			const sessionDir = join(fixtureRoot, ".agentflux/runtime/sessions");
			for (const file of readdirSync(sessionDir).filter(file => file.endsWith(".jsonl"))) {
				const entries = readFileSync(join(sessionDir, file), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
				const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
				const calls = messages.flatMap(message => message.role === "assistant" ? (message.content ?? []).filter((part: any) => part.type === "toolCall") : []);
				const results = messages.filter(message => message.role === "toolResult");
				backgroundToolEvidence.push({ file, tools: calls.map((call: any) => call.name), passed: ["find", "grep"].every(name => calls.some((call: any) => call.name === name && results.some(result => result.toolCallId === call.id && !result.isError))) });
			}
			if (backgroundToolEvidence.filter(item => item.passed).length !== 2) throw new Error("Both role sessions must successfully use native find and grep tools");
		}
		const backendVerified = roleRuns.length === 2 && roleRuns.every((run: any) => (run.backend ?? "process") === config.subagentRuntime
			&& (config.subagentRuntime !== "sdk" || (run.pid === undefined && run.processIdentity === undefined && run.sdkOwner?.host.pid === piPid && !!run.sdkSessionId)));
		const birthVerified = !verifyBirth || (mainBirth?.state === "alive" && mainBirth.identity.pid === execution?.ownerPid
			&& mainBirth.identity.birth === execution?.ownerIdentity?.birth
			&& roleRuns.length === 2 && roleRuns.every((run: any) => {
				const expected = run.backend === "sdk" ? run.sdkOwner?.host : run.processIdentity;
				return birthChecks.some(check => check.runId === run.id && check.expected.pid === expected?.pid && check.expected.birth === expected?.birth && check.passed);
			}));
		Object.assign(evidence, {
			backend: config.subagentRuntime, backendVerified,
			verifyBirth, birthVerified, mainBirth, ownerIdentity: execution?.ownerIdentity, birthChecks,
			backgroundTools, backgroundToolEvidence,
			updatedAt: new Date().toISOString(),
			provider: config.providerId,
			model: config.mainModel,
			thinking: config.thinking,
			builtExtension: useBuiltExtension,
			noExecutionDeadline,
			executionBudget: execution?.budget,
			testWatchdogMs: 240_000,
			exitCode,
			piPid,
			wallClockMs: Date.now() - startedAt,
			marker: hasAssistantFinalMarker(stdout, stderr, "MULTIROLE_LIVE_OK"),
			toolStarts: toolExecutionStarts(stdout, "flux_agent"),
			task: task ? { id: task.id, executionId: task.executionId, status: task.status, operation: task.operation } : undefined,
			agent: agent ? { name: agent.name, roles: agent.roles, callCount: agent.callCount, lastRole: agent.lastRole, status: agent.status } : undefined,
			roleRuns: roleRuns.map((item: any) => ({ runId: item.id, taskId: item.taskId, executionId: item.executionId, role: item.role, model: item.model, status: item.status, costUsd: item.costUsd,
				backend: item.backend ?? "process", sdkOwner: item.sdkOwner, sdkSessionId: item.sdkSessionId, processIdentity: item.processIdentity, invocation: item.invocation, costAccounting: item.costAccounting })),
			stdoutTail: stdout.slice(-4000),
			stderrTail: stderr.slice(-4000),
		});
		if (exitCode !== 0 || !evidence.marker || agent?.callCount !== 2 || agent?.lastRole !== "reviewer"
			|| agent?.status !== "idle" || roleRuns.length !== 2 || new Set(roleRuns.map((item: any) => item.role)).size !== 2
			|| roleRuns.some((run: any) => run.status !== "completed") || task?.status !== "completed" || !noExecutionDeadline
			|| !backendVerified || !birthVerified || evidence.birthSamplingError
			|| evidence.toolStarts.filter((event: any) => event.args?.action === "run").length !== 2) {
			throw new Error(`multi-role live evidence failed; report=${reportPath}`);
		}
		evidence.passed = true;
		console.log(JSON.stringify(evidence, null, 2));
	} catch (error) {
		evidence.error = String(error);
		throw error;
	} finally {
		if (birthTimer) clearInterval(birthTimer);
		await birthSampling;
		Object.assign(evidence, { verifyBirth, mainBirth, birthChecks });
		writeFileSync(join(fixtureRoot, "pi.stdout.jsonl"), stdout);
		writeFileSync(join(fixtureRoot, "pi.stderr.log"), stderr);
		evidence.processExit = { pid: piPid, alive: piPid ? isProcessAlive(piPid) : false };
		if (evidence.processExit.alive) { evidence.passed = false; process.exitCode = 1; }
		evidence.workspaceRetainedForAudit = true;
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		writeFileSync(uniqueReportPath, JSON.stringify(evidence, null, 2));
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
