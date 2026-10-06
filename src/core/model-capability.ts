/**
 * 模型能力层 — 能力向量 × 角色需求 = 亲和度匹配
 * 文档依据: docs/17-model-capability.md
 *
 * 设计:
 *   model_capability = { coding, reasoning, speed, context, cost_eff }  (0-1)
 *   role_requirement = { coding, reasoning, speed, context, cost_eff }  (0-1)
 *   affinity(model, role) = Σ (requirement[k] × capability[k])
 *   assign(role) = argmax_model affinity
 *
 * 数据来源四层降级:
 *   1. 用户在 models.json 手动填 capability
 *   2. (后续) 远程 benchmark API
 *   3. 模型家族启发式
 *   4. 均值兜底
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildChatCatalog } from "./model-catalog";

// ──────────────────────────────── 类型 ────────────────────────────────

export interface ModelCapability {
	coding: number;     // 0-1, 编码能力
	reasoning: number;  // 0-1, 推理能力
	speed: number;      // 0-1, 速度
	context: number;    // 0-1, 上下文窗口 (log scale)
	cost_eff: number;   // 0-1, 性价比
}

export interface RoleRequirement {
	coding?: number;
	reasoning?: number;
	speed?: number;
	context?: number;
	cost_eff?: number;
}

export interface ModelEntry {
	provider: string;
	contextWindow?: number;
	id?: string;
	type?: string;
	api?: string;
	available?: boolean;
	virtual?: boolean;
	requiresHostRegistration?: boolean;
	pricing?: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	capability?: Partial<ModelCapability>;  // 用户手填的部分
}

export interface ModelsConfig {
	models: Record<string, ModelEntry>;
}

// ──────────────────────────────── pi 模型自动发现 ────────────────────────────────

/**
 * pi 的 models.json 中单个模型的接口 (部分字段)
 */
interface PiModelEntry {
	id: string;
	name: string;
	type?: string;
	api?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

interface PiProviderConfig {
	baseUrl?: string;
	api?: string;
	models: PiModelEntry[];
}

interface PiModelsFile {
	providers: Record<string, PiProviderConfig>;
}

/**
 * 从 pi 的 ~/.pi/agent/models.json 自动发现所有可用模型.
 * 将 pi provider+model 展开为 AgentFlux ModelEntry 格式.
 * capability 和 pricing 留空 (由 resolveCapability 的家族启发式填充).
 *
 * @param piModelsPath pi models.json 路径, 默认 ~/.pi/agent/models.json
 * @returns Record<modelId, ModelEntry> — key 是模型 id (如 "gpt-5.5", "oa/glm-5.2")
 */
export function discoverPiModels(piModelsPath?: string): Record<string, ModelEntry> {
	try {
		const path = piModelsPath ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "models.json");
		if (!existsSync(path)) return {};
		const raw = readFileSync(path, "utf-8");
		const data = JSON.parse(raw) as PiModelsFile;
		if (!data.providers) return {};

		const models = Object.entries(data.providers).flatMap(([provider, config]) =>
			Array.isArray(config?.models) ? config.models.map(model => ({ ...model, provider })) : []);
		return buildChatCatalog(models);
	} catch {
		return {};
	}
}

/**
 * 合并模型表: AgentFlux models.json 优先, pi 发现的模型补充.
 * AgentFlux models.json 中已有的模型保留其 capability/pricing,
 * pi 发现的新模型用空 capability/pricing (家族启发式 + 远程 pricing 填充).
 */
export function mergeModels(
	agentFluxModels: Record<string, ModelEntry>,
	piModels: Record<string, ModelEntry>,
): Record<string, ModelEntry> {
	const merged: Record<string, ModelEntry> = { ...piModels };
	for (const [id, entry] of Object.entries(agentFluxModels)) {
		// AgentFlux 条目覆盖 pi 条目 (保留 capability + pricing)
		merged[id] = entry;
	}
	return merged;
}

/**
 * 模型降级: 从可用模型中选出比当前模型低一档的候选.
 * 策略: 用 rankModels 按角色需求排序, 返回排在当前模型之后的第一个模型.
 *
 * @param failedModel 失败的模型名
 * @param requirement 角色需求 (决定排序)
 * @param models 全部可用模型
 * @returns 降级模型名, 或 null (无可用降级)
 */
export function findFallbackModel(
	failedModel: string,
	requirement: RoleRequirement,
	models: Record<string, ModelEntry>,
): string | null {
	const ranked = rankModels(requirement, models);
	// 找到失败模型在排序列表中的位置
	const failedIndex = ranked.findIndex(r => r.model === failedModel);
	if (failedIndex === -1) {
		// 失败模型不在列表中, 返回最后一个 (最低档)
		return ranked.length > 0 ? ranked[ranked.length - 1].model : null;
	}
	// 返回排在后面的第一个 (更低档)
	if (failedIndex + 1 < ranked.length) {
		return ranked[failedIndex + 1].model;
	}
	// 已经是最低档, 无法降级
	return null;
}

// ──────────────────────────────── 启发式 ────────────────────────────────

const FAMILY_HEURISTICS: Record<string, Partial<ModelCapability>> = {
	gpt:      { coding: 0.85, reasoning: 0.90, speed: 0.40 },
	claude:   { coding: 0.88, reasoning: 0.92, speed: 0.45 },
	opus:     { coding: 0.88, reasoning: 0.92, speed: 0.45 },
	sonnet:   { coding: 0.82, reasoning: 0.82, speed: 0.65 },
	haiku:    { coding: 0.70, reasoning: 0.65, speed: 0.90 },
	deepseek: { coding: 0.78, reasoning: 0.70, speed: 0.80 },
	gemini:   { coding: 0.80, reasoning: 0.82, speed: 0.70 },
	qwen:     { coding: 0.75, reasoning: 0.75, speed: 0.75 },
	glm:      { coding: 0.76, reasoning: 0.76, speed: 0.72 },
	llama:    { coding: 0.72, reasoning: 0.72, speed: 0.75 },
	mistral:  { coding: 0.75, reasoning: 0.73, speed: 0.78 },
};

const DEFAULT_CAPABILITY: ModelCapability = {
	coding: 0.50,
	reasoning: 0.50,
	speed: 0.50,
	context: 0.50,
	cost_eff: 0.50,
};

/**
 * 从模型名识别家族
 */
function detectFamily(modelName: string): string | null {
	const lower = modelName.toLowerCase();
	for (const family of Object.keys(FAMILY_HEURISTICS)) {
		if (lower.includes(family)) return family;
	}
	// 额外模式匹配
	if (lower.includes("o1") || lower.includes("o3") || lower.includes("o4")) return "gpt";
	if (lower.includes("v3") || lower.includes("v4")) {
		if (lower.includes("deepseek")) return "deepseek";
	}
	return null;
}

/**
 * 从 contextWindow 计算 context 维度分数 (200K 饱和)
 * 4K → 0.58, 32K → 0.72, 128K → 0.82, 200K+ → 0.85 (饱和)
 * 超过 200K 后所有模型得分相同, 区分度来自其他维度.
 */
export function contextToScore(contextWindow: number): number {
	if (contextWindow <= 0) return 0;
	// 0.85 * min(1, log2(ctx)/log2(200000))
	// 200K 及以上全部 = 0.85, 200K 以下按 log scale 递减
	const ratio = Math.log2(contextWindow) / Math.log2(200000);
	return Math.max(0, Math.min(0.85, 0.85 * Math.min(1, ratio)));
}

/**
 * 从 models.dev API 查询模型能力数据 (reasoning/tool_call/context)
 * 返回部分 ModelCapability 字段, 用于补充/替代家族启发式
 */
export async function fetchCapabilityFromModelsDev(
	modelName: string,
	modelsDevUrl = "https://models.dev/api.json",
	timeoutMs = 10000,
): Promise<Partial<ModelCapability> & { contextWindow?: number }> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const resp = await fetch(modelsDevUrl, { signal: ctrl.signal });
		clearTimeout(timer);
		if (!resp.ok) return {};
		const data = await resp.json();

		// 生成候选 (复用 pricing 的前缀剥离逻辑)
		const candidates = [modelName];
		if (modelName.includes("/")) {
			candidates.push(modelName.split("/").pop()!);
		}

		// 遍历所有 provider 的 models 查找匹配
		for (const [provId, prov] of Object.entries(data)) {
			const p = prov as any;
			if (!p?.models) continue;
			for (const [modelId, m] of Object.entries(p.models)) {
				const mm = m as any;
				const idLower = modelId.toLowerCase();
				const modelPart = modelId.split("/").pop()?.toLowerCase() ?? idLower;
				// 精确匹配候选
				const matched = candidates.some(c =>
					c.toLowerCase() === idLower || c.toLowerCase() === modelPart
				);
				if (!matched) continue;

				// 从 models.dev 字段映射到 AgentFlux 能力向量
				const contextWindow = mm.limit?.context ?? 0;
				const result: Partial<ModelCapability> & { contextWindow?: number } = {};

				// reasoning: models.dev 有布尔值 → 映射为 0.5+0.3*has
				if (mm.reasoning !== undefined) {
					result.reasoning = mm.reasoning ? 0.85 : 0.50;
				}
				// tool_call → coding 的近似指标
				if (mm.tool_call !== undefined) {
					result.coding = mm.tool_call ? 0.78 : 0.55;
				}
				// context window
				if (contextWindow > 0) {
					result.contextWindow = contextWindow;
					result.context = contextToScore(contextWindow);
				}
				// speed: 无直接字段, 用 family 启发式
				return result;
			}
		}
		return {};
	} catch {
		return {};
	}
}

/**
 * 从 pricing 计算 cost_eff 维度分数
 * 越便宜越高分。用所有模型的均价做参考点。
 * 用 log scale 拉平平价与高价模型的差距, 避免极便宜模型在所有角色上都赢。
 */
export function pricingToCostEff(
	pricing: { input: number; output: number } | undefined,
	allPricings: { input: number; output: number }[],
): number {
	if (!pricing) return 0.50;
	const costs = allPricings.map(p => p.input + p.output).filter(c => c > 0);
	if (costs.length === 0) return 0.50;
	const myCost = pricing.input + pricing.output;
	if (myCost <= 0) return 1.0;
	// 用 log scale: log(cost) 归一化, 再翻转
	const logCosts = costs.map(c => Math.log10(c + 1e-12));
	const myLog = Math.log10(myCost + 1e-12);
	const minLog = Math.min(...logCosts);
	const maxLog = Math.max(...logCosts);
	if (maxLog === minLog) return 0.50;  // 所有模型同价
	// log scale 映射: 最便宜 → 0.85, 最贵 → 0.25
	const normalized = (myLog - minLog) / (maxLog - minLog);  // 0=最便宜, 1=最贵
	const score = 0.85 - normalized * 0.60;  // 映射到 0.25-0.85
	return Math.max(0.1, Math.min(1, score));
}

// ──────────────────────────────── 核心逻辑 ────────────────────────────────

/**
 * 解析模型的完整能力向量
 * 优先: 用户手填 → 家族启发式 → 均值兜底
 * context 和 cost_eff 始终自动计算
 */
export function resolveCapability(
	modelName: string,
	entry: ModelEntry,
	allEntries: Record<string, ModelEntry>,
): ModelCapability {
	const userCap = entry.capability ?? {};
	const family = detectFamily(modelName);
	const heurCap = family ? (FAMILY_HEURISTICS[family] ?? {}) : {};

	// context: 始终从 contextWindow 计算
	const context = contextToScore(entry.contextWindow ?? 0);

	// cost_eff: 始终从 pricing 计算
	const allPricings = Object.values(allEntries)
		.map(e => e.pricing)
		.filter((p): p is { input: number; output: number } => !!p);
	const cost_eff = pricingToCostEff(entry.pricing, allPricings);

	// coding, reasoning, speed: 用户手填 > 启发式 > 默认
	return {
		coding: userCap.coding ?? heurCap.coding ?? DEFAULT_CAPABILITY.coding,
		reasoning: userCap.reasoning ?? heurCap.reasoning ?? DEFAULT_CAPABILITY.reasoning,
		speed: userCap.speed ?? heurCap.speed ?? DEFAULT_CAPABILITY.speed,
		context,
		cost_eff,
	};
}

/**
 * 计算亲和度 = 归一化加权点积
 * 权重先归一化到总和=1, 再做加权平均,
 * 这样每个维度按其相对重要性贡献, 不会被高权重低区分度维度淹没.
 */
export function calcAffinity(capability: ModelCapability, requirement: RoleRequirement): number {
	// 收集所有指定维度
	const dims: Array<{weight: number; value: number}> = [];
	if (requirement.coding !== undefined) dims.push({ weight: requirement.coding, value: capability.coding });
	if (requirement.reasoning !== undefined) dims.push({ weight: requirement.reasoning, value: capability.reasoning });
	if (requirement.speed !== undefined) dims.push({ weight: requirement.speed, value: capability.speed });
	if (requirement.context !== undefined) dims.push({ weight: requirement.context, value: capability.context });
	if (requirement.cost_eff !== undefined) dims.push({ weight: requirement.cost_eff, value: capability.cost_eff });
	if (dims.length === 0) return 0;
	// 归一化权重
	const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
	if (totalWeight <= 0) return 0;
	// 加权平均 (归一化后各维度按比例贡献)
	let sum = 0;
	for (const d of dims) {
		sum += (d.weight / totalWeight) * d.value;
	}
	return sum;
}

export interface AffinityResult {
	model: string;
	affinity: number;
	capability: ModelCapability;
}

/**
 * 为角色选最佳模型
 * 返回按亲和度降序排列的所有候选
 * tie-breaking: 亲和度差 < 0.03 时, 只在角色 cost_eff 权重 > 0.5 时用 cost_eff 破局
 * (reasoning-heavy 角色不应被成本覆盖)
 */
export function rankModels(
	requirement: RoleRequirement,
	models: Record<string, ModelEntry>,
): AffinityResult[] {
	const results: AffinityResult[] = [];
	for (const [name, entry] of Object.entries(models)) {
		if ((entry.type !== undefined && entry.type !== "chat") || entry.available === false || entry.virtual || entry.requiresHostRegistration) continue;
		if (entry.id && name !== `${entry.provider}/${entry.id}`) continue; // 不让 alias 获得第二份排名
		const capability = resolveCapability(name, entry, models);
		const affinity = calcAffinity(capability, requirement);
		results.push({ model: name, affinity, capability });
	}
	results.sort((a, b) => b.affinity - a.affinity);

	// tie-breaking: 只在角色关心成本时才用 cost_eff 破局
	const costWeight = requirement.cost_eff ?? 0;
	if (results.length >= 2 && Math.abs(results[0].affinity - results[1].affinity) < 0.03 && costWeight > 0.5) {
		if (results[1].capability.cost_eff > results[0].capability.cost_eff) {
			[results[0], results[1]] = [results[1], results[0]];
		}
	}
	return results;
}

/**
 * 为角色分配模型
 * 返回 { model, affinity, capability, source }
 * source: "model" (直接指定) | "affinity" (亲和度匹配) | "single" (只有一个模型)
 */
export interface AssignResult {
	model: string;
	affinity: number;
	capability: ModelCapability;
	source: "model" | "affinity" | "single";
	reason: string;
}

export function assignModel(
	roleName: string,
	role: { model?: string; requirement?: RoleRequirement },
	models: Record<string, ModelEntry>,
): AssignResult {
	// 1. 直接指定模型
	if (role.model) {
		if (models[role.model]) {
			const capability = resolveCapability(role.model, models[role.model], models);
			return {
				model: role.model,
				affinity: role.requirement ? calcAffinity(capability, role.requirement) : -1,
				capability,
				source: "model",
				reason: `Role ${roleName} explicitly selects model ${role.model}`,
			};
		}
		throw new Error(`Role ${roleName} explicitly requested missing or ambiguous chat model ${role.model}; select provider/model`);
	}

	// 2. 亲和度匹配
	if (role.requirement) {
		const modelNames = rankModels(role.requirement, models).map(item => item.model);
		if (modelNames.length === 0) {
			throw new Error(`Role ${roleName} has no available model (models.json is empty)`);
		}
		if (modelNames.length === 1) {
			const name = modelNames[0];
			const capability = resolveCapability(name, models[name], models);
			return {
				model: name,
				affinity: calcAffinity(capability, role.requirement),
				capability,
				source: "single",
				reason: `Role ${roleName} has only one available model: ${name}; using a homogeneous assignment`,
			};
		}
		const ranked = rankModels(role.requirement, models);
		const best = ranked[0];
		return {
			...best,
			source: "affinity",
			reason: `Role ${roleName} affinity ranking: ${ranked.map(r => `${r.model}=${r.affinity.toFixed(2)}`).join(", ")}`,
		};
	}

	throw new Error(`Role ${roleName} must specify a model or requirement`);
}

// ──────────────────────────────── 格式化 ────────────────────────────────

export function formatCapability(cap: ModelCapability): string {
	const dims = [
		`coding=${cap.coding.toFixed(2)}`,
		`reason=${cap.reasoning.toFixed(2)}`,
		`speed=${cap.speed.toFixed(2)}`,
		`ctx=${cap.context.toFixed(2)}`,
		`cost=${cap.cost_eff.toFixed(2)}`,
	];
	return `[${dims.join(" ")}]`;
}

export function formatAffinityTable(results: AffinityResult[]): string {
	const lines = ["Model Affinity Ranking:", ""];
	for (const r of results) {
		const marker = r === results[0] ? "*" : " ";
		lines.push(`  ${marker} ${r.model.padEnd(20)} affinity=${r.affinity.toFixed(3)}  ${formatCapability(r.capability)}`);
	}
	return lines.join("\n");
}
