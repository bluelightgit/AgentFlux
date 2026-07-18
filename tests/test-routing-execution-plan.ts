import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRuntimeOverride } from "../src/core/config";
import { buildTaskRoutePlan, evaluateMainTaskBudget, MODE_CAPABILITIES, remainingTaskWallClock, resolveExecutableMode } from "../src/core/execution-plan";
import { classifyTask } from "../src/core/task-router";
import { DEFAULT_CONFIG, DEFAULT_PREFERENCE } from "../src/core/types";
import { buildFluxSummary, buildInspectorText } from "../src/extension/footer";

const results: Array<{ name: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: string) {
	results.push({ name, passed, detail });
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
}

const root = mkdtempSync(join(tmpdir(), "agentflux-route-plan-"));
try {
	const chineseCases = [
		["请修复启动时的崩溃问题", "bugfix"],
		["新增一个预算控制功能", "feature"],
		["重构路由模块并去重", "refactor"],
		["审查这次代码变更", "review"],
		["补充单元测试和覆盖率", "test"],
		["更新使用文档", "docs"],
	] as const;
	for (const [task, expected] of chineseCases) {
		const actual = classifyTask(task).type;
		check(`Chinese classify ${expected}`, actual === expected, `actual=${actual}`);
	}

	const accurate = applyRuntimeOverride(DEFAULT_CONFIG, DEFAULT_PREFERENCE, "accurate");
	check("preset replaces vector", accurate.pref.vector.accuracy_priority === 0.98 && accurate.pref.vector.cost_sensitivity === 0.15, JSON.stringify(accurate.pref.vector));

	const manyFiles = Array.from({ length: 35 }, (_, index) => `src/mod${index}/file${index}.ts`).join(" ");
	const plan = buildTaskRoutePlan({
		cwd: root,
		task: `重构这些模块 ${manyFiles}`,
		stage: "Established",
		config: { ...DEFAULT_CONFIG, mode: "accurate", routing: { ...DEFAULT_CONFIG.routing, override_mode: "auto" } },
		pref: accurate.pref,
	});
	check("task route carries concrete signal", plan.signal.complexity.fileCount >= 30, `files=${plan.signal.complexity.fileCount}`);
	check("only production modes execute", ["M1", "M2", "M5"].includes(plan.effectiveMode), `${plan.requestedMode}→${plan.effectiveMode}`);
	check("experimental mode has explicit fallback", plan.requestedMode === plan.effectiveMode || !!plan.fallbackReason, plan.fallbackReason ?? "direct");
	check("auto plan needs no confirmation", plan.requiresConfirmation === false, `requiresConfirmation=${plan.requiresConfirmation}`);

	const explicitM2 = buildTaskRoutePlan({
		cwd: root,
		task: "实现用户明确指定的功能",
		stage: "Established",
		config: { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, override_mode: "suggest" } },
		pref: DEFAULT_PREFERENCE,
		requestedMode: "M2",
	});
	check("explicit mode overrides router without confirmation", explicitM2.requestedMode === "M2" && explicitM2.effectiveMode === "M2" && !explicitM2.requiresConfirmation, `${explicitM2.requestedMode}/${explicitM2.selectionSource}`);
	check("explicit mode remains observable", explicitM2.selectionSource === "explicit" && explicitM2.decision.reason.includes("explicit-mode:M2"), explicitM2.decision.reason.join(" | "));

	const expectedModes = {
		M1: { effectiveMode: "M1", executor: "main", status: "available" },
		M2: { effectiveMode: "M2", executor: "main_with_subagent", status: "available" },
		M3: { effectiveMode: "M2", executor: "main_with_subagent", status: "experimental" },
		M4: { effectiveMode: "M5", executor: "dag", status: "experimental" },
		M5: { effectiveMode: "M5", executor: "dag", status: "available" },
		M6: { effectiveMode: "M5", executor: "dag", status: "experimental" },
	} as const;
	for (const [mode, expected] of Object.entries(expectedModes)) {
		const resolved = resolveExecutableMode(mode as keyof typeof expectedModes);
		check(`${mode} executable contract`, resolved.effectiveMode === expected.effectiveMode
			&& resolved.executor === expected.executor && resolved.capability.status === expected.status,
			`${mode}→${resolved.effectiveMode}/${resolved.executor}/${resolved.capability.status}`);
	}
	check("capability manifest marks M3/M4/M6 experimental", ["M3", "M4", "M6"].every(mode => MODE_CAPABILITIES[mode as "M3" | "M4" | "M6"].status === "experimental"), "manifest checked");
	const displayState = {
		mode: "M4" as const,
		preset: "balanced" as const,
		stage: "Established" as const,
		role: "coordinator" as const,
		expectedMode: "M4" as const,
		cache: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, cacheHitRate: 0, contextTokens: 0, contextWindow: 0, contextPercent: 0 },
		turnIndex: 0,
	};
	check("summary shows the executable fallback instead of hard-coded M1", buildFluxSummary(displayState, "events.jsonl", null).includes("M4  (fallback M5)"), buildFluxSummary(displayState, "events.jsonl", null).split("\n")[1]);
	check("inspector shows the executable fallback instead of hard-coded M1", buildInspectorText(displayState, null, { fileCount: 0, commitCount: 0 }, "events.jsonl").includes("M4  (fallback M5)"), buildInspectorText(displayState, null, { fileCount: 0, commitCount: 0 }, "events.jsonl").split("\n")[1]);

	const blocked = buildTaskRoutePlan({
		cwd: root,
		task: "更新文档",
		stage: "Seed",
		config: { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_cost_per_task: 0 } },
		pref: DEFAULT_PREFERENCE,
	});
	check("invalid budget blocks execution", !!blocked.blockedReason, blocked.blockedReason ?? "not blocked");
	check("configured wall clock is not silently capped at 300s", remainingTaskWallClock(600_000, 25_000) === 575_000, `${remainingTaskWallClock(600_000, 25_000)}ms`);
	let budgetState = { taskId: explicitM2.taskId, startedAt: 1_000, iterationsStarted: 0 };
	for (let i = 0; i < explicitM2.budget.maxIterations; i++) {
		const result = evaluateMainTaskBudget(explicitM2, budgetState, 1_001 + i);
		check(`main task budget allows configured iteration ${i + 1}`, result.allowed, JSON.stringify(result));
		budgetState = result.nextState;
	}
	const iterationStop = evaluateMainTaskBudget(explicitM2, budgetState, 2_000);
	check("main task budget blocks the first excess provider turn", !iterationStop.allowed && iterationStop.reason === "max_iterations", JSON.stringify(iterationStop));
	const wallStop = evaluateMainTaskBudget(explicitM2, { taskId: explicitM2.taskId, startedAt: 1_000, iterationsStarted: 0 }, 1_000 + explicitM2.budget.maxWallClockMs);
	check("main task budget blocks at wall-clock deadline", !wallStop.allowed && wallStop.reason === "max_wall_clock", JSON.stringify(wallStop));
} finally {
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter(result => !result.passed);
console.log(`\nRouting execution plan: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
