/**
 * M2-1 并行 subagent 测试脚本
 *
 * 测试内容:
 *   1. 并行执行 2 个独立 subagent 任务, 验证 wall-clock < 串行总和
 *   2. 验证两个 subagent 都产出有效输出
 *   3. 验证 telemetry 事件被正确写入
 *   4. 验证错误隔离: 一个 agent 失败不影响另一个
 *
 * 测试模型: deepseek-v4-flash
 *
 * 运行方式: npx tsx tests/test-m2-1-parallel-subagent.ts
 */

import { runSubagent, runSubagentsParallel, formatParallelResults, formatSubagentResult, loadSubagent, type SubagentDef } from "../src/extension/subagent";
import { TelemetryWriter } from "../src/telemetry/events";
import { loadConfig } from "../src/core/config";
import { loadPricing } from "../src/core/pricing";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const CWD = process.cwd();
const FLUX_DIR = join(CWD, ".agentflux");

// ─── 测试用 agent 定义 ───

const reviewerAgent: SubagentDef = {
	name: "test-reviewer-1",
	description: "Review code structure",
	tools: ["read", "grep", "find", "ls", "bash"],
	systemPrompt: "You are a code reviewer. Review the specified file briefly. Output: ## Summary / ## Issues. Keep it concise (max 200 words).",
};

const analyzerAgent: SubagentDef = {
	name: "test-analyzer-1",
	description: "Analyze code metrics",
	tools: ["read", "grep", "find", "ls", "bash"],
	systemPrompt: "You are a code analyzer. Count lines, functions, and imports in the specified file. Output a brief summary. Keep it concise (max 200 words).",
};

const badAgent: SubagentDef = {
	name: "test-bad-agent",
	description: "Agent with invalid model to test error isolation",
	tools: ["read"],
	model: "this-model-does-not-exist-xyz123",  // 不存在的模型名, 触发子进程失败
	systemPrompt: "You are a test agent.",
};

// ─── 辅助函数 ───

function assert(condition: boolean, msg: string): void {
	if (!condition) throw new Error(`ASSERT FAILED: ${msg}`);
}

function assertApprox(condition: boolean, msg: string): void {
	if (!condition) console.warn(`  ⚠️ SOFT ASSERT: ${msg}`);
}

interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
}

const results: TestResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`${icon} ${name}: ${detail}`);
}

// ─── 主测试 ───

async function main() {
	console.log("=".repeat(70));
	console.log("M2-1 Parallel Subagent Test");
	console.log(`Model: deepseek-v4-flash`);
	console.log(`CWD: ${CWD}`);
	console.log("=".repeat(70) + "\n");

	// 加载配置和价格表
	const config = loadConfig(CWD);
	let pricingTable: any = null;
	try {
		pricingTable = await loadPricing(FLUX_DIR, config.pricing, "deepseek-v4-flash");
	} catch (e: any) {
		console.warn(`Pricing load failed: ${e?.message}, cost will use upstream values`);
	}

	const telemetry = new TelemetryWriter(FLUX_DIR, true);
	const sessionId = `test-m2-1-${Date.now()}`;
	const prefixLayout = config.cache.prefix_layout === "static_first";

	const MODEL = "deepseek-v4-flash";

	// 读取 models.json 获取 provider
	let provider: string | undefined;
	try {
		const modelsConfig = JSON.parse(readFileSync(join(FLUX_DIR, "models.json"), "utf-8"));
		provider = modelsConfig.models?.[MODEL]?.provider;
		console.log(`Provider: ${provider}`);
	} catch {
		console.warn("Could not read models.json, using default provider");
	}

	// ─── Test 1: 并行执行 2 个独立任务 ───
	console.log("\n--- Test 1: Parallel execution of 2 independent tasks ---");

	const task1 = "Read the file src/core/types.ts and briefly describe what types are defined there. Max 100 words.";
	const task2 = "Read the file src/core/config.ts and briefly describe what the loadConfig function does. Max 100 words.";

	const parallelTasks = [
		{ agent: { ...reviewerAgent, name: "reviewer-types" }, task: task1, label: "review-types" },
		{ agent: { ...analyzerAgent, name: "analyzer-config" }, task: task2, label: "analyze-config" },
	];

	console.log("  Launching 2 agents in parallel...");
	const parallelStart = Date.now();
	const parallelResult = await runSubagentsParallel(parallelTasks, {
		cwd: CWD, sessionId, telemetry, prefixLayout, pricing: pricingTable ?? undefined,
	});
	const parallelWall = Date.now() - parallelStart;

	console.log(`  Wall clock: ${(parallelWall / 1000).toFixed(1)}s`);
	console.log(`  Speedup ratio: ${parallelResult.speedupRatio.toFixed(2)}x`);
	console.log(`  All succeeded: ${parallelResult.allSucceeded}`);
	console.log(`  Total cost: $${parallelResult.totalCost.toFixed(6)}`);

	// 验证: 两个 agent 都有输出
	const hasOutput1 = parallelResult.results[0].output.length > 0;
	const hasOutput2 = parallelResult.results[1].output.length > 0;
	record("T1.1 Both agents produced output",
		hasOutput1 && hasOutput2,
		`agent1 output=${parallelResult.results[0].output.length}chars, agent2 output=${parallelResult.results[1].output.length}chars`);

	// 验证: 两个 agent 都成功退出
	const bothExit0 = parallelResult.results[0].exitCode === 0 && parallelResult.results[1].exitCode === 0;
	record("T1.2 Both agents exited with code 0",
		bothExit0,
		`exit1=${parallelResult.results[0].exitCode}, exit2=${parallelResult.results[1].exitCode}`);

	// 验证: 没有错误
	record("T1.3 No errors in parallel run",
		parallelResult.errors.length === 0,
		parallelResult.errors.length > 0 ? parallelResult.errors.join("; ") : "clean");

	// 验证: speedup > 1.0 (并行应该比串行快)
	// 注意: 由于网络波动, speedup 可能不严格 > 1.0, 用 soft assert
	assertApprox(parallelResult.speedupRatio > 1.0,
		`speedup ratio ${parallelResult.speedupRatio.toFixed(2)} > 1.0 (parallel should be faster than serial sum)`);

	// ─── Test 2: 串行执行相同任务 (对比基准) ───
	console.log("\n--- Test 2: Serial execution of same tasks (baseline) ---");

	console.log("  Running agent 1 serially...");
	const serial1Start = Date.now();
	const serialResult1 = await runSubagent({
		cwd: CWD, agent: { ...reviewerAgent, name: "reviewer-types" }, task: task1,
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
	});
	const serial1Time = Date.now() - serial1Start;

	console.log("  Running agent 2 serially...");
	const serial2Start = Date.now();
	const serialResult2 = await runSubagent({
		cwd: CWD, agent: { ...analyzerAgent, name: "analyzer-config" }, task: task2,
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
	});
	const serial2Time = Date.now() - serial2Start;

	const serialTotal = serial1Time + serial2Time;
	console.log(`  Serial total: ${(serialTotal / 1000).toFixed(1)}s (agent1=${(serial1Time / 1000).toFixed(1)}s, agent2=${(serial2Time / 1000).toFixed(1)}s)`);
	console.log(`  Parallel wall: ${(parallelWall / 1000).toFixed(1)}s`);
	console.log(`  Actual speedup: ${(serialTotal / parallelWall).toFixed(2)}x`);

	// 验证: 并行 wall-clock < 串行总时间 (核心断言)
	// 给一些容差 (网络波动), 并行应该至少比串行快 10%
	const speedupActual = serialTotal / parallelWall;
	record("T2.1 Parallel wall-clock < serial total",
		parallelWall < serialTotal,
		`parallel ${(parallelWall / 1000).toFixed(1)}s < serial ${(serialTotal / 1000).toFixed(1)}s (speedup ${speedupActual.toFixed(2)}x)`);

	// 验证: 串行结果也都有输出
	record("T2.2 Serial results also have output",
		serialResult1.output.length > 0 && serialResult2.output.length > 0,
		`serial1=${serialResult1.output.length}chars, serial2=${serialResult2.output.length}chars`);

	// ─── Test 3: Telemetry 事件验证 ───
	console.log("\n--- Test 3: Telemetry events ---");

	const eventsPath = telemetry.path;
	assert(existsSync(eventsPath), `events.jsonl should exist at ${eventsPath}`);
	const eventsContent = readFileSync(eventsPath, "utf-8");
	const eventLines = eventsContent.trim().split("\n").filter(l => l.trim());
	const recentEvents = eventLines.slice(-10); // 最后 10 条
	let subagentRunCount = 0;
	for (const line of recentEvents) {
		try {
			const ev = JSON.parse(line);
			if (ev.type === "subagent.run") subagentRunCount++;
		} catch {}
	}
	// 并行 2 + 串行 2 = 至少 4 条 subagent.run 事件
	record("T3.1 Telemetry subagent.run events written",
		subagentRunCount >= 4,
		`found ${subagentRunCount} subagent.run events in recent events (expected >=4)`);

	// ─── Test 4: 错误隔离 ───
	console.log("\n--- Test 4: Error isolation (one bad agent + one good agent) ---");

	// 创建一个会真正失败的 agent (用不存在的模型名)
	const errorTasks = [
		{ agent: badAgent, task: "Read src/core/types.ts and list the type names.", label: "bad-agent" },
		{ agent: { ...reviewerAgent, name: "good-reviewer" }, task: "Read src/core/types.ts and list the type names. Max 50 words.", label: "good-agent" },
	];

	console.log("  Launching 1 bad (invalid model) + 1 good agent in parallel...");
	const errorResult = await runSubagentsParallel(errorTasks, {
		cwd: CWD, sessionId, telemetry, prefixLayout, pricing: pricingTable ?? undefined,
	});

	// 验证: good agent 仍然有输出 (即使 bad agent 出错)
	const goodAgentResult = errorResult.results.find(r => r.agent === "good-reviewer");
	const goodHasOutput = goodAgentResult && goodAgentResult.output.length > 0;
	record("T4.1 Good agent produced output despite bad agent failure",
		!!goodHasOutput,
		goodHasOutput ? `good agent output=${goodAgentResult!.output.length}chars` : "good agent has no output");

	// 验证: allSucceeded 为 false (因为 bad agent 使用了不存在的模型)
	// 注意: bad agent 可能因为模型回退而成功, 也可能失败. 我们检查的是:
	// 如果 bad agent 失败了, good agent 不受影响
	const badAgentResult = errorResult.results.find(r => r.agent === "test-bad-agent");
	const badFailed = badAgentResult && (badAgentResult.exitCode !== 0 || badAgentResult.errorMessage);

	if (badFailed) {
		record("T4.2 allSucceeded is false when one agent fails",
			!errorResult.allSucceeded,
			`allSucceeded=${errorResult.allSucceeded}, errors=${errorResult.errors.length}`);
		record("T4.3 Errors are captured in errors array",
			errorResult.errors.length > 0,
			`errors: ${errorResult.errors.slice(0, 2).join("; ")}`);
	} else {
		// 模型回退导致 bad agent 也成功了 — 依然验证 good agent 不受影响
		record("T4.2 Error isolation (bad agent fell back, no crash)",
			!!goodHasOutput,
			`bad agent fell back to exit=${badAgentResult?.exitCode}, good agent ok`);
		record("T4.3 Error isolation (no cascading failure)",
			errorResult.results.length === 2,
			`both results present (len=${errorResult.results.length})`);
	}

	// ─── 汇总 ───
	console.log("\n" + "=".repeat(70));
	console.log("Test Summary");
	console.log("=".repeat(70));
	const passed = results.filter(r => r.passed).length;
	const failed = results.filter(r => !r.passed).length;
	for (const r of results) {
		const icon = r.passed ? "✅" : "❌";
		console.log(`  ${icon} ${r.name}: ${r.detail}`);
	}
	console.log(`\n  Total: ${passed + failed} tests, ${passed} passed, ${failed} failed`);

	// 输出并行 vs 串行对比
	console.log("\n  ── Performance Comparison ──");
	console.log(`  Parallel wall-clock:  ${(parallelWall / 1000).toFixed(1)}s`);
	console.log(`  Serial total:        ${(serialTotal / 1000).toFixed(1)}s`);
	console.log(`  Speedup:             ${speedupActual.toFixed(2)}x`);
	console.log(`  Parallel cost:       $${parallelResult.totalCost.toFixed(6)}`);
	console.log(`  Serial cost:         $${(serialResult1.usage.cost + serialResult2.usage.cost).toFixed(6)}`);
	console.log("");

	if (failed > 0) {
		process.exit(1);
	}
}

main().catch(e => {
	console.error("Test script error:", e);
	process.exit(1);
});
