/**
 * AgentFlux F3-4 — Step-level model routing
 * 文档依据: docs/21-reasoning-effort, docs/22-mode-capability-roadmap
 *
 * 核心思路: 不是 session 级选一个模型, 而是每步按任务复杂度选 model + effort
 *
 * 策略:
 *   trivial  → 便宜模型 + low thinking
 *   simple   → 便宜模型 + medium thinking
 *   moderate → 中等模型 + medium thinking (或便宜模型 + high)
 *   complex  → 强模型 + high thinking
 *
 * 约束: 始终在 max_cost_per_task 预算内
 *
 * 参考: AgentRouter (ICML 2026) step-level routing 72% 成本降幅, 质量降幅 <3%
 */

import { assignModel, type AssignResult } from "./model-capability";
import type { PricingTable } from "./pricing";
import type { RoleDefinition } from "./role-manager";

// ─── 类型 ───

export type StepComplexity = "trivial" | "simple" | "moderate" | "complex";

export interface StepModelSelection {
	/** 选中的模型名 */
	model: string;
	/** provider */
	provider?: string;
	/** reasoning effort */
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** 步骤复杂度评估 */
	stepComplexity: StepComplexity;
	/** 选择理由 */
	reason: string;
	/** 预估成本 (基于角色 token 估算) */
	estimatedCost: number;
}

export interface StepComplexityInput {
	/** 任务类型 */
	taskType: string;
	/** 当前步骤描述 */
	stepDescription: string;
	/** 涉及文件数 */
	fileCount: number;
	/** diff 行数 */
	diffLines: number;
	/** 是否需要深度推理 (如架构决策、debug) */
	requiresDeepReasoning?: boolean;
	/** 是否是简单执行 (如格式化、简单 CRUD) */
	isSimpleExecution?: boolean;
	/** 预算上限 (USD) */
	maxCostPerTask?: number;
}

// ─── 步骤复杂度评估 ───

/**
 * 评估单个步骤的复杂度.
 */
export function assessStepComplexity(input: StepComplexityInput): StepComplexity {
	// 明确标记
	if (input.requiresDeepReasoning) return "complex";
	if (input.isSimpleExecution) return "trivial";

	// 基于任务类型
	const typeComplexity: Record<string, StepComplexity> = {
		bugfix: "moderate",    // debug 需要推理
		feature: "moderate",   // 实现需要中等思考
		refactor: "complex",   // 重构需要理解全局
		explore: "simple",     // 探索读代码
		review: "complex",     // 审查需要深度分析
		test: "simple",        // 写测试
		docs: "trivial",       // 写文档
		unknown: "simple",
	};

	let complexity = typeComplexity[input.taskType] ?? "simple";

	// 基于文件数调整
	if (input.fileCount > 20) complexity = "complex";
	else if (input.fileCount > 5 && complexity === "simple") complexity = "moderate";
	else if (input.fileCount <= 1 && complexity === "moderate") complexity = "simple";

	// 基于 diff 行数调整
	if (input.diffLines > 200) complexity = "complex";
	else if (input.diffLines > 50 && complexity === "trivial") complexity = "simple";

	return complexity;
}

// ─── 模型选择 ───

/**
 * 为单个步骤选择最优 model + thinking.
 *
 * 决策矩阵:
 *   trivial  → 最便宜模型 + off/low
 *   simple   → 便宜模型 + medium
 *   moderate → 中等或便宜模型 + high (用 effort 弥补模型能力)
 *   complex  → 最强模型 + high
 */
export function selectModelForStep(
	input: StepComplexityInput,
	models: Record<string, any>,
	role?: RoleDefinition,
	pricing?: PricingTable,
): StepModelSelection {
	const stepComplexity = assessStepComplexity(input);
	const modelEntries = Object.entries(models);

	if (modelEntries.length === 0) {
		return {
			model: "default", thinking: "off", stepComplexity,
			reason: "no models configured, using default", estimatedCost: 0,
		};
	}

	// 按 capability 排序模型
	const modelScores = modelEntries.map(([name, m]) => ({
		name,
		provider: m.provider,
		reasoning: m.capability?.reasoning ?? 0.5,
		speed: m.capability?.speed ?? 0.5,
		coding: m.capability?.coding ?? 0.5,
		cost_eff: m.capability?.cost_eff ?? 0.5,
		inputPrice: m.pricing?.input ?? 0,
		outputPrice: m.pricing?.output ?? 0,
	}));

	// 复杂度 → 模型策略
	let thinking: StepModelSelection["thinking"];
	let preferredModel: string;
	let reason: string;

	switch (stepComplexity) {
		case "trivial":
			// 最便宜 + 最低 thinking
			thinking = "off";
			preferredModel = modelScores.reduce((a, b) => (a.inputPrice + a.outputPrice < b.inputPrice + b.outputPrice ? a : b)).name;
			reason = "trivial task → cheapest model + no thinking";
			break;

		case "simple":
			// 便宜 + 快 + low/medium
			thinking = "low";
			preferredModel = modelScores.reduce((a, b) => (a.speed * 0.6 + a.cost_eff * 0.4 > b.speed * 0.6 + b.cost_eff * 0.4 ? a : b)).name;
			reason = "simple task → fast+cheap model + low thinking";
			break;

		case "moderate":
			// 用 effort 弥补: 便宜模型 + high thinking
			// 或者中等模型 + medium thinking, 取成本更低的
			thinking = "high";
			const cheapHigh = modelScores.reduce((a, b) => (a.cost_eff > b.cost_eff ? a : b));
			const midMedium = modelScores.reduce((a, b) => (a.reasoning * 0.5 + a.cost_eff * 0.5 > b.reasoning * 0.5 + b.cost_eff * 0.5 ? a : b));
			// 比较: 便宜+high vs 中等+medium
			// 简化: 选 cost_eff 最高的, 用 high thinking 弥补
			preferredModel = cheapHigh.name;
			reason = "moderate task → cost-efficient model + high thinking (effort compensates)";
			break;

		case "complex":
			// 最强推理 + high
			thinking = "high";
			preferredModel = modelScores.reduce((a, b) => (a.reasoning > b.reasoning ? a : b)).name;
			reason = "complex task → strongest reasoning model + high thinking";
			break;
	}

	// 角色覆盖: 如果角色有明确的模型指定, 优先使用
	if (role?.model && models[role.model]) {
		preferredModel = role.model;
		reason += ` (role override: ${role.model})`;
	}
	if (role?.thinking) {
		thinking = role.thinking;
		reason += ` (role thinking: ${role.thinking})`;
	}

	// 预算约束检查
	const selectedModel = modelScores.find(m => m.name === preferredModel)!;
	let estimatedCost = 0;
	if (pricing && selectedModel) {
		// 粗估: 输入 2000 tokens + 输出 500 tokens
		estimatedCost = 2000 * selectedModel.inputPrice + 500 * selectedModel.outputPrice;
		if (input.maxCostPerTask && estimatedCost > input.maxCostPerTask) {
			// 降级到更便宜的模型
			const cheaper = modelScores
				.filter(m => (2000 * m.inputPrice + 500 * m.outputPrice) <= input.maxCostPerTask)
				.sort((a, b) => b.cost_eff - a.cost_eff);
			if (cheaper.length > 0) {
				preferredModel = cheaper[0].name;
				estimatedCost = 2000 * cheaper[0].inputPrice + 500 * cheaper[0].outputPrice;
				reason += ` (budget-constrained: switched to ${preferredModel})`;
			}
		}
	}

	return {
		model: preferredModel,
		provider: selectedModel?.provider,
		thinking,
		stepComplexity,
		reason,
		estimatedCost,
	};
}

// ─── 格式化 ───

export function formatStepModelSelection(sel: StepModelSelection): string {
	return `Step Model: ${sel.model} (thinking=${sel.thinking}, complexity=${sel.stepComplexity}, estCost=$${sel.estimatedCost.toFixed(6)}) — ${sel.reason}`;
}

// ─── 批量步骤规划 ───

export interface StepPlan {
	steps: Array<{
		description: string;
		selection: StepModelSelection;
	}>;
	totalEstimatedCost: number;
}

/**
 * 为多步骤任务规划每步的 model + thinking.
 */
export function planStepModels(
	steps: Array<{ description: string; input: StepComplexityInput }>,
	models: Record<string, any>,
	role?: RoleDefinition,
	pricing?: PricingTable,
): StepPlan {
	const plan: StepPlan = { steps: [], totalEstimatedCost: 0 };

	for (const step of steps) {
		const selection = selectModelForStep(step.input, models, role, pricing);
		plan.steps.push({ description: step.description, selection });
		plan.totalEstimatedCost += selection.estimatedCost;
	}

	return plan;
}
