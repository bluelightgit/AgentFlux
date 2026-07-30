import { join } from "node:path";
import { existsSync } from "node:fs";
import { readJsonStore, updateJsonStore } from "./json-store";
import { assertSafeOpaqueId } from "./safe-path";

export type AgentRunStatus =
	| "starting"
	| "running"
	| "stop_requested"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out";

export interface AgentRunRecord {
	id: string;
	taskId?: string;
	executionId?: string;
	sessionId: string;
	agent: string;
	role: string;
	currentTask: string;
	model?: string;
	kind: "ephemeral" | "persistent";
	status: AgentRunStatus;
	pid?: number;
	attempt: number;
	costUsd: number;
	error?: string;
	createdAt: string;
	updatedAt: string;
	heartbeatAt: string;
	finishedAt?: string;
}

interface AgentRunStore {
	version: 1;
	runs: AgentRunRecord[];
}

const TERMINAL = new Set<AgentRunStatus>(["completed", "failed", "cancelled", "timed_out"]);
const createStore = (): AgentRunStore => ({ version: 1, runs: [] });
const isStore = (value: unknown): value is AgentRunStore =>
	!!value
	&& typeof value === "object"
	&& (value as AgentRunStore).version === 1
	&& Array.isArray((value as AgentRunStore).runs);

function registryPath(fluxDir: string): string {
	return join(fluxDir, "runtime", "runs.json");
}

export function registerAgentRun(
	fluxDir: string,
	input: Omit<AgentRunRecord, "status" | "attempt" | "costUsd" | "createdAt" | "updatedAt" | "heartbeatAt">,
): AgentRunRecord {
	const id = assertSafeOpaqueId(input.id, "runId");
	if (input.taskId) assertSafeOpaqueId(input.taskId, "taskId");
	if (input.executionId) assertSafeOpaqueId(input.executionId, "executionId");
	return updateJsonStore(registryPath(fluxDir), createStore, isStore, store => {
		if (store.runs.some(run => run.id === id)) throw new Error(`Agent run already exists: ${id}`);
		const now = new Date().toISOString();
		const record: AgentRunRecord = {
			...input,
			id,
			status: "starting",
			attempt: 0,
			costUsd: 0,
			createdAt: now,
			updatedAt: now,
			heartbeatAt: now,
		};
		store.runs.push(record);
		return structuredClone(record);
	});
}

function updateRun(
	fluxDir: string,
	runId: string,
	update: (run: AgentRunRecord, now: string) => void,
): AgentRunRecord {
	assertSafeOpaqueId(runId, "runId");
	return updateJsonStore(registryPath(fluxDir), createStore, isStore, store => {
		const run = store.runs.find(item => item.id === runId);
		if (!run) throw new Error(`Agent run not found: ${runId}`);
		const now = new Date().toISOString();
		update(run, now);
		run.updatedAt = now;
		return structuredClone(run);
	});
}

export function markAgentRunRunning(fluxDir: string, runId: string, pid: number, attempt: number): AgentRunRecord {
	return updateRun(fluxDir, runId, (run, now) => {
		if (TERMINAL.has(run.status)) throw new Error(`Historical Agent run is immutable: ${runId} is ${run.status}`);
		run.status = "running";
		run.pid = pid;
		run.attempt = attempt;
		run.heartbeatAt = now;
	});
}

export function heartbeatAgentRun(fluxDir: string, runId: string): AgentRunRecord {
	return updateRun(fluxDir, runId, (run, now) => {
		if (run.status !== "running" && run.status !== "stop_requested") {
			throw new Error(`Agent run is not active: ${runId} is ${run.status}`);
		}
		run.heartbeatAt = now;
	});
}

export function markAgentRunStopRequested(fluxDir: string, runId: string): AgentRunRecord {
	return updateRun(fluxDir, runId, run => {
		if (run.status !== "starting" && run.status !== "running") {
			throw new Error(`Agent run cannot be stopped: ${runId} is ${run.status}`);
		}
		run.status = "stop_requested";
	});
}

export function finishAgentRun(
	fluxDir: string,
	runId: string,
	input: { status: Extract<AgentRunStatus, "completed" | "failed" | "cancelled" | "timed_out">; costUsd?: number; error?: string },
): AgentRunRecord {
	return updateRun(fluxDir, runId, (run, now) => {
		if (TERMINAL.has(run.status)) {
			if (run.status !== input.status) throw new Error(`Historical Agent run is immutable: ${runId} is ${run.status}`);
			return;
		}
		run.status = input.status;
		run.costUsd = input.costUsd ?? run.costUsd;
		run.error = input.error;
		run.finishedAt = now;
		run.heartbeatAt = now;
		run.pid = undefined;
	});
}

export function listAgentRuns(fluxDir: string, filter: { taskId?: string; agent?: string; activeOnly?: boolean } = {}): AgentRunRecord[] {
	return readJsonStore(registryPath(fluxDir), createStore, isStore).runs
		.filter(run => !filter.taskId || run.taskId === filter.taskId)
		.filter(run => !filter.agent || run.agent === filter.agent)
		.filter(run => !filter.activeOnly || !TERMINAL.has(run.status))
		.slice()
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getAgentRun(fluxDir: string, runId: string): AgentRunRecord | undefined {
	assertSafeOpaqueId(runId, "runId");
	return readJsonStore(registryPath(fluxDir), createStore, isStore).runs.find(run => run.id === runId);
}

export function reconcileStaleAgentRuns(
	fluxDir: string,
	options: { now?: Date; staleAfterMs?: number } = {},
): AgentRunRecord[] {
	const nowDate = options.now ?? new Date();
	const nowMs = nowDate.getTime();
	const staleAfterMs = options.staleAfterMs ?? 30_000;
	if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1_000) throw new Error("Run Registry staleAfterMs must be at least 1000");
	if (!existsSync(registryPath(fluxDir))) return [];
	return updateJsonStore(registryPath(fluxDir), createStore, isStore, store => {
		const reconciled: AgentRunRecord[] = [];
		for (const run of store.runs) {
			if (TERMINAL.has(run.status)) continue;
			const heartbeatMs = Date.parse(run.heartbeatAt);
			if (Number.isFinite(heartbeatMs) && nowMs - heartbeatMs <= staleAfterMs) continue;
			run.status = "failed";
			run.error = "runtime heartbeat expired before terminal convergence";
			run.updatedAt = nowDate.toISOString();
			run.heartbeatAt = nowDate.toISOString();
			run.finishedAt = nowDate.toISOString();
			run.pid = undefined;
			reconciled.push(structuredClone(run));
		}
		return reconciled;
	});
}
