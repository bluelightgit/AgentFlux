import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
		{ name: "dev", status: "idle", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
	] }, null, 2));
	const dryRun = runLifecycleGc(fluxDir, DEFAULT_CONFIG.retention, { dryRun: true, now: new Date("2026-07-18T00:00:00.000Z") });
	check(dryRun.removed.persistentAgents.includes("archived-reviewer"), "GC dry-run 找到过期终态 Agent");
	check(JSON.parse(readFileSync(join(fluxDir, "runtime", "agents.json"), "utf-8")).agents.length === 3, "GC dry-run 不修改注册表");
	registerAgentRun(fluxDir, {
		id: "stale-run",
		sessionId: "gc-session",
		taskId: "task-gc",
		agent: "worker",
		role: "reviewer",
		currentTask: "stale heartbeat",
		kind: "ephemeral",
	});
	markAgentRunRunning(fluxDir, "stale-run", 9999, 1);
	const staleRunPath = join(fluxDir, "runtime", "runs.json");
	const staleBefore = JSON.parse(readFileSync(staleRunPath, "utf-8")).runs.find((r: any) => r.id === "stale-run");
	const dryRun2 = runLifecycleGc(fluxDir, DEFAULT_CONFIG.retention, { dryRun: true, now: new Date("2026-07-18T01:00:00.000Z") });
	const staleAfter = JSON.parse(readFileSync(staleRunPath, "utf-8")).runs.find((r: any) => r.id === "stale-run");
	check(dryRun2.dryRun && staleBefore.status === "running" && staleAfter.status === "running", "GC dry-run 不执行 reconcile（stale run 保持 running，无写盘）");
	finishAgentRun(fluxDir, "stale-run", { status: "cancelled" });
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
	check(applied.removed.persistentAgents.includes("archived-reviewer") && remaining.length === 2 && remaining.every((a: any) => ["active-reviewer", "dev"].includes(a.name)), "GC 仅回收终态 Agent 并保留活跃 Agent");

	// ---- 会话匹配回归（2026-08-12 修复：段边界 + persistent 前缀 + 统一 TTL）----
	const sessionsDir = join(fluxDir, "runtime", "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const old = new Date("2025-01-01T00:00:00.000Z");
	const fresh = new Date("2026-07-18T00:00:00.000Z");
	const touch = (name: string, mtime: Date) => { const p = join(sessionsDir, name); writeFileSync(p, ""); utimesSync(p, mtime, mtime); };
	touch("2025-01-01T00-00-00-000Z_persistent-dev-cap-abc123.jsonl", old);
	touch("2025-01-01T00-00-00-000Z_persistent-dev-frontend-cap-def456.jsonl", old);
	touch("2025-01-01T00-00-00-000Z_persistent-active-reviewer-cap-aaa111.jsonl", old);
	touch("2025-01-01T00-00-00-000Z_flux-worker-cap-bbb222.jsonl", old);
	touch("2026-07-18T00-00-00-000Z_persistent-active-reviewer-cap-recent.jsonl", fresh);
	touch("2026-07-18T00-00-00-000Z_persistent-archived-reviewer-cap-recent.jsonl", fresh);
	touch("2025-01-01T00-00-00-000Z_persistent-archived-reviewer-cap-old.jsonl", old);

	const sessionDry = runLifecycleGc(fluxDir, DEFAULT_CONFIG.retention, { dryRun: true, now: new Date("2026-07-18T00:00:00.000Z") });
	check(sessionDry.preserved.protectedSessions >= 2, "持久会话按段边界匹配 protectedNames（active-reviewer 双会话均受保护）");
	check(!sessionDry.removed.orphanSessions.some(f => f.includes("dev-cap-")), "段边界匹配：dev 不误匹配 dev-frontend 的会话");
	check(sessionDry.removed.orphanSessions.some(f => f.includes("flux-worker-cap-")), "flux- 前缀会话仍按孤儿 TTL 归档");
	check(!sessionDry.removed.orphanSessions.some(f => f.includes("archived-reviewer-cap-recent")), "被移除 agent 的新鲜会话不归档（belongsToRemoved 需 TTL 过期）");
	check(sessionDry.removed.orphanSessions.some(f => f.includes("archived-reviewer-cap-old")), "被移除 agent 的过期会话按孤儿 TTL 归档");
	check(sessionDry.removed.orphanSessions.length === 3, `过期孤儿共 3 个（dev-frontend + worker + archived-reviewer-old）: ${sessionDry.removed.orphanSessions.join(",")}`);
	console.log(`\n${passed} lifecycle GC checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
