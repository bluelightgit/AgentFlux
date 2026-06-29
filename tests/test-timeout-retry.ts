/**
 * Subagent 超时+重试机制测试
 *
 * 验证:
 *   T1: 正常执行不受影响 (exitCode=0, retryCount=0)
 *   T2: 超时触发自动重试 (用极短 timeoutMs 模拟)
 *   T3: 进程失败触发自动重试 (用不存在的模型)
 *   T4: 达到最大重试后返回失败结果
 *   T5: retryCount 字段正确记录在结果中
 *   T6: 并行执行也支持重试
 */

import { runSubagent, runSubagentsParallel, formatSubagentResult, type SubagentDef } from "../src/extension/subagent";
import { TelemetryWriter } from "../src/telemetry/events";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const CWD = process.cwd();
const FLUX_DIR = join(CWD, ".agentflux");
const MODEL = "deepseek-v4-flash";

// Load models config for provider
let provider: string | undefined;
try {
	const mc = JSON.parse(readFileSync(join(FLUX_DIR, "models.json"), "utf-8"));
	provider = mc.models?.[MODEL]?.provider;
} catch {}

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`  ${icon} ${name}: ${detail}`);
}

async function main() {
	console.log("=".repeat(70));
	console.log("Subagent Timeout + Retry Test");
	console.log(`Model: ${MODEL}`);
	console.log("=".repeat(70));

	const telemetry = new TelemetryWriter(FLUX_DIR, true);
	const sessionId = `retry-test-${Date.now()}`;

	const goodAgent: SubagentDef = {
		name: "retry-test-good",
		description: "Simple reader",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: "You are a code reader. Be concise.",
		thinking: "off",
	};

	// ═══════════════════════════════════════════
	// T1: 正常执行
	// ═══════════════════════════════════════════
	console.log("\n📋 T1: Normal execution (no retry needed)\n");

	const r1 = await runSubagent({
		cwd: CWD, agent: goodAgent,
		task: "Read src/core/types.ts and list the first 3 type names. One per line.",
		sessionId, telemetry, prefixLayout: true,
		model: MODEL, provider,
		timeoutMs: 120000, maxRetries: 2,
	});

	record("T1: exit code 0",
		r1.exitCode === 0,
		`exit=${r1.exitCode}`);
	record("T1: retryCount is 0 (first attempt succeeded)",
		r1.retryCount === 0,
		`retryCount=${r1.retryCount}`);
	record("T1: produces output",
		r1.output.length > 0,
		`output=${r1.output.length} chars`);

	// ═══════════════════════════════════════════
	// T2: 超时触发自动重试
	// ═══════════════════════════════════════════
	console.log("\n⏱️  T2: Timeout triggers auto-retry\n");

	// 用 1ms 超时强制超时 (进程刚启动就被 SIGKILL)
	const r2 = await runSubagent({
		cwd: CWD, agent: goodAgent,
		task: "Read src/core/types.ts and list the first 3 type names.",
		sessionId, telemetry, prefixLayout: true,
		model: MODEL, provider,
		timeoutMs: 1,         // 1ms — 立即超时
		maxRetries: 2,
		retryDelayMs: 100,    // 短延迟加速测试
	});

	console.log(`  exitCode=${r2.exitCode}, retryCount=${r2.retryCount}, errorMessage=${r2.errorMessage?.slice(0, 80)}`);

	record("T2: exitCode is 124 (timeout) after all retries exhausted",
		r2.exitCode === 124,
		`exitCode=${r2.exitCode}`);
	record("T2: retryCount reflects retries attempted",
		r2.retryCount !== undefined && r2.retryCount > 0,
		`retryCount=${r2.retryCount}`);

	// ═══════════════════════════════════════════
	// T3: 进程失败触发自动重试 (不存在的模型)
	// ═══════════════════════════════════════════
	console.log("\n❌ T3: Process failure triggers auto-retry\n");

	const badAgent: SubagentDef = {
		...goodAgent,
		name: "retry-test-bad",
		model: "this-model-does-not-exist-xyz123",
	};

	const r3 = await runSubagent({
		cwd: CWD, agent: badAgent,
		task: "This should fail because the model doesn't exist.",
		sessionId, telemetry, prefixLayout: true,
		model: "this-model-does-not-exist-xyz123",
		provider,
		timeoutMs: 30000, maxRetries: 1,
		retryDelayMs: 100,
	});

	console.log(`  exitCode=${r3.exitCode}, retryCount=${r3.retryCount}, errorMessage=${r3.errorMessage?.slice(0, 80)}`);

	record("T3: has errorMessage (model not found)",
		!!r3.errorMessage && /not found|404/i.test(r3.errorMessage),
		`error=${r3.errorMessage?.slice(0, 50)}`);
	record("T3: retryCount >= 1 (retried due to model error)",
		(r3.retryCount ?? 0) >= 1,
		`retryCount=${r3.retryCount}`);

	// ═══════════════════════════════════════════
	// T4: maxRetries=0 时不重试
	// ═══════════════════════════════════════════
	console.log("\n🚫 T4: maxRetries=0 means no retry\n");

	const r4 = await runSubagent({
		cwd: CWD, agent: badAgent,
		task: "This should fail without retry.",
		sessionId, telemetry, prefixLayout: true,
		model: "this-model-does-not-exist-xyz123",
		provider,
		timeoutMs: 30000, maxRetries: 0,
	});

	record("T4: has errorMessage (model not found)",
		!!r4.errorMessage,
		`error=${r4.errorMessage?.slice(0, 50)}`);
	record("T4: retryCount is 0 (no retries despite error)",
		r4.retryCount === 0,
		`retryCount=${r4.retryCount}`);

	// ═══════════════════════════════════════════
	// T5: formatSubagentResult 显示重试信息
	// ═══════════════════════════════════════════
	console.log("\n📝 T5: Format output includes retry info\n");

	const formattedWithRetry = formatSubagentResult({ ...r3, retryCount: 2 });
	record("T5: formatted output includes 'retries=' when retryCount > 0",
		formattedWithRetry.includes("retries=2"),
		`has retries=2: ${formattedWithRetry.includes("retries=2")}`);

	const formattedNoRetry = formatSubagentResult(r1);
	record("T5: formatted output excludes retry info when retryCount = 0",
		!formattedNoRetry.includes("retries="),
		`has no retries: ${!formattedNoRetry.includes("retries=")}`);

	// ═══════════════════════════════════════════
	// T6: 并行执行支持重试
	// ═══════════════════════════════════════════
	console.log("\n🔀 T6: Parallel execution with retry\n");

	const parallelResult = await runSubagentsParallel(
		[
			{ agent: goodAgent, task: "List 2 type names from src/core/types.ts.", label: "good" },
			{ agent: badAgent, task: "This will fail.", label: "bad" },
		],
		{
			cwd: CWD, sessionId, telemetry, prefixLayout: true,
			timeoutMs: 60000, maxRetries: 1,
		},
	);

	record("T6: parallel result has 2 entries",
		parallelResult.results.length === 2,
		`results=${parallelResult.results.length}`);
	record("T6: good agent succeeded despite bad agent failing",
		parallelResult.results[0].exitCode === 0,
		`good exit=${parallelResult.results[0].exitCode}`);
	record("T6: bad agent failed with retryCount >= 1",
		parallelResult.results[1].exitCode !== 0 && (parallelResult.results[1].retryCount ?? 0) >= 1,
		`bad exit=${parallelResult.results[1].exitCode}, retries=${parallelResult.results[1].retryCount}`);
	record("T6: error isolation (not all failed)",
		parallelResult.allSucceeded === false,
		`allSucceeded=${parallelResult.allSucceeded}`);

	// ═══════════════════════════════════════════
	// T7: telemetry 记录 retryCount
	// ═══════════════════════════════════════════
	console.log("\n📊 T7: Telemetry records retryCount\n");

	const events = readFileSync(join(FLUX_DIR, "events.jsonl"), "utf-8")
		.split("\n").filter(Boolean).map(l => JSON.parse(l));
	const recentSubagentEvents = events.filter(e => e.type === "subagent.run").slice(-6);
	const hasRetryField = recentSubagentEvents.some(e => e.retryCount !== undefined);
	const hasNonZeroRetry = recentSubagentEvents.some(e => (e.retryCount ?? 0) > 0);

	record("T7: telemetry events have retryCount field",
		hasRetryField,
		`has field=${hasRetryField}`);
	record("T7: at least one event has retryCount > 0",
		hasNonZeroRetry,
		`has non-zero=${hasNonZeroRetry}`);

	// ═══════════════════════════════════════════
	// 汇总
	// ═══════════════════════════════════════════
	console.log("\n" + "=".repeat(70));
	console.log("Timeout + Retry Test Summary");
	console.log("=".repeat(70));

	const passed = results.filter(r => r.passed).length;
	const failed = results.filter(r => !r.passed).length;

	for (const r of results) {
		const icon = r.passed ? "✅" : "❌";
		console.log(`  ${icon} ${r.name}: ${r.detail}`);
	}

	console.log(`\n  Total: ${passed + failed} tests, ${passed} passed, ${failed} failed`);

	if (failed > 0) {
		console.log("\n  ❌ FAILED TESTS:");
		for (const r of results.filter(r => !r.passed)) {
			console.log(`    ${r.name}`);
		}
		process.exit(1);
	} else {
		console.log("\n  ✅ ALL TESTS PASSED");
	}
}

main().catch(e => { console.error("Test error:", e); process.exit(1); });
