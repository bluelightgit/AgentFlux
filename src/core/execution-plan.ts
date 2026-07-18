/**
 * Task → RoutePlan 的唯一生产入口。
 * 路由推荐和实际可执行能力在这里汇合，避免 UI/入口各自复制模式语义。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { applyScenarioOverride } from "./config";
import { ExperienceStore } from "./experience-store";
import { route } from "./routing";
import { generateTaskRoutingSignal, type TaskRoutingSignal } from "./task-router";
import type { FluxConfig, Mode, PreferenceConfig, ProjectStage, RoutingDecision } from "./types";

export type ExecutorKind = "main" | "main_with_subagent" | "dag";
export type CapabilityStatus = "available" | "experimental" | "unavailable";

export interface ModeCapability {
	mode: Mode;
	status: CapabilityStatus;
	executor?: ExecutorKind;
	fallback: "M1" | "M2" | "M5";
	reason?: string;
}

export const MODE_CAPABILITIES: Record<Mode, ModeCapability> = {
	M1: { mode: "M1", status: "available", executor: "main", fallback: "M1" },
	M2: { mode: "M2", status: "available", executor: "main_with_subagent", fallback: "M2" },
	M3: { mode: "M3", status: "experimental", fallback: "M2", reason: "fork workflow 尚未形成自动 A/B 合并闭环" },
	M4: { mode: "M4", status: "experimental", fallback: "M5", reason: "持久 worker/可靠认领尚未达到生产级" },
	M5: { mode: "M5", status: "available", executor: "dag", fallback: "M5" },
	M6: { mode: "M6", status: "experimental", fallback: "M5", reason: "异构团队尚未接入统一预算与验收闭环" },
};

export interface TaskRoutePlan {
	taskId: string;
	decisionId: string;
	task: string;
	signal: TaskRoutingSignal;
	decision: RoutingDecision;
	requestedMode: Mode;
	selectionSource: "router" | "explicit";
	effectiveMode: "M1" | "M2" | "M5";
	executor: ExecutorKind;
	capability: ModeCapability;
	fallbackReason?: string;
	requiresConfirmation: boolean;
	routingControls: {
		staticSignals: "enabled" | "disabled";
		budgetAware: "limits_only" | "disabled";
		experienceAware: "enabled" | "disabled";
	};
	budget: {
		maxCostUsd: number;
		maxIterations: number;
		maxWallClockMs: number;
		enforcement: "between_attempts_and_steps";
		singleRequestOvershootPossible: true;
	};
	blockedReason?: string;
}

export interface MainTaskBudgetState {
	taskId: string;
	startedAt: number;
	iterationsStarted: number;
}

/** 在下一次 main-agent provider turn 开始前执行硬边界检查。 */
export function evaluateMainTaskBudget(
	plan: TaskRoutePlan,
	state: MainTaskBudgetState,
	nowMs = Date.now(),
): { allowed: true; nextState: MainTaskBudgetState } | { allowed: false; reason: "max_iterations" | "max_wall_clock"; nextState: MainTaskBudgetState } {
	const nextState = { ...state, iterationsStarted: state.iterationsStarted + 1 };
	if (nowMs - state.startedAt >= plan.budget.maxWallClockMs) {
		return { allowed: false, reason: "max_wall_clock", nextState };
	}
	if (nextState.iterationsStarted > plan.budget.maxIterations) {
		return { allowed: false, reason: "max_iterations", nextState };
	}
	return { allowed: true, nextState };
}

/** planner 消耗后的任务剩余墙钟预算；节点不得再被隐藏的固定上限截短。 */
export function remainingTaskWallClock(maxWallClockMs: number, elapsedMs: number): number {
	return Math.max(1, maxWallClockMs - Math.max(0, elapsedMs));
}

export function resolveExecutableMode(requested: Mode): {
	effectiveMode: "M1" | "M2" | "M5";
	executor: ExecutorKind;
	capability: ModeCapability;
	fallbackReason?: string;
} {
	const capability = MODE_CAPABILITIES[requested];
	if (capability.status === "available" && capability.executor) {
		return { effectiveMode: requested as "M1" | "M2" | "M5", executor: capability.executor, capability };
	}
	const fallback = MODE_CAPABILITIES[capability.fallback];
	return {
		effectiveMode: capability.fallback,
		executor: fallback.executor!,
		capability,
		fallbackReason: `${requested} ${capability.status}: ${capability.reason ?? "not executable"}; fallback → ${capability.fallback}`,
	};
}

export function buildTaskRoutePlan(input: {
	cwd: string;
	task: string;
	stage: ProjectStage;
	config: FluxConfig;
	pref: PreferenceConfig;
	taskId?: string;
	decisionId?: string;
	experienceStore?: ExperienceStore;
	/** 用户、主 Agent 或受控宿主明确选择的模式；省略时才采用自动路由建议。 */
	requestedMode?: Mode;
}): TaskRoutePlan {
	const signal = generateTaskRoutingSignal(input.cwd, input.task);
	const scenarioPref = applyScenarioOverride(input.pref, signal.classification.scenario ?? undefined);
	const experienceStore = input.config.routing.experience_aware
		? input.experienceStore ?? new ExperienceStore(join(input.cwd, ".agentflux"))
		: undefined;
	const experienceRecommendation = experienceStore?.suggest(
		signal.classification.type,
		signal.complexity.tier,
		signal.complexity.fileCount,
	) ?? null;
	const decision = route({
		stage: input.stage,
		pref: scenarioPref,
		preset: scenarioPref.profile,
		taskRoutingSignal: input.config.routing.static_signals ? signal : undefined,
		overrideMode: input.config.routing.override_mode,
		experienceRecommendation,
	});
	if (!input.config.routing.static_signals) {
		decision.reason.push("routing-control:static_signals=disabled");
	}
	if (input.config.routing.budget_aware) {
		decision.reason.push("routing-control:budget_aware=limits_only (model/topology optimizer not wired)");
	}
	const requestedMode = input.requestedMode ?? decision.mode;
	const selectionSource = input.requestedMode ? "explicit" : "router";
	if (input.requestedMode) {
		decision.reason.push(`explicit-mode:${input.requestedMode}`);
	}
	const resolved = resolveExecutableMode(requestedMode);
	const maxCostUsd = Number(input.config.budget.max_cost_per_task);
	return {
		taskId: input.taskId ?? `task-${randomUUID()}`,
		decisionId: input.decisionId ?? `decision-${randomUUID()}`,
		task: input.task,
		signal,
		decision,
		requestedMode,
		selectionSource,
		effectiveMode: resolved.effectiveMode,
		executor: resolved.executor,
		capability: resolved.capability,
		fallbackReason: resolved.fallbackReason,
		requiresConfirmation: selectionSource === "explicit" ? false : input.config.routing.override_mode !== "auto",
		routingControls: {
			staticSignals: input.config.routing.static_signals ? "enabled" : "disabled",
			budgetAware: input.config.routing.budget_aware ? "limits_only" : "disabled",
			experienceAware: input.config.routing.experience_aware ? "enabled" : "disabled",
		},
		budget: {
			maxCostUsd,
			maxIterations: Math.max(1, input.config.budget.max_iterations),
			maxWallClockMs: Math.max(1000, input.config.budget.max_wall_clock_seconds * 1000),
			enforcement: "between_attempts_and_steps",
			singleRequestOvershootPossible: true,
		},
		blockedReason: Number.isFinite(maxCostUsd) && maxCostUsd > 0 ? undefined : "budget.max_cost_per_task must be > 0",
	};
}

export function formatTaskRoutePlan(plan: TaskRoutePlan): string {
	return [
		`Task plan ${plan.taskId}`,
		`  route ${plan.requestedMode}${plan.requestedMode === plan.effectiveMode ? "" : ` → ${plan.effectiveMode}`} · executor ${plan.executor} · source ${plan.selectionSource}`,
		`  confidence ${(plan.decision.confidence * 100).toFixed(0)}% · ${plan.requiresConfirmation ? "confirmation/suggest" : "auto"}`,
		`  controls static=${plan.routingControls.staticSignals} · budget=${plan.routingControls.budgetAware} · experience=${plan.routingControls.experienceAware}`,
		`  budget $${plan.budget.maxCostUsd.toFixed(4)} · ${Math.round(plan.budget.maxWallClockMs / 1000)}s · ${plan.budget.maxIterations} iterations`,
		plan.fallbackReason ? `  fallback ${plan.fallbackReason}` : "",
		plan.blockedReason ? `  BLOCKED ${plan.blockedReason}` : "",
	].filter(Boolean).join("\n");
}
