/**
 * AgentFlux Extension — 运行时 B 维度自适应 (F2-11)
 * 文档依据: docs/02-dimensions B维度, docs/06-cache-strategy, docs/10-pi-integration §4
 *
 * pi 的 compaction 会摧毁 L2 cache prefix (实验确认 93% read drop).
 * AgentFlux 在 session_before_compact 事件中拦截, 根据上下文状态选择策略:
 *   - 上下文占用低 → 放行 compaction (正常场景)
 *   - 上下文占用高 + 长对话 → 建议 fork (保留分支)
 *   - 上下文占用极高 → 放行 compaction (别无选择)
 *
 * 注: B2 mask 策略已移除 (docs/06 实证: 高 cacheRead 折扣模型下 prefix 破坏代价超过节省)。
 * 当前阶段只做“建议+记录”, 不自动拦截 compaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TelemetryWriter } from "../telemetry/events";

export interface CompactionAdvice {
	action: "allow" | "suggest_fork" | "suggest_handoff" | "force_compact";
	reason: string;
	contextPercent: number;
	toolResultCount: number;
	turnCount: number;
}

export interface NativeCompactionObservation {
	event: "session_before_compact" | "session_compact" | "session_compact_failed";
	reason?: "manual" | "threshold" | "overflow";
	willRetry?: boolean;
	errorMessage?: string;
	aborted?: boolean;
	fromExtension?: boolean;
}

function recordNativeCompaction(
	telemetry: TelemetryWriter | null,
	sessionId: string,
	observation: NativeCompactionObservation,
	contextPercent: number | null,
): void {
	telemetry?.writeContextEvent({
		sessionId,
		turnIndex: -1,
		action: "compaction_advice",
		detail: `native ${JSON.stringify(observation)}`,
		contextPercentBefore: contextPercent,
		contextPercentAfter: null,
	});
}

/**
 * 分析当前会话状态, 给出 compaction 建议.
 */
export function analyzeCompaction(ctx: any): CompactionAdvice {
	const usage = ctx.getContextUsage?.();
	const rawPercent = typeof usage?.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : 0;
	const contextPercent = Math.max(0, Math.min(1, rawPercent / 100));  // 归一化到 0-1
	const displayPercent = (contextPercent * 100).toFixed(1);
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
			reason: `Context usage ${displayPercent}%, well below the compaction threshold; allowing compaction`,
			contextPercent, toolResultCount, turnCount,
		};
	}

	if (contextPercent >= 0.85) {
		return {
			action: "force_compact",
			reason: `Context usage ${displayPercent}%, critically high; compaction is required`,
			contextPercent, toolResultCount, turnCount,
		};
	}

	// 中间区间 (60%-85%): 长对话建议 fork 保留探索
	if (turnCount > 15) {
		return {
			action: "suggest_fork",
			reason: `Context usage ${displayPercent}%, ${turnCount} turns; consider forking a new branch to preserve exploration`,
			contextPercent, toolResultCount, turnCount,
		};
	}

	return {
		action: "allow",
		reason: `Context usage ${displayPercent}%, no clear optimization; allowing compaction`,
		contextPercent, toolResultCount, turnCount,
	};
}

/**
 * Observe Pi's native compaction lifecycle without replacing it.
 * `session_before_compact` is deliberately read-only: no custom summary,
 * cancel, retry, or second compactor is introduced here.
 */
export function registerCompactionAdvisor(pi: ExtensionAPI, getState: () => { sessionId: string; telemetry: TelemetryWriter | null }) {
	const api = pi as any;
	api.on("session_before_compact", async (event: any, ctx: any) => {
		const { sessionId, telemetry } = getState();
		const advice = analyzeCompaction(ctx);
		recordNativeCompaction(telemetry, sessionId, {
			event: "session_before_compact",
			reason: event?.reason,
			willRetry: event?.willRetry === true,
		}, advice.contextPercent);
		return undefined;
	});

	// Success is also native fact; record the same reason/willRetry pair while
	// leaving the compaction entry and usage untouched.
	api.on("session_compact", async (event: any, ctx: any) => {
		const { sessionId, telemetry } = getState();
		const usage = ctx?.getContextUsage?.();
		const percent = typeof usage?.percent === "number" ? Math.max(0, Math.min(1, usage.percent / 100)) : null;
		recordNativeCompaction(telemetry, sessionId, {
			event: "session_compact",
			reason: event?.reason,
			willRetry: event?.willRetry === true,
		}, percent);
		return undefined;
	});

	api.on("session_compact_failed", async (event: any, ctx: any) => {
		const { sessionId, telemetry } = getState();
		const usage = ctx?.getContextUsage?.();
		const percent = typeof usage?.percent === "number" ? Math.max(0, Math.min(1, usage.percent / 100)) : null;
		recordNativeCompaction(telemetry, sessionId, {
			event: "session_compact_failed",
			reason: event?.reason,
			willRetry: event?.willRetry === true,
			errorMessage: typeof event?.errorMessage === "string" ? event.errorMessage.slice(0, 500) : undefined,
			aborted: event?.aborted === true,
			fromExtension: event?.fromExtension === true,
		}, percent);
		return undefined;
	});
}

/** Format compaction advice as readable text (for /flux command) */
export function formatCompactionAdvice(advice: CompactionAdvice): string {
	const markers = {
		allow: "[allow]",
		suggest_fork: "[fork]",
		suggest_handoff: "[handoff]",
		force_compact: "[compact]",
	};
	return [
		`Compaction Advice (B-dimension adaptive):`,
		`  ${markers[advice.action]} action  ${advice.action}`,
		`    reason  ${advice.reason}`,
		`    ctx     ${(advice.contextPercent * 100).toFixed(1)}%`,
		`    tools   ${advice.toolResultCount} toolResult`,
		`    turns   ${advice.turnCount}`,
	].join("\n");
}
