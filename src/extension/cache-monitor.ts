/**
 * AgentFlux Extension — cache 监控
 * 文档依据: docs/06-cache-strategy, 10-pi-integration §3
 *
 * 从 sessionManager.getBranch() 累加 assistant usage (含 cacheRead/cacheWrite),
 * 从 ctx.getContextUsage() 取当前 context 占用。
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CacheStats } from "../core/types";
import type { PricingTable } from "../core/pricing";
import { calcCost, lookupPrice } from "../core/pricing";

export function collectCacheStats(ctx: any, pricing?: PricingTable): CacheStats {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
	try {
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message?.role === "assistant") {
				const m = e.message as AssistantMessage;
				const u: any = m.usage ?? {};
				input += u.input || 0;
				output += u.output || 0;
				cacheRead += u.cacheRead || 0;
				cacheWrite += u.cacheWrite || 0;
				// F1-14: 优先本地算成本 (token×单价), 上游 cost.total 兜底
				if (pricing && m.model) {
					cost += calcCost(u, lookupPrice(pricing, m.model));
				} else {
					cost += u.cost?.total || 0;
				}
			}
		}
	} catch { /* session not ready */ }

	let contextTokens = 0, contextWindow = 0;
	let contextPercent: number | null = null;
	try {
		const cu = ctx.getContextUsage?.();
		if (cu) {
			contextTokens = cu.tokens || 0;
			contextWindow = (cu as any).contextWindow || 0;
			contextPercent = (cu as any).percent ?? null;
		}
	} catch { /* */ }

	const cacheHitRate = cacheRead / (cacheRead + input + 1e-9);

	return {
		input, output, cacheRead, cacheWrite, costUsd: cost,
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
