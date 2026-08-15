import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync } from "node:fs";

/**
 * 进程存活探测（Windows 上 process.kill(pid, 0) 同样可用）。
 * 用于锁抢占与孤儿回收的持有者校验，避免把仍在工作的进程误判为残留。
 */
export function isProcessAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * 从锁文件内容解析持有者 pid，支持 "pid:uuid"（json-store / message-bus）
 * 与 "pid-uuid"（shared-board）两种格式。内容不可解析时返回 undefined。
 */
export function parseOwnerPid(owner: string): number | undefined {
	const match = /^(\d+)[:-]/.exec(String(owner).trim());
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * 原子抢夺过期锁：rename 是原子的，并发竞争者中只有一个能成功，
 * 消除"判断过期→unlink"之间的 TOCTOU 窗口（无条件 unlink 可能删掉
 * 刚被原持有者释放、再由他人重新创建的锁）。抢到后立即清理残留文件。
 * 返回是否抢夺成功。
 */
export function stealStaleLock(lockPath: string): boolean {
	const stealPath = `${lockPath}.steal.${process.pid}.${randomUUID()}`;
	try {
		renameSync(lockPath, stealPath);
	} catch {
		return false;
	}
	try {
		unlinkSync(stealPath);
	} catch {
		// 残留文件无害，下次 GC 清理；锁已被原子移走，抢夺成功。
	}
	return true;
}
