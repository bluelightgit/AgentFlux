// 独立负例 Main 验证名称拒绝；两个后续 fresh Main 验证原生 fork 的继承记忆与源不变。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, parseJsonLines, toolExecutionStarts } from "../helpers/pi-json-output";
import { isProcessAlive } from "../../src/core/fs-lock";

const sourceRoot = resolve(import.meta.dirname, "../..");
const id = `${Date.now()}-${process.pid}`;
const root = join(sourceRoot, ".agentflux/test-workspaces", `native-fork-${id}`);
const reportPath = join(sourceRoot, ".agentflux/test-results", `native-fork-${id}.json`);
const json = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
	const config = loadLiveConfig("core");
	const report: any = { root, reportPath, startedAt: new Date().toISOString(), passed: false, pricingAuthoritative: false,
		provider: config.providerId, model: config.mainModel, thinking: config.thinking, phases: [] };
	mkdirSync(join(root, ".agentflux"), { recursive: true }); mkdirSync(join(sourceRoot, ".agentflux/test-results"), { recursive: true });
	async function run(label: string, prompt: string, marker: string) {
		const p = spawn(process.execPath, [getPiCliPath(), "--mode", "json", "-p", "--approve",
			"--no-extensions", "-e", join(root, "dist/extension/host-entry.ts"), "--no-skills", "--tools", "read,flux_agent", ...config.cliArgs(config.mainModel), prompt],
			{ cwd: root, env: config.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		const row: any = { label, pid: p.pid, testWatchdogMs: 360000 }; report.phases.push(row);
		let stdout = "", stderr = "";
		const stop = () => { if (!p.pid || p.exitCode !== null || p.signalCode !== null) return;
			if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			else { try { process.kill(-p.pid, "SIGKILL"); } catch {} }
		};
		p.stdout.on("data", b => { stdout += b.toString(); appendFileSync(join(root, `${label}.stdout.jsonl`), b); });
		p.stderr.on("data", b => { stderr += b.toString(); appendFileSync(join(root, `${label}.stderr.log`), b); });
		const watchdog = setTimeout(() => { row.watchdogExpired = true; stop(); }, row.testWatchdogMs);
		try {
			row.exitCode = await new Promise<number>((done, reject) => { p.on("error", reject); p.on("close", c => done(c ?? 1)); });
			assert.equal(row.exitCode, 0); assert.ok(!row.watchdogExpired); assert.ok(hasAssistantFinalMarker(stdout, stderr, marker));
			return stdout;
		} finally {
			clearTimeout(watchdog); stop(); const until = Date.now() + 10000;
			while (p.exitCode === null && p.signalCode === null && Date.now() < until) await sleep(50);
			row.alive = p.pid ? isProcessAlive(p.pid) : false;
			assert.equal(row.alive, false);
		}
	}
	try {
		assert.equal(process.env.AGENTFLUX_LIVE_BUILT, "1");
		cpSync(join(sourceRoot, "dist/extension"), join(root, "dist/extension"), { recursive: true });
		writeFileSync(join(root, "README.md"), "# Native session fork fixture\n");
		writeFileSync(join(root, ".agentflux/models.json"), JSON.stringify(config.fluxModelsJson()));
		writeFileSync(join(root, ".agentflux/agentflux.json"), JSON.stringify({ subagent_runtime: config.subagentRuntime, budget: { max_cost_per_task: 0.25, max_iterations: 3,
			max_turns_per_task: 12, max_input_tokens_per_task: 100000, max_wall_clock_seconds: null }, pricing: { enable_remote_fetch: false } }));
		report.dist = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"].map(name => ({ name, sha256: hash(join(root, "dist/extension", name)) }));
		const memory = `FORK_MEMORY_${randomUUID().replaceAll("-", "")}`;
		const invalidOutput = await run("invalid-name", "只调用一次 flux_agent action=create name=invalid(name) role=implementer。它必须因名称校验被拒绝，这是预期负例，不重试也不创建其他 Agent。确认拒绝后最终只输出 NAME_REJECTED_OK。", "NAME_REJECTED_OK");
		const badCall = toolExecutionStarts(invalidOutput, "flux_agent").find(e => e.args?.action === "create" && e.args.name === "invalid(name)");
		assert.ok(badCall);
		assert.ok(parseJsonLines(invalidOutput).some(e => e.type === "tool_execution_end" && e.toolCallId === badCall.toolCallId && e.isError === true));
		const rejectedHistory = json(join(root, ".agentflux/runtime/tasks.json"));
		assert.equal(rejectedHistory.tasks.length, 1); assert.equal(rejectedHistory.tasks[0].status, "failed");
		assert.equal(rejectedHistory.executions[0].outcome.status, "failure");
		const rejectedTaskId = rejectedHistory.tasks[0].id;
		const agentStore = join(root, ".agentflux/runtime/agents.json");
		assert.ok(!existsSync(agentStore) || json(agentStore).agents.length === 0);
		report.nameRejection = rejectedHistory;
		await run("source", `严格顺序调用 flux_agent：create name=memory-source role=implementer scope=project；再以同样参数 create，得到去重名称 memory-source-2；最后 run agent=memory-source-2 sessionMode=fresh background=false task=记住唯一 secret 值 ${memory}，不要使用任何工具，只回复 MEMORY_STORED。全部成功后最终只输出 SOURCE_READY。`, "SOURCE_READY");
		assert.deepEqual(json(agentStore).agents.map((a: any) => a.name).sort(), ["memory-source", "memory-source-2"]);
		const sessionDir = join(root, ".agentflux/runtime/sessions");
		const filesBefore = readdirSync(sessionDir).filter(n => n.endsWith(".jsonl"));
		assert.equal(filesBefore.length, 1);
		const sourceFile = join(sessionDir, filesBefore[0]); const beforeHash = hash(sourceFile);
		const sourceHeader = JSON.parse(readFileSync(sourceFile, "utf8").split(/\r?\n/)[0]);
		assert.ok(readFileSync(sourceFile, "utf8").includes(memory));
		const forkCalls = [
			{ action: "create", name: "memory-child", role: "reviewer", scope: "project", forkFrom: "memory-source-2" },
			{ action: "run", agent: "memory-child", background: false, task: "从继承的会话记忆找出唯一 secret 值，不使用任何工具、不读取文件，只回复该 secret 的原始字符串" },
			{ action: "run", agent: "memory-child", background: false, task: "再次仅凭会话记忆回复相同 secret，禁止使用任何工具" },
		];
		const prompt = `严格顺序实际调用 flux_agent 三次，每次参数必须原样使用下面对应 JSON：${JSON.stringify(forkCalls)}。注意 name 只用于 create，run 必须使用 agent 字段；禁止额外调用或改写 task。Main 不得在子任务正文指定答案，不得查询文件或让源 Agent 重跑。全部调用成功后最终只输出 FORK_LIVE_OK；若发生任何意外错误则报告失败，不得自行增加调用。`;
		assert.ok(!prompt.includes(memory));
		const stdout = await run("fork", prompt, "FORK_LIVE_OK");
		const calls = toolExecutionStarts(stdout, "flux_agent").filter(e => e.args?.action === "run");
		assert.equal(calls.length, 2); assert.ok(calls.every(e => e.args.agent === "memory-child" && !e.args.task.includes(memory)));
		assert.equal(hash(sourceFile), beforeHash, "源文件必须在两个目标 Run 后仍字节不变");
		const agents = json(join(root, ".agentflux/runtime/agents.json")).agents;
		const source = agents.find((a: any) => a.name === "memory-source-2"), child = agents.find((a: any) => a.name === "memory-child");
		assert.ok(source && child && source.id !== child.id && source.sessionId !== child.sessionId);
		assert.equal(child.lineage.origin, "fork"); assert.equal(child.callCount, 2);
		const runs = json(join(root, ".agentflux/runtime/runs.json")).runs;
		assert.equal(runs.length, 3); assert.ok(runs.every((r: any) => r.status === "completed" && r.deadlineAt === undefined));
		const targets = readdirSync(sessionDir).filter(n => n.endsWith(".jsonl") && !filesBefore.includes(n)).map(n => join(sessionDir, n));
		assert.ok(targets.length > 0);
		const targetFacts = targets.map(p => {
			const rows = readFileSync(p, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
			assert.notEqual(rows[0].id, sourceHeader.id);
			return { path: p, sha256: hash(p), header: rows[0], rows };
		});
		const seed = targetFacts.find(f => f.header.id === child.sessionId);
		const active = targetFacts.find(f => f.header.id === child.lastSessionId);
		assert.equal(seed?.header.parentSession, sourceFile, "原生种子必须指向源快照");
		assert.ok(active && seed && active.path !== seed.path);
		assert.equal(active.header.parentSession, seed.path, "当前 capability 分支必须由原生种子派生");
		assert.equal(targetFacts.length, 2, "相同 capability 的第二次 Run 必须复用独立分支而不覆盖种子");
		const nativeReplies = active.rows.filter(r => r.message?.role === "assistant")
			.flatMap(r => r.message.content ?? []).filter(b => b.type === "text" && b.text === memory);
		assert.equal(nativeReplies.length, 2);
		assert.ok(active.rows.filter(r => r.message?.role === "assistant")
			.every(r => !(r.message.content ?? []).some((b: any) => b.type === "toolCall")), "记忆回答不能靠工具读取源文件");
		const replies = parseJsonLines(stdout).filter(e => e.type === "tool_execution_end" && e.toolName === "flux_agent")
			.flatMap(e => e.result?.content ?? []).filter(b => b.type === "text" && b.text.includes(memory));
		assert.equal(replies.length, 2, "两个真实 child 工具结果都必须返回继承的随机记忆");
		const tasks = json(join(root, ".agentflux/runtime/tasks.json"));
		assert.equal(tasks.tasks.length, 3);
		assert.ok(tasks.tasks.every((t: any) => t.status === (t.id === rejectedTaskId ? "failed" : "completed")));
		assert.deepEqual(tasks.tasks.find((t: any) => t.id === rejectedTaskId), rejectedHistory.tasks[0], "预期失败历史仍不可改写");
		const assistantCost = (rows: any[]) => rows.filter(e => e.message?.role === "assistant").reduce((sum, e) => sum + (e.message.usage?.cost?.total ?? 0), 0);
		const sourceRows = readFileSync(sourceFile, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
		const sourceSdkCost = assistantCost(sourceRows);
		const targetSdkCost = assistantCost(active.rows.filter(e => e.message?.content?.some?.((b: any) => b.type === "text" && b.text === memory)));
		const sourceRunCost = runs.filter((r: any) => r.agent === "memory-source-2").reduce((sum: number, r: any) => sum + r.costUsd, 0);
		const targetRunCost = runs.filter((r: any) => r.agent === "memory-child").reduce((sum: number, r: any) => sum + r.costUsd, 0);
		assert.ok(sourceSdkCost > 0 && targetSdkCost > 0, "此场景必须提供非零 SDK 费用，不能用零价证明记账");
		assert.ok(Math.abs(sourceSdkCost - sourceRunCost) < 1e-9 && Math.abs(targetSdkCost - targetRunCost) < 1e-9);
		report.costChecks = report.phases.map((phase: any) => {
			const execution = tasks.executions.find((e: any) => e.ownerPid === phase.pid);
			const mainSdkCost = assistantCost(parseJsonLines(readFileSync(join(root, `${phase.label}.stdout.jsonl`), "utf8")).filter(e => e.type === "message_end"));
			const childCost = runs.filter((r: any) => r.taskId === execution.taskId).reduce((sum: number, r: any) => sum + r.costUsd, 0);
			assert.ok(Math.abs(execution.costUsd - mainSdkCost - childCost) < 1e-9, "父 Execution 必须等于 Main SDK 成本加各 Run 一次费用");
			assert.ok(Math.abs(execution.costAccounting.invocationCostUsd - childCost) < 1e-9);
			return { label: phase.label, mainSdkCost, childCost, executionCost: execution.costUsd, passed: true };
		});
		report.nativeRunCost = { sourceSdkCost, sourceRunCost, targetSdkCost, targetRunCost, passed: true };
		report.source = { path: sourceFile, beforeHash, afterHash: hash(sourceFile), sessionId: sourceHeader.id };
		report.targets = targetFacts.map(({ rows, ...facts }) => facts); report.agents = agents; report.runs = runs; report.tasks = tasks;
		report.passed = true;
	} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
	finally {
		report.finishedAt = new Date().toISOString(); report.workspaceRetained = true;
		writeFileSync(reportPath, JSON.stringify(report, null, 2)); writeFileSync(join(sourceRoot, ".agentflux/test-results/native-fork-latest.json"), JSON.stringify(report, null, 2));
		config.cleanup(); console.log(JSON.stringify({ passed: report.passed, error: report.error, reportPath }));
	}
}
main().catch(e => { console.error(e); process.exitCode = 1; });
