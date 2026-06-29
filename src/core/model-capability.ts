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
	contextWindow: number;
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
 * 从 contextWindow 计算 context 维度分数 (log scale)
 * 4K → 0.36, 32K → 0.56, 128K → 0.70, 200K → 0.73, 1M → 0.84
 */
export function contextToScore(contextWindow: number): number {
	if (contextWindow <= 0) return 0;
	// log2(contextWindow) / log2(1_000_000), clamp 0-1
	const score = Math.log2(contextWindow) / Math.log2(1_000_000);
	return Math.max(0, Math.min(1, score));
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
	const context = contextToScore(entry.contextWindow);

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
 * 计算亲和度 = 加权点积
 * 只累加 requirement 中明确指定的维度
 */
export function calcAffinity(capability: ModelCapability, requirement: RoleRequirement): number {
	let sum = 0;
	if (requirement.coding !== undefined) sum += requirement.coding * capability.coding;
	if (requirement.reasoning !== undefined) sum += requirement.reasoning * capability.reasoning;
	if (requirement.speed !== undefined) sum += requirement.speed * capability.speed;
	if (requirement.context !== undefined) sum += requirement.context * capability.context;
	if (requirement.cost_eff !== undefined) sum += requirement.cost_eff * capability.cost_eff;
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
 */
export function rankModels(
	requirement: RoleRequirement,
	models: Record<string, ModelEntry>,
): AffinityResult[] {
	const results: AffinityResult[] = [];
	for (const [name, entry] of Object.entries(models)) {
		const capability = resolveCapability(name, entry, models);
		const affinity = calcAffinity(capability, requirement);
		results.push({ model: name, affinity, capability });
	}
	results.sort((a, b) => b.affinity - a.affinity);

	// 亲和度差值 < 0.05 时用 cost_eff 破平局
	if (results.length >= 2 && Math.abs(results[0].affinity - results[1].affinity) < 0.05) {
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
				reason: `角色 ${roleName} 直接指定模型 ${role.model}`,
			};
		}
		// model 不存在, 尝试 fallback 到 requirement
		if (role.requirement) {
			const ranked = rankModels(role.requirement, models);
			if (ranked.length > 0) {
				const best = ranked[0];
				return {
					...best,
					source: "affinity",
					reason: `角色 ${roleName} 指定模型 ${role.model} 不可用, fallback 到亲和度匹配 → ${best.model}`,
				};
			}
		}
		throw new Error(`角色 ${roleName} 指定模型 ${role.model} 不存在且无 requirement fallback`);
	}

	// 2. 亲和度匹配
	if (role.requirement) {
		const modelNames = Object.keys(models);
		if (modelNames.length === 0) {
			throw new Error(`角色 ${roleName} 无可用模型 (models.json 为空)`);
		}
		if (modelNames.length === 1) {
			const name = modelNames[0];
			const capability = resolveCapability(name, models[name], models);
			return {
				model: name,
				affinity: calcAffinity(capability, role.requirement),
				capability,
				source: "single",
				reason: `角色 ${roleName} 只有一个可用模型 ${name}, 退化为同构`,
			};
		}
		const ranked = rankModels(role.requirement, models);
		const best = ranked[0];
		return {
			...best,
			source: "affinity",
			reason: `角色 ${roleName} 亲和度匹配: ${ranked.map(r => `${r.model}=${r.affinity.toFixed(2)}`).join(", ")}`,
		};
	}

	throw new Error(`角色 ${roleName} 必须指定 model 或 requirement`);
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
		const marker = r === results[0] ? "★" : " ";
		lines.push(`  ${marker} ${r.model.padEnd(20)} affinity=${r.affinity.toFixed(3)}  ${formatCapability(r.capability)}`);
	}
	return lines.join("\n");
}
