/**
 * F3-3 ExperienceStore + F3-4 Step-level routing 测试
 *
 * F3-3 测试:
 *   1. record() 记录经验
 *   2. querySimilar() 查找相似任务
 *   3. suggest() 返回模式推荐
 *   4. importFromTelemetry() 从 telemetry 导入
 *   5. getStats() 统计摘要
 *
 * F3-4 测试:
 *   6. assessStepComplexity() 正确评估步骤复杂度
 *   7. selectModelForStep() 选择最优 model + thinking
 *   8. 预算约束降级
 *   9. planStepModels() 多步骤规划
 */

import { ExperienceStore, formatRecommendation, formatExperienceStats } from "../src/core/experience-store";
import { assessStepComplexity, selectModelForStep, planStepModels, formatStepModelSelection, type StepComplexityInput } from "../src/core/step-router";
import { loadConfig } from "../src/core/config";
import { loadPricing } from "../src/core/pricing";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const CWD = process.cwd();
const FLUX_DIR = join(CWD, ".agentflux");
const TEST_EXP_DIR = join(FLUX_DIR, "runtime", "test-experience");

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`${icon} ${name}: ${detail}`);
}

async function main() {
	console.log("=".repeat(70));
	console.log("F3-3 ExperienceStore + F3-4 Step-level Routing Test");
	console.log("=".repeat(70) + "\n");

	const config = loadConfig(CWD);
	let pricingTable: any = null;
	try {
		pricingTable = await loadPricing(FLUX_DIR, config.pricing, "deepseek-v4-flash");
	} catch (e: any) { console.warn(`Pricing load failed: ${e?.message}`); }

	let modelsConfig: any = null;
	try {
		modelsConfig = JSON.parse(readFileSync(join(FLUX_DIR, "models.json"), "utf-8"));
	} catch {}

	// 清理测试数据
	try { rmSync(join(FLUX_DIR, "runtime", "experience.jsonl")); } catch {}

	// ═══════════════════════════════════════════
	// F3-3: ExperienceStore
	// ═══════════════════════════════════════════

	console.log("--- F3-3: ExperienceStore (feedback loop) ---\n");

	const store = new ExperienceStore(FLUX_DIR);

	// ─── record() 测试 ───
	console.log("  [record]");

	store.record({
		taskType: "bugfix", complexityTier: 1, fileCount: 3, diffLines: 50,
		routedMode: "M2", actualMode: "M2",
		outcome: { success: true, cost: 0.001, latencyMs: 15000, turns: 3, cacheHitRate: 0.85 },
	});
	store.record({
		taskType: "bugfix", complexityTier: 1, fileCount: 2, diffLines: 30,
		routedMode: "M2", actualMode: "M2",
		outcome: { success: true, cost: 0.0008, latencyMs: 12000, turns: 2, cacheHitRate: 0.90 },
	});
	store.record({
		taskType: "bugfix", complexityTier: 1, fileCount: 4, diffLines: 60,
		routedMode: "M1", actualMode: "M1",
		outcome: { success: false, cost: 0.0005, latencyMs: 5000, turns: 1, cacheHitRate: 0.95 },
	});
	store.record({
		taskType: "feature", complexityTier: 2, fileCount: 15, diffLines: 200,
		routedMode: "M4", actualMode: "M4",
		outcome: { success: true, cost: 0.005, latencyMs: 60000, turns: 5, cacheHitRate: 0.70 },
	});
	store.record({
		taskType: "feature", complexityTier: 2, fileCount: 12, diffLines: 180,
		routedMode: "M3", actualMode: "M3",
		outcome: { success: true, cost: 0.003, latencyMs: 45000, turns: 4, cacheHitRate: 0.75 },
	});
	store.record({
		taskType: "feature", complexityTier: 2, fileCount: 18, diffLines: 220,
		routedMode: "M3", actualMode: "M3",
		outcome: { success: true, cost: 0.0028, latencyMs: 40000, turns: 3, cacheHitRate: 0.80 },
	});

	const allRecords = store.loadAll();
	record("record: stores 6 experience records",
		allRecords.length === 6,
		`records=${allRecords.length}`);
	record("record: each record has unique ID",
		new Set(allRecords.map(r => r.id)).size === 6,
		`unique IDs=${new Set(allRecords.map(r => r.id)).size}`);

	// ─── querySimilar() 测试 ───
	console.log("\n  [querySimilar]");

	const similar = store.querySimilar("bugfix", 1, 3);
	record("querySimilar: finds similar bugfix/tier1 records",
		similar.length >= 3,
		`similar records=${similar.length}`);
	record("querySimilar: all results are same taskType",
		similar.every(r => r.signature.taskType === "bugfix"),
		`all bugfix=${similar.every(r => r.signature.taskType === "bugfix")}`);
	record("querySimilar: all results are same complexityTier",
		similar.every(r => r.signature.complexityTier === 1),
		`all tier1=${similar.every(r => r.signature.complexityTier === 1)}`);

	// ─── suggest() 测试 ───
	console.log("\n  [suggest]");

	const recommendation = store.suggest("bugfix", 1, 3);
	console.log("  " + formatRecommendation(recommendation));

	record("suggest: returns recommendation for bugfix/tier1 (3+ samples)",
		recommendation !== null,
		`mode=${recommendation?.mode}, conf=${recommendation?.confidence.toFixed(2)}`);
	record("suggest: recommends M2 (lower cost, 100% success)",
		recommendation?.mode === "M2",
		`recommended=${recommendation?.mode} (M1 failed once, M2 succeeded twice)`);
	record("suggest: has success rate > 0.7",
		(recommendation?.successRate ?? 0) > 0.7,
		`successRate=${recommendation?.successRate.toFixed(2)}`);

	// 不足样本的情况
	const noRec = store.suggest("review", 3, 50);
	record("suggest: returns null for insufficient data",
		noRec === null,
		`result=${noRec}`);

	// feature 也有足够样本
	const featureRec = store.suggest("feature", 2, 15);
	console.log("  " + formatRecommendation(featureRec));
	record("suggest: returns recommendation for feature/tier2",
		featureRec !== null,
		`mode=${featureRec?.mode}`);
	record("suggest: recommends M3 (lower cost than M4)",
		featureRec?.mode === "M3",
		`recommended=${featureRec?.mode} (M3 cost $0.003 < M4 cost $0.005)`);

	// ─── getStats() 测试 ───
	console.log("\n  [getStats]");

	const stats = store.getStats();
	console.log("  " + formatExperienceStats(stats));
	record("getStats: totalRecords = 6",
		stats.totalRecords === 6,
		`total=${stats.totalRecords}`);
	record("getStats: has mode distribution",
		Object.keys(stats.modeDistribution).length >= 2,
		`modes=${Object.entries(stats.modeDistribution).map(([m, c]) => `${m}×${c}`).join(", ")}`);

	// ─── importFromTelemetry() 测试 ───
	console.log("\n  [importFromTelemetry]");

	// 创建测试 telemetry 文件
	const testEventsFile = join(FLUX_DIR, "runtime", "test-events.jsonl");
	const testEvents = [
		{ type: "routing.decision", sessionId: "test-1", payload: { mode: "M2", taskType: "bugfix", complexityTier: 1, fileCount: 5, diffLines: 80 } },
		{ type: "subagent.run", sessionId: "test-1", payload: { cost: 0.0012, latencyMs: 20000, exitCode: 0, cacheHitRate: 0.88 } },
		{ type: "routing.decision", sessionId: "test-2", payload: { mode: "M4", taskType: "refactor", complexityTier: 3, fileCount: 25, diffLines: 500 } },
		{ type: "subagent.run", sessionId: "test-2", payload: { cost: 0.008, latencyMs: 90000, exitCode: 0, cacheHitRate: 0.65 } },
		{ type: "subagent.run", sessionId: "test-2", payload: { cost: 0.003, latencyMs: 45000, exitCode: 0, cacheHitRate: 0.70 } },
	];
	writeFileSync(testEventsFile, testEvents.map(e => JSON.stringify(e)).join("\n") + "\n");

	const imported = store.importFromTelemetry(testEventsFile);
	record("importFromTelemetry: imports 2 routing decisions",
		imported === 2,
		`imported=${imported}`);

	const allAfterImport = store.loadAll();
	record("importFromTelemetry: total records increased",
		allAfterImport.length === 8,
		`total after import=${allAfterImport.length} (was 6)`);

	// 清理
	try { rmSync(testEventsFile); } catch {}

	// ═══════════════════════════════════════════
	// F3-4: Step-level model routing
	// ═══════════════════════════════════════════

	console.log("\n--- F3-4: Step-level model routing ---\n");

	// ─── assessStepComplexity() 测试 ───
	console.log("  [assessStepComplexity]");

	const complexityTests: { input: StepComplexityInput; expected: string }[] = [
		{ input: { taskType: "docs", stepDescription: "Write README", fileCount: 1, diffLines: 10 }, expected: "trivial" },
		{ input: { taskType: "test", stepDescription: "Write unit tests", fileCount: 2, diffLines: 30 }, expected: "simple" },
		{ input: { taskType: "bugfix", stepDescription: "Debug crash", fileCount: 5, diffLines: 80 }, expected: "moderate" },
		{ input: { taskType: "refactor", stepDescription: "Refactor auth module", fileCount: 25, diffLines: 500 }, expected: "complex" },
		{ input: { taskType: "review", stepDescription: "Review PR", fileCount: 10, diffLines: 100, requiresDeepReasoning: true }, expected: "complex" },
		{ input: { taskType: "feature", stepDescription: "Add CRUD endpoint", fileCount: 3, diffLines: 40, isSimpleExecution: true }, expected: "trivial" },
	];

	for (const tc of complexityTests) {
		const result = assessStepComplexity(tc.input);
		const passed = result === tc.expected;
		record(`assessStepComplexity: "${tc.input.stepDescription}" → ${tc.expected}`,
			passed,
			`got=${result}`);
	}

	// ─── selectModelForStep() 测试 ───
	console.log("\n  [selectModelForStep]");

	const models = modelsConfig?.models ?? { "deepseek-v4-flash": { provider: "test", pricing: { input: 9e-8, output: 1.8e-7 }, capability: { reasoning: 0.70, speed: 0.85, coding: 0.78, cost_eff: 0.80 } } };

	// trivial
	const trivialSel = selectModelForStep(
		{ taskType: "docs", stepDescription: "Write README", fileCount: 1, diffLines: 10 },
		models, undefined, pricingTable ?? undefined,
	);
	console.log("  " + formatStepModelSelection(trivialSel));
	record("selectModelForStep: trivial → low thinking",
		trivialSel.thinking === "off" || trivialSel.thinking === "low",
		`thinking=${trivialSel.thinking}`);
	record("selectModelForStep: trivial → has model selected",
		!!trivialSel.model,
		`model=${trivialSel.model}`);

	// complex
	const complexSel = selectModelForStep(
		{ taskType: "refactor", stepDescription: "Refactor auth module", fileCount: 25, diffLines: 500, requiresDeepReasoning: true },
		models, undefined, pricingTable ?? undefined,
	);
	console.log("  " + formatStepModelSelection(complexSel));
	record("selectModelForStep: complex → high thinking",
		complexSel.thinking === "high",
		`thinking=${complexSel.thinking}`);
	record("selectModelForStep: complex → stepComplexity=complex",
		complexSel.stepComplexity === "complex",
		`complexity=${complexSel.stepComplexity}`);

	// moderate
	const moderateSel = selectModelForStep(
		{ taskType: "bugfix", stepDescription: "Debug crash", fileCount: 5, diffLines: 80 },
		models, undefined, pricingTable ?? undefined,
	);
	console.log("  " + formatStepModelSelection(moderateSel));
	record("selectModelForStep: moderate → high thinking (effort compensates)",
		moderateSel.thinking === "high",
		`thinking=${moderateSel.thinking}`);

	// ─── 预算约束测试 ───
	console.log("\n  [budget constraint]");

	const budgetSel = selectModelForStep(
		{ taskType: "refactor", stepDescription: "Complex refactor", fileCount: 25, diffLines: 500, requiresDeepReasoning: true, maxCostPerTask: 0.000001 },
		models, undefined, pricingTable ?? undefined,
	);
	record("selectModelForStep: budget constraint produces selection",
		!!budgetSel.model,
		`model=${budgetSel.model}, reason includes budget=${budgetSel.reason.includes("budget")}`);

	// ─── planStepModels() 测试 ───
	console.log("\n  [planStepModels]");

	const plan = planStepModels(
		[
			{ description: "Analyze the codebase", input: { taskType: "explore", stepDescription: "Read code", fileCount: 5, diffLines: 0 } },
			{ description: "Implement the fix", input: { taskType: "bugfix", stepDescription: "Fix bug", fileCount: 3, diffLines: 50 } },
			{ description: "Review changes", input: { taskType: "review", stepDescription: "Review", fileCount: 5, diffLines: 50, requiresDeepReasoning: true } },
		],
		models, undefined, pricingTable ?? undefined,
	);

	record("planStepModels: produces 3 step plans",
		plan.steps.length === 3,
		`steps=${plan.steps.length}`);
	record("planStepModels: has total estimated cost",
		plan.totalEstimatedCost >= 0,
		`totalCost=$${plan.totalEstimatedCost.toFixed(6)}`);

	for (const step of plan.steps) {
		console.log(`    ${step.description}: ${formatStepModelSelection(step.selection)}`);
	}

	// 验证 review 步骤用 high thinking
	const reviewStep = plan.steps.find(s => s.description.includes("Review"));
	record("planStepModels: review step uses high thinking",
		reviewStep?.selection.thinking === "high",
		`review thinking=${reviewStep?.selection.thinking}`);

	// ─── 清理 ───
	try { rmSync(join(FLUX_DIR, "runtime", "experience.jsonl")); } catch {}

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

	if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("Test error:", e); process.exit(1); });
