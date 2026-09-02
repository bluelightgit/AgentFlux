import type { AgentRunPhase } from "./run-registry";

/** 在线 Run 的健康维度；不代表 status，也不负责结束 Run。 */
export type AgentRunHealth =
	| "healthy"
	| "waiting_provider"
	| "waiting_tool"
	| "quiet"
	| "suspected_stall"
	| "suspected_loop"
	| "context_pressure";

/** 健康监控阈值。所有阈值只产生提示，不会自动终止模型执行。 */
export interface RunHealthConfig {
	waiting_provider_after_ms: number;
	quiet_after_ms: number;
	suspected_stall_after_ms: number;
	suspected_loop_repeats: number;
	warning_cooldown_ms: number;
	context_pressure_percent: number;
}

export const DEFAULT_RUN_HEALTH_CONFIG: RunHealthConfig = {
	waiting_provider_after_ms: 30_000,
	quiet_after_ms: 60_000,
	suspected_stall_after_ms: 120_000,
	suspected_loop_repeats: 3,
	warning_cooldown_ms: 60_000,
	context_pressure_percent: 0.85,
};

export interface RunHealthObservation {
	phase: AgentRunPhase;
	nowMs?: number;
	lastProgressAt?: string;
	lastActivityAt?: string;
	providerError?: string;
	modelError?: string;
	waitingForProvider?: boolean;
	repeatActionSignature?: string;
	repeatActionCount?: number;
	contextPercent?: number;
	contextTokens?: number;
	contextWindow?: number;
}

export interface RunHealthAssessment {
	health: AgentRunHealth;
	reason?: string;
	warningKey?: string;
}

function ageMs(timestamp: string | undefined, nowMs: number): number | undefined {
	if (!timestamp) return undefined;
	const value = Date.parse(timestamp);
	return Number.isFinite(value) ? Math.max(0, nowMs - value) : undefined;
}

function contextPercent(observation: RunHealthObservation): number | undefined {
	if (typeof observation.contextPercent === "number" && Number.isFinite(observation.contextPercent)) {
		return observation.contextPercent > 1 ? observation.contextPercent / 100 : observation.contextPercent;
	}
	if (typeof observation.contextTokens === "number" && observation.contextTokens >= 0
		&& typeof observation.contextWindow === "number" && observation.contextWindow > 0) {
		return observation.contextTokens / observation.contextWindow;
	}
	return undefined;
}

function assessment(health: AgentRunHealth, reason?: string): RunHealthAssessment {
	return { health, reason, warningKey: health === "healthy" ? undefined : `${health}:${reason ?? ""}` };
}

/**
 * 根据当前阶段、语义进展和重复动作证据推导健康状态。
 * heartbeat 不参与 progress age，因此活着但没有语义进展的进程仍会被提示。
 */
export function assessRunHealth(
	observation: RunHealthObservation,
	config: RunHealthConfig = DEFAULT_RUN_HEALTH_CONFIG,
): RunHealthAssessment {
	const nowMs = observation.nowMs ?? Date.now();
	const percent = contextPercent(observation);
	if (percent !== undefined && percent >= config.context_pressure_percent) {
		return assessment("context_pressure", `context usage ${(percent * 100).toFixed(1)}%`);
	}
	if ((observation.repeatActionCount ?? 0) >= config.suspected_loop_repeats) {
		return assessment(
			"suspected_loop",
			`repeated action ${observation.repeatActionSignature ?? "(unknown)"} × ${observation.repeatActionCount}`,
		);
	}
	const progressAge = ageMs(observation.lastProgressAt, nowMs);
	if ((observation.phase === "error" && observation.providerError)
		|| observation.phase === "backoff" || observation.phase === "retrying"
		|| (observation.waitingForProvider && progressAge !== undefined && progressAge >= config.waiting_provider_after_ms)) {
		return assessment("waiting_provider", observation.providerError ?? "waiting for provider response");
	}
	if (observation.phase === "tool") {
		return assessment("waiting_tool", observation.lastActivityAt ? "tool execution in progress" : "waiting for tool");
	}

	if (progressAge !== undefined && progressAge >= config.suspected_stall_after_ms) {
		return assessment("suspected_stall", `no semantic progress for ${Math.round(progressAge / 1000)}s`);
	}
	if (progressAge !== undefined && progressAge >= config.quiet_after_ms) {
		return assessment("quiet", `no semantic progress for ${Math.round(progressAge / 1000)}s`);
	}
	return assessment("healthy");
}

/** 健康告警限频：状态变化立即提示，同一状态按 cooldown 重复提示。 */
export function shouldEmitHealthWarning(
	previous: AgentRunHealth | undefined,
	next: RunHealthAssessment,
	nowMs: number,
	lastWarningAt: string | undefined,
	cooldownMs: number,
): boolean {
	if (next.health === "healthy") return false;
	if (previous !== next.health) return true;
	const previousMs = lastWarningAt ? Date.parse(lastWarningAt) : NaN;
	return !Number.isFinite(previousMs) || nowMs - previousMs >= cooldownMs;
}
