import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLiveConfig } from "./live-config";

/**
 * P0-07 真实双 Pi 控制面链路：Pi A 先启动一个无 deadline Run，
 * Pi B 从 Core 读取 inspect 并通过 Message V2 steer；测试等待 delivery ACK
 * 以及目标 Run 的 STEER_SEEN 语义响应后，再由 Pi B 对第二个 Run 写定向 stop request。
 * 必须显式使用本轮 production dist：AGENTFLUX_LIVE_BUILT=1。
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `p0-07-controls-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "p0-07-controls-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const ACTIVE = new Set(["starting", "running", "stop_requested"]);

interface PiResult {
	label: string;
	pid?: number;
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

interface PiHandle {
	child: ChildProcess;
	result: Promise<PiResult>;
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return undefined; }
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function stopTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	} else {
		try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
	}
}

function launch(label: string, extensionEntry: string, prompt: string, config: ReturnType<typeof loadLiveConfig>, timeoutMs: number): PiHandle {
	const args = [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "read,grep,find,ls,flux_agent", ...config.cliArgs(config.modelFlash), prompt,
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
			resolveResult({ label, pid: child.pid, exitCode: 124, stdout, stderr, timedOut: true });
		}, timeoutMs);
		child.on("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ label, pid: child.pid, exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false });
		});
		child.on("close", code => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({ label, pid: child.pid, exitCode: code ?? 1, stdout, stderr, timedOut: false });
		});
	});
	return { child, result };
}

function listControlDeliveries(): any[] {
	const root = join(fixtureRoot, ".agentflux", "shared", "messages-v2", "deliveries", "control-live");
	if (!existsSync(root)) return [];
	return readdirSync(root).filter(file => file.endsWith(".json")).map(file => readJson(join(root, file))).filter(Boolean);
}

function deliveriesForRun(runId: string | undefined): any[] {
	if (!runId) return [];
	return listControlDeliveries().filter(item => {
		const envelope = item?.messageId
			? readJson(join(fixtureRoot, ".agentflux", "shared", "messages-v2", "envelopes", `${item.messageId}.json`))
			: undefined;
		return envelope?.correlationId === runId;
	});
}

function runContainsText(run: any | undefined, text: string): boolean {
	return Boolean(run?.recentEvents?.some((event: any) => String(event.summary ?? "").includes(text)));
}

async function main(): Promise<void> {
	const config = loadLiveConfig();
	const startedAt = Date.now();
	let mainPi: PiHandle | undefined;
	let steerOperatorPi: PiHandle | undefined;
	let stopOperatorPi: PiHandle | undefined;
	mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
	if (process.env.AGENTFLUX_LIVE_BUILT !== "1") throw new Error("P0-07 controls live test requires AGENTFLUX_LIVE_BUILT=1");
	if (!existsSync(join(sourceRoot, "dist", "extension", "entry.js"))) throw new Error("production dist entry is missing; run npm run build first");
	try {
		cpSync(join(sourceRoot, "dist", "extension"), join(fixtureRoot, "dist", "extension"), { recursive: true });
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux P0-07 control fixture\n");
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: {
				max_cost_per_task: 0.30,
				max_iterations: 3,
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
		const liveModels: any = config.fluxModelsJson();
		// The live config intentionally keeps most roles read-only; this control
		// fixture needs a real long-running shell tool in the implementer Run.
		liveModels.roles.implementer.tools = ["read", "grep", "find", "ls", "bash"];
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(liveModels, null, 2));
		const extensionEntry = join(fixtureRoot, "dist", "extension", "entry.js");
		mainPi = launch("main", extensionEntry, [
			"只能按顺序调用 AgentFlux flux_agent 工具，不要调用其他工具。",
			"1) action=create，name=control-live，role=implementer，scope=project。",
			"2) action=run，agent=control-live，background=false，task=必须调用 bash 执行 node -e \"setTimeout(() => {}, 15000)\"；在收到 operator 的 steer 指令前不要结束，收到后只回复 STEER_SEEN。",
			"3) 上一次 run 返回后，立即 action=run，agent=control-live，background=false，task=必须调用 bash 执行 node -e \"setTimeout(() => {}, 60000)\"，在命令结束前不要回复；命令结束后只回复 CONTROL_CHILD_DONE。",
			"主 Agent 不要自行完成子任务；第二次 run 返回后输出 CONTROL_MAIN_DONE。",
		].join("\n"), config, 300_000);

		let activeRun: any;
		const waitDeadline = Date.now() + 90_000;
		while (Date.now() < waitDeadline) {
			const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"));
			activeRun = (runs?.runs ?? []).find((run: any) => run.agent === "control-live" && ACTIVE.has(run.status) && run.pid && run.phase !== "starting");
			if (activeRun) break;
			const mainDone = await Promise.race([mainPi.result.then(() => true), sleep(500).then(() => false)]);
			if (mainDone) break;
		}
		if (!activeRun) {
			const observed = (readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [])
				.filter((item: any) => item.agent === "control-live")
				.map((item: any) => ({ id: item.id, status: item.status, phase: item.phase, pid: item.pid, turns: item.turns, activity: item.lastActivityType, summary: item.lastActivitySummary, events: item.recentEvents?.slice(-8) }));
			throw new Error(`real Pi did not expose an active control-live Run before the steer window; observed=${JSON.stringify(observed)}`);
		}
		const steerRunId = activeRun.id;

		steerOperatorPi = launch("steer-operator", extensionEntry, [
			"必须严格按顺序实际调用 AgentFlux flux_agent 工具，不要调用其他工具。",
			"1) action=inspect，agent=control-live，last=3。",
			"2) action=steer，agent=control-live，task=收到 operator steer；请只回复 STEER_SEEN，然后结束当前 Run。",
			"两次调用后只输出 P0_07_STEER_SENT。",
		].join("\n"), config, 120_000);
		const steerOperatorResult = await steerOperatorPi.result;

		let steerRun: any;
		let steerDeliveries: any[] = [];
		let steerConsumed = false;
		const steerDeadline = Date.now() + 90_000;
		while (Date.now() < steerDeadline) {
			const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"));
			steerRun = (runs?.runs ?? []).find((item: any) => item.id === steerRunId);
			steerDeliveries = deliveriesForRun(steerRunId);
			steerConsumed = steerDeliveries.some(item => item.status === "acknowledged") && runContainsText(steerRun, "STEER_SEEN");
			if (steerConsumed || (steerRun && !ACTIVE.has(steerRun.status))) break;
			await sleep(250);
		}
		if (!steerConsumed) {
			const observed = (readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [])
				.filter((item: any) => item.agent === "control-live")
				.map((item: any) => ({ id: item.id, status: item.status, phase: item.phase, turns: item.turns, activity: item.lastActivityType, summary: item.lastActivitySummary, events: item.recentEvents?.slice(-4) }));
			throw new Error(`real Pi steer was not consumed; run=${steerRunId} observed=${JSON.stringify(observed)} report=${reportPath}`);
		}

		let stopRun: any;
		const stopWaitDeadline = Date.now() + 180_000;
		while (Date.now() < stopWaitDeadline) {
			const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"));
			stopRun = (runs?.runs ?? []).find((item: any) => item.agent === "control-live" && item.id !== steerRunId && ACTIVE.has(item.status) && item.pid && item.phase !== "starting");
			if (stopRun) break;
			const mainDone = await Promise.race([mainPi.result.then(() => true), sleep(500).then(() => false)]);
			if (mainDone) break;
		}
		if (!stopRun) {
			const observed = (readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"))?.runs ?? [])
				.filter((item: any) => item.agent === "control-live")
				.map((item: any) => ({ id: item.id, status: item.status, phase: item.phase, turns: item.turns, activity: item.lastActivityType, summary: item.lastActivitySummary, events: item.recentEvents?.slice(-6) }));
			throw new Error(`real Pi did not expose the second active control-live Run before the stop window; observed=${JSON.stringify(observed)}`);
		}

		stopOperatorPi = launch("stop-operator", extensionEntry, [
			"必须严格按顺序实际调用 AgentFlux flux_agent 工具，不要调用其他工具。",
			"1) action=inspect，agent=control-live，last=3。",
			"2) action=stop，agent=control-live。",
			"3) action=inspect，agent=control-live，last=3。",
			"三次调用后只输出 P0_07_CONTROLS_OK。",
		].join("\n"), config, 120_000);
		const stopOperatorResult = await stopOperatorPi.result;
		const mainResult = await mainPi.result;
		await sleep(1_000);

		const runs = readJson(join(fixtureRoot, ".agentflux", "runtime", "runs.json"));
		steerRun = (runs?.runs ?? []).find((item: any) => item.id === steerRunId);
		stopRun = (runs?.runs ?? []).find((item: any) => item.id === stopRun.id);
		const agents = readJson(join(fixtureRoot, ".agentflux", "runtime", "agents.json"));
		const agent = (agents?.agents ?? []).find((item: any) => item.name === "control-live");
		steerDeliveries = deliveriesForRun(steerRunId);
		const terminal = stopRun && !ACTIVE.has(stopRun.status);
		const stopObserved = stopRun?.recentEvents?.some((event: any) => event.type === "stop_requested") ?? false;
		const noDeadline = steerRun?.deadlineAt === undefined && stopRun?.deadlineAt === undefined;
		const steerAcked = steerDeliveries.some(item => item.status === "acknowledged");
		const stopMarker = stopOperatorResult.stdout.includes("P0_07_CONTROLS_OK") || stopOperatorResult.stderr.includes("P0_07_CONTROLS_OK");
		const steerMarker = steerOperatorResult.stdout.includes("P0_07_STEER_SENT") || steerOperatorResult.stderr.includes("P0_07_STEER_SENT");
		const passed = steerOperatorResult.exitCode === 0 && stopOperatorResult.exitCode === 0 && mainResult.exitCode === 0
			&& steerMarker && stopMarker && steerConsumed && steerAcked && steerRun?.status === "completed"
			&& Boolean(terminal) && stopRun?.status === "cancelled" && stopObserved && noDeadline;
		const evidence = {
			updatedAt: new Date().toISOString(),
			provider: config.providerId,
			model: config.modelFlash,
			thinking: config.thinking,
			builtExtension: true,
			main: { pid: mainResult.pid, exitCode: mainResult.exitCode, timedOut: mainResult.timedOut },
			steerOperator: { pid: steerOperatorResult.pid, exitCode: steerOperatorResult.exitCode, timedOut: steerOperatorResult.timedOut },
			stopOperator: { pid: stopOperatorResult.pid, exitCode: stopOperatorResult.exitCode, timedOut: stopOperatorResult.timedOut },
			wallClockMs: Date.now() - startedAt,
			steerMarker,
			stopMarker,
			steerConsumed,
			steerAcked,
			passed,
			activeRunBeforeControl: activeRun,
			steerRun: steerRun ? {
				id: steerRun.id,
				status: steerRun.status,
				phase: steerRun.phase,
				health: steerRun.health,
				deadlineAt: steerRun.deadlineAt,
				turns: steerRun.turns,
				input: steerRun.input,
				costUsd: steerRun.costUsd,
				recentEvents: steerRun.recentEvents,
			} : undefined,
			stopRun: stopRun ? {
				id: stopRun.id,
				status: stopRun.status,
				phase: stopRun.phase,
				health: stopRun.health,
				deadlineAt: stopRun.deadlineAt,
				turns: stopRun.turns,
				input: stopRun.input,
				costUsd: stopRun.costUsd,
				recentEvents: stopRun.recentEvents,
			} : undefined,
			agent: agent ? { name: agent.name, status: agent.status, callCount: agent.callCount, lastResult: agent.lastResult } : undefined,
			steerDeliveries,
			stdoutTail: { main: mainResult.stdout.slice(-5000), steerOperator: steerOperatorResult.stdout.slice(-4000), stopOperator: stopOperatorResult.stdout.slice(-4000) },
			stderrTail: { main: mainResult.stderr.slice(-3000), steerOperator: steerOperatorResult.stderr.slice(-2000), stopOperator: stopOperatorResult.stderr.slice(-2000) },
		};
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		if (!passed) {
			throw new Error(`P0-07 controls live evidence failed; report=${reportPath}`);
		}
		console.log(JSON.stringify(evidence, null, 2));
	} finally {
		if (mainPi) stopTree(mainPi.child);
		if (steerOperatorPi) stopTree(steerOperatorPi.child);
		if (stopOperatorPi) stopTree(stopOperatorPi.child);
		try { rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (error) { console.warn(`control fixture cleanup deferred: ${String(error)}`); }
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
