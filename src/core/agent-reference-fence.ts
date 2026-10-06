import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { updateJsonStore, withJsonStoreLock, type JsonStoreOptions, type JsonStoreValidator } from "./json-store";

// 跨 bundle 共用同步重入状态；不能在 await/Provider 等待期间持有该 Host fence。
const key = Symbol.for("agentflux.agentReferenceFence.v1");
const root = globalThis as typeof globalThis & { [key]?: Set<string> };
const held = root[key] ??= new Set<string>();

export function withAgentReferenceFence<R>(action: () => R): R {
	const path = resolve(join(homedir(), ".agentflux", "runtime", "agent-reference-fence"));
	if (action.constructor.name === "AsyncFunction") throw new Error("Agent reference fence requires a synchronous callback");
	const invoke = (): R => {
		const result = action();
		if (result && typeof (result as any).then === "function") throw new Error("Agent reference fence cannot span asynchronous work");
		return result;
	};
	if (held.has(path)) return invoke();
	return withJsonStoreLock(path, () => {
		held.add(path);
		try { return invoke(); } finally { held.delete(path); }
	});
}

/** 引用写入者先取 F，再取自己的 JSON store 锁；不改变原子写和损坏拒绝语义。 */
export function updateReferenceStore<T, R>(path: string, createDefault: () => T, validate: JsonStoreValidator<T>, update: (store: T) => R, options: JsonStoreOptions = {}): R {
	return withAgentReferenceFence(() => updateJsonStore(path, createDefault, validate, update, options));
}
