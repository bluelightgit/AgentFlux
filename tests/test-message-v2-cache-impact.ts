import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { assessCacheImpact, diffRuntimeCacheShape, formatCacheImpactWarning } from "../src/core/cache-impact";
import { MessageBackpressureError, MessageBus } from "../src/core/message-bus";
import { AgentMessageRuntime } from "../src/core/agent-message-runtime";
import {
	communicationPolicyFromFrontmatter, evaluateCommunicationContract, resolveCommunicationPolicy,
} from "../src/core/communication-policy";
import { SharedBoard } from "../src/core/shared-board";
import { runAgent, type AgentTemplate, type AgentRunResult } from "../src/agents/agent-runner";

const results: Array<{ name: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: string) {
	results.push({ name, passed, detail });
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
}

const root = mkdtempSync(join(tmpdir(), "agentflux-message-v2-"));
const fluxDir = join(root, ".agentflux");

async function main() {
	try {
		const board = new SharedBoard(fluxDir);
		for (const name of ["planner", "worker-a", "worker-b", "desktop-target", "limited", "runner-ok", "runner-fail", "runner-contract", "runtime-sender", "concurrent"]) {
			board.registerAgent({ name, role: "worker", status: "idle" });
		}
		const group = board.createGroup("implementation", ["planner", "worker-a", "worker-b"], "team", "planner");
		const bus = new MessageBus(fluxDir, { redeliveryAfterMs: 1_000, maxPendingPerRecipient: 10 });

		const direct = bus.sendDirect("planner", "worker-a", "task_update", "Use the new schema", {
			dedupeKey: "task-1-schema-v2", taskId: "task-1",
		});
		const duplicate = bus.sendDirect("planner", "worker-a", "task_update", "This payload is ignored by dedupe", {
			dedupeKey: "task-1-schema-v2", taskId: "task-1",
		});
		check("dedupe returns the original envelope",
			duplicate.deduplicated && duplicate.envelope.id === direct.envelope.id && bus.countOutstanding("worker-a") === 1,
			`${direct.envelope.id} / ${duplicate.envelope.id}`);

		const groupResult = bus.sendGroup("planner", group.id, "interface_changed", "API response changed", {
			priority: "high", correlationId: "change-1",
		});
		check("group send snapshots one delivery per non-sender member",
			groupResult.deliveries.length === 2
				&& groupResult.deliveries.some(delivery => delivery.recipient === "worker-a")
				&& groupResult.deliveries.some(delivery => delivery.recipient === "worker-b"),
			groupResult.deliveries.map(delivery => delivery.recipient).join(","));
		const workerBPeek = bus.peek("worker-b");
		check("peek exposes group inbox without consuming delivery",
			workerBPeek.length === 1
				&& workerBPeek[0].envelope.id === groupResult.envelope.id
				&& workerBPeek[0].delivery.status === "pending"
				&& bus.getDelivery(groupResult.envelope.id, "worker-b")?.status === "pending",
			`${workerBPeek[0]?.envelope.channel.type}:${workerBPeek[0]?.delivery.status}`);

		const workerAPoll = bus.poll("worker-a", { now: new Date("2026-07-16T12:00:00.000Z") });
		check("poll orders high-priority messages first and marks delivery",
			workerAPoll.length === 2 && workerAPoll[0].envelope.id === groupResult.envelope.id
				&& workerAPoll.every(item => item.delivery.status === "delivered" && item.delivery.attempts === 1),
			workerAPoll.map(item => `${item.envelope.priority}:${item.delivery.status}`).join(","));
		check("delivery lease prevents immediate duplicate injection",
			bus.poll("worker-a", { now: new Date("2026-07-16T12:00:00.500Z") }).length === 0,
			"no immediate redelivery");
		bus.acknowledge("worker-a", direct.envelope.id, new Date("2026-07-16T12:00:01.000Z"));
		bus.acknowledge("worker-a", groupResult.envelope.id, new Date("2026-07-16T12:00:01.000Z"));
		check("acknowledgement is recipient-specific",
			bus.getDelivery(groupResult.envelope.id, "worker-a")?.status === "acknowledged"
				&& bus.getDelivery(groupResult.envelope.id, "worker-b")?.status === "pending",
			`a=${bus.getDelivery(groupResult.envelope.id, "worker-a")?.status} b=${bus.getDelivery(groupResult.envelope.id, "worker-b")?.status}`);
		check("cursor tracks delivered and acknowledged messages",
			bus.getCursor("worker-a").lastAcknowledgedMessageId === groupResult.envelope.id,
			JSON.stringify(bus.getCursor("worker-a")));

		const workerBFirst = bus.poll("worker-b", { now: new Date("2026-07-16T12:00:00.000Z") });
		const workerBRedelivery = bus.poll("worker-b", { now: new Date("2026-07-16T12:00:02.000Z") });
		check("unacknowledged delivery is redelivered after lease",
			workerBFirst.length === 1 && workerBRedelivery.length === 1 && workerBRedelivery[0].delivery.attempts === 2,
			`attempts=${workerBRedelivery[0]?.delivery.attempts}`);
		bus.acknowledge("worker-b", groupResult.envelope.id, new Date("2026-07-16T12:00:03.000Z"));

		const expired = bus.sendDirect("planner", "worker-a", "obsolete", "This should expire", {
			expiresAt: "2026-07-16T11:00:00.000Z",
		});
		check("expired messages never enter the inbox",
			bus.poll("worker-a", { now: new Date("2026-07-16T12:00:00.000Z") }).length === 0
				&& bus.getDelivery(expired.envelope.id, "worker-a")?.status === "expired",
			bus.getDelivery(expired.envelope.id, "worker-a")?.status ?? "missing");

		const limitedBus = new MessageBus(fluxDir, { maxPendingPerRecipient: 1 });
		const firstLimited = limitedBus.sendDirect("planner", "limited", "one", "first");
		let backpressure: unknown;
		try { limitedBus.sendDirect("planner", "limited", "two", "second"); }
		catch (error) { backpressure = error; }
		check("per-recipient pending limit applies backpressure",
			backpressure instanceof MessageBackpressureError,
			backpressure instanceof Error ? backpressure.message : "no error");
		limitedBus.poll("limited");
		limitedBus.acknowledge("limited", firstLimited.envelope.id);
		check("acknowledgement releases backpressure capacity",
			limitedBus.sendDirect("planner", "limited", "two", "second").deliveries.length === 1,
			`outstanding=${limitedBus.countOutstanding("limited")}`);
		let unsafeMessageIdRejected = false;
		try { limitedBus.acknowledge("limited", "../../outside"); }
		catch (error) { unsafeMessageIdRejected = /opaque id/.test(error instanceof Error ? error.message : String(error)); }
		check("message ids cannot escape the delivery directory", unsafeMessageIdRejected, "path-like message id rejected");
		let reservedRecipientRejected = false;
		try { limitedBus.sendDirect("planner", "nul", "message", "reserved"); }
		catch (error) { reservedRecipientRejected = /safe .*path segment/.test(error instanceof Error ? error.message : String(error)); }
		check("Windows reserved recipient names are rejected", reservedRecipientRejected, "nul");

		const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
		const workerScript = join(process.cwd(), "tests", "helpers", "message-bus-worker.ts");
		const runWorker = (prefix: string): Promise<void> => new Promise((resolveWorker, rejectWorker) => {
			const child = spawn(process.execPath, [tsxCli, workerScript, fluxDir, prefix], {
				cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.setEncoding("utf-8");
			child.stderr.on("data", chunk => { stderr += chunk; });
			child.once("error", rejectWorker);
			child.once("close", code => code === 0
				? resolveWorker()
				: rejectWorker(new Error(`message worker ${prefix} exited ${code}: ${stderr}`)));
		});
		await Promise.all(["sender1", "sender2", "sender3", "sender4"].map(runWorker));
		const concurrentMessages = bus.poll("concurrent", { limit: 100 });
		check("cross-process sends preserve all deliveries",
			concurrentMessages.length === 40 && new Set(concurrentMessages.map(item => item.envelope.content)).size === 40,
			`deliveries=${concurrentMessages.length}`);

		const balancedImpact = assessCacheImpact("skill_set", 0.5);
		check("cache-breaking skill changes produce a user warning",
			balancedImpact.shouldNotifyUser && !!formatCacheImpactWarning(balancedImpact)?.includes("reusable-prefix=invalidated"),
			formatCacheImpactWarning(balancedImpact)?.split("\n")[0] ?? "suppressed");
		const zeroCostImpact = assessCacheImpact("skill_set", 0);
		check("cost_sensitivity=0 suppresses cache-impact notification",
			!zeroCostImpact.shouldNotifyUser && zeroCostImpact.suppressedReason === "cost_sensitivity_zero"
				&& formatCacheImpactWarning(zeroCostImpact) === null,
			zeroCostImpact.suppressedReason ?? "not suppressed");
		const messageImpact = assessCacheImpact("message_injection", 0.5);
		check("dynamic message suffix records token impact without false cache warning",
			messageImpact.addsContextTokens && !messageImpact.invalidatesReusablePrefix
				&& !messageImpact.shouldNotifyUser && messageImpact.suppressedReason === "no_cache_hit_impact",
			messageImpact.reason);
		check("runtime cache shape diff identifies only changed cache contracts",
			JSON.stringify(diffRuntimeCacheShape(
				{ toolSchema: "a", skillSet: "a", mcpSet: "a", systemPrompts: "a", modelAssignments: "a" },
				{ toolSchema: "b", skillSet: "a", mcpSet: "a", systemPrompts: "b", modelAssignments: "a" },
			)) === JSON.stringify(["tool_schema", "system_prompt"]),
			"tool_schema,system_prompt");

		const rolePolicy = communicationPolicyFromFrontmatter({
			communication_actions: "send, poll, ack, status",
			communication_targets: "worker-a",
			required_handoff_to: "worker-a",
			require_explicit_inbox_ack: "true",
			max_messages_per_run: "3",
		});
		const communicationPolicy = resolveCommunicationPolicy(rolePolicy, { maxMessagesPerRun: 2 });
		check("communication policy merges template defaults with runtime override",
			communicationPolicy.allowedTargets[0] === "worker-a"
				&& communicationPolicy.requiredSendTo[0] === "worker-a"
				&& communicationPolicy.requireExplicitInboxAck && communicationPolicy.maxMessagesPerRun === 2,
			JSON.stringify(communicationPolicy));
		const unionPolicy = resolveCommunicationPolicy({ requiredSendTo: ["worker-a"] }, { requiredSendTo: ["worker-b"] });
		check("requiredSendTo 按 union 合并（下层不得移除上层要求，与 narrowCommunication 一致）",
			unionPolicy.requiredSendTo.length === 2 && unionPolicy.requiredSendTo.includes("worker-a") && unionPolicy.requiredSendTo.includes("worker-b"),
			JSON.stringify(unionPolicy.requiredSendTo));

		const audit: any[] = [];
		const runtime = new AgentMessageRuntime(fluxDir, {
			agent: "runtime-sender", instanceId: "runtime-sender:run-1", runId: "run-1", taskId: "task-runtime",
		}, communicationPolicy, record => audit.push(record));
		const runtimeSend: any = runtime.execute({ action: "send", target: "worker-a", content: "identity-bound handoff" });
		check("identity-bound runtime fixes sender and run correlation",
			runtimeSend.envelope.from === "runtime-sender"
				&& runtimeSend.envelope.senderInstanceId === "runtime-sender:run-1"
				&& runtimeSend.envelope.correlationId === "run-1",
			`${runtimeSend.envelope.from}/${runtimeSend.envelope.senderInstanceId}`);
		let deniedTarget = "";
		try { runtime.execute({ action: "send", target: "worker-b", content: "must be denied" }); }
		catch (error: any) { deniedTarget = error.message; }
		check("identity-bound runtime enforces target allowlist",
			deniedTarget.includes("not allowed") && audit.some(record => record.result === "denied"),
			deniedTarget || "not denied");
		const runtimeInbox = bus.sendDirect("planner", "runtime-sender", "question", "explicit ack required");
		runtime.execute({ action: "poll" });
		runtime.execute({ action: "ack", messageId: runtimeInbox.envelope.id });
		const runtimeContract = evaluateCommunicationContract({
			bus, policy: communicationPolicy, sender: "runtime-sender", runId: "run-1",
			injectedMessageIds: [runtimeInbox.envelope.id],
		});
		check("communication contract verifies required handoff and explicit inbox ack",
			runtimeContract.passed && runtimeContract.sentTo.includes("worker-a")
				&& runtimeContract.unacknowledgedInbox.length === 0,
			JSON.stringify(runtimeContract));

		const agent = (name: string): AgentTemplate => ({ name, description: "test", systemPrompt: "", tools: [] });
		const successMessage = bus.sendDirect("planner", "runner-ok", "question", "Acknowledge after successful processing");
		const success = await runAgent({
			cwd: root, agent: agent("runner-ok"), task: "process inbox", sessionId: "message-v2-success",
			prefixLayout: false, timeoutMs: 5_000, maxRetries: 0,
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "successful-subagent.cjs")] },
		});
		check("successful deferred subagent acknowledges injected V2 message",
			success.exitCode === 0 && bus.getDelivery(successMessage.envelope.id, "runner-ok")?.status === "acknowledged",
			`exit=${success.exitCode} status=${bus.getDelivery(successMessage.envelope.id, "runner-ok")?.status}`);
		check("assistantMessages collects per-message text for last(k)",
			Array.isArray(success.assistantMessages) && success.assistantMessages.includes("message processed"),
			`assistantMessages=${JSON.stringify(success.assistantMessages)}`);

		const failedMessage = bus.sendDirect("planner", "runner-fail", "question", "Keep unacked after failed processing");
		const failed = await runAgent({
			cwd: root, agent: agent("runner-fail"), task: "process inbox", sessionId: "message-v2-failure",
			prefixLayout: false, timeoutMs: 5_000, maxRetries: 0,
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "failed-subagent.cjs")] },
		});
		check("failed deferred subagent leaves V2 delivery available for lease redelivery",
			failed.exitCode !== 0 && bus.getDelivery(failedMessage.envelope.id, "runner-fail")?.status === "delivered",
			`exit=${failed.exitCode} status=${bus.getDelivery(failedMessage.envelope.id, "runner-fail")?.status}`);

		// provider 崩溃模拟：瞬时错误 → 指数退避重试恢复；持续崩溃 → 重试耗尽；模型不可用 → 降级
		const crashState = join(root, "crash-state.txt");
		const crashAgent = (name: string): AgentTemplate => ({ name, description: "test", systemPrompt: "", tools: [] });
		const crashOnce = await runAgent({
			cwd: root, agent: crashAgent("crash-once"), task: "recover from provider crash", sessionId: "provider-crash-once",
			prefixLayout: false, timeoutMs: 30_000, maxRetries: 1,
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "provider-crash-once.cjs")] },
			env: { AGENTFLUX_CRASH_STATE: crashState },
		});
		check("provider crash recovers via retry with backoff",
			crashOnce.exitCode === 0 && crashOnce.retryCount === 1 && !crashOnce.errorMessage
				&& /recovered after provider crash/.test(crashOnce.output),
			`exit=${crashOnce.exitCode} retries=${crashOnce.retryCount} error=${crashOnce.errorMessage ?? ""}`);

		const crashAlways = await runAgent({
			cwd: root, agent: crashAgent("crash-always"), task: "survive persistent crash", sessionId: "provider-crash-always",
			prefixLayout: false, timeoutMs: 30_000, maxRetries: 2, retryDelayMs: 100,
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "provider-crash-always.cjs")] },
		});
		check("persistent provider crash exhausts retries and reports the failure",
			crashAlways.retryCount === 2 && /502/.test(crashAlways.errorMessage ?? ""),
			`retries=${crashAlways.retryCount} error=${crashAlways.errorMessage ?? ""}`);

		const modelState = join(root, "model-state.txt");
		const modelsForFallback = {
			"unavailable-model": { provider: "octopus-completions", contextWindow: 128000 },
			"fallback-model": { provider: "octopus-anthropic", contextWindow: 128000 },
		};
		const fallbackRun = await runAgent({
			cwd: root, agent: { ...crashAgent("model-missing"), model: "unavailable-model" }, task: "degrade model", sessionId: "provider-model-missing",
			prefixLayout: false, timeoutMs: 30_000, maxRetries: 0, enableModelFallback: true,
			modelsForFallback, roleRequirementForFallback: { reasoning: 0.5 },
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "provider-model-missing.cjs")] },
			env: { AGENTFLUX_CRASH_STATE: modelState },
		});
		check("unavailable model degrades to a fallback model and succeeds",
			fallbackRun.exitCode === 0 && fallbackRun.fallbackModel === "fallback-model" && !fallbackRun.errorMessage
				&& /fallback model succeeded/.test(fallbackRun.output),
			`exit=${fallbackRun.exitCode} fallback=${fallbackRun.fallbackModel ?? ""} error=${fallbackRun.errorMessage ?? ""}`);

		const contractAgent: AgentTemplate = {
			...agent("runner-contract"), tools: ["read"], communication: { requiredSendTo: ["planner"], allowedTargets: ["planner"] },
		};
		const contractInbox = bus.sendDirect("planner", "runner-contract", "question", "do not ack until the full contract passes");
		const missingContract = await runAgent({
			cwd: root, agent: contractAgent, task: "must hand off", sessionId: "message-contract-missing",
			prefixLayout: true, timeoutMs: 5_000, maxRetries: 0, runId: "contract-missing",
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "successful-subagent.cjs")] },
		});
		check("subagent completion gate fails closed when required handoff is missing",
			missingContract.exitCode === 76 && missingContract.communication?.missingSendTo.includes("planner") === true
				&& bus.getDelivery(contractInbox.envelope.id, "runner-contract")?.status === "delivered",
			`exit=${missingContract.exitCode} inbox=${bus.getDelivery(contractInbox.envelope.id, "runner-contract")?.status}`);
		bus.sendDirect("runner-contract", "planner", "handoff", "completed", {
			correlationId: "contract-complete", senderInstanceId: "runner-contract:contract-complete",
		});
		const capturePath = join(root, "subagent-runtime-capture.json");
		process.env.AGENTFLUX_TEST_CAPTURE = capturePath;
		let completedContract: AgentRunResult;
		try {
			completedContract = await runAgent({
				cwd: root, agent: contractAgent, task: "must hand off", sessionId: "message-contract-complete",
				prefixLayout: true, timeoutMs: 5_000, maxRetries: 0, runId: "contract-complete", liveTeamCommunication: true,
				invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "successful-subagent.cjs")] },
			});
		} finally {
			delete process.env.AGENTFLUX_TEST_CAPTURE;
		}
		check("subagent completion gate accepts run-correlated required handoff",
			completedContract.exitCode === 0 && completedContract.communication?.passed === true,
			`exit=${completedContract.exitCode} sent=${completedContract.communication?.sentTo}`);
		const capture = JSON.parse(readFileSync(capturePath, "utf-8"));
		const toolsIndex = capture.argv.indexOf("--tools");
		check("subagent invocation activates identity tool and injects immutable runtime identity",
			toolsIndex >= 0 && capture.argv[toolsIndex + 1].split(",").includes("flux_agent_message")
				&& capture.agent === "runner-contract" && capture.runId === "contract-complete"
				&& capture.instanceId === "runner-contract:contract-complete",
			JSON.stringify({ tools: capture.argv[toolsIndex + 1], agent: capture.agent, runId: capture.runId }));
		check("live Team child is instructed to poll operator and peer updates before finishing",
			capture.argv.at(-1)?.includes("action=poll") === true,
			capture.argv.at(-1)?.slice(-180) ?? "missing task prompt");
		const corruptRoot = mkdtempSync(join(tmpdir(), "agentflux-message-corrupt-"));
		try {
			const corruptFluxDir = join(corruptRoot, ".agentflux");
			const corruptBus = new MessageBus(corruptFluxDir);
			const sent = corruptBus.sendDirect("planner", "worker-a", "test", "preserve corrupt evidence");
			const envelopePath = join(corruptFluxDir, "shared", "messages-v2", "envelopes", `${sent.envelope.id}.json`);
			writeFileSync(envelopePath, "{\"schemaVersion\":2,", "utf-8");
			let rejectedCorruption = false;
			try { corruptBus.getEnvelope(sent.envelope.id); }
			catch (error) { rejectedCorruption = /corrupt and was not overwritten/.test(error instanceof Error ? error.message : String(error)); }
			check("corrupt Message V2 state fails closed without erasing evidence",
				rejectedCorruption && readFileSync(envelopePath, "utf-8") === "{\"schemaVersion\":2,",
				sent.envelope.id);

			// V1 消息/群组单文件损坏容忍：聚合读取跳过损坏项，GC 不被阻塞
			const v1Board = new SharedBoard(corruptFluxDir);
			v1Board.sendMessage("planner", "worker-a", "handoff", "intact v1 message");
			const v1Dir = join(corruptFluxDir, "shared", "messages");
			writeFileSync(join(v1Dir, "corrupt-broken.json"), "{ not json", "utf-8");
			const v1Messages = v1Board.listMessages();
			check("corrupt V1 message file is skipped by listMessages (GC not blocked)",
				v1Messages.length === 1 && v1Messages[0].content === "intact v1 message",
				`count=${v1Messages.length}`);
			const inbox = v1Board.getInbox("worker-a");
			check("corrupt V1 message file is skipped by getInbox",
				inbox.length === 1 && inbox[0].to === "worker-a", `count=${inbox.length}`);
			const corruptGroup = join(corruptFluxDir, "shared", "groups", "corrupt-grp");
			mkdirSync(corruptGroup, { recursive: true });
			writeFileSync(join(corruptGroup, "messages.jsonl"), '{"id":1}\n{ broken\n{"id":3}\n', "utf-8");
			const groupMessages = v1Board.getGroupMessages("corrupt-grp");
			check("corrupt V1 group message line is skipped by getGroupMessages",
				groupMessages.length === 2, `count=${groupMessages.length}`);
			writeFileSync(join(corruptFluxDir, "shared", "groups", "_registry.json"), "{ broken", "utf-8");
			const groupsAfterCorruption = v1Board.listGroups();
			check("corrupt group registry file degrades to empty list",
				Array.isArray(groupsAfterCorruption) && groupsAfterCorruption.length === 0,
				`count=${groupsAfterCorruption.length}`);
		} finally {
			rmSync(corruptRoot, { recursive: true, force: true });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	const failed = results.filter(result => !result.passed);
	console.log(`\nMessage V2 + cache impact: ${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
