import type { PreferenceConfig } from "./types";

export type CacheImpactChange =
	| "tool_schema"
	| "skill_set"
	| "mcp_set"
	| "system_prompt"
	| "model"
	| "session_generation"
	| "runtime_policy_guard"
	| "message_injection";

export interface CacheImpactAssessment {
	change: CacheImpactChange;
	severity: "none" | "low" | "high";
	invalidatesReusablePrefix: boolean;
	requiresNewSessionGeneration: boolean;
	addsContextTokens: boolean;
	costSensitivity: number;
	shouldNotifyUser: boolean;
	suppressedReason?: "cost_sensitivity_zero" | "no_cache_hit_impact";
	reason: string;
}

export interface RuntimeCacheShape {
	toolSchema: string;
	skillSet: string;
	mcpSet: string;
	systemPrompts: string;
	modelAssignments: string;
}

const ZERO_COST_SENSITIVITY_EPSILON = 0.01;

const IMPACTS: Record<CacheImpactChange, Omit<CacheImpactAssessment, "change" | "costSensitivity" | "shouldNotifyUser" | "suppressedReason">> = {
	tool_schema: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: false,
		reason: "工具 schema/order 变化会改变静态提示前缀，旧 session 的工具契约也不再可靠",
	},
	skill_set: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: true,
		reason: "Skill 内容会进入上下文，变更后既破坏前缀复用，也无法从旧 session 中撤回",
	},
	mcp_set: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: false,
		reason: "MCP 能力集合变化会改变可用工具契约和静态前缀",
	},
	system_prompt: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: true,
		reason: "system prompt 变化会直接使之前的可缓存前缀失效",
	},
	model: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: false,
		reason: "切换模型不能复用原模型的 provider cache，且同一 session 中切换可能破坏行为一致性",
	},
	session_generation: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: false,
		reason: "新 session generation 会放弃旧 session 已积累的对话前缀缓存",
	},
	runtime_policy_guard: {
		severity: "none", invalidatesReusablePrefix: false, requiresNewSessionGeneration: false, addsContextTokens: false,
		reason: "仅在宿主侧收紧执行 guard，不改变暴露给模型的工具 schema 或提示前缀",
	},
	message_injection: {
		severity: "low", invalidatesReusablePrefix: false, requiresNewSessionGeneration: false, addsContextTokens: true,
		reason: "消息作为动态后缀增加上下文 token，但保持既有静态前缀顺序，不主动破坏前缀命中",
	},
};

export function assessCacheImpact(change: CacheImpactChange, pref: PreferenceConfig): CacheImpactAssessment {
	const impact = IMPACTS[change];
	const costSensitivity = Math.max(0, Math.min(1, Number(pref.vector.cost_sensitivity) || 0));
	const hasCacheHitImpact = impact.invalidatesReusablePrefix || impact.requiresNewSessionGeneration;
	const costSensitivityZero = costSensitivity <= ZERO_COST_SENSITIVITY_EPSILON;
	return {
		change,
		...impact,
		costSensitivity,
		shouldNotifyUser: hasCacheHitImpact && !costSensitivityZero,
		suppressedReason: !hasCacheHitImpact
			? "no_cache_hit_impact"
			: costSensitivityZero ? "cost_sensitivity_zero" : undefined,
	};
}

export function formatCacheImpactWarning(assessment: CacheImpactAssessment): string | null {
	if (!assessment.shouldNotifyUser) return null;
	return [
		`⚠ Cache impact (${assessment.change})`,
		assessment.reason,
		`cost_sensitivity=${assessment.costSensitivity.toFixed(2)} · reusable-prefix=${assessment.invalidatesReusablePrefix ? "invalidated" : "preserved"} · new-session=${assessment.requiresNewSessionGeneration ? "required" : "not-required"}`,
	].join("\n");
}

export function diffRuntimeCacheShape(before: RuntimeCacheShape, after: RuntimeCacheShape): CacheImpactChange[] {
	const changes: CacheImpactChange[] = [];
	if (before.toolSchema !== after.toolSchema) changes.push("tool_schema");
	if (before.skillSet !== after.skillSet) changes.push("skill_set");
	if (before.mcpSet !== after.mcpSet) changes.push("mcp_set");
	if (before.systemPrompts !== after.systemPrompts) changes.push("system_prompt");
	if (before.modelAssignments !== after.modelAssignments) changes.push("model");
	return changes;
}
