import {
	existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
	utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/core/config";
import { formatLifecycleGcReport, runLifecycleGc } from "../src/core/lifecycle-gc";
import { SharedBoard } from "../src/core/shared-board";
import { MessageBus } from "../src/core/message-bus";
import { DEFAULT_CONFIG, type RetentionConfig } from "../src/core/types";

const results: Array<{ name: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: string) {
	results.push({ name, passed, detail });
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
}

const root = mkdtempSync(join(tmpdir(), "agentflux-lifecycle-gc-"));
const fluxDir = join(root, ".agentflux");
const runtimeDir = join(fluxDir, "runtime");
const now = new Date("2026-07-16T12:00:00.000Z");
const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
const fresh = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
const secondFresh = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
const policy: RetentionConfig = {
	enabled: true,
	stale_runtime_ttl_hours: 2,
	terminal_agent_ttl_hours: 24,
	max_terminal_agents: 1,
	read_message_ttl_hours: 24,
	max_read_messages: 1,
	orphan_session_ttl_hours: 24,
};

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

function mutateMessage(id: string, updates: Record<string, unknown>) {
	const dir = join(fluxDir, "shared", "messages");
	const file = readdirSync(dir).find(name => name.startsWith(id));
	if (!file) throw new Error(`message ${id} not found`);
	const path = join(dir, file);
	const message = JSON.parse(readFileSync(path, "utf-8"));
	writeFileSync(path, JSON.stringify({ ...message, ...updates }, null, 2), "utf-8");
}

try {
	mkdirSync(runtimeDir, { recursive: true });
	writeJson(join(runtimeDir, "registry.json"), {
		instances: [
			{ name: "role-running", status: "running", createdAt: old },
			{ name: "role-old", status: "done", createdAt: old },
			{ name: "role-fresh", status: "done", createdAt: fresh },
			{ name: "role-excess", status: "failed", createdAt: secondFresh },
		],
	});
	writeJson(join(runtimeDir, "persistent-agents.json"), {
		agents: [
			{ name: "persist-running", status: "running", createdAt: old, lastUsedAt: old },
			{ name: "persist-old", status: "done", createdAt: old, lastUsedAt: old },
			{ name: "persist-fresh", status: "done", createdAt: fresh, lastUsedAt: fresh },
		],
	});

	const board = new SharedBoard(fluxDir);
	writeJson(join(fluxDir, "shared", "agents", "_registry.json"), [
		{ name: "shared-running", role: "worker", status: "running", registeredAt: old, lastSeen: old },
		{ name: "legacy-stale-explicit", role: "worker", status: "running", registeredAt: old, lastSeen: old },
		{ name: "legacy-fresh-explicit", role: "worker", status: "idle", registeredAt: fresh, lastSeen: fresh },
		{ name: "legacy-pid-explicit", role: "rpc-runtime", status: "idle", runtimePid: 333, registeredAt: old, lastSeen: old },
		{ name: "runtime-stale", role: "rpc-runtime", status: "idle", instanceId: "stale-instance", runtimePid: 111, registeredAt: old, lastSeen: old, heartbeatAt: old },
		{ name: "runtime-fresh", role: "rpc-runtime", status: "idle", instanceId: "fresh-instance", runtimePid: 222, registeredAt: fresh, lastSeen: fresh, heartbeatAt: fresh },
		{ name: "shared-old", role: "worker", status: "done", registeredAt: old, lastSeen: old },
		{ name: "shared-cancelled-old", role: "worker", status: "cancelled", registeredAt: old, lastSeen: old },
		{ name: "shared-fresh", role: "worker", status: "done", registeredAt: fresh, lastSeen: fresh },
	]);
	writeJson(join(fluxDir, "shared", "blackboard.json"), {
		project: "test", currentMode: "M2", sharedContext: {}, updatedAt: fresh,
		agentStatuses: {
			"board-running": { status: "running", updatedAt: old },
			"board-old": { status: "done", updatedAt: old },
			"board-fresh": { status: "done", updatedAt: fresh },
			"board-legacy": { status: "done" },
		},
	});

	const oldRead = board.sendMessage("planner", "worker", "note", "old read direct");
	const freshRead = board.sendMessage("planner", "worker", "note", "fresh read direct");
	const excessRead = board.sendMessage("planner", "worker", "note", "excess read direct");
	const unread = board.sendMessage("planner", "worker", "question", "old unread direct");
	const broadcast = board.sendMessage("planner", "broadcast", "notice", "old broadcast");
	mutateMessage(oldRead.id, { read: true, timestamp: old });
	mutateMessage(freshRead.id, { read: true, timestamp: fresh });
	mutateMessage(excessRead.id, { read: true, timestamp: secondFresh });
	mutateMessage(unread.id, { read: false, timestamp: old });
	mutateMessage(broadcast.id, { read: true, timestamp: old });
	const group = board.createGroup("workers", ["planner", "worker"], "team", "planner");
	board.sendGroupMessage("planner", group.id, "group history must survive GC");
	const messageBus = new MessageBus(fluxDir);
	const v2Old = messageBus.sendDirect("planner", "worker", "handoff", "old completed V2");
	messageBus.poll("worker", { now: new Date(old) });
	messageBus.acknowledge("worker", v2Old.envelope.id, new Date(old));
	const v2Fresh = messageBus.sendDirect("planner", "worker", "handoff", "fresh completed V2");
	messageBus.poll("worker", { now: new Date(fresh) });
	messageBus.acknowledge("worker", v2Fresh.envelope.id, new Date(fresh));
	const v2Excess = messageBus.sendDirect("planner", "worker", "handoff", "excess completed V2");
	messageBus.poll("worker", { now: new Date(secondFresh) });
	messageBus.acknowledge("worker", v2Excess.envelope.id, new Date(secondFresh));
	const v2Outstanding = messageBus.sendDirect("planner", "worker", "question", "pending V2 must survive");

	const sessionsDir = join(runtimeDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	for (const file of [
		"flux-persist-old-session.jsonl",
		"flux-persist-running-session.jsonl",
		"orphan-old.jsonl",
		"orphan-fresh.jsonl",
	]) writeFileSync(join(sessionsDir, file), "{}\n", "utf-8");
	const oldDate = new Date(old);
	utimesSync(join(sessionsDir, "flux-persist-old-session.jsonl"), oldDate, oldDate);
	utimesSync(join(sessionsDir, "flux-persist-running-session.jsonl"), oldDate, oldDate);
	utimesSync(join(sessionsDir, "orphan-old.jsonl"), oldDate, oldDate);
	const freshDate = new Date(fresh);
	utimesSync(join(sessionsDir, "orphan-fresh.jsonl"), freshDate, freshDate);

	const report = runLifecycleGc(fluxDir, policy, { now });
	check("terminal role records obey TTL and count cap",
		report.removed.roleInstances.includes("role-old") && report.removed.roleInstances.includes("role-excess")
			&& !report.removed.roleInstances.includes("role-fresh"),
		JSON.stringify(report.removed.roleInstances));
	check("persistent and shared terminal records are pruned",
		report.removed.persistentAgents.includes("persist-old")
			&& report.removed.sharedAgents.includes("shared-old")
			&& report.removed.sharedAgents.includes("shared-cancelled-old"),
		`persistent=${report.removed.persistentAgents} shared=${report.removed.sharedAgents}`);
	check("running agents are always preserved",
		JSON.stringify(readFileSync(join(runtimeDir, "registry.json"), "utf-8")).includes("role-running")
			&& JSON.stringify(readFileSync(join(runtimeDir, "persistent-agents.json"), "utf-8")).includes("persist-running")
			&& board.listAgents().some(agent => agent.name === "shared-running"),
		`nonTerminal=${report.preserved.nonTerminalAgents}`);
	check("stale fenced RPC runtime is archived while fresh runtime is preserved",
		report.removed.sharedAgents.includes("runtime-stale")
			&& !report.removed.sharedAgents.includes("runtime-fresh")
			&& board.listAgents().some(agent => agent.name === "runtime-fresh"),
		`removed=${report.removed.sharedAgents.join(",")}`);
	check("automatic GC preserves pre-identity non-terminal records",
		["legacy-stale-explicit", "legacy-fresh-explicit", "legacy-pid-explicit"]
			.every(name => board.listAgents().some(agent => agent.name === name))
			&& report.removed.explicitLegacyAgents.length === 0,
		`explicit=${report.removed.explicitLegacyAgents.join(",")}`);
	check("blackboard only removes timestamped expired terminal state",
		!board.getBlackboard().agentStatuses["board-old"]
			&& !!board.getBlackboard().agentStatuses["board-legacy"]
			&& !!board.getBlackboard().agentStatuses["board-running"],
		JSON.stringify(Object.keys(board.getBlackboard().agentStatuses)));

	const remainingMessageIds = new Set(board.listMessages().map(message => message.id));
	check("old/excess read direct messages leave active inbox",
		!remainingMessageIds.has(oldRead.id) && !remainingMessageIds.has(excessRead.id) && remainingMessageIds.has(freshRead.id),
		JSON.stringify([...remainingMessageIds]));
	check("unread and broadcast messages are preserved",
		remainingMessageIds.has(unread.id) && remainingMessageIds.has(broadcast.id),
		`unread=${report.preserved.unreadMessages} broadcast=${report.preserved.broadcastMessages}`);
	check("group history is never touched by lifecycle GC",
		board.getGroupMessages(group.id).length === 1,
		`groupMessages=${board.getGroupMessages(group.id).length}`);
	check("terminal Message V2 envelopes obey TTL and count cap",
		report.removed.messageV2Envelopes.includes(v2Old.envelope.id)
			&& report.removed.messageV2Envelopes.includes(v2Excess.envelope.id)
			&& !report.removed.messageV2Envelopes.includes(v2Fresh.envelope.id)
			&& !existsSync(join(fluxDir, "shared", "messages-v2", "envelopes", `${v2Old.envelope.id}.json`)),
		JSON.stringify(report.removed.messageV2Envelopes));
	check("outstanding Message V2 delivery is preserved",
		messageBus.getEnvelope(v2Outstanding.envelope.id)?.id === v2Outstanding.envelope.id
			&& report.preserved.messageV2Outstanding === 1,
		`outstanding=${report.preserved.messageV2Outstanding}`);

	const remainingSessions = new Set(readdirSync(sessionsDir));
	check("removed-agent and expired orphan sessions are archived",
		!remainingSessions.has("flux-persist-old-session.jsonl") && !remainingSessions.has("orphan-old.jsonl"),
		JSON.stringify([...remainingSessions]));
	check("active-agent and fresh orphan sessions are preserved",
		remainingSessions.has("flux-persist-running-session.jsonl") && remainingSessions.has("orphan-fresh.jsonl"),
		`protected=${report.preserved.protectedSessions}`);
	check("GC writes an auditable manifest",
		!!report.archivePath && existsSync(join(report.archivePath, "manifest.json"))
			&& existsSync(join(report.archivePath, "messages")) && existsSync(join(report.archivePath, "sessions"))
			&& existsSync(join(report.archivePath, "messages-v2", v2Old.envelope.id, "envelope.json")),
		report.archivePath ?? "no archive");
	check("formatted report exposes preservation counts",
		formatLifecycleGcReport(report).includes("preserved non-terminal=")
			&& formatLifecycleGcReport(report).includes("explicit-legacy=0")
			&& formatLifecycleGcReport(report).includes("archive="),
		formatLifecycleGcReport(report).split("\n")[0]);

	const explicitNames = ["legacy-stale-explicit", "legacy-fresh-explicit", "legacy-pid-explicit"];
	const explicitDryRun = runLifecycleGc(fluxDir, policy, {
		now, dryRun: true, explicitLegacyAgentNames: explicitNames,
	});
	check("explicit legacy dry-run selects only stale identity-less pid-less records",
		JSON.stringify(explicitDryRun.removed.explicitLegacyAgents) === JSON.stringify(["legacy-stale-explicit"])
			&& explicitNames.every(name => board.listAgents().some(agent => agent.name === name)),
		JSON.stringify(explicitDryRun.removed.explicitLegacyAgents));
	const explicitRun = runLifecycleGc(fluxDir, policy, { now, explicitLegacyAgentNames: explicitNames });
	check("explicit legacy cleanup is archived and keeps fresh/fenced records",
		explicitRun.removed.explicitLegacyAgents.includes("legacy-stale-explicit")
			&& !board.listAgents().some(agent => agent.name === "legacy-stale-explicit")
			&& board.listAgents().some(agent => agent.name === "legacy-fresh-explicit")
			&& board.listAgents().some(agent => agent.name === "legacy-pid-explicit")
			&& !!explicitRun.archivePath
			&& existsSync(join(explicitRun.archivePath, "manifest.json")),
		explicitRun.archivePath ?? "no archive");

	const beforeDryRun = readFileSync(join(runtimeDir, "persistent-agents.json"), "utf-8");
	const dryRun = runLifecycleGc(fluxDir, policy, { now: new Date("2026-08-16T12:00:00.000Z"), dryRun: true });
	check("dry-run predicts cleanup without mutating registry",
		Object.values(dryRun.removed).some(items => items.length > 0)
			&& readFileSync(join(runtimeDir, "persistent-agents.json"), "utf-8") === beforeDryRun
			&& !dryRun.archivePath,
		formatLifecycleGcReport(dryRun).split("\n")[0]);
	const emptyDryRunFlux = join(root, ".agentflux-empty-dry-run");
	runLifecycleGc(emptyDryRunFlux, policy, { now, dryRun: true });
	check("dry-run does not create missing SharedBoard/runtime directories",
		!existsSync(emptyDryRunFlux),
		existsSync(emptyDryRunFlux) ? "unexpected directory created" : "no mutation");

	const roleRegistry = JSON.parse(readFileSync(join(runtimeDir, "registry.json"), "utf-8"));
	roleRegistry.instances.push({ name: "role-blocked-old", status: "done", createdAt: old });
	writeJson(join(runtimeDir, "registry.json"), roleRegistry);
	const blocked = runLifecycleGc(fluxDir, policy, { now, activeRunIds: ["active-run-1"] });
	check("active subagent run blocks mutating GC",
		blocked.blockedReason?.includes("active-run-1") === true
			&& readFileSync(join(runtimeDir, "registry.json"), "utf-8").includes("role-blocked-old"),
		blocked.blockedReason ?? "not blocked");

	const invalidWarnings = validateConfig({
		...DEFAULT_CONFIG,
		retention: { ...DEFAULT_CONFIG.retention, stale_runtime_ttl_hours: 0, orphan_session_ttl_hours: 0, max_read_messages: -1 },
	});
	check("invalid retention policy is observable in config validation",
		invalidWarnings.some(warning => warning.includes("stale_runtime_ttl_hours"))
			&& invalidWarnings.some(warning => warning.includes("orphan_session_ttl_hours"))
			&& invalidWarnings.some(warning => warning.includes("max_read_messages")),
		invalidWarnings.join(" | "));
} finally {
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter(result => !result.passed);
console.log(`\nLifecycle GC: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
