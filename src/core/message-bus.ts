/** File-backed Message/Delivery V2 with per-recipient acknowledgement. */
import {
	closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
	statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SharedBoard } from "./shared-board";
import { assertSafeOpaqueId, assertSafePathSegment } from "./safe-path";
import { writeJsonFileAtomic } from "./json-store";
import { isProcessAlive, parseOwnerPid, stealStaleLock } from "./fs-lock";

export type MessageChannel =
	| { type: "direct"; id: string }
	| { type: "broadcast"; id: "all" }
	| { type: "group"; id: string }
	| { type: "system"; id: string };
export type MessagePriority = "low" | "normal" | "high" | "critical";
export type DeliveryStatus = "pending" | "delivered" | "acknowledged" | "rejected" | "expired";

export interface MessageEnvelopeV2 {
	schemaVersion: 2;
	id: string;
	from: string;
	channel: MessageChannel;
	type: string;
	content: string;
	recipients: string[];
	priority: MessagePriority;
	createdAt: string;
	expiresAt?: string;
	dedupeKey?: string;
	correlationId?: string;
	taskId?: string;
	artifactId?: string;
	/** Concrete process/run identity; `from` remains the routable agent identity. */
	senderInstanceId?: string;
}

export interface MessageDeliveryV2 {
	schemaVersion: 2;
	messageId: string;
	recipient: string;
	status: DeliveryStatus;
	attempts: number;
	createdAt: string;
	deliveredAt?: string;
	acknowledgedAt?: string;
	rejectedAt?: string;
	expiredAt?: string;
	rejectionReason?: string;
}

export interface MessageCursorV2 {
	schemaVersion: 2;
	recipient: string;
	lastDeliveredMessageId?: string;
	lastDeliveredAt?: string;
	lastAcknowledgedMessageId?: string;
	lastAcknowledgedAt?: string;
	updatedAt: string;
}

export interface DeliveredMessageV2 {
	envelope: MessageEnvelopeV2;
	delivery: MessageDeliveryV2;
}

export interface SendMessageV2Input {
	from: string;
	recipients: string[];
	channel: MessageChannel;
	type: string;
	content: string;
	priority?: MessagePriority;
	expiresAt?: string;
	dedupeKey?: string;
	correlationId?: string;
	taskId?: string;
	artifactId?: string;
	senderInstanceId?: string;
}

export interface SendMessageV2Result {
	envelope: MessageEnvelopeV2;
	deliveries: MessageDeliveryV2[];
	deduplicated: boolean;
}

export interface MessageBusOptions {
	maxMessageBytes?: number;
	maxRecipients?: number;
	maxPendingPerRecipient?: number;
	redeliveryAfterMs?: number;
}

export class MessageBackpressureError extends Error {
	constructor(public readonly recipient: string, public readonly pending: number, public readonly limit: number) {
		super(`message backpressure for ${recipient}: pending=${pending}, limit=${limit}`);
		this.name = "MessageBackpressureError";
	}
}

const AGENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const PRIORITY_WEIGHT: Record<MessagePriority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

export class MessageBus {
	private readonly root: string;
	private readonly envelopesDir: string;
	private readonly deliveriesDir: string;
	private readonly cursorsDir: string;
	private readonly options: Required<MessageBusOptions>;

	constructor(private readonly fluxDir: string, options: MessageBusOptions = {}) {
		this.root = join(fluxDir, "shared", "messages-v2");
		this.envelopesDir = join(this.root, "envelopes");
		this.deliveriesDir = join(this.root, "deliveries");
		this.cursorsDir = join(this.root, "cursors");
		this.options = {
			maxMessageBytes: options.maxMessageBytes ?? 16 * 1024,
			maxRecipients: options.maxRecipients ?? 100,
			maxPendingPerRecipient: options.maxPendingPerRecipient ?? 100,
			redeliveryAfterMs: options.redeliveryAfterMs ?? 5 * 60 * 1000,
		};
		for (const dir of [this.root, this.envelopesDir, this.deliveriesDir, this.cursorsDir]) {
			mkdirSync(dir, { recursive: true });
		}
	}

	send(input: SendMessageV2Input): SendMessageV2Result {
		this.validateSend(input);
		const recipients = [...new Set(input.recipients)].sort();
		return this.withMutex(() => {
			const dedupeIndex = this.readJson<Record<string, string>>(join(this.root, "_dedupe.json"), {});
			const dedupeHash = input.dedupeKey
				? createHash("sha256").update(`${input.from}\0${input.dedupeKey}`).digest("hex") : undefined;
			if (dedupeHash && dedupeIndex[dedupeHash]) {
				const existing = this.getEnvelope(dedupeIndex[dedupeHash]);
				if (existing) {
					return {
						envelope: existing,
						deliveries: existing.recipients
							.map(recipient => this.getDelivery(existing.id, recipient))
							.filter((delivery): delivery is MessageDeliveryV2 => !!delivery),
						deduplicated: true,
					};
				}
			}

			for (const recipient of recipients) {
				const pending = this.countOutstanding(recipient);
				if (pending >= this.options.maxPendingPerRecipient) {
					throw new MessageBackpressureError(recipient, pending, this.options.maxPendingPerRecipient);
				}
			}

			const now = new Date().toISOString();
			const envelope: MessageEnvelopeV2 = {
				schemaVersion: 2,
				id: `msg2-${randomUUID()}`,
				from: input.from,
				channel: input.channel,
				type: input.type,
				content: input.content,
				recipients,
				priority: input.priority ?? "normal",
				createdAt: now,
				expiresAt: input.expiresAt,
				dedupeKey: input.dedupeKey,
				correlationId: input.correlationId,
				taskId: input.taskId,
				artifactId: input.artifactId,
				senderInstanceId: input.senderInstanceId,
			};
			const deliveries = recipients.map<MessageDeliveryV2>(recipient => ({
				schemaVersion: 2,
				messageId: envelope.id,
				recipient,
				status: "pending",
				attempts: 0,
				createdAt: now,
			}));

			// Delivery first, envelope second: envelope is the commit marker observed by poll().
			for (const delivery of deliveries) this.writeJsonAtomic(this.deliveryPath(delivery.messageId, delivery.recipient), delivery);
			this.writeJsonAtomic(this.envelopePath(envelope.id), envelope);
			if (dedupeHash) {
				dedupeIndex[dedupeHash] = envelope.id;
				this.writeJsonAtomic(join(this.root, "_dedupe.json"), dedupeIndex);
			}
			return { envelope, deliveries, deduplicated: false };
		});
	}

	sendDirect(from: string, to: string, type: string, content: string, metadata: Omit<Partial<SendMessageV2Input>, "from" | "recipients" | "channel" | "type" | "content"> = {}): SendMessageV2Result {
		return this.send({ ...metadata, from, recipients: [to], channel: { type: "direct", id: to }, type, content });
	}

	sendBroadcast(from: string, type: string, content: string, metadata: Omit<Partial<SendMessageV2Input>, "from" | "recipients" | "channel" | "type" | "content"> = {}): SendMessageV2Result {
		const board = new SharedBoard(this.fluxDir);
		const recipients = board.listAgents().map(agent => agent.name).filter(name => name !== from);
		return this.send({ ...metadata, from, recipients, channel: { type: "broadcast", id: "all" }, type, content });
	}

	sendGroup(from: string, groupId: string, type: string, content: string, metadata: Omit<Partial<SendMessageV2Input>, "from" | "recipients" | "channel" | "type" | "content"> = {}): SendMessageV2Result {
		const board = new SharedBoard(this.fluxDir);
		const group = board.listGroups().find(candidate => candidate.id === groupId);
		if (!group) throw new Error(`Group ${groupId} not found`);
		if (!group.members.includes(from) && group.type !== "all") throw new Error(`${from} is not a member of group ${groupId}`);
		const recipients = group.members.filter(name => name !== from);
		return this.send({ ...metadata, from, recipients, channel: { type: "group", id: groupId }, type, content });
	}

	poll(recipient: string, options: { limit?: number; now?: Date } = {}): DeliveredMessageV2[] {
		this.validateAgentName(recipient, "recipient");
		const now = options.now ?? new Date();
		const limit = Math.max(1, Math.min(100, options.limit ?? 20));
		return this.withMutex(() => {
			const dir = this.recipientDir(recipient);
			if (!existsSync(dir)) return [];
			const candidates: DeliveredMessageV2[] = [];
			for (const file of readdirSync(dir).filter(file => file.endsWith(".json"))) {
				const delivery = this.readJson<MessageDeliveryV2 | null>(join(dir, file), null);
				if (!delivery || ["acknowledged", "rejected", "expired"].includes(delivery.status)) continue;
				const envelope = this.getEnvelope(delivery.messageId);
				if (!envelope) continue;
				if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= now.getTime()) {
					delivery.status = "expired";
					delivery.expiredAt = now.toISOString();
					this.writeJsonAtomic(this.deliveryPath(delivery.messageId, recipient), delivery);
					continue;
				}
				if (delivery.status === "delivered") {
					const deliveredAt = delivery.deliveredAt ? Date.parse(delivery.deliveredAt) : 0;
					if (now.getTime() - deliveredAt < this.options.redeliveryAfterMs) continue;
				}
				candidates.push({ envelope, delivery });
			}
			candidates.sort((a, b) =>
				PRIORITY_WEIGHT[b.envelope.priority] - PRIORITY_WEIGHT[a.envelope.priority]
				|| a.envelope.createdAt.localeCompare(b.envelope.createdAt));
			const selected = candidates.slice(0, limit);
			for (const item of selected) {
				item.delivery.status = "delivered";
				item.delivery.attempts++;
				item.delivery.deliveredAt = now.toISOString();
				this.writeJsonAtomic(this.deliveryPath(item.delivery.messageId, recipient), item.delivery);
			}
			if (selected.length > 0) {
				const last = selected[selected.length - 1];
				const cursor = this.getCursor(recipient);
				this.writeCursor({
					...cursor,
					lastDeliveredMessageId: last.envelope.id,
					lastDeliveredAt: now.toISOString(),
					updatedAt: now.toISOString(),
				});
			}
			return selected;
		});
	}

	/** Read an inbox without changing delivery state. */
	peek(recipient: string, options: { limit?: number; includeTerminal?: boolean } = {}): DeliveredMessageV2[] {
		this.validateAgentName(recipient, "recipient");
		const dir = this.recipientDir(recipient);
		if (!existsSync(dir)) return [];
		const limit = Math.max(1, Math.min(100, options.limit ?? 20));
		return readdirSync(dir)
			.filter(file => file.endsWith(".json"))
			.map(file => this.readJson<MessageDeliveryV2 | null>(join(dir, file), null))
			.filter((delivery): delivery is MessageDeliveryV2 => !!delivery)
			.filter(delivery => options.includeTerminal || ["pending", "delivered"].includes(delivery.status))
			.map(delivery => ({ delivery, envelope: this.getEnvelope(delivery.messageId) }))
			.filter((item): item is DeliveredMessageV2 => !!item.envelope)
			.sort((a, b) =>
				PRIORITY_WEIGHT[b.envelope.priority] - PRIORITY_WEIGHT[a.envelope.priority]
				|| a.envelope.createdAt.localeCompare(b.envelope.createdAt))
			.slice(0, limit);
	}

	acknowledge(recipient: string, messageId: string, now = new Date()): MessageDeliveryV2 {
		return this.finishDelivery(recipient, messageId, "acknowledged", now);
	}

	reject(recipient: string, messageId: string, reason: string, now = new Date()): MessageDeliveryV2 {
		return this.finishDelivery(recipient, messageId, "rejected", now, reason);
	}

	getEnvelope(messageId: string): MessageEnvelopeV2 | null {
		return this.readJson<MessageEnvelopeV2 | null>(this.envelopePath(messageId), null);
	}

	listEnvelopes(): MessageEnvelopeV2[] {
		if (!existsSync(this.envelopesDir)) return [];
		return readdirSync(this.envelopesDir)
			.filter(file => file.endsWith(".json"))
			.map(file => this.readJson<MessageEnvelopeV2 | null>(join(this.envelopesDir, file), null))
			.filter((envelope): envelope is MessageEnvelopeV2 => !!envelope)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	getDelivery(messageId: string, recipient: string): MessageDeliveryV2 | null {
		return this.readJson<MessageDeliveryV2 | null>(this.deliveryPath(messageId, recipient), null);
	}

	getCursor(recipient: string): MessageCursorV2 {
		this.validateAgentName(recipient, "recipient");
		return this.readJson<MessageCursorV2>(join(this.cursorsDir, `${recipient}.json`), {
			schemaVersion: 2, recipient, updatedAt: new Date(0).toISOString(),
		});
	}

	countOutstanding(recipient: string): number {
		const dir = this.recipientDir(recipient);
		if (!existsSync(dir)) return 0;
		let count = 0;
		for (const file of readdirSync(dir).filter(file => file.endsWith(".json"))) {
			const delivery = this.readJson<MessageDeliveryV2 | null>(join(dir, file), null);
			if (delivery && ["pending", "delivered"].includes(delivery.status) && this.getEnvelope(delivery.messageId)) count++;
		}
		return count;
	}

	/** Coordinate maintenance mutations with send/poll/ack without exposing the lock implementation. */
	withExclusiveMaintenance<T>(operation: () => T): T {
		return this.withMutex(operation, 5_000);
	}

	private finishDelivery(recipient: string, messageId: string, status: "acknowledged" | "rejected", now: Date, reason?: string): MessageDeliveryV2 {
		this.validateAgentName(recipient, "recipient");
		return this.withMutex(() => {
			const delivery = this.getDelivery(messageId, recipient);
			if (!delivery) throw new Error(`delivery ${messageId} for ${recipient} not found`);
			if (delivery.status === status) return delivery;
			if (["acknowledged", "rejected", "expired"].includes(delivery.status)) {
				throw new Error(`delivery ${messageId} is already ${delivery.status}`);
			}
			if (status === "acknowledged" && delivery.status !== "delivered") {
				throw new Error(`delivery ${messageId} must be delivered before acknowledgement`);
			}
			delivery.status = status;
			if (status === "acknowledged") delivery.acknowledgedAt = now.toISOString();
			else {
				delivery.rejectedAt = now.toISOString();
				delivery.rejectionReason = reason?.slice(0, 500) || "rejected";
			}
			this.writeJsonAtomic(this.deliveryPath(messageId, recipient), delivery);
			if (status === "acknowledged") {
				const cursor = this.getCursor(recipient);
				this.writeCursor({
					...cursor,
					lastAcknowledgedMessageId: messageId,
					lastAcknowledgedAt: now.toISOString(),
					updatedAt: now.toISOString(),
				});
			}
			return delivery;
		});
	}

	private validateSend(input: SendMessageV2Input): void {
		this.validateAgentName(input.from, "sender");
		if (!input.type.trim() || input.type.length > 80) throw new Error("message type must be 1-80 characters");
		if (!input.content.trim()) throw new Error("message content cannot be empty");
		if (Buffer.byteLength(input.content, "utf-8") > this.options.maxMessageBytes) {
			throw new Error(`message exceeds ${this.options.maxMessageBytes} bytes`);
		}
		const recipients = [...new Set(input.recipients)];
		if (recipients.length === 0) throw new Error("message requires at least one recipient");
		if (recipients.length > this.options.maxRecipients) throw new Error(`message exceeds ${this.options.maxRecipients} recipients`);
		for (const recipient of recipients) this.validateAgentName(recipient, "recipient");
		if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt))) throw new Error("expiresAt must be an ISO timestamp");
		if (input.dedupeKey && input.dedupeKey.length > 200) throw new Error("dedupeKey exceeds 200 characters");
		if (input.senderInstanceId && input.senderInstanceId.length > 160) throw new Error("senderInstanceId exceeds 160 characters");
	}

	private validateAgentName(name: string, label: string): void {
		if (!AGENT_NAME.test(name)) throw new Error(`invalid ${label} name: ${name}`);
		assertSafePathSegment(name, `${label} name`);
	}

	private recipientDir(recipient: string): string {
		return join(this.deliveriesDir, recipient);
	}

	private envelopePath(messageId: string): string {
		return join(this.envelopesDir, `${assertSafeOpaqueId(messageId, "messageId")}.json`);
	}

	private deliveryPath(messageId: string, recipient: string): string {
		this.validateAgentName(recipient, "recipient");
		assertSafeOpaqueId(messageId, "messageId");
		const dir = this.recipientDir(recipient);
		mkdirSync(dir, { recursive: true });
		return join(dir, `${messageId}.json`);
	}

	private writeCursor(cursor: MessageCursorV2): void {
		this.writeJsonAtomic(join(this.cursorsDir, `${cursor.recipient}.json`), cursor);
	}

	private readJson<T>(path: string, fallback: T): T {
		if (!existsSync(path)) return fallback;
		try { return JSON.parse(readFileSync(path, "utf-8")) as T; }
		catch (error) {
			throw new Error(`Message V2 state is corrupt and was not overwritten: ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private writeJsonAtomic(path: string, value: unknown): void {
		// Message V2 has an envelope commit marker and explicit audit archival.
		// Sidecar .bak files would bypass GC retention and keep acknowledged content alive.
		writeJsonFileAtomic(path, value, { backup: false });
	}

	private withMutex<T>(operation: () => T, timeoutMs = 2_000): T {
		const lockPath = join(this.root, ".mutex.lock");
		const deadline = Date.now() + timeoutMs;
		const waiter = new Int32Array(new SharedArrayBuffer(4));
		const owner = `${process.pid}:${randomUUID()}`;
		do {
			let fd: number | null = null;
			try {
				fd = openSync(lockPath, "wx");
				writeFileSync(fd, owner);
				closeSync(fd);
				fd = null;
				try { return operation(); }
				finally {
					try {
						if (readFileSync(lockPath, "utf-8") === owner) unlinkSync(lockPath);
					} catch {}
				}
			} catch (error: any) {
				if (error?.code !== "EEXIST") throw error;
				let stale = false;
				try {
					if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
						// 时间超时且持有者进程已消失才算过期；活进程的锁不可偷（长写保护）
						let owner = "";
						try { owner = readFileSync(lockPath, "utf-8"); } catch {}
						const pid = parseOwnerPid(owner);
						stale = pid !== undefined && !isProcessAlive(pid);
					}
				} catch {}
				if (stale) {
					stealStaleLock(lockPath);
				}
				Atomics.wait(waiter, 0, 0, 10);
			} finally {
				if (fd !== null) closeSync(fd);
			}
		} while (Date.now() < deadline);
		throw new Error("MessageBus mutex timeout");
	}
}
