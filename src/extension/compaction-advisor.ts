/**
 * AgentFlux Extension — 运行时 B 维度自适应 (F2-11)
 * 文档依据: docs/02-dimensions B维度, docs/06-cache-strategy, docs/10-pi-integration §4
 *
 * pi 的 compaction 会摧毁 L2 cache prefix (实验确认 93% read drop).
 * AgentFlux 在 session_before_compact 事件中拦截, 根据上下文状态选择策略:
 *   - 上下文占用低 → 放行 compaction (正常场景)
 *   - 上下文占用高 + 有 toolResult → 建议 mask (保 prefix)
 *   - 上下文占用高 + 长对话 → 建议 fork (保留分支)
 *   - 上下文占用极高 → 放行 compaction (别无选择)
 *
 * 注意: 当前阶段只做"建议+记录", 不自动拦截 compaction.
 * Phase 3 会接入自动决策.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TelemetryWriter } from "../telemetry/events";

export interface CompactionAdvice {
	action: "allow" | "suggest_mask" | "suggest_fork" | "suggest_handoff" | "force_compact";
	reason: string;
	contextPercent: number;
	toolResultCount: number;
	turnCount: number;
}

/**
 * 分析当前会话状态, 给出 compaction 建议.
 */
export function analyzeCompaction(ctx: any): CompactionAdvice {
	const usage = ctx.getContextUsage?.();
	const contextPercent = usage?.percent ? usage.percent / 100 : 0;  // 归一化到 0-1
	const branch = ctx.sessionManager?.getBranch?.() ?? [];

	// 统计 toolResult 消息数
	const toolResultCount = branch.filter((e: any) =>
		e.type === "message" && e.message?.role === "toolResult"
	).length;

	// 统计轮次 (user message 数)
	const turnCount = branch.filter((e: any) =>
		e.type === "message" && e.message?.role === "user"
	).length;

	// 决策逻辑
	if (contextPercent < 0.60) {
		return {
			action: "allow",
			reason: `上下文占用 ${contextPercent.toFixed(1)}%, 远低于 compaction 阈值, 正常放行`,
			contextPercent, toolResultCount, turnCount,
		};
	}

	if (contextPercent >= 0.85) {
		return {
			action: "force_compact",
			reason: `上下文占用 ${contextPercent.toFixed(1)}%, 极高, 必须 compact`,
			contextPercent, toolResultCount, turnCount,
		};
	}

	// 中间区间 (60%-85%): 根据内容特征建议
	if (toolResultCount > 10) {
		return {
			action: "suggest_mask",
			reason: `上下文 ${contextPercent.toFixed(1)}%, toolResult ${toolResultCount} 个, 建议 mask 旧 tool result 保 prefix`,
			contextPercent, toolResultCount, turnCount,
		};
	}

	if (turnCount > 15) {
		return {
			action: "suggest_fork",
			reason: `上下文 ${contextPercent.toFixed(1)}%, ${turnCount} 轮对话, 建议 fork 新分支保留探索`,
			contextPercent, toolResultCount, turnCount,
		};
	}

	return {
		action: "allow",
		reason: `上下文 ${contextPercent.toFixed(1)}%, 无明显优化点, 放行 compaction`,
		contextPercent, toolResultCount, turnCount,
	};
}

/**
 * 注册 session_before_compact 事件处理.
 */
export function registerCompactionAdvisor(pi: ExtensionAPI, getState: () => { sessionId: string; telemetry: TelemetryWriter | null }) {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		const { sessionId, telemetry } = getState();
		const advice = analyzeCompaction(ctx);

		// 记录 telemetry
		telemetry?.writeContextEvent({
			sessionId,
			turnIndex: -1,
			action: "compaction_advice",
			detail: `${advice.action}: ${advice.reason}`,
			contextPercentBefore: advice.contextPercent,
			contextPercentAfter: null,
		});

		console.error(`[flux] compaction advice: ${advice.action} — ${advice.reason}`);

		// 当前阶段: 只建议不拦截
		// Phase 3: 根据 advice.action 返回值拦截或修改 compaction 行为
		return undefined;
	});
}

/**
 * 格式化 compaction 建议为可读文本 (用于 /flux 命令)
 */
export function formatCompactionAdvice(advice: CompactionAdvice): string {
	const icons = {
		allow: "✓",
		suggest_mask: "◐",
		suggest_fork: "⎇",
		suggest_handoff: "⇄",
		force_compact: "!",
	};
	return [
		`Compaction 建议 (B 维度自适应):`,
		`  ${icons[advice.action]} action  ${advice.action}`,
		`    reason  ${advice.reason}`,
		`    ctx     ${(advice.contextPercent * 100).toFixed(1)}%`,
		`    tools   ${advice.toolResultCount} toolResult`,
		`    turns   ${advice.turnCount}`,
	].join("\n");
}
