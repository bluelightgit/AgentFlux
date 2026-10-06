import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	assertMessageRedeliveryContract,
	collectSessionEvidence,
	countSessionToolCalls,
	findMessageV2Snapshot,
	listCheckpointArtifacts,
	matchesObservedRunForSignal,
} from "./helpers/message-redelivery-evidence";

const birth = { version: 1, pid: 123, platform: "win32", birth: "2026-09-08T10:00:00.0000000Z" };
const signalRun = { id: "run-signal", pid: 123, attempt: 1, status: "running", processIdentity: birth };
assert.equal(matchesObservedRunForSignal(signalRun, signalRun, signalRun.id, 123, "same"), true);
for (const state of ["unknown", "gone", "reused"]) assert.equal(matchesObservedRunForSignal(signalRun, signalRun, signalRun.id, 123, state), false);
for (const change of [{ id: "another" }, { pid: 124 }, { attempt: 2 }, { status: "completed" }, { processIdentity: undefined },
	{ processIdentity: { ...birth, birth: "2026-09-08T10:00:00.0000001Z" } }]) {
	assert.equal(matchesObservedRunForSignal(signalRun, { ...signalRun, ...change }, signalRun.id, 123, "same"), false);
}
assert.equal(matchesObservedRunForSignal(signalRun, signalRun, "another", 123, "same"), false);
console.log("message redelivery signal fence: unknown/reused/changed/terminal ownership refused");

const root = mkdtempSync(join(tmpdir(), "agentflux-message-redelivery-evidence-"));
const fluxDir = join(root, ".agentflux");
const messagesRoot = join(fluxDir, "shared", "messages-v2");
const messageId = "msg2-test-redelivery";
const recipient = "redelivery-peer";
const content = "MESSAGE_REDELIVERY_EVIDENCE_TOKEN";
const firstRun = {
	id: "run-first",
	agent: recipient,
	status: "failed",
	phase: "terminal",
	createdAt: "2026-09-08T10:00:00.000Z",
	finishedAt: "2026-09-08T10:00:01.000Z",
	deadlineAt: undefined,
};
const replacementRun = {
	id: "run-replacement",
	agent: recipient,
	status: "completed",
	phase: "terminal",
	createdAt: "2026-09-08T10:00:03.000Z",
	finishedAt: "2026-09-08T10:00:04.000Z",
	deadlineAt: undefined,
};

try {
	mkdirSync(join(messagesRoot, "envelopes"), { recursive: true });
	mkdirSync(join(messagesRoot, "deliveries", recipient), { recursive: true });
	mkdirSync(join(fluxDir, "runtime", "sessions"), { recursive: true });
	writeFileSync(join(messagesRoot, "envelopes", `${messageId}.json`), JSON.stringify({
		schemaVersion: 2, id: messageId, from: "sender-peer", senderRunId: "sender-run",
		channel: { type: "direct", id: recipient }, type: "message", content,
		recipients: [recipient], priority: "normal", createdAt: "2026-09-08T09:59:59.000Z",
	}));
	writeFileSync(join(messagesRoot, "deliveries", recipient, `${messageId}.json`), JSON.stringify({
		schemaVersion: 2, messageId, recipient, status: "acknowledged", attempts: 2,
		createdAt: "2026-09-08T09:59:59.000Z", deliveredAt: "2026-09-08T10:00:03.100Z",
		acknowledgedAt: "2026-09-08T10:00:03.200Z",
	}));
	mkdirSync(join(fluxDir, "runtime", "runs", "unrelated"), { recursive: true });
	writeFileSync(join(fluxDir, "runtime", "sessions", "peer.jsonl"), [
		JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `inbox ${content}` }] } }),
		JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "REDLIVERY_OK" }] } }),
		JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", name: "flux_agent_message" }] } }),
	].join("\n") + "\n");
	writeFileSync(join(fluxDir, "runtime", "runs", "unrelated", "ordinary.txt"), "retained");

	const snapshot = findMessageV2Snapshot(fluxDir, recipient, content);
	assert.ok(snapshot);
	assert.equal(collectSessionEvidence(fluxDir, [content, "REDLIVERY_OK"]).totals.userNeedleCounts[content], 1);
	assert.equal(collectSessionEvidence(fluxDir, [content, "REDLIVERY_OK"]).totals.assistantExactCounts.REDLIVERY_OK, 1);
	assert.equal(countSessionToolCalls(fluxDir, "flux_agent_message", { pathIncludes: "peer" }), 1);
	assert.deepEqual(listCheckpointArtifacts(fluxDir), []);
	assertMessageRedeliveryContract({
		recipient,
		expectedSender: "sender-peer",
		snapshot,
		firstDelivery: { status: "delivered", attempts: 1, deliveredAt: "2026-09-08T10:00:00.100Z" },
		firstRun,
		replacementRun,
		expectedFirstRunStatus: "failed",
		expectedSenderRunId: "sender-run",
		observations: [
			{ at: "2026-09-08T10:00:00.100Z", status: "delivered", attempts: 1 },
			{ at: "2026-09-08T10:00:03.200Z", status: "acknowledged", attempts: 2 },
		],
	});

	assert.throws(() => assertMessageRedeliveryContract({
		recipient,
		snapshot,
		firstDelivery: { status: "delivered", attempts: 1, deliveredAt: "2026-09-08T10:00:00.100Z" },
		firstRun: { ...firstRun, id: replacementRun.id },
		replacementRun,
		expectedFirstRunStatus: "failed",
		expectedSenderRunId: "sender-run",
	}), /same physical Run id/);
	assert.throws(() => assertMessageRedeliveryContract({
		recipient,
		snapshot: { ...snapshot, envelope: { ...snapshot.envelope, correlationId: "run-first" } },
		firstDelivery: { status: "delivered", attempts: 1, deliveredAt: "2026-09-08T10:00:00.100Z" },
		firstRun,
		replacementRun,
		expectedFirstRunStatus: "failed",
		expectedSenderRunId: "sender-run",
	}), /physical Run fence/);
	assert.throws(() => assertMessageRedeliveryContract({
		recipient,
		snapshot,
		firstDelivery: { status: "delivered", attempts: 1, deliveredAt: "2026-09-08T10:00:00.100Z" },
		firstRun,
		replacementRun,
		expectedFirstRunStatus: "failed",
		expectedSenderRunId: "sender-run",
		ackLoss: {
			lockAcquired: true,
			ackFailureObserved: false,
			firstRunDelivery: { status: "delivered", attempts: 1 },
		},
	}), /ACK-loss did not retain/);

	const marker = "RETRY_TERMINAL_OK";
	const retryFile = join(fluxDir, "runtime/sessions/provider-retry.jsonl");
	const entry = (stopReason: string, errorMessage?: string) => JSON.stringify({ message: {
		role: "assistant", stopReason, errorMessage, content: [{ type: "text", text: marker }],
	} }) + "\n";
	writeFileSync(retryFile, entry("error", "WebSocket error"));
	let retryEvidence = collectSessionEvidence(fluxDir, [marker], { pathIncludes: "provider-retry" });
	assert.equal(retryEvidence.totals.assistantExactCounts[marker], 1);
	assert.equal(retryEvidence.totals.assistantSuccessExactCounts[marker], 0, "error text cannot prove completion");
	appendFileSync(retryFile, entry("aborted") + entry("toolUse") + entry("stop"));
	retryEvidence = collectSessionEvidence(fluxDir, [marker], { pathIncludes: "provider-retry" });
	assert.equal(retryEvidence.totals.assistantExactCounts[marker], 4, "retain raw partial/error matches for audit");
	assert.equal(retryEvidence.totals.assistantSuccessExactCounts[marker], 1, "only the successful terminal response counts");
	appendFileSync(retryFile, entry("stop"));
	assert.equal(collectSessionEvidence(fluxDir, [marker], { pathIncludes: "provider-retry" }).totals.assistantSuccessExactCounts[marker], 2,
		"two successful replies must not be deduplicated into one");
	console.log("message redelivery evidence: contract and successful-terminal counting checks passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
