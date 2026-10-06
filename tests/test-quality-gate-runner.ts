import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkQualityGate } from "../src/workflows/quality-gate";
import { listAgentRuns, registerAgentRun, finishAgentRun } from "../src/core/run-registry";
import { executeDAG } from "../src/workflows/dag-executor";
import { TelemetryWriter } from "../src/telemetry/events";
import { loadPricing, DEFAULT_PRICING_CONFIG } from "../src/core/pricing";

const root = mkdtempSync(join(tmpdir(), "flux-judge-runner-"));
const helper = resolve("tests/helpers/quality-gate-subagent.cjs");
let count = 0;
const pass = (text: string) => { count++; console.log(`✓ ${text}`); };
const base = (name: string, mode = "valid") => {
	const cwd = join(root, name); mkdirSync(cwd, { recursive: true });
	return { cwd, sessionId: "judge-session", taskId: name, executionId: name, model: "judge-test", provider: "configured-provider", thinking: "max" as const,
		invocationOverride: { command: process.execPath, args: [helper, mode, join(cwd, "spawn.jsonl")] } };
};
try {
	const live = base("online", "online");
	let observed = false;
	const timer = setInterval(() => {
		const r = listAgentRuns(join(live.cwd, ".agentflux"))[0];
		if (r?.status === "running" && r.pid && r.input === 10 && r.costUsd === 0.02) observed = true;
	}, 30);
	const result = await checkQualityGate("marker", ["marker"], live).finally(() => clearInterval(timer));
	assert.ok(result.passed && result.runId && observed);
	const record = listAgentRuns(join(live.cwd, ".agentflux"))[0];
	assert.equal(record.id, result.runId); assert.equal(record.role, "judge"); assert.equal(record.taskId, live.taskId);
	assert.equal(record.executionId, live.executionId); assert.equal(record.status, "completed"); assert.equal(record.costUsd, result.gateCost);
	const receipt = JSON.parse(readFileSync(join(live.cwd, "spawn.jsonl"), "utf8"));
	assert.ok(receipt.argv.includes("--no-session") && receipt.argv.includes("-e"));
	assert.equal(receipt.argv[receipt.argv.indexOf("--thinking") + 1], "max");
	assert.equal(receipt.argv[receipt.argv.indexOf("--provider") + 1], "configured-provider");
	assert.deepEqual(receipt.capability.tools, ["read"]); assert.equal(receipt.capability.communication.enabled, false);
	pass("judge 使用同一 Core Run，在线 PID/usage、父谱系、max 参数、只读能力和一次费用齐全");

	const metadata = base("metadata-native-cost", "online"), metadataDir = join(metadata.cwd, ".agentflux");
	mkdirSync(metadataDir, { recursive: true });
	writeFileSync(join(metadataDir, "models.json"), JSON.stringify({ models: { "judge-test": { provider: "configured-provider", contextWindow: 272000 } } }));
	const metadataPricing = await loadPricing(metadataDir, { ...DEFAULT_PRICING_CONFIG, enable_remote_fetch: false });
	assert.equal(metadataPricing.entries["judge-test"], undefined);
	const priced = await checkQualityGate("marker", ["marker"], { ...metadata, pricing: metadataPricing, parentMaxCostUsd: 0.01 });
	assert.equal(priced.gateCost, 0.02); assert.ok(priced.budgetExceeded);
	assert.equal(listAgentRuns(metadataDir)[0].costUsd, 0.02);
	const noMore = await checkQualityGate("marker", ["marker"], { ...metadata, pricing: metadataPricing, parentMaxCostUsd: 0.01 });
	assert.ok(noMore.budgetExceeded);
	assert.equal(readFileSync(join(metadata.cwd, "spawn.jsonl"), "utf8").trim().split("\n").length, 1);
	pass("模型元数据不冒充零价，原生 usage 成本在线进入父预算，超限后零 spawn");

	for (const kind of ["cost", "turns", "input"] as const) {
		const opts = base(`exhausted-${kind}`), dir = join(opts.cwd, ".agentflux");
		registerAgentRun(dir, { id: "worker", taskId: opts.taskId, executionId: opts.executionId, sessionId: opts.sessionId, agent: "worker", role: "implementer", currentTask: "done", kind: "ephemeral" });
		finishAgentRun(dir, "worker", { status: "completed", costUsd: 1, turns: 2, input: 20 });
		const r = await checkQualityGate("marker", ["marker"], { ...opts, ...(kind === "cost" ? { parentMaxCostUsd: 1 } : kind === "turns" ? { parentMaxTurns: 2 } : { parentMaxInputTokens: 20 }) });
		assert.ok(!r.passed && r.budgetExceeded); assert.equal(existsSync(join(opts.cwd, "spawn.jsonl")), false);
		assert.equal(listAgentRuns(dir).filter(r => r.role === "judge")[0].status, "failed");
	}
	pass("父成本/轮次/token 恰好耗尽时 judge 零 spawn，拒绝保留 Core 终态");

	const concurrent = base("concurrent", "online");
	const pair = await Promise.all([1, 2].map(() => checkQualityGate("marker", ["marker"], { ...concurrent, parentMaxParallel: 1, parentMaxCostUsd: 1 })));
	assert.equal(pair.filter(r => r.passed).length, 1); assert.equal(pair.filter(r => r.budgetExceeded).length, 1);
	assert.equal(readFileSync(join(concurrent.cwd, "spawn.jsonl"), "utf8").trim().split("\n").length, 1);
	assert.equal(pair.find(r => r.budgetExceeded)?.runId, undefined, "未注册的拒绝不返回悬空 Run 引用");
	pass("并发 judge 共用父并发 fence，不各自获得完整并发配额");

	const shared = base("shared-cost", "online");
	const sharedPair = await Promise.all([1, 2].map(() => checkQualityGate("marker", ["marker"], { ...shared, parentMaxCostUsd: 0.03, parentMaxParallel: 2 })));
	assert.ok(sharedPair.some(r => r.budgetExceeded));
	assert.equal(listAgentRuns(join(shared.cwd, ".agentflux")).reduce((sum, r) => sum + r.costUsd, 0), 0.04);
	const blocked = await checkQualityGate("marker", ["marker"], { ...shared, parentMaxCostUsd: 0.03 });
	assert.ok(blocked.budgetExceeded);
	assert.equal(readFileSync(join(shared.cwd, "spawn.jsonl"), "utf8").trim().split("\n").length, 2);
	pass("并发在途费用如实聚合，超过共享父成本后后续 judge 零 spawn，不重置配额");

	const timed = base("deadline", "hang"), parentDeadline = Date.now() + 30000;
	const timeout = await checkQualityGate("marker", ["marker"], { ...timed, deadlineAt: parentDeadline, timeoutMs: 450 });
	assert.ok(timeout.timedOut && !timeout.passed && timeout.deadlineAt! < parentDeadline);
	assert.equal(listAgentRuns(join(timed.cwd, ".agentflux"))[0].status, "timed_out");
	const abort = base("abort", "hang"), controller = new AbortController();
	const abortion = checkQualityGate("marker", ["marker"], { ...abort, signal: controller.signal });
	setTimeout(() => controller.abort(), 450);
	const cancelled = await abortion; assert.ok(cancelled.cancelled && !cancelled.passed);
	assert.equal(listAgentRuns(join(abort.cwd, ".agentflux"))[0].status, "cancelled");
	pass("judge 继承并收窄绝对 deadline，统一 runner 取消/进程终态一致");

	const dag = { description: "judge budget", nodes: [{ id: "one", title: "one", role: "implementer", description: "marker", dependsOn: [], parallelizable: false, acceptanceCriteria: ["marker"], files: [] }] };
	for (const [name, mode, budget, expectedRuns] of [["dag-pass", "valid", 1, 1], ["dag-invalid", "invalid", 1, 2], ["dag-budget", "valid", 0.02, 1]] as const) {
		const opts = base(name, mode);
		const r = await executeDAG(dag, { ...opts, fluxDir: join(opts.cwd, ".agentflux"), modelsConfig: { models: { "judge-test": { provider: "configured-provider", contextWindow: 128000 } }, roles: {} }, telemetry: new TelemetryWriter(join(opts.cwd, ".agentflux")), prefixLayout: true, persistent: false, maxRetries: 0, maxCostUsd: budget,
			invocationOverride: { command: process.execPath, args: [resolve("tests/helpers/successful-subagent.cjs")] }, judgeInvocationOverride: opts.invocationOverride });
		const judges = listAgentRuns(join(opts.cwd, ".agentflux")).filter(r => r.role === "judge");
		assert.equal(judges.length, expectedRuns); assert.equal(new Set(judges.map(r => r.id)).size, expectedRuns);
		assert.equal(r.attemptCostUsd, mode === "invalid" ? 0.04 : 0.02);
		assert.equal(r.status === "passed", name === "dag-pass");
	}
	pass("DAG gate pass/两次不可判定/预算停止，独立 judge Run 与累计费用一致且不重复计费");
	console.log(`${count} groups passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
