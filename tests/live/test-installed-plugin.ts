// 使用用户全局已安装 packages 自动发现；不显式 -e、不禁用扩展，不修改用户其他设置。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";
import { isProcessAlive } from "../../src/core/fs-lock";

const sourceRoot = resolve(import.meta.dirname, "../.."), id = `${Date.now()}-${process.pid}`;
async function main() {
 const config = loadLiveConfig("core"), root = join(sourceRoot, ".agentflux/test-workspaces", `installed-${id}`), fluxDir = join(root, ".agentflux");
 mkdirSync(fluxDir, { recursive: true });
 writeFileSync(join(fluxDir, "models.json"), JSON.stringify(config.fluxModelsJson()));
 writeFileSync(join(fluxDir, "agentflux.json"), JSON.stringify({ subagent_runtime: config.subagentRuntime,
  budget: { max_cost_per_task: 0.15, max_iterations: 3, max_turns_per_task: 12, max_input_tokens_per_task: 100000, max_wall_clock_seconds: null }, pricing: { enable_remote_fetch: false } }));
 const report: any = { root, backend: config.subagentRuntime, provider: config.providerId, model: config.mainModel, thinking: config.thinking, passed: false,
  packageDiscovery: "User global settings/packages, no explicit extension path", startedAt: new Date().toISOString() };
 let stdout = "", stderr = "";
 const child = spawn(process.execPath, [getPiCliPath(), "--mode", "json", "-p", "--approve", "--no-context-files", "--no-prompt-templates", "--no-skills", "--tools", "flux_agent", ...config.cliArgs(config.mainModel),
  '严格只调用 flux_agent create name=installed-runtime-check role=tester scope=project；然后 run agent=installed-runtime-check background=false task=不使用工具，只回复 INSTALLED_CHILD_OK。全部成功后 Main 最终只输出 INSTALLED_PLUGIN_OK；失败直接报告，不重试。'],
  { cwd: root, env: config.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
 report.mainPid = child.pid;
 child.stdout.on("data", b => { stdout += b.toString(); appendFileSync(join(root, "main.stdout.jsonl"), b); });
 child.stderr.on("data", b => { stderr += b.toString(); appendFileSync(join(root, "main.stderr.log"), b); });
 const watchdog = setTimeout(() => { report.watchdogExpired = true;
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL");
 }, 240000);
 try {
  report.exitCode = await new Promise<number>((done, reject) => { child.on("error", reject); child.on("close", code => done(code ?? 1)); });
  assert.equal(report.exitCode, 0); assert.ok(!report.watchdogExpired); assert.ok(hasAssistantFinalMarker(stdout, stderr, "INSTALLED_PLUGIN_OK"));
  assert.deepEqual(toolExecutionStarts(stdout, "flux_agent").map(e => e.args.action), ["create", "run"]);
  report.runs = JSON.parse(readFileSync(join(fluxDir, "runtime/runs.json"), "utf8")).runs;
  assert.equal(report.runs.length, 1);
  const run = report.runs[0]; assert.equal(run.status, "completed"); assert.equal(run.backend, config.subagentRuntime); assert.equal(run.costAccounting.complete, true);
  assert.equal(run.invocation.host.version, "1.0.0"); assert.equal(run.invocation.sameVersion, true);
  if (config.subagentRuntime === "sdk") { assert.equal(run.pid, undefined); assert.equal(run.sdkOwner.host.pid, child.pid); assert.ok(run.sdkSessionId); }
  report.tasks = JSON.parse(readFileSync(join(fluxDir, "runtime/tasks.json"), "utf8"));
  assert.ok(report.tasks.tasks.every((t: any) => t.status === "completed")); assert.ok(report.tasks.executions.every((e: any) => e.costAccounting.complete === true));
  assert.equal(isProcessAlive(child.pid!), false); report.passed = true;
 } catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
 finally { clearTimeout(watchdog); report.finishedAt = new Date().toISOString(); report.mainAlive = child.pid ? isProcessAlive(child.pid) : false;
  const path = join(sourceRoot, ".agentflux/test-results", `installed-plugin-${id}.json`); writeFileSync(path, JSON.stringify(report, null, 2));
  config.cleanup(); console.log(JSON.stringify({ passed: report.passed, reportPath: path, error: report.error }));
 }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
