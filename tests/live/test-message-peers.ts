// 真实 Main → sender/receiver Pi：跨 Run direct/group/broadcast 与逐收件人 ACK。
// RPC busy steer/stop 由 controls fixture 覆盖；本测试不冒充崩溃重投验收。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";
import { isProcessAlive } from "../../src/core/fs-lock";

const sourceRoot = resolve(import.meta.dirname, "../..");
const id = `${Date.now()}-${process.pid}`;
const root = join(sourceRoot, ".agentflux/test-workspaces", `message-peers-${id}`);
const reportPath = join(sourceRoot, ".agentflux/test-results", `message-peers-${id}.json`);
const latestPath = join(sourceRoot, ".agentflux/test-results/message-peers-latest.json");
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
	const config = loadLiveConfig("core");
	const report: any = { startedAt: new Date().toISOString(), root, reportPath, provider: config.providerId,
		model: config.mainModel, thinking: config.thinking, passed: false, pricingAuthoritative: false, crashRedeliveryTested: false };
	mkdirSync(root, { recursive: true }); mkdirSync(join(sourceRoot, ".agentflux/test-results"), { recursive: true });
	let child: ReturnType<typeof spawn> | undefined;
	let stdout = "", stderr = "", watchdog: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
		if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
	};
	try {
		assert.equal(process.env.AGENTFLUX_LIVE_BUILT, "1", "Peer live test requires production dist");
		cpSync(join(sourceRoot, "dist/extension"), join(root, "dist/extension"), { recursive: true });
		mkdirSync(join(root, ".agentflux"), { recursive: true });
		writeFileSync(join(root, "README.md"), "# Message peer fixture\n");
		writeFileSync(join(root, ".agentflux/agentflux.json"), JSON.stringify({ subagent_runtime: config.subagentRuntime, budget: { max_cost_per_task: 0.25, max_iterations: 3,
			max_wall_clock_seconds: null, max_turns_per_task: 20, max_input_tokens_per_task: 150000 }, pricing: { enable_remote_fetch: false } }));
		const models: any = config.fluxModelsJson();
		models.roles.implementer.communication = { enabled: true, actions: ["send", "poll", "ack", "status"], allowedTargets: ["*"], maxMessagesPerRun: 6 };
		writeFileSync(join(root, ".agentflux/models.json"), JSON.stringify(models));
		report.dist = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"].map(name => ({ name, sha256: hash(join(root, "dist/extension", name)) }));
		const prompt = [
			"Execute exactly six tool calls in the following order. Do not use Workflow or Issue. Stop on any tool error; do not retry or diagnose. Every run uses the agent parameter, never name.",
			`1. flux_agent ${JSON.stringify({ action: "create", name: "peer-sender", role: "implementer", scope: "project" })}`,
			`2. flux_agent ${JSON.stringify({ action: "create", name: "peer-receiver", role: "implementer", scope: "project" })}`,
			`3. flux_agent ${JSON.stringify({ action: "run", agent: "peer-receiver", background: false, task: "Do not use tools. Reply exactly RECEIVER_READY." })}`,
			`4. flux_message ${JSON.stringify({ action: "group_create", name: "peer-group", members: ["peer-sender", "peer-receiver"] })}. Use the actual group ID returned by this call below.`,
			"5. flux_agent action=run, agent=peer-sender, background=false. Set task to: Use your own flux_agent_message tool to send exactly three type=handoff messages, action=send: target=peer-receiver content=PEER_DIRECT_PAYLOAD; target=group:<actual ID returned in step 4> content=PEER_GROUP_PAYLOAD; target=broadcast content=PEER_BROADCAST_PAYLOAD. After all three succeed, reply exactly SENDER_SENT. On any error stop and report failure. Main must not send on your behalf.",
			`6. flux_agent ${JSON.stringify({ action: "run", agent: "peer-receiver", background: false, task: "Do not use tools. Verify that the startup inbox actually contains PEER_DIRECT_PAYLOAD, PEER_GROUP_PAYLOAD and PEER_BROADCAST_PAYLOAD from peer-sender, then reply exactly PEER_RECEIVED. If anything is absent, report failure instead of guessing." })}`,
			"Main must not poll or acknowledge messages on behalf of an Agent. Only after all steps succeed, reply exactly PEER_LIVE_OK.",
		].join("\n");
		const args = [getPiCliPath(), "--mode", "json", "-p", "--approve", "--no-extensions",
			"-e", join(root, "dist/extension/host-entry.ts"), "--no-skills", "--tools", "read,flux_agent,flux_message", ...config.cliArgs(config.mainModel), prompt];
		child = spawn(process.execPath, args, { cwd: root, env: config.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		report.pid = child.pid;
		child.stdout!.on("data", b => { stdout += b.toString(); appendFileSync(join(root, "main.stdout.jsonl"), b); });
		child.stderr!.on("data", b => { stderr += b.toString(); appendFileSync(join(root, "main.stderr.log"), b); });
		watchdog = setTimeout(() => { report.testWatchdogExpired = true; stop(); }, 480000);
		report.testWatchdogMs = 480000;
		report.exitCode = await new Promise<number>((done, reject) => { child!.on("error", reject); child!.on("close", code => done(code ?? 1)); });
		clearTimeout(watchdog);
		assert.equal(report.exitCode, 0); assert.ok(!report.testWatchdogExpired);
		assert.ok(hasAssistantFinalMarker(stdout, stderr, "PEER_LIVE_OK"));
		const starts = toolExecutionStarts(stdout, "flux_agent");
		assert.equal(starts.length, 5);
		assert.equal(starts.filter(e => e.args?.action === "create").length, 2);
		assert.equal(starts.filter(e => e.args?.action === "run").length, 3);
		assert.equal(toolExecutionStarts(stdout, "flux_message").length, 1);
		assert.equal(toolExecutionStarts(stdout, "flux_message")[0].args?.action, "group_create");
		assert.equal(toolExecutionStarts(stdout, "read").length, 0);
		assert.ok(!toolExecutionStarts(stdout, "flux_message").some(e => ["send", "group_send", "ack", "poll"].includes(e.args?.action)));
		const runs = json(join(root, ".agentflux/runtime/runs.json")).runs;
		const tasks = json(join(root, ".agentflux/runtime/tasks.json"));
		assert.equal(runs.length, 3); assert.ok(runs.every((r: any) => r.status === "completed" && r.deadlineAt === undefined));
		assert.equal(tasks.tasks.length, 1); assert.equal(tasks.tasks[0].status, "completed");
		assert.ok(tasks.executions.every((e: any) => e.status === "completed" && e.outcome.status === "success"));
		const sender = runs.find((r: any) => r.agent === "peer-sender");
		const receivers = runs.filter((r: any) => r.agent === "peer-receiver");
		const secondReceiver = receivers.sort((a: any,b: any) => a.createdAt.localeCompare(b.createdAt))[1];
		assert.ok(sender && secondReceiver && sender.id !== secondReceiver.id);
		const busRoot = join(root, ".agentflux/shared/messages-v2");
		const envelopes = readdirSync(join(busRoot, "envelopes")).filter(f => f.endsWith(".json")).map(f => json(join(busRoot, "envelopes", f)));
		const matched = ["direct", "group", "broadcast"].map(channel => {
			const e = envelopes.find((e: any) => e.channel.type === channel && e.from === "peer-sender");
			assert.ok(e); assert.equal(e.senderRunId, sender.id); assert.equal(e.correlationId, undefined);
			assert.equal(e.taskId, sender.taskId); assert.equal(e.content, `PEER_${channel.toUpperCase()}_PAYLOAD`);
			const delivery = json(join(busRoot, "deliveries/peer-receiver", `${e.id}.json`));
			assert.equal(delivery.status, "acknowledged"); assert.equal(delivery.attempts, 1);
			assert.ok(Date.parse(delivery.acknowledgedAt) >= Date.parse(secondReceiver.createdAt));
			return { envelope: e, delivery };
		});
		const sessionDir = join(root, ".agentflux/runtime/sessions");
		const senderSession = readdirSync(sessionDir).find(f => f.includes("agent-peer-sender-cap-") && f.endsWith(".jsonl"));
		assert.ok(senderSession);
		const session = readFileSync(join(sessionDir, senderSession), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
		const calls = session.flatMap(e => e.message?.role === "assistant" ? e.message.content ?? [] : []).filter(b => b.type === "toolCall" && b.name === "flux_agent_message" && b.arguments?.action === "send");
		assert.equal(calls.length, 3, "All sends must originate from actual sender Pi tool calls");
		assert.ok(session.some(e => e.type === "thinking_level_change" && e.thinkingLevel === config.thinking));
		report.runs = runs; report.tasks = tasks; report.messages = matched;
		report.senderSession = { path: join(sessionDir, senderSession), sha256: hash(join(sessionDir, senderSession)) };
		report.passed = true;
	} catch (error) { report.error = String(error); process.exitCode = 1; }
	finally {
		if (watchdog) clearTimeout(watchdog);
		stop();
		const until = Date.now() + 10000;
		while (child && child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(50);
		report.cleanup = { workspaceRetained: true, pid: child?.pid, alive: child?.pid ? isProcessAlive(child.pid) : false };
		if (report.cleanup.alive) { report.passed = false; process.exitCode = 1; }
		report.finishedAt = new Date().toISOString();
		writeFileSync(reportPath, JSON.stringify(report, null, 2)); writeFileSync(latestPath, JSON.stringify(report, null, 2));
		config.cleanup();
		console.log(JSON.stringify({ passed: report.passed, reportPath, error: report.error }));
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
