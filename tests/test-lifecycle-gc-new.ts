import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLifecycleGc } from "../src/core/lifecycle-gc";
import { DEFAULT_CONFIG } from "../src/core/types";
import { finishAgentRun, markAgentRunRunning, registerAgentRun } from "../src/core/run-registry";

let passed = 0;
function check(value: unknown, message: string): void {
	if (!value) throw new Error(message);
	passed++;
	console.log(`✓ ${message}`);
}

const root = mkdtempSync(join(tmpdir(), "agentflux-gc-"));
const fluxDir = join(root, ".agentflux");
try {
	mkdirSync(join(fluxDir, "runtime"), { recursive: true });
	writeFileSync(join(fluxDir, "runtime", "agents.json"), JSON.stringify({ agents: [
		{ name: "archived-reviewer", status: "archived", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
		{ name: "active-reviewer", status: "idle", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
	] }, null, 2));
	const dryRun = runLifecycleGc(fluxDir, DEFAULT_CONFIG.retention, { dryRun: true, now: new Date("2026-07-18T00:00:00.000Z") });
	check(dryRun.removed.persistentAgents.includes("archived-reviewer"), "GC dry-run 找到过期终态 Agent");
	check(JSON.parse(readFileSync(join(fluxDir, "runtime", "agents.json"), "utf-8")).agents.length === 2, "GC dry-run 不修改注册表");
	registerAgentRun(fluxDir, {
		id: "running-task",
		sessionId: "gc-session",
		taskId: "task-gc",
		agent: "worker",
		role: "reviewer",
		currentTask: "still running",
		kind: "ephemeral",
	});
	markAgentRunRunning(fluxDir, "running-task", process.pid, 1);
	const blocked = runLifecycleGc(fluxDir, DEFAULT_CONFIG.retention);
	check(blocked.blockedReason?.includes("running-task"), "GC 从权威 Run Registry 发现运行中任务并拒绝执行");
	finishAgentRun(fluxDir, "running-task", { status: "cancelled" });
	const applied = runLifecycleGc(fluxDir, DEFAULT_CONFIG.retention, { now: new Date("2026-07-18T00:00:00.000Z") });
	const remaining = JSON.parse(readFileSync(join(fluxDir, "runtime", "agents.json"), "utf-8")).agents;
	check(applied.removed.persistentAgents.includes("archived-reviewer") && remaining.length === 1 && remaining[0].name === "active-reviewer", "GC 仅回收终态 Agent 并保留活跃 Agent");
	console.log(`\n${passed} lifecycle GC checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
