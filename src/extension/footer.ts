/**
 * AgentFlux Extension — TUI 渲染 (footer / status / overlay)
 * 文档依据: docs/10-pi-integration §5, 12-ui-direction
 *
 * pi TUI 布局: footer = 左(cache/mode/ctx/cost) + 右(stage/role/preset→expected)
 * 非 TUI 模式 (print/rpc) setFooter/setStatus 是 no-op, 走 telemetry + stderr
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FluxRuntimeState } from "../core/types";
import { fmt, fmtCost, pct } from "./cache-monitor";

export function installFooter(ctx: any, getState: () => FluxRuntimeState, getRouteHint?: () => string | null): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setFooter((_tui: any, theme: any, _footerData: any) => {
		return {
			invalidate() {},
			render(width: number): string[] {
				const s = getState();
				// 新 session 尚无 turn 数据时显示 'init' 而非误导性的 0%
				const hasData = s.cache.input > 0 || s.cache.cacheRead > 0 || s.cache.costUsd > 0;
				const cacheStr = hasData
					? `cache ${(s.cache.cacheHitRate * 100).toFixed(0)}%`
					: `cache --`;
				const ctxStr = s.cache.contextPercent != null
					? `ctx ${pct(s.cache.contextPercent)}`
					: `ctx --`;
				const costStr = hasData ? fmtCost(s.cache.costUsd) : `$--`;
				const left = theme.fg("dim",
					`flux ${s.mode} | ${cacheStr} | ${ctxStr} | ${costStr}`);
				const right = theme.fg("dim", `${s.stage}/${s.role} | ${s.preset}->${s.expectedMode}`);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
				const line1 = truncateToWidth(left + pad + right, width);
				// Route hint line (only when router suggests different mode)
				const hint = getRouteHint?.();
				if (hint) {
					const hintLine = truncateToWidth(theme.fg("accent", `  hint: ${hint}`), width);
					return [line1, hintLine];
				}
				return [line1];
			},
		};
	});
}

export function setFluxStatus(ctx: any, getState: () => FluxRuntimeState): void {
	// No-op: we use setFooter for all status display.
	// setStatus creates a persistent bar above the editor that's hard to dismiss.
	// Footer already shows mode/stage/role/preset, so no separate status needed.
}

/** 构造 /flux 摘要文本 (TUI notify + 非 TUI stdout 共用) */
export function buildFluxSummary(s: FluxRuntimeState, telemetryPath: string, branch: string | null): string {
	return [
		`AgentFlux`,
		`  mode      ${s.mode}  (fallback ${s.mode === "M1" ? "M1" : "M1"})`,
		`  stage     ${s.stage}  /  role ${s.role}`,
		`  preset    ${s.preset}  ->  expected ${s.expectedMode}`,
		`  branch    ${branch ?? "-"}`,
		``,
		`Cache Ledger (cumulative)`,
		`  input       ${fmt(s.cache.input)}`,
		`  cacheRead   ${fmt(s.cache.cacheRead)}`,
		`  cacheWrite  ${fmt(s.cache.cacheWrite)}`,
		`  hit rate    ${(s.cache.cacheHitRate * 100).toFixed(1)}%`,
		`  cost        ${fmtCost(s.cache.costUsd)}`,
		``,
		`Context`,
		`  tokens  ${fmt(s.cache.contextTokens)} / ${fmt(s.cache.contextWindow)}`,
		`  fill    ${pct(s.cache.contextPercent)}`,
		``,
		`telemetry: ${telemetryPath}`,
	].join("\n");
}

/** 构造 route inspector 文本 (/flux why) */
export function buildInspectorText(
	s: FluxRuntimeState,
	decision: { reason: string[]; confidence: number; expected: any; biasSources: any } | null,
	maturitySignals: { fileCount: number; commitCount: number },
	telemetryPath: string,
): string {
	const lines: string[] = [
		`Current Mode`,
		`  ${s.mode}  ·  fallback M1`,
		``,
		`Route Reason`,
	];
	if (decision) {
		for (const r of decision.reason) lines.push(`  - ${r}`);
		lines.push(`  confidence ${decision.confidence}`);
		lines.push(`  expected   cost:${decision.expected.cost} latency:${decision.expected.latency} acc:${decision.expected.accuracy}`);
	} else {
		lines.push(`  - router not yet run (Phase 1 rule routing)`);
	}
	lines.push(``, `Project Maturity`,
		`  stage ${s.stage}   role ${s.role}`,
		`  signals  file ${maturitySignals.fileCount}  commit ${maturitySignals.commitCount}`,
		``, `Preference`,
		`  preset  ${s.preset}  ->  ${s.expectedMode}`,
		``, `Cache Ledger`,
		`  input ${fmt(s.cache.input)}  read ${fmt(s.cache.cacheRead)}  write ${fmt(s.cache.cacheWrite)}`,
		`  hit ${(s.cache.cacheHitRate * 100).toFixed(1)}%  |  ctx ${pct(s.cache.contextPercent)}  |  ${fmtCost(s.cache.costUsd)}`,
		``, `telemetry → ${telemetryPath}`);
	return lines.join("\n");
}
