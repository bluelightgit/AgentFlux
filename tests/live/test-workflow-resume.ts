// R03/R08：真实业务失败后跨 Pi 恢复；不伪造 checkpoint，不声称覆盖 hard-kill。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";
import { isProcessAlive } from "../../src/core/fs-lock";
import { createWorkflowDefinition } from "../../src/workflows/workflow-registry";

const sourceRoot = resolve(import.meta.dirname, "../..");
const iteration = `${Date.now()}-${process.pid}`;
const root = join(sourceRoot, ".agentflux/test-workspaces", `workflow-resume-${iteration}`);
const fluxDir = join(root, ".agentflux"), runtime = join(fluxDir, "runtime");
const results = join(sourceRoot, ".agentflux/test-results");
const reportPath = join(results, `workflow-resume-${iteration}.json`);
const json = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function main() {
	const config = loadLiveConfig("core");
	mkdirSync(fluxDir, { recursive: true }); mkdirSync(results, { recursive: true });
	const report: any = { root, reportPath, startedAt: new Date().toISOString(), passed: false, phases: [],
		provider: config.providerId, model: config.mainModel, thinking: config.thinking, pricingAuthoritative: false, hardKillTested: false };
	const persist = () => { writeFileSync(reportPath, JSON.stringify(report, null, 2)); writeFileSync(join(results, "workflow-resume-latest.json"), JSON.stringify(report, null, 2)); };
	async function phase(label: string, taskRequest: any, workflowRequest: any, expectedStatus: string) {
		const marker = `RESUME_${label}_OK`;
		const prompt = `严格顺序实际调用两次工具：flux_task 参数 ${JSON.stringify(taskRequest)}；随后 flux_workflow 参数 ${JSON.stringify(workflowRequest)}。第一步必须成功才能进行第二步；第一步失败就停止，禁止转为新 Workflow。不得改写参数、不得其他调用或修复文件。${expectedStatus === "completed" ? "等待 Workflow 成功" : "第二步必须失败，这是预期负例，不重试；Supervisor 会核对真正失败事实"}后最终只输出 ${marker}。`;
		const child = spawn(process.execPath, [getPiCliPath(),
			"--mode", "json", "-p", "--approve", "--no-extensions", "-e", join(root, "dist/extension/host-entry.ts"), "--no-skills",
			"--tools", "flux_task,flux_workflow", "--no-session", "--session-id", `resume-${iteration}`, ...config.cliArgs(config.mainModel), prompt],
			{ cwd: root, env: config.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		const row: any = { label, pid: child.pid, taskRequest, workflowRequest, marker, expectedStatus, testWatchdogMs: 480000 };
		report.phases.push(row); persist();
		let stdout = "", stderr = ""; const pids = new Set<number>();
		for (const suffix of ["stdout.jsonl", "stderr.log"]) writeFileSync(join(root, `${label}.${suffix}`), "");
		child.stdout.on("data", b => { stdout += b.toString(); appendFileSync(join(root, `${label}.stdout.jsonl`), b); });
		child.stderr.on("data", b => { stderr += b.toString(); appendFileSync(join(root, `${label}.stderr.log`), b); });
		const stop = () => {
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
			if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
		};
		const monitor = setInterval(() => { try { for (const r of json(join(runtime, "runs.json")).runs) if (r.pid) pids.add(r.pid); } catch {} }, 200);
		const watchdog = setTimeout(() => { row.watchdogExpired = true; stop(); }, row.testWatchdogMs);
		try {
			row.exitCode = await new Promise<number>((done, reject) => { child.on("error", reject); child.on("close", code => done(code ?? 1)); });
			assert.equal(row.exitCode, 0); assert.ok(!row.watchdogExpired); assert.ok(hasAssistantFinalMarker(stdout, stderr, marker));
			assert.deepEqual(toolExecutionStarts(stdout, "flux_task").map(e => e.args), [taskRequest]);
			assert.deepEqual(toolExecutionStarts(stdout, "flux_workflow").map(e => e.args), [workflowRequest]);
			const receipts = stdout.trim().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).filter(e => e.type === "tool_execution_end");
			assert.equal(receipts.find(e => e.toolName === "flux_task")?.isError, false, "Task preparation must actually succeed");
			assert.equal(receipts.find(e => e.toolName === "flux_workflow")?.isError, expectedStatus !== "completed", "failed Workflow DTO must be a tool error; recovered Workflow must succeed");
			const store = json(join(runtime, "tasks.json"));
			const execution = store.executions.find((e: any) => e.ownerPid === child.pid);
			assert.ok(execution); const task = store.tasks.find((t: any) => t.id === execution.taskId);
			assert.equal(task.status, expectedStatus); assert.equal(execution.status, expectedStatus);
			assert.equal(execution.outcome.status, expectedStatus === "completed" ? "success" : "failure");
			assert.equal(execution.deadlineAt, undefined); assert.equal(execution.budget.maxWallClockMs, undefined);
			const runs = existsSync(join(runtime, "runs.json")) ? json(join(runtime, "runs.json")).runs.filter((r: any) => r.taskId === task.id) : [];
			Object.assign(row, { task, execution, runs }); return row;
		} finally {
			clearTimeout(watchdog); clearInterval(monitor); stop();
			const until = Date.now() + 10000;
			while (child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(50);
			row.mainAlive = child.pid ? isProcessAlive(child.pid) : false;
			row.observedRunPids = [...pids].map(pid => ({ pid, alive: isProcessAlive(pid) }));
			row.outputArtifacts = ["stdout.jsonl", "stderr.log"].map(suffix => ({ path: join(root, `${label}.${suffix}`), sha256: hash(join(root, `${label}.${suffix}`)) }));
			for (const name of ["tasks", "runs"]) if (existsSync(join(runtime, `${name}.json`))) row[`${name}Snapshot`] = json(join(runtime, `${name}.json`));
			persist(); assert.equal(row.mainAlive, false); assert.ok(row.observedRunPids.every((p: any) => !p.alive));
		}
	}
	try {
		assert.equal(process.env.AGENTFLUX_LIVE_BUILT, "1");
		cpSync(join(sourceRoot, "dist/extension"), join(root, "dist/extension"), { recursive: true });
		report.dist = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"].map(name => ({ name, sha256: hash(join(root, "dist/extension", name)) }));
		writeFileSync(join(fluxDir, "models.json"), JSON.stringify(config.fluxModelsJson()));
		writeFileSync(join(fluxDir, "agentflux.json"), JSON.stringify({ subagent_runtime: config.subagentRuntime, budget: { max_cost_per_task: 0.25, max_iterations: 3, max_turns_per_task: 24,
			max_input_tokens_per_task: 100000, max_parallel_agents: 2, max_wall_clock_seconds: null }, pricing: { enable_remote_fetch: false },
			quality_gate: { model: config.judgeModel, provider: config.providerId, thinking: config.thinking } }));
		writeFileSync(join(root, "README.md"), "# Resume fixture\n"); writeFileSync(join(root, "condition.txt"), "BLOCKED\n");
		const input = `原始执行输入 B ${iteration}：严格按保存节点执行，不额外工作。`;
		const parent = `原始父任务 A ${iteration}：执行并核对阶段结果。`;
		const firstOutput = `FIRST_PROVEN_${iteration}`;
		const definition = createWorkflowDefinition(fluxDir, { name: "resume-proof", dag: { description: "two fixed nodes", nodes: [
			{ id: "first", title: "first", role: "implementer", description: `不使用工具，只输出 ${firstOutput}。`, dependsOn: [], files: [], parallelizable: false, acceptanceCriteria: [`输出必须精确等于 ${firstOutput}`] },
			{ id: "second", title: "second", role: "implementer", description: "只使用 read 读取 condition.txt，只输出其中第一行原文；禁止更改文件或解释。", dependsOn: ["first"], files: ["condition.txt"], parallelizable: false, acceptanceCriteria: ["输出必须精确等于 RESUME_SECOND_OK；BLOCKED 必须判定不通过"] },
		] } });
		const seed = await phase("SEED", { action: "new", task: parent }, { action: "reuse", workflow: `${definition.id}@1`, task: input }, "failed");
		const seedDir = join(runtime, "runs", seed.task.executionId);
		const checkpoint = json(join(seedDir, "checkpoint.json"));
		assert.deepEqual(checkpoint.completed, ["first"]); assert.ok(checkpoint.failed.includes("second"));
		assert.ok(checkpoint.totalCost > 0); assert.equal(seed.task.workflowRequest.task, input);
		assert.equal(seed.runs.filter((r: any) => r.agent === "dag-planner").length, 0);
		const sourceFiles = [join(seedDir, "dag.json"), join(seedDir, "checkpoint.json"), ...Object.values(checkpoint.artifactPaths) as string[]];
		const sourceHashes = sourceFiles.map(path => ({ path, sha256: hash(path) }));
		const definitionHash = hash(join(runtime, "workflows.json"));
		const mismatch = await phase("MISMATCH", { action: "resume", selector: seed.task.id }, { action: "run", task: "冲突的新执行 C" }, "failed");
		assert.equal(mismatch.runs.length, 0); assert.equal(existsSync(join(runtime, "runs", mismatch.task.executionId)), false);
		assert.match(mismatch.execution.outcome.error, /cannot replace the saved invocation input/);
		writeFileSync(join(root, "condition.txt"), "RESUME_SECOND_OK\n");
		const resumed = await phase("RECOVERED", { action: "resume", selector: seed.task.id }, { action: "run" }, "completed");
		assert.equal(resumed.task.task, parent); assert.equal(resumed.task.workflowRequest.task, input);
		assert.equal(resumed.task.parentTaskId, seed.task.id); assert.equal(resumed.execution.parentExecutionId, seed.task.executionId);
		const recoveredDir = join(runtime, "runs", resumed.task.executionId), recovered = json(join(recoveredDir, "checkpoint.json"));
		assert.equal(json(join(recoveredDir, "dag.json")).invocationTask, input);
		assert.equal(recovered.status, "passed"); assert.deepEqual([...recovered.completed].sort(), ["first", "second"]);
		assert.ok(resumed.runs.length >= 2 && resumed.runs.every((r: any) => r.status === "completed" && r.agent !== "dag-first" && r.agent !== "dag-planner"));
		assert.equal(recovered.inheritedCostUsd, checkpoint.totalCost); assert.ok(recovered.attemptCostUsd > 0);
		assert.ok(Math.abs(recovered.totalCost - recovered.inheritedCostUsd - recovered.attemptCostUsd) < 1e-9);
		assert.ok(Math.abs(resumed.execution.costAccounting.invocationCostUsd - recovered.attemptCostUsd) < 1e-9);
		assert.ok(recovered.artifactPaths.first.includes(resumed.task.executionId));
		assert.equal(hash(recovered.artifactPaths.first), hash(checkpoint.artifactPaths.first));
		const final = json(join(runtime, "tasks.json"));
		assert.deepEqual(final.tasks.find((t: any) => t.id === seed.task.id), seed.task);
		assert.deepEqual(final.executions.find((e: any) => e.id === seed.task.executionId), seed.execution);
		for (const file of sourceHashes) assert.equal(hash(file.path), file.sha256);
		assert.equal(hash(join(runtime, "workflows.json")), definitionHash);
		report.sourceHashes = sourceHashes; report.seedCheckpoint = checkpoint; report.recoveredCheckpoint = recovered;
		report.passed = true;
	} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
	finally { report.finishedAt = new Date().toISOString(); report.workspaceRetained = true; persist(); config.cleanup(); console.log(JSON.stringify({ passed: report.passed, error: report.error, reportPath })); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
