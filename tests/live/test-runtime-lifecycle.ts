// 两后端真实 Provider：独立节点并发、持久 stop 请求、SDK 取消后 Main 继续请求。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";
import { createWorkflowDefinition } from "../../src/workflows/workflow-registry";
import { isProcessAlive } from "../../src/core/fs-lock";
import { observeProcessAsync } from "../../src/core/process-identity";

const sourceRoot = resolve(import.meta.dirname, "../..");
const id = `${Date.now()}-${process.pid}`;
const root = join(sourceRoot, ".agentflux/test-workspaces", `runtime-lifecycle-${id}`);
const fluxDir = join(root, ".agentflux"), runtime = join(fluxDir, "runtime");
const reportPath = join(sourceRoot, ".agentflux/test-results", `runtime-lifecycle-${id}.json`);
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function main() {
 const config = loadLiveConfig("core"); mkdirSync(fluxDir, { recursive: true });
 const report: any = { root, reportPath, backend: config.subagentRuntime, provider: config.providerId, model: config.mainModel, thinking: config.thinking,
  startedAt: new Date().toISOString(), passed: false, pricingAuthoritative: false, processes: [], parallelSamples: [] };
 const owned: Array<{ stop(): void; result: Promise<any>; child: ReturnType<typeof spawn> }> = [];
 const persist = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
 function launch(label: string, tools: string, prompt: string) {
  const child = spawn(process.execPath, [getPiCliPath(), "--mode", "json", "-p", "--approve", "--no-extensions", "-e", join(root, "dist/extension/host-entry.ts"),
   "--no-context-files", "--no-prompt-templates", "--no-skills", "--tools", tools, ...config.cliArgs(config.mainModel), prompt],
   { cwd: root, env: config.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const row: any = { label, pid: child.pid, testWatchdogMs: 300000 }; report.processes.push(row); persist();
  let stdout = "", stderr = "";
  child.stdout!.on("data", b => { stdout += b.toString(); appendFileSync(join(root, `${label}.stdout.jsonl`), b); });
  child.stderr!.on("data", b => { stderr += b.toString(); appendFileSync(join(root, `${label}.stderr.log`), b); });
  const stop = () => { if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
   if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
   else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  };
  const watchdog = setTimeout(() => { row.watchdogExpired = true; stop(); }, row.testWatchdogMs);
  const result = new Promise<any>(done => {
   child.on("error", error => { row.error = String(error); });
   child.on("close", (code, signal) => { clearTimeout(watchdog); Object.assign(row, { exitCode: code, signal }); done({ ...row, stdout, stderr }); });
  });
  const handle = { child, result, stop }; owned.push(handle); return handle;
 }
 async function waitUntil(predicate: () => boolean) {
  const until = Date.now() + 150000;
  while (!predicate()) { if (Date.now() >= until) throw Error("fixture coordination timed out"); await sleep(100); }
 }
 try {
  assert.equal(process.env.AGENTFLUX_LIVE_BUILT, "1");
  cpSync(join(sourceRoot, "dist/extension"), join(root, "dist/extension"), { recursive: true });
  report.dist = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"].map(name => ({ name, sha256: hash(join(root, "dist/extension", name)) }));
  const models: any = config.fluxModelsJson(); models.roles.implementer.tools = ["bash"];
  writeFileSync(join(fluxDir, "models.json"), JSON.stringify(models));
  writeFileSync(join(fluxDir, "agentflux.json"), JSON.stringify({ subagent_runtime: config.subagentRuntime,
   budget: { max_cost_per_task: 0.25, max_parallel_agents: 2, max_iterations: 3, max_turns_per_task: 20, max_input_tokens_per_task: 100000, max_wall_clock_seconds: null },
   pricing: { enable_remote_fetch: false }, quality_gate: { model: config.judgeModel, provider: config.providerId, thinking: config.thinking } }));
  // 两条命令必须同时存活；顺序执行会卡在屏障并由夹具 watchdog 留下失败。
  writeFileSync(join(root, "barrier.cjs"), 'const fs=require("node:fs"),p=require("node:path"),name=process.argv[2];fs.writeFileSync(p.join(__dirname,"barrier-"+name),String(process.pid));const t=setInterval(()=>{if(fs.existsSync(p.join(__dirname,"barrier-a"))&&fs.existsSync(p.join(__dirname,"barrier-b"))){clearInterval(t);console.log("PARALLEL_"+name.toUpperCase()+"_OK");}},50);');
  const definition = createWorkflowDefinition(fluxDir, { name: "runtime-parallel", dag: { description: "independent barrier nodes", nodes: ["a", "b"].map(name => ({
   id: name, title: name, role: "implementer", description: `只调用一次 bash 执行 node barrier.cjs ${name}；不使用其他工具；命令完成后只回复 PARALLEL_${name.toUpperCase()}_OK。`,
   dependsOn: [], files: [], parallelizable: true, acceptanceCriteria: [`必须输出 PARALLEL_${name.toUpperCase()}_OK`] })) } });
  const parallel = launch("parallel", "flux_workflow", `只调用一次 flux_workflow action=reuse workflow=${definition.id}@1 task=执行保存的两个独立屏障节点；不得改 Workflow 或顺序执行。成功后最终只输出 RUNTIME_PARALLEL_OK。`);
  const sample = setInterval(() => { try {
   const runs = json(join(runtime, "runs.json")).runs.filter((r: any) => ["dag-a", "dag-b"].includes(r.agent) && r.status === "running");
   if (runs.length === 2 && report.parallelSamples.length < 20) report.parallelSamples.push(runs.map((r: any) => ({ id: r.id, agent: r.agent, backend: r.backend, pid: r.pid, sdkOwner: r.sdkOwner, sdkSessionId: r.sdkSessionId, provider: r.provider, model: r.model, phase: r.phase, health: r.health })));
  } catch {} }, 100);
  let parallelResult: any; try { parallelResult = await parallel.result; } finally { clearInterval(sample); }
  assert.equal(parallelResult.exitCode, 0); assert.ok(!parallelResult.watchdogExpired);
  assert.ok(hasAssistantFinalMarker(parallelResult.stdout, parallelResult.stderr, "RUNTIME_PARALLEL_OK"));
  assert.equal(toolExecutionStarts(parallelResult.stdout, "flux_workflow").length, 1);
  assert.ok(report.parallelSamples.length > 0, "same-provider node Runs must overlap");
  const parallelRuns = json(join(runtime, "runs.json")).runs;
  assert.ok(parallelRuns.every((r: any) => r.status === "completed" && (r.backend ?? "process") === config.subagentRuntime));
  assert.ok(parallelRuns.every((r: any) => r.costAccounting?.complete === true));
  if (config.subagentRuntime === "sdk") {
   assert.ok(parallelRuns.every((r: any) => r.pid === undefined && r.sdkOwner.host.pid === parallel.child.pid && !!r.sdkSessionId));
   assert.equal(new Set(parallelRuns.map((r: any) => r.sdkSessionId)).size, parallelRuns.length);
  }
  report.parallelRuns = parallelRuns;
  writeFileSync(join(root, "cancel-hold.cjs"), 'const fs=require("node:fs"),p=require("node:path");fs.writeFileSync(p.join(__dirname,"cancel-started"),String(process.pid));const t=setInterval(()=>{if(fs.existsSync(p.join(__dirname,"cancel-release"))){clearInterval(t);console.log("CANCEL_RELEASED");}},50);');
  const holder = launch("holder", "flux_agent", '严格调用 flux_agent create name=runtime-cancel role=implementer scope=project；再 run agent=runtime-cancel background=false task=只调用一次bash执行 node cancel-hold.cjs，不使用其他工具，等待命令结束。Supervisor 会从另一 Main 请求 stop，run 必须取消；取消是预期结果，不重试或修复。收到取消结果后 Main 最终只输出 RUNTIME_CANCEL_MAIN_ALIVE_OK。');
  await waitUntil(() => existsSync(join(root, "cancel-started")));
  const liveRun = json(join(runtime, "runs.json")).runs.find((r: any) => r.agent === "runtime-cancel");
  assert.equal(liveRun.status, "running"); assert.equal(liveRun.backend, config.subagentRuntime);
  const observed = await observeProcessAsync(holder.child.pid!); assert.equal(observed.state, "alive");
  report.cancelHostObservation = observed;
  if (config.subagentRuntime === "sdk") { assert.equal(liveRun.pid, undefined); assert.equal(liveRun.sdkOwner.host.pid, holder.child.pid); }
  report.holdPid = Number(readFileSync(join(root, "cancel-started"), "utf8")); assert.ok(isProcessAlive(report.holdPid));
  const stopper = launch("stopper", "flux_agent", '只实际调用一次 flux_agent action=stop agent=runtime-cancel，正常停止这个 Agent，成功后最终只输出 RUNTIME_STOP_SENT_OK。');
  const stopped = await stopper.result; assert.equal(stopped.exitCode, 0); assert.ok(hasAssistantFinalMarker(stopped.stdout, stopped.stderr, "RUNTIME_STOP_SENT_OK"));
  assert.equal(toolExecutionStarts(stopped.stdout, "flux_agent").filter(e => e.args.action === "stop").length, 1);
  const held = await holder.result; assert.equal(held.exitCode, 0); assert.ok(!held.watchdogExpired);
  assert.ok(hasAssistantFinalMarker(held.stdout, held.stderr, "RUNTIME_CANCEL_MAIN_ALIVE_OK"), "Main must complete a new provider request after child cancellation");
  const terminal = json(join(runtime, "runs.json")).runs.find((r: any) => r.id === liveRun.id);
  assert.equal(terminal.status, "cancelled"); assert.equal(terminal.phase, "terminal"); assert.equal(terminal.pid, undefined);
  assert.equal(terminal.deadlineAt, undefined); assert.equal(terminal.costAccounting?.complete, true);
  const holderExecution = json(join(runtime, "tasks.json")).executions.find((e: any) => e.ownerPid === holder.child.pid);
  assert.equal(holderExecution.status, "cancelled"); assert.equal(holderExecution.outcome.status, "cancelled");
  report.cancelRun = terminal; report.cancelExecution = holderExecution;
  assert.equal(isProcessAlive(report.holdPid), false);
  report.passed = true;
 } catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
 finally {
  writeFileSync(join(root, "cancel-release"), "cleanup");
  for (const handle of owned) { handle.stop(); await handle.result; }
  for (const row of report.processes) { row.alive = row.pid ? isProcessAlive(row.pid) : false; if (row.alive) { report.passed = false; process.exitCode = 1; } }
  if (report.holdPid && isProcessAlive(report.holdPid)) { report.passed = false; report.holdStillAlive = true; process.exitCode = 1; }
  report.tasks = existsSync(join(runtime, "tasks.json")) ? json(join(runtime, "tasks.json")) : undefined;
  report.runs = existsSync(join(runtime, "runs.json")) ? json(join(runtime, "runs.json")) : undefined;
  report.finishedAt = new Date().toISOString(); persist(); config.cleanup(); console.log(JSON.stringify({ passed: report.passed, reportPath, error: report.error }));
 }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
