/**
 * AgentFlux Extension — subagent safety entry
 * Loads only capability/message/settlement safety hooks; it does not register
 * the Main-only flux_subagent tool or /flux command, and leaves native cache
 * payload/TTL semantics untouched.
 *
 * 用法: subagent 子进程用 -e src/subagent-entry.ts (替代 src/entry.ts)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { loadConfig } from "./core/config";
import type { SdkRunOwner } from "./core/runtime-owner";
import { AgentMessageRuntime } from "./core/agent-message-runtime";
import { resolveCommunicationPolicy } from "./core/communication-policy";
import { TelemetryWriter } from "./telemetry/events";
import {
	capabilityToolUnsupportedReason,
	evaluateCapabilityToolCall,
	evaluateLockFileToolCall,
	type EffectiveCapabilityPolicy,
} from "./core/capability-policy";
import {
	AGENTFLUX_BOUNDARY_RECEIPT_CUSTOM_TYPE,
	createBoundaryReceiptDetails,
	readBoundaryStateOutcome,
	RpcInboxPump,
} from "./extension/rpc-inbox-pump";
import { readAgentRunStop } from "./agents/agent-run-control";
import { SharedBoard } from "./core/shared-board";
import { toJsonValue, toolDetailsFailed } from "./core/tool-result";

function parseStartupMessageIds(value: string | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

/** Keep tool details/content safe for JSON mode and structured callers. */
function toJsonSafe(value: unknown): any { return toJsonValue(value) ?? null; }

export interface SubagentSessionOptions {
	agentName?: string;
	instanceId?: string;
	runId?: string;
	taskId?: string;
	controlCwd?: string;
	agentRole?: string;
	rpcInboxEnabled?: boolean;
	communicationPolicy?: unknown;
	capabilityPolicy?: unknown;
	lockFiles?: readonly string[];
	startupMessageIds?: readonly string[];
	runtimeOwner?: SdkRunOwner;
	isRunAccepting?: () => boolean;
}

export interface SubagentSafetyControl {
	closeInput(): void;
	shutdown(): void;
	hasPendingInput(): boolean;
	initializationError(): string | undefined;
}

/** 同一安全factory；SDK直接注入Run参数，CLI wrapper仅负责解码env。 */
export function registerSubagentSafety(pi: ExtensionAPI, options: SubagentSessionOptions): SubagentSafetyControl {
	let acceptingInput = true;
	let initializationError: string | undefined;
	let generation = 0;
	let telemetry: TelemetryWriter | null = null;
	let sessionId = "subagent";
	const { agentName, instanceId, runId, controlCwd, taskId } = options;
	const agentRole = options.agentRole ?? "rpc-runtime";
	const rpcInboxEnabled = options.rpcInboxEnabled === true;
	const isAccepting = () => acceptingInput && (options.isRunAccepting?.() ?? true);
	let rpcInboxPump: RpcInboxPump | null = null;
	let agentBusy = false;
	let runtimeBoard: SharedBoard | null = null;
	const communicationPolicy = resolveCommunicationPolicy(options.communicationPolicy as any);
	let capabilityPolicy: EffectiveCapabilityPolicy | null = null;
	let capabilityPolicyError: string | null = null;
	const lockFiles = [...(options.lockFiles ?? [])].map(item => resolve(item));
	if (options.capabilityPolicy !== undefined) {
		try {
			const parsed = options.capabilityPolicy as any;
			if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.tools)
				|| parsed.workspace === null || typeof parsed.workspace !== "object"
				|| !Array.isArray(parsed.workspace.roots) || !Array.isArray(parsed.workspace.deniedPaths)) {
				throw new Error("effective capability policy shape is invalid");
			}
			const unsupported = parsed.tools.map((tool: unknown) => typeof tool === "string" ? capabilityToolUnsupportedReason(tool) : null).find(Boolean);
			if (unsupported) throw new Error(unsupported);
			capabilityPolicy = parsed as EffectiveCapabilityPolicy;
		} catch (error: any) { capabilityPolicyError = `invalid capability policy: ${error?.message ?? error}`; }
	}

	if (agentName && instanceId && runId && communicationPolicy.enabled) {
		pi.registerTool({
			name: "flux_agent_message",
			label: "Agent Message",
			description: "Identity-bound AgentFlux messaging. Sender and recipient identity are fixed by the runtime; use send for handoff, poll for new messages, and ack after processing an inbox message.",
			exposure: "model-only",
			executionMode: "sequential",
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
			async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
			try {
				if (!isAccepting() || readAgentRunStop(controlCwd || ctx.cwd, runId)) {
					throw new Error(`Agent Run ${runId} is stopping; message action rejected`);
				}
				const runtime = new AgentMessageRuntime(join(controlCwd || ctx.cwd, ".agentflux"), {
					agent: agentName, instanceId, runId, taskId,
				}, communicationPolicy, record => telemetry?.writeMessageProtocol({
					sessionId, runId: record.runId, action: record.action, agent: record.agent,
					instanceId: record.instanceId, messageId: record.messageId, target: record.target,
					result: record.result, detail: record.detail,
				}));
				const result = toJsonSafe(runtime.execute({
					action: params.action, target: params.target, type: params.messageType,
					content: params.content, messageId: params.messageId, dedupeKey: params.dedupeKey,
					limit: params.limit, priority: params.priority,
				}));
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result, structuredContent: result, isError: toolDetailsFailed(result),
				} as any;
			} catch (error: any) {
				const result = toJsonSafe({ ok: false, error: String(error?.message ?? error).slice(0, 500) });
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result, structuredContent: result, isError: true,
				} as any;
			}
			},
		} as any);
	}

	pi.on("tool_call", async (event: any, ctx: any) => {
		if (!isAccepting()) return { block: true, reason: "Agent Run is stopping; new tool calls are rejected" };
		// This check intentionally runs even for legacy children without an
		// injected capability JSON.  No PowerShell path gate means no execution;
		// nested calls arrive here with parentToolCallId and use the same check.
		const unsupportedReason = capabilityToolUnsupportedReason(String(event.toolName ?? ""));
		if (unsupportedReason) return { block: true, reason: unsupportedReason };
		if (capabilityPolicyError) return { block: true, reason: capabilityPolicyError };
		if (!capabilityPolicy) return undefined;
		try {
			const reason = evaluateCapabilityToolCall(capabilityPolicy, ctx.cwd, event.toolName, event.input ?? {});
			if (reason) return { block: true, reason };
			const lockReason = evaluateLockFileToolCall(ctx.cwd, lockFiles, event.toolName, event.input ?? {});
			if (lockReason) return { block: true, reason: lockReason };
			return undefined;
		} catch (error: any) {
			return { block: true, reason: `Invalid capability policy; tool call rejected: ${String(error?.message ?? error).slice(0, 400)}` };
		}
	});

	// Pi's native warmer has no extension-visible completion/charge callback in
	// this adapter.  Stop each native decision safely instead of changing global
	// settings or maintaining a second timer/ledger.
	(pi as any).on("cache_warming_decision", async (event: any) => {
		try {
			telemetry?.write({
				ts: Date.now(), sessionId, type: "cache.warming",
				action: "stop", nativeAction: event?.action ?? "unknown",
				reason: "no attributable warming completion usage interface; warming not enabled",
			} as any);
		} catch { /* telemetry is observational */ }
		return { action: "stop" };
	});

	pi.on("session_start", async (_event: any, ctx: any) => {
		try {
			const config = loadConfig(controlCwd || ctx.cwd);
			const fluxDir = join(controlCwd || ctx.cwd, ".agentflux");
			telemetry = new TelemetryWriter(fluxDir, true);
			sessionId = ctx.sessionManager?.getSessionFile?.() ?? `subagent-${Date.now()}`;
			if (rpcInboxEnabled && agentName && instanceId && runId && communicationPolicy.enabled) {
				runtimeBoard = new SharedBoard(fluxDir, { runtimeOwner: options.runtimeOwner });
				runtimeBoard.registerRuntimeAgent({
					name: agentName,
					role: "rpc-runtime",
					status: "idle",
					instanceId,
					runtimePid: process.pid,
					runtimeOwner: options.runtimeOwner,
				}, { leaseMs: config.communication.runtime_lease_ms });
				rpcInboxPump = new RpcInboxPump({
					fluxDir,
					recipient: agentName,
					pollIntervalMs: config.communication.poll_interval_ms,
					batchSize: config.communication.batch_size,
					heartbeatIntervalMs: config.communication.heartbeat_interval_ms,
					redeliveryAfterMs: config.communication.redelivery_after_ms,
					startupMessageIds: [...(options.startupMessageIds ?? [])],
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
					isRunAccepting: () => isAccepting() && !readAgentRunStop(controlCwd || ctx.cwd, runId),
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
			// Native provider cache controls remain untouched in the sub-entry.
			console.error(`[agentflux-subagent] cache_layout=native capability=${capabilityPolicy ? "enforced" : "legacy"} rpc_inbox=${rpcInboxPump ? "on" : "off"} role=${agentRole}`);
		} catch (e) {
			initializationError = String(e);
			console.error(`[agentflux-subagent] init error: ${e}`);
		}
	});

	pi.on("agent_start", async () => {
		agentBusy = true;
		generation += 1;
		rpcInboxPump?.onAgentStart(generation);
		if (agentName && instanceId) runtimeBoard?.updateAgentPresence(agentName, { status: "running" }, instanceId);
	});

	// BoundaryState is the only source of a generation's outcome.  The receipt
	// is append-only and visible as JSON `entry_appended`; it is not sent to the
	// model and never asks Pi to start another turn.
	(pi as any).on("agent_before_settle", async (event: any) => {
		const outcome = readBoundaryStateOutcome(event);
		if (!outcome || generation < 1) {
			rpcInboxPump?.onAgentBeforeSettle(null);
			return;
		}
		const boundaryAccepted = rpcInboxPump
			? rpcInboxPump.onAgentBeforeSettle({ generation, outcome })
			: true;
		if (!boundaryAccepted) return;
		const details = createBoundaryReceiptDetails({
			generation,
			outcome,
			consumption: rpcInboxPump?.getConsumptionForBoundary() ?? { consumed: false, messageIds: [] },
			continueRequested: event.continue === true,
		});
		try {
			(pi.appendEntry as any)(AGENTFLUX_BOUNDARY_RECEIPT_CUSTOM_TYPE, details);
		} catch (error: any) {
			// A missing receipt is deliberately observable/fail-closed; do not
			// synthesize a settled outcome or ACK when append fails.
			rpcInboxPump?.onAgentBeforeSettle(null);
			console.error(`[agentflux-subagent] boundary receipt append failed: ${String(error?.message ?? error).slice(0, 400)}`);
		}
	});

	pi.on("message_start", async (event: any) => {
		rpcInboxPump?.onMessageStart(event.message);
	});

	pi.on("message_end", async (event: any) => {
		if (event?.message?.role === "toolResult" && event.message.isError) rpcInboxPump?.onAssistantMessageEnd(false);
		if (event?.message?.role !== "assistant") return;
		const success = event.message.stopReason !== "error" && event.message.stopReason !== "aborted";
		rpcInboxPump?.onAssistantMessageEnd(success);
	});

	pi.on("agent_settled", async () => {
		rpcInboxPump?.onAgentSettled();
		agentBusy = false;
		if (agentName && instanceId) runtimeBoard?.updateAgentPresence(agentName, { status: "idle" }, instanceId);
		await rpcInboxPump?.tick();
	});

	const control: SubagentSafetyControl = {
		closeInput: () => { acceptingInput = false; },
		shutdown: () => { acceptingInput = false; rpcInboxPump?.stop(); rpcInboxPump = null; },
		hasPendingInput: () => rpcInboxPump?.getStats().inFlight === true,
		initializationError: () => initializationError,
	};
	pi.on("session_shutdown", async () => { control.shutdown(); });
	// Native cache_control/TTL remain untouched in both drivers.
	return control;
}

export default function (pi: ExtensionAPI) {
	const decode = (value: string | undefined, fallback: unknown): unknown => {
		try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
	};
	registerSubagentSafety(pi, {
		agentName: process.env.AGENTFLUX_AGENT_NAME,
		instanceId: process.env.AGENTFLUX_AGENT_INSTANCE_ID,
		runId: process.env.AGENTFLUX_RUN_ID,
		taskId: process.env.AGENTFLUX_TASK_ID || undefined,
		controlCwd: process.env.AGENTFLUX_CONTROL_CWD,
		agentRole: process.env.AGENTFLUX_AGENT_ROLE,
		rpcInboxEnabled: process.env.AGENTFLUX_RPC_INBOX_PUMP === "1",
		communicationPolicy: decode(process.env.AGENTFLUX_COMMUNICATION_POLICY, { enabled: false }),
		capabilityPolicy: process.env.AGENTFLUX_CAPABILITY_POLICY ? decode(process.env.AGENTFLUX_CAPABILITY_POLICY, null) : undefined,
		lockFiles: parseStartupMessageIds(process.env.AGENTFLUX_LOCK_FILES),
		startupMessageIds: parseStartupMessageIds(process.env.AGENTFLUX_STARTUP_MESSAGE_IDS),
	});
}
