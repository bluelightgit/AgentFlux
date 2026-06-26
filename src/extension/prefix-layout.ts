/**
 * AgentFlux Extension — 前缀布局强制器 (F1-2)
 * 文档依据: docs/06-cache-strategy (前缀布局原则), 10-pi-integration §4
 *
 * 实证依据: docs/20-empirical-findings.md (实验二/四)
 *   - pi 默认只给 system + 最后 user 打 cache_control, 历史不打 → L2 靠隐式缓存
 *   - 主动给"最后一条历史消息"打 cache_control, 可控制缓存断点
 *
 * 策略 (prefix_layout: static_first):
 *   给倒数第二条消息的最后一个 content block 打 cache_control: {type:"ephemeral"}
 *   使 anthropic 缓存 [system + 全部历史] 前缀, 下一轮命中 L2
 *
 * 配置 (docs/04 Level 3):
 *   cache.prefix_layout: "static_first" (启用) | "none" (禁用)
 */

import type { CacheConfig } from "../core/types";

export interface PrefixLayoutResult {
	applied: boolean;
	targetMsgIndex: number;
	reason: string;
}

/**
 * 在 before_provider_request 阶段注入 cache_control。
 * 调用方式: const result = applyPrefixLayout(payload, config); 若 applied 返回修改后的 payload。
 */
export function applyPrefixLayout(
	payload: any,
	config: CacheConfig,
): { payload: any; result: PrefixLayoutResult } {
	const noop: { payload: any; result: PrefixLayoutResult } = {
		payload,
		result: { applied: false, targetMsgIndex: -1, reason: "prefix_layout disabled" },
	};

	if (config.prefix_layout !== "static_first") return noop;

	const msgs = payload?.messages;
	if (!Array.isArray(msgs) || msgs.length < 2) {
		return { payload, result: { applied: false, targetMsgIndex: -1, reason: "messages < 2, no history to cache" } };
	}

	// 给倒数第二条消息 (最后一条历史) 的最后一个 content block 打 cache_control
	const histIdx = msgs.length - 2;
	const hist = msgs[histIdx];
	if (!hist || !Array.isArray(hist.content) || hist.content.length === 0) {
		return { payload, result: { applied: false, targetMsgIndex: histIdx, reason: "history msg has no content blocks" } };
	}

	// 深拷贝避免污染原 payload (before_provider_request 可能共享引用)
	const newPayload = { ...payload, messages: msgs.map((m: any, i: number) => {
		if (i !== histIdx) return m;
		const newContent = m.content.map((b: any) => ({ ...b }));
		// 移除该消息上既有的 cache_control (避免重复断点), 只在最后 block 打
		for (const b of newContent) if (b.cache_control) delete b.cache_control;
		const lastBlock = newContent[newContent.length - 1];
		if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
		return { ...m, content: newContent };
	})};

	return {
		payload: newPayload,
		result: { applied: true, targetMsgIndex: histIdx, reason: `cache_control → msg[${histIdx}] (role=${hist.role})` },
	};
}
