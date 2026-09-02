import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEphemeralRecord, finishEphemeralRecord } from "../src/agents/agent-lifecycle";
import { allocateParallelAgentBudget, canCompletionProofRecover, runAgent, runAgentsParallel, type AgentTemplate } from "../src/agents/agent-runner";
import { createAgent, deleteAgent, deleteSessionAgents, enqueueAgentInstruction, findAgents, formatAgents, formatAgentSessionCommand, formatSubagentStatusLine, gcAgents, listAgents, readAgentLastMessage, readAgentLastMessages, rejectQueuedAgentInstructions, resetAgentStatus, runAgentRecord, sortAgentsByActivity } from "../src/agents/agent-store";
import { TelemetryWriter } from "../src/telemetry/events";
import { MessageBus } from "../src/core/message-bus";
import { resolveAgentFluxTeamTaskRuntime } from "../src/core/team-runtime";
import { finishAgentRun, getAgentRun, heartbeatAgentRun, markAgentRunRunning, reconcileStaleAgentRuns, registerAgentRun, listAgentRuns, updateAgentRunSnapshot } from "../src/core/run-registry";

let passed = 0;
function check(value: unknown, message: string): void { if (!value) throw new Error(message); passed++; console.log(`✓ ${message}`); }

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "agentflux-agent-life-"));
	try {
		check(allocateParallelAgentBudget(0.25, 5) === 0.05, "并行预算按 child 数量分配");
		check(allocateParallelAgentBudget(undefined, 5) === undefined, "未设置总预算时不制造子预算");
		let invalidBudgetCountRejected = false;
		try { allocateParallelAgentBudget(0.25, 0); } catch { invalidBudgetCountRejected = true; }
		check(invalidBudgetCountRejected, "空并行清单不能分配预算");
		const helper = resolve("tests/helpers/successful-subagent.cjs");
		const invocationOverride = { command: process.execPath, args: [helper] };
		const template: AgentTemplate = { name: "worker", role: "implementer", description: "test", tools: [], systemPrompt: "Complete the task." };
		const telemetry = new TelemetryWriter(join(root, ".agentflux"));
		const record = createEphemeralRecord({ name: "worker-1", role: "implementer", sessionId: "test", telemetry });
		const result = await runAgent({ cwd: root, agent: { ...template, name: record.name }, task: "short task", sessionId: "test", telemetry, prefixLayout: true, persistent: false, invocationOverride });
		finishEphemeralRecord(record, result.exitCode, result.usage.cost, telemetry, "test");
		check(result.exitCode === 0 && record.status === "done" && record.callCount === 1, "单次运行后进入终态");
		// 运行过程实时回调：mock CLI 的 message_end 文本块应实时上报
		const progressEvents: Array<{ type: string; text: string }> = [];
		await runAgent({ cwd: root, agent: { ...template, name: "progress-watch" }, task: "progress", sessionId: "test", prefixLayout: true, persistent: false, invocationOverride, onProgress: event => progressEvents.push(event) });
		check(progressEvents.some(event => event.type === "message" && event.text.includes("message processed")), "onProgress 实时上报 assistant 消息块");
		const firstRun = listAgentRuns(join(root, ".agentflux"), { agent: record.name })[0];
		check(firstRun?.status === "completed" && !!firstRun.finishedAt && firstRun.recentEvents?.some(event => event.type === "message_end"), "Run Registry 保存权威终态与有界最近事件");

		// 进程仍在运行时，Core Registry、文本 list 与最终结果读取同一份绝对在线快照。
		const onlineHelper = resolve("tests/helpers/online-telemetry-subagent.cjs");
		const onlineRunId = "online-telemetry-run";
		const onlinePromise = runAgent({
			cwd: root, agent: { ...template, name: "online-observer" }, task: "observe live usage",
			sessionId: "test", prefixLayout: true, persistent: false, runId: onlineRunId,
			invocationOverride: { command: process.execPath, args: [onlineHelper] },
			env: { AGENTFLUX_TEST_EXIT_DELAY_MS: "700" },
		});
		let onlineRun = getAgentRun(join(root, ".agentflux"), onlineRunId);
		for (let attempt = 0; attempt < 100 && (onlineRun?.turns ?? 0) < 1; attempt++) {
			await new Promise(resolveWait => setTimeout(resolveWait, 20));
			onlineRun = getAgentRun(join(root, ".agentflux"), onlineRunId);
		}
		check(onlineRun?.status === "running" && onlineRun.phase === "running" && !!onlineRun.pid
			&& onlineRun.turns === 1 && onlineRun.input === 21 && onlineRun.output === 4
			&& onlineRun.cacheRead === 8 && onlineRun.cacheWrite === 2 && onlineRun.contextTokens === 33
			&& onlineRun.costUsd === 0.012345 && onlineRun.model === "live-test-model"
			&& onlineRun.provider === "live-test-provider" && onlineRun.lastActivityType === "message_end",
		"子进程未结束时 Run Registry 暴露非零 usage、模型、provider 与最近活动");
		const onlineIdentity = {
			id: "agent-online-observer", name: "online-observer", scope: "project", role: "implementer",
			status: "idle", lineage: { origin: "fresh" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			callCount: 0, totalCostUsd: 0, capabilityGeneration: 1,
		} as any;
		const onlineList = formatAgents([onlineIdentity], root);
		check(onlineList.includes("run=running") && onlineList.includes("turns=1")
			&& onlineList.includes("liveCost=$0.012345") && onlineList.includes("model=live-test-model")
			&& onlineList.includes("provider=live-test-provider") && onlineList.includes("activity=online telemetry ready"),
		"formatAgents 从 Core Run Registry 展示同一份在线事实并区分实时成本");
		const onlineResult = await onlinePromise;
		const onlineTerminal = getAgentRun(join(root, ".agentflux"), onlineRunId);
		check(onlineResult.exitCode === 0 && onlineTerminal?.status === "completed" && onlineTerminal.phase === "terminal"
			&& onlineTerminal.turns === onlineResult.usage.turns && onlineTerminal.input === onlineResult.usage.input
			&& onlineTerminal.output === onlineResult.usage.output && onlineTerminal.cacheRead === onlineResult.usage.cacheRead
			&& onlineTerminal.cacheWrite === onlineResult.usage.cacheWrite && onlineTerminal.contextTokens === onlineResult.usage.contextTokens
			&& onlineTerminal.costUsd === onlineResult.usage.cost && onlineTerminal.model === "live-test-model"
			&& onlineTerminal.provider === "live-test-provider",
		"在线绝对快照与 terminal 汇总一致且不会跨阶段双计");

		const noDeadlineResult = await runAgent({
			cwd: root, agent: { ...template, name: "no-deadline-agent" }, task: "no hard wall clock deadline",
			sessionId: "test", prefixLayout: true, timeoutMs: null,
			invocationOverride: { command: process.execPath, args: [onlineHelper] },
			env: { AGENTFLUX_TEST_EXIT_DELAY_MS: "150" },
		});
		check(noDeadlineResult.exitCode === 0, "null deadline 不因固定 wall-clock 终止运行");
		const explicitDeadlineId = "explicit-deadline-run";
		const explicitDeadlineResult = await runAgent({
			cwd: root, agent: { ...template, name: "explicit-deadline-agent" }, task: "explicit deadline",
			sessionId: "test", prefixLayout: true, timeoutMs: 100, runId: explicitDeadlineId,
			invocationOverride: { command: process.execPath, args: [onlineHelper] },
			env: { AGENTFLUX_TEST_EXIT_DELAY_MS: "700" },
		});
		check(explicitDeadlineResult.exitCode === 124 && getAgentRun(join(root, ".agentflux"), explicitDeadlineId)?.status === "timed_out",
			"显式 deadline 超时收敛为 timed_out");

		// 父 Task 聚合预算读取 Core Run 快照；并行 child 不能各自重复获得完整父预算。
		const parentBudgetTaskId = "parent-budget-task";
		const parentBudgetBase = {
			cwd: root, sessionId: "test", prefixLayout: true, taskId: parentBudgetTaskId,
			parentMaxCostUsd: 0.02, parentMaxParallel: 2,
			invocationOverride: { command: process.execPath, args: [onlineHelper] },
			env: { AGENTFLUX_TEST_EXIT_DELAY_MS: "600" },
		};
		const parentBudgetResults = await Promise.all([
			runAgent({ ...parentBudgetBase, agent: { ...template, name: "parent-budget-a" }, task: "parent child a" }),
			runAgent({ ...parentBudgetBase, agent: { ...template, name: "parent-budget-b" }, task: "parent child b" }),
		]);
		check(parentBudgetResults.some(result => result.exitCode === 75 && result.errorMessage?.includes("parent task budget")), "父 Task 聚合成本预算会停止超限 child");
		const exhaustedRunId = "parent-budget-preflight-run";
		const exhaustedResult = await runAgent({ ...parentBudgetBase, agent: { ...template, name: "parent-budget-preflight" }, task: "preflight must not spawn", runId: exhaustedRunId });
		const exhaustedRun = getAgentRun(join(root, ".agentflux"), exhaustedRunId);
		check(exhaustedResult.exitCode === 75 && exhaustedResult.errorMessage?.includes("parent task budget") === true
			&& exhaustedRun?.status === "failed" && exhaustedRun.recentEvents?.some(event => event.type === "parent_budget_exhausted") === true,
			"父级预算预检失败也持久化 Run 终态且不启动子进程");

		const parentConcurrencyTaskId = "parent-concurrency-task";
		const parentConcurrencyBase = {
			cwd: root, sessionId: "test", prefixLayout: true, taskId: parentConcurrencyTaskId,
			parentMaxParallel: 2,
			invocationOverride: { command: process.execPath, args: [onlineHelper] },
			env: { AGENTFLUX_TEST_EXIT_DELAY_MS: "600" },
		};
		const concurrencyA = runAgent({ ...parentConcurrencyBase, agent: { ...template, name: "parent-concurrency-a" }, task: "concurrency a" });
		const concurrencyB = runAgent({ ...parentConcurrencyBase, agent: { ...template, name: "parent-concurrency-b" }, task: "concurrency b" });
		const concurrencyC = runAgent({ ...parentConcurrencyBase, agent: { ...template, name: "parent-concurrency-c" }, task: "concurrency c" });
		const concurrencyResults = await Promise.all([concurrencyA, concurrencyB, concurrencyC]);
		check(concurrencyResults.filter(result => result.exitCode === 75 && result.errorMessage?.includes("parent concurrency")).length === 1, "父 Task 并发预算拒绝超出 active Run 的新 child");

		// heartbeat 写失败只产生有界诊断；不能污染业务 error 或终止健康 child。
		let heartbeatAttempts = 0;
		const heartbeatRunId = "heartbeat-write-failure-run";
		const heartbeatResult = await runAgent({
			cwd: root, agent: { ...template, name: "heartbeat-survivor" }, task: "survive registry heartbeat failure",
			sessionId: "test", prefixLayout: true, persistent: false, runId: heartbeatRunId,
			invocationOverride: { command: process.execPath, args: [onlineHelper] },
			env: { AGENTFLUX_TEST_EXIT_DELAY_MS: "2300" },
			runRegistry: {
				heartbeat: (fluxDir, runId) => {
					heartbeatAttempts++;
					if (heartbeatAttempts === 1) throw new Error("injected heartbeat write failure");
					return heartbeatAgentRun(fluxDir, runId);
				},
			},
		});
		check(heartbeatAttempts >= 1 && heartbeatResult.exitCode === 0 && !heartbeatResult.errorMessage
			&& getAgentRun(join(root, ".agentflux"), heartbeatRunId)?.status === "completed",
		"首次 heartbeat 写失败后健康 child 仍 exit 0 并收敛 completed");

		// 明确 provider 错误在进程退出前持续可见，普通业务错误不借此扩大 fallback 匹配。
		const providerErrorRunId = "online-provider-error-run";
		const providerErrorPromise = runAgent({
			cwd: root, agent: { ...template, name: "provider-error-observer" }, task: "surface provider failure",
			sessionId: "test", prefixLayout: true, persistent: false, runId: providerErrorRunId,
			invocationOverride: { command: process.execPath, args: [onlineHelper] },
			env: { AGENTFLUX_TEST_EXIT_DELAY_MS: "700", AGENTFLUX_TEST_PROVIDER_ERROR: "Monthly usage limit reached" },
		});
		let providerRun = getAgentRun(join(root, ".agentflux"), providerErrorRunId);
		for (let attempt = 0; attempt < 100 && !providerRun?.providerError; attempt++) {
			await new Promise(resolveWait => setTimeout(resolveWait, 20));
			providerRun = getAgentRun(join(root, ".agentflux"), providerErrorRunId);
		}
		check(providerRun?.status === "running" && providerRun.phase === "error"
			&& providerRun.providerError?.includes("Monthly usage limit") === true && providerRun.modelError === undefined,
		"明确 provider 错误在 child 退出前写入 Core Registry");
		const providerErrorResult = await providerErrorPromise;
		check(providerErrorResult.exitCode !== 0
			&& getAgentRun(join(root, ".agentflux"), providerErrorRunId)?.status === "failed"
			&& getAgentRun(join(root, ".agentflux"), providerErrorRunId)?.providerError?.includes("Monthly usage limit") === true,
		"provider 错误在 terminal Run 中保留分类诊断");
		const modelErrorRunId = "model-error-classification-run";
		const modelErrorResult = await runAgent({
			cwd: root, agent: { ...template, name: "model-error-observer" }, task: "surface model failure",
			sessionId: "test", prefixLayout: true, persistent: false, runId: modelErrorRunId,
			invocationOverride: { command: process.execPath, args: [resolve("tests/helpers/provider-model-missing.cjs")] },
		});
		const modelErrorRun = getAgentRun(join(root, ".agentflux"), modelErrorRunId);
		check(modelErrorResult.exitCode !== 0 && modelErrorRun?.modelError?.includes("model not found") === true
			&& modelErrorRun.providerError === undefined,
		"明确 model 错误单独分类并保留到 terminal Run");
		const businessFailureResult = await runAgent({
			cwd: root, agent: { ...template, name: "business-error-no-fallback", model: "primary-model", provider: "provider-a" },
			task: "ordinary command failure", sessionId: "test", prefixLayout: true, persistent: false,
			enableModelFallback: true, maxRetries: 0,
			modelsForFallback: {
				"primary-model": { provider: "provider-a", capability: { coding: 0.9, reasoning: 0.9, speed: 0.9 } },
				"fallback-model": { provider: "provider-b", capability: { coding: 0.8, reasoning: 0.8, speed: 0.8 } },
			} as any,
			roleRequirementForFallback: { coding: 0.5, reasoning: 0.5 },
			invocationOverride: { command: process.execPath, args: [onlineHelper] },
			env: { AGENTFLUX_TEST_EXIT_DELAY_MS: "100", AGENTFLUX_TEST_PROVIDER_ERROR: "file not found: src/missing.ts" },
		});
		const businessFailureRun = listAgentRuns(join(root, ".agentflux"), { agent: "business-error-no-fallback" })[0];
		check(businessFailureResult.exitCode !== 0 && businessFailureResult.fallbackModel === undefined
			&& businessFailureRun?.modelError === undefined && businessFailureRun?.providerError === undefined,
		"普通 file not found 业务错误不会触发模型降级或误分类为 provider/model 错误");

		// Core 快照契约：旧格式只在内存补默认值，计数必须非负且单调，terminal 一律拒写。
		const legacyFluxDir = join(root, "legacy-flux");
		mkdirSync(join(legacyFluxDir, "runtime"), { recursive: true });
		writeFileSync(join(legacyFluxDir, "runtime", "runs.json"), JSON.stringify({
			version: 1,
			runs: [{
				id: "legacy-run", sessionId: "legacy", agent: "legacy-agent", role: "implementer",
				currentTask: "legacy task", kind: "ephemeral", status: "completed", attempt: 1, costUsd: 0.25,
				createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
				heartbeatAt: "2026-01-01T00:00:01.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
			}],
		}, null, 2));
		const legacyRun = listAgentRuns(legacyFluxDir)[0];
		check(legacyRun.phase === "terminal" && legacyRun.turns === 0 && legacyRun.input === 0
			&& legacyRun.output === 0 && legacyRun.cacheRead === 0 && legacyRun.cacheWrite === 0
			&& legacyRun.contextTokens === 0 && legacyRun.lastActivityType === "terminal",
		"旧 runs.json 读取时内存归一化在线字段且不要求迁移写回");
		const contractFluxDir = join(root, "snapshot-contract-flux");
		registerAgentRun(contractFluxDir, {
			id: "snapshot-contract-run", sessionId: "test", agent: "contract-agent", role: "tester",
			currentTask: "validate snapshots", kind: "ephemeral",
		});
		markAgentRunRunning(contractFluxDir, "snapshot-contract-run", process.pid, 1, { model: "contract-model", provider: "contract-provider" });
		const validSnapshot = {
			phase: "tool" as const, turns: 1, input: 10, output: 2, cacheRead: 3, cacheWrite: 1,
			contextTokens: 16, costUsd: 0.01, attempt: 1, lastActivityAt: new Date().toISOString(),
			lastActivityType: "tool_start", lastActivitySummary: "read src/example.ts",
		};
		updateAgentRunSnapshot(contractFluxDir, "snapshot-contract-run", validSnapshot);
		let invalidSnapshotRejected = false;
		try { updateAgentRunSnapshot(contractFluxDir, "snapshot-contract-run", { ...validSnapshot, input: -1 }); } catch { invalidSnapshotRejected = true; }
		check(invalidSnapshotRejected && getAgentRun(contractFluxDir, "snapshot-contract-run")?.input === 10,
		"Run Registry 拒绝负数快照且原子保留上一次事实");
		let backwardsSnapshotRejected = false;
		try { updateAgentRunSnapshot(contractFluxDir, "snapshot-contract-run", { ...validSnapshot, turns: 0 }); } catch { backwardsSnapshotRejected = true; }
		check(backwardsSnapshotRejected && getAgentRun(contractFluxDir, "snapshot-contract-run")?.turns === 1,
		"Run Registry 拒绝 usage 回退且不会覆盖在线累计");
		finishAgentRun(contractFluxDir, "snapshot-contract-run", { status: "completed", ...validSnapshot });
		let terminalWriteRejected = false;
		try { updateAgentRunSnapshot(contractFluxDir, "snapshot-contract-run", validSnapshot); } catch { terminalWriteRejected = true; }
		let terminalRefinishRejected = false;
		try { finishAgentRun(contractFluxDir, "snapshot-contract-run", { status: "completed" }); } catch { terminalRefinishRejected = true; }
		check(terminalWriteRejected && terminalRefinishRejected,
		"terminal Run 拒绝在线更新与重复 finish，历史事实保持不可变");

		registerAgentRun(join(root, ".agentflux"), {
			id: "stale-test-run",
			sessionId: "test",
			agent: "stale-worker",
			role: "implementer",
			currentTask: "crashed process",
			kind: "ephemeral",
		});
		markAgentRunRunning(join(root, ".agentflux"), "stale-test-run", 99999999, 1);
		reconcileStaleAgentRuns(join(root, ".agentflux"), { now: new Date(Date.now() + 31_000), staleAfterMs: 30_000 });
		check(getAgentRun(join(root, ".agentflux"), "stale-test-run")?.status === "failed", "Run Registry 将心跳过期的孤儿运行收敛为失败");
		// 心跳过期但进程仍存活（长操作/心跳写失败）→ 不误标 failed
		registerAgentRun(join(root, ".agentflux"), {
			id: "alive-heartbeat-run",
			sessionId: "test",
			agent: "alive-worker",
			role: "implementer",
			currentTask: "long operation with stale heartbeat",
			kind: "ephemeral",
		});
		markAgentRunRunning(join(root, ".agentflux"), "alive-heartbeat-run", process.pid, 1);
		reconcileStaleAgentRuns(join(root, ".agentflux"), { now: new Date(Date.now() + 31_000), staleAfterMs: 30_000 });
		check(getAgentRun(join(root, ".agentflux"), "alive-heartbeat-run")?.status === "running",
			"心跳超时但进程存活时保留运行状态（进程存活保护）");
		// 心跳过期且进程已消失 → 收敛为失败
		registerAgentRun(join(root, ".agentflux"), {
			id: "dead-heartbeat-run",
			sessionId: "test",
			agent: "dead-worker",
			role: "implementer",
			currentTask: "crashed process",
			kind: "ephemeral",
		});
		markAgentRunRunning(join(root, ".agentflux"), "dead-heartbeat-run", 99999999, 1);
		reconcileStaleAgentRuns(join(root, ".agentflux"), { now: new Date(Date.now() + 31_000), staleAfterMs: 30_000 });
		check(getAgentRun(join(root, ".agentflux"), "dead-heartbeat-run")?.status === "failed",
			"心跳超时且进程已消失时收敛为失败");
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
		check(team.allSucceeded && team.results.length === 2, "并行运行两个独立子代理");
		check(listAgentRuns(join(root, ".agentflux")).filter(run => ["worker-a", "worker-b"].includes(run.agent)).length === 2, "Run Registry 保存每个 child 而不是只保存父任务");
		const lifecycleEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8")
			.trim().split("\n").map(line => JSON.parse(line)).filter(event => event.type === "agent.lifecycle" && ["worker-a", "worker-b"].includes(event.agent));
		check(lifecycleEvents.filter(event => event.action === "created").length === 2 && lifecycleEvents.filter(event => event.action === "completed").length === 2, "child 的创建与终态均写入 lifecycle telemetry");
		check(lifecycleEvents.filter(event => event.action === "started").length === 2
			&& lifecycleEvents.every(event => event.taskId === "team-task-1")
			&& lifecycleEvents.some(event => event.currentTask === "A" && event.role === "implementer"),
		"child 在运行阶段暴露 task、role 与父任务关联");

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
		check(scoped.results.length === 1 && scoped.allSucceeded, "结构化并行清单只启动声明的 Agent");
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

		// ─── 统一 Agent 存储（agent-store）───
		const created = createAgent(root, { name: "reviewer-main", role: "reviewer", modelsConfig: { models: {} } });
		check(created.scope === "project" && created.name === "reviewer-main" && listAgents(root).length === 1, "角色模板创建 Agent（项目级作用域）");
		const createdDefault = createAgent(root, { name: "worker-x", modelsConfig: { models: {} } });
		check(createdDefault.role === "assistant" && createdDefault.lineage.origin === "fresh", "默认创建路径使用内置 assistant 模板");
		const duplicate = createAgent(root, { name: "reviewer-main", role: "reviewer", modelsConfig: { models: {} } });
		check(duplicate.name === "reviewer-main(1)", "重名创建自动后缀去重");
		const fork = createAgent(root, { name: "fork-worker", forkFrom: "reviewer-main", modelsConfig: { models: {} } });
		check(fork.lineage.origin === "fork" && fork.sessionId === created.sessionId, "会话树分叉继承源 Agent 会话记忆");
		check(findAgents(root, "reviewer-main").length === 1 && findAgents(root, "worker-x")[0].id === createdDefault.id, "按 name 查询返回匹配 Agent；id 精确匹配");
		let unknownTemplateRejected = false;
		try { createAgent(root, { name: "bad", role: "no-such-role", modelsConfig: { models: {} } }); } catch { unknownTemplateRejected = true; }
		check(unknownTemplateRejected, "未知角色模板拒绝创建");

		const runResult = await runAgentRecord("reviewer-main", "review task", { cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true, invocationOverride });
		const afterRun = listAgents(root).find(agent => agent.name === "reviewer-main")!;
		check(runResult.exitCode === 0 && afterRun.status === "idle" && afterRun.callCount === 1, "run 后回到 idle 并保留身份");
		check(afterRun.lastTask === "review task", "lastTask 持久化供 retry 复用");
		check(afterRun.lastResult?.success === true && afterRun.lastResult.turns >= 0 && typeof afterRun.lastResult.costUsd === "number" && afterRun.lastResult.summary.length > 0, "完成 run 写入 lastResult 摘要（后台查询用）");
		check(formatAgents(listAgents(root)).includes("last=SUCCESS"), "formatAgents 展示最近一次运行结果");
		const statusEvents: string[] = [];
		await runAgentRecord("reviewer-main", "second task", { cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true, invocationOverride }, undefined, undefined, undefined, status => statusEvents.push(status));
		check(statusEvents[0] === "running" && statusEvents[statusEvents.length - 1] === "idle", "onStatusChange 回调按 running → 终态 上报（footer 状态行刷新）");
		let busyRejected = false;
		try { await runAgentRecord("reviewer-main", "second task", { cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true, invocationOverride }); } catch (error: any) { busyRejected = String(error?.message ?? "").includes("already running"); }
		check(!busyRejected || afterRun.status === "idle", "run 后未处于 busy 状态（真实运行已结束）");
		resetAgentStatus(root, "reviewer-main", "running");
		check(listAgents(root).find(agent => agent.name === "reviewer-main")?.status === "running", "resetAgentStatus 可置 running（模拟孤儿状态）");
		resetAgentStatus(root, "reviewer-main", "idle");
		check(listAgents(root).find(agent => agent.name === "reviewer-main")?.status === "idle", "stop 孤儿恢复路径：running 无句柄时重置为 idle");
		// busy Agent 的新指令只能进入 Message V2 pending 队列，并按具体 Run 隔离。
		const queuedAgent = createAgent(root, { name: "queued-agent", modelsConfig: { models: {} } });
		const queuedRunId = "queued-agent-run";
		registerAgentRun(join(root, ".agentflux"), { id: queuedRunId, sessionId: "persistent", agent: queuedAgent.name, role: queuedAgent.role, currentTask: "busy task", kind: "persistent" });
		markAgentRunRunning(join(root, ".agentflux"), queuedRunId, process.pid, 1);
		resetAgentStatus(root, queuedAgent.name, "running");
		const firstQueued = enqueueAgentInstruction(queuedAgent.name, "first steer", { cwd: root, sessionId: "persistent" });
		const secondQueued = enqueueAgentInstruction(queuedAgent.name, "second steer", { cwd: root, sessionId: "persistent" });
		check(!!firstQueued && !!secondQueued && firstQueued.run.id === queuedRunId && secondQueued.pending === 2, "busy Agent 指令进入有界 Message V2 pending 队列并保留 Run correlation");
		const queuedMessages = new MessageBus(join(root, ".agentflux")).peek(queuedAgent.name, { limit: 20 });
		check(queuedMessages.length === 2 && queuedMessages.every(item => item.envelope.type === "steer" && item.envelope.correlationId === queuedRunId), "busy 队列使用 steer delivery 且顺序可观察");
		check(rejectQueuedAgentInstructions(root, getAgentRun(join(root, ".agentflux"), queuedRunId)!, "test stop") === 2
			&& new MessageBus(join(root, ".agentflux")).peek(queuedAgent.name, { limit: 20 }).every(item => item.delivery.status === "rejected"), "停止具体 Run 时拒绝其未消费指令");
		finishAgentRun(join(root, ".agentflux"), queuedRunId, { status: "cancelled" });
		resetAgentStatus(root, queuedAgent.name, "idle");
		// GC: 最新 k 个保留，更早的删除
		createAgent(root, { name: "gc-a", modelsConfig: { models: {} } });
		createAgent(root, { name: "gc-b", modelsConfig: { models: {} } });
		createAgent(root, { name: "gc-c", modelsConfig: { models: {} } });
		createAgent(root, { name: "gc-d", modelsConfig: { models: {} } });
		const removed = gcAgents(root, 3, new Set());
		check(removed.includes("gc-a") && removed.length === 6, "GC 删除无引用且非最新 k 个创建的 Agent");
		const kept = listAgents(root).map(agent => agent.name);
		check(!kept.includes("gc-a") && kept.includes("gc-b") && kept.includes("gc-c") && kept.includes("gc-d"), "GC 保留最新 k 个");
		// 手动删除（用 GC 保留的 agent）
		check(deleteAgent(root, "gc-b").name === "gc-b", "手动删除 Agent");
		check(!listAgents(root).some(agent => agent.name === "gc-b"), "删除后不再出现在列表");
		check(formatAgents(listAgents(root)).includes("scope=project"), "formatAgents 展示作用域");
		// lastResult 展示细节：摘要换行折叠 + 空摘要兜底 + 精度统一 + 损坏记录丢弃（放在 GC 之后以免影响创建顺序）
		const summaryAgent = createAgent(root, { name: "sum-check", modelsConfig: { models: {} } });
		const storePath = join(root, ".agentflux", "runtime", "agents.json");
		const store = JSON.parse(readFileSync(storePath, "utf-8"));
		const rec = store.agents.find((agent: any) => agent.id === summaryAgent.id);
		rec.lastResult = { exitCode: 0, success: true, summary: "line1\nline2\t\n", turns: 3, costUsd: 0.00012345, at: new Date().toISOString() };
		writeFileSync(storePath, JSON.stringify(store, null, 2));
		const formatted = formatAgents(listAgents(root));
		check(formatted.includes("last=SUCCESS·t3·$0.000123·line1 line2") && formatted.split("\n").length === listAgents(root).length + 1, "lastResult 摘要换行折叠为单行且成本精度统一");
		const badStore = JSON.parse(readFileSync(storePath, "utf-8"));
		badStore.agents.find((agent: any) => agent.id === summaryAgent.id).lastResult = { bogus: true };
		writeFileSync(storePath, JSON.stringify(badStore, null, 2));
		check(listAgents(root).find(agent => agent.id === summaryAgent.id)!.lastResult === undefined, "结构不完整的 lastResult 读取时丢弃（不展示 last=undefined）");
		const emptyStore = JSON.parse(readFileSync(storePath, "utf-8"));
		emptyStore.agents.find((agent: any) => agent.id === summaryAgent.id).lastResult = { exitCode: 0, success: true, summary: "   ", turns: 1, costUsd: 0, at: new Date().toISOString() };
		writeFileSync(storePath, JSON.stringify(emptyStore, null, 2));
		check(formatAgents(listAgents(root)).includes("(no output)"), "空摘要兜底显示 (no output)");
		// 直接对话入口：enter 命令输出 pi --session 启动命令（会话文件按 sessionId-cap- 前缀匹配）
		const enterAgent = createAgent(root, { name: "enter-me", modelsConfig: { models: {} } });
		const sessionsDir = join(root, ".agentflux", "runtime", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(join(sessionsDir, "2026-01-01T00-00-00-000Z_agent-enter-me-cap-abc123.jsonl"), "{\"type\":\"session\",\"version\":3}\n");
		const enterCmd = formatAgentSessionCommand(root, enterAgent);
		check(enterCmd?.includes("agent-enter-me-cap-abc123.jsonl") === true && enterCmd.startsWith("npx pi --session"), "启动命令单行输出（npx pi --session + 会话文件）");
		const listText = formatAgents(listAgents(root), root);
		check(listText.includes("npx pi --session") && listText.includes("agent-enter-me-cap-abc123.jsonl"), "agent 列表详情最下方显示 npx pi --session 启动命令");
		// 最后说的话：读会话文件最后一条 assistant 文本（message 事件类型，非 message_end）
		writeFileSync(join(sessionsDir, "2026-01-01T00-00-00-000Z_agent-talker-cap-abc123.jsonl"), [
			JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
			JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "报告写好了，共 12 个问题。" }] } }),
			JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "(no output)" }] } }),
			JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "汇总完毕。" }] } }),
		].join("\n"), "utf8");
		const lastMessage = readAgentLastMessage(root, { ...enterAgent, name: "talker", sessionId: "agent-talker" });
		check(lastMessage === "汇总完毕。", "Talk 展示最后一条 assistant 文本（跳过 user/toolResult 与旧消息）");
		const lastMessages = readAgentLastMessages(root, { ...enterAgent, name: "talker", sessionId: "agent-talker" }, 3);
		check(lastMessages.length === 2 && lastMessages[0] === "报告写好了，共 12 个问题。" && lastMessages[1] === "汇总完毕。", "最近对话取最后 N 条 assistant 回复（时间正序）");
		check(readAgentLastMessage(root, { ...enterAgent, name: "never-run", sessionId: "never-run" }) === undefined, "无会话文件时最后回复为空");
		// 排序：运行中优先、最新创建在前（/flux agent list 与底部栏一致）
		const sortRoot = mkdtempSync(join(tmpdir(), "flux-sort-"));
		const older = createAgent(sortRoot, { name: "older-one", modelsConfig: { models: {} } });
		const newer = createAgent(sortRoot, { name: "newer-one", modelsConfig: { models: {} } });
		const running = createAgent(sortRoot, { name: "run-now", modelsConfig: { models: {} } });
		const records = [{ ...running, status: "running" as const }, newer, older, { ...older, name: "archived-x", status: "archived" as const }];
		const sorted = sortAgentsByActivity(records);
		check(sorted[0].name === "run-now" && sorted[1].name === "newer-one" && sorted[2].name === "older-one", "排序：运行中最前，其次按 createdAt 最新在前");
		check(formatAgents(records).split("\n")[1].includes("run-now"), "/flux agent list 首行是运行中的 Agent");
		rmSync(sortRoot, { recursive: true, force: true });
		const noSessionCmd = formatAgentSessionCommand(root, { ...enterAgent, name: "never-run", sessionId: "never-run" });
		check(noSessionCmd === undefined, "无会话文件的子代理不输出启动命令");
		// ─── TUI 底部状态行（运行中优先、按创建时间新旧、单行省略）───
		const statusAgents = [
			{ ...createdDefault, name: "old-idle", status: "idle", createdAt: "2026-08-01T00:00:00.000Z" },
			{ ...createdDefault, name: "new-running", status: "running", createdAt: "2026-08-10T00:00:00.000Z" },
			{ ...createdDefault, name: "old-running", status: "running", createdAt: "2026-08-05T00:00:00.000Z" },
			{ ...createdDefault, name: "archived-x", status: "archived", createdAt: "2026-08-12T00:00:00.000Z" },
			{ ...createdDefault, name: "newest-idle", status: "idle", createdAt: "2026-08-12T00:00:00.000Z" },
		];
		const statusLine = formatSubagentStatusLine(statusAgents as any);
		check(statusLine?.startsWith("subagent: new-running - running | old-running - running | newest-idle - idle | old-idle - idle"), "状态行：运行中优先（新的在前），其次按创建时间新旧，archived 排除");
		const manyAgents = Array.from({ length: 30 }, (_, index) => ({ ...createdDefault, name: `agent-${index}`, status: "idle", createdAt: `2026-08-01T00:00:00.${String(index).padStart(3, "0")}Z` }));
		check((formatSubagentStatusLine(manyAgents as any) ?? "").length <= 141, "状态行超长省略（140 字符上限）");
		check(formatSubagentStatusLine([]) === undefined, "无子代理时状态行返回 undefined（footer 清除）");
		// session 作用域与会话结束清理
		const sessionAgent = createAgent(root, { name: "session-scope", scope: "session", ownerSessionId: "ses-1", modelsConfig: { models: {} } });
		check(sessionAgent.scope === "session" && sessionAgent.ownerSessionId === "ses-1", "session 作用域记录 ownerSessionId");
		createAgent(root, { name: "session-other", scope: "session", ownerSessionId: "ses-2", modelsConfig: { models: {} } });
		check(listAgents(root, "ses-1").some(agent => agent.name === "session-scope")
			&& !listAgents(root, "ses-1").some(agent => agent.name === "session-other")
			&& listAgents(root, "ses-2").some(agent => agent.name === "session-other"),
		"session 作用域列表按 ownerSessionId 隔离");
		check(findAgents(root, "session-scope", "ses-2").length === 0 && findAgents(root, "session-scope", "ses-1").length === 1,
		"session 作用域按 name/id 查询按会话隔离");
		const cleaned = deleteSessionAgents(root, "ses-1");
		check(cleaned.includes("session-scope") && !cleaned.includes("session-other"), "会话结束清理本会话的 session Agent（保留其他会话）");
		const afterCleanup = listAgents(root);
		check(!afterCleanup.some(agent => agent.name === "session-scope") && afterCleanup.some(agent => agent.name === "session-other"), "清理后本会话 Agent 消失，其他会话保留");

		// ─── 旧格式记录兼容（2026-08-12 前无 scope/kind 字段）───
		const legacyDir = join(root, ".agentflux", "runtime");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "agents.json"), JSON.stringify({
			version: 2,
			agents: [
				{ id: "agent-legacy-1", name: "stat-agent", kind: "persistent", role: "implementer", status: "idle", model: "flash", callCount: 2, totalCostUsd: 0.0003, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z" },
				{ name: "no-scope-no-status", role: "reviewer" },
			],
		}, null, 2));
		const legacyList = listAgents(root);
		const stat = legacyList.find(agent => agent.name === "stat-agent");
		const bare = legacyList.find(agent => agent.name === "no-scope-no-status");
		check(stat?.scope === "project" && stat?.callCount === 2 && stat?.totalCostUsd === 0.0003, "旧格式记录读取时补默认作用域并保留调用统计");
		check(bare?.scope === "project" && bare?.status === "idle" && bare?.role === "reviewer" && bare?.id === "legacy-no-scope-no-status", "缺 scope/status/id 的记录归一化为默认值");
		check(!formatAgents(legacyList).includes("undefined"), "formatAgents 对旧格式记录不崩溃且无 undefined 占位");
		// ─── 模型/思考等级覆盖 ───
		const modelsConfig = {
			models: {
				"flash-model": { provider: "octopus-completions", contextWindow: 128000, pricing: { input: 0.1, output: 0.2 } },
				"pro-model": { provider: "octopus-anthropic", contextWindow: 128000, pricing: { input: 1, output: 2 } },
			},
		};
		const inheritedCapture = join(root, "main-model-capture.json");
		process.env.AGENTFLUX_TEST_CAPTURE = inheritedCapture;
		const inheritedAgent = createAgent(root, { name: "inherits-main", modelsConfig: { models: {} } });
		const inheritedRun = await runAgentRecord("inherits-main", "inherit main model", {
			cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true,
			defaultModel: "main-selected-model", defaultProvider: "main-selected-provider", invocationOverride,
		});
		const inheritedArgs = JSON.parse(readFileSync(inheritedCapture, "utf-8"));
		check(inheritedRun.exitCode === 0 && inheritedAgent.model === undefined
			&& inheritedArgs.argv.includes("--model") && inheritedArgs.argv.includes("main-selected-model")
			&& inheritedArgs.argv.includes("--provider") && inheritedArgs.argv.includes("main-selected-provider"),
		"未显式指定模型的 Agent 运行时继承 Main 当前模型和 provider，且不写回 Agent 配置");
		const roleDir = join(root, ".agentflux", "agents");
		mkdirSync(roleDir, { recursive: true });
		writeFileSync(join(roleDir, "role-provider.md"), [
			"---",
			"name: role-provider",
			"model: role-selected-model",
			"provider: role-selected-provider",
			"thinking: max",
			"tools: read",
			"---",
			"Use the explicitly configured role model.",
		].join("\n"));
		const roleAgent = createAgent(root, { name: "role-provider-agent", role: "role-provider", modelsConfig: { models: {} } });
		const roleRun = await runAgentRecord("role-provider-agent", "use role model", {
			cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true,
			defaultModel: "main-selected-model", defaultProvider: "main-selected-provider", invocationOverride,
		});
		const roleArgs = JSON.parse(readFileSync(inheritedCapture, "utf-8"));
		check(roleRun.exitCode === 0 && roleAgent.model === "role-selected-model" && roleAgent.provider === "role-selected-provider"
			&& roleArgs.argv.includes("role-selected-model") && roleArgs.argv.includes("role-selected-provider")
			&& !roleArgs.argv.includes("main-selected-model"),
		"角色模板显式模型/provider 优先于 Main 模型继承");
		writeFileSync(join(roleDir, "role-acceptor.md"), [
			"---",
			"name: role-acceptor",
			"model: acceptor-model",
			"provider: acceptor-provider",
			"thinking: low",
			"tools: read",
			"---",
			"Use the acceptance role.",
		].join("\n"));
		const multiRoleAgent = createAgent(root, {
			name: "multi-role-agent", roles: ["role-provider", "role-acceptor"], modelsConfig: { models: {} },
		});
		check(multiRoleAgent.role === "role-provider"
			&& multiRoleAgent.roles?.join(",") === "role-provider,role-acceptor"
			&& multiRoleAgent.model === undefined,
		"同一 Agent 可绑定多个角色且不把首个角色模型固化到身份");
		const acceptanceRun = await runAgentRecord("multi-role-agent", "accept the result", {
			cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true,
			defaultModel: "main-selected-model", defaultProvider: "main-selected-provider", invocationOverride,
		}, undefined, undefined, { role: "role-acceptor" });
		const afterAcceptance = listAgents(root).find(agent => agent.name === "multi-role-agent")!;
		const acceptanceArgs = JSON.parse(readFileSync(inheritedCapture, "utf-8"));
		check(acceptanceRun.exitCode === 0 && acceptanceRun.role === "role-acceptor"
			&& afterAcceptance.lastRole === "role-acceptor" && afterAcceptance.lastResult?.role === "role-acceptor"
			&& acceptanceArgs.argv.includes("acceptor-model") && acceptanceArgs.argv.includes("acceptor-provider")
			&& !acceptanceArgs.argv.includes("main-selected-model"),
		"多角色 Agent 按本次 Run 选择验收角色并使用该角色的模型/provider");
		const planningRun = await runAgentRecord("multi-role-agent", "plan the next change", {
			cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true,
			defaultModel: "main-selected-model", defaultProvider: "main-selected-provider", invocationOverride,
		}, undefined, undefined, { role: "role-provider" });
		const afterPlanning = listAgents(root).find(agent => agent.name === "multi-role-agent")!;
		const planningArgs = JSON.parse(readFileSync(inheritedCapture, "utf-8"));
		check(planningRun.exitCode === 0 && planningRun.role === "role-provider" && afterPlanning.callCount === 2
			&& planningArgs.argv.includes("role-selected-model") && planningArgs.argv.includes("role-selected-provider"),
		"同一 Agent 可再次以规划角色运行并保留独立 Run 统计");
		let unauthorizedRoleRejected = false;
		try { await runAgentRecord("multi-role-agent", "not registered", { cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true, invocationOverride }, undefined, undefined, { role: "tester" }); } catch (error: any) { unauthorizedRoleRejected = /not registered for role tester/.test(String(error?.message ?? "")); }
		check(unauthorizedRoleRejected && listAgents(root).find(agent => agent.name === "multi-role-agent")?.status === "idle",
		"多角色 Agent 拒绝未绑定角色且不污染运行状态");
		const overridden = createAgent(root, { name: "doc-writer", role: "implementer", model: "flash-model", thinking: "off", modelsConfig });
		check(overridden.model === "flash-model" && overridden.thinking === "off" && overridden.provider === "octopus-completions", "create 时 model/thinking 覆盖角色模板并持久化");
		let unknownModelRejected = false;
		try { createAgent(root, { name: "bad-model", model: "no-such-model", modelsConfig }); } catch (error: any) { unknownModelRejected = /Unknown model/.test(String(error?.message ?? "")); }
		check(unknownModelRejected, "未知模型覆盖拒绝创建（fail-closed）");
		let badThinkingRejected = false;
		try { createAgent(root, { name: "bad-thinking", thinking: "ultra" as any, modelsConfig }); } catch (error: any) { badThinkingRejected = /Unknown thinking level/.test(String(error?.message ?? "")); }
		check(badThinkingRejected, "非法思考等级覆盖拒绝创建");
		const coveredRun = await runAgentRecord("doc-writer", "write doc", { cwd: root, modelsConfig, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true, invocationOverride }, undefined, undefined, { model: "pro-model", thinking: "high" });
		const afterCoveredRun = listAgents(root).find(agent => agent.name === "doc-writer")!;
		check(coveredRun.exitCode === 0 && afterCoveredRun.model === "flash-model", "run 时 model/thinking 覆盖仅作用于单次运行，不修改记录");
		let badRunOverrideRejected = false;
		try { await runAgentRecord("doc-writer", "write doc", { cwd: root, modelsConfig, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true, invocationOverride }, undefined, undefined, { model: "nope" }); } catch (error: any) { badRunOverrideRejected = /Unknown model/.test(String(error?.message ?? "")); }
		check(badRunOverrideRejected, "run 时未知模型覆盖拒绝（fail-closed）");
		console.log(`\n${passed} Agent lifecycle checks passed`);
	} finally { delete process.env.AGENTFLUX_TEST_CAPTURE; rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
