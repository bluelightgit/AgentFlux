import type { AgentTemplate } from "../agents/agent-runner";

/**
 * Team 任务的单次运行运行时解析。
 * 从原 host API 迁入 core（host 层已随 Desktop 放弃而移除），供结构化 Team 调度与测试共用。
 */
export interface AgentFluxTeamTaskRuntime {
	model?: string;
	provider?: string;
	thinking?: AgentTemplate["thinking"];
	maxTurns?: number;
	maxInputTokens?: number;
}

/**
 * low_cost_test 只定义资源边界，不绑定某个 provider/model。
 * 具体模型由调用方的配置和 defaults 提供，避免 Core 因测试档案偷偷切换通道。
 */
export interface AgentFluxTeamExecutionProfiles {
	low_cost_test?: {
		model?: string;
		provider?: string;
		thinking?: AgentTemplate["thinking"];
		maxTurns?: number;
		maxInputTokens?: number;
	};
}

const DEFAULT_LOW_COST_LIMITS = {
	thinking: "off" as const,
	maxTurns: 6,
	maxInputTokens: 12_000,
};

/**
 * 解析一次 Team 任务的运行参数：low_cost_test 档只收窄 thinking、轮次和
 * input token；provider/model 从 profile 或调用方 defaults 继承。
 * 调用方传入的更严格上限始终保留，下层不会扩大其能力或预算。
 */
export function resolveAgentFluxTeamTaskRuntime(
	spec: { executionProfile?: "default" | "low_cost_test" },
	item: Partial<AgentFluxTeamTaskRuntime>,
	defaults: { model?: string; provider?: string; thinking?: AgentTemplate["thinking"] },
	profiles: AgentFluxTeamExecutionProfiles = {},
): AgentFluxTeamTaskRuntime {
	if (spec.executionProfile !== "low_cost_test") {
		return {
			model: item.model ?? defaults.model,
			provider: item.provider ?? defaults.provider,
			thinking: item.thinking ?? defaults.thinking,
			maxTurns: item.maxTurns,
			maxInputTokens: item.maxInputTokens,
		};
	}
	const configured = profiles.low_cost_test ?? {};
	const maxTurns = configured.maxTurns ?? DEFAULT_LOW_COST_LIMITS.maxTurns;
	const maxInputTokens = configured.maxInputTokens ?? DEFAULT_LOW_COST_LIMITS.maxInputTokens;
	if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("low_cost_test maxTurns must be a positive integer");
	if (!Number.isInteger(maxInputTokens) || maxInputTokens < 1) throw new Error("low_cost_test maxInputTokens must be a positive integer");
	return {
		model: configured.model ?? defaults.model,
		provider: configured.provider ?? defaults.provider,
		thinking: configured.thinking ?? DEFAULT_LOW_COST_LIMITS.thinking,
		maxTurns: Math.min(maxTurns, item.maxTurns ?? maxTurns),
		maxInputTokens: Math.min(maxInputTokens, item.maxInputTokens ?? maxInputTokens),
	};
}
