import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEphemeralRecord, finishEphemeralRecord } from "../src/agents/agent-lifecycle";
import { allocateParallelAgentBudget, canCompletionProofRecover, runAgent, runAgentsParallel, type AgentTemplate } from "../src/agents/agent-runner";
import { archivePersistentAgent, listPersistentAgents, registerPersistentAgent, runPersistentAgent } from "../src/agents/persistent-agent";
import { TelemetryWriter } from "../src/telemetry/events";
import { resolveAgentFluxTeamTaskRuntime } from "../src/core/team-runtime";
import { getAgentRun, markAgentRunRunning, reconcileStaleAgentRuns, registerAgentRun, listAgentRuns } from "../src/core/run-registry";

let passed = 0;
function check(value: unknown, message: string): void { if (!value) throw new Error(message); passed++; console.log(`✓ ${message}`); }

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "agentflux-agent-life-"));
	try {
		check(allocateParallelAgentBudget(0.25, 5) === 0.05, "Team 总预算按并行 child 数量分配");
		check(allocateParallelAgentBudget(undefined, 5) === undefined, "未设置总预算时不制造子预算");
		let invalidBudgetCountRejected = false;
		try { allocateParallelAgentBudget(0.25, 0); } catch { invalidBudgetCountRejected = true; }
		check(invalidBudgetCountRejected, "空 Team 不能分配并行预算");
		const helper = resolve("tests/helpers/successful-subagent.cjs");
		const invocationOverride = { command: process.execPath, args: [helper] };
		const template: AgentTemplate = { name: "worker", role: "implementer", description: "test", tools: [], systemPrompt: "Complete the task." };
		const telemetry = new TelemetryWriter(join(root, ".agentflux"));
		const record = createEphemeralRecord({ name: "worker-1", role: "implementer", sessionId: "test", telemetry });
		const result = await runAgent({ cwd: root, agent: { ...template, name: record.name }, task: "short task", sessionId: "test", telemetry, prefixLayout: true, persistent: false, invocationOverride });
		finishEphemeralRecord(record, result.exitCode, result.usage.cost, telemetry, "test");
		check(result.exitCode === 0 && record.status === "done" && record.callCount === 1, "Ephemeral Agent 单次运行后进入终态");
		const firstRun = listAgentRuns(join(root, ".agentflux"), { agent: record.name })[0];
		check(firstRun?.status === "completed" && firstRun.kind === "ephemeral" && !!firstRun.finishedAt, "Run Registry 保存 Ephemeral 的权威终态");
		registerAgentRun(join(root, ".agentflux"), {
			id: "stale-test-run",
			sessionId: "test",
			agent: "stale-worker",
			role: "implementer",
			currentTask: "crashed process",
			kind: "ephemeral",
		});
		markAgentRunRunning(join(root, ".agentflux"), "stale-test-run", process.pid, 1);
		reconcileStaleAgentRuns(join(root, ".agentflux"), { now: new Date(Date.now() + 31_000), staleAfterMs: 30_000 });
		check(getAgentRun(join(root, ".agentflux"), "stale-test-run")?.status === "failed", "Run Registry 将心跳过期的孤儿运行收敛为失败");
		const turnLimited = await runAgent({
			cwd: root, agent: { ...template, name: "turn-limited" }, task: "bounded",
			sessionId: "test", prefixLayout: true, maxTurns: 1, invocationOverride,
		});
		check(turnLimited.exitCode === 74 && turnLimited.errorMessage?.includes("turn limit") === true,
			"结构化调度可用 turn 上限终止高消耗 Agent");
		writeFileSync(join(root, "proof.txt"), "PATCH_APPLIED\n");
		const proofAccepted = await runAgent({
			cwd: root, agent: { ...template, name: "proof-accepted" }, task: "bounded with proof",
			sessionId: "test", prefixLayout: true, maxTurns: 1, invocationOverride,
			completionProof: { files: [{ path: "proof.txt", contains: ["PATCH_APPLIED"] }] },
		});
		check(proofAccepted.exitCode === 0 && proofAccepted.completionProof?.passed === true,
			"turn 上限后可由 workspace 完成凭证确认真实成功");
		const proofRejected = await runAgent({
			cwd: root, agent: { ...template, name: "proof-rejected" }, task: "bounded with bad proof",
			sessionId: "test", prefixLayout: true, maxTurns: 1, invocationOverride,
			completionProof: { files: [{ path: "proof.txt", contains: ["MISSING_MARKER"] }] },
		});
		check(proofRejected.exitCode === 74 && proofRejected.completionProof?.passed === false,
			"完成凭证不满足时保留预算失败终态");
		const falseSuccessRejected = await runAgent({
			cwd: root, agent: { ...template, name: "false-success-rejected" }, task: "claims success without proof",
			sessionId: "test", prefixLayout: true, invocationOverride,
			completionProof: { files: [{ path: "proof.txt", contains: ["MISSING_MARKER"] }] },
		});
		check(falseSuccessRejected.exitCode === 75
			&& falseSuccessRejected.completionProof?.passed === false
			&& falseSuccessRejected.errorMessage?.includes("completion proof failed") === true,
		"模型正常结束但完成凭证不满足时拒绝假成功");
		check(canCompletionProofRecover({
			exitCode: 1,
			output: "Patch applied and verified.",
			errorMessage: "ResourceExhausted: Worker local total request limit reached",
		}), "完成凭证可恢复已产出结果后的瞬时 provider 尾部错误");
		check(!canCompletionProofRecover({
			exitCode: 1,
			output: "",
			errorMessage: "ResourceExhausted: Worker local total request limit reached",
		}), "无模型结果的 provider 失败不能由完成凭证恢复");
		check(!canCompletionProofRecover({
			exitCode: 1,
			output: "Patch failed.",
			errorMessage: "command exited with code 1",
		}), "普通业务失败不能由完成凭证恢复");

		const team = await runAgentsParallel([
			{ agent: { ...template, name: "worker-a" }, task: "A", label: "A" },
			{ agent: { ...template, name: "worker-b" }, task: "B", label: "B" },
		], { cwd: root, sessionId: "team", taskId: "team-task-1", telemetry, prefixLayout: true, invocationOverride });
		check(team.allSucceeded && team.results.length === 2, "Team 并行运行两个独立 Ephemeral Agent");
		check(listAgentRuns(join(root, ".agentflux")).filter(run => ["worker-a", "worker-b"].includes(run.agent)).length === 2, "Run Registry 保存每个 Team child 而不是只保存父任务");
		const lifecycleEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8")
			.trim().split("\n").map(line => JSON.parse(line)).filter(event => event.type === "agent.lifecycle" && ["worker-a", "worker-b"].includes(event.agent));
		check(lifecycleEvents.filter(event => event.action === "created").length === 2 && lifecycleEvents.filter(event => event.action === "completed").length === 2, "Team child 的创建与终态均写入 lifecycle telemetry");
		check(lifecycleEvents.filter(event => event.action === "started").length === 2
			&& lifecycleEvents.every(event => event.taskId === "team-task-1")
			&& lifecycleEvents.some(event => event.currentTask === "A" && event.role === "implementer"),
		"Team child 在运行阶段暴露 task、role 与父任务关联");

		const workspace = join(root, "external-workspace");
		const capture = join(root, "workspace-capture.json");
		mkdirSync(workspace);
		writeFileSync(join(workspace, "target.ts"), "export {};\n");
		process.env.AGENTFLUX_TEST_CAPTURE = capture;
		const scoped = await runAgentsParallel([{
			agent: { ...template, name: "workspace-worker", thinking: "high" },
			task: "Patch target",
			label: "workspace-worker",
			workspaceCwd: workspace,
			lockFiles: ["target.ts"],
			model: "deepseek-v4-flash",
			provider: "octopus-completions",
			thinking: "off",
		}], {
			cwd: root, sessionId: "workspace-team", telemetry, prefixLayout: true,
			invocationOverride, taskId: "workspace-task",
		});
		const captured = JSON.parse(readFileSync(capture, "utf-8"));
		check(scoped.results.length === 1 && scoped.allSucceeded, "结构化 Team 清单只启动声明的 Agent");
		check(captured.cwd === workspace && captured.controlCwd === root && captured.workspaceCwd === workspace,
			"AgentFlux 状态目录与子 Agent 工作区彼此独立");
		check(captured.lockFiles.length === 1 && captured.lockFiles[0] === join(workspace, "target.ts"),
			"相对 lockFiles 以子 Agent 工作区解析为绝对路径");
		check(captured.argv.includes("--thinking") && captured.argv.includes("off")
			&& captured.argv.includes("deepseek-v4-flash") && captured.argv.includes("octopus-completions"),
		"单次运行显式模型、provider 与 thinking 覆盖角色模板");
		const lowCostRuntime = resolveAgentFluxTeamTaskRuntime(
			{ executionProfile: "low_cost_test" },
			{ model: "deepseek-v4-pro", provider: "other", thinking: "xhigh", maxTurns: 20, maxInputTokens: 50_000 },
			{ model: "default-model", provider: "default-provider", thinking: "high" },
		);
		check(lowCostRuntime.model === "deepseek-v4-flash"
			&& lowCostRuntime.provider === "octopus-completions"
			&& lowCostRuntime.thinking === "off"
			&& lowCostRuntime.maxTurns === 6
			&& lowCostRuntime.maxInputTokens === 12_000,
		"低成本测试档强制 Flash、关闭思考并限制轮次与输入 token");
		const stricterLowCostRuntime = resolveAgentFluxTeamTaskRuntime(
			{ executionProfile: "low_cost_test" },
			{ maxTurns: 2, maxInputTokens: 4_000 },
			{},
		);
		check(stricterLowCostRuntime.maxTurns === 2 && stricterLowCostRuntime.maxInputTokens === 4_000,
			"低成本测试档保留调用方更严格的上限");

		const persistent = registerPersistentAgent(root, "reviewer-main", "reviewer", { models: {} });
		check(persistent.kind === "persistent" && listPersistentAgents(root).length === 1, "Persistent Agent 从模板注册");
		const persistentResult = await runPersistentAgent("reviewer-main", "review task", { cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true, invocationOverride });
		const afterRun = listPersistentAgents(root)[0];
		check(persistentResult.exitCode === 0 && afterRun.status === "idle" && afterRun.callCount === 1, "Persistent Agent 完成后回到 idle 并保留身份");
		check(archivePersistentAgent(root, "reviewer-main").status === "archived", "空闲 Persistent Agent 可归档");
		registerPersistentAgent(root, "reviewer-a", "reviewer", { models: {} });
		registerPersistentAgent(root, "reviewer-b", "reviewer", { models: {} });
		await Promise.all([
			runPersistentAgent("reviewer-a", "review A", { cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent-a", sharedSkills: [], prefixLayout: true, invocationOverride }),
			runPersistentAgent("reviewer-b", "review B", { cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent-b", sharedSkills: [], prefixLayout: true, invocationOverride }),
		]);
		const concurrentPersistent = listPersistentAgents(root).filter(agent => ["reviewer-a", "reviewer-b"].includes(agent.name));
		check(concurrentPersistent.length === 2
			&& concurrentPersistent.every(agent => agent.status === "idle" && agent.callCount === 1),
		"并发 Persistent Agent 终态以事务合并且不丢更新");
		console.log(`\n${passed} Agent lifecycle checks passed`);
	} finally { delete process.env.AGENTFLUX_TEST_CAPTURE; rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
