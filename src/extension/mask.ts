/**
 * AgentFlux Extension — mask 策略 (F1-3)
 * 文档依据: docs/06-cache-strategy (mask vs compact), 10-pi-integration §4
 *
 * 实证依据: docs/06 — JetBrains Research 实测 mask 比 compact 省 52% cost 且 +2.6% solve rate。
 *
 * 策略 (mask_strategy: hide_tool_results, mask_keep_last_n: 3):
 *   - 平时不动 (保留 prefix, cache 不失效)
 *   - 仅当 context% 接近 compaction_threshold 时触发, 推迟 compaction
 *   - 把最早的、超出 keep_last_n 的 tool result 内容替换为占位符 (保持消息结构/顺序)
 *   - 相比 compact (摘要替换, 前缀全失效): mask 只缩减内容, 不重排, prefix 骨架保留
 *
 * 注意: 替换早期 tool result 会改变前缀内容, 导致该处之后的 cache 失效。
 *       但这是"主动取舍": 用一次 cache miss 换取推迟 compaction (compaction 代价更大)。
 *       且只在高占用时触发, 低占用零成本。
 */

import type { ContextConfig } from "../core/types";

export interface MaskResult {
	applied: boolean;
	maskedCount: number;
	reason: string;
	contextPercentBefore: number | null;
}

/** 判断是否应触发 mask */
export function shouldMask(contextPercent: number | null, config: ContextConfig): boolean {
	if (config.mask_strategy !== "hide_tool_results") return false;
	if (contextPercent == null) return false;
	// 接近 compaction_threshold (留 10% buffer) 才触发, 避免频繁破坏 prefix
	return contextPercent >= (config.compaction_threshold - 0.10);
}

/**
 * 在 context 事件阶段 mask 旧 tool result。
 * 调用方式: const r = applyMask(event.messages, config, ctxPercent); 若 applied 返回新 messages。
 */
export function applyMask(
	messages: any[],
	config: ContextConfig,
	contextPercent: number | null,
): { messages: any[]; result: MaskResult } {
	const noop = (reason: string): { messages: any[]; result: MaskResult } => ({
		messages,
		result: { applied: false, maskedCount: 0, reason, contextPercentBefore: contextPercent },
	});

	if (!shouldMask(contextPercent, config)) {
		return noop(`context ${contextPercent == null ? "?" : Math.round(contextPercent * 100) + "%"} < mask trigger`);
	}

	const keepN = config.mask_keep_last_n;
	// pi 内部格式: tool result 是独立消息 (role="toolResult"), 不在 user content block 里
	const toolResultMsgIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m?.role === "toolResult" || m?.role === "tool") {
			toolResultMsgIndices.push(i);
		}
	}

	// 保留最近 keepN 个, mask 更早的
	const toMask = toolResultMsgIndices.slice(0, Math.max(0, toolResultMsgIndices.length - keepN));
	if (toMask.length === 0) {
		return noop(`tool_results ${toolResultMsgIndices.length} ≤ keep ${keepN}, nothing to mask`);
	}

	let maskedCount = 0;
	const newMessages = messages.map((m: any, i: number) => {
		if (!toMask.includes(i)) return m;
		maskedCount++;
		// toolResult 独立消息: 替换 content 为占位符 (保持消息存在, 不重排)
		const placeholder = "[masked by AgentFlux: old tool result]";
		if (Array.isArray(m.content)) {
			return { ...m, content: [{ type: "text", text: placeholder }] };
		}
		return { ...m, content: placeholder };
	});

	return {
		messages: newMessages,
		result: {
			applied: true,
			maskedCount,
			reason: `masked ${maskedCount} old tool_results (kept last ${keepN}) at ctx ${Math.round((contextPercent ?? 0) * 100)}%`,
			contextPercentBefore: contextPercent,
		},
	};
}
