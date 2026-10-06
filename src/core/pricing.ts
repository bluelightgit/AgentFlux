/**
 * AgentFlux Core — 价格层 (F1-14)
 * 文档依据: docs/16-pricing-layer
 *
 * 成本公式: cost = input×p_in + output×p_out + cacheRead×p_cacheRead + cacheWrite×p_cacheWrite
 *
 * 四层降级 (优先级从高到低):
 *   1. .agentflux/models.json  — 用户显式覆盖，按 token 重算
 *   2. Pi usage.cost.total    — 有限非负的原生请求级估计（保留 tier/1h/Fast 等语义）
 *   3. 远程价格源 (source_url)  — 仅在没有原生总额时作 simple quote
 *   4. 未知                  — 无可用报价时不捏造单价
 *   (source_url 可配置, 后续 GitHub Action 生成的 pricing-latest.json 替换, 不改代码)
 *
 * 用户价、Pi 原生估计、远程 simple quote 和未知是不同来源；模型元数据不是显式零价。
 * cacheWrite1h 是 cacheWrite 的子集，reasoning 已包含在 output；这些均不是供应商账单。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------- 类型 ----------

/** 单模型价格条目, 单位 $/token */
export interface PriceEntry {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number; // 未知则 0
	source: "user" | "remote" | "fallback" | "unknown";
}

/** 未知模型的价格 (全 0, source=unknown, 用于显示 "?" 而非估算) */
export const UNKNOWN_PRICE: PriceEntry = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "unknown",
};

/** 已加载的价格表 */
export interface PricingTable {
	/** key = 标准 id (vendor/model) */
	entries: Record<string, PriceEntry>;
	/** 未知模型兜底 (价格表内所有模型各单价均值) */
	avg: PriceEntry;
	fetchedAt: number;
	sourceUrl: string;
	/** 是否成功从远程拉取 (false = 仅用户文件 + 兜底) */
	remoteOk: boolean;
}

export interface PricingConfig {
	/** 主价格源 URL, 默认 OpenRouter; 后续可指向 GitHub Action 产物 */
	source_url: string;
	/** 第二价格源 URL (models.dev), 补充主源未覆盖的模型 */
	models_dev_url?: string;
	/** 本地缓存 TTL (小时) */
	cache_ttl_hours: number;
	/** 是否启用远程拉取 (false = 仅用本地 models.json + 兜底) */
	enable_remote_fetch: boolean;
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
	source_url: "https://openrouter.ai/api/v1/models",
	// models.dev 作为第二数据源 (补充 OpenRouter 未覆盖的模型)
	models_dev_url: "https://models.dev/api.json",
	cache_ttl_hours: 24,
	enable_remote_fetch: true,
};

// ---------- 归一化 (兼容多源格式) ----------

interface RawPriceRow {
	id: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** OpenRouter 格式: {data:[{id, pricing:{prompt,completion,input_cache_read,input_cache_write}}]} */
function normalizeOpenRouter(json: any): RawPriceRow[] {
	const data = json?.data ?? json;
	if (!Array.isArray(data)) return [];
	const rows: RawPriceRow[] = [];
	for (const m of data) {
		const id = m.id;
		const p = m.pricing ?? {};
		if (typeof id !== "string" || !id || !hasExplicitPrices(p)) continue;
		rows.push({
			id,
			input: num(p.prompt),
			output: num(p.completion),
			cacheRead: num(p.input_cache_read),
			cacheWrite: num(p.input_cache_write),
		});
	}
	return rows;
}

const PRICE_FIELDS = ["input", "prompt", "output", "completion", "cacheRead", "input_cache_read", "cacheWrite", "input_cache_write"] as const;
function hasExplicitPrices(value: any): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const values = PRICE_FIELDS.filter(key => value[key] !== undefined && value[key] !== null).map(key => value[key]);
	return values.length > 0 && values.every(value => (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
		&& Number.isFinite(Number(value)) && Number(value) >= 0);
}

/** 未来价格文件格式: {models:[{id,input,output,cacheRead,cacheWrite}]} 或 {[id]:{...}} */
function normalizePriceFile(json: any): RawPriceRow[] {
	const rows: RawPriceRow[] = [];
	if (Array.isArray(json?.models)) {
		for (const m of json.models) {
			if (!m || typeof m.id !== "string" || !m.id || !hasExplicitPrices(m)) continue;
			rows.push({
				id: m.provider ? `${m.provider}/${m.id}` : m.id,
				input: num(m.input ?? m.prompt),
				output: num(m.output ?? m.completion),
				cacheRead: num(m.cacheRead ?? m.input_cache_read),
				cacheWrite: num(m.cacheWrite ?? m.input_cache_write),
			});
		}
	} else if (json && typeof json === "object") {
		const priceMap = json.models && typeof json.models === "object"
			? json.models
			: json;
		for (const [id, p] of Object.entries(priceMap)) {
			const model = p as any;
			const pp = model?.pricing ?? model;
			if (hasExplicitPrices(pp)) {
				rows.push({
					id: model?.provider && !id.startsWith(`${model.provider}/`) ? `${model.provider}/${id}` : id,
					input: num(pp.input ?? pp.prompt),
					output: num(pp.output ?? pp.completion),
					cacheRead: num(pp.cacheRead ?? pp.input_cache_read),
					cacheWrite: num(pp.cacheWrite ?? pp.input_cache_write),
				});
			}
		}
	}
	return rows;
}

/** 自动识别格式并归一化 (OpenRouter 格式: $/token) */
function normalizeAny(json: any): RawPriceRow[] {
	if (json?.data && Array.isArray(json.data)) return normalizeOpenRouter(json);
	if (json?.models || (json && typeof json === "object" && !Array.isArray(json))) return normalizePriceFile(json);
	return [];
}

/**
 * models.dev API 格式归一化: {providerId: {models: {modelId: {cost: {input, output, cache_read, cache_write}}}}}
 * models.dev 的 cost 单位是 $/M token, 需要转为 $/token (除以 1e6)
 */
function normalizeModelsDev(json: any): RawPriceRow[] {
	const rows: RawPriceRow[] = [];
	for (const [provId, prov] of Object.entries(json)) {
		const p = prov as any;
		if (!p?.models || typeof p.models !== "object") continue;
		for (const [modelId, m] of Object.entries(p.models)) {
			const mm = m as any;
			if (!mm?.cost) continue;
			const c = mm.cost;
			if (!hasExplicitPrices(c)) continue;
			// models.dev cost 单位是 $/M token → 转为 $/token
			rows.push({
				id: modelId,
				input: num(c.input) / 1e6,
				output: num(c.output) / 1e6,
				cacheRead: num(c.cache_read) / 1e6,
				cacheWrite: num(c.cache_write) / 1e6,
			});
		}
	}
	return rows;
}

function num(v: any): number {
	const n = typeof v === "string" ? parseFloat(v) : (typeof v === "number" ? v : NaN);
	return isFinite(n) ? n : 0;
}

// ---------- 模型名映射 ----------

/**
 * relay 名 → 候选标准 id 列表 (精确匹配优先)
 * 策略: 去掉任意单段前缀 (网关前缀), 生成多级候选
 * 例: oa/glm-5.2 → ["oa/glm-5.2", "glm-5.2"]
 *      z-ai/glm-5.2 → ["z-ai/glm-5.2", "glm-5.2"]
 *      vendor/model-fast → ["vendor/model-fast", "model-fast"]
 */
export function generateCandidates(relayName: string): string[] {
	if (!relayName) return [];
	const cands: string[] = [relayName]; // 原始名优先

	// 去掉第一段前缀 (任意 xxx/ 前缀, 不仅限于 oa/flux/relay 等)
	if (relayName.includes("/")) {
		const parts = relayName.split("/");
		const lastPart = parts[parts.length - 1];
		if (lastPart) cands.push(lastPart);
		// 如果有两段以上, 也保留去掉第一段的版本
		if (parts.length >= 3) {
			cands.push(parts.slice(1).join("/"));
		}
	}

	// 去掉常见二次分发前缀 (保留向后兼容)
	const stripped = relayName.replace(/^(oa|flux|relay|gateway|proxy)\//i, "");
	if (stripped !== relayName && !cands.includes(stripped)) {
		cands.push(stripped);
		if (stripped.includes("/")) {
			cands.push(stripped.split("/").pop()!);
		}
	}

	return cands;
}

/**
 * 从价格表查找模型价格
 * 三层匹配: 精确 → model-part 精确 → model-part 前缀
 * 不再使用 includes (避免 glm-5 匹配 glm-5.2)
 * 未找到返回 UNKNOWN_PRICE (不估算)
 */
export function lookupPrice(table: PricingTable, relayName: string): PriceEntry {
	const candidates = generateCandidates(relayName);

	// 1. 精确匹配 (原始名 + 去前缀名)
	for (const c of candidates) {
		if (table.entries[c]) return table.entries[c];
	}

	// 2. model-part 精确匹配 (只比较最后一段)
	for (const c of candidates) {
		const cl = c.toLowerCase();
		for (const [key, entry] of Object.entries(table.entries)) {
			const modelPart = (key.split("/").pop() || key).toLowerCase();
			if (modelPart === cl) return entry;
		}
	}

	// 3. model-part 前缀匹配 (更严格: 只允许候选以 entry 开头, 不允许反过来)
	// 例: glm-5.2-coding → 匹配 glm-5.2 (候选是 entry 的超集)
	for (const c of candidates) {
		const cl = c.toLowerCase();
		let bestMatch: { key: string; entry: PriceEntry; len: number } | null = null;
		for (const [key, entry] of Object.entries(table.entries)) {
			const modelPart = (key.split("/").pop() || key).toLowerCase();
			if (cl.startsWith(modelPart) && modelPart.length > 3) {
				// 选最长匹配 (最精确)
				if (!bestMatch || modelPart.length > bestMatch.len) {
					bestMatch = { key, entry, len: modelPart.length };
				}
			}
		}
		if (bestMatch) return bestMatch.entry;
	}

	// 4. 未找到 → 返回 unknown (不估算)
	return UNKNOWN_PRICE;
}

// ---------- 均值兜底 ----------

function computeAvg(rows: RawPriceRow[]): PriceEntry {
	if (!rows.length) {
		return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "fallback" };
	}
	// 保守策略: 用最便宜已知模型价格作为未知模型的估值
	// (未知模型更可能是经济型而非高端型, 用均值会被高端模型拉高)
	const min = (arr: number[]) => arr.length ? Math.min(...arr) : 0;
	const inputs = rows.map(r => r.input).filter(v => v > 0);
	const outputs = rows.map(r => r.output).filter(v => v > 0);
	const reads = rows.map(r => r.cacheRead).filter(v => v > 0);
	const writes = rows.map(r => r.cacheWrite).filter(v => v > 0);
	return {
		input: min(inputs),
		output: min(outputs),
		cacheRead: min(reads),
		cacheWrite: min(writes),
		source: "fallback",
	};
}

// ---------- 加载 ----------

function readJsonSafe(path: string): any | null {
	if (!existsSync(path)) return null;
	try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

/** 加载用户手填价格 (.agentflux/models.json), 最高优先级 */
function loadUserPrices(dir: string): Record<string, PriceEntry> {
	const raw = readJsonSafe(join(dir, "models.json"));
	if (!raw) return {};
	const out: Record<string, PriceEntry> = {};
	// 支持 {models:[...]} 或 {[id]:{...}}
	const rows = normalizePriceFile(raw);
	for (const r of rows) {
		out[r.id] = {
			input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite,
			source: "user",
		};
	}
	return out;
}

/** 远程拉取 (带超时), 返回归一化后的 rows 或 null */
async function fetchRemote(sourceUrl: string, timeoutMs = 15000): Promise<RawPriceRow[] | null> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const resp = await fetch(sourceUrl, { signal: ctrl.signal });
		clearTimeout(timer);
		if (!resp.ok) return null;
		const json = await resp.json();
		return normalizeAny(json);
	} catch {
		return null;
	}
}

/** 拉取 models.dev API (带超时), 返回归一化后的 rows 或 null */
async function fetchModelsDev(url: string, timeoutMs = 15000): Promise<RawPriceRow[] | null> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const resp = await fetch(url, { signal: ctrl.signal });
		clearTimeout(timer);
		if (!resp.ok) return null;
		const json = await resp.json();
		return normalizeModelsDev(json);
	} catch {
		return null;
	}
}

/**
 * 加载完整价格表.
 * @param dir  .agentflux 目录
 * @param cfg  pricing 配置
 * @param model 当前 relay 模型名 (用于诊断日志)
 */
export async function loadPricing(dir: string, cfg: PricingConfig, model?: string): Promise<PricingTable> {
	// 1. 用户手填 (最高优先级)
	const userEntries = loadUserPrices(dir);

	// 2. 远程缓存 / 拉取 (OpenRouter + models.dev 双源)
	const cachePath = join(dir, "pricing-cache.json");
	let remoteRows: RawPriceRow[] | null = null;
	let fetchedAt = 0;
	let remoteOk = false;

	const cached = readJsonSafe(cachePath);
	const now = Date.now();
	const ttlMs = cfg.cache_ttl_hours * 3600 * 1000;

	if (cached && cached.fetchedAt && (now - cached.fetchedAt < ttlMs)) {
		// 缓存有效
		remoteRows = normalizeAny(cached.payload ?? cached);
		fetchedAt = cached.fetchedAt;
		remoteOk = remoteRows != null && remoteRows.length > 0;
	} else if (cfg.enable_remote_fetch) {
		// 拉取主源 (OpenRouter)
		const primaryRows = await fetchRemote(cfg.source_url);
		// 拉取第二源 (models.dev, 补充覆盖)
		const modelsDevUrl = cfg.models_dev_url ?? DEFAULT_PRICING_CONFIG.models_dev_url!;
		const devRows = await fetchModelsDev(modelsDevUrl);
		if (primaryRows && primaryRows.length) {
			// 合并: OpenRouter 为主, models.dev 补充不存在的 key
			const seen = new Set(primaryRows.map(r => r.id));
			const extra = (devRows ?? []).filter(r => !seen.has(r.id));
			remoteRows = [...primaryRows, ...extra];
			fetchedAt = now;
			remoteOk = true;
		} else if (devRows && devRows.length) {
			remoteRows = devRows;
			fetchedAt = now;
			remoteOk = true;
		}
		// 写缓存
		if (remoteRows && remoteRows.length) {
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(cachePath, JSON.stringify({ fetchedAt, sourceUrl: cfg.source_url, payload: { data: rowsToOpenRouterShape(remoteRows) } }, null, 2), "utf-8");
			} catch { /* */ }
		} else if (cached) {
			// 拉取失败, 降级用旧缓存
			remoteRows = normalizeAny(cached.payload ?? cached);
			fetchedAt = cached.fetchedAt ?? 0;
			remoteOk = false;
		}
	}

	// 3. 合并: 用户 > 远程
	const entries: Record<string, PriceEntry> = {};
	if (remoteRows) {
		for (const r of remoteRows) {
			entries[r.id] = {
				input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite,
				source: "remote",
			};
		}
	}
	// 用户覆盖
	for (const [k, v] of Object.entries(userEntries)) {
		entries[k] = v;
	}

	// 4. 兜底: 不再估算未知模型价格, 用 UNKNOWN_PRICE
	const avg = UNKNOWN_PRICE;

	if (model) {
		const found = lookupPrice({ entries, avg, fetchedAt, sourceUrl: cfg.source_url, remoteOk }, model);
		if (found.source === "unknown") {
			console.error(`[flux pricing] model=${model} -> WARNING: UNKNOWN quote; use available Pi usage estimates, not a billing guarantee. Add explicit prices to models.json.`);
		} else {
			console.error(`[flux pricing] model=${model} → source=${found.source} in=${found.input} out=${found.output} cacheRead=${found.cacheRead} | remote=${remoteOk} (${Object.keys(entries).length} entries)`);
		}
	}

	return { entries, avg, fetchedAt, sourceUrl: cfg.source_url, remoteOk };
}

/** 写缓存时转成 {data:[...]} 形状便于复用 normalizeAny */
function rowsToOpenRouterShape(rows: RawPriceRow[]): any[] {
	return rows.map(r => ({
		id: r.id,
		pricing: {
			prompt: String(r.input),
			completion: String(r.output),
			input_cache_read: String(r.cacheRead),
			input_cache_write: String(r.cacheWrite),
		},
	}));
}

// ---------- 成本计算 ----------

export interface UsageCostLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Subset of cacheWrite retained for one hour; never add it separately. */
	cacheWrite1h?: number;
	/** Subset of output; never add it separately. */
	reasoning?: number;
	cost?: UsageCostLike;
}

/** The source used for a Core estimate. `native` is Pi's finite cost.total. */
export type UsageCostSource = "user" | "native" | "remote" | "fallback" | "unknown";

export interface UsageCostResolution {
	cost: number;
	source: UsageCostSource;
	/** True means the amount came from an explicit/native/simple quote. */
	known: boolean;
}

export interface UsageCostResolutionOptions {
	/** 物理 provider 身份；不能把其他 provider 的同名用户价格套过来。 */
	provider?: string;
	/** Override the native total when the caller has a request-level aggregate. */
	nativeCost?: unknown;
	/** Set false only when the caller intentionally wants to ignore native total. */
	preferNative?: boolean;
	/** Aggregated/heterogeneous usage must set this false when no native total exists. */
	allowRemoteQuote?: boolean;
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageNumber(value: unknown): number {
	return finiteNonNegative(value) ?? 0;
}

/** 单条 usage × 单价 → 美元成本。reasoning/cacheWrite1h 均不另加总量。 */
export function calcCost(usage: UsageLike, price: PriceEntry): number {
	if (price.source === "unknown") return 0; // 未知模型不估算
	return usageNumber(usage.input) * price.input
		+ usageNumber(usage.output) * price.output
		+ usageNumber(usage.cacheRead) * price.cacheRead
		+ usageNumber(usage.cacheWrite) * price.cacheWrite;
}

/**
 * Resolve a single usage amount without losing the provenance of the estimate.
 * The order is deliberately user override → native finite total → remote simple
 * quote → unknown. A native total is authoritative for request-wide tiers,
 * cache retention, Fast/fallback routing, and aggregated tool usage.
 */
export function resolveUsageCostDetailed(
	usage: UsageLike,
	model?: string,
	table?: PricingTable,
	options: UsageCostResolutionOptions = {},
): UsageCostResolution {
	const qualified = model && options.provider ? `${options.provider}/${model}` : model;
	let price = table && qualified ? lookupPrice(table, qualified) : UNKNOWN_PRICE;
	if (table && model && options.provider && price.source === "user") {
		const exact = table.entries[qualified!]?.source === "user" ? table.entries[qualified!]
			: table.entries[model]?.source === "user" ? table.entries[model] : undefined;
		price = exact ?? UNKNOWN_PRICE;
	}

	// An explicit user quote is the only source allowed to replace native cost.
	if (price.source === "user") {
		return { cost: calcCost(usage, price), source: "user", known: true };
	}

	const native = options.nativeCost ?? usage.cost?.total;
	if (options.preferNative !== false) {
		const reported = finiteNonNegative(native);
		if (reported !== undefined) return { cost: reported, source: "native", known: true };
	}

	if (options.allowRemoteQuote !== false && (price.source === "remote" || price.source === "fallback")) {
		return { cost: calcCost(usage, price), source: price.source, known: true };
	}

	return { cost: 0, source: "unknown", known: false };
}

/** Main 与子 Run 共用同一费用来源规则；显式零价仍保留最高优先级。 */
export function resolveUsageCost(
	usage: UsageLike,
	model?: string,
	table?: PricingTable,
	options?: UsageCostResolutionOptions,
): number {
	return resolveUsageCostDetailed(usage, model, table, options).cost;
}

/** 多条 usage 累加成本，沿用 user → native → remote → unknown 优先级。 */
export function calcCostCumulative(usages: UsageLike[], table: PricingTable, relayName: string): number {
	return usages.reduce((sum, usage) => sum + resolveUsageCost(usage, relayName, table), 0);
}
