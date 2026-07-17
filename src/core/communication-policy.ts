/** Agent communication capability policy and completion contracts. */
import type { MessageBus, MessageChannel, MessageDeliveryV2, MessageEnvelopeV2 } from "./message-bus";

export type AgentMessageAction = "send" | "poll" | "ack" | "status";

export interface CommunicationPolicy {
	enabled: boolean;
	actions: AgentMessageAction[];
	/** Direct names, `broadcast`, `group:<id>`, `group:*`, or `*`. */
	allowedTargets: string[];
	/** A successful run must send at least one run-correlated message to every target. */
	requiredSendTo: string[];
	/** Injected V2 messages must be explicitly acknowledged through the agent tool. */
	requireExplicitInboxAck: boolean;
	maxMessagesPerRun: number;
}

export type CommunicationPolicyInput = Partial<CommunicationPolicy>;

export const DEFAULT_COMMUNICATION_POLICY: CommunicationPolicy = {
	enabled: true,
	actions: ["send", "poll", "ack", "status"],
	allowedTargets: ["*"],
	requiredSendTo: [],
	requireExplicitInboxAck: false,
	maxMessagesPerRun: 20,
};

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	if (["true", "yes", "1", "on"].includes(value.trim().toLowerCase())) return true;
	if (["false", "no", "0", "off"].includes(value.trim().toLowerCase())) return false;
	return undefined;
}

function csv(value: unknown): string[] | undefined {
	if (typeof value !== "string") return undefined;
	const values = value.split(",").map(item => item.trim()).filter(Boolean);
	return values.length > 0 ? values : undefined;
}

/** Parse the flat Markdown frontmatter representation used by role templates. */
export function communicationPolicyFromFrontmatter(frontmatter: Record<string, string>): CommunicationPolicyInput | undefined {
	const enabled = parseBoolean(frontmatter.communication_enabled);
	const actions = csv(frontmatter.communication_actions) as AgentMessageAction[] | undefined;
	const allowedTargets = csv(frontmatter.communication_targets);
	const requiredSendTo = csv(frontmatter.required_handoff_to);
	const requireExplicitInboxAck = parseBoolean(frontmatter.require_explicit_inbox_ack);
	const maxRaw = frontmatter.max_messages_per_run;
	const maxMessagesPerRun = maxRaw !== undefined && /^\d+$/.test(maxRaw) ? Number(maxRaw) : undefined;
	if (enabled === undefined && !actions && !allowedTargets && !requiredSendTo
		&& requireExplicitInboxAck === undefined && maxMessagesPerRun === undefined) return undefined;
	return { enabled, actions, allowedTargets, requiredSendTo, requireExplicitInboxAck, maxMessagesPerRun };
}

const ACTIONS = new Set<AgentMessageAction>(["send", "poll", "ack", "status"]);
const TARGET = /^(?:\*|broadcast|group:\*|group:[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}|[a-zA-Z0-9][a-zA-Z0-9._-]{0,79})$/;

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return [...new Set(value.filter((item): item is string => typeof item === "string")
		.map(item => item.trim()).filter(Boolean))];
}

/** Merge defaults → role template → invocation/registered-instance override. */
export function resolveCommunicationPolicy(
	rolePolicy?: CommunicationPolicyInput,
	runtimeOverride?: CommunicationPolicyInput,
): CommunicationPolicy {
	const merged = { ...DEFAULT_COMMUNICATION_POLICY, ...(rolePolicy ?? {}), ...(runtimeOverride ?? {}) };
	const roleActions = stringList(rolePolicy?.actions);
	const overrideActions = stringList(runtimeOverride?.actions);
	const roleTargets = stringList(rolePolicy?.allowedTargets);
	const overrideTargets = stringList(runtimeOverride?.allowedTargets);
	const roleRequired = stringList(rolePolicy?.requiredSendTo);
	const overrideRequired = stringList(runtimeOverride?.requiredSendTo);
	const actions = (overrideActions ?? roleActions ?? DEFAULT_COMMUNICATION_POLICY.actions)
		.filter((action): action is AgentMessageAction => ACTIONS.has(action as AgentMessageAction));
	const allowedTargets = overrideTargets ?? roleTargets ?? DEFAULT_COMMUNICATION_POLICY.allowedTargets;
	const requiredSendTo = overrideRequired ?? roleRequired ?? DEFAULT_COMMUNICATION_POLICY.requiredSendTo;
	const maxMessagesPerRun = Number.isInteger(merged.maxMessagesPerRun) && merged.maxMessagesPerRun > 0
		? Math.min(100, merged.maxMessagesPerRun) : DEFAULT_COMMUNICATION_POLICY.maxMessagesPerRun;
	const policy: CommunicationPolicy = {
		enabled: merged.enabled !== false,
		actions: [...new Set(actions)],
		allowedTargets: [...new Set(allowedTargets)],
		requiredSendTo: [...new Set(requiredSendTo)],
		requireExplicitInboxAck: merged.requireExplicitInboxAck === true,
		maxMessagesPerRun,
	};
	validateCommunicationPolicy(policy);
	return policy;
}

export function validateCommunicationPolicy(policy: CommunicationPolicy): void {
	if (!policy.enabled && (policy.requiredSendTo.length > 0 || policy.requireExplicitInboxAck)) {
		throw new Error("disabled communication cannot require send or explicit inbox acknowledgement");
	}
	for (const action of policy.actions) {
		if (!ACTIONS.has(action)) throw new Error(`unsupported communication action: ${action}`);
	}
	for (const target of [...policy.allowedTargets, ...policy.requiredSendTo]) {
		if (!TARGET.test(target)) throw new Error(`invalid communication target: ${target}`);
	}
	if (policy.requiredSendTo.length > 0 && !policy.actions.includes("send")) {
		throw new Error("requiredSendTo requires the send action");
	}
	if (policy.requireExplicitInboxAck && !policy.actions.includes("ack")) {
		throw new Error("requireExplicitInboxAck requires the ack action");
	}
	for (const target of policy.requiredSendTo) {
		if (target === "*" || target === "group:*") throw new Error(`required target must be concrete: ${target}`);
		if (!isTargetAllowed(policy, target)) throw new Error(`required target is not allowed: ${target}`);
	}
}

export function isTargetAllowed(policy: CommunicationPolicy, target: string): boolean {
	return policy.allowedTargets.includes("*")
		|| policy.allowedTargets.includes(target)
		|| (target.startsWith("group:") && policy.allowedTargets.includes("group:*"));
}

function channelTarget(channel: MessageChannel): string {
	if (channel.type === "broadcast") return "broadcast";
	if (channel.type === "group") return `group:${channel.id}`;
	return channel.id;
}

export interface CommunicationContractReport {
	passed: boolean;
	requiredSendTo: string[];
	sentTo: string[];
	missingSendTo: string[];
	injectedMessageIds: string[];
	unacknowledgedInbox: string[];
}

/** Evaluate only messages correlated with this concrete run instance. */
export function evaluateCommunicationContract(input: {
	bus: MessageBus;
	policy: CommunicationPolicy;
	sender: string;
	runId: string;
	injectedMessageIds?: string[];
}): CommunicationContractReport {
	const sent = input.bus.listEnvelopes()
		.filter((envelope: MessageEnvelopeV2) => envelope.from === input.sender && envelope.correlationId === input.runId);
	const sentTo = [...new Set(sent.map(envelope => channelTarget(envelope.channel)))];
	const missingSendTo = input.policy.requiredSendTo.filter(target => !sentTo.includes(target));
	const injectedMessageIds = input.injectedMessageIds ?? [];
	const unacknowledgedInbox = input.policy.requireExplicitInboxAck
		? injectedMessageIds.filter(messageId => {
			const delivery: MessageDeliveryV2 | null = input.bus.getDelivery(messageId, input.sender);
			return delivery?.status !== "acknowledged";
		}) : [];
	return {
		passed: missingSendTo.length === 0 && unacknowledgedInbox.length === 0,
		requiredSendTo: [...input.policy.requiredSendTo],
		sentTo,
		missingSendTo,
		injectedMessageIds: [...injectedMessageIds],
		unacknowledgedInbox,
	};
}

export function formatCommunicationContractInstruction(policy: CommunicationPolicy): string | null {
	const lines: string[] = [];
	if (policy.requiredSendTo.length > 0) {
		lines.push(`Before finishing, use flux_agent_message to send a handoff to: ${policy.requiredSendTo.join(", ")}.`);
	}
	if (policy.requireExplicitInboxAck) {
		lines.push("After processing every injected V2 inbox message, acknowledge it with flux_agent_message action=ack.");
	}
	if (lines.length === 0) return null;
	return `=== Enforced communication contract ===\n${lines.join("\n")}\nThe run fails closed if this contract is incomplete.\n=== End communication contract ===`;
}
