/** Convert Message/Delivery V2 inbox entries into live pi RPC turns. */
import { randomUUID } from "node:crypto";
import { MessageBus, type DeliveredMessageV2, type MessagePriority } from "../core/message-bus";
import { assertSafeOpaqueId } from "../core/safe-path";

export type RpcInboxDeliveryMode = "prompt" | "steer" | "followUp";
export type AgentActivityOutcome = "completed" | "aborted" | "error";

/** Stable custom-entry kind consumed by JSON/RPC observers and Main. */
export const AGENTFLUX_BOUNDARY_RECEIPT_CUSTOM_TYPE = "agentflux.boundary.receipt";

export interface AgentBoundaryReceiptDetails {
	schemaVersion: 1;
	generation: number;
	outcome: AgentActivityOutcome;
	terminalFailure: boolean;
	terminalFailureOutcome?: Exclude<AgentActivityOutcome, "completed">;
	/** Whether the user message for this physical delivery was actually consumed. */
	consumed: boolean;
	consumedGeneration?: number;
	consumedMessageIds: string[];
	/** Boundary receipts are observations; settlement is a separate event. */
	settled: false;
	continueRequested: boolean;
}

export interface AgentBoundaryStateSnapshot {
	generation: number;
	outcome: AgentActivityOutcome;
}

/**
 * Read only the legal BoundaryState shape exposed by Pi's
 * `agent_before_settle` hook.  In particular, never infer an outcome from
 * `agent_settled`, which is notification-only and carries no outcome.
 */
export function readBoundaryStateOutcome(value: unknown): AgentActivityOutcome | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const state = value as Record<string, unknown>;
	if (!Array.isArray(state.entries) || typeof state.continue !== "boolean") return null;
	if (state.outcome !== "completed" && state.outcome !== "aborted" && state.outcome !== "error") return null;
	const context = state.context;
	if (context === null || typeof context !== "object" || Array.isArray(context)) return null;
	const preview = context as Record<string, unknown>;
	if (!Array.isArray(preview.contextEntries) || !Array.isArray(preview.contextMessages)
		|| !Array.isArray(preview.llmMessages) || !Array.isArray(preview.pendingMessages)
		|| typeof preview.canContinue !== "boolean") return null;
	return state.outcome;
}

export interface RpcInboxConsumption {
	consumed: boolean;
	generation?: number;
	messageIds: string[];
}

export function createBoundaryReceiptDetails(input: {
	generation: number;
	outcome: AgentActivityOutcome;
	consumption: RpcInboxConsumption;
	continueRequested: boolean;
}): AgentBoundaryReceiptDetails {
	const terminalFailure = input.outcome !== "completed";
	return {
		schemaVersion: 1,
		generation: input.generation,
		outcome: input.outcome,
		terminalFailure,
		...(terminalFailure ? { terminalFailureOutcome: input.outcome as Exclude<AgentActivityOutcome, "completed"> } : {}),
		consumed: input.consumption.consumed,
		...(input.consumption.generation === undefined ? {} : { consumedGeneration: input.consumption.generation }),
		consumedMessageIds: [...input.consumption.messageIds],
		settled: false,
		continueRequested: input.continueRequested,
	};
}

export interface RpcInboxPumpStats {
	recipient: string;
	running: boolean;
	inFlight: boolean;
	inFlightMessageIds: string[];
	delivered: number;
	acknowledged: number;
	failed: number;
	lastTickAt?: string;
	lastDeliveryAt?: string;
	lastAcknowledgedAt?: string;
	lastHeartbeatAt?: string;
	lastError?: string;
}

export interface RpcInboxPumpOptions {
	fluxDir: string;
	recipient: string;
	pollIntervalMs?: number;
	batchSize?: number;
	heartbeatIntervalMs?: number;
	redeliveryAfterMs?: number;
	/** 启动正文已交由 Host 注入/确认；本次 Run 的 RPC 不重复接管。 */
	startupMessageIds?: readonly string[];
	isIdle: () => boolean;
	sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
	onAudit?: (event: {
		action: "poll" | "ack";
		result: "success" | "failure";
		messageIds: string[];
		mode?: RpcInboxDeliveryMode;
		detail?: string;
	}) => void;
	onHeartbeat?: (now: Date) => void;
	/** 注入后等待实际 user 消息消费的握手超时（默认 60s）；不限制模型响应耗时。 */
	agentStartTimeoutMs?: number;
	/** Physical Run correlation; prevents a later Run from consuming old steer mail. */
	runId?: string;
	/** Durable stop fence checked while poll holds the Message V2 mutex. */
	isRunAccepting?: () => boolean;
}

interface ActiveBatch {
	messageIds: string[];
	mode: RpcInboxDeliveryMode;
	/** 每次注入都有独立 token；旧注入延迟消费不能确认新 delivery。 */
	content: string;
	consumed: boolean;
	consumedGeneration?: number;
	/** Host 忙时已接受的队列不是丢失的握手，不能重排同一消息。 */
	waitingForIdle: boolean;
	lastResponseSuccess?: boolean;
	startedAtMs: number;
}

const PRIORITY_WEIGHT: Record<MessagePriority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

const DEFAULT_AGENT_START_TIMEOUT_MS = 60_000;

export class RpcInboxPump {
	private readonly bus: MessageBus;
	private readonly startupMessageIds: ReadonlySet<string>;
	private readonly pollIntervalMs: number;
	private readonly batchSize: number;
	private readonly heartbeatIntervalMs: number;
	private readonly agentStartTimeoutMs: number;
	private timer: NodeJS.Timeout | null = null;
	private ticking = false;
	private activeBatch: ActiveBatch | null = null;
	private currentGeneration = 0;
	private boundary: AgentBoundaryStateSnapshot | null = null;
	private lastHeartbeatMs = 0;
	private stats: RpcInboxPumpStats;
	private agentStartTimer: NodeJS.Timeout | null = null;

	constructor(private readonly options: RpcInboxPumpOptions) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.recipient)) {
			throw new Error(`invalid RPC inbox recipient: ${options.recipient}`);
		}
		if (options.startupMessageIds !== undefined && (!Array.isArray(options.startupMessageIds) || options.startupMessageIds.length > 20)) {
			throw new Error("startupMessageIds must be an array of at most 20 message IDs");
		}
		this.startupMessageIds = new Set((options.startupMessageIds ?? []).map(id => assertSafeOpaqueId(id, "startup messageId")));
		this.bus = new MessageBus(options.fluxDir, { redeliveryAfterMs: options.redeliveryAfterMs });
		this.pollIntervalMs = Math.max(100, Math.min(60_000, options.pollIntervalMs ?? 1_000));
		this.batchSize = Math.max(1, Math.min(20, options.batchSize ?? 5));
		this.heartbeatIntervalMs = Math.max(1_000, Math.min(60_000, options.heartbeatIntervalMs ?? 10_000));
		if (options.agentStartTimeoutMs !== undefined && (!Number.isFinite(options.agentStartTimeoutMs) || options.agentStartTimeoutMs <= 0)) {
			throw new Error("agentStartTimeoutMs must be a positive finite number");
		}
		this.agentStartTimeoutMs = Math.max(1, Math.min(24 * 60 * 60 * 1000, options.agentStartTimeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS));
		this.stats = {
			recipient: options.recipient, running: false, inFlight: false,
			inFlightMessageIds: [], delivered: 0, acknowledged: 0, failed: 0,
		};
	}

	start(options: { immediate?: boolean } = {}): void {
		if (this.timer) return;
		this.stats.running = true;
		this.timer = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
		this.timer.unref?.();
		if (options.immediate !== false) void this.tick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.clearAgentStartWatchdog();
		this.stats.running = false;
		this.activeBatch = null; // 停止后的延迟响应不能确认已移交的 delivery。
		this.boundary = null;
		this.syncInFlightStats();
	}

	async tick(now = new Date()): Promise<number> {
		if (this.ticking) return 0;
		this.maybeHeartbeat(now);
		if (this.activeBatch) {
			this.refreshHandshake(now.getTime());
			return 0;
		}
		this.ticking = true;
		this.stats.lastTickAt = now.toISOString();
		try {
			const messages = this.bus.poll(this.options.recipient, {
				limit: this.batchSize,
				now,
				correlationId: this.options.runId,
				includeUncorrelated: true,
				accept: (envelope, _delivery) => !this.startupMessageIds.has(envelope.id)
					&& (envelope.type !== "steer" || envelope.correlationId === this.options.runId)
					&& (this.options.isRunAccepting?.() ?? true),
			});
			if (messages.length === 0) return 0;
			const mode = this.selectMode(messages);
			const messageIds = messages.map(item => item.envelope.id);
			const content = `AgentFlux delivery batch ${randomUUID()}\n${this.formatMessages(messages)}`;
			// 在 sendUserMessage 前注册，兼容同步发出 user message_start 的宿主。
			this.activeBatch = { messageIds, mode, content, consumed: false, waitingForIdle: !this.options.isIdle(), startedAtMs: Date.now() };
			this.syncInFlightStats();
			if (!this.activeBatch.waitingForIdle) this.armAgentStartWatchdog();
			try {
				if (mode === "steer") this.options.sendUserMessage(content, { deliverAs: "steer" });
				else if (mode === "followUp") this.options.sendUserMessage(content, { deliverAs: "followUp" });
				else this.options.sendUserMessage(content);
				this.stats.delivered += messages.length;
				this.stats.lastDeliveryAt = now.toISOString();
				this.stats.lastError = undefined;
				this.audit({ action: "poll", result: "success", messageIds, mode });
				return messages.length;
			} catch (error: any) {
				this.clearAgentStartWatchdog();
				this.activeBatch = null;
				this.boundary = null;
				this.syncInFlightStats();
				this.stats.failed += messages.length;
				this.stats.lastError = String(error?.message ?? error).slice(0, 500);
				this.audit({
					action: "poll", result: "failure", messageIds, mode, detail: this.stats.lastError,
				});
				return 0;
			}
		} catch (error: any) {
			// 定时器不能产生未处理的拒绝；轮询失败不等于模型失败，也不确认消息。
			this.stats.failed++;
			this.stats.lastError = String(error?.message ?? error).slice(0, 500);
			console.error(`[flux message-v2] ${this.options.recipient} RPC inbox poll failed: ${this.stats.lastError}`);
			this.audit({ action: "poll", result: "failure", messageIds: [], detail: this.stats.lastError });
			return 0;
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * watchdog 只约束尚未消费的注入握手，不对已消费后的模型工作补造硬时限。
	 * 超时保留 delivery；重投使用新的注入 token，旧队列消息不能确认新批次。
	 */
	checkAgentStartTimeout(now = Date.now()): boolean {
		this.refreshHandshake(now);
		const batch = this.activeBatch;
		if (!batch || batch.consumed || batch.waitingForIdle) return false;
		const timeoutMs = this.agentStartTimeoutMs;
		if (now - batch.startedAtMs < timeoutMs) return false;
		this.clearAgentStartWatchdog();
		this.activeBatch = null;
		this.boundary = null;
		this.syncInFlightStats();
		this.stats.failed += batch.messageIds.length;
		this.stats.lastError = `injected user message was not consumed within ${timeoutMs}ms; delivery retained for lease redelivery`;
		this.audit({
			action: "ack", result: "failure", messageIds: batch.messageIds,
			mode: batch.mode, detail: this.stats.lastError,
		});
		return true;
	}

	/** 只有宿主空闲后才有“该启动却未启动”的握手计时依据。 */
	private refreshHandshake(now: number): void {
		const batch = this.activeBatch;
		if (!batch || batch.consumed) return;
		if (!this.options.isIdle()) {
			batch.waitingForIdle = true;
			this.clearAgentStartWatchdog();
		} else if (batch.waitingForIdle) {
			batch.waitingForIdle = false;
			batch.startedAtMs = now;
			this.armAgentStartWatchdog();
		}
	}

	private armAgentStartWatchdog(): void {
		this.clearAgentStartWatchdog();
		this.agentStartTimer = setTimeout(() => { this.checkAgentStartTimeout(); }, this.agentStartTimeoutMs);
		this.agentStartTimer.unref?.();
	}

	private clearAgentStartWatchdog(): void {
		if (this.agentStartTimer) clearTimeout(this.agentStartTimer);
		this.agentStartTimer = null;
	}

	/**
	 * agent_start establishes a new physical generation, but never proves that a
	 * queued message was consumed.  The optional argument lets the sub-entry
	 * share one generation number with its boundary receipt; the no-argument
	 * form keeps the small pump adapter backwards-compatible.
	 */
	onAgentStart(generation?: number): void {
		const next = generation ?? this.currentGeneration + 1;
		if (!Number.isSafeInteger(next) || next < 1) {
			this.boundary = null;
			return;
		}
		this.currentGeneration = next;
		this.boundary = null;
	}

	/**
	 * Cache the authoritative outcome from a legal agent_before_settle
	 * BoundaryState.  agent_settled has no outcome and is intentionally never
	 * used to manufacture one.
	 */
	onAgentBeforeSettle(snapshot: AgentBoundaryStateSnapshot | null): boolean {
		if (!snapshot || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1
			|| !["completed", "aborted", "error"].includes(snapshot.outcome)) {
			this.boundary = null;
			return false;
		}
		if (this.currentGeneration !== snapshot.generation) {
			this.boundary = null;
			return false;
		}
		this.boundary = { ...snapshot };
		if (this.activeBatch?.consumed && this.activeBatch.consumedGeneration === snapshot.generation) {
			// Keep the association explicit for the receipt/settlement audit.
			this.activeBatch.consumedGeneration = snapshot.generation;
		}
		return true;
	}

	/** Alias used by adapters that model the event as a generic boundary. */
	onBoundary(snapshot: AgentBoundaryStateSnapshot | null): boolean {
		return this.onAgentBeforeSettle(snapshot);
	}

	/** Snapshot consumed delivery association before settled clears the batch. */
	getConsumptionForBoundary(): RpcInboxConsumption {
		const batch = this.activeBatch;
		return batch?.consumed
			? { consumed: true, generation: batch.consumedGeneration, messageIds: [...batch.messageIds] }
			: { consumed: false, messageIds: [] };
	}

	/** Pi 在实际消费 user 消息时发出 message_start；入队回执不算消费。 */
	onMessageStart(message: { role?: string; content?: unknown }): void {
		const batch = this.activeBatch;
		if (!batch || message.role !== "user") return;
		const content = typeof message.content === "string" ? message.content
			: Array.isArray(message.content) ? message.content.filter(item => item?.type === "text").map(item => item.text).join("") : "";
		if (content !== batch.content) return;
		batch.consumed = true;
		batch.consumedGeneration = this.currentGeneration > 0 ? this.currentGeneration : undefined;
		batch.lastResponseSuccess = undefined;
		this.clearAgentStartWatchdog();
	}

	/** Intermediate toolUse/error can be replaced by a later retry; boundary outcome wins. */
	onAssistantMessageEnd(success: boolean): number {
		if (this.activeBatch?.consumed) this.activeBatch.lastResponseSuccess = success;
		return 0;
	}

	onAgentSettled(now = new Date()): number {
		const batch = this.activeBatch;
		if (!batch) return 0;
		// This may be the old task settling while a followUp is still queued; it
		// must not reset or ACK the queued delivery.
		if (!batch.consumed) {
			this.refreshHandshake(now.getTime());
			return 0;
		}
		const boundary = this.boundary;
		this.boundary = null;
		this.clearAgentStartWatchdog();
		this.activeBatch = null;
		this.syncInFlightStats();
		const settledSuccessfully = boundary !== null
			&& boundary.generation === batch.consumedGeneration
			&& boundary.outcome === "completed";
		if (!settledSuccessfully || !(this.options.isRunAccepting?.() ?? true)) {
			this.stats.failed += batch.messageIds.length;
			this.stats.lastError = !boundary
				? "missing valid agent_before_settle outcome; delivery retained for lease redelivery"
				: boundary.outcome === "completed"
					? "agent_before_settle generation mismatch; delivery retained for lease redelivery"
					: `agent_before_settle outcome=${boundary.outcome}; delivery retained for lease redelivery`;
			this.audit({
				action: "ack", result: "failure", messageIds: batch.messageIds,
				mode: batch.mode, detail: this.stats.lastError,
			});
			return 0;
		}
		let acknowledged = 0;
		for (const messageId of batch.messageIds) {
			try {
				this.bus.acknowledge(this.options.recipient, messageId, now);
				acknowledged++;
			} catch (error: any) {
				this.stats.lastError = String(error?.message ?? error).slice(0, 500);
			}
		}
		this.stats.acknowledged += acknowledged;
		if (acknowledged > 0) this.stats.lastAcknowledgedAt = now.toISOString();
		if (acknowledged === batch.messageIds.length) this.stats.lastError = undefined;
		this.audit({
			action: "ack", result: acknowledged === batch.messageIds.length ? "success" : "failure",
			messageIds: batch.messageIds, mode: batch.mode,
			detail: acknowledged === batch.messageIds.length ? undefined : this.stats.lastError,
		});
		return acknowledged;
	}

	private audit(event: Parameters<NonNullable<RpcInboxPumpOptions["onAudit"]>>[0]): void {
		try { this.options.onAudit?.(event); }
		catch (error: any) {
			// 观测失败不能清除已经排入 Pi、无法撤销的批次。
			this.stats.lastError = `inbox audit failed: ${String(error?.message ?? error).slice(0, 450)}`;
			console.error(`[flux message-v2] ${this.stats.lastError}`);
		}
	}

	getStats(): RpcInboxPumpStats {
		return { ...this.stats, inFlightMessageIds: [...this.stats.inFlightMessageIds] };
	}

	private selectMode(messages: DeliveredMessageV2[]): RpcInboxDeliveryMode {
		if (this.options.isIdle()) return "prompt";
		const maxPriority = Math.max(...messages.map(item => PRIORITY_WEIGHT[item.envelope.priority]));
		const explicitSteer = messages.some(item => item.envelope.type === "steer");
		return explicitSteer || maxPriority >= PRIORITY_WEIGHT.high ? "steer" : "followUp";
	}

	private formatMessages(messages: DeliveredMessageV2[]): string {
		const lines = messages.map(({ envelope }) =>
			`[${envelope.id}] [${envelope.priority}] [${envelope.type}] from ${envelope.from}: ${envelope.content}`);
		return [
			"=== AgentFlux live inbox ===",
			...lines,
			"Process these messages in this turn. Their delivery will be acknowledged only after this message is consumed and the assistant settles successfully.",
			"=== End AgentFlux live inbox ===",
		].join("\n");
	}

	private syncInFlightStats(): void {
		this.stats.inFlight = !!this.activeBatch;
		this.stats.inFlightMessageIds = this.activeBatch ? [...this.activeBatch.messageIds] : [];
	}

	private maybeHeartbeat(now: Date): void {
		if (!this.options.onHeartbeat || now.getTime() - this.lastHeartbeatMs < this.heartbeatIntervalMs) return;
		try {
			this.options.onHeartbeat(now);
			this.lastHeartbeatMs = now.getTime();
			this.stats.lastHeartbeatAt = now.toISOString();
		} catch (error: any) {
			this.stats.lastError = `heartbeat failed: ${String(error?.message ?? error).slice(0, 450)}`;
		}
	}
}
