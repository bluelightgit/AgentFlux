/**
 * AgentFlux Phase 1+2 — pi extension main entry
 * Docs: docs/07 Phase 1+2, docs/17-19 model capability/roles/multi-agent
 *
 * Usage:
 *   pi -e src/entry.ts
 *   pi -e src/entry.ts -p "..."            # print mode telemetry verification
 *   /flux                                   # main menu (TUI) / summary (non-TUI)
 *   /flux why                               # route inspector (with complexity + git signals)
 *   /flux mode <eco|fast|accurate|balanced> # switch preset (runtime override)
 *   /flux preference                        # preference tuner
 *   /flux project                           # project maturity panel
 *   /flux fork [last|index|entryId]         # M3 conversation tree fork
 *   /flux complexity                        # show RGAO complexity signal
 *   /flux team status|plan|build|review|abort|roles|models|affinity|pipeline
 *   /flux compact                           # compaction advice (B-dimension adaptive)
 *   /flux status                            # full status report (version, mode, subsystems, issues)
 *   /flux health                            # health check (8 subsystem diagnostics)
 *   /flux restart                           # re-initialize (reload config/pricing/models, re-run router)
 *   /flux upgrade                           # check git remote for updates
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import type { FluxRuntimeState, RoutingDecision, Preset, ProjectProfile } from "./core/types";
import { loadConfig, loadPreference, savePreference, applyRuntimeOverride, validateConfig, presetToExpectedMode } from "./core/config";
import { route } from "./core/routing";
import { TelemetryWriter, cacheStatsToSample } from "./telemetry/events";
import { collectCacheStats, fmt, fmtCost, pct } from "./extension/cache-monitor";
import { collectMaturity, loadOrCreateProfile, bumpSessionHistory } from "./extension/maturity";
import { installFooter, setFluxStatus, buildFluxSummary, buildInspectorText } from "./extension/footer";
import { applyPrefixLayout } from "./extension/prefix-layout";
import { applyMask } from "./extension/mask";
import { loadSubagent, runSubagent, formatSubagentResult, runSubagentsParallel, formatParallelResults, type ParallelSubagentTask } from "./extension/subagent";
import { registerForkMode, handleForkCommand, getForkCandidates } from "./extension/fork-mode";
import { handleForkExploreCommand, handleForkCompareCommand, handleForkPruneCommand } from "./extension/fork-workflow";
import { registerCompactionAdvisor, analyzeCompaction, formatCompactionAdvice } from "./extension/compaction-advisor";
import { handleTeamCommand, type TeamContext } from "./extension/team";
import { collectComplexitySignal, formatComplexitySignal, type TaskComplexitySignal } from "./core/complexity";
import { loadPricing, type PricingTable } from "./core/pricing";
import { showFluxMenu, type FluxMenuState, type FluxMenuCallbacks } from "./extension/flux-menu";
import type { PreferenceConfig } from "./core/types";
import { Type } from "typebox";
import { getVersionInfo, checkHealth, formatHealthReport, scanRecentIssues, checkUpgrade, formatUpgradeInfo, formatStatusReport, formatIssues, type SubsystemStatus, type AgentInfo } from "./extension/health-monitor";
import { loadAllRoles } from "./core/role-manager";

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
	let routeHint: string | null = null;  // non-intrusive route suggestion for footer
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

		// 校验 warnings → reason
		const warnings = validateConfig(config);
		for (const w of warnings) decision.reason.push(`warn:${w}`);

		// F2-10: override_mode suggest — non-intrusive footer hint (no popup)
		if (config.routing.override_mode === "suggest" && decision.confidence >= 0.7) {
			const expected = presetToExpectedMode(state.preset);
			if (decision.mode !== expected) {
			routeHint = `router suggests ${decision.mode} (${(decision.confidence*100).toFixed(0)}%) | preset ${state.preset} expects ${expected}`;
			console.error(`[flux] route hint: ${routeHint}`);
			} else {
			routeHint = null;
			}
		}

		telemetry.writeRoutingDecision({
			sessionId, mode: state.mode, preset: state.preset, stage: state.stage, role: state.role,
			reason: decision.reason, confidence: decision.confidence, fallback: decision.fallback,
			biasSources: decision.biasSources, expected: decision.expected,
		});
	}

	// ---------- 自重启: 重新执行初始化序列 ----------

	async function performRestart(ctx: any): Promise<string> {
		const lines: string[] = [];
		const step = (n: number, name: string, detail: string) => {
			lines.push(`[${n}] ${name}... ${detail}`);
		};

		step(1, "Clearing in-memory state", "done");
		state.mode = "M2"; state.preset = "balanced"; state.expectedMode = "M2";
		state.turnIndex = 0;
		state.cache = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextWindow: 0, contextPercent: null, cacheHitRate: 0 };
		decision = null; routeHint = null; pricingTable = null; complexitySignal = null;

		step(2, "Reloading config", "done");
		const config = loadConfig(ctx.cwd);

		step(3, "Reloading pricing table", "...");
		try {
			const currentModel = ctx.model?.id ?? "deepseek-v4-flash";
			pricingTable = await loadPricing(fluxDir, config.pricing, currentModel);
			step(3, "Reloading pricing table", pricingTable ? "OK" : "fallback");
		} catch (e: any) {
			step(3, "Reloading pricing table", `failed: ${e?.message}`);
		}

		step(4, "Reloading models.json", "...");
		let modelsConfig: any = null;
		try {
			const modelsPath = join(fluxDir, "models.json");
			if (existsSync(modelsPath)) {
				modelsConfig = JSON.parse(readFileSync(modelsPath, "utf-8"));
				step(4, "Reloading models.json", `${Object.keys(modelsConfig.models ?? {}).length} models`);
			} else {
				step(4, "Reloading models.json", "not found, builtins only");
			}
		} catch (e: any) {
			step(4, "Reloading models.json", `failed: ${e?.message}`);
		}
		teamCtx = { cwd: ctx.cwd, fluxDir, telemetry, modelsConfig, sharedSkills: config.sharedSkills, prefixLayout: config.cache.prefix_layout === "static_first", pricing: pricingTable ?? undefined };

		step(5, "Recollecting complexity signal", "...");
		try {
			complexitySignal = collectComplexitySignal(ctx.cwd);
			step(5, "Recollecting complexity signal", `tier${complexitySignal.complexityTier} → ${complexitySignal.recommendedMode}`);
		} catch (e: any) {
			step(5, "Recollecting complexity signal", `failed: ${e?.message}`);
		}

		step(6, "Rebuilding team context", "done");

		step(7, "Re-running router", "...");
		runRouter(ctx);
		step(7, "Re-running router", `${state.mode} (conf ${decision?.confidence.toFixed(2)})`);

		step(8, "Updating footer", "done");
		setFluxStatus(ctx, getState);

		lines.push("");
		lines.push(`Restart complete: mode ${state.mode} · preset ${state.preset} · stage ${state.stage}/${state.role}`);
		lines.push(`Telemetry continuity preserved (${telemetry.path})`);

		return lines.join("\n");
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
		installFooter(ctx, getState, () => routeHint);
		if (ctx.hasUI) ctx.ui.notify(`AgentFlux · ${state.stage}/${state.role} · ${state.preset}→${state.expectedMode} · ${state.mode}`, "info");
		else console.error(`[flux] init · ${state.stage}/${state.role} · ${state.preset}→${state.expectedMode} · mode ${state.mode}`);
	});

	pi.on("turn_end", async (event: any, ctx: any) => {
		state.turnIndex = event.turnIndex ?? state.turnIndex + 1;
		refreshCache(ctx);
		emitSample(ctx);

		// 自维护: 每 5 轮扫描一次错误模式
		if (state.turnIndex > 0 && state.turnIndex % 5 === 0 && telemetry) {
			try {
				const issues = scanRecentIssues(telemetry.path, 20);
				if (issues.length > 0) {
					const issueText = formatIssues(issues);
					// 非侵入式 footer hint (仅当没有 routeHint 时)
					if (!routeHint) {
						routeHint = `⚠ ${issueText}`;
					}
					console.error(`[flux] health: ${issueText}`);
				}
			} catch {}
		}
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
	registerCompactionAdvisor(pi, () => ({ sessionId, telemetry }));

	// ---------- 命令 ----------

	pi.registerTool({
		name: "flux_subagent",
		label: "Flux Subagent",
		description: "Delegate a task to a specialized AgentFlux subagent (e.g. reviewer). 子进程加载前缀布局+cache监控, 跨调用共享 L1。参数: agent (reviewer 或 .agentflux/agents/*.md 定义的), task (任务描述), persistent (可选, 持久 session 可续接), thinking (可选, reasoning effort: off/low/medium/high)",
		parameters: Type.Object({
			agent: Type.String({ description: "subagent 名称, 如 reviewer" }),
			task: Type.String({ description: "任务描述" }),
			persistent: Type.Optional(Type.Boolean({ description: "M2-2: 持久 session, 可跨调用续接 (默认 false)" })),
			thinking: Type.Optional(Type.String({ description: "M2-4: reasoning effort (off/minimal/low/medium/high/xhigh), 默认跟随 agent 定义" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			const agent = loadSubagent(ctx.cwd, params.agent);
			if (!agent) {
				return { content: [{ type: "text", text: `AgentFlux: unknown subagent '${params.agent}'. 可用: reviewer (内建) 或 .agentflux/agents/*.md` }], details: {} };
			}
			const config = loadConfig(ctx.cwd);
			const validThinking = params.thinking && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(params.thinking)
				? params.thinking as any : undefined;
			const r = await runSubagent({
				cwd: ctx.cwd, agent, task: params.task, sessionId,
				telemetry, prefixLayout: config.cache.prefix_layout === "static_first",
				pricing: pricingTable ?? undefined,
				persistent: params.persistent ?? false,
				thinking: validThinking,
			});
			return { content: [{ type: "text", text: formatSubagentResult(r) }], details: {} };
		},
	});

	// ---------- M2-1: 并行 subagent 工具 ----------

	pi.registerTool({
		name: "flux_subagent_parallel",
		label: "Flux Parallel Subagents",
		description: "Launch multiple AgentFlux subagents in parallel (M2-1). Each agent runs as an independent child process. One failure does not affect others. Use for independent tasks like parallel code review of multiple files, or running reviewer + tester simultaneously. Returns combined results with wall-clock vs sum timing and speedup ratio.",
		parameters: Type.Object({
			agents: Type.Array(Type.Object({
				agent: Type.String({ description: "subagent 名称, 如 reviewer" }),
				task: Type.String({ description: "该 agent 的任务描述" }),
				label: Type.Optional(Type.String({ description: "可选标签用于区分结果" })),
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			if (!params.agents || params.agents.length === 0) {
				return { content: [{ type: "text", text: "AgentFlux: no agents specified for parallel execution" }], details: {} };
			}
			if (params.agents.length > 5) {
				return { content: [{ type: "text", text: `AgentFlux: too many parallel agents (${params.agents.length}), max 5` }], details: {} };
			}

			const config = loadConfig(ctx.cwd);
			const tasks: ParallelSubagentTask[] = [];
			const loadErrors: string[] = [];

			for (const a of params.agents) {
				const agent = loadSubagent(ctx.cwd, a.agent);
				if (!agent) {
					loadErrors.push(`unknown subagent '${a.agent}'`);
					continue;
				}
				tasks.push({ agent, task: a.task, label: a.label });
			}

			if (tasks.length === 0) {
				return { content: [{ type: "text", text: `AgentFlux: no valid agents loaded. Errors: ${loadErrors.join("; ")}` }], details: {} };
			}

			console.error(`[flux] parallel subagent: launching ${tasks.length} agents`);
			const result = await runSubagentsParallel(tasks, {
				cwd: ctx.cwd, sessionId, telemetry,
				prefixLayout: config.cache.prefix_layout === "static_first",
				pricing: pricingTable ?? undefined,
			});
			console.error(`[flux] parallel subagent done: wall ${(result.wallClockMs / 1000).toFixed(1)}s, speedup ${result.speedupRatio.toFixed(2)}x`);
			return { content: [{ type: "text", text: formatParallelResults(result) }], details: {} };
		},
	});

	pi.registerCommand("flux", {
		description: "AgentFlux: routing/cache/mode/fork/self-maintenance. subcommands: why | mode <preset> | preference | project | fork | complexity | team | compact | status | health | restart | upgrade",
		handler: async (args: string, ctx: any) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0];

			if (sub === "why") return showInspector(ctx);
			if (sub === "mode") return cmdMode(parts[1] as Preset | undefined, ctx);
			if (sub === "preference") return cmdPreference(ctx);
			if (sub === "project") return cmdProject(ctx);
			if (sub === "fork") {
				const forkArgs = parts.slice(1);
				// M3-1: /flux fork explore <task>
				if (forkArgs[0] === "explore") {
					const exploreTask = forkArgs.slice(1).join(" ");
					const result = await handleForkExploreCommand(exploreTask, ctx, {
						sessionId, telemetry,
						model: ctx.model?.id,
						provider: teamCtx?.modelsConfig?.models?.[ctx.model?.id ?? ""]?.provider,
					});
					if (ctx.hasUI) ctx.ui.notify(result, "info"); else console.log(result);
					return;
				}
				// M3-2/M3-3: /flux fork compare
				if (forkArgs[0] === "compare") {
					const result = await handleForkCompareCommand(ctx, {
						sessionId, telemetry,
						model: ctx.model?.id,
						provider: teamCtx?.modelsConfig?.models?.[ctx.model?.id ?? ""]?.provider,
					});
					if (ctx.hasUI) ctx.ui.notify(result, "info"); else console.log(result);
					return;
				}
				// M3-4: /flux fork prune <branchId|A|B> [reason]
				if (forkArgs[0] === "prune") {
					const result = await handleForkPruneCommand(forkArgs.slice(1), ctx, { sessionId, telemetry });
					if (ctx.hasUI) ctx.ui.notify(result, "info"); else console.log(result);
					return;
				}
				// 原有 fork 命令
				const result = await handleForkCommand(forkArgs, ctx);
				if (ctx.hasUI) ctx.ui.notify(result, "info"); else console.log(result);
				return;
			}
			if (sub === "complexity") return cmdComplexity(ctx);
			if (sub === "team") {
				if (!teamCtx) {
					const msg = "team context not initialized (session_start incomplete?)";
					if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
					return;
				}
				return handleTeamCommand(parts.slice(1), ctx, teamCtx);
			}
			if (sub === "compact") {
				const advice = analyzeCompaction(ctx);
				const text = formatCompactionAdvice(advice);
				if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
				return;
			}

			// ─── 自维护子命令 ───

			if (sub === "status") {
				const vInfo = getVersionInfo(ctx.cwd);
				const healthReport = checkHealth(ctx.cwd, fluxDir);
				const subsystems: SubsystemStatus[] = healthReport.checks.map(c => ({
					name: c.name, healthy: c.status === "ok",
					detail: c.detail,
					path: c.name === "Config" ? join(fluxDir, "agentflux.json")
						: c.name === "Telemetry" ? telemetry?.path
						: undefined,
				}));

				// Read persistent agents
				const activeAgents: AgentInfo[] = [];
				try {
					const regPath = join(fluxDir, "runtime", "persistent-agents.json");
					if (existsSync(regPath)) {
						const reg = JSON.parse(readFileSync(regPath, "utf-8"));
						for (const [name, info] of Object.entries(reg)) {
							const a = info as any;
							activeAgents.push({ name, role: a.role ?? "?", status: a.status ?? "?", model: a.model, callCount: a.callCount, totalCost: a.totalCost });
						}
					}
				} catch {}

				const issues = telemetry ? scanRecentIssues(telemetry.path, 20) : [];
				const text = formatStatusReport(vInfo, {
					mode: state.mode, preset: state.preset, stage: state.stage, role: state.role,
					turnIndex: state.turnIndex, cacheHitRate: state.cache.cacheHitRate,
					costUsd: state.cache.costUsd, branch: state.branch,
				}, subsystems, activeAgents, issues, {
					fluxDir, eventsPath: telemetry?.path ?? "", configPath: join(fluxDir, "agentflux.json"),
				});
				if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
				return;
			}

			if (sub === "health") {
				const report = checkHealth(ctx.cwd, fluxDir);
				const text = formatHealthReport(report);
				if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
				return;
			}

			if (sub === "restart") {
				const text = await performRestart(ctx);
				if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
				return;
			}

			if (sub === "upgrade") {
				const info = checkUpgrade(ctx.cwd);
				const text = formatUpgradeInfo(info);
				if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
				return;
			}

			// No subcommand: show main menu (TUI) or summary (non-TUI)
			if (!sub) {
				const menuState: FluxMenuState = {
					preset: state.preset,
					expectedMode: state.expectedMode,
					mode: state.mode,
					fallback: decision?.fallback ?? "M1",
					stage: state.stage,
					role: state.role,
					reason: decision?.reason ?? [],
					complexitySignal,
					compactionAdvice: analyzeCompaction(ctx),
				};
				const menuCallbacks: FluxMenuCallbacks = {
					onModeChange: (preset: Preset) => {
						runtimePreset = preset;
						runRouter(ctx);
						refreshCache(ctx);
						setFluxStatus(ctx, getState);
					},
					onPreferenceChange: (_pref: PreferenceConfig) => {
						runRouter(ctx);
						refreshCache(ctx);
						setFluxStatus(ctx, getState);
					},
					onTeamCommand: (teamSub: string, task: string) => {
						if (teamCtx) handleTeamCommand([teamSub, task], ctx, teamCtx);
					},
					onReroute: () => {
						runRouter(ctx);
						refreshCache(ctx);
						setFluxStatus(ctx, getState);
					},
				};
				return showFluxMenu(ctx, menuState, menuCallbacks);
			}

			// Default: summary
			refreshCache(ctx);
			const text = buildFluxSummary(state, telemetry.path, state.branch);
			if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
		},
	});

	async function cmdMode(preset: Preset | undefined, ctx: any) {
		if (preset) {
			runtimePreset = preset;
			runRouter(ctx);
			refreshCache(ctx);
			setFluxStatus(ctx, getState);
			const text = `preset -> ${preset}\nmode ${state.mode} (fallback ${decision?.fallback})\nexpected ${state.expectedMode}\nreason: ${decision?.reason.join("; ")}`;
			if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
			return;
		}
		// No arg: TUI opens main menu, non-TUI shows text
		if (ctx.mode !== "tui") {
			const text = `Current preset: ${state.preset}\nOptions: eco | fast | accurate | balanced | custom\nUsage: /flux mode <preset>`;
			if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
			return;
		}
		return showFluxMenu(ctx, makeMenuState(ctx), makeMenuCallbacks(ctx));
	}

	async function cmdPreference(ctx: any) {
		if (ctx.mode !== "tui") {
			const pref = loadPreference(ctx.cwd);
			const v = pref.vector;
			const text = [
				`Preference`,
				`  profile    ${pref.profile} -> expected ${state.expectedMode}`,
				`  vector (0-1)`,
				`  cost_sensitivity        ${v.cost_sensitivity}`,
				`  accuracy_priority       ${v.accuracy_priority}`,
				`  latency_priority        ${v.latency_priority}`,
				`  parallelism_willingness ${v.parallelism_willingness}`,
				`  multi_agent_willingness ${v.multi_agent_willingness}`,
				``,
				`Edit .agentflux/agentflux.json or use TUI for interactive tuner`,
			].join("\n");
			if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
			return;
		}
		return showFluxMenu(ctx, makeMenuState(ctx), makeMenuCallbacks(ctx));
	}

	function cmdProject(ctx: any) {
		const text = [
			`Project Maturity`,
			`  stage    ${state.stage}    role ${state.role}`,
			`  signals  file ${maturitySignals.fileCount}  commit ${maturitySignals.commitCount}  session ${profile?.maturity.signals.session_history ?? 0}`,
			`  baseline_mode  ${profile?.baseline_mode ?? "?"}`,
			`  delegate_impl  ${profile?.role.delegate_impl ?? false}`,
			``,
			`Thresholds: Seed->Growth(50file/20commit) ->Established(300file/100commit) ->Mature`,
			``,
			`profile: ${join(fluxDir, "project-profile.json")}`,
		].join("\n");
		if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
	}

	function cmdComplexity(ctx: any) {
		if (!complexitySignal) {
			const text = "Complexity signal not collected (session_start failed?)";
			if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
			return;
		}
		const text = formatComplexitySignal(complexitySignal);
		if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
	}

	function makeMenuState(ctx: any): FluxMenuState {
		return {
			preset: state.preset,
			expectedMode: state.expectedMode,
			mode: state.mode,
			fallback: decision?.fallback ?? "M1",
			stage: state.stage,
			role: state.role,
			reason: decision?.reason ?? [],
			complexitySignal,
			compactionAdvice: analyzeCompaction(ctx),
		};
	}

	function makeMenuCallbacks(ctx: any): FluxMenuCallbacks {
		return {
			onModeChange: (p: Preset) => { runtimePreset = p; runRouter(ctx); refreshCache(ctx); setFluxStatus(ctx, getState); },
			onPreferenceChange: () => { runRouter(ctx); refreshCache(ctx); setFluxStatus(ctx, getState); },
			onTeamCommand: (s: string, t: string) => { if (teamCtx) handleTeamCommand([s, t], ctx, teamCtx); },
			onReroute: () => { runRouter(ctx); refreshCache(ctx); setFluxStatus(ctx, getState); },
		};
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
					out.push(theme.fg("dim", "  esc / q to close"));
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
