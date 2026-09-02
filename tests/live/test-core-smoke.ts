import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLiveConfig, type LiveConfig } from "./live-config";

const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `core-live-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "core-live-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

function setup(config: LiveConfig): void {
	mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
	mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
	cpSync(join(sourceRoot, "src"), join(fixtureRoot, "src"), { recursive: true });
	writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux live fixture\n");
	writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({ budget: { max_cost_per_task: 0.25, max_iterations: 3, max_wall_clock_seconds: 240 }, pricing: { enable_remote_fetch: false } }, null, 2));
	writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(config.fluxModelsJson(), null, 2));
}

function writeReport(status: "running" | "passed" | "failed", evidence: Record<string, unknown>[], error?: unknown): void {
	writeFileSync(reportPath, JSON.stringify({ status, updatedAt: new Date().toISOString(), evidence, error: error ? String(error) : undefined }, null, 2));
}

async function run(config: LiveConfig, label: string, model: string, prompt: string, expected: string[], forbidden: string[] = [], timeoutMs = 300_000): Promise<Record<string, unknown>> {
	const args = [piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", join(fixtureRoot, "src", "entry.ts"), "--no-skills", "--tools", "read,grep,find,ls,flux_task,flux_agent,flux_team,flux_workflow,flux_issue,flux_message", ...config.cliArgs(model), prompt];
	const started = Date.now();
	const child = spawn(process.execPath, args, { cwd: fixtureRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: config.env });
	let stdout = ""; let stderr = "";
	child.stdout.on("data", value => { stdout += value.toString(); }); child.stderr.on("data", value => { stderr += value.toString(); });
	const exitCode = await new Promise<number>((done, reject) => {
		const timer = setTimeout(() => { if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL"); reject(new Error(`${label} timeout`)); }, timeoutMs);
		child.on("error", reject); child.on("close", code => { clearTimeout(timer); done(code ?? 1); });
	});
	if (exitCode !== 0) throw new Error(`${label} exit ${exitCode}\n${stderr}\n${stdout.slice(-2000)}`);
	const combined = `${stdout}\n${stderr}`;
	for (const marker of expected) if (!combined.includes(marker)) throw new Error(`${label} missing ${marker}\nSTDERR:\n${stderr.slice(-4000)}\nSTDOUT:\n${stdout.slice(-4000)}`);
	for (const marker of forbidden) if (combined.includes(marker)) throw new Error(`${label} unexpectedly used ${marker}\n${combined.slice(-4000)}`);
	const readRuntimeJson = (name: string): any => {
		const path = join(fixtureRoot, ".agentflux", "runtime", name);
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : undefined;
	};
	const taskStore = readRuntimeJson("tasks.json");
	const runStore = readRuntimeJson("runs.json");
	if (label === "natural-team") {
		const teamTask = taskStore?.tasks?.find((task: any) => task.workStyle === "team");
		const childRuns = runStore?.runs?.filter((run: any) => run.taskId === teamTask?.id) ?? [];
		if (!teamTask || teamTask.status !== "completed" || childRuns.length < 2 || childRuns.some((run: any) => run.status !== "completed")) {
			throw new Error(`${label} did not produce a completed Team task with two completed child runs`);
		}
	}
	return {
		label,
		model,
		thinking: config.thinking,
		pid: child.pid,
		exitCode,
		wallClockMs: Date.now() - started,
		markers: expected,
		tasks: taskStore?.tasks?.map((task: any) => ({
			id: task.id,
			executionId: task.executionId,
			workStyle: task.workStyle,
			status: task.status,
			operation: task.operation,
		})),
		executions: taskStore?.executions?.map((execution: any) => ({
			id: execution.id,
			taskId: execution.taskId,
			status: execution.status,
			costUsd: execution.costUsd,
			outcome: execution.outcome,
		})),
		runs: runStore?.runs?.map((run: any) => ({
			id: run.id,
			taskId: run.taskId,
			executionId: run.executionId,
			agent: run.agent,
			kind: run.kind,
			status: run.status,
			attempt: run.attempt,
			costUsd: run.costUsd,
			error: run.error,
		})),
	};
}

async function main(): Promise<void> {
	const config = loadLiveConfig("core"); setup(config); const evidence: Record<string, unknown>[] = []; writeReport("running", evidence);
	const selectedCases = new Set((process.env.AGENTFLUX_LIVE_CASES ?? "direct,team,workflow,community").split(",").map(value => value.trim()).filter(Boolean));
	try {
		if (selectedCases.has("direct")) { const direct = await run(config, "natural-direct", config.mainModel, "回答精确文本 NATURAL_DIRECT_OK。这是一个单一且无需读取文件的小任务。", ["NATURAL_DIRECT_OK"], ["\"toolName\":\"flux_team\"", "\"toolName\":\"flux_workflow\"", "\"toolName\":\"flux_issue\""]); evidence.push(direct); writeReport("running", evidence); console.log(JSON.stringify(direct)); }
		if (selectedCases.has("team")) { const team = await run(config, "natural-team", config.workerModel, "必须实际调用 flux_team，并行启动代码审查者和测试专家两个 Agent，分别独立检查 README.md 第一行是否准确描述项目；等待两个 Agent 完成、汇总意见后以 NATURAL_TEAM_OK 结束。", ["flux_team", "NATURAL_TEAM_OK"]); evidence.push(team); writeReport("running", evidence); console.log(JSON.stringify(team)); }
		if (selectedCases.has("workflow")) { const workflow = await run(config, "natural-workflow", config.plannerModel, "执行固定三职责只读流程，节点不可合并。规划职责定义 README.md 第一行应等于 '# AgentFlux live fixture'，产物需包含 PLAN_READY；执行职责依赖规划产物，读取文件并给出判断，产物需包含 EXEC_PASS；独立审查职责依赖前两份产物，复核后产物需包含 REVIEW_PASS。每个节点的验收只检查是否包含对应标记，不限制其他解释文字。不修改文件，全部通过后以 NATURAL_WORKFLOW_OK 结束。", ["flux_workflow", "[DAG Execution: PASSED]", "NATURAL_WORKFLOW_OK"]); evidence.push(workflow); writeReport("running", evidence); console.log(JSON.stringify(workflow)); }
		if (selectedCases.has("community")) { const community = await run(config, "natural-community", config.mainModel, "职责和检查范围尚未确定。请建立一个公开协作事项，形成 README 审计的认领范围，记录意见，提交认领结果并在完成后关闭事项；最后以 NATURAL_COMMUNITY_OK 结束。", ["flux_issue", "resolved", "NATURAL_COMMUNITY_OK"]); evidence.push(community); writeReport("running", evidence); console.log(JSON.stringify(community)); }
		writeReport("passed", evidence);
		process.stdout.write(`${JSON.stringify({ ok: true, evidence }, null, 2)}\n`);
	} catch (error) {
		writeReport("failed", evidence, error);
		throw error;
	} finally {
		const base = resolve(sourceRoot, ".agentflux", "test-workspaces"); const target = resolve(fixtureRoot);
		if (!target.startsWith(`${base}\\`)) throw new Error(`unsafe cleanup: ${target}`);
		rmSync(target, { recursive: true, force: true });
		config.cleanup();
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
