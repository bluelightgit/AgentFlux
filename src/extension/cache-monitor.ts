/**
 * AgentFlux Extension — cache 监控
 * 文档依据: docs/06-cache-strategy, 10-pi-integration §3
 *
 * 通过 Core usage adapter 累加原始 session 费用（包括未投影到 context 的费用），
 * 从 ctx.getContextUsage() 取当前 context 占用。
 */

import type { CacheStats } from "../core/types";
import type { PricingTable } from "../core/pricing";
import { UsageAccounting } from "../core/usage-accounting";

export function collectCacheStats(ctx: any, pricing?: PricingTable): CacheStats {
	const accounting = new UsageAccounting({ pricing });
	let readable = true;
	try { accounting.ingestEntries(ctx.sessionManager.getEntries()); } catch { readable = false; }
	const { input, output, cacheRead, cacheWrite, cost, complete } = accounting.snapshot();

	let contextTokens = 0, contextWindow: number | undefined;
	let contextPercent: number | null = null;
	try {
		const cu = ctx.getContextUsage?.();
		if (cu) {
			contextTokens = cu.tokens || 0;
			contextWindow = typeof cu.contextWindow === "number" && cu.contextWindow > 0 ? cu.contextWindow : undefined;
			contextPercent = (cu as any).percent != null ? (cu as any).percent / 100 : null; // pi returns 0-100, normalize to 0-1
		}
	} catch { /* */ }

	const cacheHitRate = cacheRead / (cacheRead + input + 1e-9);

	return {
		input, output, cacheRead, cacheWrite, costUsd: cost, costComplete: readable && complete,
		contextTokens, contextWindow, contextPercent, cacheHitRate,
	};
}

export function fmt(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

/** 自适应成本显示: 极低用科学计数, 低用 6 位, 高用 4 位 */
export function fmtCost(c: number): string {
	if (c === 0) return "$0";
	if (c < 0.001) return `$${c.toExponential(2)}`;
	if (c < 0.01) return `$${c.toFixed(6)}`;
	return `$${c.toFixed(4)}`;
}

export function pct(x: number | null): string {
	return x == null ? "?" : `${Math.round(x * 100)}%`;
}
