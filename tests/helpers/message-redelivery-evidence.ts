import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isProcessIdentity } from "../../src/core/process-identity";

/** Pure fixture fence; the caller obtains birthState from a fresh OS query. */
export function matchesObservedRunForSignal(recorded: any, latest: any, expectedRunId: string, pid: number, birthState: string): boolean {
	const active = (run: any) => ["starting", "running", "stop_requested"].includes(run?.status);
	return Number.isSafeInteger(pid) && pid > 0 && birthState === "same"
		&& recorded?.id === expectedRunId && latest?.id === expectedRunId
		&& recorded.pid === pid && latest.pid === pid && active(recorded) && active(latest)
		&& Number.isSafeInteger(recorded.attempt) && recorded.attempt > 0 && recorded.attempt === latest.attempt
		&& isProcessIdentity(recorded.processIdentity) && isProcessIdentity(latest.processIdentity)
		&& recorded.processIdentity.pid === pid && latest.processIdentity.pid === pid
		&& recorded.processIdentity.platform === latest.processIdentity.platform
		&& recorded.processIdentity.birth === latest.processIdentity.birth;
}

export interface MessageV2Snapshot {
	messageId: string;
	recipient: string;
	envelopePath: string;
	deliveryPath: string;
	envelope: any;
	delivery: any;
}

export interface DeliveryObservation {
	at: string;
	status?: string;
	attempts?: number;
	deliveredAt?: string;
	acknowledgedAt?: string;
	error?: string;
}

export interface RedeliveryAssertionInput {
	recipient: string;
	expectedSender?: string;
	snapshot: MessageV2Snapshot;
	firstDelivery: {
		status: string;
		attempts: number;
		deliveredAt?: string;
	};
	firstRun: any;
	replacementRun: any;
	expectedFirstRunStatus: "failed" | "cancelled" | "completed";
	observations?: DeliveryObservation[];
	expectedSenderRunId?: string;
	ackLoss?: {
		lockAcquired: boolean;
		ackFailureObserved: boolean;
		firstRunDelivery: { status: string; attempts: number };
		harnessPid?: number;
	};
}

export interface SessionEvidenceFile {
	path: string;
	sha256: string;
	bytes: number;
	parseableLines: number;
	invalidLines: number;
	needleCounts: Record<string, number>;
	userNeedleCounts: Record<string, number>;
	assistantExactCounts: Record<string, number>;
	assistantSuccessExactCounts: Record<string, number>;
}

export interface SessionEvidence {
	files: SessionEvidenceFile[];
	totals: {
		bytes: number;
		parseableLines: number;
		invalidLines: number;
		needleCounts: Record<string, number>;
		userNeedleCounts: Record<string, number>;
		assistantExactCounts: Record<string, number>;
		assistantSuccessExactCounts: Record<string, number>;
	};
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch { return undefined; }
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("");
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let offset = 0;
	while (true) {
		const index = text.indexOf(needle, offset);
		if (index < 0) return count;
		count++;
		offset = index + Math.max(1, needle.length);
	}
}

function emptyCounts(needles: readonly string[]): Record<string, number> {
	return Object.fromEntries(needles.map(needle => [needle, 0]));
}

function addCounts(target: Record<string, number>, source: Record<string, number>): void {
	for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

/** Read one persisted V2 envelope and its recipient-specific delivery without changing state. */
export function readMessageV2Snapshot(fluxDir: string, messageId: string, recipient: string): MessageV2Snapshot | undefined {
	const root = join(fluxDir, "shared", "messages-v2");
	const envelopePath = join(root, "envelopes", `${messageId}.json`);
	const deliveryPath = join(root, "deliveries", recipient, `${messageId}.json`);
	const envelope = readJson(envelopePath);
	const delivery = readJson(deliveryPath);
	if (!envelope || !delivery) return undefined;
	return { messageId, recipient, envelopePath, deliveryPath, envelope, delivery };
}

/** Find a direct V2 envelope by its exact persisted content and logical recipient. */
export function findMessageV2Snapshot(fluxDir: string, recipient: string, content: string): MessageV2Snapshot | undefined {
	const envelopeDir = join(fluxDir, "shared", "messages-v2", "envelopes");
	if (!existsSync(envelopeDir)) return undefined;
	for (const file of readdirSync(envelopeDir).filter(name => name.endsWith(".json"))) {
		const envelope = readJson(join(envelopeDir, file));
		if (!envelope || envelope.content !== content || !Array.isArray(envelope.recipients) || !envelope.recipients.includes(recipient)) continue;
		const messageId = typeof envelope.id === "string" ? envelope.id : file.slice(0, -5);
		const snapshot = readMessageV2Snapshot(fluxDir, messageId, recipient);
		if (snapshot) return snapshot;
	}
	return undefined;
}

/** Read the current run registry without inferring or writing terminal state. */
export function readRuns(fluxDir: string): any[] {
	const store = readJson(join(fluxDir, "runtime", "runs.json"));
	return Array.isArray(store?.runs) ? store.runs : [];
}

export function findRunsForRecipient(fluxDir: string, recipient: string): any[] {
	return readRuns(fluxDir).filter(run => run?.agent === recipient);
}

/** Count persisted assistant tool-call blocks in selected physical session files. */
export function countSessionToolCalls(fluxDir: string, toolName: string, options: { pathIncludes?: string } = {}): number {
	const sessionDir = join(fluxDir, "runtime", "sessions");
	if (!existsSync(sessionDir)) return 0;
	let count = 0;
	for (const name of readdirSync(sessionDir).filter(item => item.endsWith(".jsonl") && (!options.pathIncludes || item.includes(options.pathIncludes)))) {
		for (const line of readFileSync(join(sessionDir, name), "utf8").split(/\r?\n/).filter(Boolean)) {
			try {
				const content = JSON.parse(line)?.message?.content;
				if (!Array.isArray(content)) continue;
				count += content.filter((block: any) => block?.type === "toolCall" && block?.name === toolName).length;
			} catch { /* raw session evidence remains available to the caller */ }
		}
	}
	return count;
}

/**
 * Capture raw session evidence. Counts are derived from persisted JSONL, not from
 * a final assistant sentence, so a fixture cannot claim that a message was seen
 * without retaining the actual user context that contained it.
 */
export function collectSessionEvidence(fluxDir: string, needles: readonly string[], options: { pathIncludes?: string } = {}): SessionEvidence {
	const sessionDir = join(fluxDir, "runtime", "sessions");
	const files: SessionEvidenceFile[] = [];
	const totals: SessionEvidence["totals"] = {
		bytes: 0, parseableLines: 0, invalidLines: 0,
		needleCounts: emptyCounts(needles), userNeedleCounts: emptyCounts(needles),
		assistantExactCounts: emptyCounts(needles), assistantSuccessExactCounts: emptyCounts(needles),
	};
	if (!existsSync(sessionDir)) return { files, totals };
	for (const name of readdirSync(sessionDir).filter(item => item.endsWith(".jsonl") && (!options.pathIncludes || item.includes(options.pathIncludes))).sort()) {
		const path = join(sessionDir, name);
		const text = readFileSync(path, "utf8");
		const needleCounts = emptyCounts(needles);
		const userNeedleCounts = emptyCounts(needles);
		const assistantExactCounts = emptyCounts(needles);
		const assistantSuccessExactCounts = emptyCounts(needles);
		let parseableLines = 0;
		let invalidLines = 0;
		for (const line of text.split(/\r?\n/).filter(Boolean)) {
			for (const needle of needles) needleCounts[needle] += countOccurrences(line, needle);
			try {
				const event = JSON.parse(line);
				parseableLines++;
				const message = event?.message;
				const messageText = textFromContent(message?.content);
				if (message?.role === "user") {
					for (const needle of needles) userNeedleCounts[needle] += countOccurrences(messageText, needle);
				}
				if (message?.role === "assistant") {
					for (const needle of needles) if (messageText.trim() === needle.trim()) {
						assistantExactCounts[needle]++;
						if (message.stopReason === "stop" && !message.errorMessage
							&& (!Array.isArray(message.content) || !message.content.some((block: any) => block?.type === "toolCall"))) {
							assistantSuccessExactCounts[needle]++;
						}
					}
				}
			} catch { invalidLines++; }
		}
		const bytes = statSync(path).size;
		files.push({
			path, sha256: sha256(text), bytes, parseableLines, invalidLines,
			needleCounts, userNeedleCounts, assistantExactCounts, assistantSuccessExactCounts,
		});
		totals.bytes += bytes;
		totals.parseableLines += parseableLines;
		totals.invalidLines += invalidLines;
		addCounts(totals.needleCounts, needleCounts);
		addCounts(totals.userNeedleCounts, userNeedleCounts);
		addCounts(totals.assistantExactCounts, assistantExactCounts);
		addCounts(totals.assistantSuccessExactCounts, assistantSuccessExactCounts);
	}
	return { files, totals };
}

function validTimestamp(value: unknown): boolean {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function requireCondition(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
}

function assertRunShape(run: any, label: string, recipient: string, status: string): void {
	requireCondition(run && typeof run === "object", `${label} Run is missing`);
	requireCondition(run.agent === recipient, `${label} Run recipient mismatch: ${String(run.agent)}`);
	requireCondition(typeof run.id === "string" && run.id.length > 0, `${label} Run has no physical run id`);
	requireCondition(run.status === status, `${label} Run status=${String(run.status)}, expected ${status}`);
	requireCondition(run.deadlineAt === undefined, `${label} Run has a fabricated product deadline: ${String(run.deadlineAt)}`);
	requireCondition(run.phase === "terminal", `${label} Run status is not backed by terminal phase: ${String(run.phase)}`);
	requireCondition(validTimestamp(run.createdAt), `${label} Run has no valid createdAt`);
	requireCondition(validTimestamp(run.finishedAt), `${label} Run has no durable finishedAt`);
}

/**
 * Assert the non-negotiable live redelivery contract. This function only reads
 * evidence; it never acknowledges, edits, terminalizes, or repairs a store.
 */
export function assertMessageRedeliveryContract(input: RedeliveryAssertionInput): void {
	const { snapshot, recipient, firstDelivery, firstRun, replacementRun } = input;
	const envelope = snapshot.envelope;
	const delivery = snapshot.delivery;
	requireCondition(envelope.schemaVersion === 2, "redelivery envelope is not Message V2");
	requireCondition(envelope.id === snapshot.messageId, "redelivery envelope id does not match its path");
	requireCondition(typeof envelope.from === "string" && envelope.from.length > 0,
		"redelivery envelope has no logical sender");
	if (input.expectedSender !== undefined) {
		requireCondition(envelope.from === input.expectedSender,
			`redelivery sender ${String(envelope.from)} does not match ${input.expectedSender}`);
	}
	requireCondition(Array.isArray(envelope.recipients) && envelope.recipients.length === 1 && envelope.recipients[0] === recipient,
		"redelivery must retain one concrete logical recipient");
	requireCondition(envelope.channel?.type === "direct" && envelope.channel?.id === recipient,
		"redelivery must use a direct channel for the same logical recipient");
	requireCondition(envelope.correlationId === undefined,
		"redelivery fixture message must be uncorrelated; a physical Run fence cannot be silently reused");
	requireCondition(typeof envelope.senderRunId === "string" && envelope.senderRunId.length > 0,
		"redelivery must retain the sender physical Run id");
	if (input.expectedSenderRunId !== undefined) {
		requireCondition(envelope.senderRunId === input.expectedSenderRunId,
			`senderRunId ${String(envelope.senderRunId)} does not match the observed sender Run ${input.expectedSenderRunId}`);
	}
	requireCondition(delivery.schemaVersion === 2 && delivery.messageId === snapshot.messageId,
		"recipient delivery is not Message V2 or points at another envelope");
	requireCondition(delivery.recipient === recipient, "delivery recipient changed across redelivery");
	requireCondition(firstDelivery.status === "delivered" && firstDelivery.attempts === 1,
		`first delivery must be observed as delivered/attempt 1, got ${firstDelivery.status}/${firstDelivery.attempts}`);
	requireCondition(validTimestamp(firstDelivery.deliveredAt), "first delivery has no durable deliveredAt");
	requireCondition(delivery.status === "acknowledged", `final delivery status is ${String(delivery.status)}, not acknowledged`);
	requireCondition(delivery.attempts === 2, `expected exactly two delivery attempts, got ${String(delivery.attempts)}`);
	requireCondition(validTimestamp(delivery.deliveredAt), "final delivery has no durable deliveredAt");
	requireCondition(validTimestamp(delivery.acknowledgedAt), "final delivery has no durable acknowledgedAt");
	const firstDeliveredAt = firstDelivery.deliveredAt as string;
	const finalDeliveredAt = delivery.deliveredAt as string;
	const finalAcknowledgedAt = delivery.acknowledgedAt as string;
	assertRunShape(firstRun, "first", recipient, input.expectedFirstRunStatus);
	assertRunShape(replacementRun, "replacement", recipient, "completed");
	requireCondition(firstRun.id !== replacementRun.id, "redelivery reused the same physical Run id");
	requireCondition(envelope.senderRunId !== firstRun.id && envelope.senderRunId !== replacementRun.id,
		"senderRunId was confused with the target physical Run fence");
	requireCondition(Date.parse(finalAcknowledgedAt) >= Date.parse(replacementRun.createdAt),
		"final ACK predates the replacement physical Run");
	requireCondition(Date.parse(finalDeliveredAt) >= Date.parse(firstDeliveredAt),
		"delivery timestamps moved backwards");
	if (input.observations) {
		const deliveredFirst = input.observations.some(item => item.status === "delivered" && item.attempts === 1);
		const acknowledgedSecond = input.observations.some(item => item.status === "acknowledged" && item.attempts === 2);
		requireCondition(deliveredFirst, "evidence has no observed first delivery attempt");
		requireCondition(acknowledgedSecond, "evidence has no observed final ACK attempt");
	}
	if (input.ackLoss) {
		requireCondition(input.ackLoss.lockAcquired, "ACK-loss harness never acquired its fixture-owned lock");
		requireCondition(input.ackLoss.ackFailureObserved, "ACK-loss did not retain an observed ACK failure");
		requireCondition(input.ackLoss.firstRunDelivery.status === "delivered" && input.ackLoss.firstRunDelivery.attempts === 1,
		"ACK-loss first Run did not leave its delivery unacknowledged");
		if (input.ackLoss.harnessPid !== undefined) {
			requireCondition(Number.isInteger(input.ackLoss.harnessPid) && input.ackLoss.harnessPid > 0,
				"ACK-loss harness PID is not a real process identity");
		}
	}
}

function walk(root: string, current: string, output: string[]): void {
	if (!existsSync(current)) return;
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const path = join(current, entry.name);
		if (entry.isDirectory()) walk(root, path, output);
		else if (/checkpoint(?:\.json)?$/i.test(entry.name) || /checkpoint/i.test(relative(root, path))) output.push(path);
	}
}

/** Return checkpoint-like files so a non-Workflow fixture can prove it created none. */
export function listCheckpointArtifacts(fluxDir: string): string[] {
	const output: string[] = [];
	walk(fluxDir, fluxDir, output);
	return output.sort();
}
