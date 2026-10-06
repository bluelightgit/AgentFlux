/**
 * 项目级空间互斥状态（docs/32 阶段三）。
 *
 * active-context.json 是"同一项目同时只运行一个空间"的权威来源：
 * - 空间：main（主 Agent 直接派发的子代理）/ workflow（DAG 运行）/ community（Issue 协作）
 * - 互斥规则：注册新运行时，若存在活跃条目且其空间 ≠ 目标空间 → 拒绝；
 *   空间内并行允许（DAG 并行节点、community 多 issue 多 agent）。
 * - 条目由持有方在 finally 中释放；进程崩溃残留由 pid 存活探测 + TTL 清理。
 */

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isProcessInstanceActive } from "./fs-lock";
import { getProcessIdentity, type ProcessIdentity } from "./process-identity";
import { readJsonStore, updateJsonStore } from "./json-store";
import { isSdkRunOwner, isSdkRunOwnerActive, type SdkRunOwner } from "./runtime-owner";

export type SpaceContext = "main" | "workflow" | "community";

export interface ActiveContextEntry {
	/** 具体空间运行实例的 lease 标识；释放必须优先使用它，不能按共享名称误删。 */
	leaseId: string;
	/** 条目标识（agent name / executionId / issue/claim 前缀）。 */
	name: string;
	context: SpaceContext;
	/** 空间内作用域（workflow executionId / claimId 等），用于定向展示。 */
	scope?: string;
	task: string;
	pid: number;
	processIdentity?: ProcessIdentity;
	runtimeOwner?: SdkRunOwner;
	startedAt: string;
	updatedAt: string;
}

interface ActiveContextState {
	context: SpaceContext | null;
	entries: ActiveContextEntry[];
}

const createState = (): ActiveContextState => ({ context: null, entries: [] });
const isState = (value: unknown): value is ActiveContextState =>
	!!value && typeof value === "object" && Array.isArray((value as ActiveContextState).entries);

export function activeContextPath(cwd: string): string {
	return join(cwd, ".agentflux", "runtime", "active-context.json");
}

/** Only proven exit/reuse expires a lease; unknown and legacy live owners stay protected. */
function isActiveEntry(entry: ActiveContextEntry, cwd: string): boolean {
	return entry.runtimeOwner ? isSdkRunOwnerActive(cwd, entry.runtimeOwner) : isProcessInstanceActive(entry.pid, entry.processIdentity);
}

/**
 * 旧 active-context 条目没有 leaseId。读取时为它生成稳定的内存标识，
 * 让新 API 可以安全地操作旧状态；下一次写入会把该标识持久化。
 */
function normalizeEntry(entry: ActiveContextEntry, index: number): ActiveContextEntry {
	const raw = entry as ActiveContextEntry & { leaseId?: unknown };
	const leaseId = typeof raw.leaseId === "string" && raw.leaseId.trim()
		? raw.leaseId
		: `legacy-${index}-${entry.name}-${entry.scope ?? ""}-${entry.pid}-${entry.startedAt}`;
	return { ...entry, leaseId };
}

function liveEntries(state: ActiveContextState, cwd: string): ActiveContextEntry[] {
	return state.entries.map(normalizeEntry).filter(entry => isActiveEntry(entry, cwd));
}

/** 读取当前活跃空间状态（stale 条目即时清理但不写回）。 */
export function readActiveContext(cwd: string): ActiveContextState {
	const state = readJsonStore(activeContextPath(cwd), createState, isState);
	const entries = liveEntries(state, cwd);
	return {
		context: entries.length > 0 ? state.context : null,
		entries,
	};
}

function contextLabel(entries: ActiveContextEntry[]): string {
	return entries.map(entry => `${entry.name} (${entry.context})`).join(", ");
}

/** 注册一条活跃运行：存在非目标空间的活跃条目 → 拒绝（互斥）。 */
export function registerActiveContext(
	cwd: string,
	entry: { name: string; context: SpaceContext; scope?: string; task: string; pid?: number; runtimeOwner?: SdkRunOwner },
): ActiveContextEntry {
	if (!entry.name.trim()) throw new Error("active context entry requires name");
	if (entry.runtimeOwner && !isSdkRunOwner(entry.runtimeOwner)) throw new Error("Invalid active context logical owner");
	const record: ActiveContextEntry = {
		leaseId: `lease-${randomUUID()}`,
		name: entry.name,
		context: entry.context,
		scope: entry.scope,
		task: entry.task.slice(0, 200),
		pid: entry.pid ?? process.pid,
		processIdentity: getProcessIdentity(entry.pid ?? process.pid),
		runtimeOwner: entry.runtimeOwner,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	// Drop only owners proven gone or replaced; do not infer death from a failed probe.
	pruneStaleActiveContext(cwd);
	updateJsonStore(activeContextPath(cwd), createState, isState, state => {
		const live = liveEntries(state, cwd);
		const conflict = live.find(agent => agent.context !== record.context);
		if (conflict) {
			throw new Error(
				`The project already has an active ${conflict.context} space (${conflict.name} · ${conflict.task.slice(0, 60)}). ` +
					`Cannot start a ${record.context} space concurrently; wait for completion or stop it with /flux agent stop`,
			);
		}
		live.push(record);
		state.entries = live;
		state.context = record.context;
		return structuredClone(record);
	});
	return record;
}

/**
 * 释放一条具体活跃运行。selector 优先按 leaseId 匹配；为兼容旧调用，
 * 唯一的 name/scope 也可匹配，但共享 name/scope 的多个实例会 fail-closed，
 * 不会像旧实现一样一次删除其他并行实例。
 */
export function releaseActiveContext(cwd: string, selector: string): boolean {
	let removed = false;
	updateJsonStore(activeContextPath(cwd), createState, isState, state => {
		const live = liveEntries(state, cwd);
		const exact = live.find(entry => entry.leaseId === selector);
		const matches = exact
			? [exact]
			: live.filter(entry => entry.name === selector || entry.scope === selector);
		if (!exact && matches.length > 1) {
			throw new Error(`Active context selector is ambiguous: ${selector}; release the concrete leaseId`);
		}
		const target = matches[0];
		const kept = target ? live.filter(entry => entry.leaseId !== target.leaseId) : live;
		removed = !!target;
		state.entries = kept;
		state.context = kept.length > 0 ? kept[kept.length - 1].context : null;
	});
	return removed;
}

/**
 * 按明确谓词批量释放同一终态对象的 leases。仅用于对象整体终态清理，
 * 普通运行释放必须使用 releaseActiveContext 的具体 leaseId。
 */
export function releaseActiveContexts(cwd: string, predicate: (entry: ActiveContextEntry) => boolean): number {
	let removed = 0;
	updateJsonStore(activeContextPath(cwd), createState, isState, state => {
		const live = liveEntries(state, cwd);
		const kept = live.filter(entry => {
			if (!predicate(entry)) return true;
			removed++;
			return false;
		});
		state.entries = kept;
		state.context = kept.length > 0 ? kept[kept.length - 1].context : null;
	});
	return removed;
}

/** 清理崩溃残留（持有 pid 已消失的条目）并返回清理的条目名。 */
export function pruneStaleActiveContext(cwd: string): string[] {
	const pruned: string[] = [];
	updateJsonStore(activeContextPath(cwd), createState, isState, state => {
		const normalized = state.entries.map(normalizeEntry);
		const live = normalized.filter(entry => isActiveEntry(entry, cwd));
		for (const entry of normalized) if (!isActiveEntry(entry, cwd)) pruned.push(entry.name);
		state.entries = live;
		state.context = live.length > 0 ? live[live.length - 1].context : null;
	});
	return pruned;
}

/** 当前是否有活跃条目（用于状态展示与只读判断）。 */
export function hasActiveContext(cwd: string): boolean {
	return readActiveContext(cwd).entries.length > 0;
}

/** 展示格式（/flux space 与 TUI 共用）。 */
export function formatActiveContext(state: ActiveContextState): string {
	if (state.entries.length === 0) return "no active context";
	return state.entries
		.map(entry => `[${entry.context}] ${entry.name}${entry.scope ? ` · scope ${entry.scope}` : ""} · ${entry.task.slice(0, 80)} @ ${entry.startedAt} (pid ${entry.pid})`)
		.join("\n");
}
