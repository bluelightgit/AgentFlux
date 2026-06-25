/**
 * AgentFlux Extension — subagent 精简入口
 * 仅加载 prefix-layout + cache 监控, 不注册 flux_subagent tool 和 /flux 命令
 * 避免改变子进程 LLM 的工具列表和行为 (实验 C 暴露的问题)
 *
 * 用法: subagent 子进程用 -e src/subagent-entry.ts (替代 src/entry.ts)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadConfig } from "./core/config";
import { applyPrefixLayout } from "./extension/prefix-layout";
import { TelemetryWriter } from "./telemetry/events";
import type { FluxRuntimeState } from "./core/types";

export default function (pi: ExtensionAPI) {
	let state: FluxRuntimeState = {
		mode: "M2", preset: "balanced", expectedMode: "M2",
		stage: "Seed", role: "doer", branch: null, turnIndex: 0,
		cache: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0,
			contextTokens: 0, contextWindow: 0, contextPercent: null, cacheHitRate: 0 },
	};
	let telemetry: TelemetryWriter | null = null;
	let sessionId = "subagent";

	pi.on("session_start", async (_event: any, ctx: any) => {
		try {
			const config = loadConfig(ctx.cwd);
			telemetry = new TelemetryWriter(join(ctx.cwd, ".agentflux"), true);
			sessionId = ctx.sessionManager?.getSessionFile?.() ?? `subagent-${Date.now()}`;
			// 只设 mode, 不跑路由/maturity/footer (subagent 不需要)
			state.mode = "M2";
			// stderr 标记
			console.error(`[agentflux-subagent] prefix_layout=${config.cache.prefix_layout}`);
		} catch (e) {
			console.error(`[agentflux-subagent] init error: ${e}`);
		}
	});

	// ---------- F1-2 前缀布局 (唯一功能) ----------

	pi.on("before_provider_request", async (event: any, _ctx: any) => {
		if (!telemetry) return undefined;
		try {
			const config = loadConfig(_ctx.cwd);
			const { payload, result } = applyPrefixLayout(event.payload, config.cache);
			if (result.applied) {
				telemetry.writeContextEvent({
					sessionId, turnIndex: state.turnIndex,
					action: "prefix_layout_rewrite",
					detail: result.reason,
					contextPercentBefore: state.cache.contextPercent,
					contextPercentAfter: state.cache.contextPercent,
				});
				return payload;
			}
		} catch { /* */ }
		return undefined;
	});

	// ---------- 轮次追踪 ----------

	pi.on("turn_end", async (_event: any, _ctx: any) => {
		state.turnIndex++;
	});
}
