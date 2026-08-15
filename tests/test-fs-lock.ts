/**
 * 锁安全回归：stale-steal 修复（docs/32 评审高优先级项 1）。
 * 过期判定 = 时间超时 且 持有者进程已消失；活进程的锁不可偷；
 * 偷锁用原子 rename（消除 TOCTOU 无条件 unlink 竞态）。
 */
import { mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateJsonStore } from "../src/core/json-store";
import { parseOwnerPid, stealStaleLock, isProcessAlive } from "../src/core/fs-lock";
import { MessageBus } from "../src/core/message-bus";
import { SharedBoard } from "../src/core/shared-board";

const root = join(tmpdir(), `agentflux-fs-lock-test-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

function check(name: string, passed: boolean, detail: string) {
	console.log(`  ${passed ? "✓" : "✗"} ${name}${passed ? "" : ` — ${detail}`}`);
	results.push({ name, passed });
}

const results: Array<{ name: string; passed: boolean }> = [];

// ── parseOwnerPid ──
check("parseOwnerPid reads pid from colon format",
	parseOwnerPid("12345:abc-uuid") === 12345, String(parseOwnerPid("12345:abc-uuid")));
check("parseOwnerPid reads pid from dash format (shared-board)",
	parseOwnerPid("67890-xyz") === 67890, String(parseOwnerPid("67890-xyz")));
check("parseOwnerPid rejects unparseable content",
	parseOwnerPid("not-a-pid") === undefined && parseOwnerPid("") === undefined, "expected undefined");

// ── json-store 锁：死 pid + 旧 mtime → 可偷（update 成功）──
{
	const storePath = join(root, "json-store-dead.json");
	mkdirSync(join(root), { recursive: true });
	const lockPath = `${storePath}.lock`;
	writeFileSync(lockPath, "99999999:dead-owner", "utf-8");
	const old = new Date(Date.now() - 120_000);
	utimesSync(lockPath, old, old);
	let updated = false;
	try {
		updateJsonStore(storePath, () => ({ v: 1 }), (x: unknown): x is { v: number } => typeof x === "object" && x !== null && "v" in x,
			store => { updated = true; store.v = 2; return store.v; }, { staleLockMs: 1000 });
	} catch (error: any) {
		check("json-store steals a dead-owner stale lock", false, error?.message);
	}
	check("json-store steals a dead-owner stale lock",
		updated && readFileSync(storePath, "utf-8").includes('"v": 2'), "updated=" + updated);
}

// ── json-store 锁：活 pid（本进程）+ 旧 mtime → 不可偷（lock timeout 抛错）──
{
	const storePath = join(root, "json-store-alive.json");
	const lockPath = `${storePath}.lock`;
	writeFileSync(lockPath, `${process.pid}:alive-owner`, "utf-8");
	const old = new Date(Date.now() - 120_000);
	utimesSync(lockPath, old, old);
	let threw = false;
	try {
		updateJsonStore(storePath, () => ({ v: 1 }), (x: unknown): x is { v: number } => typeof x === "object" && x !== null && "v" in x,
			store => { store.v = 9; return store.v; }, { lockTimeoutMs: 300, staleLockMs: 1000 });
	} catch (error: any) {
		threw = /lock timeout/.test(error?.message ?? "");
	}
	check("json-store never steals a live-owner lock (long-write protection)",
		threw, "expected lock timeout, got success");
}

// ── message-bus 锁：死 pid 可偷、活 pid 不可偷 ──
{
	const busRoot = join(root, "mb");
	const deadBus = new MessageBus(busRoot, { redeliveryAfterMs: 1000 });
	const deadLock = join(busRoot, "shared", "messages-v2", ".mutex.lock");
	writeFileSync(deadLock, "99999999:dead", "utf-8");
	const old = new Date(Date.now() - 120_000);
	utimesSync(deadLock, old, old);
	let deadSend = false;
	try {
		deadBus.sendDirect("main", "a", "handoff", "x");
		deadSend = true;
	} catch {}
	check("message-bus steals a dead-owner stale lock",
		deadSend && !exists(deadLock), `deadSend=${deadSend} lockGone=${!exists(deadLock)}`);

	const aliveBus = new MessageBus(join(root, "mb2"), { redeliveryAfterMs: 1000 });
	const aliveLock = join(root, "mb2", "shared", "messages-v2", ".mutex.lock");
	writeFileSync(aliveLock, `${process.pid}:alive`, "utf-8");
	utimesSync(aliveLock, old, old);
	let aliveThrew = false;
	try {
		aliveBus.sendDirect("main", "b", "handoff", "y");
	} catch (error: any) {
		aliveThrew = /mutex timeout/.test(error?.message ?? "");
	}
	check("message-bus never steals a live-owner lock",
		aliveThrew, "expected mutex timeout, got success");
}

// ── shared-board 锁：死 pid 可偷、活 pid 不可偷 ──
{
	const board = new SharedBoard(join(root, "sb"));
	const lockDir = join(root, "sb", "shared", "locks");
	mkdirSync(lockDir, { recursive: true });
	const deadLock = join(lockDir, ".mutex-blackboard.lock");
	writeFileSync(deadLock, JSON.stringify({ token: "t1", ownerId: "99999999-dead", timestamp: Date.now() - 120_000 }), "utf-8");
	let deadOk = false;
	try {
		board.updateAgentStatus("a1", { status: "idle" });
		deadOk = true;
	} catch {}
	check("shared-board steals a dead-owner stale lock", deadOk, "updateAgentStatus threw");

	const aliveLock = join(lockDir, ".mutex-blackboard.lock");
	writeFileSync(aliveLock, JSON.stringify({ token: "t2", ownerId: `${process.pid}-alive`, timestamp: Date.now() - 120_000 }), "utf-8");
	let aliveThrew = false;
	try {
		board.updateAgentStatus("a2", { status: "idle" });
	} catch (error: any) {
		aliveThrew = /mutex timeout/.test(error?.message ?? "");
	}
	check("shared-board never steals a live-owner lock",
		aliveThrew, "expected mutex timeout, got success");
}

// ── stealStaleLock 原子性 ──
{
	const p = join(root, "steal-probe.lock");
	writeFileSync(p, "99999999:x", "utf-8");
	check("stealStaleLock renames and removes the stale lock",
		stealStaleLock(p) && !exists(p), `steal=${stealStaleLock(p)} exists=${exists(p)}`);
	check("stealStaleLock fails when the lock is already gone",
		!stealStaleLock(p), "expected false for missing lock");
	check("isProcessAlive sanity (own pid alive, bogus pid dead)",
		isProcessAlive(process.pid) && !isProcessAlive(99999999), "liveness probe failed");
}

function exists(p: string): boolean {
	try { readFileSync(p); return true; } catch { return false; }
}

rmSync(root, { recursive: true, force: true });
const failed = results.filter(result => !result.passed);
console.log(`\nFS lock: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
