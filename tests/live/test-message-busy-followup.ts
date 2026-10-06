// R13：真实 bash 长任务期间已接受的 followUp 跨过 60s 握手阈值，仍只注入一次并在消费后 ACK。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";
import { isProcessAlive } from "../../src/core/fs-lock";
import { MessageBus } from "../../src/core/message-bus";
const sourceRoot = resolve(import.meta.dirname, "../..");
const id = `${Date.now()}-${process.pid}`;
const root = join(sourceRoot, ".agentflux/test-workspaces", `busy-followup-${id}`);
const results = join(sourceRoot, ".agentflux/test-results");
const json = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function main() {
	const config = loadLiveConfig("core"); mkdirSync(join(root, ".agentflux"), { recursive: true }); mkdirSync(results, { recursive: true });
	const report: any = { root, startedAt: new Date().toISOString(), passed: false, pricingAuthoritative: false,
		provider: config.providerId, model: config.mainModel, thinking: config.thinking, processes: [] };
	const owned: Array<{ child: ReturnType<typeof spawn>; stop(): void; result: Promise<any> }> = [];
	function launch(label: string, prompt: string) {
		const child = spawn(process.execPath, [getPiCliPath(), "--mode", "json", "-p", "--approve",
			"--no-extensions", "-e", join(root, "dist/extension/host-entry.ts"), "--no-skills", "--tools", "flux_agent,flux_message", ...config.cliArgs(config.mainModel), prompt],
			{ cwd: root, env: config.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		const row: any = { label, pid: child.pid, testWatchdogMs: 360000 }; report.processes.push(row);
		let stdout = "", stderr = "";
		child.stdout.on("data", b => { stdout += b.toString(); appendFileSync(join(root, `${label}.stdout.jsonl`), b); });
		child.stderr.on("data", b => { stderr += b.toString(); appendFileSync(join(root, `${label}.stderr.log`), b); });
		const stop = () => { if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
			if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
		};
		const timer = setTimeout(() => { row.watchdogExpired = true; stop(); }, row.testWatchdogMs);
		const result = new Promise<any>(done => { child.on("error", error => { row.error = String(error); }); child.on("close", (code, signal) => {
			clearTimeout(timer); Object.assign(row, { exitCode: code, signal }); done({ stdout, stderr, ...row });
		}); });
		const handle = { child, result, stop }; owned.push(handle); return handle;
	}
	async function waitUntil(check: () => boolean, timeoutMs: number) {
		const until = Date.now() + timeoutMs;
		while (!check()) { if (Date.now() >= until) throw Error("fixture coordination timed out"); await sleep(200); }
	}
	try {
		assert.equal(process.env.AGENTFLUX_LIVE_BUILT, "1"); cpSync(join(sourceRoot, "dist/extension"), join(root, "dist/extension"), { recursive: true });
		report.dist = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"].map(name => ({ name, sha256: hash(join(root, "dist/extension", name)) }));
		writeFileSync(join(root, "README.md"), "# Busy followUp fixture\n");
		writeFileSync(join(root, "wait-release.cjs"), 'const fs=require("node:fs"),p=require("node:path");fs.writeFileSync(p.join(__dirname,"hold-started"),String(process.pid));const t=setInterval(()=>{if(fs.existsSync(p.join(__dirname,"hold-release"))){clearInterval(t);console.log("WAIT_FINISHED");}},50);');
		const models: any = config.fluxModelsJson(); models.roles.implementer.tools = ["bash"];
		writeFileSync(join(root, ".agentflux/models.json"), JSON.stringify(models));
		writeFileSync(join(root, ".agentflux/agentflux.json"), JSON.stringify({ subagent_runtime: config.subagentRuntime, budget: { max_cost_per_task: 0.25, max_iterations: 3,
			max_turns_per_task: 16, max_input_tokens_per_task: 100000, max_wall_clock_seconds: null }, pricing: { enable_remote_fetch: false } }));
		const holder = launch("holder", "严格顺序调用 flux_agent：create name=busy-peer role=implementer scope=project；run agent=busy-peer background=false task=只调用一次 bash 执行 node wait-release.cjs，不使用其他工具，命令完成后只回复 WAIT_FINISHED，然后正常处理排队的用户消息。子代理最终应处理外部 followUp 并回复 FOLLOWUP_ACK_OK；run 成功后 Main 最终只输出 BUSY_FOLLOWUP_OK，禁止解释或重试。");
		await waitUntil(() => existsSync(join(root, "hold-started")), 150000);
		report.waiterPid = Number(readFileSync(join(root, "hold-started"), "utf8")); assert.ok(isProcessAlive(report.waiterPid));
		const sender = launch("sender", `仅实际调用一次 flux_message action=send sender=main target=busy-peer content=${id}:请只回复 FOLLOWUP_ACK_OK。必须使用 normal 优先级，禁止 steer。成功后最终仅输出 FOLLOWUP_SENT_OK。`);
		const sent = await sender.result;
		assert.equal(sent.exitCode, 0); assert.ok(hasAssistantFinalMarker(sent.stdout, sent.stderr, "FOLLOWUP_SENT_OK"));
		assert.equal(toolExecutionStarts(sent.stdout, "flux_message").filter(e => e.args.action === "send").length, 1);
		const fluxDir = join(root, ".agentflux"), bus = new MessageBus(fluxDir);
		const envelope = bus.listEnvelopes().find(m => m.recipients.includes("busy-peer") && m.content.includes(id));
		assert.ok(envelope); assert.equal(envelope.priority, "normal"); assert.equal(envelope.type, "message");
		await waitUntil(() => bus.getDelivery(envelope.id, "busy-peer")?.status === "delivered", 30000);
		report.firstDelivery = bus.getDelivery(envelope.id, "busy-peer"); report.holdStartedAt = new Date().toISOString();
		await sleep(70000); // 测试自身有意等待，超过产品握手阈值但不设置执行 deadline。
		report.beforeRelease = bus.getDelivery(envelope.id, "busy-peer"); report.waitedMs = Date.now() - Date.parse(report.holdStartedAt);
		assert.equal(report.beforeRelease.status, "delivered"); assert.equal(report.beforeRelease.attempts, 1);
		const active = json(join(fluxDir, "runtime/runs.json")).runs.find((r: any) => r.agent === "busy-peer");
		assert.equal(active.status, "running"); assert.equal(active.deadlineAt, undefined);
		assert.equal(active.backend ?? "process", config.subagentRuntime);
		if (config.subagentRuntime === "sdk") {
			assert.equal(active.pid, undefined); assert.equal(active.sdkOwner?.host.pid, holder.child.pid); assert.ok(active.sdkSessionId);
		}
		report.backend = config.subagentRuntime; report.sdkOwner = active.sdkOwner; report.sdkSessionId = active.sdkSessionId;
		report.agentPid = active.pid; report.runtimeHostPid = config.subagentRuntime === "sdk" ? active.sdkOwner.host.pid : active.pid;
		writeFileSync(join(root, "hold-release"), "release");
		const held = await holder.result;
		assert.equal(held.exitCode, 0); assert.ok(hasAssistantFinalMarker(held.stdout, held.stderr, "BUSY_FOLLOWUP_OK"));
		report.delivery = bus.getDelivery(envelope.id, "busy-peer"); assert.equal(report.delivery.status, "acknowledged"); assert.equal(report.delivery.attempts, 1);
		const sessionDir = join(fluxDir, "runtime/sessions");
		const sessions = readdirSync(sessionDir).filter(p => p.endsWith(".jsonl")).map(p => join(sessionDir, p));
		const injected = sessions.flatMap(p => readFileSync(p, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)))
			.filter(e => e.message?.role === "user" && JSON.stringify(e.message.content).includes(envelope.id));
		assert.equal(injected.length, 1, "长任务中的 accepted followUp 只能注入一次");
		report.sessionArtifacts = sessions.map(p => ({ path: p, sha256: hash(p) }));
		report.tasks = json(join(fluxDir, "runtime/tasks.json")); report.runs = json(join(fluxDir, "runtime/runs.json"));
		assert.ok(report.tasks.tasks.every((t: any) => t.status === "completed")); assert.ok(report.runs.runs.every((r: any) => r.status === "completed"));
		assert.equal(isProcessAlive(report.runtimeHostPid), false); assert.equal(isProcessAlive(report.waiterPid), false);
		report.passed = true;
	} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
	finally {
		writeFileSync(join(root, "hold-release"), "cleanup");
		for (const handle of owned) { handle.stop(); await handle.result; }
		for (const row of report.processes) { row.alive = row.pid ? isProcessAlive(row.pid) : false; if (row.alive) { report.passed = false; process.exitCode = 1; } }
		report.finishedAt = new Date().toISOString(); report.workspaceRetained = true;
		const path = join(results, `busy-followup-${id}.json`); writeFileSync(path, JSON.stringify(report, null, 2)); writeFileSync(join(results, "busy-followup-latest.json"), JSON.stringify(report, null, 2));
		config.cleanup(); console.log(JSON.stringify({ passed: report.passed, reportPath: path, error: report.error }));
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
