/** Identity-bound facade exposed to a concrete subagent process. */
import { MessageBus, type MessagePriority } from "./message-bus";
import {
	isTargetAllowed, type AgentMessageAction, type CommunicationPolicy,
} from "./communication-policy";

export interface AgentMessageRuntimeIdentity {
	agent: string;
	instanceId: string;
	runId: string;
	taskId?: string;
}

export interface AgentMessageToolInput {
	action: AgentMessageAction;
	target?: string;
	type?: string;
	content?: string;
	priority?: MessagePriority;
	messageId?: string;
	dedupeKey?: string;
	limit?: number;
}

export interface AgentMessageAuditRecord {
	action: AgentMessageAction;
	agent: string;
	instanceId: string;
	runId: string;
	messageId?: string;
	target?: string;
	result: "success" | "denied" | "failure";
	detail?: string;
}

export class AgentMessageRuntime {
	private readonly bus: MessageBus;

	constructor(
		fluxDir: string,
		private readonly identity: AgentMessageRuntimeIdentity,
		private readonly policy: CommunicationPolicy,
		private readonly audit?: (record: AgentMessageAuditRecord) => void,
	) {
		this.bus = new MessageBus(fluxDir);
	}

	execute(input: AgentMessageToolInput): unknown {
		try {
			this.assertAction(input.action);
			let result: unknown;
			if (input.action === "send") result = this.send(input);
			else if (input.action === "poll") {
				// correlationId 是目标 Run fence；peer handoff 通过 senderRunId 记录发送事实。
				result = this.bus.poll(this.identity.agent, {
					limit: input.limit,
					correlationId: this.identity.runId,
					includeUncorrelated: true,
					accept: envelope => envelope.type !== "steer" || envelope.correlationId === this.identity.runId,
				});
			} else if (input.action === "ack") {
				if (!input.messageId) throw new Error("ack requires messageId");
				const envelope = this.bus.getEnvelope(input.messageId);
				if (!envelope) throw new Error(`message ${input.messageId} not found`);
				if (envelope.correlationId !== undefined && envelope.correlationId !== this.identity.runId) {
					throw new Error(`message ${input.messageId} belongs to another Run`);
				}
				result = this.bus.acknowledge(this.identity.agent, input.messageId);
			} else {
				result = {
					identity: this.identity,
					policy: this.policy,
					outstanding: this.bus.countOutstanding(this.identity.agent),
					cursor: this.bus.getCursor(this.identity.agent),
					sentThisRun: this.sentThisRunCount(),
				};
			}
			const messageId = (result as any)?.envelope?.id ?? (result as any)?.messageId ?? input.messageId;
			this.audit?.({
				action: input.action, agent: this.identity.agent, instanceId: this.identity.instanceId,
				runId: this.identity.runId, target: input.target, messageId, result: "success",
			});
			return result;
		} catch (error: any) {
			const denied = /disabled|not allowed|denied/.test(String(error?.message));
			this.audit?.({
				action: input.action, agent: this.identity.agent, instanceId: this.identity.instanceId,
				runId: this.identity.runId, target: input.target, messageId: input.messageId,
				result: denied ? "denied" : "failure", detail: String(error?.message ?? error).slice(0, 500),
			});
			throw error;
		}
	}

	private assertAction(action: AgentMessageAction): void {
		if (!this.policy.enabled) throw new Error("agent messaging is disabled by policy");
		if (!this.policy.actions.includes(action)) throw new Error(`message action not allowed: ${action}`);
	}

	private send(input: AgentMessageToolInput): unknown {
		const target = input.target?.trim();
		if (!target) throw new Error("send requires target");
		if (!isTargetAllowed(this.policy, target)) throw new Error(`message target not allowed: ${target}`);
		if (!input.content?.trim()) throw new Error("send requires content");
		if (this.sentThisRunCount() >= this.policy.maxMessagesPerRun) {
			throw new Error(`message limit reached for run: ${this.policy.maxMessagesPerRun}`);
		}
		const metadata = {
			priority: input.priority,
			dedupeKey: input.dedupeKey,
			senderRunId: this.identity.runId,
			taskId: this.identity.taskId,
			senderInstanceId: this.identity.instanceId,
		};
		const type = input.type?.trim() || "handoff";
		if (type === "steer") throw new Error("steer requires a target Run fence; use the Agent steer entry");
		if (target === "broadcast") {
			return this.bus.sendBroadcast(this.identity.agent, type, input.content, metadata);
		}
		if (target.startsWith("group:")) {
			return this.bus.sendGroup(this.identity.agent, target.slice("group:".length), type, input.content, metadata);
		}
		return this.bus.sendDirect(this.identity.agent, target, type, input.content, metadata);
	}

	private sentThisRunCount(): number {
		return this.bus.listEnvelopes().filter(envelope =>
			envelope.from === this.identity.agent && (envelope.senderRunId ?? envelope.correlationId) === this.identity.runId).length;
	}
}
