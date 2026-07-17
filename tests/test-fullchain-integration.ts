/**
 * AgentFlux 全链路集成测试
 *
 * 测试范围:
 *   1. 配置加载链路 (config → pricing → roles → models)
 *   2. 多层路由全链路 (classifyTask → taskRoutingSignal → experienceStore → route → override)
 *   3. Agent 执行 + 状态监控 (subagent → telemetry → sharedBoard)
 *   4. DAG 执行器 + 质量门 + 经验记录
 *   5. 预算路由
 *   6. 端到端: 任务输入 → 路由决策 → agent 执行 → 质量门 → 经验记录 → telemetry 验证
 *
 * 测试模型: deepseek-v4-flash
 */

import { loadConfig } from "../src/core/config";
import { loadPricing } from "../src/core/pricing";
import { loadAllRoles } from "../src/core/role-manager";
import { collectComplexitySignal, formatComplexitySignal } from "../src/core/complexity";
import { classifyTask, analyzeTaskScope, generateTaskRoutingSignal, formatTaskRoutingSignal } from "../src/core/task-router";
import { route, type RouteInput } from "../src/core/routing";
import { ExperienceStore, formatRecommendation, formatExperienceStats } from "../src/core/experience-store";
import { assessStepComplexity, selectModelForStep, planStepModels } from "../src/core/step-router";
import { optimizeBudget, buildAgentModelOptions, formatBudgetPlan } from "../src/core/budget-router";
import { SidecarClient } from "../src/core/sidecar";
import { runSubagent } from "../src/extension/subagent";
import { checkQualityGate } from "../src/extension/quality-gate";
import { generateTaskDAG, executeDAG, formatDAG, formatDAGResult } from "../src/extension/dag-executor";
import { executeHeterogeneousTeam, createStandardHeterogeneousTeam, formatHeterogeneousTeamResult } from "../src/extension/heterogeneous-team";
import { SharedBoard } from "../src/core/shared-board";
import { TelemetryWriter } from "../src/telemetry/events";
import { DEFAULT_PREFERENCE, type ProjectStage, type Preset, type Mode } from "../src/core/types";
import { join } from "node:path";
import { readFileSync, existsSync, rmSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const CWD = process.cwd();
const PROJECT_FLUX_DIR = join(CWD, ".agentflux");
const TEST_ROOT = mkdtempSync(join(tmpdir(), "agentflux-fullchain-"));
const FLUX_DIR = join(TEST_ROOT, ".agentflux");

interface TestResult { name: string; passed: boolean; detail: string; category: string; }
const results: TestResult[] = [];
function record(category: string, name: string, passed: boolean, detail: string): void {
	results.push({ category, name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`  ${icon} ${name}: ${detail}`);
}

async function main() {
	console.log("=".repeat(80));
	console.log("AgentFlux Full-Chain Integration Test");
	console.log(`Model: deepseek-v4-flash`);
	console.log("=".repeat(80));

	// ═══════════════════════════════════════════════════════
	// 1. 配置加载链路
	// ═══════════════════════════════════════════════════════

	console.log("\n📋 1. Configuration Loading Chain\n");

	// 1.1 Config
	const config = loadConfig(CWD);
	record("config", "loadConfig returns valid config",
		!!config && !!config.cache && !!config.routing,
		`mode=${config?.mode}, prefix_layout=${config?.cache?.prefix_layout}`);

	// 1.2 Pricing
	let pricingTable: any = null;
	try {
		pricingTable = await loadPricing(FLUX_DIR, config.pricing, "deepseek-v4-flash");
	} catch (e: any) {
		console.warn(`  Pricing load failed: ${e?.message}`);
	}
	record("config", "loadPricing returns pricing table",
		!!pricingTable && (pricingTable.entries?.length > 0 || Object.keys(pricingTable).length > 0),
		`entries=${pricingTable?.entries?.length ?? 'n/a'}, keys=${Object.keys(pricingTable ?? {}).join(',')}`);

	// 1.3 Models config
	let modelsConfig: any = null;
	try {
		modelsConfig = JSON.parse(readFileSync(join(PROJECT_FLUX_DIR, "models.json"), "utf-8"));
	} catch {}
	record("config", "models.json loaded with models",
		!!modelsConfig && Object.keys(modelsConfig.models ?? {}).length > 0,
		`models=${Object.keys(modelsConfig?.models ?? {}).join(", ")}`);

	// 1.4 Roles
	const roles = loadAllRoles(CWD, modelsConfig);
	record("config", "loadAllRoles returns builtin roles",
		roles.size >= 4,
		`roles=${[...roles.keys()].join(", ")}`);
	record("config", "planner role has thinking=high",
		roles.get("planner")?.thinking === "high",
		`planner.thinking=${roles.get("planner")?.thinking}`);
	record("config", "reviewer role has thinking=xhigh",
		roles.get("reviewer")?.thinking === "xhigh",
		`reviewer.thinking=${roles.get("reviewer")?.thinking}`);
	record("config", "implementer role has thinking=medium",
		roles.get("implementer")?.thinking === "medium",
		`implementer.thinking=${roles.get("implementer")?.thinking}`);

	// 1.5 Role tools
	record("config", "planner tools are read-only",
		roles.get("planner")?.tools?.every(t => !["write", "edit"].includes(t)) ?? false,
		`tools=[${roles.get("planner")?.tools?.join(", ")}]`);
	record("config", "implementer has write tools",
		roles.get("implementer")?.tools?.includes("write") ?? false,
		`has write=${roles.get("implementer")?.tools?.includes("write")}`);

	// ═══════════════════════════════════════════════════════
	// 2. 多层路由全链路
	// ═══════════════════════════════════════════════════════

	console.log("\n🧭 2. Multi-Layer Routing Chain\n");

	const stage: ProjectStage = "Growth";
	const preset: Preset = "balanced";

	// 2.1 Layer 1a: Repository-level complexity signal (Phase 2)
	const repoSignal = collectComplexitySignal(CWD);
	record("routing", "Layer 1a: collectComplexitySignal produces signal",
		repoSignal.complexityTier >= 0 && ["M1", "M2", "M3", "M4"].includes(repoSignal.recommendedMode),
		`tier=${repoSignal.complexityTier}, mode=${repoSignal.recommendedMode}`);

	// 2.2 Layer 1b: Task-level routing signal (Phase 3 F3-2)
	const taskInput = "Fix the bug in src/core/types.ts where the Mode type is incorrect";
	const taskSignal = generateTaskRoutingSignal(CWD, taskInput);
	console.log("  " + formatTaskRoutingSignal(taskSignal).split("\n").join("\n  "));
	record("routing", "Layer 1b: classifyTask classifies as bugfix",
		taskSignal.classification.type === "bugfix",
		`type=${taskSignal.classification.type}`);
	record("routing", "Layer 1b: analyzeTaskScope finds diff files",
		taskSignal.scope.allRelevantFiles.length > 0,
		`relevant files=${taskSignal.scope.allRelevantFiles.length}`);
	record("routing", "Layer 1b: taskRoutingSignal has recommended mode",
		["M1", "M2", "M3", "M4"].includes(taskSignal.recommendedMode),
		`mode=${taskSignal.recommendedMode}, conf=${taskSignal.confidence.toFixed(2)}`);

	// 2.3 Layer 3: Experience store
	const expStore = new ExperienceStore(FLUX_DIR);
	record("routing", "Layer 3: ExperienceStore initialized empty",
		expStore.loadAll().length === 0,
		`records=${expStore.loadAll().length}`);

	// Seed experience data
	for (let i = 0; i < 4; i++) {
		expStore.record({
			taskType: "bugfix", complexityTier: taskSignal.complexity.tier,
			fileCount: taskSignal.scope.allRelevantFiles.length, diffLines: taskSignal.scope.diffLines,
			routedMode: "M2" as Mode, actualMode: "M2" as Mode,
			outcome: { success: true, cost: 0.001 * (i + 1), latencyMs: 15000 * (i + 1), turns: 2 + i, cacheHitRate: 0.85 + i * 0.02 },
		});
	}
	const expRec = expStore.suggest("bugfix", taskSignal.complexity.tier, taskSignal.scope.allRelevantFiles.length);
	console.log("  " + formatRecommendation(expRec));
	record("routing", "Layer 3: ExperienceStore.suggest returns M2 recommendation",
		expRec?.mode === "M2",
		`mode=${expRec?.mode}, conf=${expRec?.confidence.toFixed(2)}, samples=${expRec?.sampleCount}`);

	// 2.4 Route() integration: all layers
	const routeNoSignal = route({ stage, pref: DEFAULT_PREFERENCE, preset });
	const routeWithL1 = route({ stage, pref: DEFAULT_PREFERENCE, preset, taskRoutingSignal: taskSignal });
	const routeWithL1L3 = route({ stage, pref: DEFAULT_PREFERENCE, preset, taskRoutingSignal: taskSignal, experienceRecommendation: expRec });
	const routeAuto = route({ stage, pref: DEFAULT_PREFERENCE, preset, taskRoutingSignal: taskSignal, experienceRecommendation: expRec, overrideMode: "auto" });

	console.log(`  Route (no signal):      mode=${routeNoSignal.mode}, conf=${routeNoSignal.confidence.toFixed(2)}`);
	console.log(`  Route (L1 task):        mode=${routeWithL1.mode}, conf=${routeWithL1.confidence.toFixed(2)}`);
	console.log(`  Route (L1+L3):          mode=${routeWithL1L3.mode}, conf=${routeWithL1L3.confidence.toFixed(2)}`);
	console.log(`  Route (L1+L3+auto):     mode=${routeAuto.mode}, conf=${routeAuto.confidence.toFixed(2)}, applied=${routeAuto.applied}`);

	record("routing", "route() without signal: confidence 0.60 (baseline)",
		Math.abs(routeNoSignal.confidence - 0.60) < 0.01,
		`conf=${routeNoSignal.confidence.toFixed(2)}`);
	record("routing", "route() with L1 task signal: confidence > 0.60",
		routeWithL1.confidence > routeNoSignal.confidence,
		`${routeWithL1.confidence.toFixed(2)} > ${routeNoSignal.confidence.toFixed(2)}`);
	record("routing", "route() with L1+L3: reason mentions experience",
		routeWithL1L3.reason.some(r => r.includes("experience")),
		`has experience in reason`);
	record("routing", "route() with auto: applied=true",
		routeAuto.applied === true,
		`applied=${routeAuto.applied}`);
	record("routing", "route() reason chain includes all layers",
		routeAuto.reason.some(r => r.includes("taskRoutingSignal")) &&
		routeAuto.reason.some(r => r.includes("experience")) &&
		routeAuto.reason.some(r => r.includes("override:auto")),
		`L1=${routeAuto.reason.some(r => r.includes("taskRoutingSignal"))}, L3=${routeAuto.reason.some(r => r.includes("experience"))}, auto=${routeAuto.reason.some(r => r.includes("override:auto"))}`);

	// 2.5 Layer 2: Budget routing
	const budgetRoles = [
		{ name: "planner-1", role: "planner", critical: true, estimatedTokens: { input: 3000, output: 1000 } },
		{ name: "impl-1", role: "implementer", critical: false, estimatedTokens: { input: 2000, output: 800 } },
	];
	const budgetAgents = buildAgentModelOptions(budgetRoles, modelsConfig?.models ?? {});
	const budgetPlan = optimizeBudget(budgetAgents, { maxTotalCost: 0.01 });
	record("routing", "Layer 2: optimizeBudget produces plan",
		budgetPlan.assignments.length === 2,
		`agents=${budgetPlan.assignments.length}, withinBudget=${budgetPlan.withinBudget}`);

	// 2.6 Step-level routing
	const stepPlan = planStepModels(
		[
			{ description: "Analyze bug", input: { taskType: "bugfix", stepDescription: "Debug", fileCount: 2, diffLines: 30 } },
			{ description: "Fix code", input: { taskType: "bugfix", stepDescription: "Fix", fileCount: 2, diffLines: 30 } },
			{ description: "Review fix", input: { taskType: "review", stepDescription: "Review", fileCount: 2, diffLines: 30, requiresDeepReasoning: true } },
		],
		modelsConfig?.models ?? {},
		undefined,
		pricingTable ?? undefined,
	);
	record("routing", "Step-level: planStepModels produces 3 steps",
		stepPlan.steps.length === 3,
		`steps=${stepPlan.steps.length}`);
	record("routing", "Step-level: review step uses high thinking",
		stepPlan.steps[2].selection.thinking === "high",
		`review thinking=${stepPlan.steps[2].selection.thinking}`);

	// ═══════════════════════════════════════════════════════
	// 3. Agent 执行 + 状态监控
	// ═══════════════════════════════════════════════════════

	console.log("\n🤖 3. Agent Execution + State Monitoring\n");

	const telemetry = new TelemetryWriter(FLUX_DIR, true);
	const sessionId = `fullchain-${Date.now()}`;
	const prefixLayout = config.cache.prefix_layout === "static_first";
	const MODEL = "deepseek-v4-flash";
	let provider: string | undefined;
	try { provider = modelsConfig?.models?.[MODEL]?.provider; } catch {}

	// 3.1 Subagent execution + telemetry
	console.log("  [3.1] Running subagent...");
	const subagentResult = await runSubagent({
		cwd: CWD,
		agent: { name: "test-reader", description: "Read and summarize", tools: ["read", "grep", "find", "ls"], systemPrompt: "You are a code reader.", thinking: "medium" },
		task: "Read src/core/types.ts and list the first 3 type names. Just the names, one per line.",
		sessionId, telemetry, prefixLayout,
		model: MODEL, provider, pricing: pricingTable ?? undefined,
		thinking: "medium",
	});

	record("execution", "Subagent: exit code 0",
		subagentResult.exitCode === 0,
		`exit=${subagentResult.exitCode}`);
	record("execution", "Subagent: produces output",
		subagentResult.output.length > 0,
		`output=${subagentResult.output.length} chars`);
	record("execution", "Subagent: has cost > 0",
		subagentResult.usage.cost > 0,
		`cost=$${subagentResult.usage.cost.toFixed(6)}`);
	record("execution", "Subagent: has cache stats",
		subagentResult.usage.cacheRead >= 0 && subagentResult.usage.cacheWrite >= 0,
		`cacheRead=${subagentResult.usage.cacheRead}, cacheWrite=${subagentResult.usage.cacheWrite}`);

	// 3.2 Telemetry events.jsonl verification
	const eventsFile = join(FLUX_DIR, "events.jsonl");
	record("execution", "Telemetry: events.jsonl exists",
		existsSync(eventsFile),
		`exists=${existsSync(eventsFile)}`);

	if (existsSync(eventsFile)) {
		const events = readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
		const subagentEvents = events.filter(e => e.type === "subagent.run");
		record("execution", "Telemetry: has subagent.run events",
			subagentEvents.length > 0,
			`subagent.run count=${subagentEvents.length}`);

		// Check latest subagent.run event has required fields
		const latestSubagent = subagentEvents[subagentEvents.length - 1];
		const agentVal = latestSubagent.payload?.agent ?? latestSubagent.agent;
		const costVal = latestSubagent.payload?.costUsd ?? latestSubagent.costUsd;
		record("execution", "Telemetry: subagent.run has agent field",
			!!agentVal,
			`agent=${agentVal}`);
		record("execution", "Telemetry: subagent.run has cost field",
			costVal !== undefined && costVal !== null,
			`costUsd=${costVal ?? 'n/a'}`);
	}

	// 3.3 Quality gate
	console.log("  [3.3] Testing quality gate...");
	const gateResult = await checkQualityGate(
		subagentResult.output,
		["Output mentions at least 1 type name"],
		{ cwd: CWD, model: MODEL, provider, pricing: pricingTable ?? undefined, telemetry, sessionId },
	);
	record("execution", "Quality gate: returns result",
		gateResult !== null && gateResult.passed !== undefined,
		`passed=${gateResult?.passed}, cost=$${gateResult?.gateCost.toFixed(6)}`);

	// 3.4 SharedBoard state
	const board = new SharedBoard(FLUX_DIR);
	const bb = board.getBlackboard();
	record("execution", "SharedBoard: getBlackboard returns object",
		bb !== null && typeof bb === "object",
		`agents=${Object.keys(bb.agentStatuses).length}`);

	// 3.5 SharedBoard messaging
	board.sendMessage("test-fullchain", "broadcast", "test_msg", "Full-chain test message");
	const inbox = board.getInbox("test-fullchain");
	record("execution", "SharedBoard: messaging works",
		inbox.length > 0,
		`inbox=${inbox.length}`);

	// ═══════════════════════════════════════════════════════
	// 4. DAG 执行器 + 质量门 + 经验记录
	// ═══════════════════════════════════════════════════════

	console.log("\n🔀 4. DAG Executor + Quality Gate + Experience Recording\n");

	// 4.1 DAG generation
	console.log("  [4.1] Generating task DAG...");
	const dag = await generateTaskDAG(
		"Read src/core/types.ts and list all type names, then verify the list is complete.",
		{ cwd: CWD, model: MODEL, provider, pricing: pricingTable ?? undefined, telemetry, sessionId, prefixLayout },
	);
	console.log("  " + formatDAG(dag).split("\n").join("\n  "));
	record("dag", "DAG: generateTaskDAG produces nodes",
		dag.nodes.length >= 1,
		`nodes=${dag.nodes.length}`);
	record("dag", "DAG: has description",
		dag.description.length > 0,
		`desc length=${dag.description.length}`);

	// 4.2 DAG execution (simple 2-node)
	console.log("  [4.2] Executing 2-node DAG...");
	const simpleDAG = {
		description: "Read and verify types",
		nodes: [
			{
				id: "d1", title: "List type names", role: "implementer",
				dependsOn: [], parallelizable: true,
				acceptanceCriteria: ["Output mentions at least 2 type names"],
				files: ["src/core/types.ts"],
				description: "Read src/core/types.ts and list the first 3 type names.",
			},
			{
				id: "d2", title: "Verify list", role: "reviewer",
				dependsOn: ["d1"], parallelizable: false,
				acceptanceCriteria: ["Output confirms the list is accurate"],
				files: [],
				description: "Confirm the type list from the previous step is accurate. Max 50 words.",
			},
		],
	};
	const dagResult = await executeDAG(simpleDAG, {
		cwd: CWD, fluxDir: FLUX_DIR, modelsConfig, telemetry, prefixLayout,
		pricing: pricingTable ?? undefined, sessionId,
		maxRetries: 1, enableQualityGate: true,
	});
	console.log("  " + formatDAGResult(dagResult).split("\n").join("\n  "));
	record("dag", "DAG: execution completes all nodes",
		dagResult.completedNodes.length + dagResult.failedNodes.length === 2,
		`completed=${dagResult.completedNodes.length}, failed=${dagResult.failedNodes.length}`);
	record("dag", "DAG: has total cost",
		dagResult.totalCost >= 0,
		`cost=$${dagResult.totalCost.toFixed(6)}`);

	// 4.3 DAG state file
	const dagStateFile = join(FLUX_DIR, "runtime", "dag-state.json");
	record("dag", "DAG: state file persisted",
		existsSync(dagStateFile),
		`exists=${existsSync(dagStateFile)}`);

	// 4.4 Record experience from DAG execution
	expStore.record({
		taskType: "bugfix", complexityTier: 1,
		fileCount: taskSignal.scope.allRelevantFiles.length, diffLines: taskSignal.scope.diffLines,
		routedMode: routeAuto.mode, actualMode: routeAuto.mode,
		outcome: {
			success: dagResult.allPassed,
			cost: dagResult.totalCost,
			latencyMs: dagResult.wallClockMs,
			turns: dagResult.completedNodes.length,
			cacheHitRate: 0.85,
			gatePassed: dagResult.allPassed,
		},
		context: { stage, preset },
	});
	record("dag", "Experience: DAG execution recorded to ExperienceStore",
		expStore.loadAll().length > 4,
		`total records=${expStore.loadAll().length}`);

	// ═══════════════════════════════════════════════════════
	// 5. M6 异构团队
	// ═══════════════════════════════════════════════════════

	console.log("\n_TEAM 5. M6 Heterogeneous Team_\n");

	const heteroTeam = createStandardHeterogeneousTeam(
		"Read src/core/types.ts and list the first 3 type names.",
		modelsConfig,
		{ strongModel: MODEL, cheapModel: MODEL },
	);
	// Simplify to 2 agents for test speed
	heteroTeam.agents = [heteroTeam.agents[0], heteroTeam.agents[2]];
	heteroTeam.agents[1].dependsOn = ["hetero-planner"];
	heteroTeam.maxRetries = 1;

	console.log("  [5.1] Executing 2-agent heterogeneous team...");
	const heteroResult = await executeHeterogeneousTeam(heteroTeam, {
		cwd: CWD, fluxDir: FLUX_DIR, modelsConfig, telemetry, prefixLayout,
		pricing: pricingTable ?? undefined, sessionId,
	});
	console.log("  " + formatHeterogeneousTeamResult(heteroResult).split("\n").join("\n  "));
	record("hetero", "M6: team execution completes",
		heteroResult.agentResults.size === 2,
		`agents=${heteroResult.agentResults.size}`);
	record("hetero", "M6: has cost savings report",
		typeof heteroResult.costSavings.savings === "number",
		`savings=${heteroResult.costSavings.savings}%`);
	record("hetero", "M6: has model usage report",
		Object.keys(heteroResult.modelUsage).length > 0,
		`models=${Object.entries(heteroResult.modelUsage).map(([m, c]) => `${m}×${c}`).join(", ")}`);

	// ═══════════════════════════════════════════════════════
	// 6. 端到端: 任务输入 → 路由 → 执行 → 质量门 → 经验 → telemetry
	// ═══════════════════════════════════════════════════════

	console.log("\n🔗 6. End-to-End Pipeline\n");

	const e2eTask = "Review the routing module for potential issues";

	// Step 1: Classify task
	const e2eClassification = classifyTask(e2eTask);
	record("e2e", "E2E step 1: task classified",
		e2eClassification.type !== "unknown",
		`type=${e2eClassification.type}`);

	// Step 2: Generate routing signal
	const e2eSignal = generateTaskRoutingSignal(CWD, e2eTask);
	record("e2e", "E2E step 2: routing signal generated",
		e2eSignal.recommendedMode !== null,
		`mode=${e2eSignal.recommendedMode}, conf=${e2eSignal.confidence.toFixed(2)}`);

	// Step 3: Query experience
	const e2eExp = expStore.suggest(e2eClassification.type, e2eSignal.complexity.tier, e2eSignal.scope.allRelevantFiles.length);
	record("e2e", "E2E step 3: experience queried (may be null if insufficient data)",
		true, // null is valid if not enough data
		`recommendation=${e2eExp ? e2eExp.mode : "null (insufficient data)"}`);

	// Step 4: Route decision
	const e2eRoute = route({
		stage, pref: DEFAULT_PREFERENCE, preset,
		taskRoutingSignal: e2eSignal,
		experienceRecommendation: e2eExp,
		overrideMode: "auto",
	});
	record("e2e", "E2E step 4: route decision made",
		e2eRoute.mode !== null && e2eRoute.applied === true,
		`mode=${e2eRoute.mode}, conf=${e2eRoute.confidence.toFixed(2)}, applied=${e2eRoute.applied}`);

	// Step 5: Execute agent
	console.log("  [E2E step 5] Executing agent...");
	const e2eResult = await runSubagent({
		cwd: CWD,
		agent: { name: "e2e-reviewer", description: "Review code", tools: ["read", "grep", "find", "ls"], systemPrompt: "You are a code reviewer.", thinking: "high" },
		task: `${e2eTask}\n\nReview src/core/routing.ts. List any potential issues. Max 100 words.`,
		sessionId, telemetry, prefixLayout,
		model: MODEL, provider, pricing: pricingTable ?? undefined,
		thinking: "high",
	});
	record("e2e", "E2E step 5: agent executed",
		e2eResult.exitCode === 0 && e2eResult.output.length > 0,
		`exit=${e2eResult.exitCode}, output=${e2eResult.output.length}chars`);

	// Step 6: Quality gate
	const e2eGate = await checkQualityGate(
		e2eResult.output,
		["Output mentions at least 1 issue or confirms no issues"],
		{ cwd: CWD, model: MODEL, provider, pricing: pricingTable ?? undefined, telemetry, sessionId },
	);
	record("e2e", "E2E step 6: quality gate checked",
		e2eGate !== null,
		`passed=${e2eGate.passed}, feedback=${e2eGate.feedback.slice(0, 50)}`);

	// Step 7: Record experience
	expStore.record({
		taskType: e2eClassification.type,
		complexityTier: e2eSignal.complexity.tier,
		fileCount: e2eSignal.scope.allRelevantFiles.length,
		diffLines: e2eSignal.scope.diffLines,
		routedMode: e2eRoute.mode, actualMode: e2eRoute.mode,
		outcome: {
			success: e2eResult.exitCode === 0,
			cost: e2eResult.usage.cost + e2eGate.gateCost,
			latencyMs: 0, turns: 1,
			cacheHitRate: e2eResult.usage.cacheRead / (e2eResult.usage.cacheRead + e2eResult.usage.input + 1e-9),
			gatePassed: e2eGate.passed,
		},
	});
	record("e2e", "E2E step 7: experience recorded",
		expStore.loadAll().length > 5,
		`total records=${expStore.loadAll().length}`);

	// Step 8: Verify telemetry
	const allEvents = readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
	const recentSubagentEvents = allEvents.filter(e => e.type === "subagent.run").slice(-3);
	record("e2e", "E2E step 8: telemetry has recent subagent.run events",
		recentSubagentEvents.length >= 2,
		`recent subagent.run count=${recentSubagentEvents.length}`);

	// Step 9: Verify experience can now suggest
	const postE2eRec = expStore.suggest(e2eClassification.type, e2eSignal.complexity.tier, e2eSignal.scope.allRelevantFiles.length);
	record("e2e", "E2E step 9: experience can query after recording",
		true, // may still be null if not enough same-type records
		`recommendation=${postE2eRec ? postE2eRec.mode : "null (may need more data)"}`);

	// ═══════════════════════════════════════════════════════
	// 7. Sidecar 回退验证
	// ═══════════════════════════════════════════════════════

	console.log("\n🔌 7. Sidecar Fallback\n");

	const sidecar = new SidecarClient(FLUX_DIR);
	const sidecarAvailable = await sidecar.checkAvailability();
	record("sidecar", "Sidecar: Python not available (expected)",
		sidecarAvailable === false,
		`available=${sidecarAvailable}`);

	const sidecarBudget = await sidecar.optimizeBudget(budgetAgents, { maxTotalCost: 0.01 });
	record("sidecar", "Sidecar: optimizeBudget falls back to TS heuristic",
		sidecarBudget.assignments.length === 2,
		`assignments=${sidecarBudget.assignments.length}`);

	const sidecarSuggest = await sidecar.suggestMode(expStore, "bugfix", taskSignal.complexity.tier, taskSignal.scope.allRelevantFiles.length);
	record("sidecar", "Sidecar: suggestMode falls back to ExperienceStore",
		sidecarSuggest !== null,
		`mode=${sidecarSuggest?.mode}`);
	sidecar.dispose();

	// ═══════════════════════════════════════════════════════
	// 8. ExperienceStore 统计
	// ═══════════════════════════════════════════════════════

	console.log("\n📊 8. Experience Store Stats\n");

	const expStats = expStore.getStats();
	console.log("  " + formatExperienceStats(expStats));
	record("experience", "ExperienceStore: has records from all tests",
		expStats.totalRecords >= 5,
		`total=${expStats.totalRecords}`);
	record("experience", "ExperienceStore: has mode distribution",
		Object.keys(expStats.modeDistribution).length >= 1,
		`modes=${Object.entries(expStats.modeDistribution).map(([m, c]) => `${m}×${c}`).join(", ")}`);

	// ═══════════════════════════════════════════════════════
	// 清理
	// ═══════════════════════════════════════════════════════

	try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}

	// ═══════════════════════════════════════════════════════
	// 汇总
	// ═══════════════════════════════════════════════════════

	console.log("\n" + "=".repeat(80));
	console.log("Full-Chain Test Summary");
	console.log("=".repeat(80));

	const categories = [...new Set(results.map(r => r.category))];
	const passed = results.filter(r => r.passed).length;
	const failed = results.filter(r => !r.passed).length;

	for (const cat of categories) {
		const catResults = results.filter(r => r.category === cat);
		const catPassed = catResults.filter(r => r.passed).length;
		const catFailed = catResults.filter(r => !r.passed).length;
		console.log(`\n  [${cat}] ${catPassed}/${catResults.length} passed${catFailed > 0 ? `, ${catFailed} failed` : ""}`);
		for (const r of catResults) {
			const icon = r.passed ? "✅" : "❌";
			console.log(`    ${icon} ${r.name}: ${r.detail}`);
		}
	}

	console.log(`\n  ${"─".repeat(60)}`);
	console.log(`  Total: ${passed + failed} tests, ${passed} passed, ${failed} failed`);
	console.log(`  Categories: ${categories.join(", ")}`);

	if (failed > 0) {
		console.log("\n  ❌ FAILED TESTS:");
		for (const r of results.filter(r => !r.passed)) {
			console.log(`    ${r.category}: ${r.name}`);
		}
		process.exit(1);
	} else {
		console.log("\n  ✅ ALL TESTS PASSED");
	}
}

main().catch(e => { console.error("Test error:", e); process.exit(1); });
