/**
 * AgentFlux Extension — subagent 精简入口
 * 仅加载 prefix-layout + cache 监控, 不注册 flux_subagent tool 和 /flux 命令
 * 避免改变子进程 LLM 的工具列表和行为 (实验 C 暴露的问题)
 *
 * 用法: subagent 子进程用 -e src/subagent-entry.ts (替代 src/entry.ts)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { loadConfig } from "./core/config";
import { AgentMessageRuntime } from "./core/agent-message-runtime";
import { resolveCommunicationPolicy } from "./core/communication-policy";
import { applyPrefixLayout } from "./extension/prefix-layout";
import { TelemetryWriter } from "./telemetry/events";
import type { FluxRuntimeState } from "./core/types";
import { evaluateCapabilityToolCall, evaluateLockFileToolCall, type EffectiveCapabilityPolicy } from "./core/capability-policy";
import { RpcInboxPump } from "./extension/rpc-inbox-pump";
import { readAgentRunStop } from "./agents/agent-run-control";
import { SharedBoard } from "./core/shared-board";

export default function (pi: ExtensionAPI) {
	let state: FluxRuntimeState = {
		branch: null, turnIndex: 0,
		cache: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0,
			contextTokens: 0, contextWindow: 0, contextPercent: null, cacheHitRate: 0 },
	};
	let telemetry: TelemetryWriter | null = null;
	let sessionId = "subagent";
	const agentName = process.env.AGENTFLUX_AGENT_NAME;
	const instanceId = process.env.AGENTFLUX_AGENT_INSTANCE_ID;
	const runId = process.env.AGENTFLUX_RUN_ID;
	const controlCwd = process.env.AGENTFLUX_CONTROL_CWD;
	const agentRole = process.env.AGENTFLUX_AGENT_ROLE ?? "rpc-runtime";
	const rpcInboxEnabled = process.env.AGENTFLUX_RPC_INBOX_PUMP === "1";
	let rpcInboxPump: RpcInboxPump | null = null;
	let agentBusy = false;
	let runtimeBoard: SharedBoard | null = null;
	let rawPolicy: any = undefined;
	try { rawPolicy = JSON.parse(process.env.AGENTFLUX_COMMUNICATION_POLICY ?? "{}"); } catch { rawPolicy = { enabled: false }; }
	const communicationPolicy = resolveCommunicationPolicy(rawPolicy);
	let capabilityPolicy: EffectiveCapabilityPolicy | null = null;
	let capabilityPolicyError: string | null = null;
	let lockFiles: string[] = [];
	try {
		const parsed = JSON.parse(process.env.AGENTFLUX_LOCK_FILES ?? "[]");
		if (Array.isArray(parsed)) lockFiles = parsed.filter((item): item is string => typeof item === "string").map(item => resolve(item));
	} catch {}
	if (process.env.AGENTFLUX_CAPABILITY_POLICY) {
		try { capabilityPolicy = JSON.parse(process.env.AGENTFLUX_CAPABILITY_POLICY); }
		catch (error: any) { capabilityPolicyError = `invalid capability policy: ${error?.message ?? error}`; }
	}

	if (agentName && instanceId && runId && communicationPolicy.enabled) {
		pi.registerTool({
			name: "flux_agent_message",
			label: "Agent Message",
			description: "Identity-bound AgentFlux messaging. Sender and recipient identity are fixed by the runtime; use send for handoff, poll for new messages, and ack after processing an inbox message.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("send"), Type.Literal("poll"), Type.Literal("ack"), Type.Literal("status")]),
				target: Type.Optional(Type.String({ description: "Direct agent, broadcast, or group:<id>; send only" })),
				messageType: Type.Optional(Type.String()),
				content: Type.Optional(Type.String()),
				messageId: Type.Optional(Type.String()),
				dedupeKey: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
				priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("critical")])),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
				if (readAgentRunStop(controlCwd || ctx.cwd, runId)) {
					throw new Error(`Agent Run ${runId} is stopping; message action rejected`);
				}
				const runtime = new AgentMessageRuntime(join(controlCwd || ctx.cwd, ".agentflux"), {
					agent: agentName, instanceId, runId, taskId: process.env.AGENTFLUX_TASK_ID || undefined,
				}, communicationPolicy, record => telemetry?.writeMessageProtocol({
					sessionId, runId: record.runId, action: record.action, agent: record.agent,
					instanceId: record.instanceId, messageId: record.messageId, target: record.target,
					result: record.result, detail: record.detail,
				}));
				const result = runtime.execute({
					action: params.action, target: params.target, type: params.messageType,
					content: params.content, messageId: params.messageId, dedupeKey: params.dedupeKey,
					limit: params.limit, priority: params.priority,
				});
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			},
		});
	}

	pi.on("tool_call", async (event: any, ctx: any) => {
		if (capabilityPolicyError) return { block: true, reason: capabilityPolicyError };
		if (!capabilityPolicy) return undefined;
		const reason = evaluateCapabilityToolCall(capabilityPolicy, ctx.cwd, event.toolName, event.input ?? {});
		if (reason) return { block: true, reason };
		const lockReason = evaluateLockFileToolCall(ctx.cwd, lockFiles, event.toolName, event.input ?? {});
		if (lockReason) return { block: true, reason: lockReason };
		return undefined;
	});

	pi.on("session_start", async (_event: any, ctx: any) => {
		try {
			const config = loadConfig(controlCwd || ctx.cwd);
			const fluxDir = join(controlCwd || ctx.cwd, ".agentflux");
			telemetry = new TelemetryWriter(fluxDir, true);
			sessionId = ctx.sessionManager?.getSessionFile?.() ?? `subagent-${Date.now()}`;
			if (rpcInboxEnabled && agentName && instanceId && runId && communicationPolicy.enabled) {
				runtimeBoard = new SharedBoard(fluxDir);
				runtimeBoard.registerRuntimeAgent({
					name: agentName,
					role: "rpc-runtime",
					status: "idle",
					instanceId,
					runtimePid: process.pid,
				}, { leaseMs: config.communication.runtime_lease_ms });
				rpcInboxPump = new RpcInboxPump({
					fluxDir,
					recipient: agentName,
					pollIntervalMs: config.communication.poll_interval_ms,
					batchSize: config.communication.batch_size,
					heartbeatIntervalMs: config.communication.heartbeat_interval_ms,
					redeliveryAfterMs: config.communication.redelivery_after_ms,
					isIdle: () => !agentBusy,
					sendUserMessage: (content, options) => {
						(pi.sendUserMessage as any)(content, options?.deliverAs ? { deliverAs: options.deliverAs } : undefined);
					},
					onHeartbeat: () => {
						runtimeBoard?.updateAgentPresence(agentName, {
							status: agentBusy ? "running" : "idle",
							heartbeatAt: new Date().toISOString(),
							runtimePid: process.pid,
						}, instanceId);
					},
					runId,
					isRunAccepting: () => !readAgentRunStop(controlCwd || ctx.cwd, runId),
					onAudit: audit => telemetry?.writeMessageProtocol({
						sessionId,
						runId,
						action: audit.action,
						agent: agentName,
						instanceId,
						messageId: audit.messageIds[0],
						result: audit.result,
						detail: audit.detail ?? `${audit.messageIds.length} message(s) via ${audit.mode ?? "n/a"}`,
					}),
				});
				rpcInboxPump.start({ immediate: false });
			}
			// stderr 标记
			console.error(`[agentflux-subagent] prefix_layout=${config.cache.prefix_layout} capability=${capabilityPolicy ? "enforced" : "legacy"} rpc_inbox=${rpcInboxPump ? "on" : "off"} role=${agentRole}`);
		} catch (e) {
			console.error(`[agentflux-subagent] init error: ${e}`);
		}
	});

	pi.on("agent_start", async () => {
		agentBusy = true;
		rpcInboxPump?.onAgentStart();
		if (agentName && instanceId) runtimeBoard?.updateAgentPresence(agentName, { status: "running" }, instanceId);
	});

	pi.on("message_end", async (event: any) => {
		if (event?.message?.role !== "assistant") return;
		const success = event.message.stopReason !== "error" && event.message.stopReason !== "aborted";
		rpcInboxPump?.onAssistantMessageEnd(success);
	});

	pi.on("agent_end", async () => {
		agentBusy = false;
		if (agentName && instanceId) runtimeBoard?.updateAgentPresence(agentName, { status: "idle" }, instanceId);
		await rpcInboxPump?.tick();
	});

	pi.on("session_shutdown", async () => {
		rpcInboxPump?.stop();
		rpcInboxPump = null;
	});

	// ---------- F1-2 前缀布局 (唯一功能) ----------

	pi.on("before_provider_request", async (event: any, _ctx: any) => {
		if (!telemetry) return undefined;
		try {
			const config = loadConfig(controlCwd || _ctx.cwd);
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
