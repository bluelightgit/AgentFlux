/**
 * AgentFlux V0 Probe — pi extension
 *
 * 验证目标 (docs/11 §五):
 *  1. cache stats 能实时拿到 (cacheRead/cacheWrite/context%)
 *  2. telemetry 能沉淀到 events.jsonl
 *  3. TUI 能承载状态 (setFooter/setStatus)
 *  4. event schema 稳定, 后续 Web 可复用
 *
 * 同时覆盖两个新能力的最小形态:
 *  - 路由偏好 (docs/13): 读 profile, footer 显示倾向落点
 *  - 项目演进 (docs/14): git 信号 → stage + role
 *
 * 用法:
 *   pi -e experiments/v0-probe/agentflux-probe.ts
 *   pi -e experiments/v0-probe/agentflux-probe.ts -p "say hi"   # 验证 events.jsonl
 *   /flux            # 当前状态摘要
 *   /flux why        # route inspector (TUI overlay / 非 TUI 用 notify)
 *
 * 数据落点: <cwd>/.agentflux/
 *   events.jsonl          每轮 cache.sample + routing.decision
 *   agentflux.json        用户偏好 (可选, 缺省 balanced)
 *   project-profile.json  项目成熟度 (自动生成/更新)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

interface FluxState {
	mode: string;
	pref: string;
	expectedMode: string;
	stage: string;
	role: string;
	branch: string | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	contextTokens: number;
	contextWindow: number;
	contextPercent: number | null;
	turnIndex: number;
}

function git(cwd: string, args: string): string {
	try {
		return execSync(`git ${args}`, { cwd, encoding: "utf-8", timeout: 5000, shell: true }).trim();
	} catch {
		return "";
	}
}

function collectMaturity(cwd: string) {
	const fileCount = git(cwd, "ls-files").split("\n").filter(Boolean).length;
	const commitCount = Number(git(cwd, "rev-list --count HEAD")) || 0;
	const branch = git(cwd, "rev-parse --abbrev-ref HEAD") || null;

	// V0 简化: 仅 file + commit 两信号 (LOC/耦合度/深度 Phase 1 静态分析补). 阈值见 docs/14
	let stage = "Seed";
	let role = "doer";
	if (fileCount > 50 || commitCount > 20) { stage = "Growth"; role = "doer+reviewer"; }
	if (commitCount > 100 || fileCount > 300) { stage = "Established"; role = "planner+orchestrator+reviewer"; }
	// Mature 需多 PR/持久记忆信号, V0 不判定
	return { fileCount, commitCount, branch, stage, role };
}

function prefToExpectedMode(pref: string): string {
	switch (pref) {
		case "eco": return "M1";
		case "fast": return "M3";
		case "accurate": return "M6";
		case "balanced": return "M2";
		default: return "M2";
	}
}

function loadPreference(cwd: string): string {
	const cfgPath = join(cwd, ".agentflux", "agentflux.json");
	if (existsSync(cfgPath)) {
		try {
			const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
			return cfg?.preference?.profile ?? "balanced";
		} catch { return "balanced"; }
	}
	return "balanced";
}

function loadOrCreateProfile(cwd: string, maturity: ReturnType<typeof collectMaturity>) {
	const p = join(cwd, ".agentflux", "project-profile.json");
	let existing: any = {};
	if (existsSync(p)) { try { existing = JSON.parse(readFileSync(p, "utf-8")); } catch { existing = {}; } }
	const updated = {
		version: 1,
		project: { root: cwd, name: cwd.split(/[\\/]/).pop() },
		maturity: {
			stage: maturity.stage,
			stage_since: existing?.maturity?.stage_since ?? new Date().toISOString().slice(0, 10),
			signals: { file_count: maturity.fileCount, commit_history: maturity.commitCount },
		},
		role: { primary: maturity.role, delegate_impl: maturity.stage === "Established" },
		baseline_mode: maturity.stage === "Seed" ? "M1" : "M2",
		history: existing?.history ?? [],
	};
	try { writeFileSync(p, JSON.stringify(updated, null, 2)); } catch { /* best effort */ }
	return updated;
}

function fmt(n: number): string { return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`; }
function pct(x: number | null): string { return x == null ? "?" : `${Math.round(x * 100)}%`; }

export default function (pi: ExtensionAPI) {
	const state: FluxState = {
		mode: "M2", pref: "balanced", expectedMode: "M2", stage: "Seed", role: "doer", branch: null,
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0,
		contextTokens: 0, contextWindow: 0, contextPercent: null, turnIndex: 0,
	};

	let fluxDir = "";
	let sessionId = "";
	let profile: any = {};
	let maturitySignals = { fileCount: 0, commitCount: 0 };

	function ensureFluxDir(cwd: string) {
		fluxDir = join(cwd, ".agentflux");
		try { mkdirSync(fluxDir, { recursive: true }); } catch { /* exists */ }
	}

	function writeEvent(ev: Record<string, unknown>) {
		if (!fluxDir) return;
		try { appendFileSync(join(fluxDir, "events.jsonl"), JSON.stringify(ev) + "\n"); } catch { /* */ }
	}

	function refreshFromBranch(ctx: any) {
		let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage.input || 0;
				output += m.usage.output || 0;
				cacheRead += (m.usage as any).cacheRead || 0;
				cacheWrite += (m.usage as any).cacheWrite || 0;
				cost += m.usage.cost?.total || 0;
			}
		}
		state.input = input; state.output = output; state.cacheRead = cacheRead;
		state.cacheWrite = cacheWrite; state.costUsd = cost;
		const cu = ctx.getContextUsage?.();
		if (cu) {
			state.contextTokens = cu.tokens || 0;
			state.contextWindow = (cu as any).contextWindow || 0;
			state.contextPercent = (cu as any).percent ?? null;
		}
	}

	function emitCacheSample(ctx: any) {
		const hitRate = state.cacheRead / (state.cacheRead + state.input + 1e-9);
		writeEvent({
			type: "cache.sample", ts: Date.now(), sessionId, turnIndex: state.turnIndex,
			model: ctx.model?.id ?? null, mode: state.mode, stage: state.stage, role: state.role,
			pref: state.pref, expectedMode: state.expectedMode,
			input: state.input, output: state.output, cacheRead: state.cacheRead, cacheWrite: state.cacheWrite,
			costUsd: Number(state.costUsd.toFixed(6)),
			contextTokens: state.contextTokens, contextWindow: state.contextWindow,
			contextPercent: state.contextPercent, cacheHitRate: Number(hitRate.toFixed(4)),
		});
		console.error(
			`[flux] turn ${state.turnIndex} | in ${fmt(state.input)} read ${fmt(state.cacheRead)} ` +
			`write ${fmt(state.cacheWrite)} hit ${(hitRate * 100).toFixed(0)}% | ctx ${pct(state.contextPercent)} | ` +
			`$${state.costUsd.toFixed(4)} | ${state.mode} · ${state.stage}/${state.role} · pref ${state.pref}→${state.expectedMode}`,
		);
	}

	function setFluxStatus(ctx: any) {
		if (!ctx.hasUI) return;
		const t = ctx.ui.theme;
		ctx.ui.setStatus("flux", t.fg("dim",
			`flux · ${state.mode} · ${state.stage}/${state.role} · pref ${state.pref}→${state.expectedMode}`));
	}

	function installFooter(ctx: any) {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui: any, theme: any, _footerData: any) => ({
			invalidate() {},
			render(width: number): string[] {
				const hitRate = state.cacheRead / (state.cacheRead + state.input + 1e-9);
				const left = theme.fg("dim",
					`flux ${state.mode} · cache ${(hitRate * 100).toFixed(0)}% · ctx ${pct(state.contextPercent)} · $${state.costUsd.toFixed(3)}`);
				const right = theme.fg("dim", `${state.stage}/${state.role} · ${state.pref}→${state.expectedMode}`);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	}

	function buildInspectorText(hitRate: number): string {
		return [
			`Current Mode`,
			`  ${state.mode}  ·  fallback M1`,
			``,
			`Route Reason`,
			`  - v0-probe: 静态默认 (路由器 Phase 1 接入)`,
			`  - stage ${state.stage} → baseline ${state.stage === "Seed" ? "M1" : "M2"}`,
			`  - pref ${state.pref} → expected ${state.expectedMode}`,
			``,
			`Project Maturity (docs/14)`,
			`  stage ${state.stage}   role ${state.role}`,
			`  signals  file ${maturitySignals.fileCount}  commit ${maturitySignals.commitCount}`,
			``,
			`Preference (docs/13)`,
			`  profile  ${state.pref}  →  ${state.expectedMode}`,
			``,
			`Cache Ledger`,
			`  input ${fmt(state.input)}  read ${fmt(state.cacheRead)}  write ${fmt(state.cacheWrite)}`,
			`  hit ${(hitRate * 100).toFixed(1)}%  ·  ctx ${pct(state.contextPercent)}  ·  $${state.costUsd.toFixed(4)}`,
			``,
			`telemetry → .agentflux/events.jsonl`,
		].join("\n");
	}

	async function showInspector(ctx: any, hitRate: number) {
		const text = buildInspectorText(hitRate);
		if (ctx.mode !== "tui") { ctx.ui.notify(text, "info"); return; }
		await ctx.ui.custom<void>((tui: any, theme: any, _kb: any, done: () => void) => {
			const lines = text.split("\n");
			let closed = false;
			const close = () => { if (!closed) { closed = true; done(); } };
			return {
				render(width: number): string[] {
					const out: string[] = [theme.fg("accent", "┌─ AgentFlux · Route Inspector ─")];
					for (const ln of lines) out.push("  " + theme.fg("text", truncateToWidth(ln, width - 2)));
					out.push(theme.fg("dim", "  esc / q 关闭"));
					return out;
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape) || data === "q") close();
					tui.requestRender();
				},
			};
		}, { overlay: true });
	}

	// ---------- 事件 ----------

	pi.on("session_start", async (_event, ctx: any) => {
		ensureFluxDir(ctx.cwd);
		sessionId = ctx.sessionManager?.getSessionFile?.() ?? `s${Date.now()}`;
		const m = collectMaturity(ctx.cwd);
		maturitySignals = { fileCount: m.fileCount, commitCount: m.commitCount };
		state.branch = m.branch; state.stage = m.stage; state.role = m.role;
		state.pref = loadPreference(ctx.cwd);
		state.expectedMode = prefToExpectedMode(state.pref);
		profile = loadOrCreateProfile(ctx.cwd, m);

		writeEvent({
			type: "routing.decision", ts: Date.now(), sessionId,
			mode: state.mode, stage: state.stage, role: state.role,
			pref: state.pref, expectedMode: state.expectedMode,
			reason: ["v0-probe:static-default", `stage:${state.stage}`], fallback: "M1",
		});

		setFluxStatus(ctx);
		installFooter(ctx);
		if (ctx.hasUI) ctx.ui.notify(`AgentFlux V0 · ${state.stage}/${state.role} · pref ${state.pref}`, "info");
	});

	pi.on("turn_end", async (event: any, ctx: any) => {
		state.turnIndex = event.turnIndex ?? state.turnIndex + 1;
		refreshFromBranch(ctx);
		emitCacheSample(ctx);
	});

	pi.on("agent_end", async (_event, ctx: any) => {
		refreshFromBranch(ctx);
		emitCacheSample(ctx);
		if (profile?.maturity) {
			profile.maturity.signals.session_history = (profile.maturity.signals?.session_history ?? 0) + 1;
			try { writeFileSync(join(fluxDir, "project-profile.json"), JSON.stringify(profile, null, 2)); } catch { /* */ }
		}
	});

	// ---------- 命令 ----------

	pi.registerCommand("flux", {
		description: "AgentFlux: show current routing/cache state (try: /flux why)",
		handler: async (args: string, ctx: any) => {
			refreshFromBranch(ctx);
			const hitRate = state.cacheRead / (state.cacheRead + state.input + 1e-9);
			if (args?.trim() === "why") { await showInspector(ctx, hitRate); return; }
			const lines = [
				`AgentFlux V0`,
				`  mode      ${state.mode}  (fallback M1)`,
				`  stage     ${state.stage}  /  role ${state.role}`,
				`  pref      ${state.pref}  →  expected ${state.expectedMode}`,
				`  branch    ${state.branch ?? "-"}`,
				``,
				`Cache Ledger (cumulative)`,
				`  input      ${fmt(state.input)}`,
				`  cacheRead  ${fmt(state.cacheRead)}`,
				`  cacheWrite ${fmt(state.cacheWrite)}`,
				`  hit rate   ${(hitRate * 100).toFixed(1)}%`,
				`  cost       $${state.costUsd.toFixed(4)}`,
				``,
				`Context`,
				`  tokens  ${fmt(state.contextTokens)} / ${fmt(state.contextWindow)}`,
				`  fill    ${pct(state.contextPercent)}`,
				``,
				`telemetry: ${join(fluxDir, "events.jsonl")}`,
			].join("\n");
			if (ctx.hasUI) ctx.ui.notify(lines, "info"); else console.log(lines);
		},
	});
}
