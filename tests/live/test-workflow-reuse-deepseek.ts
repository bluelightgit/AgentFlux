import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadLiveConfig, type LiveConfig } from "./live-config";

const sourceRoot = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "agentflux-live-workflow-reuse-"));
const sessionDir = join(root, "sessions");
const piCli = resolve(sourceRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const config = loadLiveConfig();

function run(prompt: string, allowPostExecutionTimeout = false): { output: string; timedOutAfterExecution: boolean } {
	const result = spawnSync(process.execPath, [
		piCli,
		"--mode", "json", "-p", "--approve", "--no-extensions",
		"-e", join(root, "src", "entry.ts"),
		"--no-skills",
		"--tools", "read,grep,find,ls,flux_task,flux_workflow",
		"--session-dir", sessionDir,
		"--session-id", "workflow-reuse-live",
		...config.cliArgs(config.modelPro),
		prompt,
	], {
		cwd: root,
		encoding: "utf-8",
		timeout: 300_000,
		maxBuffer: 32 * 1024 * 1024,
		windowsHide: true,
		env: config.env,
	});
	const output = `${result.stdout}\n${result.stderr}`;
	const timedOut = result.status === null && (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
	const dagFinished = output.includes("[DAG Execution: PASSED]")
		|| (output.includes("[flux dag]") && output.includes("✅ passed") && !output.includes("❌ failed"));
	if (result.status !== 0 && !(allowPostExecutionTimeout && timedOut && dagFinished)) {
		throw new Error(`workflow reuse live failed (status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? "none"})\n${output.slice(-6000)}`);
	}
	return { output, timedOutAfterExecution: timedOut };
}

try {
	cpSync(join(sourceRoot, "src"), join(root, "src"), { recursive: true });
	mkdirSync(join(root, ".agentflux"), { recursive: true });
	writeFileSync(join(root, "README.md"), "# AgentFlux workflow reuse fixture\n");
	writeFileSync(join(root, ".agentflux", "agentflux.json"), JSON.stringify({
		budget: { max_cost_per_task: 0.25, max_iterations: 3, max_wall_clock_seconds: 240 },
		pricing: { enable_remote_fetch: false },
	}));
	writeFileSync(join(root, ".agentflux", "models.json"), JSON.stringify(config.fluxModelsJson()));
	const { output: first } = run("执行固定两步只读流程：先读取 README.md 第一行并输出 WORKFLOW_READ_OK，再由独立 reviewer 复核并输出 WORKFLOW_REVIEW_OK；全部通过后以 WORKFLOW_SEED_OK 结束。");
	if (!first.includes("\"toolName\":\"flux_workflow\"") || !first.includes("[DAG Execution: PASSED]") || !first.includes("WORKFLOW_SEED_OK")) {
		throw new Error(`initial Workflow did not pass\n${first.slice(-6000)}`);
	}
	const { output: second, timedOutAfterExecution } = run(
		"完整复用刚才保存的固定流程再次执行，不要重新设计流程；完成后以 WORKFLOW_REUSE_OK 结束。",
		true,
	);
	if (!second.includes("DAG Execution: PASSED") && !timedOutAfterExecution) {
		throw new Error(`saved Workflow was not reused\n${second.slice(-6000)}`);
	}
	if (!second.includes("WORKFLOW_REUSE_OK") && !timedOutAfterExecution) {
		throw new Error(`Main Agent did not summarize the reused Workflow\n${second.slice(-6000)}`);
	}
	const workflowsPath = join(root, ".agentflux", "runtime", "workflows.json");
	const tasksPath = join(root, ".agentflux", "runtime", "tasks.json");
	if (!existsSync(workflowsPath) || !existsSync(tasksPath)) throw new Error("Workflow registry or Task Registry missing");
	const definitions = JSON.parse(readFileSync(workflowsPath, "utf-8")).definitions;
	const tasks = JSON.parse(readFileSync(tasksPath, "utf-8")).tasks;
	const workflowTasks = tasks.filter((task: any) => task.workStyle === "workflow");
	if (definitions.length !== 1 || definitions[0].version !== 1) throw new Error("reuse unexpectedly created or revised a Workflow definition");
	if (!workflowTasks.some((task: any) => task.operation === "reuse" && task.resource?.id === definitions[0].id)) {
		throw new Error("Workflow reuse lineage or resource association missing");
	}
	console.log(JSON.stringify({
		ok: true,
		workflowId: definitions[0].id,
		version: definitions[0].version,
		workflowTaskCount: workflowTasks.length,
		reusedWithoutRevision: true,
		timedOutAfterExecution,
	}, null, 2));
} finally {
	rmSync(root, { recursive: true, force: true });
	config.cleanup();
}
