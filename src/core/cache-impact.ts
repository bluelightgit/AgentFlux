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
		reason: "Changing tool schemas or their order invalidates the static prompt prefix and the tool contract of existing sessions",
	},
	skill_set: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: true,
		reason: "Skills enter the context; changes invalidate prefix reuse and cannot remove content from existing sessions",
	},
	mcp_set: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: false,
		reason: "Changing MCP capabilities changes the available tool contract and static prefix",
	},
	system_prompt: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: true,
		reason: "Changing the system prompt invalidates the previously cacheable prefix",
	},
	model: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: false,
		reason: "Switching models prevents reuse of the previous provider cache and may disrupt behavior within the same session",
	},
	session_generation: {
		severity: "high", invalidatesReusablePrefix: true, requiresNewSessionGeneration: true, addsContextTokens: false,
		reason: "A new session generation discards the conversation prefix cache accumulated by the previous session",
	},
	runtime_policy_guard: {
		severity: "none", invalidatesReusablePrefix: false, requiresNewSessionGeneration: false, addsContextTokens: false,
		reason: "Only Host execution guards are narrowed; model-visible tool schemas and prompt prefixes remain unchanged",
	},
	message_injection: {
		severity: "low", invalidatesReusablePrefix: false, requiresNewSessionGeneration: false, addsContextTokens: true,
		reason: "Messages add context tokens as dynamic suffixes while preserving static prefix order and cache reuse",
	},
};

export function assessCacheImpact(change: CacheImpactChange, costPreference = 1): CacheImpactAssessment {
	const impact = IMPACTS[change];
	const costSensitivity = Math.max(0, Math.min(1, Number(costPreference) || 0));
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
		`Warning: Cache impact (${assessment.change})`,
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
