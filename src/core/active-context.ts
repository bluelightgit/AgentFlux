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
import { join } from "node:path";
import { isProcessAlive as isAlive } from "./fs-lock";
import { readJsonStore, updateJsonStore } from "./json-store";

export type SpaceContext = "main" | "workflow" | "community";

export interface ActiveContextEntry {
	/** 条目标识（agent name / executionId / issue id 前缀）。 */
	name: string;
	context: SpaceContext;
	/** 空间内作用域（workflow executionId / issueId），用于定向释放与展示。 */
	scope?: string;
	task: string;
	pid: number;
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

/** 读取当前活跃空间状态（stale 条目即时清理但不写回）。 */
export function readActiveContext(cwd: string): ActiveContextState {
	const state = readJsonStore(activeContextPath(cwd), createState, isState);
	const now = Date.now();
	return {
		context: state.context,
		entries: state.entries.filter(entry =>
			isAlive(entry.pid) && now - Date.parse(entry.updatedAt) < STALE_ENTRY_MS,
		),
	};
}


/** stale 阈值：超过该时长且 pid 消失的条目视为崩溃残留。 */
export const STALE_ENTRY_MS = 60 * 60 * 1000;

function contextLabel(entries: ActiveContextEntry[]): string {
	return entries.map(entry => `${entry.name} (${entry.context})`).join(", ");
}

/** 注册一条活跃运行：存在非目标空间的活跃条目 → 拒绝（互斥）。 */
export function registerActiveContext(
	cwd: string,
	entry: { name: string; context: SpaceContext; scope?: string; task: string; pid?: number },
): ActiveContextEntry {
	if (!entry.name.trim()) throw new Error("active context entry requires name");
	const record: ActiveContextEntry = {
		name: entry.name,
		context: entry.context,
		scope: entry.scope,
		task: entry.task.slice(0, 200),
		pid: entry.pid ?? process.pid,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	updateJsonStore(activeContextPath(cwd), createState, isState, state => {
		const live = state.entries.filter(agent => isAlive(agent.pid) && Date.now() - Date.parse(agent.updatedAt) < STALE_ENTRY_MS);
		const conflict = live.find(agent => agent.context !== record.context);
		if (conflict) {
			throw new Error(
				`项目已有 ${conflict.context} 空间活跃（${conflict.name} · ${conflict.task.slice(0, 60)}），` +
					`不能同时启动 ${record.context} 空间运行；请先等待其结束或 /flux agent stop 停止`,
			);
		}
		live.push(record);
		state.entries = live;
		state.context = record.context;
		return structuredClone(record);
	});
	return record;
}

/** 释放一条活跃运行（按 name 或 scope 精确匹配）。 */
export function releaseActiveContext(cwd: string, selector: string): boolean {
	let removed = false;
	updateJsonStore(activeContextPath(cwd), createState, isState, state => {
		const live = state.entries.filter(agent => isAlive(agent.pid) && Date.now() - Date.parse(agent.updatedAt) < STALE_ENTRY_MS);
		const kept = live.filter(agent => agent.name !== selector && agent.scope !== selector);
		removed = kept.length !== live.length;
		state.entries = kept;
		state.context = kept.length > 0 ? kept[kept.length - 1].context : null;
	});
	return removed;
}

/** 清理崩溃残留（pid 消失或超时）并返回清理的条目名。 */
export function pruneStaleActiveContext(cwd: string): string[] {
	const pruned: string[] = [];
	updateJsonStore(activeContextPath(cwd), createState, isState, state => {
		const now = Date.now();
		const live = state.entries.filter(agent => {
			const alive = isAlive(agent.pid) && now - Date.parse(agent.updatedAt) < STALE_ENTRY_MS;
			if (!alive) pruned.push(agent.name);
			return alive;
		});
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
