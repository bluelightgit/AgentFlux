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
 *   /flux work <task>                      # MA-5: multi-agent DAG execution (persistent agents + quality gates)
 *   /flux gc [dry-run]                     # archive terminal agent/message/session state
 *   /flux gc legacy [dry-run] <names...>   # archive explicitly named stale pre-identity records
 *   /flux compact                           # compaction advice (B-dimension adaptive)
 *   /flux status                            # full status report (version, mode, subsystems, issues)
 *   /flux health                            # health check (8 subsystem diagnostics)
 *   /flux restart                           # re-initialize (reload config/pricing/models, re-run router)
 *   /flux upgrade                           # check git remote for updates
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

import type { FluxRuntimeState, RoutingDecision, Preset, ProjectProfile, CacheStats, Mode } from "./core/types";
import { loadConfig, loadPreference, savePreference, applyRuntimeOverride, validateConfig, presetToExpectedMode, resolveSharedSkills } from "./core/config";
import { route } from "./core/routing";
import { TelemetryWriter, cacheStatsToSample } from "./telemetry/events";
import { collectCacheStats, fmt, fmtCost, pct } from "./extension/cache-monitor";
import { collectMaturity, loadOrCreateProfile, bumpSessionHistory } from "./extension/maturity";
import { installFooter, setFluxStatus, buildFluxSummary, buildInspectorText } from "./extension/footer";
import { applyPrefixLayout } from "./extension/prefix-layout";
import { applyMask } from "./extension/mask";
import { loadSubagent, withSharedSkills, runSubagent, formatSubagentResult, runSubagentsParallel, formatParallelResults, getActiveSubagentRunIds, type ParallelSubagentTask } from "./extension/subagent";
import { runTeamWithReview, formatTeamWorkflowResult, type TeamTask } from "./extension/team-workflow";
import { SharedBoard, formatGroups, formatGroupMessages, formatAgents } from "./core/shared-board";
import { registerForkMode, handleForkCommand, getForkCandidates } from "./extension/fork-mode";
import { handleForkExploreCommand, handleForkCompareCommand, handleForkPruneCommand } from "./extension/fork-workflow";
import { registerCompactionAdvisor, analyzeCompaction, formatCompactionAdvice } from "./extension/compaction-advisor";
import { handleTeamCommand, type TeamContext } from "./extension/team";
import { collectComplexitySignal, formatComplexitySignal, type TaskComplexitySignal } from "./core/complexity";
import { loadPricing, type PricingTable } from "./core/pricing";
import { discoverPiModels, mergeModels } from "./core/model-capability";
import { showFluxMenu, type FluxMenuState, type FluxMenuCallbacks } from "./extension/flux-menu";
import { handleFluxAgentsCommand, handleFluxBackCommand, getAgentSystemPromptOverride, getActiveAgent, setActiveAgent, saveMainSession, readMainSession, findAgentSessionFile } from "./extension/agent-switcher";
import type { PreferenceConfig } from "./core/types";
import { Type } from "typebox";
import { getVersionInfo, checkHealth, formatHealthReport, scanRecentIssues, checkUpgrade, formatUpgradeInfo, formatStatusReport, formatIssues, type SubsystemStatus, type AgentInfo } from "./extension/health-monitor";
import { generateTaskDAG, executeDAG, formatDAGResult, resolveDAGRoleModel, type DAGExecutionResult } from "./extension/dag-executor";
import { buildTaskRoutePlan, evaluateMainTaskBudget, formatTaskRoutePlan, remainingTaskWallClock, resolveExecutableMode, type MainTaskBudgetState, type TaskRoutePlan } from "./core/execution-plan";
import { formatLifecycleGcReport, runLifecycleGc } from "./core/lifecycle-gc";
import { MessageBus } from "./core/message-bus";
import { assessCacheImpact, diffRuntimeCacheShape, formatCacheImpactWarning, type RuntimeCacheShape } from "./core/cache-impact";
import { loadAllRoles } from "./core/role-manager";
import { RpcInboxPump } from "./extension/rpc-inbox-pump";
import {
	loadRegisteredCapabilityOverride, normalizeRuntimeCapabilityOverride,
	normalizeRuntimeCommunicationOverride, resolveCapabilityPolicy, saveRegisteredCapabilityOverride,
	type CapabilityPolicyInput,
} from "./core/capability-policy";

const EXECUTION_MODES = new Set<Mode>(["M1", "M2", "M3", "M4", "M5", "M6"]);
const DIRECT_WORK_MODES = new Set<Mode>(["M1", "M2", "M5"]);

function parseExecutionMode(value: string | undefined): Mode | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toUpperCase() as Mode;
	return EXECUTION_MODES.has(normalized) ? normalized : undefined;
}

function parseWorkCommand(args: string[]): { task: string; mode?: Mode; error?: string } {
	if (args[0] !== "--mode") return { task: args.join(" ").trim() };
	const mode = parseExecutionMode(args[1]);
	if (!mode || !DIRECT_WORK_MODES.has(mode)) {
		return { task: "", error: "--mode must be one of M1, M2, or M5. M3/M4/M6 remain experimental and use their dedicated commands." };
	}
	return { task: args.slice(2).join(" ").trim(), mode };
}

export default function (pi: ExtensionAPI) {
	const explicitRuntimeMode = parseExecutionMode(process.env.AGENTFLUX_EXECUTION_MODE);
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
	let currentTaskPlan: TaskRoutePlan | null = null;
	let pendingExplicitPlan: TaskRoutePlan | null = null;
	let mainTaskBudgetState: MainTaskBudgetState | null = null;
	let runtimeCacheShape: RuntimeCacheShape | null = null;
	let rpcInboxPump: RpcInboxPump | null = null;
	let rpcRuntimeAgentName: string | null = null;
	let rpcRuntimeInstanceId: string | null = null;
	let runtimeExitPresenceHookInstalled = false;

	function configureRpcInboxPump(ctx: any, config = loadConfig(ctx.cwd)): void {
		rpcInboxPump?.stop();
		rpcInboxPump = null;
		rpcRuntimeAgentName = null;
		rpcRuntimeInstanceId = null;
		const envEnabled = /^(?:1|true|yes)$/i.test(process.env.AGENTFLUX_RPC_INBOX_PUMP ?? "");
		if (!envEnabled && !config.communication.rpc_inbox_pump) return;
		const recipient = process.env.AGENTFLUX_AGENT_NAME || pi.getSessionName?.();
		if (!recipient || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(recipient)) {
			console.error("[flux rpc-inbox] disabled: a valid AGENTFLUX_AGENT_NAME or pi session name is required");
			return;
		}
		const instanceId = process.env.AGENTFLUX_RUNTIME_INSTANCE_ID || `rpc:${sessionId}`;
		try {
			const board = new SharedBoard(fluxDir);
			board.registerRuntimeAgent({
				name: recipient, role: "rpc-runtime", status: "idle",
				model: ctx.model?.id, provider: ctx.model?.provider,
				sessionFile: ctx.sessionManager?.getSessionFile?.(), instanceId,
				runtimePid: process.pid,
			}, { leaseMs: config.communication.runtime_lease_ms });
			board.ensureAllGroup([recipient]);
		} catch (error: any) {
			console.error(`[flux rpc-inbox] disabled: ${error?.message ?? error}`);
			return;
		}
		rpcRuntimeAgentName = recipient;
		rpcRuntimeInstanceId = instanceId;
		if (!runtimeExitPresenceHookInstalled) {
			runtimeExitPresenceHookInstalled = true;
			process.once("exit", code => {
				const name = rpcRuntimeAgentName;
				const owner = rpcRuntimeInstanceId;
				if (!name || !owner) return;
				try { new SharedBoard(fluxDir).finalizeRuntimeAgentPresence(name, owner, code); } catch {}
			});
		}
		rpcInboxPump = new RpcInboxPump({
			fluxDir, recipient,
			pollIntervalMs: config.communication.poll_interval_ms,
			batchSize: config.communication.batch_size,
			heartbeatIntervalMs: config.communication.heartbeat_interval_ms,
			redeliveryAfterMs: config.communication.redelivery_after_ms,
			isIdle: () => ctx.isIdle?.() ?? true,
			sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
			onAudit: event => {
				for (const messageId of event.messageIds) telemetry?.writeMessageProtocol({
					sessionId, runId: instanceId, action: event.action, agent: recipient,
					instanceId, messageId, result: event.result,
					detail: [event.mode ? `mode=${event.mode}` : "", event.detail ?? ""].filter(Boolean).join("; ") || undefined,
				});
			},
			onHeartbeat: now => {
				const updated = new SharedBoard(fluxDir).updateAgentPresence(
					recipient, { heartbeatAt: now.toISOString(), runtimePid: process.pid }, instanceId,
				);
				if (!updated) throw new Error(`runtime lease lost for ${recipient}`);
			},
		});
		// session_start is still initializing pi's AgentSession. An immediate
		// extension-originated prompt can be accepted by the bridge before the RPC
		// session is ready to start a turn. Let the first interval run after the
		// hook has returned; explicit restart remains safe with the same behavior.
		rpcInboxPump.start({ immediate: false });
		console.error(`[flux rpc-inbox] started recipient=${recipient} interval=${config.communication.poll_interval_ms}ms batch=${config.communication.batch_size}`);
	}
	const activeRuns = new Map<string, { controller: AbortController; startedAt: number; task: string }>();

	const getState = () => state;
	const stableStringify = (value: unknown): string => JSON.stringify(value, (_key, current) => {
		if (!current || typeof current !== "object" || Array.isArray(current)) return current;
		return Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
	});
	const buildRuntimeCacheShape = (cwd: string, modelsConfig: any, sharedSkills: string[]): RuntimeCacheShape => {
		const roles = [...loadAllRoles(cwd, modelsConfig).entries()].sort(([a], [b]) => a.localeCompare(b));
		return {
			toolSchema: stableStringify(roles.map(([name, role]) => [name, role.tools ?? [], role.communication ?? null])),
			skillSet: stableStringify(roles.map(([name, role]) => [name, [...new Set([...sharedSkills, ...(role.skills ?? [])])].sort()])),
			mcpSet: stableStringify(modelsConfig?.mcp ?? modelsConfig?.mcpServers ?? {}),
			systemPrompts: stableStringify(roles.map(([name, role]) => [name, role.systemPrompt ?? ""])),
			modelAssignments: stableStringify(roles.map(([name, role]) => [name, role.model ?? role.requirement ?? null])),
		};
	};

	// 上一 turn 的累计值, 用于计算增量 (避免 telemetry 聚合时重复计算)
	let prevCumulative: CacheStats | null = null;

	function refreshCache(ctx: any) {
		state.cache = collectCacheStats(ctx, pricingTable ?? undefined);
	}

	function emitSample(ctx: any) {
		// state.cache 是累计值 (从 getBranch 全量累加)
		// telemetry 需要记录增量 (per-turn delta), 避免聚合时重复计算
		const cumulative = state.cache;
		let delta: CacheStats;
		if (prevCumulative) {
			delta = {
				input: Math.max(0, cumulative.input - prevCumulative.input),
				output: Math.max(0, cumulative.output - prevCumulative.output),
				cacheRead: Math.max(0, cumulative.cacheRead - prevCumulative.cacheRead),
				cacheWrite: Math.max(0, cumulative.cacheWrite - prevCumulative.cacheWrite),
				costUsd: Math.max(0, cumulative.costUsd - prevCumulative.costUsd),
				contextTokens: cumulative.contextTokens,
				contextWindow: cumulative.contextWindow,
				contextPercent: cumulative.contextPercent,
				cacheHitRate: cumulative.cacheHitRate,
			};
		} else {
			delta = { ...cumulative };
		}
		prevCumulative = { ...cumulative };

		telemetry.writeCacheSample(cacheStatsToSample(delta, {
			turnIndex: state.turnIndex, model: ctx.model?.id ?? null,
			mode: state.mode, stage: state.stage, role: state.role, preset: state.preset, sessionId,
		}));
		// 仅非 TUI 模式 stderr 实时观测 (TUI 模式用 footer, 避免 stderr 干扰渲染)
		if (!ctx.hasUI) {
			console.error(
				`[flux] turn ${state.turnIndex} | in ${fmt(delta.input)} read ${fmt(delta.cacheRead)} ` +
				`write ${fmt(delta.cacheWrite)} hit ${(delta.cacheHitRate * 100).toFixed(0)}% | ` +
				`ctx ${pct(delta.contextPercent)} | ${fmtCost(delta.costUsd)} | ` +
				`${state.mode} · ${state.stage}/${state.role} · ${state.preset}→${state.expectedMode}`,
			);
		}
	}

	function runRouter(ctx: any, taskText?: string): TaskRoutePlan | null {
		const config = loadConfig(ctx.cwd);
		let pref = loadPreference(ctx.cwd);
		const ov = applyRuntimeOverride(config, pref, runtimePreset);
		state.preset = ov.config.mode;
		pref = ov.pref;

		if (taskText?.trim()) {
			currentTaskPlan = buildTaskRoutePlan({ cwd: ctx.cwd, task: taskText, stage: state.stage, config: ov.config, pref, requestedMode: explicitRuntimeMode });
			decision = currentTaskPlan.decision;
			if (!currentTaskPlan.requiresConfirmation) state.mode = currentTaskPlan.effectiveMode;
			if (currentTaskPlan.fallbackReason) decision.reason.push(`capability:${currentTaskPlan.fallbackReason}`);
		} else {
			currentTaskPlan = null;
			decision = route({
				stage: state.stage, pref, preset: state.preset,
				taskSignal: complexitySignal ?? undefined,
				overrideMode: ov.config.routing.override_mode,
			});
			const requestedMode = explicitRuntimeMode ?? decision.mode;
			const resolved = resolveExecutableMode(requestedMode);
			state.mode = resolved.effectiveMode;
			if (explicitRuntimeMode) decision.reason.push(`explicit-mode:${explicitRuntimeMode}`);
			if (resolved.fallbackReason) decision.reason.push(`capability:${resolved.fallbackReason}`);
		}
		state.expectedMode = decision.biasSources.preference ?? state.mode;

		// 校验 warnings → reason
		const warnings = validateConfig(config);
		for (const w of warnings) decision.reason.push(`warn:${w}`);

		// F2-10: override_mode suggest — non-intrusive footer hint (no popup)
		if (explicitRuntimeMode) {
			const recommended = resolveExecutableMode(decision.mode).effectiveMode;
			routeHint = `user fixed ${explicitRuntimeMode}${explicitRuntimeMode === state.mode ? "" : `→${state.mode}`} | router suggests ${decision.mode}${decision.mode === recommended ? "" : `→${recommended}`}`;
		} else if (config.routing.override_mode === "suggest" && decision.confidence >= 0.7) {
			const expected = presetToExpectedMode(state.preset);
			if (state.mode !== expected) {
			routeHint = `router suggests ${decision.mode}${decision.mode === state.mode ? "" : `→${state.mode}`} (${(decision.confidence*100).toFixed(0)}%) | preset ${state.preset} expects ${expected}`;
			if (!ctx.hasUI) console.error(`[flux] route hint: ${routeHint}`);
			} else {
			routeHint = null;
			}
		}

		telemetry.writeRoutingDecision({
			sessionId, mode: state.mode, preset: state.preset, stage: state.stage, role: state.role,
			reason: decision.reason, confidence: decision.confidence, fallback: decision.fallback,
			biasSources: decision.biasSources, expected: decision.expected,
			taskId: currentTaskPlan?.taskId,
			decisionId: currentTaskPlan?.decisionId,
			taskType: currentTaskPlan?.signal.classification.type,
			complexityTier: currentTaskPlan?.signal.complexity.tier,
			fileCount: currentTaskPlan?.signal.complexity.fileCount,
			diffLines: currentTaskPlan?.signal.scope.diffLines,
			actualMode: currentTaskPlan && !currentTaskPlan.requiresConfirmation
				? currentTaskPlan.effectiveMode
				: explicitRuntimeMode ? state.mode : undefined,
			overrideMode: config.routing.override_mode,
			applied: decision.applied,
		});
		return currentTaskPlan;
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
		prevCumulative = null;
		decision = null; routeHint = null; pricingTable = null; complexitySignal = null;

		step(2, "Reloading config", "done");
		const config = loadConfig(ctx.cwd);
		configureRpcInboxPump(ctx, config);

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
			// pi 模型自动发现
			const piModels = discoverPiModels();
			if (Object.keys(piModels).length > 0) {
				modelsConfig = modelsConfig ?? { models: {}, roles: {} };
				modelsConfig.models = mergeModels(modelsConfig.models ?? {}, piModels);
			}
		} catch (e: any) {
			step(4, "Reloading models.json", `failed: ${e?.message}`);
		}
		const sharedSkills = resolveSharedSkills(config, modelsConfig);
		teamCtx = { cwd: ctx.cwd, fluxDir, telemetry, modelsConfig, sharedSkills, prefixLayout: config.cache.prefix_layout === "static_first", pricing: pricingTable ?? undefined };
		const nextCacheShape = buildRuntimeCacheShape(ctx.cwd, modelsConfig, sharedSkills);
		if (runtimeCacheShape) {
			const pref = applyRuntimeOverride(config, loadPreference(ctx.cwd), runtimePreset).pref;
			for (const change of diffRuntimeCacheShape(runtimeCacheShape, nextCacheShape)) {
				const warning = formatCacheImpactWarning(assessCacheImpact(change, pref));
				if (warning) lines.push("", warning);
			}
		}
		runtimeCacheShape = nextCacheShape;
		if (config.retention.enabled) {
			try {
				const gcReport = runLifecycleGc(fluxDir, config.retention, { activeRunIds: getActiveSubagentRunIds() });
				const changed = Object.values(gcReport.removed).reduce((sum, items) => sum + items.length, 0);
				if (!ctx.hasUI && (changed > 0 || gcReport.blockedReason || gcReport.warnings.length > 0)) {
					console.error(`[flux] ${formatLifecycleGcReport(gcReport)}`);
				}
			} catch (error: any) {
				if (!ctx.hasUI) console.error(`[flux] lifecycle GC failed closed: ${error?.message ?? error}`);
			}
		}

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
		step(7, "Re-running router", `${state.mode} (conf ${(decision as RoutingDecision | null)?.confidence.toFixed(2) ?? "n/a"})`);

		step(8, "Refreshing cache stats", "...");
		refreshCache(ctx);
		step(8, "Refreshing cache stats", `hit ${(state.cache.cacheHitRate * 100).toFixed(0)}% | ctx ${pct(state.cache.contextPercent)} | ${fmtCost(state.cache.costUsd)}`);

		step(9, "Updating footer", "done");
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
			if (!ctx.hasUI) console.error(`[flux pricing] load failed: ${e?.message}, cost 将回退上游 cost.total`);
		}

		// Phase 2: 收集复杂度信号 (RGAO 静态分析)
		try {
			complexitySignal = collectComplexitySignal(ctx.cwd);
			if (!ctx.hasUI) console.error(`[flux] complexity: tier${complexitySignal.complexityTier} → ${complexitySignal.recommendedMode} (${complexitySignal.reason.join("; ")})`);
		} catch (e: any) {
			if (!ctx.hasUI) console.error(`[flux] complexity analysis failed: ${e?.message}`);
		}

		// Phase 2: 加载 models.json (模型 + 角色定义) + pi 模型自动发现
		let modelsConfig: any = null;
		try {
			const modelsPath = join(fluxDir, "models.json");
			if (existsSync(modelsPath)) {
				modelsConfig = JSON.parse(readFileSync(modelsPath, "utf-8"));
				if (!ctx.hasUI) console.error(`[flux] models.json loaded: ${Object.keys(modelsConfig.models ?? {}).length} models, ${Object.keys(modelsConfig.roles ?? {}).length} roles`);
			}
			// pi 模型自动发现: 合并 pi 的可用模型到 AgentFlux 模型表
			const piModels = discoverPiModels();
			if (Object.keys(piModels).length > 0) {
				const agentFluxModels = modelsConfig?.models ?? {};
				modelsConfig = modelsConfig ?? { models: {}, roles: {} };
				modelsConfig.models = mergeModels(agentFluxModels, piModels);
				if (!ctx.hasUI) console.error(`[flux] pi models discovered: ${Object.keys(piModels).length} total, merged → ${Object.keys(modelsConfig.models).length} models`);
			}
		} catch (e: any) {
			if (!ctx.hasUI) console.error(`[flux] models.json load failed: ${e?.message}`);
		}
		const sharedSkills = resolveSharedSkills(config, modelsConfig);
		teamCtx = { cwd: ctx.cwd, fluxDir, telemetry, modelsConfig, sharedSkills, prefixLayout: config.cache.prefix_layout === "static_first", pricing: pricingTable ?? undefined };
		runtimeCacheShape = buildRuntimeCacheShape(ctx.cwd, modelsConfig, sharedSkills);

		runRouter(ctx);
		refreshCache(ctx);
		setFluxStatus(ctx, getState);
		installFooter(ctx, getState, () => routeHint);
		if (ctx.hasUI) ctx.ui.notify(`AgentFlux · ${state.stage}/${state.role} · ${state.preset}→${state.expectedMode} · ${state.mode}`, "info");
		else console.error(`[flux] init · ${state.stage}/${state.role} · ${state.preset}→${state.expectedMode} · mode ${state.mode}`);
		configureRpcInboxPump(ctx, config);
	});

	pi.on("agent_start", async () => {
		rpcInboxPump?.onAgentStart();
		if (rpcRuntimeAgentName) {
			try { new SharedBoard(fluxDir).updateAgentPresence(rpcRuntimeAgentName, { status: "running" }, rpcRuntimeInstanceId ?? undefined); } catch {}
		}
	});

	pi.on("message_end", async (event: any) => {
		const message = event?.message;
		if (message?.role !== "assistant") return;
		const aborted = message.stopReason === "aborted";
		const success = !message.errorMessage && message.stopReason !== "error" && !aborted;
		rpcInboxPump?.onAssistantMessageEnd(success);
		if (rpcRuntimeAgentName) {
			try { new SharedBoard(fluxDir).updateAgentPresence(rpcRuntimeAgentName, { status: success ? "idle" : aborted ? "cancelled" : "failed" }, rpcRuntimeInstanceId ?? undefined); } catch {}
		}
	});

	pi.on("turn_end", async (event: any, ctx: any) => {
		state.turnIndex = event.turnIndex ?? state.turnIndex + 1;
		refreshCache(ctx);
		emitSample(ctx);

		// override.json: 外部控制面 (如 Desktop) 可写入运行时覆盖
		try {
			const overridePath = join(fluxDir, "runtime", "override.json");
			if (existsSync(overridePath)) {
				const ov = JSON.parse(readFileSync(overridePath, "utf-8"));
				if (ov.preset && ov.preset !== state.preset) {
					runtimePreset = ov.preset;
					runRouter(ctx);
					refreshCache(ctx);
					if (ctx.hasUI) ctx.ui.notify(`AgentFlux: override applied → preset ${ov.preset} → mode ${state.mode}`, "info");
					else console.error(`[flux] override: preset ${ov.preset} → mode ${state.mode}`);
				}
				// override 可以指定强制模式
				if (ov.forceMode && ov.forceMode !== state.mode) {
					state.mode = ov.forceMode;
					if (ctx.hasUI) ctx.ui.notify(`AgentFlux: override forced mode ${ov.forceMode}`, "info");
				}
				// 一次性覆盖: 读后删除
				if (ov.ephemeral !== false) {
					try { unlinkSync(overridePath); } catch {}
				}
			}
		} catch {}

		// agent-switch-request.json: Desktop 可请求切换到指定 agent session
		try {
			const switchReqPath = join(fluxDir, "runtime", "agent-switch-request.json");
			if (existsSync(switchReqPath)) {
				const req = JSON.parse(readFileSync(switchReqPath, "utf-8"));
				try { unlinkSync(switchReqPath); } catch {}
				if (req.target === "main") {
					const mainSession = readMainSession(ctx.cwd);
					if (mainSession && existsSync(mainSession)) {
						setActiveAgent(ctx.cwd, null);
						await ctx.switchSession(mainSession, {
							withSession: async (c: any) => { if (c.hasUI) c.ui.notify("Returned to main agent", "info"); },
						});
					}
				} else if (req.target) {
					const sessionFile = findAgentSessionFile(ctx.cwd, req.target);
					if (sessionFile) {
						const currentSession = ctx.sessionManager?.getSessionFile?.();
						if (currentSession && !getActiveAgent(ctx.cwd)) saveMainSession(ctx.cwd, currentSession);
						setActiveAgent(ctx.cwd, req.target);
						await ctx.switchSession(sessionFile, {
							withSession: async (c: any) => { if (c.hasUI) c.ui.notify(`Switched to agent "${req.target}". Type /flux-back to return.`, "info"); },
						});
					}
				}
			}
		} catch {}

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
					if (!ctx.hasUI) console.error(`[flux] health: ${issueText}`);

					// 自动修复: 针对可自动处理的问题
					for (const iss of issues) {
						if (iss.category === "low_cache") {
							// cache 命中率低 → 重新加载 pricing 确保 cache 统计准确
							try {
								const config = loadConfig(ctx.cwd);
								if (!pricingTable) {
									pricingTable = await loadPricing(fluxDir, config.pricing, ctx.model?.id ?? "deepseek-v4-flash");
									refreshCache(ctx);
									if (!ctx.hasUI) console.error(`[flux] auto-fix: reloaded pricing table for accurate cache stats`);
								}
							} catch {}
						}
						if (iss.category === "high_context") {
							// 上下文 > 85% → 提示用户 /flux compact
							routeHint = `⚠ ctx ${pct(state.cache.contextPercent)} → consider /flux compact or /flux fork`;
						}
						if (iss.category === "subagent_failure") {
							// subagent 频繁失败 → 提示检查模型配置
							routeHint = `⚠ subagent failures detected → check .agentflux/models.json + /flux health`;
						}
					}
				}
			} catch {}
		}
	});

	pi.on("agent_end", async (_event, ctx: any) => {
		refreshCache(ctx);
		emitSample(ctx);
		if (profile) bumpSessionHistory(ctx.cwd, profile);
		// Do not clear the task budget here. `/flux work` queues a second user
		// turn from inside the slash-command lifecycle, and the outer command's
		// agent_end can arrive while that queued turn is still active. The next
		// before_agent_start replaces this state atomically for the next plan;
		// turn_start also requires an exact taskId match.
	});

	pi.on("session_shutdown", async () => {
		rpcInboxPump?.stop();
		rpcInboxPump = null;
		if (rpcRuntimeAgentName) {
			try {
				if (rpcRuntimeInstanceId) new SharedBoard(fluxDir).finalizeRuntimeAgentPresence(rpcRuntimeAgentName, rpcRuntimeInstanceId, 0);
			} catch {}
		}
		rpcRuntimeAgentName = null;
		rpcRuntimeInstanceId = null;
		for (const [, run] of activeRuns) run.controller.abort("AgentFlux session shutdown");
		activeRuns.clear();
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

	// ---------- before_agent_start: agent role prompt injection ----------

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const plan = pendingExplicitPlan?.task === event.prompt
			? pendingExplicitPlan
			: runRouter(ctx, event.prompt);
		const explicitlyApplied = pendingExplicitPlan?.task === event.prompt;
		if (explicitlyApplied) pendingExplicitPlan = null;
		if (plan && (explicitlyApplied || !plan.requiresConfirmation)) {
			state.mode = plan.effectiveMode;
			if (plan.executor !== "dag") {
				mainTaskBudgetState = { taskId: plan.taskId, startedAt: Date.now(), iterationsStarted: 0 };
			}
			setFluxStatus(ctx, getState);
		}
		const rolePrompt = getAgentSystemPromptOverride(ctx.cwd);
		const routingPrompt = plan ? [
			"=== AgentFlux task execution plan ===",
			formatTaskRoutePlan(plan),
			plan.blockedReason
				? `Do not execute this task: ${plan.blockedReason}. Explain the configuration problem.`
				: plan.effectiveMode === "M2" && (explicitlyApplied || !plan.requiresConfirmation)
					? "Apply M2: the main agent owns implementation and final verification; delegate only bounded independent research/review/test work through flux_subagent or flux_subagent_parallel. Do not delegate overlapping file edits. If a delegation fails, choose exactly one bounded recovery: continue directly, select a healthy provider once, or stop and report. Do not repeat failed delegation or tool calls without a new plan and observable progress."
					: plan.effectiveMode === "M5" && (explicitlyApplied || !plan.requiresConfirmation)
						? "Apply M5: call flux_execute_plan exactly once with the user's task before editing; use its DAG artifacts and report the verified outcome. Do not duplicate the DAG's file edits in parallel."
						: plan.effectiveMode === "M1"
							? "Apply M1: execute directly in the main agent and verify the result."
							: "This is a route suggestion only. Do not launch a different executor without user confirmation; explain the suggested plan if it materially changes the work.",
			"=== End AgentFlux task execution plan ===",
		].join("\n") : "";
		const additions = [rolePrompt, routingPrompt].filter(Boolean);
		if (additions.length === 0) return undefined;
		return { systemPrompt: event.systemPrompt + "\n\n" + additions.join("\n\n") };
	});

	// M1/M2 的 provider-turn 与墙钟预算在下一 turn 开始前硬停止。
	// M5 由 DAG executor 自己控制节点/attempt 预算。
	pi.on("turn_start", async (_event: any, ctx: any) => {
		if (!currentTaskPlan || currentTaskPlan.executor === "dag" || !mainTaskBudgetState) return;
		if (mainTaskBudgetState.taskId !== currentTaskPlan.taskId) return;
		const evaluated = evaluateMainTaskBudget(currentTaskPlan, mainTaskBudgetState);
		mainTaskBudgetState = evaluated.nextState;
		if (evaluated.allowed) return;
		const detail = evaluated.reason === "max_iterations"
			? `${currentTaskPlan.budget.maxIterations} provider turns`
			: `${Math.round(currentTaskPlan.budget.maxWallClockMs / 1000)}s wall clock`;
		routeHint = `BLOCKED task budget exhausted: ${evaluated.reason} (${detail})`;
		console.error(`[flux] ${routeHint}`);
		ctx.abort();
	});

	// ---------- M3 fork 事件 (Phase 2) ----------

	registerForkMode(pi, () => ({ sessionId, telemetry }));
	registerCompactionAdvisor(pi, () => ({ sessionId, telemetry }));

	// ---------- 命令 ----------

	async function dispatchDagPlan(plan: TaskRoutePlan, ctx: any, signal?: AbortSignal): Promise<DAGExecutionResult> {
		if (!teamCtx) throw new Error("team context not initialized");
		if (plan.blockedReason) throw new Error(plan.blockedReason);
		if (plan.executor !== "dag") throw new Error(`plan ${plan.effectiveMode} uses ${plan.executor}, not DAG`);
		const startedAt = Date.now();
		const plannerBudget = plan.budget.maxCostUsd;
		const plannerRuntime = resolveDAGRoleModel(ctx.cwd, teamCtx.modelsConfig, "planner");
		const dag = await generateTaskDAG(plan.task, {
			cwd: ctx.cwd,
			model: plannerRuntime.model,
			provider: plannerRuntime.provider,
			thinking: plannerRuntime.thinking,
			models: teamCtx.modelsConfig?.models,
			pricing: teamCtx.pricing,
			telemetry,
			sessionId,
			prefixLayout: teamCtx.prefixLayout,
			signal,
			maxCostUsd: plannerBudget,
			taskId: plan.taskId,
			// planner 可能需要完成 provider 降级；保留任务总 deadline，避免隐藏的 120s 截断。
			timeoutMs: Math.min(240_000, plan.budget.maxWallClockMs),
		});
		const elapsed = Date.now() - startedAt;
		const remainingWallClock = remainingTaskWallClock(plan.budget.maxWallClockMs, elapsed);
		return executeDAG(dag, {
			cwd: ctx.cwd,
			fluxDir,
			modelsConfig: teamCtx.modelsConfig,
			telemetry,
			prefixLayout: teamCtx.prefixLayout,
			pricing: teamCtx.pricing,
			sessionId,
			sharedSkills: teamCtx.sharedSkills,
			persistent: true,
			enableQualityGate: true,
			maxRetries: Math.max(0, Math.min(2, plan.budget.maxIterations - 1)),
			// 节点共享任务总 deadline；不要用隐藏的 300s 上限截断用户配置的墙钟预算。
			timeoutMs: remainingWallClock,
			maxWallClockMs: remainingWallClock,
			// max_iterations 约束 retry/feedback，不应截断一个合法的 N 节点 DAG。
			maxIterations: dag.nodes.length + plan.budget.maxIterations,
			maxCostUsd: plan.budget.maxCostUsd,
			maxParallel: 3,
			signal,
			executionId: plan.taskId,
			taskId: plan.taskId,
		});
	}

	pi.registerTool({
		name: "flux_execute_plan",
		label: "Flux Execute Routed Plan",
		description: "Execute a task through AgentFlux's unified Task→RoutePlan→M5 DAG path. Use only when the injected AgentFlux task plan selects M5. Enforces cancellation, wall-clock/iteration limits, step budget stops, quality gates, checkpoints, and artifacts.",
		parameters: Type.Object({ task: Type.String({ description: "The exact user task to execute" }) }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx: any) {
			const config = loadConfig(ctx.cwd);
			const pref = applyRuntimeOverride(config, loadPreference(ctx.cwd), runtimePreset).pref;
			const plan = currentTaskPlan?.task === params.task
				? currentTaskPlan
				: buildTaskRoutePlan({ cwd: ctx.cwd, task: params.task, stage: state.stage, config, pref });
			if (plan.executor !== "dag") {
				return { content: [{ type: "text", text: `${formatTaskRoutePlan(plan)}\n\nThis plan stays in the main agent; no DAG was launched.` }], details: { plan } };
			}
			const result = await dispatchDagPlan(plan, ctx, signal);
			return { content: [{ type: "text", text: `${formatTaskRoutePlan(plan)}\n\n${formatDAGResult(result)}` }], details: { plan, executionId: result.executionId, artifactPaths: result.artifactPaths } };
		},
	});

	pi.registerTool({
		name: "flux_message_v2",
		label: "Flux Message V2",
		description: "Leader-side Message/Delivery V2 operations. send creates per-recipient deliveries with dedupe/backpressure; poll marks selected messages delivered; ack confirms processing. Subagents use the separate identity-bound flux_agent_message tool.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("send"), Type.Literal("poll"), Type.Literal("ack"), Type.Literal("status")]),
			sender: Type.Optional(Type.String({ description: "Leader-authorized sender identity; default main" })),
			target: Type.Optional(Type.String({ description: "Direct agent, broadcast, or group:<groupId>; for poll/ack this is recipient" })),
			messageType: Type.Optional(Type.String()),
			content: Type.Optional(Type.String()),
			messageId: Type.Optional(Type.String()),
			dedupeKey: Type.Optional(Type.String()),
			correlationId: Type.Optional(Type.String()),
			taskId: Type.Optional(Type.String()),
			priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("critical")])),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			const bus = new MessageBus(join(ctx.cwd, ".agentflux"));
			const sender = params.sender ?? "main";
			if (params.action === "send") {
				if (!params.target || !params.content) throw new Error("send requires target and content");
				const metadata = {
					dedupeKey: params.dedupeKey, correlationId: params.correlationId,
					taskId: params.taskId, priority: params.priority,
				};
				const result = params.target === "broadcast"
					? bus.sendBroadcast(sender, params.messageType ?? "message", params.content, metadata)
					: params.target.startsWith("group:")
						? bus.sendGroup(sender, params.target.slice("group:".length), params.messageType ?? "message", params.content, metadata)
						: bus.sendDirect(sender, params.target, params.messageType ?? "message", params.content, metadata);
				return { content: [{ type: "text", text: `Message ${result.envelope.id}: recipients=${result.deliveries.length}, deduplicated=${result.deduplicated}` }], details: result };
			}
			const recipient = params.target ?? sender;
			if (params.action === "poll") {
				const messages = bus.poll(recipient);
				const text = messages.length === 0 ? "No pending V2 messages." : messages.map(item =>
					`${item.envelope.id} [${item.envelope.priority}] ${item.envelope.from}: ${item.envelope.content}`).join("\n");
				return { content: [{ type: "text", text }], details: { messages } };
			}
			if (params.action === "ack") {
				if (!params.messageId) throw new Error("ack requires messageId");
				const delivery = bus.acknowledge(recipient, params.messageId);
				return { content: [{ type: "text", text: `Acknowledged ${params.messageId} for ${recipient}` }], details: { delivery } };
			}
			const delivery = params.messageId ? bus.getDelivery(params.messageId, recipient) : null;
			const status = delivery ?? { recipient, outstanding: bus.countOutstanding(recipient), cursor: bus.getCursor(recipient) };
			return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: status };
		},
	});

	pi.registerTool({
		name: "flux_capability_policy",
		label: "Flux Capability Policy",
		description: "Inspect or persist a registered-agent capability override. Overrides may only narrow the role template. Returns effective policy, provenance, revision, and cache-impact warnings.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
			agent: Type.String(),
			role: Type.String(),
			expectedRevision: Type.Optional(Type.Number({ minimum: 0 })),
			override: Type.Optional(Type.Object({
				tools: Type.Optional(Type.Array(Type.String())),
				skills: Type.Optional(Type.Array(Type.String())),
				mcpServers: Type.Optional(Type.Array(Type.String())),
				communication: Type.Optional(Type.Object({
					enabled: Type.Optional(Type.Boolean()),
					actions: Type.Optional(Type.Array(Type.Union([Type.Literal("send"), Type.Literal("poll"), Type.Literal("ack"), Type.Literal("status")]))),
					allowedTargets: Type.Optional(Type.Array(Type.String())),
					requiredSendTo: Type.Optional(Type.Array(Type.String())),
					requireExplicitInboxAck: Type.Optional(Type.Boolean()),
					maxMessagesPerRun: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
				})),
				workspace: Type.Optional(Type.Object({
					roots: Type.Optional(Type.Array(Type.String())),
					deniedPaths: Type.Optional(Type.Array(Type.String())),
					blockDangerousCommands: Type.Optional(Type.Boolean()),
				})),
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			const roles = loadAllRoles(ctx.cwd, teamCtx?.modelsConfig);
			const role = roles.get(params.role);
			if (!role) throw new Error(`Unknown role template: ${params.role}`);
			const template: CapabilityPolicyInput = {
				tools: role.tools,
				skills: [...new Set([...(teamCtx?.sharedSkills ?? []), ...(role.skills ?? [])])],
				mcpServers: role.mcpServers,
				communication: role.communication,
				workspace: role.workspace,
			};
			let record = loadRegisteredCapabilityOverride(join(ctx.cwd, ".agentflux"), params.agent);
			if (params.action === "set") {
				if (!params.override) throw new Error("set requires override");
				// Validate the complete effective policy before persisting anything.
				resolveCapabilityPolicy({
					cwd: ctx.cwd, agentName: params.agent, role: params.role, runId: "policy-preview",
					template, registered: params.override,
				});
				record = saveRegisteredCapabilityOverride({
					fluxDir: join(ctx.cwd, ".agentflux"), agentName: params.agent, role: params.role,
					override: params.override, expectedRevision: params.expectedRevision,
				});
				telemetry?.writeCapabilityPolicy({
					sessionId, runId: `policy:${params.agent}:${record.revision}`,
					agent: params.agent, role: params.role, action: "set", result: "success",
					revision: record.revision,
					detail: `registered capability override revision ${record.revision}`,
				});
			}
			const effective = resolveCapabilityPolicy({
				cwd: ctx.cwd, agentName: params.agent, role: params.role, runId: "policy-preview",
				template, registered: record?.override,
			});
			const pref = applyRuntimeOverride(loadConfig(ctx.cwd), loadPreference(ctx.cwd), runtimePreset).pref;
			const changes = [
				record?.override.tools ? "tool_schema" : null,
				record?.override.skills ? "skill_set" : null,
				record?.override.mcpServers ? "mcp_set" : null,
				record?.override.communication || record?.override.workspace ? "runtime_policy_guard" : null,
			].filter((item): item is "tool_schema" | "skill_set" | "mcp_set" | "runtime_policy_guard" => !!item);
			const cacheImpact = changes.map(change => assessCacheImpact(change, pref));
			const text = [
				`Capability policy ${params.agent} (${params.role}) revision=${record?.revision ?? 0}`,
				JSON.stringify(effective, null, 2),
				...cacheImpact.map(item => formatCacheImpactWarning(item)).filter(Boolean) as string[],
			].join("\n\n");
			return { content: [{ type: "text", text }], details: { record, effective, cacheImpact } };
		},
	});

	pi.registerTool({
		name: "flux_subagent",
		label: "Flux Subagent",
		description: "Delegate a task to a specialized AgentFlux subagent (e.g. reviewer). 子进程加载前缀布局+cache监控, 跨调用共享 L1。参数: agent (reviewer 或 .agentflux/agents/*.md 定义的), task (任务描述), persistent (可选, 持久 session 可续接), thinking (可选, reasoning effort: off/low/medium/high)",
		parameters: Type.Object({
			agent: Type.String({ description: "subagent 名称, 如 reviewer" }),
			task: Type.String({ description: "任务描述" }),
			persistent: Type.Optional(Type.Boolean({ description: "M2-2: 持久 session, 可跨调用续接 (默认 false)" })),
			thinking: Type.Optional(Type.String({ description: "M2-4: reasoning effort (off/minimal/low/medium/high/xhigh), 默认跟随 agent 定义" })),
			timeoutSeconds: Type.Optional(Type.Number({ minimum: 30, maximum: 900, description: "本次子 Agent 总时限；默认 min(180s, 任务墙钟上限)" })),
			lockFiles: Type.Optional(Type.Array(Type.String(), { description: "该 agent 将编辑的文件路径列表, 用于文件锁防并行冲突" })),
			communication: Type.Optional(Type.Object({
				disable: Type.Optional(Type.Boolean({ description: "Explicitly disable messaging for this run. Empty/default objects are ignored." })),
				enabled: Type.Optional(Type.Boolean()),
				actions: Type.Optional(Type.Array(Type.Union([Type.Literal("send"), Type.Literal("poll"), Type.Literal("ack"), Type.Literal("status")]))),
				allowedTargets: Type.Optional(Type.Array(Type.String())),
				requiredSendTo: Type.Optional(Type.Array(Type.String())),
				requireExplicitInboxAck: Type.Optional(Type.Boolean()),
				maxMessagesPerRun: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
			}, { description: "单次运行的通信策略覆盖；在角色模板默认值之上生效" })),
			capabilities: Type.Optional(Type.Object({
				denyAllTools: Type.Optional(Type.Boolean({ description: "Explicitly remove every tool. tools: [] alone is treated as omitted." })),
				denyAllSkills: Type.Optional(Type.Boolean({ description: "Explicitly remove every skill. skills: [] alone is treated as omitted." })),
				denyAllMcpServers: Type.Optional(Type.Boolean({ description: "Explicitly remove every MCP server. mcpServers: [] alone is treated as omitted." })),
				tools: Type.Optional(Type.Array(Type.String())),
				skills: Type.Optional(Type.Array(Type.String())),
				mcpServers: Type.Optional(Type.Array(Type.String())),
				workspace: Type.Optional(Type.Object({
					roots: Type.Optional(Type.Array(Type.String())),
					deniedPaths: Type.Optional(Type.Array(Type.String())),
					blockDangerousCommands: Type.Optional(Type.Boolean()),
				})),
			}, { description: "单次运行能力覆盖；只能进一步收窄角色模板和注册实例" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			const loadedAgent = loadSubagent(ctx.cwd, params.agent);
			if (!loadedAgent) {
				throw new Error(`AgentFlux: unknown subagent '${params.agent}'. 可用: reviewer (内建) 或 .agentflux/agents/*.md`);
			}
			const agent = withSharedSkills(loadedAgent, teamCtx?.sharedSkills);
			const config = loadConfig(ctx.cwd);
			// Resolve provider from config if not specified in agent definition
			if (!agent.provider && agent.model) {
				agent.provider = teamCtx?.modelsConfig?.models?.[agent.model]?.provider;
			}
			const validThinking = params.thinking && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(params.thinking)
				? params.thinking as any : undefined;
			const runtimeCapabilities = normalizeRuntimeCapabilityOverride(params.capabilities);
			const runtimeCommunication = normalizeRuntimeCommunicationOverride(params.communication);
			const pref = applyRuntimeOverride(config, loadPreference(ctx.cwd), runtimePreset).pref;
			const capabilityWarnings = [
				runtimeCapabilities?.tools ? assessCacheImpact("tool_schema", pref) : null,
				runtimeCapabilities?.skills ? assessCacheImpact("skill_set", pref) : null,
				runtimeCapabilities?.mcpServers ? assessCacheImpact("mcp_set", pref) : null,
			].filter((item): item is NonNullable<typeof item> => !!item)
				.map(item => formatCacheImpactWarning(item)).filter((item): item is string => !!item);
			if (ctx.hasUI) for (const warning of capabilityWarnings) ctx.ui.notify(warning, "warning");
			const r = await runSubagent({
				cwd: ctx.cwd, agent, task: params.task, sessionId,
				telemetry, prefixLayout: config.cache.prefix_layout === "static_first",
				pricing: pricingTable ?? undefined,
				persistent: params.persistent ?? false,
				thinking: validThinking,
				timeoutMs: Math.min(
					Math.max(30_000, config.budget.max_wall_clock_seconds * 1000),
					Math.max(30_000, Math.min(900_000, (params.timeoutSeconds ?? 180) * 1000)),
				),
				maxRetries: 2,       // 自动重试 2 次 (502/timeout 等)
				enableModelFallback: Object.keys(teamCtx?.modelsConfig?.models ?? {}).length > 1,
				modelsForFallback: teamCtx?.modelsConfig?.models,
				roleRequirementForFallback: {
					coding: params.agent === "implementer" ? 0.8 : 0.5,
					reasoning: params.agent === "reviewer" ? 0.9 : 0.6,
					speed: 0.6,
					cost_eff: params.agent === "reviewer" ? 0.4 : 0.75,
				},
				lockFiles: params.lockFiles,
				signal: _signal,
				maxCostUsd: config.budget.max_cost_per_task,
				taskId: currentTaskPlan?.taskId,
				communicationOverride: runtimeCommunication,
				capabilityOverride: runtimeCapabilities,
			});
			const observedCapabilityWarnings = (r.capability?.cacheBreakingChanges ?? [])
				.map(change => formatCacheImpactWarning(assessCacheImpact(change, pref)))
				.filter((item): item is string => !!item);
			const resultWarnings = [...new Set([...capabilityWarnings, ...observedCapabilityWarnings])];
			if (ctx.hasUI) for (const warning of observedCapabilityWarnings) {
				if (!capabilityWarnings.includes(warning)) ctx.ui.notify(warning, "warning");
			}
			return { content: [{ type: "text", text: [...resultWarnings, formatSubagentResult(r)].join("\n\n") }], details: r };
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
				lockFiles: Type.Optional(Type.Array(Type.String(), { description: "该 agent 将编辑的文件路径列表, 用于文件锁防冲突" })),
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
			const lockFilesMap: Record<string, string[]> = {};
			const fileOwner: Record<string, string> = {};  // file→label, 冲突检测

			for (const a of params.agents) {
				const loadedAgent = loadSubagent(ctx.cwd, a.agent);
				if (!loadedAgent) {
					loadErrors.push(`unknown subagent '${a.agent}'`);
					continue;
				}
				const agent = withSharedSkills(loadedAgent, teamCtx?.sharedSkills);
				// Resolve provider from config if not specified in agent definition
				if (!agent.provider && agent.model) {
					agent.provider = teamCtx?.modelsConfig?.models?.[agent.model]?.provider;
				}
				const label = a.label ?? a.agent;
				tasks.push({ agent, task: a.task, label });
				// 文件锁: 显式指定 + 自动检测冲突
				if (a.lockFiles && a.lockFiles.length > 0) {
					lockFilesMap[label] = a.lockFiles;
					for (const fp of a.lockFiles) {
						if (fileOwner[fp] && fileOwner[fp] !== label) {
							console.error(`[flux] WARNING: file conflict — ${fp} wanted by both ${fileOwner[fp]} and ${label}`);
						} else {
							fileOwner[fp] = label;
						}
					}
				}
			}

			if (tasks.length === 0) {
				return { content: [{ type: "text", text: `AgentFlux: no valid agents loaded. Errors: ${loadErrors.join("; ")}` }], details: {} };
			}

			console.error(`[flux] parallel subagent: launching ${tasks.length} agents`);
			const result = await runSubagentsParallel(tasks, {
				cwd: ctx.cwd, sessionId, telemetry,
				prefixLayout: config.cache.prefix_layout === "static_first",
				pricing: pricingTable ?? undefined,
				timeoutMs: 180000,
				maxRetries: 2,   // 502/timeout 自动重试
				lockFiles: Object.keys(lockFilesMap).length > 0 ? lockFilesMap : undefined,
				signal: _signal,
				maxCostUsd: config.budget.max_cost_per_task,
				taskId: currentTaskPlan?.taskId,
			});
			console.error(`[flux] parallel subagent done: wall ${(result.wallClockMs / 1000).toFixed(1)}s, speedup ${result.speedupRatio.toFixed(2)}x`);
			return { content: [{ type: "text", text: formatParallelResults(result) }], details: {} };
		},
	});

	// ---------- Team Review-Feedback Workflow ----------

	pi.registerTool({
		name: "flux_team_review",
		label: "Flux Team with Review Loop",
		description: "多 agent 团队工作流: implement (parallel, persistent) → review → feedback → re-implement. Reviewer 反馈写入 SharedBoard messages/, 失败的 implementer 带 feedback 重新 dispatch. 实现→审查→反馈→修复的闭环. 参数: tasks (implementer 任务数组), reviewer (reviewer agent 名), maxRounds (可选, 默认 2).",
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({
				agent: Type.String({ description: "implementer agent 名称" }),
				task: Type.String({ description: "任务描述 (含完整规格)" }),
				label: Type.String({ description: "唯一标签, 用作 session ID 和 reviewer 反馈路由" }),
			})),
			reviewer: Type.Optional(Type.String({ description: "reviewer agent 名称, 默认 'reviewer'" })),
			maxRounds: Type.Optional(Type.Number({ description: "最大轮次 (默认 2 = 初始 + 1 retry)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			if (!params.tasks || params.tasks.length === 0) {
				return { content: [{ type: "text", text: "AgentFlux: no tasks specified" }], details: {} };
			}
			if (params.tasks.length > 5) {
				return { content: [{ type: "text", text: `AgentFlux: too many tasks (${params.tasks.length}), max 5` }], details: {} };
			}

			const config = loadConfig(ctx.cwd);
			const reviewerAgent = params.reviewer ?? "reviewer";
			const fluxDir = join(ctx.cwd, ".agentflux");

			const result = await runTeamWithReview(
				params.tasks as TeamTask[],
				reviewerAgent,
				{
					cwd: ctx.cwd,
					fluxDir,
					telemetry,
					pricing: pricingTable ?? undefined,
					prefixLayout: config.cache.prefix_layout === "static_first",
					maxRounds: params.maxRounds ?? 2,
					timeoutMs: 180000,
					signal: _signal,
					maxCostUsd: config.budget.max_cost_per_task,
					sharedSkills: teamCtx?.sharedSkills,
				},
			);

			return { content: [{ type: "text", text: formatTeamWorkflowResult(result) }], details: {} };
		},
	});

	// ---------- /flux-agents & /flux-back: direct agent communication ----------

	pi.registerCommand("flux-agents", {
		description: "List registered agents, select one to enter its session directly. Press d to delete (y/n confirm).",
		handler: async (_args: string, ctx: any) => handleFluxAgentsCommand(_args, ctx),
	});

	pi.registerCommand("flux-back", {
		description: "Return to the main agent session from an agent session.",
		handler: async (_args: string, ctx: any) => handleFluxBackCommand(_args, ctx),
	});

	pi.registerCommand("flux", {
		description: "AgentFlux: routing/execution/cache/self-maintenance. subcommands: work [--mode M1|M2|M5] <task> | cancel [runId|all] | gc [dry-run] | gc legacy [dry-run] <names...> | why | mode <preset> | preference | project | fork | complexity | team | compact | agents | chat | groups | status | health | restart | upgrade [pull]",
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

			// ─── Task → RoutePlan → M1/M2/M5 执行 ───
			if (sub === "work") {
				const parsedWork = parseWorkCommand(parts.slice(1));
				if (parsedWork.error) {
					const msg = parsedWork.error;
					if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
					return;
				}
				const taskText = parsedWork.task;
				if (!taskText) {
					const msg = "Usage: /flux work [--mode M1|M2|M5] <task description>\n  Without --mode, AgentFlux returns/applies the configured route recommendation.\n  Example: /flux work --mode M2 Implement a preference radar chart";
					if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
					return;
				}
				if (!teamCtx) {
					const msg = "team context not initialized (session_start incomplete?)";
					if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
					return;
				}

				const config = loadConfig(ctx.cwd);
				const runtime = applyRuntimeOverride(config, loadPreference(ctx.cwd), runtimePreset);
				const plan = buildTaskRoutePlan({ cwd: ctx.cwd, task: taskText, stage: state.stage, config: runtime.config, pref: runtime.pref, requestedMode: parsedWork.mode ?? explicitRuntimeMode });
				currentTaskPlan = plan;
				state.mode = plan.effectiveMode;
				telemetry.writeRoutingDecision({
					sessionId, taskId: plan.taskId, decisionId: plan.decisionId,
					mode: plan.effectiveMode, actualMode: plan.effectiveMode,
					preset: state.preset, stage: state.stage, role: state.role,
					reason: [...plan.decision.reason, "explicit:/flux work"], confidence: plan.decision.confidence,
					fallback: plan.decision.fallback, biasSources: plan.decision.biasSources, expected: plan.decision.expected,
					taskType: plan.signal.classification.type, complexityTier: plan.signal.complexity.tier,
					fileCount: plan.signal.complexity.fileCount, diffLines: plan.signal.scope.diffLines,
					overrideMode: runtime.config.routing.override_mode, applied: true,
				});
				if (plan.blockedReason) {
					const msg = `[flux work] ${formatTaskRoutePlan(plan)}`;
					if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
					return;
				}

				// M1/M2 的执行 owner 是当前 main agent；把原任务重新送入 agent loop，并绑定已确认计划。
				if (plan.executor !== "dag") {
					pendingExplicitPlan = plan;
					const msg = `[flux work] Applied\n${formatTaskRoutePlan(plan)}`;
					if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
					pi.sendUserMessage(taskText);
					// In print mode the slash command itself is the only top-level input.  If
					// the handler returns immediately, pi may dispose the session before the
					// asynchronously queued user turn starts, invalidating every extension
					// context.  Yield once so sendUserMessage can enter the agent loop, then
					// keep the command alive until that turn settles.  TUI/RPC callers retain
					// their existing non-blocking command behaviour.
					if (ctx.mode === "print") {
						const previousTurn = state.turnIndex;
						const startDeadline = Date.now() + 5_000;
						while (ctx.isIdle() && state.turnIndex === previousTurn && Date.now() < startDeadline) {
							await new Promise<void>((resolve) => setTimeout(resolve, 10));
						}
						if (!ctx.isIdle()) await ctx.waitForIdle();
						else if (state.turnIndex === previousTurn) {
							throw new Error("/flux work could not start its delegated turn in print mode");
						}
					}
					return;
				}

				const controller = new AbortController();
				activeRuns.set(plan.taskId, { controller, startedAt: Date.now(), task: taskText });
				// DAG 在后台执行，但保留可取消句柄和稳定 run id。
				const execDag = async () => {
					try {
						if (ctx.hasUI) ctx.ui.notify(`[flux work] ${formatTaskRoutePlan(plan)}\nDecomposing...`, "info");
						else console.log(`[flux work]\n${formatTaskRoutePlan(plan)}\nDecomposing...`);
						const result = await dispatchDagPlan(plan, ctx, controller.signal);
						const resultStr = formatDAGResult(result);
						if (ctx.hasUI) ctx.ui.notify(`[flux work] Done!\n${resultStr}`, "info");
						else console.log(resultStr);
						refreshCache(ctx);
					} catch (e: any) {
						const errMsg = `[flux work] Error: ${e?.message ?? e}`;
						if (ctx.hasUI) ctx.ui.notify(errMsg, "error"); else console.error(errMsg);
					} finally {
						activeRuns.delete(plan.taskId);
					}
				};

				void execDag();
				if (ctx.hasUI) ctx.ui.notify(`[flux work] Dispatched ${plan.taskId}. Use /flux cancel ${plan.taskId} to stop.`, "info");
				else console.log(`[flux work] Dispatched ${plan.taskId}. Use /flux cancel ${plan.taskId} to stop.`);
				return;
			}

			if (sub === "cancel") {
				const target = parts[1];
				const runs = target && target !== "all"
					? [...activeRuns.entries()].filter(([id]) => id === target)
					: [...activeRuns.entries()];
				for (const [, run] of runs) run.controller.abort(`cancelled by /flux cancel ${target ?? "all"}`);
				const msg = runs.length > 0 ? `Cancellation requested for ${runs.map(([id]) => id).join(", ")}` : "No matching active AgentFlux run";
				if (ctx.hasUI) ctx.ui.notify(msg, runs.length > 0 ? "info" : "warn"); else console.log(msg);
				return;
			}

			if (sub === "gc") {
				const config = loadConfig(ctx.cwd);
				const legacy = parts[1] === "legacy";
				const dryRun = parts.includes("dry-run") || parts.includes("--dry-run");
				const explicitLegacyAgentNames = legacy
					? parts.slice(2).filter(part => !["dry-run", "--dry-run"].includes(part))
					: undefined;
				if (legacy && explicitLegacyAgentNames!.length === 0) {
					const usage = "Usage: /flux gc legacy [dry-run] <agent-name> [agent-name...]";
					if (ctx.hasUI) ctx.ui.notify(usage, "warn"); else console.log(usage);
					return;
				}
				const activeRunIds = [...new Set([...activeRuns.keys(), ...getActiveSubagentRunIds()])];
				const report = runLifecycleGc(fluxDir, config.retention, { dryRun, activeRunIds, explicitLegacyAgentNames });
				const text = formatLifecycleGcReport(report);
				if (ctx.hasUI) ctx.ui.notify(text, report.blockedReason ? "warn" : "info"); else console.log(text);
				return;
			}

			if (sub === "agents") {
				const lines: string[] = ["AgentFlux Active Agents", "═".repeat(60)];
				let count = 0;
				if (activeRuns.size > 0) {
					lines.push("Active Runs:");
					for (const [id, run] of activeRuns) {
						lines.push(`  ● ${id} | ${Math.round((Date.now() - run.startedAt) / 1000)}s | ${run.task.slice(0, 60)}`);
						count++;
					}
				}
				// Agent registry (new: from SharedBoard agents/)
				try {
					const board = new SharedBoard(fluxDir);
					const agents = board.listAgents();
					if (agents.length > 0) {
						lines.push("Registered Agents:");
						for (const a of agents) {
							const statusIcon = a.status === "running" ? "●" : a.status === "done" ? "✓" : a.status === "failed" ? "✗" : a.status === "blocked" ? "⚠" : "○";
							lines.push(`  ${statusIcon} ${a.name.padEnd(20)} ${a.role} | ${a.status} | ${a.model ?? "?"} | ${a.currentTask?.slice(0, 40) ?? ""}`);
							count++;
						}
					}
				} catch {}
				// Persistent agents (M4)
				try {
					const regPath = join(fluxDir, "runtime", "persistent-agents.json");
					if (existsSync(regPath)) {
						const reg = JSON.parse(readFileSync(regPath, "utf-8"));
						lines.push("Persistent Agents:");
						for (const a of (Array.isArray(reg) ? reg : reg.agents ?? [])) {
							const name = a.name ?? "unknown";
							const statusIcon = a.status === "running" ? "●" : a.status === "done" ? "✓" : a.status === "failed" ? "✗" : "○";
							lines.push(`  ${statusIcon} ${name.padEnd(20)} ${a.role ?? "?"} | ${a.status ?? "?"} | calls=${a.callCount ?? 0} | $${(a.totalCost ?? 0).toFixed(4)}`);
							count++;
						}
					}
				} catch {}
				// SharedBoard agents (DAG/M6)
				try {
					const board = new SharedBoard(fluxDir);
					const bb = board.getBlackboard();
					{
						const agents = bb.agentStatuses ?? {};
						const entries = Object.entries(agents);
						if (entries.length > 0) {
							if (count > 0) lines.push("");
							lines.push("DAG/M6 Agents:");
							for (const [name, info] of entries) {
								const a = info as any;
								const statusIcon = a.status === "running" ? "●" : a.status === "done" ? "✓" : a.status === "failed" ? "✗" : "○";
								lines.push(`  ${statusIcon} ${name.padEnd(20)} ${a.role ?? "?"} | ${a.status ?? "?"} | ${a.workingOn ?? ""}`);
								count++;
							}
						}
					}
				} catch {}
				if (count === 0) lines.push("(no active agents)");
				// DAG state
				try {
					const dagPath = join(fluxDir, "runtime", "dag-state.json");
					if (existsSync(dagPath)) {
						const ds = JSON.parse(readFileSync(dagPath, "utf-8"));
						const age = Math.round((Date.now() - ds.timestamp) / 1000);
						lines.push("");
						lines.push(`DAG: ${ds.description?.slice(0, 50) ?? "?"} | ✅${ds.completed?.length ?? 0} ❌${ds.failed?.length ?? 0} | ${age}s ago`);
					}
				} catch {}
				if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info"); else console.log(lines.join("\n"));
				return;
			}

			// ─── 群组/聊天子命令 ───

			if (sub === "chat") {
				// /flux chat [groupId] — 查看群组消息
				try {
					const board = new SharedBoard(fluxDir);
					const groups = board.listGroups();
					if (groups.length === 0) {
						if (ctx.hasUI) ctx.ui.notify("No groups. Use /flux groups to create.", "info"); else console.log("No groups.");
						return;
					}
					const targetGroup = parts[1] ? groups.find(g => g.id === parts[1] || g.name === parts.slice(1).join(" ")) : groups[0];
					if (!targetGroup) {
						if (ctx.hasUI) ctx.ui.notify(`Group '${parts[1]}' not found. Available: ${groups.map(g => g.id).join(", ")}`, "warn"); else console.log(`Group not found. Available: ${groups.map(g => g.id).join(", ")}`);
						return;
					}
					const msgs = board.getGroupMessages(targetGroup.id);
					const lines: string[] = [
						`Group: ${targetGroup.name} (${targetGroup.id}) [${targetGroup.type}]`,
						`Members: ${targetGroup.members.join(", ")}`,
						"".repeat(1),
						formatGroupMessages(msgs),
					];
					if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info"); else console.log(lines.join("\n"));
				} catch (e: any) {
					if (ctx.hasUI) ctx.ui.notify(`Error reading chat: ${e.message}`, "error"); else console.error(e);
				}
				return;
			}

			if (sub === "groups") {
				// /flux groups — 列出所有群组 + agent 注册表
				try {
					const board = new SharedBoard(fluxDir);
					const groups = board.listGroups();
					const agents = board.listAgents();
					const lines: string[] = ["AgentFlux Groups & Agents", "═".repeat(60)];
					lines.push(formatGroups(groups));
					lines.push("");
					lines.push(formatAgents(agents));
					if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info"); else console.log(lines.join("\n"));
				} catch (e: any) {
					if (ctx.hasUI) ctx.ui.notify(`Error: ${e.message}`, "error"); else console.error(e);
				}
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
				const pumpStats = rpcInboxPump?.getStats();
				subsystems.push({
					name: "RPC Inbox Pump",
					healthy: !pumpStats || !pumpStats.lastError,
					detail: pumpStats
						? `running recipient=${pumpStats.recipient}; instance=${rpcRuntimeInstanceId ?? "unknown"}; in-flight=${pumpStats.inFlightMessageIds.length}; delivered=${pumpStats.delivered}; ack=${pumpStats.acknowledged}; failed=${pumpStats.failed}; heartbeat=${pumpStats.lastHeartbeatAt ?? "pending"}${pumpStats.lastError ? `; error=${pumpStats.lastError}` : ""}`
						: "disabled",
				});

				// Read persistent agents
				const activeAgents: AgentInfo[] = [];
				try {
					const regPath = join(fluxDir, "runtime", "persistent-agents.json");
					if (existsSync(regPath)) {
						const reg = JSON.parse(readFileSync(regPath, "utf-8"));
						for (const a of (Array.isArray(reg) ? reg : reg.agents ?? [])) {
							const name = a.name ?? "unknown";
							activeAgents.push({ name, role: a.role ?? "?", status: a.status ?? "?", model: a.model, callCount: a.callCount, totalCost: a.totalCost });
						}
					}
				} catch {}

				// Read SharedBoard agents (DAG/M6 temporary agents)
				try {
					const board = new SharedBoard(fluxDir);
					const bb = board.getBlackboard();
					{
						const agents = bb.agentStatuses ?? {};
						for (const [name, info] of Object.entries(agents)) {
							const a = info as any;
							// 跳过已从 persistent-agents.json 加载的
							if (activeAgents.some(x => x.name === name)) continue;
							activeAgents.push({ name, role: a.role ?? "?", status: a.status ?? "?", model: undefined, callCount: 0, totalCost: 0 });
						}
					}
				} catch {}

				// Read DAG state
				let dagInfo: string | undefined;
				try {
					const dagPath = join(fluxDir, "runtime", "dag-state.json");
					if (existsSync(dagPath)) {
						const ds = JSON.parse(readFileSync(dagPath, "utf-8"));
						const age = Math.round((Date.now() - ds.timestamp) / 1000);
						dagInfo = `${ds.description?.slice(0, 60) ?? "?"} | completed: ${ds.completed?.length ?? 0} | failed: ${ds.failed?.length ?? 0} | ${age}s ago`;
					}
				} catch {}

				const issues = telemetry ? scanRecentIssues(telemetry.path, 20) : [];

				// Read file locks
				let lockInfo = "";
				try {
					const board = new SharedBoard(fluxDir);
					const locks = board.getFileLocks();
					if (locks.length > 0) {
						lockInfo = "\n\nFile Locks:" + locks.map(l => `\n  ${l.agent} → ${l.filePath}`).join("");
					}
				} catch {}

				const text = formatStatusReport(vInfo, {
					mode: state.mode, preset: state.preset, stage: state.stage, role: state.role,
					turnIndex: state.turnIndex, cacheHitRate: state.cache.cacheHitRate,
					costUsd: state.cache.costUsd, branch: state.branch,
				}, subsystems, activeAgents, issues, {
					fluxDir, eventsPath: telemetry?.path ?? "", configPath: join(fluxDir, "agentflux.json"),
				}, dagInfo) + lockInfo;
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
				if (args[1] === "pull" && info.hasRemote && !info.upToDate) {
					// 执行 git pull
					try {
						const { execSync } = await import("node:child_process");
						const pullResult = execSync(`git pull origin ${info.currentBranch}`, { cwd: ctx.cwd, encoding: "utf-8", timeout: 30000 });
						// 自动重启初始化序列
						const restartText = await performRestart(ctx);
						const text = `Pulled ${info.remoteCommits.length} commit(s) from origin/${info.currentBranch}\n${pullResult.trim()}\n\n${restartText}`;
						if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
					} catch (e: any) {
						const text = `git pull failed: ${e?.message}`;
						if (ctx.hasUI) ctx.ui.notify(text, "error"); else console.error(text);
					}
					return;
				}
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
		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => {
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
