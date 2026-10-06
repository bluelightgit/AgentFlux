import { DEFAULT_PRICING_CONFIG, type PricingConfig } from "./pricing";
import type { RunHealthConfig } from "./run-health";

export type AgentScope = "global" | "project" | "session";
export type AgentKind = "main" | "subagent";
export type AgentOrigin = "fresh" | "template" | "fork";
export type AgentStatus = "idle" | "running" | "blocked" | "done" | "failed" | "cancelled" | "archived";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentLineage {
	origin: AgentOrigin;
	parentAgentId?: string;
	templateId?: string;
	templateIds?: string[];
	templateRevision?: number;
	forkPoint?: string;
	contextSnapshotId?: string;
}

export interface AgentRecord {
	id: string;
	name: string;
	scope: AgentScope;
	role: string;
	/** 允许该 Agent 在不同 Run 中承担的角色；role 是首选/兼容字段。 */
	roles?: string[];
	status: AgentStatus;
	lineage: AgentLineage;
	model?: string;
	provider?: string;
	thinking?: ThinkingLevel;  // 创建时覆盖角色模板的思考等级
	sessionId?: string;
	/** 最近一次物理运行使用的持久会话 key；fresh 运行与身份基准 sessionId 分开。 */
	lastSessionId?: string;
	ownerSessionId?: string;
	createdAt: string;
	updatedAt: string;
	lastTask?: string;
	lastRole?: string;
	callCount: number;
	totalCostUsd: number;
	capabilityGeneration: number;
	lastResult?: { exitCode: number; success: boolean; summary: string; turns: number; costUsd: number; model?: string; role?: string; at: string };  // 最近一次运行结果摘要（后台运行时供 list 查询）
}

export interface CacheStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	contextTokens: number;
	contextWindow?: number;
	costComplete?: boolean;
	contextPercent: number | null;
	cacheHitRate: number;
}

export interface CacheConfig {
	prefix_layout: "static_first" | "none";
	cache_breaker_actions: string[];
	target_hit_rate: number;
}

export interface ContextConfig {
	compaction_threshold: number;
}

export interface BudgetConfig {
	max_cost_per_task: number;
	max_iterations: number;
	/** Parent Task aggregate assistant-turn budget; omitted means no turn cap. */
	max_turns_per_task?: number;
	/** Parent Task aggregate input-token budget; omitted means no input cap. */
	max_input_tokens_per_task?: number;
	/** Active child Run limit for one parent Task. */
	max_parallel_agents?: number;
	/** undefined/null means no model-execution wall-clock deadline. */
	max_wall_clock_seconds?: number | null;
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
	rpc_inbox_pump: boolean;
	poll_interval_ms: number;
	batch_size: number;
	heartbeat_interval_ms: number;
	runtime_lease_ms: number;
	redelivery_after_ms: number;
}

export type SubagentRuntime = "process" | "sdk";

export interface FluxConfig {
	/** 技术执行后端；省略兼容既有 process，新 Run 读取后冻结。 */
	subagent_runtime?: SubagentRuntime;
	cache: CacheConfig;
	context: ContextConfig;
	budget: BudgetConfig;
	retention: RetentionConfig;
	communication: CommunicationRuntimeConfig;
	pricing: PricingConfig;
	quality_gate?: QualityGateConfig;
	/** 健康监控只产生 Core 事实和提示，不自动结束模型 Run。 */
	health?: RunHealthConfig;
	/** 社区无进展门禁：连续退回且反馈为空/重复达到该次数后拒绝继续（默认 3）。 */
	community_stall_threshold?: number;
}

/** 质量门配置: judge 独立于节点模型, 避免节点模型慢导致 judge 超时。 */
export interface QualityGateConfig {
	model?: string;
	provider?: string;
	thinking?: ThinkingLevel;
	/** null/omitted means the judge has no model-execution wall-clock deadline. */
	timeout_ms?: number | null;
}

export const DEFAULT_CONFIG: FluxConfig = {
	subagent_runtime: "process",
	cache: { prefix_layout: "none", cache_breaker_actions: [], target_hit_rate: 0.85 },
	context: { compaction_threshold: 0.70 },
	budget: { max_cost_per_task: 2, max_iterations: 5, max_turns_per_task: undefined, max_input_tokens_per_task: undefined, max_parallel_agents: 4, max_wall_clock_seconds: null },
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
	quality_gate: {},
	health: {
		waiting_provider_after_ms: 30_000,
		quiet_after_ms: 60_000,
		suspected_stall_after_ms: 120_000,
		suspected_loop_repeats: 3,
		warning_cooldown_ms: 60_000,
		context_pressure_percent: 0.85,
	},
	pricing: DEFAULT_PRICING_CONFIG,
};

export interface FluxRuntimeState {
	turnIndex: number;
	branch: string | null;
	cache: CacheStats;
}
