/**
 * AgentFlux F3-1 — M6 异构团队 (heterogeneous multi-agent)
 * 文档依据: docs/03-modes M6, docs/21-reasoning-effort, docs/22-mode-capability-roadmap
 *
 * M6 与 M4 的核心区别:
 *   M4: 所有 agent 用相同模型 (homogeneous)
 *   M6: 不同 agent 用不同模型 (heterogeneous) — opus/strong 做决策, flash/cheap 做执行
 *
 * 异构策略:
 *   - planner/reviewer: 强模型 + high thinking (需要推理能力)
 *   - implementer/tester: 便宜模型 + medium thinking (需要编码速度)
 *   - 每个角色可独立配置 model + thinking
 *
 * 参考: OneFlow 证明异构是多 agent 唯一不可替代价值
 *       AgentRouter: step-level model routing 72% 成本降幅
 */

import { runSubagent, type SubagentDef, type SubagentRunResult } from "./subagent";
import { runSubagentsParallel, type ParallelSubagentTask, type ParallelRunResult } from "./subagent";
import { checkQualityGate, type QualityGateResult } from "./quality-gate";
import { loadAllRoles, type RoleDefinition } from "../core/role-manager";
import { SharedBoard } from "../core/shared-board";
import type { TelemetryWriter } from "../telemetry/events";
import type { PricingTable } from "../core/pricing";
import type { Mode } from "../core/types";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// ─── 异构团队配置 ───

export interface HeterogeneousAgentConfig {
	/** 角色名 (planner/implementer/reviewer/tester 或自定义) */
	role: string;
	/** 实例名 (唯一) */
	name: string;
	/** 强制指定模型 (覆盖角色默认模型) */
	model?: string;
	/** 强制指定 provider */
	provider?: string;
	/** 强制指定 reasoning effort (覆盖角色默认) */
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** 任务文本 */
	task: string;
	/** 依赖的其他 agent 实例名 (用于拓扑序) */
	dependsOn?: string[];
	/** 验收标准 (质量门) */
	acceptanceCriteria?: string[];
	/** 涉及文件 (用于冲突检测) */
	files?: string[];
}

export interface HeterogeneousTeamConfig {
	/** 团队名称 */
	teamName: string;
	/** agent 列表 */
	agents: HeterogeneousAgentConfig[];
	/** 整体任务描述 */
	description: string;
	/** 最大重试次数 */
	maxRetries?: number;
	/** 是否启用质量门 */
	enableQualityGate?: boolean;
}

export interface HeterogeneousAgentResult {
	config: HeterogeneousAgentConfig;
	result: SubagentRunResult;
	gateResult: QualityGateResult | null;
	retryCount: number;
	passed: boolean;
	/** 实际使用的模型 */
	modelUsed: string;
	/** 实际使用的 thinking 级别 */
	thinkingUsed: string;
}

export interface HeterogeneousTeamResult {
	teamName: string;
	agentResults: Map<string, HeterogeneousAgentResult>;
	allPassed: boolean;
	totalCost: number;
	wallClockMs: number;
	/** 模型多样性报告: 各模型被使用次数 */
	modelUsage: Record<string, number>;
	/** 成本对比: 如果全用最贵模型 vs 异构 */
	costSavings: { homogeneous: number; heterogeneous: number; savings: number };
}

// ─── M6 异构团队执行器 ───

export interface M6ExecutorOptions {
	cwd: string;
	fluxDir: string;
	modelsConfig: any;
	telemetry: TelemetryWriter;
	prefixLayout: boolean;
	pricing?: PricingTable;
	sessionId: string;
	sharedSkills?: string[];
}

/**
 * 执行 M6 异构团队.
 *
 * 工作流:
 *   1. 按拓扑序执行 agent (dependsOn)
 *   2. 独立 agent (无依赖) 并行执行
 *   3. 每个 agent 用自己的 model + thinking
 *   4. 质量门检查 + 自动重试
 *   5. 成本对比: 异构 vs 同构 (全用最贵模型)
 */
export async function executeHeterogeneousTeam(
	teamConfig: HeterogeneousTeamConfig,
	opts: M6ExecutorOptions,
): Promise<HeterogeneousTeamResult> {
	const wallStart = Date.now();
	const roles = loadAllRoles(opts.cwd, opts.modelsConfig);
	const models = opts.modelsConfig?.models ?? {};
	const maxRetries = teamConfig.maxRetries ?? 2;
	const enableGate = teamConfig.enableQualityGate ?? true;

	const agentResults = new Map<string, HeterogeneousAgentResult>();
	const completed = new Set<string>();
	const failed = new Set<string>();
	let totalCost = 0;
	const modelUsage: Record<string, number> = {};

	// 主循环: 拓扑序执行
	while (completed.size + failed.size < teamConfig.agents.length) {
		// 找就绪 agent
		const ready = teamConfig.agents.filter(a =>
			!completed.has(a.name) &&
			!failed.has(a.name) &&
			(a.dependsOn ?? []).every(d => completed.has(d))
		);

		if (ready.length === 0) {
			const remaining = teamConfig.agents.filter(a => !completed.has(a.name) && !failed.has(a.name));
			console.error(`[flux m6] deadlock: remaining=${remaining.map(a => a.name).join(",")}`);
			for (const a of remaining) failed.add(a.name);
			break;
		}

		console.error(`[flux m6] executing ${ready.length} agent(s): ${ready.map(a => `${a.name}(${a.model ?? a.role})`).join(", ")}`);

		// 并行执行就绪 agent (每个用不同 model)
		const batchResults = await Promise.all(
			ready.map(agentConfig => executeHeterogeneousAgent(agentConfig, roles, models, opts, maxRetries, enableGate))
		);

		for (const agentResult of batchResults) {
			totalCost += agentResult.result.usage.cost + (agentResult.gateResult?.gateCost ?? 0);
			modelUsage[agentResult.modelUsed] = (modelUsage[agentResult.modelUsed] || 0) + 1;
			agentResults.set(agentResult.config.name, agentResult);

			if (agentResult.passed) {
				completed.add(agentResult.config.name);
				console.error(`[flux m6] ${agentResult.config.name} ✅ passed (model=${agentResult.modelUsed}, thinking=${agentResult.thinkingUsed}, cost=$${agentResult.result.usage.cost.toFixed(6)})`);
			} else {
				failed.add(agentResult.config.name);
				console.error(`[flux m6] ${agentResult.config.name} ❌ failed after ${agentResult.retryCount} retries`);

				// 条件分支: reviewer 失败 → 重跑依赖的 implementer
				if (agentResult.config.role === "reviewer" && (agentResult.config.dependsOn ?? []).length > 0) {
					const implName = agentResult.config.dependsOn![0];
					if (completed.has(implName)) {
						console.error(`[flux m6] reviewer failed, re-running ${implName}`);
						completed.delete(implName);
					}
				}
			}
		}
	}

	const wallClockMs = Date.now() - wallStart;
	const allPassed = failed.size === 0;

	// 成本对比: 异构 vs 同构 (全用最贵模型)
	const costSavings = computeCostSavings(teamConfig, agentResults, models, opts.pricing);

	return {
		teamName: teamConfig.teamName,
		agentResults, allPassed, totalCost: Number(totalCost.toFixed(6)),
		wallClockMs, modelUsage, costSavings,
	};
}

// ─── 单个异构 agent 执行 ───

async function executeHeterogeneousAgent(
	config: HeterogeneousAgentConfig,
	roles: Map<string, RoleDefinition>,
	models: Record<string, any>,
	opts: M6ExecutorOptions,
	maxRetries: number,
	enableGate: boolean,
): Promise<HeterogeneousAgentResult> {
	const role = roles.get(config.role);

	// 解析模型: config.model > role.model > undefined (继承默认)
	const modelUsed = config.model ?? role?.model ?? "default";
	const providerUsed = config.provider ?? (config.model ? models[config.model]?.provider : undefined);
	const thinkingUsed = config.thinking ?? role?.thinking ?? "off";

	// 构建 agent 定义
	const agentDef: SubagentDef = {
		name: config.name,
		description: role?.description ?? config.role,
		tools: role?.tools,
		model: config.model ?? role?.model,
		provider: providerUsed,
		systemPrompt: role?.systemPrompt ?? `You are a ${config.role}.`,
		thinking: thinkingUsed,
		skills: [...(opts.sharedSkills ?? []), ...(role?.skills ?? [])].length > 0
			? [...(opts.sharedSkills ?? []), ...(role?.skills ?? [])] : undefined,
	};

	let retryCount = 0;
	let lastResult: SubagentRunResult | null = null;
	let lastGateResult: QualityGateResult | null = null;
	let totalAgentCost = 0;

	while (retryCount <= maxRetries) {
		const taskText = retryCount > 0 && lastGateResult
			? `${config.task}\n\nPrevious attempt failed quality gate:\n${lastGateResult.feedback}\n\nPlease fix and retry.`
			: config.task;

		const result = await runSubagent({
			cwd: opts.cwd,
			agent: agentDef,
			task: taskText,
			sessionId: opts.sessionId,
			telemetry: opts.telemetry,
			prefixLayout: opts.prefixLayout,
			model: config.model ?? role?.model,
			provider: providerUsed,
			pricing: opts.pricing,
			thinking: thinkingUsed,
		});

		lastResult = result;
		totalAgentCost += result.usage.cost;

		// 质量门
		if (enableGate && (config.acceptanceCriteria ?? []).length > 0 && result.output) {
			lastGateResult = await checkQualityGate(
				result.output,
				config.acceptanceCriteria!,
				{ cwd: opts.cwd, model: opts.modelsConfig?.models && Object.keys(opts.modelsConfig.models)[0], provider: undefined, pricing: opts.pricing, telemetry: opts.telemetry, sessionId: opts.sessionId },
			);
			totalAgentCost += lastGateResult.gateCost;

			if (lastGateResult.passed) {
				return { config, result, gateResult: lastGateResult, retryCount, passed: true, modelUsed, thinkingUsed };
			}

			console.error(`[flux m6] ${config.name} gate failed (attempt ${retryCount + 1}/${maxRetries + 1})`);
			retryCount++;
			continue;
		}

		return { config, result, gateResult: null, retryCount, passed: result.exitCode === 0, modelUsed, thinkingUsed };
	}

	return { config, result: lastResult!, gateResult: lastGateResult, retryCount, passed: false, modelUsed, thinkingUsed };
}

// ─── 成本对比 ───

function computeCostSavings(
	teamConfig: HeterogeneousTeamConfig,
	agentResults: Map<string, HeterogeneousAgentResult>,
	models: Record<string, any>,
	pricing?: PricingTable,
): { homogeneous: number; heterogeneous: number; savings: number } {
	// 异构总成本 (实际)
	const heterogeneous = [...agentResults.values()].reduce((s, r) => s + r.result.usage.cost, 0);

	// 同构假设: 全用最贵的模型
	const modelPrices = Object.entries(models).map(([name, m]) => ({
		name,
		input: m.pricing?.input ?? 0,
		output: m.pricing?.output ?? 0,
	}));
	if (modelPrices.length === 0) return { homogeneous: 0, heterogeneous, savings: 0 };

	const mostExpensive = modelPrices.reduce((a, b) => (b.input + b.output > a.input + a.output ? b : a));

	// 估算: 如果全用最贵模型, 成本约为实际成本的 (最贵价格/实际平均价格) 倍
	const actualModels = [...agentResults.values()].map(r => r.modelUsed);
	const avgPrice = actualModels.reduce((s, modelName) => {
		const m = models[modelName];
		return s + ((m?.pricing?.input ?? 0) + (m?.pricing?.output ?? 0));
	}, 0) / (actualModels.length || 1);

	const expensivePrice = mostExpensive.input + mostExpensive.output;
	const ratio = avgPrice > 0 ? expensivePrice / avgPrice : 1;
	const homogeneous = heterogeneous * ratio;

	return {
		homogeneous: Number(homogeneous.toFixed(6)),
		heterogeneous: Number(heterogeneous.toFixed(6)),
		savings: Number(((homogeneous - heterogeneous) / (homogeneous || 1) * 100).toFixed(1)),
	};
}

// ─── 预设异构团队模板 ───

/**
 * 创建标准异构团队配置 (planner=strong, implementer=cheap, reviewer=strong).
 */
export function createStandardHeterogeneousTeam(
	task: string,
	modelsConfig: any,
	opts?: {
		strongModel?: string;
		cheapModel?: string;
		files?: string[];
	},
): HeterogeneousTeamConfig {
	const models = modelsConfig?.models ?? {};
	const modelNames = Object.keys(models);

	// 选择强模型和便宜模型
	const strongModel = opts?.strongModel ?? modelNames.find(n => models[n].capability?.reasoning >= 0.85) ?? modelNames[0];
	const cheapModel = opts?.cheapModel ?? modelNames.find(n => models[n].capability?.speed >= 0.8) ?? modelNames[modelNames.length - 1];

	return {
		teamName: `hetero-${Date.now()}`,
		description: task,
		agents: [
			{
				role: "planner", name: "hetero-planner",
				model: strongModel, thinking: "high",
				task: `Analyze this task and create an implementation plan:\n\n${task}`,
				dependsOn: [], files: opts?.files ?? [],
				acceptanceCriteria: ["Plan has at least 2 steps", "Plan identifies key files"],
			},
			{
				role: "implementer", name: "hetero-impl",
				model: cheapModel, thinking: "medium",
				task: `Implement according to the plan. Task: ${task}`,
				dependsOn: ["hetero-planner"], files: opts?.files ?? [],
				acceptanceCriteria: ["Output describes implementation", "Output mentions key changes"],
			},
			{
				role: "reviewer", name: "hetero-reviewer",
				model: strongModel, thinking: "high",
				task: `Review the implementation. Task: ${task}`,
				dependsOn: ["hetero-impl"],
				acceptanceCriteria: ["Output has review verdict", "Output mentions at least 1 finding"],
			},
		],
	};
}

// ─── 格式化 ───

export function formatHeterogeneousTeamResult(r: HeterogeneousTeamResult): string {
	const lines = [
		`[M6 Heterogeneous Team: ${r.teamName}]`,
		`  result: ${r.allPassed ? "ALL PASSED" : `${[...r.agentResults.values()].filter(a => !a.passed).length} FAILED`}`,
		`  wall ${(r.wallClockMs / 1000).toFixed(1)}s · cost $${r.totalCost.toFixed(6)}`,
		`  models used: ${Object.entries(r.modelUsage).map(([m, c]) => `${m}×${c}`).join(", ")}`,
		`  cost savings: ${r.costSavings.savings}% (hetero $${r.costSavings.heterogeneous.toFixed(6)} vs homo $${r.costSavings.homogeneous.toFixed(6)})`,
		"",
	];
	for (const [, ar] of r.agentResults) {
		const gateIcon = ar.gateResult ? (ar.gateResult.passed ? "✅" : "❌") : "—";
		const retry = ar.retryCount > 0 ? ` (retries=${ar.retryCount})` : "";
		lines.push(`  ${ar.config.name.padEnd(20)} ${ar.config.role.padEnd(12)} ${ar.modelUsed.padEnd(20)} thinking=${ar.thinkingUsed.padEnd(6)} ${gateIcon}${retry} $${ar.result.usage.cost.toFixed(6)}`);
	}
	return lines.join("\n");
}
