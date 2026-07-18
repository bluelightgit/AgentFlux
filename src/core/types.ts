/**
 * AgentFlux Core — 类型定义
 * 文档依据: docs/02-dimensions, 03-modes, 04-config-schema, 13-routing-preference, 14-project-evolution
 */

// ---------- 维度 (docs/02) ----------

export type ContextTopology = "single" | "star" | "fork" | "peers"; // 维度 A
export type Lifecycle = "compact" | "mask" | "handoff" | "fork-prune"; // 维度 B
export type Parallelism = "sequential" | "stage" | "task"; // 维度 C
export type ModelStrategy = "homogeneous" | "heterogeneous"; // 维度 D

// ---------- 模式 (docs/03) ----------

export type Mode = "M1" | "M2" | "M3" | "M4" | "M5" | "M6";

export interface ModeDef {
	id: Mode;
	label: string;
	topology: ContextTopology;
	lifecycle: Lifecycle;
	parallelism: Parallelism;
	modelStrategy: ModelStrategy;
}

export const MODES: Record<Mode, ModeDef> = {
	M1: { id: "M1", label: "单 agent", topology: "single", lifecycle: "compact", parallelism: "sequential", modelStrategy: "homogeneous" },
	M2: { id: "M2", label: "main+subagent", topology: "star", lifecycle: "compact", parallelism: "stage", modelStrategy: "homogeneous" },
	M3: { id: "M3", label: "对话树 fork", topology: "fork", lifecycle: "fork-prune", parallelism: "sequential", modelStrategy: "homogeneous" },
	M4: { id: "M4", label: "持久 multi-agent", topology: "peers", lifecycle: "mask", parallelism: "task", modelStrategy: "homogeneous" },
	M5: { id: "M5", label: "管道 handoff", topology: "star", lifecycle: "handoff", parallelism: "stage", modelStrategy: "homogeneous" },
	M6: { id: "M6", label: "异构团队", topology: "peers", lifecycle: "mask", parallelism: "task", modelStrategy: "heterogeneous" },
};

// ---------- 预设档位 (docs/04 Level 1) ----------

export type Preset = "eco" | "fast" | "accurate" | "balanced" | "custom";

export const PRESET_TO_MODE: Record<Preset, Mode> = {
	eco: "M1",
	fast: "M3",
	accurate: "M6",
	balanced: "M2",
	custom: "M2", // custom 由 Level 2/3 接管, 默认 fallback M2
};

// ---------- 路由偏好 (docs/13) ----------

export interface PreferenceVector {
	cost_sensitivity: number;       // 0-1, 1=极度省钱
	accuracy_priority: number;      // 0-1, 1=质量至上
	latency_priority: number;       // 0-1, 1=wall-clock 优先
	parallelism_willingness: number;// 0-1, 1=愿意并行(多 context 成本)
	multi_agent_willingness: number;// 0-1, 1=倾向多 agent
}

/** 每个产品预设对应一组完整目标权重；custom 保留用户当前向量。 */
export const PRESET_VECTORS: Record<Exclude<Preset, "custom">, PreferenceVector> = {
	eco: { cost_sensitivity: 0.9, accuracy_priority: 0.45, latency_priority: 0.4, parallelism_willingness: 0.2, multi_agent_willingness: 0.15 },
	fast: { cost_sensitivity: 0.35, accuracy_priority: 0.55, latency_priority: 0.95, parallelism_willingness: 0.8, multi_agent_willingness: 0.45 },
	accurate: { cost_sensitivity: 0.15, accuracy_priority: 0.98, latency_priority: 0.3, parallelism_willingness: 0.65, multi_agent_willingness: 0.85 },
	balanced: { cost_sensitivity: 0.5, accuracy_priority: 0.6, latency_priority: 0.4, parallelism_willingness: 0.5, multi_agent_willingness: 0.4 },
};

export type Scenario = "bugfix" | "feature" | "refactor" | "explore" | "review";

export interface ScenarioOverride extends Partial<PreferenceVector> {
	profile?: Preset;
}

export type EscalateHint = "suggest" | "auto" | "silent";

export interface PreferenceConfig {
	profile: Preset;
	vector: PreferenceVector;
	scenarios: Partial<Record<Scenario, ScenarioOverride>>;
	escalate_hint: EscalateHint;
}

// ---------- 项目演进 (docs/14) ----------

export type ProjectStage = "Seed" | "Growth" | "Established" | "Mature";
export type ProjectRole = "doer" | "doer+reviewer" | "planner+orchestrator+reviewer" | "coordinator";

export interface MaturitySignals {
	file_count: number;
	commit_history: number;
	session_history: number;
	loc?: number;
	module_count?: number;
	dependency_depth?: number;
	cross_module_coupling?: number;
}

export interface ProjectProfile {
	version: number;
	project: { root: string; name: string };
	maturity: {
		stage: ProjectStage;
		stage_since: string;
		signals: MaturitySignals;
	};
	role: { primary: ProjectRole; delegate_impl: boolean };
	baseline_mode: Mode;
	history: Array<{ ts: string; event: string }>;
}

// ---------- 完整配置 (docs/04) ----------

export interface CacheConfig {
	prefix_layout: "static_first" | "none";
	cache_breaker_actions: string[];
	target_hit_rate: number;
}

export interface ContextConfig {
	compaction_threshold: number;
	mask_strategy: "hide_tool_results" | "none";
	mask_keep_last_n: number;
}

export interface BudgetConfig {
	max_cost_per_task: number;
	max_iterations: number;
	max_wall_clock_seconds: number;
}

export interface RoutingConfig {
	static_signals: boolean;
	budget_aware: boolean;
	experience_aware: boolean;
	override_mode: "auto" | "manual" | "suggest";
}

export interface RetentionConfig {
	enabled: boolean;
	stale_runtime_ttl_hours: number;
	terminal_agent_ttl_hours: number;
	max_terminal_agents: number;
	read_message_ttl_hours: number;
	max_read_messages: number;
	orphan_session_ttl_hours: number;
}

export interface CommunicationRuntimeConfig {
	/** Enable live Message V2 → pi turn delivery for a named RPC runtime. */
	rpc_inbox_pump: boolean;
	poll_interval_ms: number;
	batch_size: number;
	heartbeat_interval_ms: number;
	runtime_lease_ms: number;
	redelivery_after_ms: number;
}

import { DEFAULT_PRICING_CONFIG, type PricingConfig } from "./pricing";

export interface FluxConfig {
	mode: Preset;
	context_topology: ContextTopology;
	lifecycle: Lifecycle;
	parallelism: Parallelism;
	model_strategy: ModelStrategy;
	cache: CacheConfig;
	context: ContextConfig;
	budget: BudgetConfig;
	routing: RoutingConfig;
	retention: RetentionConfig;
	communication: CommunicationRuntimeConfig;
	pricing: PricingConfig;
	sharedSkills?: string[];       // 所有角色共享的 skills (docs/19)
}

export const DEFAULT_CONFIG: FluxConfig = {
	mode: "balanced",
	context_topology: "star",
	lifecycle: "mask",
	parallelism: "stage",
	model_strategy: "homogeneous",
	cache: { prefix_layout: "static_first", cache_breaker_actions: [], target_hit_rate: 0.85 },
	context: { compaction_threshold: 0.70, mask_strategy: "hide_tool_results", mask_keep_last_n: 3 },
	budget: { max_cost_per_task: 2.0, max_iterations: 5, max_wall_clock_seconds: 600 },
	routing: { static_signals: true, budget_aware: true, experience_aware: false, override_mode: "suggest" },
	retention: {
		enabled: true,
		stale_runtime_ttl_hours: 1,
		terminal_agent_ttl_hours: 168,
		max_terminal_agents: 100,
		read_message_ttl_hours: 72,
		max_read_messages: 500,
		orphan_session_ttl_hours: 168,
	},
	communication: {
		rpc_inbox_pump: false,
		poll_interval_ms: 1000,
		batch_size: 5,
		heartbeat_interval_ms: 10_000,
		runtime_lease_ms: 30_000,
		redelivery_after_ms: 30_000,
	},
	pricing: DEFAULT_PRICING_CONFIG,
};

export const DEFAULT_PREFERENCE: PreferenceConfig = {
	profile: "balanced",
	vector: { ...PRESET_VECTORS.balanced },
	scenarios: {},
	escalate_hint: "suggest",
};

// ---------- 路由决策 ----------

export interface RoutingDecision {
	mode: Mode;
	fallback: Mode;
	reason: string[];        // 触发理由链
	confidence: number;      // 0-1
	expected: { cost: "low" | "med" | "high"; latency: "low" | "med" | "high"; accuracy: "low" | "med" | "high" };
	biasSources: { maturity?: Mode; preference?: Mode; taskSignal?: Mode };
	applied?: boolean;       // F3-8: 是否自动应用 (override_mode=auto)
}

// ---------- 运行时状态 ----------

export interface CacheStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	contextTokens: number;
	contextWindow: number;
	contextPercent: number | null;
	cacheHitRate: number;
}

export interface FluxRuntimeState {
	mode: Mode;
	preset: Preset;
	expectedMode: Mode;
	stage: ProjectStage;
	role: ProjectRole;
	branch: string | null;
	turnIndex: number;
	cache: CacheStats;
}
