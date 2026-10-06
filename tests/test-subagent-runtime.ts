import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as sdk from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import agentFlux from "../src/entry";
import { runAgent, getActiveAgentRunIds } from "../src/agents/agent-runner";
import { SdkRunDriver } from "../src/agents/sdk-run-driver";
import { loadSubagentRuntime, resolveSubagentRuntime } from "../src/core/config";
import { bindPiSdkHost, releasePiSdkHost } from "../src/core/pi-sdk";
import { listAgentRuns, markAgentRunRunning, markSdkAgentRunRunning, registerAgentRun, reconcileStaleAgentRuns } from "../src/core/run-registry";
import { createSdkRunOwner, activateSdkRunOwner, retireSdkRunOwner, isSdkRunOwnerActive } from "../src/core/runtime-owner";
import { SharedBoard } from "../src/core/shared-board";
import { readActiveContext } from "../src/core/active-context";
import { observeProcessAsync } from "../src/core/process-identity";

const root = mkdtempSync(join(tmpdir(), "flux-dual-runtime-"));
const fluxDir = join(root, ".agentflux"); mkdirSync(fluxDir);
const configPath = join(fluxDir, "agentflux.json");
const setMode = (value: unknown) => writeFileSync(configPath, JSON.stringify({ subagent_runtime: value, pricing: { enable_remote_fetch: false } }));
const environment = JSON.stringify(Object.entries(process.env).sort());
const workingDirectory = process.cwd();
const usage = (cost: number) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const children: sdk.AgentSession[] = [];
let active = 0, peak = 0, requests = 0;
let cancelOnRequest: AbortController | undefined;
let main: sdk.AgentSession | undefined;
let binding: ReturnType<typeof bindPiSdkHost> | undefined;
const template = { name: "sdk-worker", role: "tester", description: "fixture", systemPrompt: "Short fixture only", model: "fixture", provider: "dual-fixture", tools: ["read"], skills: [], source: "test" };
const base = { cwd: root, agent: template, sessionId: "parent", prefixLayout: false, maxRetries: 0, thinking: "off" as const };
try {
	// This positive SDK suite requires an OS-verified Main identity. A cold
	// Windows CIM helper can exceed its unchanged per-probe bound on CI;
	// retry observation only, never start a Run with an invented/unknown birth.
	let mainBirth = await observeProcessAsync(process.pid);
	for (let attempt = 1; attempt < 3 && mainBirth.state === "unknown"; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 100));
		mainBirth = await observeProcessAsync(process.pid);
	}
	assert.equal(mainBirth.state, "alive", `SDK fixture requires a verified Main birth: ${JSON.stringify(mainBirth)}`);
	assert.equal(resolveSubagentRuntime(undefined), "process"); assert.equal(resolveSubagentRuntime("sdk"), "sdk");
	assert.throws(() => resolveSubagentRuntime("auto"), /subagent_runtime/);
	assert.equal(loadSubagentRuntime(root), "process");
	setMode("auto"); assert.equal((await runAgent({ ...base, task: "REJECT" })).exitCode, 72);
	assert.equal(listAgentRuns(fluxDir).length, 0);
	writeFileSync(configPath, "{"); assert.throws(() => loadSubagentRuntime(root), /Cannot read/);
	setMode("sdk"); assert.match((await runAgent({ ...base, task: "UNBOUND" })).errorMessage!, /module-identity-verified/);
	assert.equal(listAgentRuns(fluxDir).length, 0);

	const agentDir = join(root, "pi"); mkdirSync(agentDir);
	const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("dual-fixture", { api: "dual-fixture-api" as any, apiKey: "offline", baseUrl: "http://127.0.0.1:1", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model: any, _context: any, options: any) {
			requests++; active++; peak = Math.max(peak, active);
			const stream = createAssistantMessageEventStream(); let ended = false;
			const finish = (aborted = false) => {
				if (ended) return; ended = true; active--;
				const message: any = { role: "assistant", api: model.api, model: model.id, provider: model.provider,
					content: aborted ? [] : [{ type: "text", text: "SDK_FIXTURE_OK" }], usage: usage(aborted ? 0 : 0.03), stopReason: aborted ? "aborted" : "stop", timestamp: Date.now() };
				stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
				stream.push(aborted ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: "stop", message }); stream.end();
			};
			const timer = setTimeout(() => finish(), 50);
			if (cancelOnRequest) { const controller = cancelOnRequest; cancelOnRequest = undefined; setTimeout(() => controller.abort(), 5); }
			options?.signal?.addEventListener("abort", () => { clearTimeout(timer); finish(true); }, { once: true });
			if (options?.signal?.aborted) { clearTimeout(timer); finish(true); }
			return stream;
		},
	});
	const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
	let context: sdk.ExtensionContext | undefined;
	const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [agentFlux, pi => { pi.on("session_start", (_event, ctx) => { context = ctx; }); }] });
	await loader.reload();
	main = (await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel("dual-fixture", "fixture"), thinkingLevel: "off", settingsManager: settings,
		sessionManager: sdk.SessionManager.inMemory(root), resourceLoader: loader })).session;
	await main.bindExtensions({ mode: "json" });
	assert.ok(context);
	// Instrument public SDK creation only; runtime identity still uses the real classes.
	const instrumented: typeof sdk = { ...sdk, createAgentSession: async options => { const created = await sdk.createAgentSession(options); children.push(created.session); return created; } };
	binding = bindPiSdkHost(root, instrumented, context, {});
	let injected = false;
	const costRun = await runAgent({ ...base, task: "COST", runId: "sdk-cost", onEvent: (event: any) => {
		if (event.type === "message_end" && event.message?.role === "assistant" && !injected) {
			injected = true;
			children.at(-1)!.sessionManager.appendMessage({ role: "toolResult", toolCallId: "fee", toolName: "fixture", content: [{ type: "text", text: "simulated tool usage" }], isError: false, usage: usage(0.4), timestamp: Date.now() } as any);
			children.at(-1)!.sessionManager.appendUsage("cache_warm", "dual-fixture", "fixture", usage(0.3));
		}
	} });
	assert.equal(costRun.exitCode, 0, JSON.stringify(costRun));
	assert.ok(Math.abs(costRun.usage.cost - 0.73) < 1e-12, JSON.stringify(costRun));
	assert.equal(costRun.costAccounting?.complete, true);
	assert.equal(costRun.backend, "sdk");
	const persisted = listAgentRuns(fluxDir).find(run => run.id === "sdk-cost")!;
	assert.equal(persisted.backend, "sdk"); assert.equal(persisted.pid, undefined); assert.equal(persisted.processIdentity, undefined);
	assert.equal(persisted.sdkOwner?.host.pid, process.pid); assert.equal(persisted.status, "completed"); assert.equal(persisted.sdkSessionId, costRun.sessionId);
	assert.ok(!getActiveAgentRunIds().includes("sdk-cost")); assert.equal(readActiveContext(root).entries.length, 0);

	const initialEntries = main.sessionManager.getEntries().length;
	const workA = join(root, "a"), workB = join(root, "b"); mkdirSync(workA); mkdirSync(workB);
	const results = await Promise.all([runAgent({ ...base, task: "A", runId: "sdk-a", workspaceCwd: workA }), runAgent({ ...base, task: "B", runId: "sdk-b", workspaceCwd: workB })]);
	assert.ok(peak >= 2);
	for (const result of results) assert.equal(result.exitCode, 0, JSON.stringify(result));
	assert.notEqual(results[0].sessionId, results[1].sessionId);
	assert.equal(children.find(child => child.sessionManager.getSessionId() === results[0].sessionId)!.sessionManager.getCwd(), workA);
	assert.equal(children.find(child => child.sessionManager.getSessionId() === results[1].sessionId)!.sessionManager.getCwd(), workB);
	assert.equal(main.sessionManager.getEntries().length, initialEntries, "child history must not enter Main");
	await main.prompt("MAIN_AFTER_CHILD_DISPOSE");
	assert.equal(main.getSessionStats().cost, 0.03);

	const controller = new AbortController();
	cancelOnRequest = controller;
	const beforeCancellation = requests;
	const cancelled = runAgent({ ...base, task: "CANCEL", runId: "sdk-cancel", signal: controller.signal });
	const cancelledResult = await cancelled;
	assert.equal(cancelledResult.exitCode, 130, JSON.stringify(cancelledResult)); assert.equal(active, 0);
	assert.equal(requests, beforeCancellation + 1, "cancel a live provider request, not just preflight");
	await main.prompt("MAIN_AFTER_CANCELLATION");
	assert.equal(main.getSessionStats().cost, 0.06, "child cancellation must not abort Main");
	assert.equal(listAgentRuns(fluxDir).find(run => run.id === "sdk-cancel")!.status, "cancelled");
	assert.equal(readActiveContext(root).entries.length, 0); assert.deepEqual(getActiveAgentRunIds(), []);
	assert.match((await runAgent({ ...base, task: "ENV", env: { ANY: "value" } })).errorMessage!, /environment overrides/);
	const frozen = await runAgent({ ...base, task: "FREEZE", runId: "sdk-freeze", onEvent: (event: any) => { if (event.type === "agent_start") setMode("process"); } });
	assert.equal(frozen.exitCode, 0, JSON.stringify(frozen)); assert.equal(frozen.backend, "sdk"); assert.equal(loadSubagentRuntime(root), "process");
	setMode("sdk");
	const persistent = await runAgent({ ...base, task: "PERSIST_1", runId: "sdk-persist-1", persistent: true, persistentSessionId: "fixture-persist" });
	assert.equal(persistent.exitCode, 0, JSON.stringify(persistent));
	const historical = JSON.stringify(listAgentRuns(fluxDir).find(run => run.id === "sdk-persist-1"));
	const continued = await runAgent({ ...base, task: "PERSIST_2", runId: "sdk-persist-2", persistent: true, persistentSessionId: "fixture-persist" });
	assert.equal(continued.exitCode, 0, JSON.stringify(continued)); assert.equal(continued.sessionId, persistent.sessionId);
	assert.equal(continued.usage.cost, 0.03, "inherited .03 must not be charged again");
	assert.equal(JSON.stringify(listAgentRuns(fluxDir).find(run => run.id === "sdk-persist-1")), historical);
	assert.ok(readFileSync(persistent.sessionFile!, "utf8").includes("PERSIST_1"));
	const limited = await runAgent({ ...base, task: "LIMIT", runId: "sdk-limit", maxCostUsd: 0.01 });
	assert.equal(limited.exitCode, 75, JSON.stringify(limited)); assert.equal(limited.usage.cost, 0.03);
	assert.equal(listAgentRuns(fluxDir).find(run => run.id === "sdk-limit")!.status, "failed");
	assert.equal(process.cwd(), workingDirectory);
	assert.equal(JSON.stringify(Object.entries(process.env).sort()), environment);

	// Fenced logical ownership: missing handle stays protected, drained same fence permits recovery.
	const owner = createSdkRunOwner("sdk-orphan");
	assert.equal(isSdkRunOwnerActive(root, owner), true);
	activateSdkRunOwner(root, owner);
	registerAgentRun(fluxDir, { id: owner.runId, sessionId: "parent", agent: "orphan", role: "tester", currentTask: "test", kind: "ephemeral", backend: "sdk", sdkOwner: owner });
	assert.throws(() => markAgentRunRunning(fluxDir, owner.runId, process.pid, 1), /must not bind/);
	markSdkAgentRunRunning(fluxDir, owner.runId, owner, "orphan-session", 1);
	const locked = join(root, "locked.txt"); writeFileSync(locked, "locked");
	const ownBoard = new SharedBoard(fluxDir, { runtimeOwner: owner });
	assert.equal(ownBoard.acquireFileLock("orphan", locked, -1), true);
	const otherBoard = new SharedBoard(fluxDir);
	assert.equal(otherBoard.acquireFileLock("other", locked), false);
	assert.equal(otherBoard.releaseFileLock(locked), false, "same PID cannot release another logical Run's lock");
	const future = new Date(Date.now() + 60000);
	assert.deepEqual(reconcileStaleAgentRuns(fluxDir, { now: future }), [], "heartbeat alone cannot terminalize an SDK session");
	retireSdkRunOwner(root, owner);
	assert.equal(isSdkRunOwnerActive(root, owner), false);
	assert.equal(otherBoard.acquireFileLock("other", locked), true);
	assert.equal(reconcileStaleAgentRuns(fluxDir, { now: future }).find(run => run.id === owner.runId)?.status, "failed");
	otherBoard.releaseAllLocks("other");

	// Failed cleanup must neither manufacture exit evidence nor reject an
	// unobserved work Promise that would crash the shared Main process.
	let cleanupError: Error | undefined, manufacturedClose = false, disposed = false;
	const unsafe = new SdkRunDriver({ sessionManager: { getSessionId: () => "unsafe", getSessionFile: () => undefined },
		subscribe: () => () => {}, prompt: async () => {}, abort: async () => { throw new Error("idle not proven"); },
		waitForIdle: async () => {}, isStreaming: false, getSteeringMessages: () => [], getFollowUpMessages: () => [],
		clearQueue: () => {}, dispose: () => { disposed = true; } } as any,
		{ closeInput: () => {}, shutdown: () => {}, hasPendingInput: () => false, initializationError: () => undefined } as any);
	unsafe.on("error", (error: Error) => { cleanupError = error; }); unsafe.on("close", () => { manufacturedClose = true; });
	unsafe.start("UNSAFE_CLEANUP"); await new Promise(resolve => setTimeout(resolve, 10));
	assert.match(cleanupError!.message, /did not prove idle/); assert.equal(manufacturedClose, false);
	assert.equal(unsafe.hasExited, false); assert.equal(disposed, false);
	console.log(`Dual runtime: strict config, SDK .73 accounting, ${requests} mock requests, same-PID independent cwd/session, cooperative cancellation, owner fences, Main after child and no env/cwd mutation passed`);
} finally {
	for (const session of children) { await session.abort(); session.dispose(); }
	if (main) { await main.abort(); main.dispose(); }
	releasePiSdkHost(root, binding);
	rmSync(root, { recursive: true, force: true });
}
