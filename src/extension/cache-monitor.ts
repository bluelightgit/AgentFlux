/**
 * AgentFlux Extension — cache 监控
 * 文档依据: docs/06-cache-strategy, 10-pi-integration §3
 *
 * 从 sessionManager.getBranch() 累加 assistant usage (含 cacheRead/cacheWrite),
 * 从 ctx.getContextUsage() 取当前 context 占用。
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CacheStats } from "../core/types";

export function collectCacheStats(ctx: any): CacheStats {
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
				cost += u.cost?.total || 0;
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

export function pct(x: number | null): string {
	return x == null ? "?" : `${Math.round(x * 100)}%`;
}
