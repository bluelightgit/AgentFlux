/**
 * AgentFlux lifecycle retention and GC.
 *
 * GC only removes terminal metadata from active registries. Read direct messages
 * and session files are moved into an audit archive; unread/broadcast/group
 * messages and every non-terminal agent are preserved.
 */
import {
	copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync,
	unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RetentionConfig } from "./types";
import { SharedBoard, type AgentInfo, type AgentMessage, type AgentStatus } from "./shared-board";
import type { MessageDeliveryV2, MessageEnvelopeV2 } from "./message-bus";

type JsonRecord = Record<string, any>;

export interface LifecycleGcOptions {
	dryRun?: boolean;
	now?: Date;
	activeRunIds?: string[];
}

export interface LifecycleGcReport {
	runId: string;
	timestamp: string;
	dryRun: boolean;
	blockedReason?: string;
	archivePath?: string;
	removed: {
		roleInstances: string[];
		persistentAgents: string[];
		sharedAgents: string[];
		blackboardStatuses: string[];
		readDirectMessages: string[];
		messageV2Envelopes: string[];
		orphanSessions: string[];
	};
	preserved: {
		nonTerminalAgents: number;
		unreadMessages: number;
		broadcastMessages: number;
		groupMessages: number;
		messageV2Outstanding: number;
		protectedSessions: number;
	};
	warnings: string[];
}

const ROLE_TERMINAL = new Set(["done", "failed"]);
const PERSISTENT_TERMINAL = new Set(["done", "failed", "cancelled"]);
const SHARED_TERMINAL = new Set(["done", "failed", "cancelled"]);
const BLACKBOARD_TERMINAL = new Set(["done", "failed", "cancelled"]);

function parseTimestamp(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function readJson(path: string, fallback: any, warnings: string[]): any {
	if (!existsSync(path)) return fallback;
	try { return JSON.parse(readFileSync(path, "utf-8")); }
	catch (error: any) {
		warnings.push(`cannot parse ${path}: ${error?.message ?? error}`);
		return fallback;
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(value, null, 2), "utf-8");
	renameSync(temporary, path);
}

function validatePolicy(policy: RetentionConfig): string | null {
	for (const value of [policy.terminal_agent_ttl_hours, policy.read_message_ttl_hours, policy.orphan_session_ttl_hours]) {
		if (!Number.isFinite(value) || value < 1) return "retention TTL values must be finite numbers >= 1 hour";
	}
	for (const value of [policy.max_terminal_agents, policy.max_read_messages]) {
		if (!Number.isInteger(value) || value < 0) return "retention maximum values must be integers >= 0";
	}
	return null;
}

function selectExpiredOrExcess<T>(
	items: T[],
	isTerminal: (item: T) => boolean,
	timestampOf: (item: T) => unknown,
	ttlHours: number,
	maxRetained: number,
	nowMs: number,
): T[] {
	const valid = items
		.filter(isTerminal)
		.map(item => ({ item, timestamp: parseTimestamp(timestampOf(item)) }))
		.filter((entry): entry is { item: T; timestamp: number } => entry.timestamp !== null)
		.sort((a, b) => b.timestamp - a.timestamp);
	const expiryMs = ttlHours * 60 * 60 * 1000;
	return valid
		.filter((entry, index) => nowMs - entry.timestamp >= expiryMs || index >= maxRetained)
		.map(entry => entry.item);
}

function roleTimestamp(item: JsonRecord): unknown {
	return item.updatedAt ?? item.completedAt ?? item.createdAt;
}

function pruneRegistryFile(
	path: string,
	key: "instances" | "agents",
	candidateNames: Set<string>,
	terminalStatuses: Set<string>,
	dryRun: boolean,
	warnings: string[],
): { removed: JsonRecord[]; remaining: JsonRecord[] } {
	const root = readJson(path, { [key]: [] }, warnings);
	const items = Array.isArray(root) ? root : Array.isArray(root?.[key]) ? root[key] : [];
	const removed = items.filter((item: JsonRecord) => candidateNames.has(item.name) && terminalStatuses.has(item.status));
	const removedNames = new Set(removed.map((item: JsonRecord) => item.name));
	const remaining = items.filter((item: JsonRecord) => !removedNames.has(item.name));
	if (!dryRun && removed.length > 0) {
		writeJsonAtomic(path, Array.isArray(root) ? remaining : { ...root, [key]: remaining });
	}
	return { removed, remaining };
}

function messageCandidates(messages: AgentMessage[], policy: RetentionConfig, nowMs: number): AgentMessage[] {
	return selectExpiredOrExcess(
		messages,
		message => message.read === true && message.to !== "broadcast",
		message => message.timestamp,
		policy.read_message_ttl_hours,
		policy.max_read_messages,
		nowMs,
	);
}

interface MessageV2ArchiveCandidate {
	envelope: MessageEnvelopeV2;
	deliveries: MessageDeliveryV2[];
	terminalAt: number;
}

const V2_TERMINAL = new Set(["acknowledged", "rejected", "expired"]);

function collectMessageV2Candidates(
	fluxDir: string, policy: RetentionConfig, nowMs: number, warnings: string[],
): { candidates: MessageV2ArchiveCandidate[]; outstanding: number } {
	const root = join(fluxDir, "shared", "messages-v2");
	const envelopesDir = join(root, "envelopes");
	const deliveriesDir = join(root, "deliveries");
	if (!existsSync(envelopesDir)) return { candidates: [], outstanding: 0 };
	const terminal: MessageV2ArchiveCandidate[] = [];
	let outstanding = 0;
	for (const file of readdirSync(envelopesDir).filter(file => file.endsWith(".json"))) {
		const envelope = readJson(join(envelopesDir, file), null, warnings) as MessageEnvelopeV2 | null;
		if (!envelope || !Array.isArray(envelope.recipients)) continue;
		const deliveries = envelope.recipients.map(recipient =>
			readJson(join(deliveriesDir, recipient, `${envelope.id}.json`), null, warnings) as MessageDeliveryV2 | null);
		if (deliveries.some(delivery => !delivery || !V2_TERMINAL.has(delivery.status))) {
			outstanding++;
			continue;
		}
		const completed = deliveries as MessageDeliveryV2[];
		const terminalAt = Math.max(...completed.map(delivery => parseTimestamp(
			delivery.acknowledgedAt ?? delivery.rejectedAt ?? delivery.expiredAt ?? delivery.deliveredAt ?? delivery.createdAt,
		) ?? 0));
		terminal.push({ envelope, deliveries: completed, terminalAt });
	}
	terminal.sort((a, b) => b.terminalAt - a.terminalAt);
	const expiryMs = policy.read_message_ttl_hours * 60 * 60 * 1000;
	const candidates = terminal.filter((candidate, index) =>
		nowMs - candidate.terminalAt >= expiryMs || index >= policy.max_read_messages);
	return { candidates, outstanding };
}

function archiveMessageV2Candidate(
	fluxDir: string, archiveRoot: string, candidate: MessageV2ArchiveCandidate, warnings: string[],
): boolean {
	const sourceRoot = join(fluxDir, "shared", "messages-v2");
	const targetRoot = join(archiveRoot, "messages-v2", candidate.envelope.id);
	try {
		for (const delivery of candidate.deliveries) {
			const source = join(sourceRoot, "deliveries", delivery.recipient, `${candidate.envelope.id}.json`);
			if (!existsSync(source)) throw new Error(`delivery disappeared for ${delivery.recipient}`);
			const target = join(targetRoot, "deliveries", `${delivery.recipient}.json`);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(source, target);
		}
		const envelopeSource = join(sourceRoot, "envelopes", `${candidate.envelope.id}.json`);
		const envelopeTarget = join(targetRoot, "envelope.json");
		mkdirSync(dirname(envelopeTarget), { recursive: true });
		copyFileSync(envelopeSource, envelopeTarget);
		// Envelope is the active-set commit marker. Remove it only after every archive copy succeeded.
		unlinkSync(envelopeSource);
		for (const delivery of candidate.deliveries) {
			const source = join(sourceRoot, "deliveries", delivery.recipient, `${candidate.envelope.id}.json`);
			try { unlinkSync(source); }
			catch (error: any) { warnings.push(`cannot remove archived V2 delivery ${source}: ${error?.message ?? error}`); }
		}
		return true;
	} catch (error: any) {
		warnings.push(`cannot archive Message V2 ${candidate.envelope.id}: ${error?.message ?? error}`);
		return false;
	}
}

function safeArchiveName(now: Date): string {
	return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

function includesAgentSession(file: string, agentName: string): boolean {
	const safe = agentName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
	return file.includes(`flux-${safe}`);
}

export function runLifecycleGc(
	fluxDir: string,
	policy: RetentionConfig,
	options: LifecycleGcOptions = {},
): LifecycleGcReport {
	const now = options.now ?? new Date();
	const nowMs = now.getTime();
	const dryRun = options.dryRun === true;
	const runId = safeArchiveName(now);
	const warnings: string[] = [];
	const report: LifecycleGcReport = {
		runId,
		timestamp: now.toISOString(),
		dryRun,
		removed: {
			roleInstances: [], persistentAgents: [], sharedAgents: [], blackboardStatuses: [],
			readDirectMessages: [], messageV2Envelopes: [], orphanSessions: [],
		},
		preserved: {
			nonTerminalAgents: 0, unreadMessages: 0, broadcastMessages: 0,
			groupMessages: 0, messageV2Outstanding: 0, protectedSessions: 0,
		},
		warnings,
	};

	const policyError = validatePolicy(policy);
	if (policyError) {
		report.blockedReason = policyError;
		return report;
	}
	if (!dryRun && (options.activeRunIds?.length ?? 0) > 0) {
		report.blockedReason = `active subagent runs: ${options.activeRunIds!.join(", ")}`;
		return report;
	}

	const runtimeDir = join(fluxDir, "runtime");
	const roleRegistryPath = join(runtimeDir, "registry.json");
	const persistentRegistryPath = join(runtimeDir, "persistent-agents.json");
	const roleRoot = readJson(roleRegistryPath, { instances: [] }, warnings);
	const persistentRoot = readJson(persistentRegistryPath, { agents: [] }, warnings);
	const roleInstances: JsonRecord[] = Array.isArray(roleRoot?.instances) ? roleRoot.instances : [];
	const persistentAgents: JsonRecord[] = Array.isArray(persistentRoot)
		? persistentRoot
		: Array.isArray(persistentRoot?.agents) ? persistentRoot.agents : [];

	const roleCandidates = selectExpiredOrExcess(
		roleInstances, item => ROLE_TERMINAL.has(item.status), roleTimestamp,
		policy.terminal_agent_ttl_hours, policy.max_terminal_agents, nowMs,
	);
	const persistentCandidates = selectExpiredOrExcess(
		persistentAgents, item => PERSISTENT_TERMINAL.has(item.status), item => item.lastUsedAt ?? item.createdAt,
		policy.terminal_agent_ttl_hours, policy.max_terminal_agents, nowMs,
	);

	const board = new SharedBoard(fluxDir, { ensureDirs: !dryRun });
	const sharedAgents = board.listAgents();
	const sharedCandidates = selectExpiredOrExcess(
		sharedAgents, item => SHARED_TERMINAL.has(item.status), item => item.lastSeen ?? item.registeredAt,
		policy.terminal_agent_ttl_hours, policy.max_terminal_agents, nowMs,
	);
	const blackboard = board.getBlackboard();
	const blackboardEntries = Object.entries(blackboard.agentStatuses).map(([name, status]) => ({ name, status }));
	const blackboardCandidates = selectExpiredOrExcess(
		blackboardEntries,
		item => BLACKBOARD_TERMINAL.has(item.status.status),
		item => item.status.updatedAt,
		policy.terminal_agent_ttl_hours,
		policy.max_terminal_agents,
		nowMs,
	);
	const messages = board.listMessages();
	const messagesToArchive = messageCandidates(messages, policy, nowMs);
	const messageV2 = collectMessageV2Candidates(fluxDir, policy, nowMs, warnings);
	report.preserved.messageV2Outstanding = messageV2.outstanding;
	report.preserved.unreadMessages = messages.filter(message => !message.read).length;
	report.preserved.broadcastMessages = messages.filter(message => message.to === "broadcast").length;
	report.preserved.groupMessages = board.listGroups()
		.reduce((total, group) => total + board.getGroupMessages(group.id).length, 0);

	const roleResult = pruneRegistryFile(
		roleRegistryPath, "instances", new Set(roleCandidates.map(item => item.name)), ROLE_TERMINAL, dryRun, warnings,
	);
	const persistentResult = pruneRegistryFile(
		persistentRegistryPath, "agents", new Set(persistentCandidates.map(item => item.name)), PERSISTENT_TERMINAL, dryRun, warnings,
	);
	const removedShared = dryRun
		? sharedCandidates
		: board.pruneTerminalAgents(sharedCandidates.map(item => item.name));
	const removedBlackboardNames = dryRun
		? blackboardCandidates.map(item => item.name)
		: board.pruneTerminalBlackboardStatuses(blackboardCandidates.map(item => item.name));

	report.removed.roleInstances = roleResult.removed.map(item => item.name);
	report.removed.persistentAgents = persistentResult.removed.map(item => item.name);
	report.removed.sharedAgents = removedShared.map(item => item.name);
	report.removed.blackboardStatuses = removedBlackboardNames;
	report.preserved.nonTerminalAgents = [
		...roleInstances.filter(item => !ROLE_TERMINAL.has(item.status)),
		...persistentAgents.filter(item => !PERSISTENT_TERMINAL.has(item.status)),
		...sharedAgents.filter(item => !SHARED_TERMINAL.has(item.status)),
		...blackboardEntries.filter(item => !BLACKBOARD_TERMINAL.has(item.status.status)),
	].length;

	const potentialChangeCount = roleResult.removed.length + persistentResult.removed.length
		+ removedShared.length + removedBlackboardNames.length + messagesToArchive.length
		+ messageV2.candidates.length;
	const archiveRoot = join(fluxDir, "archive", "lifecycle", runId);
	const archivedMessages = dryRun
		? messagesToArchive
		: board.archiveReadDirectMessages(messagesToArchive.map(message => message.id), join(archiveRoot, "messages"));
	report.removed.readDirectMessages = archivedMessages.map(message => message.id);
	if (dryRun) {
		report.removed.messageV2Envelopes = messageV2.candidates.map(candidate => candidate.envelope.id);
	} else {
		for (const candidate of messageV2.candidates) {
			if (archiveMessageV2Candidate(fluxDir, archiveRoot, candidate, warnings)) {
				report.removed.messageV2Envelopes.push(candidate.envelope.id);
			}
		}
	}

	const removedNames = new Set([
		...report.removed.roleInstances,
		...report.removed.persistentAgents,
		...report.removed.sharedAgents,
		...report.removed.blackboardStatuses,
	]);
	const removedSharedNames = new Set(removedShared.map(agent => agent.name));
	const currentSharedNames = new Set(board.listAgents()
		.filter(agent => !removedSharedNames.has(agent.name))
		.map(agent => agent.name));
	const protectedNames = new Set([
		...roleResult.remaining.map(item => item.name),
		...persistentResult.remaining.map(item => item.name),
		...currentSharedNames,
		...Object.entries(board.getBlackboard().agentStatuses)
			.filter(([name, status]) => !removedBlackboardNames.includes(name) && !BLACKBOARD_TERMINAL.has(status.status))
			.map(([name]) => name),
	]);

	const sessionsDir = join(runtimeDir, "sessions");
	const sessionCandidates: string[] = [];
	if (existsSync(sessionsDir)) {
		for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const file = entry.name;
			const protectedSession = [...protectedNames].some(name => includesAgentSession(file, name));
			if (protectedSession) {
				report.preserved.protectedSessions++;
				continue;
			}
			const belongsToRemoved = [...removedNames].some(name => includesAgentSession(file, name));
			let expired = false;
			try {
				expired = nowMs - statSync(join(sessionsDir, file)).mtimeMs
					>= policy.orphan_session_ttl_hours * 60 * 60 * 1000;
			} catch (error: any) {
				warnings.push(`cannot stat session ${file}: ${error?.message ?? error}`);
			}
			if (belongsToRemoved || expired) sessionCandidates.push(file);
		}
	}

	if (!dryRun && sessionCandidates.length > 0) {
		const sessionArchive = join(archiveRoot, "sessions");
		mkdirSync(sessionArchive, { recursive: true });
		for (const file of sessionCandidates) {
			const source = join(sessionsDir, file);
			if (!existsSync(source)) continue;
			renameSync(source, join(sessionArchive, basename(file)));
			report.removed.orphanSessions.push(file);
		}
	} else {
		report.removed.orphanSessions = [...sessionCandidates];
	}

	const totalChanges = potentialChangeCount + sessionCandidates.length;
	if (!dryRun && totalChanges > 0) {
		mkdirSync(archiveRoot, { recursive: true });
		report.archivePath = archiveRoot;
		writeJsonAtomic(join(archiveRoot, "manifest.json"), {
			...report,
			policy,
			archivedRecords: {
				roleInstances: roleResult.removed,
				persistentAgents: persistentResult.removed,
				sharedAgents: removedShared,
				messages: archivedMessages,
				messageV2: messageV2.candidates
					.filter(candidate => report.removed.messageV2Envelopes.includes(candidate.envelope.id)),
			},
		});
	}
	return report;
}

export function formatLifecycleGcReport(report: LifecycleGcReport): string {
	if (report.blockedReason) return `Lifecycle GC blocked: ${report.blockedReason}`;
	const total = Object.values(report.removed).reduce((sum, items) => sum + items.length, 0);
	return [
		`Lifecycle GC ${report.dryRun ? "dry-run" : "complete"}: ${total} active record/file(s) ${report.dryRun ? "would be archived" : "archived"}`,
		`  role=${report.removed.roleInstances.length} persistent=${report.removed.persistentAgents.length} shared=${report.removed.sharedAgents.length} blackboard=${report.removed.blackboardStatuses.length}`,
		`  messages-v1=${report.removed.readDirectMessages.length} messages-v2=${report.removed.messageV2Envelopes.length} sessions=${report.removed.orphanSessions.length}`,
		`  preserved non-terminal=${report.preserved.nonTerminalAgents} unread=${report.preserved.unreadMessages} broadcast=${report.preserved.broadcastMessages} group=${report.preserved.groupMessages} v2-outstanding=${report.preserved.messageV2Outstanding} protected-sessions=${report.preserved.protectedSessions}`,
		report.archivePath ? `  archive=${report.archivePath}` : "",
		...report.warnings.map(warning => `  warning: ${warning}`),
	].filter(Boolean).join("\n");
}
