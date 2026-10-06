import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";
import {
	assertMessageRedeliveryContract,
	collectSessionEvidence,
	countSessionToolCalls,
	findMessageV2Snapshot,
	listCheckpointArtifacts,
	matchesObservedRunForSignal,
	readRuns,
	type DeliveryObservation,
	type MessageV2Snapshot,
} from "../helpers/message-redelivery-evidence";
import { isProcessAlive } from "../../src/core/fs-lock";
import { checkProcessIdentity, isProcessIdentity } from "../../src/core/process-identity";
const stopBirthChecks: any[] = [];

/**
 * Production-dist Message V2 redelivery fixture.
 *
 * The two scenarios use an uncorrelated direct handoff from a real sender Run
 * to one logical recipient Agent. The first recipient Run is deliberately
 * failed, or deliberately loses its ACK while a fixture-owned lock holder is
 * alive. A fresh Run for the same logical recipient then consumes the retained
 * delivery and ACKs it. No store is repaired by this fixture: all delivery and
 * Run facts are read after the real production entry has persisted them.
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const iteration = `${Date.now()}-${process.pid}`;
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `message-redelivery-${iteration}`);
const resultsRoot = join(sourceRoot, ".agentflux", "test-results");
const reportPath = join(resultsRoot, `message-redelivery-${iteration}.json`);
const latestReportPath = join(resultsRoot, "message-redelivery-latest.json");
const piCli = getPiCliPath();
const phaseWatchdogMs = 240_000;
const infrastructureWatchdogMs = 900_000;
const redeliveryAfterMs = 1_000;
const ACTIVE_RUNS = new Set(["starting", "running", "stop_requested"]);

interface ProcessResult {
	label: string;
	pid?: number;
	exitCode: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	watchdogExpired: boolean;
	stdoutPath: string;
	stderrPath: string;
}

interface OwnedProcess {
	label: string;
	child: ChildProcess;
	result: Promise<ProcessResult>;
	stop(): void;
	row: any;
}

interface PhaseSpec {
	label: string;
	prompt: string;
	marker: string;
	calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function json(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch { return undefined; }
}

function hash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stopChildTree(child: ChildProcess): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		return;
	}
	try { process.kill(-child.pid, "SIGKILL"); }
	catch { try { child.kill("SIGKILL"); } catch {} }
}

/** Fixture-only hard kill: fresh birth and repeated Core ownership checks, never a bare PID. */
function stopObservedRun(pid: number | undefined, observedRunPids: Map<number, string>): boolean {
	if (!pid || !observedRunPids.has(pid) || pid === process.pid || !isProcessAlive(pid)) return false;
	const recorded = readRuns(join(fixtureRoot, ".agentflux")).find(run => run?.pid === pid && run.id === observedRunPids.get(pid));
	if (!recorded || !ACTIVE_RUNS.has(recorded.status)) return false;
	const birthState = isProcessIdentity(recorded.processIdentity) ? checkProcessIdentity(pid, recorded.processIdentity) : "unknown";
	const latest = readRuns(join(fixtureRoot, ".agentflux")).find(run => run.id === recorded.id);
	const matched = matchesObservedRunForSignal(recorded, latest, observedRunPids.get(pid)!, pid, birthState);
	const check: any = { at: new Date().toISOString(), pid, runId: recorded.id, expected: recorded.processIdentity, birthState, matched, signalIssued: false };
	stopBirthChecks.push(check);
	if (!matched) return false;
	if (process.platform === "win32") {
		const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 7000 });
		check.exitCode = result.status; check.error = result.error?.message;
		return check.signalIssued = result.status === 0 && !result.error;
	}
	try { process.kill(-pid, "SIGKILL"); check.signalIssued = true; }
	catch { try { process.kill(pid, "SIGKILL"); check.signalIssued = true; } catch (error) { check.error = String(error); } }
	return check.signalIssued;
}

function envelopesForContent(content: string): any[] {
	const envelopeDir = join(fixtureRoot, ".agentflux", "shared", "messages-v2", "envelopes");
	if (!existsSync(envelopeDir)) return [];
	return readdirSync(envelopeDir).filter(name => name.endsWith(".json"))
		.map(name => json(join(envelopeDir, name)))
		.filter(envelope => envelope?.content === content);
}

function readDeliveryForContent(content: string, recipient: string): MessageV2Snapshot | undefined {
	return findMessageV2Snapshot(join(fixtureRoot, ".agentflux"), recipient, content);
}

function observeDelivery(content: string, recipient: string, observations: DeliveryObservation[]): MessageV2Snapshot | undefined {
	const snapshot = readDeliveryForContent(content, recipient);
	const delivery = snapshot?.delivery;
	if (!delivery) return snapshot;
	const next: DeliveryObservation = {
		at: new Date().toISOString(),
		status: delivery.status,
		attempts: delivery.attempts,
		deliveredAt: delivery.deliveredAt,
		acknowledgedAt: delivery.acknowledgedAt,
	};
	const previous = observations.at(-1);
	if (!previous || previous.status !== next.status || previous.attempts !== next.attempts
		|| previous.acknowledgedAt !== next.acknowledgedAt || previous.deliveredAt !== next.deliveredAt) observations.push(next);
	return snapshot;
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(`fixture coordination timed out: ${label}`);
		await sleep(100);
	}
}

function activeRun(agent: string): any | undefined {
	return readRuns(join(fixtureRoot, ".agentflux")).find(run => run?.agent === agent && ACTIVE_RUNS.has(run.status) && typeof run.pid === "number");
}

function runsFor(agent: string): any[] {
	return readRuns(join(fixtureRoot, ".agentflux")).filter(run => run?.agent === agent);
}

function writeFaultHarnesses(): void {
	writeFileSync(join(fixtureRoot, "crash-window.cjs"), [
		"const fs = require('node:fs');",
		"const path = require('node:path');",
		"fs.writeFileSync(path.join(__dirname, 'crash-window-ready'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));",
		"setInterval(() => {}, 1000);",
	].join("\n"));
	writeFileSync(join(fixtureRoot, "ack-window.cjs"), [
		"const fs = require('node:fs');",
		"const path = require('node:path');",
		"const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));",
		"(async () => {",
		"  const ready = path.join(__dirname, 'ack-window-ready');",
		"  const acquired = path.join(__dirname, 'ack-lock-acquired');",
		"  const armed = path.join(__dirname, 'ack-window-armed');",
		"  fs.writeFileSync(ready, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));",
		"  const deadline = Date.now() + 30000;",
		"  while (!fs.existsSync(acquired) && Date.now() < deadline) await sleep(25);",
		"  if (!fs.existsSync(acquired)) { fs.writeFileSync(path.join(__dirname, 'ack-window-error'), 'lock holder did not acquire the fixture lock'); process.exitCode = 7; return; }",
		"  fs.writeFileSync(armed, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));",
		"  await sleep(250);",
		"  console.log('ACK_WINDOW_DONE');",
		"})().catch(error => { fs.writeFileSync(path.join(__dirname, 'ack-window-error'), String(error)); process.exitCode = 8; });",
	].join("\n"));
	writeFileSync(join(fixtureRoot, "ack-lock-holder.cjs"), [
		"const fs = require('node:fs');",
		"const path = require('node:path');",
		"const lockPath = path.join(__dirname, '.agentflux', 'shared', 'messages-v2', '.mutex.lock');",
		"const acquiredPath = path.join(__dirname, 'ack-lock-acquired');",
		"const releasePath = path.join(__dirname, 'ack-release');",
		"const errorPath = path.join(__dirname, 'ack-lock-error');",
		"try {",
		"  fs.mkdirSync(path.dirname(lockPath), { recursive: true });",
		"  const fd = fs.openSync(lockPath, 'wx');",
		"  fs.writeFileSync(fd, `${process.pid}:fixture-ack-loss`);",
		"  fs.closeSync(fd);",
		"  fs.writeFileSync(acquiredPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), lockPath }));",
		"} catch (error) { fs.writeFileSync(errorPath, String(error)); process.exitCode = 9; return; }",
		"const timer = setInterval(() => {",
		"  if (!fs.existsSync(releasePath)) return;",
		"  try { fs.unlinkSync(lockPath); } catch {}",
		"  clearInterval(timer);",
		"  process.exit(0);",
		"}, 25);",
	].join("\n"));
}

function launchOwnedProcess(
	label: string,
	args: string[],
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
): OwnedProcess {
	const stdoutPath = join(fixtureRoot, `${label}.stdout.jsonl`);
	const stderrPath = join(fixtureRoot, `${label}.stderr.log`);
	writeFileSync(stdoutPath, "");
	writeFileSync(stderrPath, "");
	const child = spawn(process.execPath, args, {
		cwd: fixtureRoot,
		env,
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const row: any = {
		label, pid: child.pid, watchdogMs: timeoutMs, watchdogExpired: false,
		stdoutPath, stderrPath, infrastructureOwned: true,
	};
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", chunk => {
		const text = chunk.toString();
		stdout += text;
		appendFileSync(stdoutPath, text);
	});
	child.stderr?.on("data", chunk => {
		const text = chunk.toString();
		stderr += text;
		appendFileSync(stderrPath, text);
	});
	let timer: NodeJS.Timeout | undefined;
	const result = new Promise<ProcessResult>(resolveResult => {
		let settled = false;
		const finish = (exitCode: number, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			row.exitCode = exitCode;
			row.signal = signal;
			resolveResult({ label, pid: child.pid, exitCode, signal, stdout, stderr, watchdogExpired: row.watchdogExpired, stdoutPath, stderrPath });
		};
		child.once("error", error => {
			stderr += `\n${String(error?.message ?? error)}`;
			appendFileSync(stderrPath, `\n${String(error?.message ?? error)}`);
			finish(1, null);
		});
		child.once("close", (code, signal) => finish(code ?? 1, signal));
		timer = setTimeout(() => {
			row.watchdogExpired = true;
			stopChildTree(child);
		}, timeoutMs);
	});
	const owned: OwnedProcess = { label, child, result, row, stop: () => stopChildTree(child) };
	return owned;
}

function launchPiPhase(config: ReturnType<typeof loadLiveConfig>, report: any, spec: PhaseSpec): OwnedProcess {
	const extensionEntry = join(fixtureRoot, "dist", "extension", "host-entry.ts");
	const phase: any = {
		label: spec.label,
		marker: spec.marker,
		prompt: spec.prompt,
		calls: spec.calls,
		watchdogMs: phaseWatchdogMs,
		freshMain: true,
		noProductDeadline: true,
		passed: false,
	};
	report.phases.push(phase);
	const owned = launchOwnedProcess(spec.label, [
		piCli,
		"--mode", "json", "-p", "--approve", "--no-extensions", "-e", extensionEntry,
		"--no-skills", "--tools", "flux_agent",
		"--no-session", "--session-id", `${spec.label}-${iteration}`,
		...config.cliArgs(config.mainModel),
		spec.prompt,
	], phaseWatchdogMs, config.env);
	phase.pid = owned.child.pid;
	phase.stdoutPath = join(fixtureRoot, `${spec.label}.stdout.jsonl`);
	phase.stderrPath = join(fixtureRoot, `${spec.label}.stderr.log`);
	return owned;
}

async function finishPiPhase(owned: OwnedProcess, report: any, spec: PhaseSpec): Promise<ProcessResult> {
	const result = await owned.result;
	const phase = report.phases.find((item: any) => item.label === spec.label);
	Object.assign(phase, {
		exitCode: result.exitCode,
		signal: result.signal,
		watchdogExpired: result.watchdogExpired,
		output: {
			finalMarker: hasAssistantFinalMarker(result.stdout, result.stderr, spec.marker),
			stdoutBytes: Buffer.byteLength(result.stdout),
			stderrBytes: Buffer.byteLength(result.stderr),
		},
	});
	assert.equal(result.exitCode, 0, `${spec.label} Main exited unsuccessfully`);
	assert.equal(result.watchdogExpired, false, `${spec.label} infrastructure watchdog expired`);
	assert.ok(hasAssistantFinalMarker(result.stdout, result.stderr, spec.marker), `${spec.label} final marker mismatch`);
	const calls = toolExecutionStarts(result.stdout, "flux_agent");
	assert.equal(calls.length, spec.calls.length, `${spec.label} issued an unexpected number of AgentFlux tool calls`);
	const ordered = spec.calls.map(expected => {
		const index = calls.findIndex(candidate => {
			if (candidate.toolName !== expected.tool) return false;
			try { assert.deepEqual(candidate.args, expected.args); return true; }
			catch { return false; }
		});
		assert.ok(index >= 0, `${spec.label} did not issue the exact ${expected.tool} call ${JSON.stringify(expected.args)}`);
		return index;
	});
	assert.equal(new Set(ordered).size, spec.calls.length, `${spec.label} duplicated an AgentFlux tool call`);
	assert.ok(ordered.every((index, position) => position === 0 || index > ordered[position - 1]), `${spec.label} AgentFlux tool calls were out of order`);
	phase.toolCalls = calls.map(call => ({ toolName: call.toolName, args: call.args, toolCallId: call.toolCallId }));
	phase.passed = true;
	return result;
}

function waitForRedeliveryWindow(snapshot: MessageV2Snapshot): Promise<void> {
	const deliveredAt = Date.parse(snapshot.delivery.deliveredAt ?? "");
	if (!Number.isFinite(deliveredAt)) throw new Error("cannot wait for redelivery without deliveredAt");
	return waitFor(() => Date.now() >= deliveredAt + redeliveryAfterMs + 150, redeliveryAfterMs + 5_000, "Message V2 redelivery lease");
}

function crashPrompt(sender: string, recipient: string, payload: string): PhaseSpec {
	const createSender = { action: "create", name: sender, role: "implementer", scope: "project" };
	const createRecipient = { action: "create", name: recipient, role: "implementer", scope: "project" };
	const senderTask = `Use flux_agent_message exactly once with this exact JSON: ${JSON.stringify({ action: "send", target: recipient, content: payload, priority: "normal" })}. Do not use another tool, do not poll or acknowledge, and after the send succeeds reply exactly SENDER_CRASH_READY.`;
	const runSender = { action: "run", agent: sender, background: false, task: senderTask };
	const recipientTask = "Run exactly one bash command: node crash-window.cjs. Do not use another tool. The command intentionally stays alive after writing crash-window-ready; do not reply before it exits. The fixture will terminate this physical Run; do not retry.";
	const runRecipient = { action: "run", agent: recipient, background: false, task: recipientTask };
	return {
		label: "01-crash-first",
		marker: "CRASH_FIRST_EXPECTED_OK",
		calls: [
			{ tool: "flux_agent", args: createSender },
			{ tool: "flux_agent", args: createRecipient },
			{ tool: "flux_agent", args: runSender },
			{ tool: "flux_agent", args: runRecipient },
		],
		prompt: [
			"This is a controlled AgentFlux Message V2 crash/redelivery fixture. Use only flux_agent.",
			`Call exactly these JSON arguments once and in order: ${JSON.stringify(createSender)}`,
			`Then call exactly: ${JSON.stringify(createRecipient)}`,
			`Then call exactly: ${JSON.stringify(runSender)}`,
			`Then call exactly: ${JSON.stringify(runRecipient)}`,
			"The sender must use its identity-bound flux_agent_message tool to create the real V2 envelope. The recipient Run is expected to fail because the fixture-owned crash harness terminates its recorded physical PID. Do not retry or call any other tool.",
			"After the expected recipient failure is returned, output exactly CRASH_FIRST_EXPECTED_OK. Do not claim that redelivery or ACK happened in this phase.",
		].join("\n"),
	};
}

function recoveryPrompt(agent: string, task: string, marker: string, label: string): PhaseSpec {
	const targetMarker = marker.replace("MAIN", "TARGET");
	const targetTask = `${task} After the actual inbox item is present, reply exactly ${targetMarker}.`;
	const run = { action: "run", agent, background: false, sessionMode: "fresh", task: targetTask };
	return {
		label,
		marker,
		calls: [{ tool: "flux_agent", args: run }],
		prompt: [
			"This is a controlled AgentFlux Message V2 redelivery fixture. Use only flux_agent.",
			`Call exactly this JSON once: ${JSON.stringify(run)}`,
			"The child must process the actual uncorrelated Message V2 item injected into its fresh physical Run. Do not use tools, do not invent or repeat a payload, and do not call flux_agent_message; the host ACK is the fact under test.",
			`Only after seeing the injected inbox item, the child task must reply exactly ${targetMarker} and finish normally.`,
			`After the child succeeds, output exactly ${marker}.`,
		].join("\n"),
	};
}

function ackLossPrompt(sender: string, recipient: string, payload: string): PhaseSpec {
	const createSender = { action: "create", name: sender, role: "implementer", scope: "project" };
	const createRecipient = { action: "create", name: recipient, role: "implementer", scope: "project" };
	const senderTask = `Use flux_agent_message exactly once with this exact JSON: ${JSON.stringify({ action: "send", target: recipient, content: payload, priority: "normal" })}. Do not use another tool, do not poll or acknowledge, and after the send succeeds reply exactly SENDER_ACK_LOSS_READY.`;
	const runSender = { action: "run", agent: sender, background: false, task: senderTask };
	const recipientTask = "Run exactly one bash command: node ack-window.cjs. Do not use another tool. After the command prints ACK_WINDOW_DONE, reply exactly ACK_LOSS_TARGET_OK and finish normally. The fixture-owned harness holds the Message V2 mutex only around the host ACK attempt; do not retry or acknowledge through another tool.";
	const runRecipient = { action: "run", agent: recipient, background: false, task: recipientTask };
	return {
		label: "03-ack-loss-first",
		marker: "ACK_LOSS_FIRST_EXPECTED_OK",
		calls: [
			{ tool: "flux_agent", args: createSender },
			{ tool: "flux_agent", args: createRecipient },
			{ tool: "flux_agent", args: runSender },
			{ tool: "flux_agent", args: runRecipient },
		],
		prompt: [
			"This is a controlled AgentFlux Message V2 ACK-loss fixture. Use only flux_agent.",
			`Call exactly these JSON arguments once and in order: ${JSON.stringify(createSender)}`,
			`Then call exactly: ${JSON.stringify(createRecipient)}`,
			`Then call exactly: ${JSON.stringify(runSender)}`,
			`Then call exactly: ${JSON.stringify(runRecipient)}`,
			"The sender must use its identity-bound flux_agent_message tool to create the real V2 envelope. The recipient child is expected to complete successfully. An infrastructure harness owned by this fixture will hold the Message V2 mutex so the host's real ACK attempt fails; this is not a product deadline and must not be treated as a child failure.",
			"Do not retry or call any other tool. After the expected successful recipient result, output exactly ACK_LOSS_FIRST_EXPECTED_OK.",
		].join("\n"),
	};
}

function coreSnapshot(): any {
	const fluxDir = join(fixtureRoot, ".agentflux");
	const envelopeDir = join(fluxDir, "shared", "messages-v2", "envelopes");
	const deliveryRoot = join(fluxDir, "shared", "messages-v2", "deliveries");
	const envelopes = existsSync(envelopeDir)
		? readdirSync(envelopeDir).filter(name => name.endsWith(".json")).map(name => json(join(envelopeDir, name))).filter(Boolean)
		: [];
	const deliveries = existsSync(deliveryRoot)
		? readdirSync(deliveryRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
			const recipientDir = join(deliveryRoot, entry.name);
			return readdirSync(recipientDir).filter(name => name.endsWith(".json")).map(name => json(join(recipientDir, name))).filter(Boolean);
		})
		: [];
	return {
		tasks: json(join(fluxDir, "runtime", "tasks.json")),
		agents: json(join(fluxDir, "runtime", "agents.json")),
		runs: json(join(fluxDir, "runtime", "runs.json")),
		messages: { envelopes, deliveries },
	};
}

async function main(): Promise<void> {
	const config = loadLiveConfig("core");
	const report: any = {
		startedAt: new Date().toISOString(),
		fixtureRoot,
		reportPath,
		latestReportPath,
		passed: false,
		workspaceRetained: true,
		failedEvidenceRetained: true,
		productionDist: true,
		provider: config.providerId,
		models: { main: config.mainModel, planner: config.plannerModel, worker: config.workerModel, judge: config.judgeModel },
		thinking: config.thinking,
		pricingAuthoritative: false,
		productDeadline: null,
		budget: { maxCostPerTask: 0.22, maxIterations: 2, maxTurnsPerTask: 10, maxInputTokensPerTask: 80_000, maxParallelAgents: 1, maxWallClockSeconds: null },
		infrastructureWatchdogMs,
		redeliveryAfterMs,
		coverage: { crashRedelivery: false, ackLossRedelivery: false },
		processes: [],
		phases: [],
	};
	const ownedProcesses = new Set<OwnedProcess>();
	const observedRunPids = new Map<number, string>();
	let infrastructureWatchdog: NodeJS.Timeout | undefined;
	let ackLockHolder: OwnedProcess | undefined;
	const observations: Record<string, DeliveryObservation[]> = {};
	const snapshots: Record<string, MessageV2Snapshot | undefined> = {};
	const runFacts: Record<string, any> = {};
	try {
		assert.equal(process.env.AGENTFLUX_LIVE_BUILT, "1", "Message redelivery requires AGENTFLUX_LIVE_BUILT=1");
		assert.ok(existsSync(join(sourceRoot, "dist", "extension", "entry.js")), "production dist entry is missing");
		assert.ok(existsSync(join(sourceRoot, "dist", "extension", "subagent-entry.js")), "production subagent dist entry is missing");
		assert.ok(existsSync(join(sourceRoot, "dist", "extension", "background-preload.mjs")), "production background preload is missing");
		mkdirSync(fixtureRoot, { recursive: true });
		mkdirSync(resultsRoot, { recursive: true });
		cpSync(join(sourceRoot, "dist", "extension"), join(fixtureRoot, "dist", "extension"), { recursive: true });
		mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
		writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux Message V2 crash and ACK-loss fixture\n");
		writeFaultHarnesses();
		const liveModels: any = config.fluxModelsJson();
		liveModels.roles.implementer.tools = ["read", "grep", "find", "ls", "bash"];
		writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(liveModels, null, 2));
		writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
			budget: {
				max_cost_per_task: 0.22,
				max_iterations: 2,
				max_turns_per_task: 10,
				max_input_tokens_per_task: 80_000,
				max_parallel_agents: 1,
				max_wall_clock_seconds: null,
			},
			communication: {
				rpc_inbox_pump: true,
				poll_interval_ms: 100,
				batch_size: 1,
				heartbeat_interval_ms: 1_000,
				runtime_lease_ms: 15_000,
				redelivery_after_ms: redeliveryAfterMs,
			},
			pricing: { enable_remote_fetch: false },
		}, null, 2));
		report.dist = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"].map(name => {
			const sourcePath = join(sourceRoot, "dist", "extension", name);
			const fixturePath = join(fixtureRoot, "dist", "extension", name);
			const sourceSha256 = hash(sourcePath);
			const fixtureSha256 = hash(fixturePath);
			return {
				name,
				sourceSha256,
				fixtureSha256,
				sameBytes: sourceSha256 === fixtureSha256,
				bytes: readFileSync(fixturePath).byteLength,
			};
		});
		assert.ok(report.dist.every((entry: any) => entry.sameBytes), "fixture must execute the copied production dist bytes");
		report.configPath = config.configPath;
		infrastructureWatchdog = setTimeout(() => {
			report.infrastructureWatchdogExpired = true;
			for (const owned of ownedProcesses) owned.stop();
			for (const pid of observedRunPids.keys()) stopObservedRun(pid, observedRunPids);
		}, infrastructureWatchdogMs);
		infrastructureWatchdog.unref?.();

		// Crash/redelivery: a real sender Run sends the direct V2 handoff before the recipient Run.
		const crashSender = `redelivery-crash-sender-${iteration}`;
		const crashAgent = `redelivery-crash-${iteration}`;
		const crashPayload = `CRASH_REDELIVERY_PAYLOAD_${iteration}`;
		const crashSpec = crashPrompt(crashSender, crashAgent, crashPayload);
		const crashMain = launchPiPhase(config, report, crashSpec);
		ownedProcesses.add(crashMain);
		await waitFor(() => {
			const run = activeRun(crashAgent);
			if (run?.pid) observedRunPids.set(run.pid, run.id);
			const snapshot = observeDelivery(crashPayload, crashAgent, observations.crash ?? (observations.crash = []));
			return !!run && existsSync(join(fixtureRoot, "crash-window-ready")) && snapshot?.delivery.status === "delivered" && snapshot.delivery.attempts === 1;
		}, 180_000, "crash first Run and first Message V2 delivery");
		const crashFirstRun = activeRun(crashAgent);
		assert.ok(crashFirstRun?.pid, "crash first Run has no recorded PID");
		assert.notEqual(crashFirstRun.pid, process.pid, "crash harness must not target itself");
		assert.notEqual(crashFirstRun.pid, crashMain.child.pid, "crash harness must not target the fixture Main PID");
		const crashFirstSnapshot = observeDelivery(crashPayload, crashAgent, observations.crash)!;
		assert.equal(crashFirstSnapshot.delivery.status, "delivered");
		assert.equal(crashFirstSnapshot.delivery.attempts, 1);
		assert.equal(envelopesForContent(crashPayload).length, 1, "sender must issue exactly one crash payload envelope");
		const crashWindow = json(join(fixtureRoot, "crash-window-ready"));
		assert.ok(Number.isInteger(crashWindow?.pid) && isProcessAlive(crashWindow.pid), "crash fault harness PID was not alive before the owned Run kill");
		const crashSenderRun = runsFor(crashSender).find(run => run.status === "completed");
		assert.ok(crashSenderRun, "sender Run did not complete before recipient delivery");
		assert.equal(crashFirstSnapshot.envelope.senderRunId, crashSenderRun.id, "senderRunId must be the sender's physical Run");
		const crashKillPid = crashFirstRun.pid as number;
		report.crash = { logicalSender: crashSender, logicalRecipient: crashAgent, senderRunId: crashSenderRun.id, messageId: crashFirstSnapshot.messageId, firstRunId: crashFirstRun.id, killedRunPid: crashKillPid, crashHarnessPid: crashWindow.pid, killPidWasObservedInCore: observedRunPids.has(crashKillPid), killOwnedProcessOnly: true };
		assert.equal(stopObservedRun(crashKillPid, observedRunPids), true, "crash injection requires verified birth and an issued signal");
		await waitFor(() => !isProcessAlive(crashKillPid), 15_000, "fixture-owned crash Run exit");
		await waitFor(() => !isProcessAlive(crashWindow.pid), 15_000, "fixture-owned crash harness exit");
		await finishPiPhase(crashMain, report, crashSpec);
		const crashRunsAfter = runsFor(crashAgent);
		const crashedRun = crashRunsAfter.find(run => run.id === crashFirstRun.id);
		assert.ok(crashedRun, "crashed Run disappeared from Core registry");
		assert.equal(crashedRun.status, "failed", "external hard kill is a failure, not a user cancellation");
		runFacts.crashFirst = crashedRun;
		const crashAfterFailure = observeDelivery(crashPayload, crashAgent, observations.crash)!;
		assert.equal(crashAfterFailure.delivery.status, "delivered", "crash must retain the unacknowledged delivery");
		assert.equal(crashAfterFailure.delivery.attempts, 1);
		await waitForRedeliveryWindow(crashAfterFailure);
		const crashRecoverySpec = recoveryPrompt(crashAgent, "Process the actual uncorrelated Message V2 inbox item in this fresh physical Run. Do not use tools. If the item is absent, fail instead of guessing.", "CRASH_REDELIVERY_MAIN_OK", "02-crash-recovery");
		const crashRecoveryMain = launchPiPhase(config, report, crashRecoverySpec);
		ownedProcesses.add(crashRecoveryMain);
		await waitFor(() => {
			const replacement = runsFor(crashAgent).find(run => run.id !== crashFirstRun.id);
			if (replacement?.pid) observedRunPids.set(replacement.pid, replacement.id);
			const snapshot = observeDelivery(crashPayload, crashAgent, observations.crash)!;
			return !!replacement && snapshot.delivery.attempts === 2;
		}, 90_000, "crash replacement Run redelivery attempt");
		const crashReplacementRun = runsFor(crashAgent).find(run => run.id !== crashFirstRun.id);
		assert.ok(crashReplacementRun, "crash replacement Run was not registered");
		const crashRecoveryResult = await finishPiPhase(crashRecoveryMain, report, crashRecoverySpec);
		const crashFinalSnapshot = observeDelivery(crashPayload, crashAgent, observations.crash)!;
		const crashReplacementFinal = runsFor(crashAgent).find(run => run.id === crashReplacementRun.id);
		assert.ok(crashReplacementFinal);
		assert.equal(crashRecoveryResult.exitCode, 0);
		assertMessageRedeliveryContract({
			recipient: crashAgent,
			expectedSender: crashSender,
			expectedSenderRunId: crashSenderRun.id,
			snapshot: crashFinalSnapshot,
			firstDelivery: { status: "delivered", attempts: 1, deliveredAt: crashFirstSnapshot.delivery.deliveredAt },
			firstRun: crashedRun,
			replacementRun: crashReplacementFinal,
			expectedFirstRunStatus: "failed",
			observations: observations.crash,
		});
		snapshots.crash = crashFinalSnapshot;
		runFacts.crashReplacement = crashReplacementFinal;
		report.crash.final = { envelope: crashFinalSnapshot.envelope, delivery: crashFinalSnapshot.delivery, firstRun: crashedRun, replacementRun: crashReplacementFinal, observations: observations.crash };
		report.crash.sessions = collectSessionEvidence(join(fixtureRoot, ".agentflux"), [crashPayload, "CRASH_REDELIVERY_TARGET_OK"], { pathIncludes: crashAgent });
		report.crash.senderToolCalls = countSessionToolCalls(join(fixtureRoot, ".agentflux"), "flux_agent_message", { pathIncludes: crashSender });
		report.crash.recipientToolCalls = countSessionToolCalls(join(fixtureRoot, ".agentflux"), "flux_agent_message", { pathIncludes: crashAgent });
		assert.equal(report.crash.senderToolCalls, 1, "crash sender must issue one real identity-bound Message V2 send");
		assert.equal(report.crash.recipientToolCalls, 0, "crash recipient must not fabricate an explicit ACK");
		assert.equal(report.crash.sessions.totals.userNeedleCounts[crashPayload] ?? 0, 2, "crash payload must appear once in each physical Run session");
		assert.equal(report.crash.sessions.totals.assistantSuccessExactCounts.CRASH_REDELIVERY_TARGET_OK ?? 0, 1, "crash replacement must produce its exact target marker once");
		report.coverage.crashRedelivery = true;

		// ACK-loss/redelivery: the target child completes, while a fixture-owned lock
		// holder makes the real host acknowledgement fail closed and retain delivery.
		const ackSender = `redelivery-ack-sender-${iteration}`;
		const ackAgent = `redelivery-ack-${iteration}`;
		const ackPayload = `ACK_LOSS_REDELIVERY_PAYLOAD_${iteration}`;
		const ackSpec = ackLossPrompt(ackSender, ackAgent, ackPayload);
		const ackMain = launchPiPhase(config, report, ackSpec);
		ownedProcesses.add(ackMain);
		const ackObservations: DeliveryObservation[] = observations.ack ?? (observations.ack = []);
		await waitFor(() => {
			const run = activeRun(ackAgent);
			if (run?.pid) observedRunPids.set(run.pid, run.id);
			const snapshot = observeDelivery(ackPayload, ackAgent, ackObservations);
			return !!run && existsSync(join(fixtureRoot, "ack-window-ready")) && snapshot?.delivery.status === "delivered" && snapshot.delivery.attempts === 1;
		}, 180_000, "ACK-loss first Run and first Message V2 delivery");
		const ackFirstRun = activeRun(ackAgent);
		assert.ok(ackFirstRun?.pid, "ACK-loss first Run has no recorded PID");
		assert.notEqual(ackFirstRun.pid, process.pid, "ACK-loss harness must not target the fixture process");
		assert.notEqual(ackFirstRun.pid, ackMain.child.pid, "ACK-loss harness must not target the fixture Main PID");
		const ackFirstSnapshot = observeDelivery(ackPayload, ackAgent, ackObservations)!;
		assert.equal(envelopesForContent(ackPayload).length, 1, "sender must issue exactly one ACK-loss payload envelope");
		const ackWindow = json(join(fixtureRoot, "ack-window-ready"));
		assert.ok(Number.isInteger(ackWindow?.pid) && isProcessAlive(ackWindow.pid), "ACK-loss target fault harness PID was not alive before lock injection");
		const ackSenderRun = runsFor(ackSender).find(run => run.status === "completed");
		assert.ok(ackSenderRun, "ACK-loss sender Run did not complete before recipient delivery");
		assert.equal(ackFirstSnapshot.envelope.senderRunId, ackSenderRun.id, "ACK-loss senderRunId must be the sender's physical Run");
		ackLockHolder = launchOwnedProcess("ack-lock-holder", [join(fixtureRoot, "ack-lock-holder.cjs")], 180_000, config.env);
		ownedProcesses.add(ackLockHolder);
		await waitFor(() => existsSync(join(fixtureRoot, "ack-lock-acquired")), 30_000, "fixture-owned ACK-loss lock acquisition");
		const lockRecord = json(join(fixtureRoot, "ack-lock-acquired"));
		assert.ok(Number.isInteger(lockRecord?.pid) && isProcessAlive(lockRecord.pid), "ACK-loss lock holder PID was not alive after acquisition");
		report.ackLoss = {
			logicalSender: ackSender,
			logicalRecipient: ackAgent,
			senderRunId: ackSenderRun.id,
			messageId: ackFirstSnapshot.messageId,
			firstRunId: ackFirstRun.id,
			firstRunPid: ackFirstRun.pid,
			ackWindowPid: ackWindow.pid,
			harnessPid: lockRecord?.pid,
			lockAcquired: true,
			lockPath: join(fixtureRoot, ".agentflux", "shared", "messages-v2", ".mutex.lock"),
		};
		await waitFor(() => existsSync(join(fixtureRoot, "ack-window-armed")), 30_000, "ACK-loss target enters post-lock window");
		const ackFirstResult = await ackMain.result;
		const ackFirstRunsAfter = runsFor(ackAgent);
		const ackCompletedRun = ackFirstRunsAfter.find(run => run.id === ackFirstRun.id);
		assert.ok(ackCompletedRun, "ACK-loss first Run disappeared from Core registry");
		assert.equal(ackCompletedRun.status, "completed", "ACK-loss child success must remain a completed Run");
		const ackAfterHostFailure = observeDelivery(ackPayload, ackAgent, ackObservations)!;
		assert.equal(ackAfterHostFailure.delivery.status, "delivered", "failed host ACK must retain delivery");
		assert.equal(ackAfterHostFailure.delivery.attempts, 1);
		const ackFailureObserved = /acknowledgement failed|MessageBus mutex timeout/i.test(`${ackFirstResult.stdout}\n${ackFirstResult.stderr}`);
		report.ackLoss.hostAckFailureObserved = ackFailureObserved;
		assert.equal(ackFailureObserved, true, "host ACK failure was not present in retained Main stderr evidence");
		writeFileSync(join(fixtureRoot, "ack-release"), "release");
		await sleep(100);
		if (ackLockHolder) {
			await waitFor(() => ackLockHolder?.child.pid === undefined || !isProcessAlive(ackLockHolder.child.pid), 15_000, "ACK-loss lock holder exit");
			const lockResult = await ackLockHolder.result;
			assert.equal(lockResult.exitCode, 0, "fixture-owned ACK-loss lock holder did not release cleanly");
			report.ackLoss.lockHolder = lockResult;
		}
		await finishPiPhase(ackMain, report, ackSpec);
		await waitForRedeliveryWindow(ackAfterHostFailure);
		const ackRecoverySpec = recoveryPrompt(ackAgent, "Process the actual uncorrelated Message V2 inbox item in this fresh physical Run. Do not use tools. If the item is absent, fail instead of guessing.", "ACK_REDELIVERY_MAIN_OK", "04-ack-loss-recovery");
		const ackRecoveryMain = launchPiPhase(config, report, ackRecoverySpec);
		ownedProcesses.add(ackRecoveryMain);
		await waitFor(() => {
			const replacement = runsFor(ackAgent).find(run => run.id !== ackFirstRun.id);
			if (replacement?.pid) observedRunPids.set(replacement.pid, replacement.id);
			const snapshot = observeDelivery(ackPayload, ackAgent, ackObservations);
			return !!replacement && snapshot?.delivery?.attempts === 2;
		}, 90_000, "ACK-loss replacement Run redelivery attempt");
		const ackReplacementRun = runsFor(ackAgent).find(run => run.id !== ackFirstRun.id);
		assert.ok(ackReplacementRun, "ACK-loss replacement Run was not registered");
		const ackRecoveryResult = await finishPiPhase(ackRecoveryMain, report, ackRecoverySpec);
		const ackFinalSnapshot = observeDelivery(ackPayload, ackAgent, ackObservations)!;
		const ackReplacementFinal = runsFor(ackAgent).find(run => run.id === ackReplacementRun.id);
		assert.ok(ackReplacementFinal);
		assert.equal(ackRecoveryResult.exitCode, 0);
		assertMessageRedeliveryContract({
			recipient: ackAgent,
			expectedSender: ackSender,
			expectedSenderRunId: ackSenderRun.id,
			snapshot: ackFinalSnapshot,
			firstDelivery: { status: "delivered", attempts: 1, deliveredAt: ackFirstSnapshot.delivery.deliveredAt },
			firstRun: ackCompletedRun,
			replacementRun: ackReplacementFinal,
			expectedFirstRunStatus: "completed",
			observations: ackObservations,
			ackLoss: {
				lockAcquired: true,
				ackFailureObserved,
				firstRunDelivery: { status: ackAfterHostFailure.delivery.status, attempts: ackAfterHostFailure.delivery.attempts },
				harnessPid: lockRecord?.pid,
			},
		});
		snapshots.ack = ackFinalSnapshot;
		runFacts.ackFirst = ackCompletedRun;
		runFacts.ackReplacement = ackReplacementFinal;
		report.ackLoss.final = { envelope: ackFinalSnapshot.envelope, delivery: ackFinalSnapshot.delivery, firstRun: ackCompletedRun, replacementRun: ackReplacementFinal, observations: ackObservations };
		report.ackLoss.sessions = collectSessionEvidence(join(fixtureRoot, ".agentflux"), [ackPayload, "ACK_LOSS_TARGET_OK", "ACK_REDELIVERY_TARGET_OK"], { pathIncludes: ackAgent });
		report.ackLoss.senderToolCalls = countSessionToolCalls(join(fixtureRoot, ".agentflux"), "flux_agent_message", { pathIncludes: ackSender });
		report.ackLoss.recipientToolCalls = countSessionToolCalls(join(fixtureRoot, ".agentflux"), "flux_agent_message", { pathIncludes: ackAgent });
		assert.equal(report.ackLoss.senderToolCalls, 1, "ACK-loss sender must issue one real identity-bound Message V2 send");
		assert.equal(report.ackLoss.recipientToolCalls, 0, "ACK-loss recipient must not fabricate an explicit ACK");
		assert.equal(report.ackLoss.sessions.totals.userNeedleCounts[ackPayload] ?? 0, 2, "ACK-loss payload must appear once in each physical Run session");
		assert.equal(report.ackLoss.sessions.totals.assistantSuccessExactCounts.ACK_LOSS_TARGET_OK ?? 0, 1, "ACK-loss first target must complete its exact marker once");
		assert.equal(report.ackLoss.sessions.totals.assistantSuccessExactCounts.ACK_REDELIVERY_TARGET_OK ?? 0, 1, "ACK-loss replacement must produce its exact target marker once");
		report.coverage.ackLossRedelivery = true;

		const checkpointArtifacts = listCheckpointArtifacts(join(fixtureRoot, ".agentflux"));
		assert.deepEqual(checkpointArtifacts, [], "Message-only fixture must not fabricate Workflow checkpoints");
		report.checkpointArtifacts = checkpointArtifacts;
		report.runs = readRuns(join(fixtureRoot, ".agentflux"));
		report.core = coreSnapshot();
		const tasks = report.core.tasks;
		assert.equal(tasks.tasks.length, 4); assert.equal(tasks.executions.length, 4);
		report.parentChecks = report.phases.map((phase: any) => {
			const execution = tasks.executions.find((item: any) => item.ownerPid === phase.pid);
			assert.ok(execution, `missing parent Execution for ${phase.label}`);
			const task = tasks.tasks.find((item: any) => item.id === execution.taskId);
			const expected = phase.label === "01-crash-first" ? "failed" : "completed";
			assert.equal(task?.status, expected); assert.equal(execution.status, expected);
			assert.equal(execution.outcome?.status, expected === "failed" ? "failure" : "success");
			return { label: phase.label, taskId: task.id, executionId: execution.id, expected, passed: true };
		});
		assert.ok(report.runs.every((run: any) => !ACTIVE_RUNS.has(run.status)), "no active Run may remain after successful recovery");
		report.noProductDeadline = report.runs.every((run: any) => run.deadlineAt === undefined);
		assert.equal(report.noProductDeadline, true, "fixture introduced a product execution deadline");
		report.passed = Object.values(report.coverage).every(Boolean) && report.infrastructureWatchdogExpired !== true;
		assert.equal(report.passed, true);
	} catch (error) {
		report.error = error instanceof Error ? error.stack : String(error);
		process.exitCode = 1;
	} finally {
		if (infrastructureWatchdog) clearTimeout(infrastructureWatchdog);
		try { writeFileSync(join(fixtureRoot, "ack-release"), "cleanup"); } catch {}
		for (const owned of ownedProcesses) owned.stop();
		for (const pid of observedRunPids.keys()) stopObservedRun(pid, observedRunPids);
		const until = Date.now() + 15_000;
		while ([...ownedProcesses].some(owned => owned.child.exitCode === null && owned.child.signalCode === null) && Date.now() < until) await sleep(50);
		const processFacts = [...ownedProcesses].map(owned => ({
			label: owned.label,
			pid: owned.child.pid,
			exitCode: owned.child.exitCode,
			signal: owned.child.signalCode,
			alive: owned.child.pid ? isProcessAlive(owned.child.pid) : false,
			infrastructureOwned: true,
		}));
		report.processes = processFacts;
		report.stopBirthChecks = stopBirthChecks;
		report.observedRunPids = [...observedRunPids].map(([pid, runId]) => ({ pid, runId, alive: isProcessAlive(pid), recordedByCore: true }));
		if (processFacts.some(item => item.alive) || report.observedRunPids.some((item: any) => item.alive)) {
			report.passed = false; process.exitCode = 1;
			report.cleanupError = "A recorded process is still alive; no complete exit claim is made";
		}
		report.finalSnapshots = snapshots;
		report.finalRunFacts = runFacts;
		report.finishedAt = new Date().toISOString();
		report.workspaceRetained = true;
		try { report.coreAtFinish = coreSnapshot(); } catch (error) { report.coreAtFinishError = String(error); }
		try {
			mkdirSync(resultsRoot, { recursive: true });
			writeFileSync(reportPath, JSON.stringify(report, null, 2));
			writeFileSync(latestReportPath, JSON.stringify(report, null, 2));
		} catch (error) {
			console.error(`unable to persist Message V2 redelivery evidence: ${String(error)}`);
			process.exitCode = 1;
		}
		config.cleanup();
		console.log(JSON.stringify({ passed: report.passed, reportPath, fixtureRoot, error: report.error }));
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
