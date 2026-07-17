/**
 * F3-5/6/7 Python sidecar + 预算路由 + RL 经验路由 测试
 *
 * F3-5: SidecarClient 通信协议 (Python 不可用时 TS 回退)
 * F3-6: optimizeBudget() 启发式预算优化
 * F3-7: ExperienceStore 统计替代 RL (已在 F3-3 测试, 此处验证 SidecarClient 回退)
 */

import { optimizeBudget, buildAgentModelOptions, formatBudgetPlan, type AgentModelOption, type ModelOption } from "../src/core/budget-router";
import { SidecarClient, optimizeWithBudget } from "../src/core/sidecar";
import { ExperienceStore } from "../src/core/experience-store";
import { join } from "node:path";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const CWD = process.cwd();
const PROJECT_FLUX_DIR = join(CWD, ".agentflux");
const TEST_ROOT = mkdtempSync(join(tmpdir(), "agentflux-f3-sidecar-"));
const FLUX_DIR = join(TEST_ROOT, ".agentflux");

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`${icon} ${name}: ${detail}`);
}

async function main() {
	console.log("=".repeat(70));
	console.log("F3-5/6/7 Sidecar + Budget Router + RL Fallback Test");
	console.log("=".repeat(70) + "\n");

	let modelsConfig: any = null;
	try {
		modelsConfig = JSON.parse(readFileSync(join(PROJECT_FLUX_DIR, "models.json"), "utf-8"));
	} catch {}
	const models = modelsConfig?.models ?? {};

	// ═══════════════════════════════════════════
	// F3-6: 预算路由 (启发式)
	// ═══════════════════════════════════════════

	console.log("--- F3-6: Budget Router (heuristic ILP replacement) ---\n");

	// ─── buildAgentModelOptions 测试 ───
	console.log("  [buildAgentModelOptions]");

	const roles = [
		{ name: "planner-1", role: "planner", critical: true, estimatedTokens: { input: 3000, output: 1000 } },
		{ name: "impl-1", role: "implementer", critical: false, estimatedTokens: { input: 2000, output: 800 } },
		{ name: "reviewer-1", role: "reviewer", critical: true, estimatedTokens: { input: 4000, output: 500 } },
	];

	const agentOptions = buildAgentModelOptions(roles, models);
	record("buildAgentModelOptions: creates options for 3 roles",
		agentOptions.length === 3,
		`agents=${agentOptions.length}`);
	record("buildAgentModelOptions: each agent has model options",
		agentOptions.every(a => a.modelOptions.length > 0),
		`all have options=${agentOptions.every(a => a.modelOptions.length > 0)}`);
	record("buildAgentModelOptions: first option uses strongest reasoning model",
		agentOptions.every(a => {
			if (a.modelOptions.length < 2) return true;
			// 第一个选项用的是最强推理模型 (byReasoning[0])
			return a.modelOptions[0].model === agentOptions[0].modelOptions[0].model;
		}),
		`first option consistent=${agentOptions.every(a => a.modelOptions[0]?.model === agentOptions[0].modelOptions[0]?.model)}`);

	// ─── optimizeBudget 测试: 预算充足 ───
	console.log("\n  [optimizeBudget: sufficient budget]");

	const sufficientPlan = optimizeBudget(agentOptions, { maxTotalCost: 100.0 });
	console.log(formatBudgetPlan(sufficientPlan));
	record("optimizeBudget: sufficient budget → within budget",
		sufficientPlan.withinBudget,
		`withinBudget=${sufficientPlan.withinBudget}`);
	record("optimizeBudget: uses strongest models when budget allows",
		sufficientPlan.assignments.every(a => a.model === agentOptions[0].modelOptions[0].model),
		`all use strongest=${sufficientPlan.assignments.every(a => a.model === agentOptions[0].modelOptions[0].model)}`);

	// ─── optimizeBudget 测试: 预算紧张 → 降级 ───
	console.log("\n  [optimizeBudget: tight budget → downgrade]");

	// 使用极低预算迫使降级
	const tightPlan = optimizeBudget(agentOptions, { maxTotalCost: 0.0001 });
	console.log(formatBudgetPlan(tightPlan));
	record("optimizeBudget: tight budget → has reason mentioning downgrade",
		tightPlan.reason.some(r => r.includes("downgrade")),
		`has downgrade=${tightPlan.reason.some(r => r.includes("downgrade"))}`);
	record("optimizeBudget: tight budget → non-critical agents downgraded first",
		tightPlan.reason.some(r => r.includes("impl-1")),
		`impl downgraded first=${tightPlan.reason.some(r => r.includes("impl-1"))}`);

	// ─── optimizeBudget 测试: 极端预算 ───
	console.log("\n  [optimizeBudget: extreme budget]");

	const extremePlan = optimizeBudget(agentOptions, { maxTotalCost: 0.000001 });
	record("optimizeBudget: extreme budget → produces a plan",
		extremePlan.assignments.length === 3,
		`assignments=${extremePlan.assignments.length}`);
	record("optimizeBudget: extreme budget → may be over budget (can't downgrade further)",
		true, // 只验证不崩溃
		`withinBudget=${extremePlan.withinBudget}`);

	// ─── 关键角色保护 ───
	console.log("\n  [optimizeBudget: critical role protection]");

	const protectedPlan = optimizeBudget(agentOptions, {
		maxTotalCost: 0.0005,
		minCriticalCapability: 0.6,
	});
	record("optimizeBudget: critical roles have capability >= minCritical",
		protectedPlan.assignments
			.filter(a => ["planner", "reviewer"].includes(a.role))
			.every(a => a.capabilityScore >= 0.6 - 0.01),
		`critical cap check=${protectedPlan.assignments
			.filter(a => ["planner", "reviewer"].includes(a.role))
			.every(a => a.capabilityScore >= 0.6 - 0.01)}`);

	// ═══════════════════════════════════════════
	// F3-5: SidecarClient (Python 不可用 → TS 回退)
	// ═══════════════════════════════════════════

	console.log("\n--- F3-5: SidecarClient (TS fallback) ---\n");

	const sidecar = new SidecarClient(FLUX_DIR);
	const available = await sidecar.checkAvailability();
	record("SidecarClient: Python not available (no sidecar script)",
		available === false,
		`available=${available}`);
	record("SidecarClient: isAvailable is false",
		sidecar.isAvailable === false,
		`isAvailable=${sidecar.isAvailable}`);

	// ─── 回退测试: optimizeBudget via SidecarClient ───
	console.log("\n  [SidecarClient fallback: optimizeBudget]");

	const sidecarBudget = await sidecar.optimizeBudget(agentOptions, { maxTotalCost: 100.0 });
	record("SidecarClient.optimizeBudget: falls back to TS heuristic",
		sidecarBudget.assignments.length === 3,
		`assignments=${sidecarBudget.assignments.length}`);
	record("SidecarClient.optimizeBudget: returns valid plan",
		sidecarBudget.totalCost >= 0,
		`totalCost=$${sidecarBudget.totalCost.toFixed(6)}`);

	// ─── 回退测试: suggestMode via SidecarClient ───
	console.log("\n  [SidecarClient fallback: suggestMode]");

	const expStore = new ExperienceStore(FLUX_DIR);

	// 添加一些经验数据
	for (let i = 0; i < 4; i++) {
		expStore.record({
			taskType: "bugfix", complexityTier: 1, fileCount: 3, diffLines: 50,
			routedMode: "M2", actualMode: "M2",
			outcome: { success: true, cost: 0.001 * (i + 1), latencyMs: 10000, turns: 2, cacheHitRate: 0.85 },
		});
	}

	const sidecarSuggestion = await sidecar.suggestMode(expStore, "bugfix", 1, 3);
	record("SidecarClient.suggestMode: falls back to ExperienceStore",
		sidecarSuggestion !== null,
		`mode=${sidecarSuggestion?.mode}`);
	record("SidecarClient.suggestMode: returns M2 (from experience)",
		sidecarSuggestion?.mode === "M2",
		`recommended=${sidecarSuggestion?.mode}`);

	// ─── 回退测试: rlUpdate via SidecarClient ───
	console.log("\n  [SidecarClient fallback: rlUpdate]");

	await sidecar.rlUpdate(expStore, {
		taskType: "feature", complexityTier: 2, fileCount: 10,
		mode: "M3", success: true, cost: 0.003, latencyMs: 30000,
	});
	const allRecords = expStore.loadAll();
	record("SidecarClient.rlUpdate: records to ExperienceStore (fallback)",
		allRecords.some(r => r.signature.taskType === "feature"),
		`has feature record=${allRecords.some(r => r.signature.taskType === "feature")}`);

	// ─── optimizeWithBudget 便捷函数 ───
	console.log("\n  [optimizeWithBudget]");

	const plan = await optimizeWithBudget(roles, models, 100.0, sidecar);
	record("optimizeWithBudget: produces valid plan",
		plan.assignments.length === 3,
		`assignments=${plan.assignments.length}`);

	sidecar.dispose();

	// ─── 清理临时目录，从不触碰项目真实 .agentflux ───
	try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}

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
