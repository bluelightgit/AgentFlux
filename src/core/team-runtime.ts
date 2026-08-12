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

const LOW_COST_TEST_RUNTIME: Required<AgentFluxTeamTaskRuntime> = {
	model: "deepseek-v4-flash",
	provider: "octopus-completions",
	thinking: "off",
	maxTurns: 6,
	maxInputTokens: 12_000,
};

/**
 * 解析一次 Team 任务的运行参数：low_cost_test 档强制 Flash、关闭思考并限制
 * 轮次与输入 token；调用方传入的更严格上限（maxTurns/maxInputTokens）始终保留。
 */
export function resolveAgentFluxTeamTaskRuntime(
	spec: { executionProfile?: "default" | "low_cost_test" },
	item: Partial<AgentFluxTeamTaskRuntime>,
	defaults: { model?: string; provider?: string; thinking?: AgentTemplate["thinking"] },
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
	return {
		...LOW_COST_TEST_RUNTIME,
		maxTurns: Math.min(LOW_COST_TEST_RUNTIME.maxTurns, item.maxTurns ?? LOW_COST_TEST_RUNTIME.maxTurns),
		maxInputTokens: Math.min(
			LOW_COST_TEST_RUNTIME.maxInputTokens,
			item.maxInputTokens ?? LOW_COST_TEST_RUNTIME.maxInputTokens,
		),
	};
}
