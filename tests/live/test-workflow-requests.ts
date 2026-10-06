// R03：父正文、Workflow 正文、复用输入和结构变更分别冻结；所有模型调用使用 production dist。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, toolExecutionStarts } from "../helpers/pi-json-output";
import { isProcessAlive } from "../../src/core/fs-lock";

const sourceRoot = resolve(import.meta.dirname, "../..");
const iteration = `${Date.now()}-${process.pid}`;
const root = join(sourceRoot, ".agentflux/test-workspaces", `workflow-requests-${iteration}`);
const results = join(sourceRoot, ".agentflux/test-results");
const reportPath = join(results, `workflow-requests-${iteration}.json`);
const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function main() {
	const config = loadLiveConfig("core");
	mkdirSync(join(root, ".agentflux"), { recursive: true }); mkdirSync(results, { recursive: true });
	const report: any = { startedAt: new Date().toISOString(), root, reportPath, passed: false, phases: [],
		provider: config.providerId, model: config.mainModel, thinking: config.thinking, backend: config.subagentRuntime, pricingAuthoritative: false };
	const runtime = join(root, ".agentflux/runtime");
	const definitions = () => readJson(join(runtime, "workflows.json")).definitions;
	const terminalTasks = new Map<string, string>();
	async function phase(label: string, action: string, body: string, expectedOutputs: string[], selector?: string) {
		const parent = `PARENT_${label}: broad parent context, not the Workflow invocation input`;
		const marker = `WORKFLOW_${label}_OK`;
		const request = { action, ...(selector ? { workflow: selector } : { name: "request-proof" }), task: body };
		const prompt = `严格顺序实际调用两个工具：先 flux_task action=new，task 参数逐字等于 ${JSON.stringify(parent)}；再调用 flux_workflow，参数必须逐字使用 ${JSON.stringify(request)}。不要再调用其他控制工具，不得改写 task 字符串。等待 Workflow 成功后，最终回复只能是 ${marker}，禁止解释或前缀。`;
		const child = spawn(process.execPath, [getPiCliPath(),
			"--mode", "json", "-p", "--approve", "--no-extensions", "-e", join(root, "dist/extension/host-entry.ts"),
			"--no-skills", "--tools", "flux_task,flux_workflow", ...config.cliArgs(config.mainModel), prompt],
			{ cwd: root, env: config.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		const row: any = { label, pid: child.pid, parent, request, marker, testWatchdogMs: 600000, observedRunPids: [] };
		report.phases.push(row); let stdout = "", stderr = ""; const pids = new Set<number>();
		child.stdout.on("data", b => { stdout += b.toString(); appendFileSync(join(root, `${label}.stdout.jsonl`), b); });
		child.stderr.on("data", b => { stderr += b.toString(); appendFileSync(join(root, `${label}.stderr.log`), b); });
		const stop = () => {
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
			if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
		};
		const monitor = setInterval(() => { try { for (const run of readJson(join(runtime, "runs.json")).runs) if (run.pid) pids.add(run.pid); } catch {} }, 200);
		const watchdog = setTimeout(() => { row.watchdogExpired = true; stop(); }, row.testWatchdogMs);
		try {
			row.exitCode = await new Promise<number>((done, reject) => { child.on("error", reject); child.on("close", code => done(code ?? 1)); });
			assert.equal(row.exitCode, 0); assert.ok(!row.watchdogExpired); assert.ok(hasAssistantFinalMarker(stdout, stderr, marker));
			const workflowCalls = toolExecutionStarts(stdout, "flux_workflow");
			assert.equal(workflowCalls.length, 1); assert.equal(workflowCalls[0].args.task, body); assert.equal(workflowCalls[0].args.action, action);
			assert.ok(toolExecutionStarts(stdout, "flux_task").some(e => e.args.action === "new" && e.args.task === parent));
			const tasks = readJson(join(runtime, "tasks.json"));
			for (const [id, before] of terminalTasks) assert.equal(JSON.stringify(tasks.tasks.find((t: any) => t.id === id)), before, "不能改写先前终态 Task");
			const task = tasks.tasks.find((t: any) => t.task === parent);
			assert.ok(task); assert.equal(task.workflowRequest.task, body); assert.equal(task.workflowRequest.action, action);
			assert.equal(task.status, "completed"); assert.equal(task.deadlineAt, undefined);
			const execution = tasks.executions.find((e: any) => e.id === task.executionId);
			assert.equal(execution.status, "completed"); assert.equal(execution.outcome.status, "success");
			const runRoot = join(runtime, "runs", task.executionId);
			const dag = readJson(join(runRoot, "dag.json")), checkpoint = readJson(join(runRoot, "checkpoint.json"));
			assert.equal(dag.invocationTask, body); assert.equal(checkpoint.status, "passed");
			assert.equal(checkpoint.completed.length, expectedOutputs.length);
			const actualOutputs = checkpoint.taskResults.map((entry: any) => entry[1].subagentResult.output.trim());
			assert.deepEqual(actualOutputs.sort(), [...expectedOutputs].sort());
			assert.ok(checkpoint.taskResults.every((entry: any) => entry[1].passed && entry[1].gateResult?.status === "passed"));
			const runs = readJson(join(runtime, "runs.json")).runs.filter((r: any) => r.taskId === task.id);
			assert.ok(runs.every((r: any) => r.status === "completed"));
			assert.ok(runs.every((r: any) => r.backend === config.subagentRuntime), "all planner/node/judge Runs must use the configured backend");
			assert.ok(runs.every((r: any) => r.costAccounting?.complete === true));
			assert.equal(runs.filter((r: any) => r.agent === "dag-planner").length, action === "reuse" ? 0 : 1);
			terminalTasks.set(task.id, JSON.stringify(task));
			Object.assign(row, { task, execution, dag, checkpoint, runs, passed: true });
			return task;
		} finally {
			clearTimeout(watchdog); clearInterval(monitor); stop();
			const until = Date.now() + 10000;
			while (child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(50);
			row.observedRunPids = [...pids].map(pid => ({ pid, alive: isProcessAlive(pid) }));
			row.mainAlive = child.pid ? isProcessAlive(child.pid) : false;
			assert.equal(row.mainAlive, false); assert.ok(row.observedRunPids.every((p: any) => !p.alive));
		}
	}
	try {
		assert.equal(process.env.AGENTFLUX_LIVE_BUILT, "1");
		cpSync(join(sourceRoot, "dist/extension"), join(root, "dist/extension"), { recursive: true });
		report.dist = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"].map(name => ({ name, sha256: hash(join(root, "dist/extension", name)) }));
		writeFileSync(join(root, "README.md"), "# Workflow request fixture\n");
		writeFileSync(join(root, "README-A.md"), "INPUT_A_OK\n"); writeFileSync(join(root, "README-B.md"), "INPUT_B_OK\n");
		writeFileSync(join(root, ".agentflux/models.json"), JSON.stringify(config.fluxModelsJson()));
		writeFileSync(join(root, ".agentflux/agentflux.json"), JSON.stringify({ subagent_runtime: config.subagentRuntime, budget: { max_cost_per_task: 0.5, max_iterations: 3,
			max_turns_per_task: 24, max_input_tokens_per_task: 150000, max_wall_clock_seconds: null }, pricing: { enable_remote_fetch: false },
			quality_gate: { model: config.judgeModel, provider: config.providerId, thinking: config.thinking } }));
		const description = "根据 Workflow invocation input 中指定的文件，使用 read 读取其第一行，只输出该行原文；这是一个通用固定读取步骤，文件名由本次输入提供。";
		const seedBody = `REQUEST_SEED：创建恰好一个 implementer 读取节点。description 必须逐字为：${description} 文件列表 README-A.md、README-B.md；唯一 acceptanceCriteria 为输出是 INPUT_A_OK 或 INPUT_B_OK。本次输入指定 README-A.md，不要把本次文件名固化进通用节点 description。`;
		const seedTask = await phase("SEED", "run", seedBody, ["INPUT_A_OK"]);
		const first = definitions().find((d: any) => d.id === seedTask.resource.id);
		assert.equal(first.version, 1); assert.equal(first.dag.invocationTask, undefined);
		const original = JSON.stringify(first); const registryPath = join(runtime, "workflows.json"); const initialHash = hash(registryPath);
		const reused = await phase("REUSE", "reuse", "REQUEST_REUSE_B：本次输入文件为 README-B.md，执行保存的通用读取节点，不改变 DAG 结构。", ["INPUT_B_OK"], `${first.id}@1`);
		assert.equal(reused.resource.version, 1); assert.equal(hash(registryPath), initialHash);
		const changed = await phase("MODIFY", "modify", "REQUEST_MODIFY_C：保持原通用读取节点，新增且仅新增一个 reviewer 节点依赖原节点；reviewer 从依赖输出确认 INPUT_B_OK，且只输出 REVIEW_INPUT_B_OK，以输出包含 REVIEW_INPUT_B_OK 为唯一验收标准。本次输入文件为 README-B.md。禁止让节点改注册表或执行控制工具。", ["INPUT_B_OK", "REVIEW_INPUT_B_OK"], first.id);
		assert.equal(changed.resource.version, 2);
		const afterModify = definitions(); assert.equal(afterModify.length, 2);
		assert.equal(JSON.stringify(afterModify.find((d: any) => d.version === 1)), original);
		assert.ok(afterModify.every((d: any) => d.dag.invocationTask === undefined));
		const revisedHash = hash(registryPath);
		const oldVersion = await phase("OLD_VERSION", "reuse", "REQUEST_OLD_VERSION_D：本次输入 README-A.md，只运行所选旧版通用读取流程。", ["INPUT_A_OK"], `${first.id}@1`);
		assert.equal(oldVersion.resource.version, 1); assert.equal(hash(registryPath), revisedHash);
		report.definitions = definitions(); report.passed = true;
	} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
	finally {
		report.finishedAt = new Date().toISOString(); report.workspaceRetained = true;
		writeFileSync(reportPath, JSON.stringify(report, null, 2)); writeFileSync(join(results, "workflow-requests-latest.json"), JSON.stringify(report, null, 2));
		config.cleanup(); console.log(JSON.stringify({ passed: report.passed, error: report.error, reportPath }));
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
