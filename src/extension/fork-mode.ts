/**
 * AgentFlux Extension — M3 对话树 fork 管理
 * 文档依据: docs/03-modes M3, 06-cache-strategy B4 fork-prune, 10-pi-integration
 *
 * M3 模式: 利用 pi 的对话树结构, 在特定节点 fork 出分支进行并行探索,
 * 完成后 prune (丢弃失败分支) 或 merge (获胜分支向上合并).
 *
 * pi 提供:
 *   - ctx.fork(entryId, options) → 从指定 entry 创建分支 (session 替换)
 *   - ctx.navigateTree(targetId, options) → 导航到树中任意节点
 *   - session_before_fork / session_before_tree 事件 → 拦截/记录 fork
 *   - SessionManager.getTree() → 获取对话树结构
 *
 * AgentFlux 增量:
 *   1. /flux fork <direction> 命令 → 智能选择 fork 点 (最近的用户消息)
 *   2. fork.event telemetry → 记录分支创建/切换/合并/prune
 *   3. 路由器在 M3 模式下建议 fork 而非 compact
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TelemetryWriter } from "../telemetry/events";

export interface ForkInfo {
	forkId: string;
	parentEntryId: string;
	label: string;
	createdAt: number;
	status: "active" | "merged" | "pruned";
}

/**
 * 注册 M3 fork 相关的命令和事件.
 * 在 entry.ts 中调用此函数.
 */
export function registerForkMode(pi: ExtensionAPI, getState: () => { sessionId: string; telemetry: TelemetryWriter | null }) {

	// ---------- session_before_fork 事件: 记录 fork ----------

	pi.on("session_before_fork", async (event: any, _ctx: any) => {
		const { sessionId, telemetry } = getState();
		if (!telemetry) return undefined;
		const targetId = event.targetEntryId ?? event.entryId ?? "unknown";
		telemetry.writeContextEvent({
			sessionId, turnIndex: -1, // fork 不是常规轮次
			action: "fork_created",
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
		const targetId = event.targetEntryId ?? event.targetId ?? "unknown";
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
 *   /flux fork           → 列出可选 fork 点
 *   /flux fork <entryId> → 从指定 entry fork
 *   /flux fork last      → 从最近一条用户消息 fork
 *   /flux fork merge     → 合并策略说明 (当前为手动合并)
 */
export async function handleForkCommand(args: string[], ctx: any): Promise<string> {
	// /flux fork merge: 合并说明
	if (args[0] === "merge") {
		return [
			"Fork Merge:",
			"  pi 的 fork 创建独立分支, 分支间不自动合并.",
			"  合并策略:",
			"  1. 手动: 在目标分支复制输出, 切回主分支粘贴",
			"  2. Git: 用 git merge 合并不同 worktree 的代码变更",
			"  3. AgentFlux 自动 (Phase 3): 读取两分支的 last assistant message,",
			"     用 LLM 合并后注入当前会话",
			"",
			"  当前阶段请用手动或 git 方式. 自动 merge 在 Phase 3 实现.",
		].join("\n");
	}

	if (!ctx.fork) {
		return "M3 fork 不可用: 当前模式不支持 ctx.fork (需要 TUI 或 RPC 模式)";
	}

	const candidates = getForkCandidates(ctx, 5);

	if (args.length === 0) {
		// 列出 fork 候选点
		const lines = ["可选 fork 点 (最近 5 条用户消息):", "─".repeat(50)];
		for (let i = candidates.length - 1; i >= 0; i--) {
			const c = candidates[i];
			lines.push(`  [${i}] ${c.entryId.slice(0, 12)}  ${c.preview}`);
		}
		lines.push("", "用法: /flux fork <序号> 或 /flux fork last");
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
		return `未找到 fork 点: ${args[0]}`;
	}

	const result = await ctx.fork(targetEntryId, {
		withSession: async (newCtx: any) => {
			newCtx.ui?.notify?.("AgentFlux fork: 已创建新分支", "info");
		},
	});

	if (result?.cancelled) {
		return "fork 被取消 (可能被其他扩展拦截)";
	}

	return `fork 成功: 从 ${targetEntryId.slice(0, 12)} 创建了新分支. 当前会话已切换到新分支.`;
}
