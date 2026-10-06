import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MessageBus } from "../src/core/message-bus";
import { RpcInboxPump } from "../src/extension/rpc-inbox-pump";

const root = mkdtempSync(join(tmpdir(), "startup-inbox-ownership-"));
const fluxDir = join(root, ".agentflux");
const bus = new MessageBus(fluxDir, { redeliveryAfterMs: 1000 });
const base = Date.now();
const at = (delta: number) => new Date(base + delta);
const pumps: RpcInboxPump[] = [];
try {
	const startup = bus.sendDirect("sender", "receiver", "handoff", "startup payload");
	assert.equal(bus.poll("receiver", { now: at(100), correlationId: "first-run", includeUncorrelated: true }).length, 1);
	const calls: string[] = [];
	const pump = new RpcInboxPump({ fluxDir, recipient: "receiver", runId: "first-run", startupMessageIds: [startup.envelope.id],
		redeliveryAfterMs: 1000, isIdle: () => false, sendUserMessage: content => calls.push(content) });
	pumps.push(pump);
	assert.equal(await pump.tick(at(2000)), 0);
	assert.equal(await pump.tick(at(3600000)), 0, "lease expiry must not duplicate a Host-owned startup item in the same Run");
	assert.equal(calls.length, 0);
	assert.equal(bus.getDelivery(startup.envelope.id, "receiver")?.attempts, 1);
	assert.equal(bus.getDelivery(startup.envelope.id, "receiver")?.status, "delivered");
	const later = bus.sendDirect("sender", "receiver", "message", "normal follow-up");
	assert.equal(await pump.tick(at(3600100)), 1, "startup ownership must not block subsequent messages");
	assert.ok(calls[0].includes(later.envelope.id)); assert.ok(!calls[0].includes(startup.envelope.id));
	pump.onAgentStart(1);
	pump.onMessageStart({ role: "user", content: [{ type: "text", text: calls[0] }] });
	pump.onAssistantMessageEnd(true);
	assert.equal(pump.onAgentBeforeSettle({ generation: 1, outcome: "completed" }), true);
	assert.equal(pump.onAgentSettled(at(3600200)), 1);
	assert.equal(bus.getDelivery(later.envelope.id, "receiver")?.status, "acknowledged");
	assert.equal(bus.getDelivery(startup.envelope.id, "receiver")?.status, "delivered", "RPC cannot acknowledge Host-owned startup delivery");
	pump.stop();

	const retryCalls: string[] = [];
	const retry = new RpcInboxPump({ fluxDir, recipient: "receiver", runId: "replacement-run", redeliveryAfterMs: 1000,
		isIdle: () => true, sendUserMessage: content => retryCalls.push(content) });
	pumps.push(retry);
	assert.equal(await retry.tick(at(3600300)), 1, "replacement Run must still receive a crashed or ACK-lost startup delivery");
	assert.equal(bus.getDelivery(startup.envelope.id, "receiver")?.attempts, 2);
	retry.onAgentStart(1);
	retry.onMessageStart({ role: "user", content: [{ type: "text", text: retryCalls[0] }] });
	retry.onAssistantMessageEnd(true);
	assert.equal(retry.onAgentBeforeSettle({ generation: 1, outcome: "completed" }), true);
	assert.equal(retry.onAgentSettled(at(3600400)), 1);
	assert.equal(bus.getDelivery(startup.envelope.id, "receiver")?.status, "acknowledged");

	const lockedMessage = bus.sendDirect("sender", "lock-target", "message", "mutex recovery");
	const lockCalls: string[] = [];
	const audits: any[] = [];
	const lockPump = new RpcInboxPump({ fluxDir, recipient: "lock-target", isIdle: () => true,
		sendUserMessage: content => lockCalls.push(content), onAudit: event => audits.push(event) });
	pumps.push(lockPump);
	const lockPath = join(fluxDir, "shared/messages-v2/.mutex.lock");
	writeFileSync(lockPath, `${process.pid}:owned-test-mutex`, { flag: "wx" });
	assert.equal(await lockPump.tick(), 0, "a live mutex timeout must not reject the timer promise or crash Pi");
	assert.match(lockPump.getStats().lastError ?? "", /MessageBus mutex timeout/);
	assert.equal(lockPump.getStats().failed, 1);
	assert.equal(audits.at(-1).result, "failure");
	assert.equal(lockCalls.length, 0);
	assert.equal(bus.getDelivery(lockedMessage.envelope.id, "lock-target")?.status, "pending");
	assert.equal(bus.getDelivery(lockedMessage.envelope.id, "lock-target")?.attempts, 0);
	assert.equal(readFileSync(lockPath, "utf8"), `${process.pid}:owned-test-mutex`);
	unlinkSync(lockPath);
	assert.equal(await lockPump.tick(), 1, "polling must recover after the real mutex is released");
	lockPump.onAgentStart(1);
	lockPump.onMessageStart({ role: "user", content: lockCalls[0] }); lockPump.onAssistantMessageEnd(true);
	assert.equal(lockPump.onAgentBeforeSettle({ generation: 1, outcome: "completed" }), true);
	assert.equal(lockPump.onAgentSettled(), 1);

	const auditMessage = bus.sendDirect("sender", "audit-target", "message", "keep accepted batch");
	const auditCalls: string[] = [];
	const auditPump = new RpcInboxPump({ fluxDir, recipient: "audit-target", isIdle: () => false,
		sendUserMessage: content => auditCalls.push(content), onAudit: () => { throw new Error("audit fixture failure"); } });
	pumps.push(auditPump);
	assert.equal(await auditPump.tick(), 1);
	assert.equal(auditPump.getStats().inFlight, true, "failed audit cannot retract an already accepted follow-up");
	assert.equal(await auditPump.tick(at(7200000)), 0);
	assert.equal(auditCalls.length, 1);
	auditPump.onAgentStart(1);
	auditPump.onMessageStart({ role: "user", content: auditCalls[0] }); auditPump.onAssistantMessageEnd(true);
	assert.equal(auditPump.onAgentBeforeSettle({ generation: 1, outcome: "completed" }), true);
	assert.equal(auditPump.onAgentSettled(), 1);
	assert.equal(bus.getDelivery(auditMessage.envelope.id, "audit-target")?.status, "acknowledged");
	assert.equal(bus.getDelivery(auditMessage.envelope.id, "audit-target")?.attempts, 1);

	const options = { fluxDir, recipient: "receiver", isIdle: () => true, sendUserMessage: () => {} };
	assert.throws(() => new RpcInboxPump({ ...options, startupMessageIds: "wrong" as any }), /array/);
	assert.throws(() => new RpcInboxPump({ ...options, startupMessageIds: Array(21).fill("msg-many") }), /at most 20/);
	assert.throws(() => new RpcInboxPump({ ...options, startupMessageIds: ["../escape"] }), /startup messageId/);
	const runner = readFileSync(resolve(import.meta.dirname, "../src/agents/agent-runner.ts"), "utf8");
	const entry = readFileSync(resolve(import.meta.dirname, "../src/subagent-entry.ts"), "utf8");
	assert.ok(runner.includes("AGENTFLUX_STARTUP_MESSAGE_IDS: JSON.stringify(inboxInjection.v2MessageIds)"));
	assert.ok(runner.includes("redeliveryAfterMs: loadConfig(cwd).communication.redelivery_after_ms"));
	assert.ok(entry.includes('startupMessageIds: parseStartupMessageIds(process.env.AGENTFLUX_STARTUP_MESSAGE_IDS)'));
	console.log("Startup inbox ownership checks passed (same-Run exclusion, normal follow-up, replacement redelivery/ACK, mutex timeout/recovery, audit failure, input validation and entry plumbing)");
} finally { for (const pump of pumps) pump.stop(); rmSync(root, { recursive: true, force: true }); }
