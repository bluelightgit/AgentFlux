/** Convert Message/Delivery V2 inbox entries into live pi RPC turns. */
import { MessageBus, type DeliveredMessageV2, type MessagePriority } from "../core/message-bus";

export type RpcInboxDeliveryMode = "prompt" | "steer" | "followUp";

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
}

interface ActiveBatch {
	messageIds: string[];
	mode: RpcInboxDeliveryMode;
	/** followUp must first let the currently active turn finish. */
	waitingForCurrentTurnEnd: boolean;
	/** A fresh prompt must wait for its own subsequent agent_start. */
	waitingForAgentStart: boolean;
}

const PRIORITY_WEIGHT: Record<MessagePriority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

export class RpcInboxPump {
	private readonly bus: MessageBus;
	private readonly pollIntervalMs: number;
	private readonly batchSize: number;
	private readonly heartbeatIntervalMs: number;
	private timer: NodeJS.Timeout | null = null;
	private ticking = false;
	private activeBatch: ActiveBatch | null = null;
	private lastHeartbeatMs = 0;
	private stats: RpcInboxPumpStats;

	constructor(private readonly options: RpcInboxPumpOptions) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.recipient)) {
			throw new Error(`invalid RPC inbox recipient: ${options.recipient}`);
		}
		this.bus = new MessageBus(options.fluxDir, { redeliveryAfterMs: options.redeliveryAfterMs });
		this.pollIntervalMs = Math.max(100, Math.min(60_000, options.pollIntervalMs ?? 1_000));
		this.batchSize = Math.max(1, Math.min(20, options.batchSize ?? 5));
		this.heartbeatIntervalMs = Math.max(1_000, Math.min(60_000, options.heartbeatIntervalMs ?? 10_000));
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
		this.stats.running = false;
	}

	async tick(now = new Date()): Promise<number> {
		if (this.ticking) return 0;
		this.maybeHeartbeat(now);
		if (this.activeBatch) return 0;
		this.ticking = true;
		this.stats.lastTickAt = now.toISOString();
		try {
			const messages = this.bus.poll(this.options.recipient, { limit: this.batchSize, now });
			if (messages.length === 0) return 0;
			const mode = this.selectMode(messages);
			const messageIds = messages.map(item => item.envelope.id);
			// Set the batch before calling pi so synchronous test adapters cannot race the state.
			this.activeBatch = {
				messageIds,
				mode,
				waitingForCurrentTurnEnd: mode === "followUp",
				waitingForAgentStart: mode === "prompt",
			};
			this.syncInFlightStats();
			try {
				const content = this.formatMessages(messages);
				if (mode === "steer") this.options.sendUserMessage(content, { deliverAs: "steer" });
				else if (mode === "followUp") this.options.sendUserMessage(content, { deliverAs: "followUp" });
				else this.options.sendUserMessage(content);
				this.stats.delivered += messages.length;
				this.stats.lastDeliveryAt = now.toISOString();
				this.stats.lastError = undefined;
				this.options.onAudit?.({ action: "poll", result: "success", messageIds, mode });
				return messages.length;
			} catch (error: any) {
				this.activeBatch = null;
				this.syncInFlightStats();
				this.stats.failed += messages.length;
				this.stats.lastError = String(error?.message ?? error).slice(0, 500);
				this.options.onAudit?.({
					action: "poll", result: "failure", messageIds, mode, detail: this.stats.lastError,
				});
				return 0;
			}
		} finally {
			this.ticking = false;
		}
	}

	/** Called for every pi agent_start event. */
	onAgentStart(): void {
		if (this.activeBatch?.waitingForAgentStart && !this.activeBatch.waitingForCurrentTurnEnd) {
			this.activeBatch.waitingForAgentStart = false;
		}
	}

	/** ACK only after the assistant response belonging to the injected batch succeeds. */
	onAssistantMessageEnd(success: boolean, now = new Date()): number {
		const batch = this.activeBatch;
		if (!batch) return 0;
		if (batch.waitingForCurrentTurnEnd) {
			batch.waitingForCurrentTurnEnd = false;
			// pi drains follow-up messages inside the same agent lifecycle and does
			// not emit a second agent_start. The next assistant message_end belongs
			// to the queued follow-up, so it is the ACK boundary.
			batch.waitingForAgentStart = false;
			return 0;
		}
		if (batch.waitingForAgentStart) return 0;
		this.activeBatch = null;
		this.syncInFlightStats();
		if (!success) {
			this.stats.failed += batch.messageIds.length;
			this.stats.lastError = "assistant turn failed; delivery retained for lease redelivery";
			this.options.onAudit?.({
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
		this.options.onAudit?.({
			action: "ack", result: acknowledged === batch.messageIds.length ? "success" : "failure",
			messageIds: batch.messageIds, mode: batch.mode,
			detail: acknowledged === batch.messageIds.length ? undefined : this.stats.lastError,
		});
		return acknowledged;
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
			"Process these messages in this turn. Their delivery will be acknowledged only after a successful assistant response.",
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
