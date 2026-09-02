import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLiveConfig } from "./live-config";

/**
 * Built-extension Task lineage validation. It performs real continue and retry
 * tool calls in separate Pi processes sharing the same durable project state,
 * then checks immutable Task/Execution parent links and terminal outcomes.
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-task-lineage-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-task-lineage-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

function git(args: string[]): string {
	try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trimEnd(); }
	catch { return ""; }
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function runPi(config: ReturnType<typeof loadLiveConfig>, extensionEntry: string, sessionId: string, prompt: string, tools: string): ReturnType<typeof spawnSync> {
	return spawnSync(process.execPath, [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", tools, "--session-dir", join(fixtureRoot, "sessions"), "--session-id", sessionId,
		...config.cliArgs(config.mainModel), prompt,
	], { cwd: fixtureRoot, encoding: "utf8", windowsHide: true, timeout: 150_000, env: config.env });
}

function tail(result: ReturnType<typeof spawnSync> | undefined, limit = 5000): { stdout: string; stderr: string } | undefined {
	if (!result) return undefined;
	return { stdout: String(result.stdout ?? "").slice(-limit), stderr: String(result.stderr ?? "").slice(-limit) };
}

async function main(): Promise<void> {
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("Task lineage live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	const config = loadLiveConfig("p0-07-task-lineage");
	const startedAt = Date.now();
	let firstContinue: ReturnType<typeof spawnSync> | undefined;
	let secondContinue: ReturnType<typeof spawnSync> | undefined;
	let retrySeed: ReturnType<typeof spawnSync> | undefined;
	let retryRun: ReturnType<typeof spawnSync> | undefined;
	mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
	try {
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		mkdirSync(join(fixtureRoot, "sessions"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux task-lineage fixture\n");
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: { max_cost_per_task: 0.30, max_iterations: 3, max_wall_clock_seconds: 90 },
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(config.fluxModelsJson(), null, 2));
		const extensionDir = join(fixtureRoot, "dist", "extension");
		mkdirSync(extensionDir, { recursive: true });
		cpSync(join(sourceRoot, "dist", "extension"), extensionDir, { recursive: true });
		const extensionEntry = join(extensionDir, "entry.js");

		firstContinue = runPi(config, extensionEntry, "continue-live", "只回答精确文本 CONTINUE_SEED_OK，不要调用任何工具。", "flux_task");
		secondContinue = runPi(config, extensionEntry, "continue-live", "必须先实际调用 AgentFlux flux_task，参数 action=continue；工具成功后只输出 CONTINUE_OK，不要调用其他工具。", "flux_task");

		// A deliberately unregistered, configuration-derived model id makes the
		// first Main task fail through the real AgentFlux create path; the next Pi
		// must use flux_task retry without binding the fixture to a vendor model.
		const invalidModel = `${config.workerModel}-unregistered-for-lineage-test`;
		retrySeed = runPi(config, extensionEntry, "retry-live", [
			`必须实际调用一次 AgentFlux flux_agent 工具：action=create，name=retry-live，role=implementer，model=${invalidModel}。`,
			"该模型没有注册，工具应失败；不要改用其他工具。工具报错后只输出 RETRY_SEED_FAILED。",
		].join("\n"), "flux_agent");
		retryRun = runPi(config, extensionEntry, "retry-live", "必须先实际调用 AgentFlux flux_task，参数 action=retry；工具成功后只输出 RETRY_OK，不要调用其他工具。", "flux_task");

		const tasksStore = readJson(join(fixtureRoot, ".agentflux", "runtime", "tasks.json"));
		const tasks = tasksStore?.tasks ?? [];
		const executions = tasksStore?.executions ?? [];
		const continueSeed = tasks.find((task: any) => task.task.includes("CONTINUE_SEED_OK"));
		const continued = tasks.find((task: any) => task.operation === "continue" && task.parentTaskId === continueSeed?.id);
		const failedRetrySeed = tasks.find((task: any) => task.task.includes("unregistered-for-lineage-test"));
		const retried = tasks.find((task: any) => task.operation === "retry" && task.parentTaskId === failedRetrySeed?.id);
		const continueMarker = `${secondContinue?.stdout ?? ""}\n${secondContinue?.stderr ?? ""}`.includes("CONTINUE_OK");
		const retryMarker = `${retryRun?.stdout ?? ""}\n${retryRun?.stderr ?? ""}`.includes("RETRY_OK");
		const continueValid = firstContinue?.status === 0 && secondContinue?.status === 0 && continueMarker
			&& continueSeed?.status === "completed" && continued?.status === "completed"
			&& continued.parentExecutionId === continueSeed.executionId;
		const retryValid = failedRetrySeed && ["failed", "cancelled", "timed_out"].includes(failedRetrySeed.status)
			&& retried?.status === "completed" && retried.parentExecutionId === failedRetrySeed.executionId && retryMarker;
		const passed = continueValid && retryValid;
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
			continue: { seed: tail(firstContinue), continuation: tail(secondContinue), marker: continueMarker, valid: continueValid },
			retry: { seed: tail(retrySeed), retry: tail(retryRun), marker: retryMarker, valid: retryValid },
			tasks,
			executions,
			passed,
		};
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		console.log(JSON.stringify(evidence, null, 2));
		if (!passed) throw new Error(`Task lineage live evidence failed; report=${reportPath}`);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
