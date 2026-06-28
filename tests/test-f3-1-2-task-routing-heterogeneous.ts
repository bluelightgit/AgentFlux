/**
 * F3-2 任务级路由 + F3-1 M6 异构团队 测试
 *
 * F3-2 测试:
 *   1. classifyTask() 正确分类各种任务类型
 *   2. analyzeTaskScope() 正确识别 git diff 文件
 *   3. computeTaskComplexity() 正确计算复杂度
 *   4. generateTaskRoutingSignal() 生成完整信号
 *   5. route() 集成 taskRoutingSignal
 *
 * F3-1 测试:
 *   6. createStandardHeterogeneousTeam() 创建异构配置
 *   7. executeHeterogeneousTeam() 执行异构团队
 *   8. 异构成本 vs 同构成本对比
 *
 * 测试模型: deepseek-v4-flash
 */

import {
	classifyTask, analyzeTaskScope, computeTaskComplexity,
	generateTaskRoutingSignal, formatTaskRoutingSignal,
	type TaskType,
} from "../src/core/task-router";
import { route } from "../src/core/routing";
import { DEFAULT_PREFERENCE, type ProjectStage, type Preset } from "../src/core/types";
import {
	createStandardHeterogeneousTeam, executeHeterogeneousTeam, formatHeterogeneousTeamResult,
} from "../src/extension/heterogeneous-team";
import { TelemetryWriter } from "../src/telemetry/events";
import { loadConfig } from "../src/core/config";
import { loadPricing } from "../src/core/pricing";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const CWD = process.cwd();
const FLUX_DIR = join(CWD, ".agentflux");

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`${icon} ${name}: ${detail}`);
}

async function main() {
	console.log("=".repeat(70));
	console.log("F3-1/F3-2 Task-Level Routing + M6 Heterogeneous Team Test");
	console.log(`Model: deepseek-v4-flash`);
	console.log("=".repeat(70) + "\n");

	const config = loadConfig(CWD);
	let pricingTable: any = null;
	try {
		pricingTable = await loadPricing(FLUX_DIR, config.pricing, "deepseek-v4-flash");
	} catch (e: any) {
		console.warn(`Pricing load failed: ${e?.message}`);
	}

	let modelsConfig: any = null;
	try {
		modelsConfig = JSON.parse(readFileSync(join(FLUX_DIR, "models.json"), "utf-8"));
	} catch {}

	// ═══════════════════════════════════════════
	// F3-2: 任务级路由
	// ═══════════════════════════════════════════

	console.log("\n--- F3-2: Task-level routing ---\n");

	// ─── classifyTask 测试 ───
	console.log("  [classifyTask]");

	const testCases: { input: string; expectedType: TaskType }[] = [
		{ input: "Fix the crash in the login handler when password is empty", expectedType: "bugfix" },
		{ input: "Add a new API endpoint for user profile updates", expectedType: "feature" },
		{ input: "Refactor the authentication module to use a strategy pattern", expectedType: "refactor" },
		{ input: "Explore how the routing system works and explain it", expectedType: "explore" },
		{ input: "Review the PR for security issues", expectedType: "review" },
		{ input: "Write unit tests for the config loader", expectedType: "test" },
	];

	for (const tc of testCases) {
		const result = classifyTask(tc.input);
		const passed = result.type === tc.expectedType;
		record(`classifyTask: "${tc.input.slice(0, 40)}..." → ${tc.expectedType}`,
			passed,
			`got=${result.type}, conf=${result.confidence.toFixed(2)}, keywords=[${result.keywords.slice(0, 3).join(",")}]`);
	}

	// 未知类型
	const unknownResult = classifyTask("hello world");
	record("classifyTask: unknown input → type=unknown",
		unknownResult.type === "unknown",
		`type=${unknownResult.type}, conf=${unknownResult.confidence.toFixed(2)}`);

	// 文件引用提取
	const fileResult = classifyTask("Fix the bug in src/core/types.ts and update tests/test-m5.ts");
	record("classifyTask: extracts file references",
		fileResult.mentionedFiles.length >= 1,
		`files=[${fileResult.mentionedFiles.join(", ")}]`);

	// ─── analyzeTaskScope 测试 ───
	console.log("\n  [analyzeTaskScope]");

	const scope = analyzeTaskScope(CWD, ["src/core/types.ts"]);
	record("analyzeTaskScope: returns scope object",
		scope !== null && typeof scope === "object",
		`diffFiles=${scope.diffFiles.length}, diffLines=${scope.diffLines}`);
	record("analyzeTaskScope: relevant files include mentioned files",
		scope.allRelevantFiles.includes("src/core/types.ts"),
		`allRelevantFiles includes mentioned file`);

	// ─── computeTaskComplexity 测试 ───
	console.log("\n  [computeTaskComplexity]");

	const complexity = computeTaskComplexity(CWD, scope);
	record("computeTaskComplexity: returns complexity with tier 0-3",
		complexity.tier >= 0 && complexity.tier <= 3,
		`tier=${complexity.tier}, files=${complexity.fileCount}, coupling=${complexity.coupling.toFixed(2)}`);
	record("computeTaskComplexity: returns recommended mode",
		["M1", "M2", "M3", "M4"].includes(complexity.recommendedMode),
		`mode=${complexity.recommendedMode}`);

	// ─── generateTaskRoutingSignal 测试 ───
	console.log("\n  [generateTaskRoutingSignal]");

	const signal = generateTaskRoutingSignal(CWD, "Fix the bug in src/core/types.ts where the mode definition is incorrect");
	console.log(formatTaskRoutingSignal(signal));

	record("generateTaskRoutingSignal: has classification",
		signal.classification.type !== "unknown",
		`type=${signal.classification.type}`);
	record("generateTaskRoutingSignal: has complexity tier",
		signal.complexity.tier >= 0,
		`tier=${signal.complexity.tier}`);
	record("generateTaskRoutingSignal: has recommended mode",
		["M1", "M2", "M3", "M4", "M5", "M6"].includes(signal.recommendedMode),
		`mode=${signal.recommendedMode}`);
	record("generateTaskRoutingSignal: has confidence > 0",
		signal.confidence > 0,
		`conf=${signal.confidence.toFixed(2)}`);

	// ─── route() 集成测试 ───
	console.log("\n  [route() integration with taskRoutingSignal]");

	const stage: ProjectStage = "Growth";
	const preset: Preset = "balanced";

	// 无 taskRoutingSignal (Phase 2 行为)
	const routeNoSignal = route({ stage, pref: DEFAULT_PREFERENCE, preset });
	record("route() without signal: baseline behavior",
		routeNoSignal.mode !== null,
		`mode=${routeNoSignal.mode}, conf=${routeNoSignal.confidence.toFixed(2)}`);

	// 有 taskRoutingSignal (Phase 3 行为)
	const routeWithSignal = route({ stage, pref: DEFAULT_PREFERENCE, preset, taskRoutingSignal: signal });
	record("route() with signal: accepts taskRoutingSignal",
		routeWithSignal.mode !== null,
		`mode=${routeWithSignal.mode}, conf=${routeWithSignal.confidence.toFixed(2)}`);
	record("route() with signal: confidence >= without signal",
		routeWithSignal.confidence >= routeNoSignal.confidence,
		`with=${routeWithSignal.confidence.toFixed(2)} >= without=${routeNoSignal.confidence.toFixed(2)}`);
	record("route() with signal: reason mentions taskRoutingSignal",
		routeWithSignal.reason.some(r => r.includes("taskRoutingSignal")),
		`reason has taskRoutingSignal: ${routeWithSignal.reason.some(r => r.includes("taskRoutingSignal"))}`);

	// ═══════════════════════════════════════════
	// F3-1: M6 异构团队
	// ═══════════════════════════════════════════

	console.log("\n--- F3-1: M6 Heterogeneous Team ---\n");

	const telemetry = new TelemetryWriter(FLUX_DIR, true);
	const sessionId = `test-f3-${Date.now()}`;
	const prefixLayout = config.cache.prefix_layout === "static_first";
	const MODEL = "deepseek-v4-flash";

	let provider: string | undefined;
	try { provider = modelsConfig?.models?.[MODEL]?.provider; } catch {}

	// ─── createStandardHeterogeneousTeam 测试 ───
	console.log("  [createStandardHeterogeneousTeam]");

	const teamConfig = createStandardHeterogeneousTeam(
		"Read src/core/types.ts and list all type definitions, then summarize what the Mode type is used for.",
		modelsConfig,
		{ strongModel: MODEL, cheapModel: MODEL }, // 只有一个测试模型
	);

	record("createStandardHeterogeneousTeam: has 3 agents",
		teamConfig.agents.length === 3,
		`agents=${teamConfig.agents.length}`);
	record("createStandardHeterogeneousTeam: planner has high thinking",
		teamConfig.agents[0].thinking === "high",
		`planner thinking=${teamConfig.agents[0].thinking}`);
	record("createStandardHeterogeneousTeam: implementer has medium thinking",
		teamConfig.agents[1].thinking === "medium",
		`implementer thinking=${teamConfig.agents[1].thinking}`);
	record("createStandardHeterogeneousTeam: reviewer has high thinking",
		teamConfig.agents[2].thinking === "high",
		`reviewer thinking=${teamConfig.agents[2].thinking}`);
	record("createStandardHeterogeneousTeam: has dependency chain",
		teamConfig.agents[1].dependsOn.includes("hetero-planner") &&
		teamConfig.agents[2].dependsOn.includes("hetero-impl"),
		`planner←impl←reviewer chain`);

	// ─── executeHeterogeneousTeam 测试 ───
	console.log("\n  [executeHeterogeneousTeam]");

	const m6Opts = {
		cwd: CWD, fluxDir: FLUX_DIR, modelsConfig, telemetry, prefixLayout,
		pricing: pricingTable ?? undefined, sessionId,
		sharedSkills: modelsConfig?.sharedSkills ?? [],
	};

	// 使用简化的团队配置 (减少测试时间)
	const simpleTeam = createStandardHeterogeneousTeam(
		"Read src/core/types.ts and list the first 3 type names you find.",
		modelsConfig,
		{ strongModel: MODEL, cheapModel: MODEL },
	);
	// 简化: 去掉 implementer, 只测 planner→reviewer
	simpleTeam.agents = [
		simpleTeam.agents[0], // planner
		simpleTeam.agents[2], // reviewer (depends on planner)
	];
	simpleTeam.agents[1].dependsOn = ["hetero-planner"];
	simpleTeam.maxRetries = 1;

	console.log("  Executing 2-agent heterogeneous team...");
	const teamResult = await executeHeterogeneousTeam(simpleTeam, m6Opts);

	console.log(formatHeterogeneousTeamResult(teamResult));

	record("executeHeterogeneousTeam: completes with results",
		teamResult.agentResults.size === 2,
		`agents=${teamResult.agentResults.size}`);
	record("executeHeterogeneousTeam: has total cost > 0",
		teamResult.totalCost > 0,
		`cost=$${teamResult.totalCost.toFixed(6)}`);
	record("executeHeterogeneousTeam: has wall clock time",
		teamResult.wallClockMs > 0,
		`wall=${(teamResult.wallClockMs / 1000).toFixed(1)}s`);
	record("executeHeterogeneousTeam: has model usage report",
		Object.keys(teamResult.modelUsage).length > 0,
		`models=${Object.entries(teamResult.modelUsage).map(([m, c]) => `${m}×${c}`).join(", ")}`);
	record("executeHeterogeneousTeam: has cost savings report",
		teamResult.costSavings !== null && typeof teamResult.costSavings.savings === "number",
		`savings=${teamResult.costSavings.savings}%`);

	// 验证 planner 在 reviewer 之前执行 (拓扑序)
	const plannerResult = teamResult.agentResults.get("hetero-planner");
	const reviewerResult = teamResult.agentResults.get("hetero-reviewer");
	record("executeHeterogeneousTeam: planner produces output",
		!!plannerResult && plannerResult.result.output.length > 0,
		`planner output=${plannerResult?.result.output.length}chars`);
	record("executeHeterogeneousTeam: reviewer produces output",
		!!reviewerResult && reviewerResult.result.output.length > 0,
		`reviewer output=${reviewerResult?.result.output.length}chars`);

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
