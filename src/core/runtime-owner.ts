import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getProcessIdentity, isProcessIdentity, type ProcessIdentity } from "./process-identity";
import { isProcessInstanceActive } from "./fs-lock";

/** SDK Run的逻辑fence。host是故障域身份，不是可单独终止的child PID。 */
export interface SdkRunOwner {
	kind: "sdk";
	runId: string;
	generation: string;
	host: ProcessIdentity;
}
const active = new Map<string, SdkRunOwner>();
const drained = new Set<string>();
const key = (cwd: string, owner: SdkRunOwner): string => `${resolve(cwd)}:${owner.runId}:${owner.generation}:${owner.host.pid}:${owner.host.birth}`;
export function isSdkRunOwner(value: unknown): value is SdkRunOwner {
	if (!value || typeof value !== "object") return false;
	const owner = value as SdkRunOwner;
	return owner.kind === "sdk" && typeof owner.runId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(owner.runId)
		&& typeof owner.generation === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(owner.generation) && isProcessIdentity(owner.host);
}
export function createSdkRunOwner(runId: string): SdkRunOwner {
	const host = getProcessIdentity();
	if (!host) throw new Error("SDK subagents require a verified Main process birth identity on this platform");
	return Object.freeze({ kind: "sdk", runId, generation: randomUUID(), host: Object.freeze(host) });
}
export function activateSdkRunOwner(cwd: string, owner: SdkRunOwner): void {
	if (!isSdkRunOwner(owner) || drained.has(key(cwd, owner))) throw new Error("Invalid or retired SDK Run owner");
	if ([...active.values()].some(value => value.runId === owner.runId)) throw new Error(`SDK Run already active: ${owner.runId}`);
	active.set(key(cwd, owner), owner);
}
/** 只能在所有SDK工作已idle、订阅与session已销毁后调用；不是取消请求。 */
export function retireSdkRunOwner(cwd: string, owner: SdkRunOwner): void {
	const id = key(cwd, owner);
	if (!active.delete(id)) return;
	drained.add(id);
	// Eviction means unknown/protected, never proof of death.
	if (drained.size > 8192) drained.delete(drained.values().next().value!);
}
/** 缺handle/心跳不证明死亡；只有同fence drain或Main确实退出/重用才能回收。 */
export function isSdkRunOwnerActive(cwd: string, owner: SdkRunOwner): boolean {
	if (!isSdkRunOwner(owner)) return true;
	if (!isProcessInstanceActive(owner.host.pid, owner.host)) return false;
	return !drained.has(key(cwd, owner));
}
