/** pi 会话树 fork 的最小适配层。fork 是 Agent 创建来源，不是工作模式。 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TelemetryWriter } from "../telemetry/events";

export function registerSessionFork(pi: ExtensionAPI, getState: () => { sessionId: string; telemetry: TelemetryWriter | null }) {

	// ---------- session_before_fork 事件: 记录 fork ----------

	pi.on("session_before_fork", async (event: any, _ctx: any) => {
		const { sessionId, telemetry } = getState();
		if (!telemetry) return undefined;
		const targetId = event.targetEntryId ?? event.entryId ?? "unknown";
		telemetry.writeContextEvent({
			sessionId, turnIndex: -1, // fork 不是常规轮次
			action: "fork_attempted",
			detail: `fork from ${targetId}`,
			contextPercentBefore: null,
			contextPercentAfter: null,
		});
		console.error(`[flux] fork: from entry ${targetId}`);
		return undefined;
	});

	// ---------- session_before_tree 事件: 记录树导航 ----------

	pi.on("session_before_tree", async (event: any, _ctx: any) => {
		const { sessionId, telemetry } = getState();
		if (!telemetry) return undefined;
		const targetId = event.preparation?.targetId ?? "unknown";
		telemetry.writeContextEvent({
			sessionId, turnIndex: -1,
			action: "tree_navigate",
			detail: `navigate to ${targetId}`,
			contextPercentBefore: null,
			contextPercentAfter: null,
		});
		console.error(`[flux] tree navigate: to entry ${targetId}`);
		return undefined;
	});
}

/**
 * 辅助: 获取当前分支最近的 N 条用户消息 entry, 供 fork 选择.
 */
export function getForkCandidates(ctx: any, count = 3): Array<{ entryId: string; preview: string }> {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	const userEntries = branch.filter((e: any) =>
		e.type === "message" && e.message?.role === "user"
	);
	// 取最近 N 条
	const recent = userEntries.slice(-count);
	return recent.map((e: any) => ({
		entryId: e.id ?? e.entryId ?? "",
		preview: (e.message?.content?.[0]?.text ?? e.message?.content ?? "").slice(0, 80),
	}));
}

/**
 * /flux fork 命令处理器:
 *   /flux fork           → 列出Available fork points
 *   /flux fork <entryId> → 从指定 entry fork
 *   /flux fork last      → 从最近一条用户消息 fork
 */
export async function handleForkCommand(args: string[], ctx: any): Promise<string> {
	if (!ctx.fork) {
		return "Fork unavailable: current runtime does not expose ctx.fork (requires TUI or RPC mode)";
	}

	const candidates = getForkCandidates(ctx, 5);

	if (args.length === 0) {
		// 列出 fork 候选点
		const lines = ["Available fork points (last 5 user messages):", "─".repeat(50)];
		for (let i = candidates.length - 1; i >= 0; i--) {
			const c = candidates[i];
			lines.push(`  [${i}] ${c.entryId.slice(0, 12)}  ${c.preview}`);
		}
		lines.push("", "Usage: /flux fork <index> or /flux fork last");
		return lines.join("\n");
	}

	let targetEntryId: string | undefined;
	if (args[0] === "last") {
		targetEntryId = candidates[candidates.length - 1]?.entryId;
	} else if (/^\d+$/.test(args[0])) {
		const idx = parseInt(args[0]);
		targetEntryId = candidates[idx]?.entryId;
	} else {
		targetEntryId = args[0]; // 直接传 entryId
	}

	if (!targetEntryId) {
		return `Fork point not found: ${args[0]}`;
	}

	const result = await ctx.fork(targetEntryId, {
		withSession: async (newCtx: any) => {
			newCtx.ui?.notify?.("AgentFlux fork: new branch created", "info");
		},
	});

	if (result?.cancelled) {
		return "fork cancelled (possibly intercepted by another extension)";
	}

	return `Fork succeeded: created a new branch from ${targetEntryId.slice(0, 12)}. The current session switched to the new branch.`;
}
