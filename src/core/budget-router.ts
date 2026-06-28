/**
 * AgentFlux F3-6 — 层2 预算路由 (启发式版, 替代 ILP)
 * 文档依据: docs/05-routing 层2, docs/22-mode-capability-roadmap
 *
 * 核心思路: 给定多个 agent/step 和它们的模型选项, 在预算约束下选择最优组合.
 *
 * 启发式策略 (替代 Python ortools ILP):
 *   1. 计算每个 agent 的模型候选集 (按能力排序)
 *   2. 初始化: 每个 agent 用最强模型
 *   3. 如果总成本超预算: 从 cost_eff 最低的 agent 开始降级
 *   4. 降级策略: 强模型→中等→便宜, 同时降低 thinking 级别
 *   5. 约束: 关键角色 (planner/reviewer) 最低保留 medium thinking
 *
 * 参考: BAMAS (EuroSys 2026) ILP+RL -86% 成本; AgentRouter 72% 成本降幅
 */

import type { Mode } from "./types";
import type { RoleDefinition } from "./role-manager";

// ─── 类型 ───

export interface AgentModelOption {
	/** agent 实例名 */
	agentName: string;
	/** 角色名 */
	role: string;
	/** 可选模型列表 (按优先级排序: 最优在前) */
	modelOptions: ModelOption[];
	/** 该 agent 的预估 token 使用量 */
	estimatedTokens: { input: number; output: number };
	/** 是否是关键角色 (不能降级太多) */
	critical: boolean;
}

export interface ModelOption {
	model: string;
	provider?: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** 单次调用预估成本 */
	estimatedCost: number;
	/** 能力评分 (reasoning * 0.4 + coding * 0.3 + speed * 0.3) */
	capabilityScore: number;
}

export interface BudgetPlan {
	assignments: Array<{
		agentName: string;
		role: string;
		model: string;
		provider?: string;
		thinking: string;
		cost: number;
		capabilityScore: number;
	}>;
	totalCost: number;
	totalCapabilityScore: number;
	withinBudget: boolean;
	reason: string[];
}

// ─── 预算优化器 ───

export interface BudgetOptimizerOptions {
	/** 总预算上限 (USD) */
	maxTotalCost: number;
	/** 单 agent 预算上限 */
	maxPerAgentCost?: number;
	/** 最低能力阈值 (关键角色不能低于此) */
	minCriticalCapability?: number;
}

/**
 * 启发式预算优化器.
 *
 * 算法:
 *   1. 初始化: 每个 agent 用最强 (第一个) 模型选项
 *   2. 如果总成本 ≤ 预算 → 返回
 *   3. 否则: 找到 "降级收益最大" 的 agent (非关键角色, 当前成本最高)
 *   4. 降级该 agent 到下一个更便宜的选项
 *   5. 重复 2-4 直到满足预算或无法降级
 */
export function optimizeBudget(
	agents: AgentModelOption[],
	opts: BudgetOptimizerOptions,
): BudgetPlan {
	const reason: string[] = [];

	// 1. 初始化: 每个 agent 用最强模型
	const assignments = agents.map(agent => {
		const best = agent.modelOptions[0]; // 第一个是最优
		return {
			agentName: agent.agentName,
			role: agent.role,
			model: best.model,
			provider: best.provider,
			thinking: best.thinking,
			cost: best.estimatedCost,
			capabilityScore: best.capabilityScore,
			optionIndex: 0,
			critical: agent.critical,
		};
	});

	let totalCost = assignments.reduce((s, a) => s + a.cost, 0);
	const minCritical = opts.minCriticalCapability ?? 0.5;

	reason.push(`initial: total=$${totalCost.toFixed(6)}, budget=$${opts.maxTotalCost.toFixed(6)}`);

	// 2. 如果在预算内, 直接返回
	if (totalCost <= opts.maxTotalCost) {
		reason.push("within budget, no optimization needed");
		return buildPlan(assignments, reason, opts);
	}

	// 3. 降级循环
	let iterations = 0;
	const maxIterations = agents.length * 5; // 防止无限循环

	while (totalCost > opts.maxTotalCost && iterations < maxIterations) {
		iterations++;

		// 找到可降级的 agent: 非关键角色优先, 当前成本最高的
		const downgradeable = assignments
			.map((a, i) => ({ ...a, index: i, agent: agents[i] }))
			.filter(a => {
				// 还有更便宜的选项
				if (a.optionIndex >= a.agent.modelOptions.length - 1) return false;
				// 关键角色检查最低能力
				if (a.critical) {
					const nextOption = a.agent.modelOptions[a.optionIndex + 1];
					if (nextOption.capabilityScore < minCritical) return false;
				}
				return true;
			})
			.sort((a, b) => {
				// 非关键角色优先降级
				if (a.critical !== b.critical) return a.critical ? 1 : -1;
				// 当前成本高的优先降级
				return b.cost - a.cost;
			});

		if (downgradeable.length === 0) {
			reason.push(`cannot meet budget: no more downgradeable agents (iter=${iterations})`);
			break;
		}

		// 降级第一个可降级的 agent
		const target = downgradeable[0];
		const oldCost = target.cost;
		const newOption = target.agent.modelOptions[target.optionIndex + 1];

		assignments[target.index] = {
			...assignments[target.index],
			model: newOption.model,
			provider: newOption.provider,
			thinking: newOption.thinking,
			cost: newOption.estimatedCost,
			capabilityScore: newOption.capabilityScore,
			optionIndex: target.optionIndex + 1,
		};

		totalCost = assignments.reduce((s, a) => s + a.cost, 0);
		reason.push(`downgrade ${target.agentName}: ${target.model}→${newOption.model} ($${oldCost.toFixed(6)}→$${newOption.estimatedCost.toFixed(6)}), total=$${totalCost.toFixed(6)}`);
	}

	return buildPlan(assignments, reason, opts);
}

function buildPlan(
	assignments: any[],
	reason: string[],
	opts: BudgetOptimizerOptions,
): BudgetPlan {
	const totalCost = assignments.reduce((s, a) => s + a.cost, 0);
	const totalCapabilityScore = assignments.reduce((s, a) => s + a.capabilityScore, 0);

	return {
		assignments: assignments.map(a => ({
			agentName: a.agentName,
			role: a.role,
			model: a.model,
			provider: a.provider,
			thinking: a.thinking,
			cost: a.cost,
			capabilityScore: a.capabilityScore,
		})),
		totalCost: Number(totalCost.toFixed(6)),
		totalCapabilityScore: Number(totalCapabilityScore.toFixed(2)),
		withinBudget: totalCost <= opts.maxTotalCost,
		reason,
	};
}

// ─── 从 models.json 构建 agent 模型选项 ───

/**
 * 为一组角色生成模型候选列表.
 *
 * 每个角色有 3 个候选: 强模型+高thinking, 中等模型+中thinking, 便宜模型+低thinking
 */
export function buildAgentModelOptions(
	roles: Array<{ name: string; role: string; critical: boolean; estimatedTokens: { input: number; output: number } }>,
	models: Record<string, any>,
): AgentModelOption[] {
	const modelEntries = Object.entries(models).map(([name, m]) => ({
		name,
		provider: m.provider,
		inputPrice: m.pricing?.input ?? 0,
		outputPrice: m.pricing?.output ?? 0,
		reasoning: m.capability?.reasoning ?? 0.5,
		coding: m.capability?.coding ?? 0.5,
		speed: m.capability?.speed ?? 0.5,
	}));

	if (modelEntries.length === 0) return [];

	// 按推理能力排序 (强→弱)
	const byReasoning = [...modelEntries].sort((a, b) => b.reasoning - a.reasoning);
	// 按成本效率排序 (便宜→贵)
	const byCost = [...modelEntries].sort((a, b) => (a.inputPrice + a.outputPrice) - (b.inputPrice + b.outputPrice));

	return roles.map(role => {
		const options: ModelOption[] = [];

		// 候选 1: 最强模型 + high thinking
		if (byReasoning[0]) {
			const m = byReasoning[0];
			const cost = role.estimatedTokens.input * m.inputPrice + role.estimatedTokens.output * m.outputPrice;
			options.push({
				model: m.name, provider: m.provider, thinking: "high",
				estimatedCost: cost,
				capabilityScore: m.reasoning * 0.4 + m.coding * 0.3 + m.speed * 0.3,
			});
		}

		// 候选 2: 中等模型 + medium thinking (如果有 2+ 模型)
		if (byReasoning[1]) {
			const m = byReasoning[1];
			const cost = role.estimatedTokens.input * m.inputPrice + role.estimatedTokens.output * m.outputPrice;
			options.push({
				model: m.name, provider: m.provider, thinking: "medium",
				estimatedCost: cost,
				capabilityScore: m.reasoning * 0.4 + m.coding * 0.3 + m.speed * 0.3,
			});
		}

		// 候选 3: 最便宜模型 + low thinking
		if (byCost[0]) {
			const m = byCost[0];
			const cost = role.estimatedTokens.input * m.inputPrice + role.estimatedTokens.output * m.outputPrice;
			options.push({
				model: m.name, provider: m.provider, thinking: "low",
				estimatedCost: cost,
				capabilityScore: m.reasoning * 0.4 + m.coding * 0.3 + m.speed * 0.3,
			});
		}

		return {
			agentName: role.name,
			role: role.role,
			modelOptions: options,
			estimatedTokens: role.estimatedTokens,
			critical: role.critical,
		};
	});
}

// ─── 格式化 ───

export function formatBudgetPlan(plan: BudgetPlan): string {
	const lines = [
		`[Budget Plan: ${plan.withinBudget ? "WITHIN BUDGET" : "OVER BUDGET"}]`,
		`  total cost $${plan.totalCost.toFixed(6)} · capability ${plan.totalCapabilityScore.toFixed(2)}`,
		"",
	];
	for (const a of plan.assignments) {
		lines.push(`  ${a.agentName.padEnd(20)} ${a.role.padEnd(12)} ${a.model.padEnd(20)} thinking=${a.thinking.padEnd(6)} $${a.cost.toFixed(6)} cap=${a.capabilityScore.toFixed(2)}`);
	}
	lines.push("");
	for (const r of plan.reason) lines.push(`  ${r}`);
	return lines.join("\n");
}
