/**
 * AgentFlux Core — 价格层 (F1-14)
 * 文档依据: docs/16-pricing-layer
 *
 * 成本公式: cost = input×p_in + output×p_out + cacheRead×p_cacheRead + cacheWrite×p_cacheWrite
 *
 * 四层降级 (优先级从高到低):
 *   1. .agentflux/models.json  — 用户手填 relay 真实价 (覆盖一切)
 *   2. 远程价格源 (source_url)  — 默认 OpenRouter, 缓存 .agentflux/pricing-cache.json (TTL)
 *   3. 兜底均值               — 未知模型用价格表内所有模型各单价均值
 *   (4. source_url 可配置, 后续 GitHub Action 生成的 pricing-latest.json 替换, 不改代码)
 *
 * token 本地算: pi 的 usage.input/output/cacheRead/cacheWrite 是 token 计数,
 *              本地 × 单价即得成本, 不依赖上游 cost.total (relay 可能返回 0).
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
	source: "user" | "remote" | "fallback";
}

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
	/** 价格源 URL, 默认 OpenRouter; 后续可指向 GitHub Action 产物 */
	source_url: string;
	/** 本地缓存 TTL (小时) */
	cache_ttl_hours: number;
	/** 是否启用远程拉取 (false = 仅用本地 models.json + 兜底) */
	enable_remote_fetch: boolean;
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
	source_url: "https://openrouter.ai/api/v1/models",
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
		if (!id || !p) continue;
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

/** 未来价格文件格式: {models:[{id,input,output,cacheRead,cacheWrite}]} 或 {[id]:{...}} */
function normalizePriceFile(json: any): RawPriceRow[] {
	const rows: RawPriceRow[] = [];
	if (Array.isArray(json?.models)) {
		for (const m of json.models) {
			rows.push({
				id: m.id,
				input: num(m.input ?? m.prompt),
				output: num(m.output ?? m.completion),
				cacheRead: num(m.cacheRead ?? m.input_cache_read),
				cacheWrite: num(m.cacheWrite ?? m.input_cache_write),
			});
		}
	} else if (json && typeof json === "object") {
		for (const [id, p] of Object.entries(json)) {
			const pp = p as any;
			if (pp && typeof pp === "object") {
				rows.push({
					id,
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

/** 自动识别格式并归一化 */
function normalizeAny(json: any): RawPriceRow[] {
	if (json?.data && Array.isArray(json.data)) return normalizeOpenRouter(json);
	if (json?.models || (json && typeof json === "object" && !Array.isArray(json))) return normalizePriceFile(json);
	return [];
}

function num(v: any): number {
	const n = typeof v === "string" ? parseFloat(v) : (typeof v === "number" ? v : NaN);
	return isFinite(n) ? n : 0;
}

// ---------- 模型名映射 ----------

/** relay 名 → 候选标准 id 列表 (精确匹配优先) */
export function generateCandidates(relayName: string): string[] {
	if (!relayName) return [];
	// 去常见二次分发前缀 (oa/, flux/, relay/ 等)
	let name = relayName.replace(/^(oa|flux|relay|gateway|proxy)\//i, "");
	const cands: string[] = [];
	if (name.includes("/")) {
		cands.push(name);                        // vendor/model 完整
		cands.push(name.split("/").pop()!);      // model 部分
	} else {
		cands.push(name);                        // 仅 model 名
	}
	return cands;
}

/** 从价格表查找模型价格 (精确 → 模糊 → 兜底均值) */
export function lookupPrice(table: PricingTable, relayName: string): PriceEntry {
	const candidates = generateCandidates(relayName);
	// 1. 精确匹配
	for (const c of candidates) {
		if (table.entries[c]) return table.entries[c];
	}
	// 2. 模糊匹配 (key 的 model 部分匹配候选)
	for (const c of candidates) {
		const cl = c.toLowerCase();
		for (const [key, entry] of Object.entries(table.entries)) {
			const modelPart = (key.split("/").pop() || key).toLowerCase();
			if (modelPart === cl || modelPart.includes(cl) || cl.includes(modelPart)) {
				return entry;
			}
		}
	}
	// 3. 兜底均值
	return table.avg;
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

/**
 * 加载完整价格表.
 * @param dir  .agentflux 目录
 * @param cfg  pricing 配置
 * @param model 当前 relay 模型名 (用于诊断日志)
 */
export async function loadPricing(dir: string, cfg: PricingConfig, model?: string): Promise<PricingTable> {
	// 1. 用户手填 (最高优先级)
	const userEntries = loadUserPrices(dir);

	// 2. 远程缓存 / 拉取
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
		// 拉取远程
		const rows = await fetchRemote(cfg.source_url);
		if (rows && rows.length) {
			remoteRows = rows;
			fetchedAt = now;
			remoteOk = true;
			// 写缓存
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(cachePath, JSON.stringify({ fetchedAt, sourceUrl: cfg.source_url, payload: { data: rowsToOpenRouterShape(rows) } }, null, 2), "utf-8");
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

	// 4. 兜底均值 (基于所有已知模型)
	const allRows: RawPriceRow[] = Object.entries(entries).map(([id, e]) => ({
		id, input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite,
	}));
	const avg = computeAvg(allRows.length ? allRows : (remoteRows ?? []));

	if (model) {
		const found = lookupPrice({ entries, avg, fetchedAt, sourceUrl: cfg.source_url, remoteOk }, model);
		console.error(`[flux pricing] model=${model} → source=${found.source} in=${found.input} out=${found.output} cacheRead=${found.cacheRead} | remote=${remoteOk} (${Object.keys(entries).length} entries)`);
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

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** 单条 usage × 单价 → 美元成本 */
export function calcCost(usage: UsageLike, price: PriceEntry): number {
	return (usage.input || 0) * price.input
		+ (usage.output || 0) * price.output
		+ (usage.cacheRead || 0) * price.cacheRead
		+ (usage.cacheWrite || 0) * price.cacheWrite;
}

/** 多条 usage 累加成本 (按模型查价) */
export function calcCostCumulative(usages: UsageLike[], table: PricingTable, relayName: string): number {
	const price = lookupPrice(table, relayName);
	return usages.reduce((sum, u) => sum + calcCost(u, price), 0);
}
