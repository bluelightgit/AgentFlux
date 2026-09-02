import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageBus } from "../src/core/message-bus";
import { SharedBoard } from "../src/core/shared-board";
import { RpcInboxPump } from "../src/extension/rpc-inbox-pump";

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
		check("successful injected prompt acknowledges V2 delivery",
			idlePump.onAssistantMessageEnd(true, new Date("2026-07-16T12:00:01.000Z")) === 1
				&& bus.getDelivery(idleMessage.envelope.id, "desktop-a")?.status === "acknowledged",
			bus.getDelivery(idleMessage.envelope.id, "desktop-a")?.status ?? "missing");

		const steerCalls: Array<string | undefined> = [];
		const steerMessage = bus.sendDirect("main", "desktop-b", "steer", "stop editing generated files", { priority: "critical" });
		const steerPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-b", isIdle: () => false,
			sendUserMessage: (_content, options) => steerCalls.push(options?.deliverAs),
		});
		await steerPump.tick(new Date("2026-07-16T12:01:00.000Z"));
		check("critical live message is delivered as steer",
			steerCalls[0] === "steer", `mode=${steerCalls[0]}`);
		check("steered turn acknowledges on its next successful assistant response",
			steerPump.onAssistantMessageEnd(true) === 1
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
		const followMessage = bus.sendDirect("main", "desktop-c", "task_update", "after the current task, run tests");
		const followPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-c", isIdle: () => false,
			sendUserMessage: (_content, options) => followCalls.push(options?.deliverAs),
		});
		await followPump.tick(new Date("2026-07-16T12:02:00.000Z"));
		const currentTurnAck = followPump.onAssistantMessageEnd(true);
		const followUpAck = followPump.onAssistantMessageEnd(true);
		check("normal live message ACKs on the queued response without a second agent_start",
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
		const failedAck = retryPump.onAssistantMessageEnd(false);
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
			afterWatchdog === 1 && wdCalls.length === 2,
			`after=${afterWatchdog} calls=${wdCalls.length}`);
		wdPump.onAssistantMessageEnd(true);

		// ── followUp 卡死（下一次 message_end 永不出现）同样由 watchdog 兜底 ──
		const fuCalls: Array<string | undefined> = [];
		const fuMessage = bus.sendDirect("main", "desktop-fu-wd", "task_update", "queued follow-up never drains");
		const fuPump = new RpcInboxPump({
			fluxDir, recipient: "desktop-fu-wd", isIdle: () => false,
			agentStartTimeoutMs: 1_000,
			sendUserMessage: (_content, options) => fuCalls.push(options?.deliverAs),
		});
		await fuPump.tick(new Date("2026-07-16T12:24:00.000Z"));
		// 某些宿主会为当前活动 lifecycle 再发 agent_start；不能清掉 followUp watchdog。
		fuPump.onAgentStart();
		// 当前轮次正常结束（第一次 message_end 属于当前轮次，不 ACK followUp）
		fuPump.onAssistantMessageEnd(true);
		check("followUp batch waits for the queued message_end",
			fuCalls[0] === "followUp" && fuPump.getStats().inFlightMessageIds[0] === fuMessage.envelope.id,
			`mode=${fuCalls[0]} inFlight=${fuPump.getStats().inFlightMessageIds.length}`);
		const fuTimedOut = fuPump.checkAgentStartTimeout(Date.now() + 2_000) ?? false;
		check("followUp watchdog fires when the queued message_end never arrives",
			fuTimedOut === true && fuPump.getStats().inFlightMessageIds.length === 0
				&& bus.getDelivery(fuMessage.envelope.id, "desktop-fu-wd")?.status === "delivered",
			`timedOut=${fuTimedOut} inFlight=${fuPump.getStats().inFlightMessageIds.length}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	const failed = results.filter(result => !result.passed);
	console.log(`\nRPC inbox pump: ${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
