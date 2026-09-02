import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isProcessAlive, parseOwnerPid, stealStaleLock } from "./fs-lock";

export type JsonStoreValidator<T> = (value: unknown) => value is T;

export interface JsonStoreOptions {
	lockTimeoutMs?: number;
	staleLockMs?: number;
	backup?: boolean;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const ATOMIC_RENAME_RETRIES = 8;
const ATOMIC_RENAME_RETRYABLE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const LOCK_RELEASE_RETRIES = 8;

function waitForFilesystemRetry(attempt: number): void {
	const waiter = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(waiter, 0, 0, Math.min(250, 10 * 2 ** attempt));
}

/**
 * Windows Defender/indexers can briefly retain a handle to the destination
 * after a reader closes it. Keep the atomic replace semantics, but retry only
 * those transient filesystem errors for a bounded interval; a persistent
 * failure still escapes with the original error and the temporary file is
 * cleaned by the caller.
 */
function renameWithRetry(source: string, destination: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(source, destination);
			return;
		} catch (error: any) {
			if (!ATOMIC_RENAME_RETRYABLE_CODES.has(error?.code) || attempt >= ATOMIC_RENAME_RETRIES) throw error;
			waitForFilesystemRetry(attempt);
		}
	}
}

export function readJsonStore<T>(
	path: string,
	createDefault: () => T,
	validate: JsonStoreValidator<T>,
): T {
	if (!existsSync(path)) return createDefault();
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`JSON store is corrupt and was not overwritten: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!validate(value)) throw new Error(`JSON store schema is invalid and was not overwritten: ${path}`);
	return value;
}

export function writeJsonFileAtomic(path: string, value: unknown, options: { backup?: boolean } = {}): void {
	const backup = options.backup !== false;
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | null = null;
	try {
		fd = openSync(temporary, "wx");
		writeFileSync(fd, JSON.stringify(value, null, 2), "utf-8");
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		if (backup && existsSync(path)) copyFileSync(path, `${path}.bak`);
		renameWithRetry(temporary, path);
	} finally {
		if (fd !== null) {
			try { closeSync(fd); } catch {}
		}
		try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
	}
}

function acquireStoreLock(path: string, options: JsonStoreOptions): () => void {
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	const owner = `${process.pid}:${randomUUID()}`;
	const timeoutMs = Math.max(1, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
	const staleLockMs = Math.max(timeoutMs * 2, options.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
	const deadline = Date.now() + timeoutMs;
	const waiter = new Int32Array(new SharedArrayBuffer(4));

	while (Date.now() <= deadline) {
		let fd: number | null = null;
		try {
			fd = openSync(lockPath, "wx");
			writeFileSync(fd, owner, "utf-8");
			closeSync(fd);
			fd = null;
			return () => {
				for (let attempt = 0; attempt <= LOCK_RELEASE_RETRIES; attempt++) {
					try {
						if (readFileSync(lockPath, "utf-8") !== owner) return;
						unlinkSync(lockPath);
						return;
					} catch (error: any) {
						if (!ATOMIC_RENAME_RETRYABLE_CODES.has(error?.code) || attempt >= LOCK_RELEASE_RETRIES) return;
						waitForFilesystemRetry(attempt);
					}
				}
			};
		} catch (error: any) {
			if (fd !== null) {
				try { closeSync(fd); } catch {}
			}
			if (error?.code !== "EEXIST" && !ATOMIC_RENAME_RETRYABLE_CODES.has(error?.code)) throw error;
			let stale = false;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > staleLockMs) {
					// 时间超时且持有者进程已消失才算过期；活进程的锁不可偷（长写保护）
					let owner = "";
					try { owner = readFileSync(lockPath, "utf-8"); } catch {}
					const pid = parseOwnerPid(owner);
					stale = pid !== undefined && !isProcessAlive(pid);
				}
			} catch {}
			if (stale) stealStaleLock(lockPath);
			Atomics.wait(waiter, 0, 0, 10);
		}
	}
	throw new Error(`JSON store lock timeout: ${path}`);
}

export function updateJsonStore<T, R>(
	path: string,
	createDefault: () => T,
	validate: JsonStoreValidator<T>,
	update: (store: T) => R,
	options: JsonStoreOptions = {},
): R {
	const release = acquireStoreLock(path, options);
	try {
		const store = readJsonStore(path, createDefault, validate);
		const result = update(store);
		writeJsonFileAtomic(path, store, { backup: options.backup });
		return result;
	} finally {
		release();
	}
}
