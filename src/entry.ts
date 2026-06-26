/**
 * AgentFlux Phase 1+2 — pi extension 主入口
 * 文档依据: docs/07 Phase 1+2, docs/17-19 模型能力/角色/多agent架构
 *
 * 用法:
 *   pi -e src/entry.ts
 *   pi -e src/entry.ts -p "..."            # print 模式验证 telemetry
 *   /flux                                   # 状态摘要
 *   /flux why                               # route inspector (含复杂度信号)
 *   /flux mode <eco|fast|accurate|balanced> # 切换预设 (运行时覆盖)
 *   /flux preference                        # 偏好画像
 *   /flux project                           # 项目成熟度面板
 *   /flux fork [last|序号|entryId]          # M3 对话树 fork
 *   /flux complexity                        # 显示 RGAO 复杂度信号
 *   /flux team status|plan|build|review|abort|roles|models|affinity
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import type { FluxRuntimeState, RoutingDecision, Preset, ProjectProfile } from "./core/types";
import { loadConfig, loadPreference, applyRuntimeOverride, validateConfig } from "./core/config";
import { route } from "./core/routing";
import { TelemetryWriter, cacheStatsToSample } from "./telemetry/events";
import { collectCacheStats, fmt, fmtCost, pct } from "./extension/cache-monitor";
import { collectMaturity, loadOrCreateProfile, bumpSessionHistory } from "./extension/maturity";
import { installFooter, setFluxStatus, buildFluxSummary, buildInspectorText } from "./extension/footer";
import { applyPrefixLayout } from "./extension/prefix-layout";
import { applyMask } from "./extension/mask";
import { loadSubagent, runSubagent, formatSubagentResult } from "./extension/subagent";
import { registerForkMode, handleForkCommand } from "./extension/fork-mode";
import { handleTeamCommand, type TeamContext } from "./extension/team";
import { collectComplexitySignal, formatComplexitySignal, type TaskComplexitySignal } from "./core/complexity";
import { loadPricing, type PricingTable } from "./core/pricing";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// ---------- 可变运行时状态 ----------
	const state: FluxRuntimeState = {
		mode: "M2", preset: "balanced", expectedMode: "M2", stage: "Seed", role: "doer",
		branch: null, turnIndex: 0,
		cache: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextWindow: 0, contextPercent: null, cacheHitRate: 0 },
	};

	let fluxDir = "";
	let sessionId = "";
	let telemetry: TelemetryWriter;
	let profile: ProjectProfile | null = null;
	let decision: RoutingDecision | null = null;
	let maturitySignals = { fileCount: 0, commitCount: 0 };
	let runtimePreset: Preset | undefined;
	let pricingTable: PricingTable | null = null;
	let complexitySignal: TaskComplexitySignal | null = null;
	let teamCtx: TeamContext | null = null;

	const getState = () => state;

	function refreshCache(ctx: any) {
		state.cache = collectCacheStats(ctx, pricingTable ?? undefined);
	}

	function emitSample(ctx: any) {
		telemetry.writeCacheSample(cacheStatsToSample(state.cache, {
			turnIndex: state.turnIndex, model: ctx.model?.id ?? null,
			mode: state.mode, stage: state.stage, role: state.role, preset: state.preset, sessionId,
		}));
		// 非 TUI 模式 stderr 实时观测
		console.error(
			`[flux] turn ${state.turnIndex} | in ${fmt(state.cache.input)} read ${fmt(state.cache.cacheRead)} ` +
			`write ${fmt(state.cache.cacheWrite)} hit ${(state.cache.cacheHitRate * 100).toFixed(0)}% | ` +
			`ctx ${pct(state.cache.contextPercent)} | ${fmtCost(state.cache.costUsd)} | ` +
			`${state.mode} · ${state.stage}/${state.role} · ${state.preset}→${state.expectedMode}`,
		);
	}

	function runRouter(ctx: any) {
		const config = loadConfig(ctx.cwd);
		let pref = loadPreference(ctx.cwd);
		const ov = applyRuntimeOverride(config, pref, runtimePreset);
		state.preset = ov.config.mode;
		pref = ov.pref;

		decision = route({ stage: state.stage, pref, preset: state.preset, taskSignal: complexitySignal ?? undefined });
		state.mode = decision.mode;
		state.expectedMode = decision.biasSources.preference ?? state.mode;

		// 校验 warnings → reason (Phase 1 只记录)
		const warnings = validateConfig(config);
		for (const w of warnings) decision.reason.push(`warn:${w}`);

		telemetry.writeRoutingDecision({
			sessionId, mode: state.mode, preset: state.preset, stage: state.stage, role: state.role,
			reason: decision.reason, confidence: decision.confidence, fallback: decision.fallback,
			biasSources: decision.biasSources, expected: decision.expected,
		});
	}

	// ---------- 事件 ----------

	pi.on("session_start", async (_event, ctx: any) => {
		fluxDir = join(ctx.cwd, ".agentflux");
		telemetry = new TelemetryWriter(fluxDir, true);
		sessionId = ctx.sessionManager?.getSessionFile?.() ?? `s${Date.now()}`;

		const m = collectMaturity(ctx.cwd);
		maturitySignals = { fileCount: m.fileCount, commitCount: m.commitCount };
		state.branch = m.branch; state.stage = m.stage; state.role = m.role;
		profile = loadOrCreateProfile(ctx.cwd, m);

		// F1-14: 加载价格表 (OpenRouter 远程 + 用户覆盖 + 兑底均值)
		const config = loadConfig(ctx.cwd);
		const currentModel = ctx.model?.id ?? "deepseek-v4-flash";
		try {
			pricingTable = await loadPricing(fluxDir, config.pricing, currentModel);
		} catch (e: any) {
			console.error(`[flux pricing] load failed: ${e?.message}, cost 将回退上游 cost.total`);
		}

		// Phase 2: 收集复杂度信号 (RGAO 静态分析)
		try {
			complexitySignal = collectComplexitySignal(ctx.cwd);
			console.error(`[flux] complexity: tier${complexitySignal.complexityTier} → ${complexitySignal.recommendedMode} (${complexitySignal.reason.join("; ")})`);
		} catch (e: any) {
			console.error(`[flux] complexity analysis failed: ${e?.message}`);
		}

		// Phase 2: 加载 models.json (模型 + 角色定义)
		let modelsConfig: any = null;
		try {
			const modelsPath = join(fluxDir, "models.json");
			if (existsSync(modelsPath)) {
				modelsConfig = JSON.parse(readFileSync(modelsPath, "utf-8"));
				console.error(`[flux] models.json loaded: ${Object.keys(modelsConfig.models ?? {}).length} models, ${Object.keys(modelsConfig.roles ?? {}).length} roles`);
			}
		} catch (e: any) {
			console.error(`[flux] models.json load failed: ${e?.message}`);
		}
		teamCtx = { cwd: ctx.cwd, fluxDir, telemetry, modelsConfig, sharedSkills: config.sharedSkills, prefixLayout: config.cache.prefix_layout === "static_first", pricing: pricingTable ?? undefined };

		runRouter(ctx);
		setFluxStatus(ctx, getState);
		installFooter(ctx, getState);
		if (ctx.hasUI) ctx.ui.notify(`AgentFlux · ${state.stage}/${state.role} · ${state.preset}→${state.expectedMode} · ${state.mode}`, "info");
		else console.error(`[flux] init · ${state.stage}/${state.role} · ${state.preset}→${state.expectedMode} · mode ${state.mode}`);
	});

	pi.on("turn_end", async (event: any, ctx: any) => {
		state.turnIndex = event.turnIndex ?? state.turnIndex + 1;
		refreshCache(ctx);
		emitSample(ctx);
	});

	pi.on("agent_end", async (_event, ctx: any) => {
		refreshCache(ctx);
		emitSample(ctx);
		if (profile) bumpSessionHistory(ctx.cwd, profile);
	});

	// ---------- F1-3 mask (context 事件, LLM 调用前) ----------

	pi.on("context", async (event: any, ctx: any) => {
		const config = loadConfig(ctx.cwd);
		const ctxPercent = state.cache.contextPercent;
		const { messages, result } = applyMask(event.messages, config.context, ctxPercent);
		if (result.applied) {
			telemetry.writeContextEvent({
				sessionId, turnIndex: state.turnIndex, action: "mask_applied",
				detail: result.reason, contextPercentBefore: result.contextPercentBefore,
				contextPercentAfter: ctxPercent,
			});
			console.error(`[flux] mask: ${result.reason}`);
			return { messages };
		}
		return undefined;
	});

	// ---------- F1-2 前缀布局 (before_provider_request, payload 构建后) ----------

	pi.on("before_provider_request", async (event: any, _ctx: any) => {
		const config = loadConfig(_ctx.cwd);
		const { payload, result } = applyPrefixLayout(event.payload, config.cache);
		if (result.applied) {
			telemetry.writeContextEvent({
				sessionId, turnIndex: state.turnIndex, action: "prefix_layout_rewrite",
				detail: result.reason, contextPercentBefore: state.cache.contextPercent,
				contextPercentAfter: state.cache.contextPercent,
			});
			return payload;
		}
		return undefined;
	});

	// ---------- M3 fork 事件 (Phase 2) ----------

	registerForkMode(pi, () => ({ sessionId, telemetry }));

	// ---------- 命令 ----------

	pi.registerTool({
		name: "flux_subagent",
		label: "Flux Subagent",
		description: "Delegate a task to a specialized AgentFlux subagent (e.g. reviewer). 子进程加载前缀布局+cache监控, 跨调用共享 L1。参数: agent (reviewer 或 .agentflux/agents/*.md 定义的), task (任务描述)",
		parameters: Type.Object({
			agent: Type.String({ description: "subagent 名称, 如 reviewer" }),
			task: Type.String({ description: "任务描述" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			const agent = loadSubagent(ctx.cwd, params.agent);
			if (!agent) {
				return { content: [{ type: "text", text: `AgentFlux: unknown subagent '${params.agent}'. 可用: reviewer (内建) 或 .agentflux/agents/*.md` }], details: {} };
			}
			const config = loadConfig(ctx.cwd);
			const r = await runSubagent({
				cwd: ctx.cwd, agent, task: params.task, sessionId,
				telemetry, prefixLayout: config.cache.prefix_layout === "static_first",
				pricing: pricingTable ?? undefined,
			});
			return { content: [{ type: "text", text: formatSubagentResult(r) }], details: {} };
		},
	});

	pi.registerCommand("flux", {
		description: "AgentFlux: routing/cache/mode/fork. subcommands: why | mode <preset> | preference | project | fork | complexity",
		handler: async (args: string, ctx: any) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0];

			if (sub === "why") return showInspector(ctx);
			if (sub === "mode") return cmdMode(parts[1] as Preset | undefined, ctx);
			if (sub === "preference") return cmdPreference(ctx);
			if (sub === "project") return cmdProject(ctx);
			if (sub === "fork") return handleForkCommand(parts.slice(1), ctx);
			if (sub === "complexity") return cmdComplexity(ctx);
			if (sub === "team") {
				if (!teamCtx) {
					const msg = "team 上下文未初始化 (session_start 未完成?)";
					if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
					return;
				}
				return handleTeamCommand(parts.slice(1), ctx, teamCtx);
			}

			// 默认: 摘要
			refreshCache(ctx);
			const text = buildFluxSummary(state, telemetry.path, state.branch);
			if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
		},
	});

	async function cmdMode(preset: Preset | undefined, ctx: any) {
		if (!preset) {
			const valid = "eco | fast | accurate | balanced | custom";
			const text = `当前 preset: ${state.preset}\n可选: ${valid}\n用法: /flux mode <preset>`;
			if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
			return;
		}
		runtimePreset = preset;
		runRouter(ctx);
		refreshCache(ctx);
		setFluxStatus(ctx, getState);
		const text = `preset → ${preset}\nmode ${state.mode} (fallback ${decision?.fallback})\nexpected ${state.expectedMode}\nreason: ${decision?.reason.join("; ")}`;
		if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
	}

	function cmdPreference(ctx: any) {
		const pref = loadPreference(ctx.cwd);
		const v = pref.vector;
		const text = [
			`Preference (docs/13)`,
			`  profile    ${pref.profile}  →  expected ${state.expectedMode}`,
			`  escalate   ${pref.escalate_hint}`,
			``,
			`  vector (0-1)`,
			`  cost_sensitivity        ${v.cost_sensitivity}`,
			`  accuracy_priority       ${v.accuracy_priority}`,
			`  latency_priority        ${v.latency_priority}`,
			`  parallelism_willingness ${v.parallelism_willingness}`,
			`  multi_agent_willingness ${v.multi_agent_willingness}`,
			``,
			`  scenarios ${Object.keys(pref.scenarios).length ? Object.keys(pref.scenarios).join(", ") : "(none)"}`,
			``,
			`调音台 (五维滑块) Phase 1 F1-11 待实现; 现可编辑 .agentflux/agentflux.json`,
		].join("\n");
		if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
	}

	function cmdProject(ctx: any) {
		const text = [
			`Project Maturity (docs/14)`,
			`  stage    ${state.stage}    role ${state.role}`,
			`  signals  file ${maturitySignals.fileCount}  commit ${maturitySignals.commitCount}  session ${profile?.maturity.signals.session_history ?? 0}`,
			`  baseline_mode  ${profile?.baseline_mode ?? "?"}`,
			`  delegate_impl  ${profile?.role.delegate_impl ?? false}`,
			``,
			`跃迁阈值: Seed→Growth(50file/20commit) →Established(300file/100commit) →Mature(多PR, Phase2+)`,
			``,
			`profile: ${join(fluxDir, "project-profile.json")}`,
		].join("\n");
		if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
	}

	function cmdComplexity(ctx: any) {
		if (!complexitySignal) {
			const text = "复杂度信号未收集 (session_start 失败?)";
			if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
			return;
		}
		const text = formatComplexitySignal(complexitySignal);
		if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
	}

	async function showInspector(ctx: any) {
		refreshCache(ctx);
		const parts = [buildInspectorText(state, decision, maturitySignals, telemetry.path)];
		if (complexitySignal) parts.push(formatComplexitySignal(complexitySignal));
		const text = parts.join("\n\n");
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
}
