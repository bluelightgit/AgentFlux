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

export type JsonStoreValidator<T> = (value: unknown) => value is T;

export interface JsonStoreOptions {
	lockTimeoutMs?: number;
	staleLockMs?: number;
	backup?: boolean;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

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
		renameSync(temporary, path);
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
				try {
					if (readFileSync(lockPath, "utf-8") === owner) unlinkSync(lockPath);
				} catch {}
			};
		} catch (error: any) {
			if (fd !== null) {
				try { closeSync(fd); } catch {}
			}
			if (error?.code !== "EEXIST") throw error;
			let stale = false;
			try { stale = Date.now() - statSync(lockPath).mtimeMs > staleLockMs; } catch {}
			if (stale) {
				try { unlinkSync(lockPath); } catch {}
			}
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
