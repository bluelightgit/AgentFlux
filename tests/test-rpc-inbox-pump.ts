import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageBus } from "../src/core/message-bus";
import { SharedBoard } from "../src/core/shared-board";
import { readBoundaryStateOutcome, RpcInboxPump } from "../src/extension/rpc-inbox-pump";

const results: Array<{ name: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: string) {
	results.push({ name, passed, detail });
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
}

const root = mkdtempSync(join(tmpdir(), "agentflux-rpc-inbox-"));
const fluxDir = join(root, ".agentflux");
const bus = new MessageBus(fluxDir);

async function main() {
	try {
		const board = new SharedBoard(fluxDir);
		board.registerRuntimeAgent({
			name: "leased-runtime", role: "rpc-runtime", status: "idle", instanceId: "instance-1",
		}, { now: new Date("2026-07-16T11:59:00.000Z"), leaseMs: 30_000 });
		let leaseConflict = "";
		try {
			board.registerRuntimeAgent({
				name: "leased-runtime", role: "rpc-runtime", status: "idle", instanceId: "instance-2",
			}, { now: new Date("2026-07-16T11:59:10.000Z"), leaseMs: 30_000 });
		} catch (error: any) { leaseConflict = error.message; }
		check("fresh runtime lease rejects a second instance with the same name",
			leaseConflict.includes("already leased"), leaseConflict || "missing conflict");
		check("presence updates are fenced by runtime instance identity",
			board.updateAgentPresence("leased-runtime", { status: "running" }, "instance-2") === false
				&& board.getAgent("leased-runtime")?.status === "idle",
			`status=${board.getAgent("leased-runtime")?.status}`);
		board.registerRuntimeAgent({
			name: "leased-runtime", role: "rpc-runtime", status: "idle", instanceId: "instance-2",
		}, { now: new Date("2026-07-16T11:59:31.000Z"), leaseMs: 30_000 });
		check("expired runtime lease permits explicit instance takeover",
			board.getAgent("leased-runtime")?.instanceId === "instance-2"
				&& board.updateAgentPresence("leased-runtime", { status: "done" }, "instance-1") === false,
			`instance=${board.getAgent("leased-runtime")?.instanceId}`);

		const deferredPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-startup", isIdle: () => true, sendUserMessage: () => {},
		});
		deferredPump.start({ immediate: false });
		check("startup can defer the first poll until the host session is ready",
			deferredPump.getStats().running && !deferredPump.getStats().lastTickAt,
			`running=${deferredPump.getStats().running} tick=${deferredPump.getStats().lastTickAt ?? "deferred"}`);
		deferredPump.stop();

		const idleCalls: Array<{ content: string; mode?: string }> = [];
		const idleMessage = bus.sendDirect("main", "desktop-a", "handoff", "run the verification", { priority: "normal" });
		const idlePump = new RpcInboxPump({
			fluxDir, recipient: "desktop-a", isIdle: () => true,
			sendUserMessage: (content, options) => idleCalls.push({ content, mode: options?.deliverAs }),
		});
		const idleCount = await idlePump.tick(new Date("2026-07-16T12:00:00.000Z"));
		check("idle runtime receives V2 inbox as a new prompt",
			idleCount === 1 && idleCalls.length === 1 && idleCalls[0].mode === undefined
				&& idleCalls[0].content.includes(idleMessage.envelope.id),
			`count=${idleCount} mode=${idleCalls[0]?.mode ?? "prompt"}`);
		check("delivery remains delivered until the injected turn starts and succeeds",
			bus.getDelivery(idleMessage.envelope.id, "desktop-a")?.status === "delivered"
				&& idlePump.onAssistantMessageEnd(true) === 0,
			bus.getDelivery(idleMessage.envelope.id, "desktop-a")?.status ?? "missing");
		idlePump.onAgentStart();
		check("agent_start alone cannot acknowledge a queued prompt", idlePump.onAssistantMessageEnd(true) === 0, "needs actual user consumption");
		idlePump.onMessageStart({ role: "user", content: [{ type: "text", text: idleCalls[0].content }] });
		idlePump.onAssistantMessageEnd(true);
		check("boundary outcome is cached before settlement", idlePump.onAgentBeforeSettle({ generation: 1, outcome: "completed" }), "completed boundary accepted");
		check("successful consumed prompt acknowledges V2 delivery only at settled",
			idlePump.onAgentSettled(new Date("2026-07-16T12:00:01.000Z")) === 1
				&& bus.getDelivery(idleMessage.envelope.id, "desktop-a")?.status === "acknowledged",
			bus.getDelivery(idleMessage.envelope.id, "desktop-a")?.status ?? "missing");
		check("invalid BoundaryState cannot provide a settlement outcome",
			readBoundaryStateOutcome({ outcome: "completed", entries: [], continue: false }) === null,
			"context preview is mandatory");
		check("valid BoundaryState exposes only its native outcome",
			readBoundaryStateOutcome({
				type: "agent_before_settle", entries: [], continue: false,
				context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
				outcome: "completed",
			}) === "completed",
			"completed");
		const noBoundaryMessage = bus.sendDirect("main", "desktop-no-boundary", "handoff", "must wait for native boundary");
		let noBoundaryContent = "";
		const noBoundaryPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-no-boundary", isIdle: () => true,
			sendUserMessage: content => { noBoundaryContent = content; },
		});
		await noBoundaryPump.tick();
		noBoundaryPump.onAgentStart();
		noBoundaryPump.onMessageStart({ role: "user", content: noBoundaryContent });
		noBoundaryPump.onAssistantMessageEnd(true);
		check("agent_settled without a valid before_settle outcome never ACKs", noBoundaryPump.onAgentSettled() === 0
			&& bus.getDelivery(noBoundaryMessage.envelope.id, "desktop-no-boundary")?.status === "delivered", "delivery retained");

		const steerCalls: Array<string | undefined> = [];
		let steerContent = "";
		const steerMessage = bus.sendDirect("main", "desktop-b", "steer", "stop editing generated files", { priority: "critical", correlationId: "desktop-b-run" });
		const steerPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-b", runId: "desktop-b-run", isIdle: () => false,
			sendUserMessage: (content, options) => { steerContent = content; steerCalls.push(options?.deliverAs); },
		});
		await steerPump.tick(new Date("2026-07-16T12:01:00.000Z"));
		check("critical live message is delivered as steer",
			steerCalls[0] === "steer", `mode=${steerCalls[0]}`);
		check("pre-injection streaming response cannot ACK steer", steerPump.onAssistantMessageEnd(true) === 0, "old response ignored");
		steerPump.onAgentStart();
		steerPump.onMessageStart({ role: "user", content: steerContent });
		steerPump.onAssistantMessageEnd(true);
		steerPump.onAgentBeforeSettle({ generation: 1, outcome: "completed" });
		check("consumed steer acknowledges only after successful settled",
			steerPump.onAgentSettled() === 1
				&& bus.getDelivery(steerMessage.envelope.id, "desktop-b")?.status === "acknowledged",
			bus.getDelivery(steerMessage.envelope.id, "desktop-b")?.status ?? "missing");

		const oldRunSteer = bus.sendDirect("main", "desktop-scoped", "steer", "old Run steer", { correlationId: "old-physical-run" });
		const scopedPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-scoped", runId: "new-physical-run", isIdle: () => false,
			sendUserMessage: () => {},
		});
		const scopedCount = await scopedPump.tick(new Date("2026-07-16T12:01:01.000Z"));
		check("RPC pump never consumes a steer correlated to another physical Run",
			scopedCount === 0 && bus.getDelivery(oldRunSteer.envelope.id, "desktop-scoped")?.status === "pending",
			`count=${scopedCount} status=${bus.getDelivery(oldRunSteer.envelope.id, "desktop-scoped")?.status}`);
		bus.reject("desktop-scoped", oldRunSteer.envelope.id, "test cleanup");

		const followCalls: Array<string | undefined> = [];
		let followContent = "";
		const followMessage = bus.sendDirect("main", "desktop-c", "task_update", "after the current task, run tests");
		const followPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-c", isIdle: () => false,
			sendUserMessage: (content, options) => { followContent = content; followCalls.push(options?.deliverAs); },
		});
		await followPump.tick(new Date("2026-07-16T12:02:00.000Z"));
		followPump.onAgentStart();
		const currentTurnAck = followPump.onAssistantMessageEnd(true);
		check("two current-task toolUse responses do not consume followUp", followPump.onAssistantMessageEnd(true) === 0 && bus.getDelivery(followMessage.envelope.id, "desktop-c")?.status === "delivered", "no early ACK");
		check("unrelated task settled preserves queued followUp fence", followPump.onAgentSettled() === 0
			&& followPump.getStats().inFlight && bus.getDelivery(followMessage.envelope.id, "desktop-c")?.status === "delivered", "no ACK and no reset");
		followPump.onMessageStart({ role: "assistant", content: followContent }); // 回显不是 user 注入消费。
		check("assistant echo cannot prove delivery consumption", followPump.onAssistantMessageEnd(true) === 0, "role checked");
		followPump.onMessageStart({ role: "user", content: followContent });
		followPump.onAssistantMessageEnd(true);
		followPump.onAgentBeforeSettle({ generation: 1, outcome: "completed" });
		const followUpAck = followPump.onAgentSettled();
		check("normal live message ACKs on consumed/settled response without a second agent_start",
			followCalls[0] === "followUp" && currentTurnAck === 0 && followUpAck === 1
				&& bus.getDelivery(followMessage.envelope.id, "desktop-c")?.status === "acknowledged",
			`mode=${followCalls[0]} currentAck=${currentTurnAck} followAck=${followUpAck}`);

		const retryCalls: string[] = [];
		const retryMessage = bus.sendDirect("main", "desktop-d", "handoff", "retry after provider failure");
		const retryPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-d", isIdle: () => true,
			sendUserMessage: content => retryCalls.push(content),
		});
		await retryPump.tick(new Date("2026-07-16T12:03:00.000Z"));
		retryPump.onAgentStart();
		retryPump.onMessageStart({ role: "user", content: retryCalls[0] });
		retryPump.onAssistantMessageEnd(false);
		retryPump.onAgentBeforeSettle({ generation: 1, outcome: "error" });
		const failedAck = retryPump.onAgentSettled();
		const beforeLease = await retryPump.tick(new Date("2026-07-16T12:04:00.000Z"));
		const afterLease = await retryPump.tick(new Date("2026-07-16T12:09:00.001Z"));
		check("failed assistant response retains delivery for lease redelivery",
			failedAck === 0 && beforeLease === 0 && afterLease === 1
				&& bus.getDelivery(retryMessage.envelope.id, "desktop-d")?.attempts === 2,
			`before=${beforeLease} after=${afterLease} attempts=${bus.getDelivery(retryMessage.envelope.id, "desktop-d")?.attempts}`);

		const throwingMessage = bus.sendDirect("main", "desktop-e", "handoff", "bridge write fails");
		const throwingPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-e", isIdle: () => true,
			sendUserMessage: () => { throw new Error("RPC stdin closed"); },
		});
		const throwingCount = await throwingPump.tick(new Date("2026-07-16T12:10:00.000Z"));
		check("RPC bridge failure is observable and never acknowledges delivery",
			throwingCount === 0 && throwingPump.getStats().failed === 1
				&& throwingPump.getStats().lastError?.includes("stdin closed") === true
				&& bus.getDelivery(throwingMessage.envelope.id, "desktop-e")?.status === "delivered",
			throwingPump.getStats().lastError ?? "missing error");

		const inFlightMessage = bus.sendDirect("main", "desktop-f", "handoff", "only inject once");
		const inFlightPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-f", isIdle: () => true, sendUserMessage: () => {},
		});
		await inFlightPump.tick(new Date("2026-07-16T12:11:00.000Z"));
		const duplicateTick = await inFlightPump.tick(new Date("2026-07-16T12:20:00.000Z"));
		check("in-flight batch blocks duplicate injection even after lease",
			duplicateTick === 0 && inFlightPump.getStats().inFlightMessageIds[0] === inFlightMessage.envelope.id,
			`duplicate=${duplicateTick} inFlight=${inFlightPump.getStats().inFlightMessageIds.length}`);

		const heartbeats: string[] = [];
		const heartbeatMessage = bus.sendDirect("main", "desktop-heartbeat", "handoff", "long running inbox turn");
		const heartbeatPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-heartbeat", isIdle: () => true,
			heartbeatIntervalMs: 1_000, sendUserMessage: () => {},
			onHeartbeat: now => heartbeats.push(now.toISOString()),
		});
		await heartbeatPump.tick(new Date("2026-07-16T12:21:00.000Z"));
		await heartbeatPump.tick(new Date("2026-07-16T12:21:02.000Z"));
		check("in-flight RPC turn continues renewing its runtime heartbeat",
			heartbeats.length === 2 && heartbeatPump.getStats().lastHeartbeatAt === heartbeats[1]
				&& bus.getDelivery(heartbeatMessage.envelope.id, "desktop-heartbeat")?.status === "delivered",
			`heartbeats=${heartbeats.length} inFlight=${heartbeatPump.getStats().inFlight}`);

		const crashMessage = bus.sendDirect("main", "desktop-crash", "handoff", "recover after process crash");
		const crashedPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-crash", isIdle: () => true,
			redeliveryAfterMs: 1_000, sendUserMessage: () => {},
		});
		await crashedPump.tick(new Date("2026-07-16T12:22:00.000Z"));
		crashedPump.stop();
		const replacementCalls: string[] = [];
		const replacementPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-crash", isIdle: () => true,
			redeliveryAfterMs: 1_000, sendUserMessage: content => replacementCalls.push(content),
		});
		const beforeCrashLease = await replacementPump.tick(new Date("2026-07-16T12:22:00.500Z"));
		const afterCrashLease = await replacementPump.tick(new Date("2026-07-16T12:22:01.001Z"));
		check("replacement runtime redelivers an unacknowledged crashed-process batch after lease",
			beforeCrashLease === 0 && afterCrashLease === 1 && replacementCalls.length === 1
				&& bus.getDelivery(crashMessage.envelope.id, "desktop-crash")?.attempts === 2,
			`before=${beforeCrashLease} after=${afterCrashLease} attempts=${bus.getDelivery(crashMessage.envelope.id, "desktop-crash")?.attempts}`);

		// ── watchdog：prompt 注入后 agent_start 永不触发 → 批次重置、消息保留重投 ──
		const wdCalls: string[] = [];
		const wdMessage = bus.sendDirect("main", "desktop-wd", "handoff", "stuck before agent_start");
		const wdPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-wd", isIdle: () => true,
			agentStartTimeoutMs: 1_000, redeliveryAfterMs: 1_000,
			sendUserMessage: content => wdCalls.push(content),
		});
		await wdPump.tick(new Date("2026-07-16T12:23:00.000Z"));
		check("watchdog arm: batch waits for agent_start",
			wdCalls.length === 1 && wdPump.getStats().inFlightMessageIds[0] === wdMessage.envelope.id,
			`calls=${wdCalls.length} inFlight=${wdPump.getStats().inFlightMessageIds.length}`);
		const timedOut = wdPump.checkAgentStartTimeout(Date.now() + 2_000) ?? false;
		check("watchdog fires and resets the batch after agent_start timeout",
			timedOut === true && wdPump.getStats().inFlightMessageIds.length === 0
				&& (wdPump.getStats().lastError?.includes("retained for lease redelivery") ?? false),
			`timedOut=${timedOut} inFlight=${wdPump.getStats().inFlightMessageIds.length} err=${wdPump.getStats().lastError}`);
		check("watchdog reset keeps the delivery unacknowledged for redelivery",
			bus.getDelivery(wdMessage.envelope.id, "desktop-wd")?.status === "delivered"
				&& bus.getDelivery(wdMessage.envelope.id, "desktop-wd")?.attempts === 1,
			bus.getDelivery(wdMessage.envelope.id, "desktop-wd")?.status ?? "missing");
		const afterWatchdog = await wdPump.tick(new Date("2026-07-16T12:23:03.000Z"));
		check("watchdog reset unblocks later injection after lease",
			afterWatchdog === 1 && wdCalls.length === 2 && wdCalls[0] !== wdCalls[1],
			`after=${afterWatchdog} calls=${wdCalls.length}`);
		wdPump.onMessageStart({ role: "user", content: wdCalls[0] });
		wdPump.onAssistantMessageEnd(true);
		check("late old injection cannot ACK a redelivered batch", wdPump.onAgentSettled() === 0 && bus.getDelivery(wdMessage.envelope.id, "desktop-wd")?.status === "delivered", "batch identity checked");

		// ── 长任务队列不受握手超时限制；空闲后的真正丢失握手仍可重投 ──
		const fuCalls: Array<string | undefined> = [];
		let fuIdle = false;
		const fuMessage = bus.sendDirect("main", "desktop-fu-wd", "task_update", "queued follow-up never drains");
		const fuPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-fu-wd", isIdle: () => fuIdle,
			agentStartTimeoutMs: 1_000,
			sendUserMessage: (_content, options) => fuCalls.push(options?.deliverAs),
		});
		await fuPump.tick(new Date("2026-07-16T12:24:00.000Z"));
		// 当前活动 lifecycle 的 agent_start/settled 均不能证明队列丢失。
		fuPump.onAgentStart();
		// 当前轮次正常结束（第一次 message_end 属于当前轮次，不 ACK followUp）
		fuPump.onAssistantMessageEnd(true);
		check("followUp batch waits for the queued message_end",
			fuCalls[0] === "followUp" && fuPump.getStats().inFlightMessageIds[0] === fuMessage.envelope.id,
			`mode=${fuCalls[0]} inFlight=${fuPump.getStats().inFlightMessageIds.length}`);
		const afterLongWork = Date.now() + 3_600_000;
		check("busy one-hour followUp queue has no handshake timeout", !fuPump.checkAgentStartTimeout(afterLongWork), "no model deadline invented");
		fuPump.onAgentSettled(new Date(afterLongWork));
		await fuPump.tick(new Date(afterLongWork));
		check("busy queue does not reinject after delivery lease expires", fuCalls.length === 1
			&& bus.getDelivery(fuMessage.envelope.id, "desktop-fu-wd")?.attempts === 1, "same accepted queue batch");
		fuIdle = true;
		check("idle transition starts a fresh handshake window", !fuPump.checkAgentStartTimeout(afterLongWork), "queue wait not charged");
		const fuTimedOut = fuPump.checkAgentStartTimeout(afterLongWork + 2_000);
		check("idle lost followUp handshake remains bounded",
			fuTimedOut === true && fuPump.getStats().inFlightMessageIds.length === 0
				&& bus.getDelivery(fuMessage.envelope.id, "desktop-fu-wd")?.status === "delivered",
			`timedOut=${fuTimedOut} inFlight=${fuPump.getStats().inFlightMessageIds.length}`);
		let retryContent = "";
		const autoRetryMail = bus.sendDirect("main", "retry-settled", "message", "handle after retry");
		const autoRetryPump = new RpcInboxPump({ fluxDir, recipient: "retry-settled", isIdle: () => true,
			agentStartTimeoutMs: 1, sendUserMessage: content => { retryContent = content; } });
		await autoRetryPump.tick();
		autoRetryPump.onAgentStart();
		autoRetryPump.onMessageStart({ role: "user", content: retryContent });
		autoRetryPump.onAssistantMessageEnd(false);
		check("consumed batch has no model wall-clock watchdog", !autoRetryPump.checkAgentStartTimeout(Date.now() + 600000), "only handshake is bounded");
		autoRetryPump.onAssistantMessageEnd(true);
		autoRetryPump.onAgentBeforeSettle({ generation: 1, outcome: "completed" });
		check("automatic retry may settle successfully before ACK", autoRetryPump.onAgentSettled() === 1 && bus.getDelivery(autoRetryMail.envelope.id, "retry-settled")?.status === "acknowledged", "final response wins");
		const stoppedMail = bus.sendDirect("main", "retry-settled", "message", "stop before ACK");
		await autoRetryPump.tick(); autoRetryPump.onMessageStart({ role: "user", content: retryContent });
		autoRetryPump.onAssistantMessageEnd(true); autoRetryPump.stop();
		check("stop prevents delayed settled from acknowledging", autoRetryPump.onAgentSettled() === 0 && bus.getDelivery(stoppedMail.envelope.id, "retry-settled")?.status === "delivered", "delivery retained");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	const failed = results.filter(result => !result.passed);
	console.log(`\nRPC inbox pump: ${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
