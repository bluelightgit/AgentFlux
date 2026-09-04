import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readJsonStore, updateJsonStore } from "./json-store";
import { assertSafeOpaqueId } from "./safe-path";
import { isProcessAlive } from "./fs-lock";
import { readActiveContext } from "./active-context";
import { getTask, getTaskExecution, updateTaskStatus } from "./task-registry";
import type { AgentRunHealth } from "./run-health";
export type { AgentRunHealth } from "./run-health";

export type AgentRunStatus =
	| "starting"
	| "running"
	| "stop_requested"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out";

/** 运行阶段是展示/诊断事实，不承担 Agent 身份生命周期。 */
export type AgentRunPhase =
	| "starting"
	| "running"
	| "tool"
	| "retrying"
	| "backoff"
	| "stopping"
	| "error"
	| "terminal"
	| (string & {});

export interface AgentRunEvent {
	at: string;
	type: string;
	phase: AgentRunPhase;
	summary: string;
}

export interface AgentRunRecord {
	id: string;
	taskId?: string;
	executionId?: string;
	sessionId: string;
	agent: string;
	role: string;
	currentTask: string;
	model?: string;
	provider?: string;
	kind: "ephemeral" | "persistent";
	status: AgentRunStatus;
	pid?: number;
	attempt: number;
	/** 累计 assistant 回合数（跨 retry attempt）。 */
	turns: number;
	/** 累计输入 token（跨 retry attempt）。 */
	input: number;
	/** 累计输出 token（跨 retry attempt）。 */
	output: number;
	/** 累计 cache-read token（跨 retry attempt）。 */
	cacheRead: number;
	/** 累计 cache-write token（跨 retry attempt）。 */
	cacheWrite: number;
	/** 当前已知最大上下文 token 数；不可回退。 */
	contextTokens: number;
	/** 累计成本（USD，跨 retry attempt）。 */
	costUsd: number;
	phase: AgentRunPhase;
	/** 健康维度独立于 status；告警不会自动结束运行。 */
	health: AgentRunHealth;
	healthReason?: string;
	/** 最近一次语义进展时间；heartbeatAt 只能证明进程仍存活。 */
	lastProgressAt: string;
	lastProgressType: string;
	lastProgressSummary: string;
	healthWarningAt?: string;
	healthWarningCount: number;
	repeatActionSignature?: string;
	repeatActionCount: number;
	repeatActionWindowStartedAt?: string;
	/** 显式模型执行 deadline 的绝对时间；缺失表示没有硬 deadline。 */
	deadlineAt?: string;
	/** 最近一次在线事件时间；heartbeatAt 仍单独表示 Registry 心跳写入时间。 */
	lastActivityAt: string;
	lastActivityType: string;
	lastActivitySummary: string;
	/** 运行期间最近一次模型错误；终态仍保留诊断历史。 */
	modelError?: string;
	/** 运行期间最近一次 provider/API 错误；终态仍保留诊断历史。 */
	providerError?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
	heartbeatAt: string;
	finishedAt?: string;
	/** 有界的最近运行事件；与 liveness/progress 最新字段互补，供 inspect 追踪历史。 */
	recentEvents?: AgentRunEvent[];
}

/**
 * 在线遥测采用绝对快照，不接受增量。调用方必须提供完整 usage counters，
 * Registry 会在同一文件锁/原子替换事务内校验并写入。
 */
export interface AgentRunParentBudget {
	maxCostUsd?: number;
	maxTurns?: number;
	maxInputTokens?: number;
}

export interface AgentRunSnapshot {
	phase: AgentRunPhase;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	contextTokens: number;
	costUsd: number;
	attempt?: number;
	pid?: number | null;
	model?: string | null;
	provider?: string | null;
	lastActivityAt?: string;
	lastActivityType?: string;
	lastActivitySummary?: string;
	modelError?: string | null;
	providerError?: string | null;
	health?: AgentRunHealth;
	healthReason?: string | null;
	lastProgressAt?: string;
	lastProgressType?: string;
	lastProgressSummary?: string;
	healthWarningAt?: string | null;
	healthWarningCount?: number;
	repeatActionSignature?: string | null;
	repeatActionCount?: number;
	repeatActionWindowStartedAt?: string | null;
}

interface AgentRunBudgetReservation {
	runId: string;
	taskId: string;
	costUsd: number;
	turns: number;
	input: number;
	updatedAt: string;
}

interface AgentRunRecoveryFence {
	taskId: string;
	executionId: string;
	runId: string;
	createdAt: string;
}

interface AgentRunStore {
	version: 1;
	runs: AgentRunRecord[];
	/** Per-Run observed-usage reservations, retained for atomic parent aggregation. */
	reservations?: AgentRunBudgetReservation[];
	/** Cross-file recovery fence preventing a new child during parent convergence. */
	recoveryFences?: AgentRunRecoveryFence[];
}

const TERMINAL = new Set<AgentRunStatus>(["completed", "failed", "cancelled", "timed_out"]);
const ACTIVE = new Set<AgentRunStatus>(["starting", "running", "stop_requested"]);
const TASK_TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const HEARTBEAT_RECOVERY_ERROR = "runtime heartbeat expired before terminal convergence";
/**
 * Recovery fences are deliberately bounded, but an unresolved safety fence must
 * never be evicted to make room for another one.  When this bound is reached,
 * recovery fails closed until an existing fence is proven resolved.
 */
const MAX_RECOVERY_FENCES = 32;
const USAGE_FIELDS = ["turns", "input", "output", "cacheRead", "cacheWrite", "contextTokens", "costUsd"] as const;

const createStore = (): AgentRunStore => ({ version: 1, runs: [], reservations: [], recoveryFences: [] });
const isStatus = (value: unknown): value is AgentRunStatus =>
	value === "starting" || value === "running" || value === "stop_requested"
	|| value === "completed" || value === "failed" || value === "cancelled" || value === "timed_out";
const isHealth = (value: unknown): value is AgentRunHealth =>
	value === "healthy" || value === "waiting_provider" || value === "waiting_tool"
	|| value === "quiet" || value === "suspected_stall" || value === "suspected_loop" || value === "context_pressure";
const isNonNegativeFiniteOrMissing = (value: unknown): boolean =>
	value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const isRunShape = (value: unknown): value is AgentRunRecord => {
	if (!value || typeof value !== "object") return false;
	const run = value as Record<string, unknown>;
	if (typeof run.id !== "string" || !run.id || typeof run.sessionId !== "string"
		|| typeof run.agent !== "string" || typeof run.role !== "string"
		|| typeof run.currentTask !== "string" || !isStatus(run.status)
		|| (run.kind !== "ephemeral" && run.kind !== "persistent")) return false;
	if (!USAGE_FIELDS.every(field => isNonNegativeFiniteOrMissing(run[field]))) return false;
	if (!isNonNegativeFiniteOrMissing(run.attempt)) return false;
	if (run.pid !== undefined && !(typeof run.pid === "number" && Number.isInteger(run.pid) && run.pid > 0)) return false;
	if (run.health !== undefined && !isHealth(run.health)) return false;
	if (run.recentEvents !== undefined && (!Array.isArray(run.recentEvents) || run.recentEvents.some(event => !event || typeof event !== "object" || typeof (event as any).at !== "string" || typeof (event as any).type !== "string" || typeof (event as any).phase !== "string" || typeof (event as any).summary !== "string"))) return false;
	for (const field of ["modelError", "providerError", "error", "healthReason", "lastProgressType", "lastProgressSummary", "repeatActionSignature"] as const) {
		if (run[field] !== undefined && typeof run[field] !== "string") return false;
	}
	return true;
};
const isReservationShape = (value: unknown): value is AgentRunBudgetReservation => {
	if (!value || typeof value !== "object") return false;
	const reservation = value as Record<string, unknown>;
	return typeof reservation.runId === "string" && reservation.runId.length > 0
		&& typeof reservation.taskId === "string" && reservation.taskId.length > 0
		&& isNonNegativeFiniteOrMissing(reservation.costUsd)
		&& isNonNegativeFiniteOrMissing(reservation.turns)
		&& isNonNegativeFiniteOrMissing(reservation.input)
		&& typeof reservation.updatedAt === "string";
};
const isRecoveryFenceShape = (value: unknown): value is AgentRunRecoveryFence => {
	if (!value || typeof value !== "object") return false;
	const fence = value as Record<string, unknown>;
	return typeof fence.taskId === "string" && fence.taskId.length > 0
		&& typeof fence.executionId === "string" && fence.executionId.length > 0
		&& typeof fence.runId === "string" && fence.runId.length > 0
		&& typeof fence.createdAt === "string" && Number.isFinite(Date.parse(fence.createdAt));
};
const isStore = (value: unknown): value is AgentRunStore => {
	if (!value || typeof value !== "object") return false;
	const store = value as AgentRunStore;
	return store.version === 1
		&& Array.isArray(store.runs)
		&& store.runs.every(isRunShape)
		&& (store.reservations === undefined || (Array.isArray(store.reservations) && store.reservations.every(isReservationShape)))
		// Do not reject an older store merely because it already contains more
		// fences than the current bound; claimRecoveryFence fails closed until
		// those records are resolved, while terminal cleanup can still repair it.
		&& (store.recoveryFences === undefined || (Array.isArray(store.recoveryFences) && store.recoveryFences.every(isRecoveryFenceShape)));
};

function registryPath(fluxDir: string): string {
	return join(fluxDir, "runtime", "runs.json");
}

function assertNonNegativeFinite(value: unknown, name: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`Run Registry ${name} must be a finite non-negative number`);
	}
}

function assertAttempt(value: unknown): asserts value is number {
	assertNonNegativeFinite(value, "attempt");
	if (!Number.isInteger(value)) throw new Error("Run Registry attempt must be an integer");
}

function assertOptionalText(value: unknown, name: string, maxLength = 2000): asserts value is string | null | undefined {
	if (value !== undefined && value !== null
		&& (typeof value !== "string" || value.length > maxLength || value.includes("\u0000"))) {
		throw new Error(`Run Registry ${name} must be text (max ${maxLength} characters)`);
	}
}

function assertTimestamp(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Run Registry ${name} must be a valid timestamp`);
	}
}

/**
 * 读取旧 runs.json 时只在内存中补齐在线字段。不会把归一化结果回写，
 * 因此读取历史终态不会产生迁移副作用，也不会篡改原始终态记录。
 */
function normalizeRunRecord(raw: AgentRunRecord): AgentRunRecord {
	const run = raw as AgentRunRecord & Record<string, unknown>;
	const now = new Date().toISOString();
	const createdAt = typeof run.createdAt === "string" && Number.isFinite(Date.parse(run.createdAt)) ? run.createdAt : now;
	const updatedAt = typeof run.updatedAt === "string" && Number.isFinite(Date.parse(run.updatedAt)) ? run.updatedAt : createdAt;
	const heartbeatAt = typeof run.heartbeatAt === "string" && Number.isFinite(Date.parse(run.heartbeatAt)) ? run.heartbeatAt : updatedAt;
	const phase = typeof run.phase === "string" && run.phase.trim()
		? run.phase
		: TERMINAL.has(run.status) ? "terminal" : run.status === "starting" ? "starting" : "running";
	const lastActivityAt = typeof run.lastActivityAt === "string" && Number.isFinite(Date.parse(run.lastActivityAt))
		? run.lastActivityAt : heartbeatAt;
	const lastActivityType = typeof run.lastActivityType === "string" && run.lastActivityType.trim()
		? run.lastActivityType : TERMINAL.has(run.status) ? "terminal" : "legacy";
	const lastActivitySummary = typeof run.lastActivitySummary === "string"
		? run.lastActivitySummary
		: run.error ?? run.currentTask ?? "legacy run";
	const health = isHealth(run.health) ? run.health : "healthy";
	const lastProgressAt = typeof run.lastProgressAt === "string" && Number.isFinite(Date.parse(run.lastProgressAt))
		? run.lastProgressAt : lastActivityAt;
	const lastProgressType = typeof run.lastProgressType === "string" && run.lastProgressType.trim()
		? run.lastProgressType : lastActivityType;
	const lastProgressSummary = typeof run.lastProgressSummary === "string"
		? run.lastProgressSummary : lastActivitySummary;
	const healthReason = typeof run.healthReason === "string" ? run.healthReason : undefined;
	const healthWarningAt = typeof run.healthWarningAt === "string" && Number.isFinite(Date.parse(run.healthWarningAt)) ? run.healthWarningAt : undefined;
	const repeatActionWindowStartedAt = typeof run.repeatActionWindowStartedAt === "string" && Number.isFinite(Date.parse(run.repeatActionWindowStartedAt)) ? run.repeatActionWindowStartedAt : undefined;
	const recentEvents = Array.isArray(run.recentEvents)
		? run.recentEvents.filter(event => event && typeof event.at === "string" && Number.isFinite(Date.parse(event.at)) && typeof event.type === "string" && typeof event.phase === "string" && typeof event.summary === "string").slice(-20)
		: [];
	const result: AgentRunRecord = {
		...run,
		recentEvents,
		id: run.id,
		status: run.status,
		sessionId: run.sessionId,
		agent: run.agent,
		role: run.role,
		currentTask: run.currentTask,
		kind: run.kind,
		attempt: run.attempt ?? 0,
		turns: run.turns ?? 0,
		input: run.input ?? 0,
		output: run.output ?? 0,
		cacheRead: run.cacheRead ?? 0,
		cacheWrite: run.cacheWrite ?? 0,
		contextTokens: run.contextTokens ?? 0,
		costUsd: run.costUsd ?? 0,
		phase,
		health,
		healthReason,
		lastProgressAt,
		lastProgressType,
		lastProgressSummary,
		healthWarningAt,
		healthWarningCount: typeof run.healthWarningCount === "number" && Number.isInteger(run.healthWarningCount) && run.healthWarningCount >= 0 ? run.healthWarningCount : 0,
		repeatActionSignature: typeof run.repeatActionSignature === "string" ? run.repeatActionSignature : undefined,
		repeatActionCount: typeof run.repeatActionCount === "number" && Number.isInteger(run.repeatActionCount) && run.repeatActionCount >= 0 ? run.repeatActionCount : 0,
		repeatActionWindowStartedAt,
		deadlineAt: typeof run.deadlineAt === "string" && Number.isFinite(Date.parse(run.deadlineAt)) ? run.deadlineAt : undefined,
		createdAt,
		updatedAt,
		heartbeatAt,
		lastActivityAt,
		lastActivityType,
		lastActivitySummary,
	};
	return result;
}

function ensureMutableRunDefaults(run: AgentRunRecord): void {
	const normalized = normalizeRunRecord(run);
	Object.assign(run, normalized);
}

function assertUsageSnapshot(snapshot: AgentRunSnapshot): void {
	for (const field of USAGE_FIELDS) assertNonNegativeFinite(snapshot[field], field);
	if (snapshot.attempt !== undefined) assertAttempt(snapshot.attempt);
	if (snapshot.pid !== undefined && snapshot.pid !== null
		&& (!(typeof snapshot.pid === "number") || !Number.isInteger(snapshot.pid) || snapshot.pid <= 0)) {
		throw new Error("Run Registry pid must be a positive integer");
	}
	if (snapshot.model !== undefined && snapshot.model !== null) assertOptionalText(snapshot.model, "model", 300);
	if (snapshot.provider !== undefined && snapshot.provider !== null) assertOptionalText(snapshot.provider, "provider", 300);
	assertOptionalText(snapshot.lastActivityType, "lastActivityType", 100);
	assertOptionalText(snapshot.lastActivitySummary, "lastActivitySummary");
	assertOptionalText(snapshot.modelError, "modelError");
	assertOptionalText(snapshot.providerError, "providerError");
	if (snapshot.health !== undefined && !isHealth(snapshot.health)) throw new Error(`Run Registry health is invalid: ${snapshot.health}`);
	assertOptionalText(snapshot.healthReason, "healthReason");
	assertOptionalText(snapshot.lastProgressType, "lastProgressType", 100);
	assertOptionalText(snapshot.lastProgressSummary, "lastProgressSummary");
	if (snapshot.healthWarningCount !== undefined) {
		assertNonNegativeFinite(snapshot.healthWarningCount, "healthWarningCount");
		if (!Number.isInteger(snapshot.healthWarningCount)) throw new Error("Run Registry healthWarningCount must be an integer");
	}
	if (snapshot.repeatActionCount !== undefined) {
		assertNonNegativeFinite(snapshot.repeatActionCount, "repeatActionCount");
		if (!Number.isInteger(snapshot.repeatActionCount)) throw new Error("Run Registry repeatActionCount must be an integer");
	}
	if (snapshot.lastActivityAt !== undefined) assertTimestamp(snapshot.lastActivityAt, "lastActivityAt");
	if (snapshot.lastProgressAt !== undefined) assertTimestamp(snapshot.lastProgressAt, "lastProgressAt");
	if (snapshot.healthWarningAt !== undefined && snapshot.healthWarningAt !== null) assertTimestamp(snapshot.healthWarningAt, "healthWarningAt");
	if (snapshot.repeatActionWindowStartedAt !== undefined && snapshot.repeatActionWindowStartedAt !== null) assertTimestamp(snapshot.repeatActionWindowStartedAt, "repeatActionWindowStartedAt");
	if (typeof snapshot.phase !== "string" || !snapshot.phase.trim() || snapshot.phase.length > 100 || snapshot.phase.includes("\u0000")) {
		throw new Error("Run Registry phase must be non-empty text (max 100 characters)");
	}
}

function appendRecentRunEvent(run: AgentRunRecord, event: AgentRunEvent): void {
	const events = Array.isArray(run.recentEvents) ? run.recentEvents : (run.recentEvents = []);
	const previous = events.at(-1);
	if (previous?.type === event.type && previous.phase === event.phase && previous.summary === event.summary) return;
	events.push({ ...event, summary: event.summary.slice(0, 500) });
	if (events.length > 20) events.splice(0, events.length - 20);
}

function applyAbsoluteSnapshot(run: AgentRunRecord, snapshot: AgentRunSnapshot, now: string): void {
	ensureMutableRunDefaults(run);
	assertUsageSnapshot(snapshot);
	for (const field of USAGE_FIELDS) {
		if (snapshot[field] < run[field]) {
			throw new Error(`Run Registry ${field} cannot move backwards (${snapshot[field]} < ${run[field]})`);
		}
	}
	if (snapshot.attempt !== undefined && snapshot.attempt < run.attempt) {
		throw new Error(`Run Registry attempt cannot move backwards (${snapshot.attempt} < ${run.attempt})`);
	}
	if (snapshot.lastActivityAt !== undefined && Date.parse(snapshot.lastActivityAt) < Date.parse(run.lastActivityAt)) {
		throw new Error("Run Registry lastActivityAt cannot move backwards");
	}
	if (snapshot.lastProgressAt !== undefined && Date.parse(snapshot.lastProgressAt) < Date.parse(run.lastProgressAt)) {
		throw new Error("Run Registry lastProgressAt cannot move backwards");
	}
	run.phase = snapshot.phase;
	for (const field of USAGE_FIELDS) run[field] = snapshot[field];
	if (snapshot.attempt !== undefined) run.attempt = snapshot.attempt;
	if (snapshot.pid !== undefined) run.pid = snapshot.pid === null ? undefined : snapshot.pid;
	if (snapshot.model !== undefined) run.model = snapshot.model === null ? undefined : snapshot.model;
	if (snapshot.provider !== undefined) run.provider = snapshot.provider === null ? undefined : snapshot.provider;
	if (snapshot.lastActivityAt !== undefined) run.lastActivityAt = snapshot.lastActivityAt;
	if (snapshot.lastActivityType !== undefined) run.lastActivityType = snapshot.lastActivityType ?? "";
	if (snapshot.lastActivitySummary !== undefined) run.lastActivitySummary = snapshot.lastActivitySummary ?? "";
	if (snapshot.modelError !== undefined) run.modelError = snapshot.modelError ?? undefined;
	if (snapshot.providerError !== undefined) run.providerError = snapshot.providerError ?? undefined;
	if (snapshot.health !== undefined) run.health = snapshot.health;
	if (snapshot.healthReason !== undefined) run.healthReason = snapshot.healthReason ?? undefined;
	if (snapshot.lastProgressAt !== undefined) run.lastProgressAt = snapshot.lastProgressAt;
	if (snapshot.lastProgressType !== undefined) run.lastProgressType = snapshot.lastProgressType ?? "";
	if (snapshot.lastProgressSummary !== undefined) run.lastProgressSummary = snapshot.lastProgressSummary ?? "";
	if (snapshot.healthWarningAt !== undefined) run.healthWarningAt = snapshot.healthWarningAt ?? undefined;
	if (snapshot.healthWarningCount !== undefined) run.healthWarningCount = snapshot.healthWarningCount;
	if (snapshot.repeatActionSignature !== undefined) run.repeatActionSignature = snapshot.repeatActionSignature ?? undefined;
	if (snapshot.repeatActionCount !== undefined) run.repeatActionCount = snapshot.repeatActionCount;
	if (snapshot.repeatActionWindowStartedAt !== undefined) run.repeatActionWindowStartedAt = snapshot.repeatActionWindowStartedAt ?? undefined;
	if (snapshot.lastActivityType !== undefined || snapshot.lastActivitySummary !== undefined) {
		appendRecentRunEvent(run, {
			at: snapshot.lastActivityAt ?? now,
			type: snapshot.lastActivityType ?? run.lastActivityType,
			phase: snapshot.phase,
			summary: snapshot.lastActivitySummary ?? run.lastActivitySummary,
		});
	}
	// 任意成功的绝对快照也证明进程仍在线；heartbeatAt 与 activity 时间分离。
	run.heartbeatAt = now;
}

function updateRun(
	fluxDir: string,
	runId: string,
	update: (run: AgentRunRecord, now: string, store: AgentRunStore) => void,
): AgentRunRecord {
	assertSafeOpaqueId(runId, "runId");
	return updateJsonStore(registryPath(fluxDir), createStore, isStore, store => {
		const run = store.runs.find(item => item.id === runId);
		if (!run) throw new Error(`Agent run not found: ${runId}`);
		const now = new Date().toISOString();
		update(run, now, store);
		run.updatedAt = now;
		return structuredClone(normalizeRunRecord(run));
	});
}

export interface AgentRunRegistrationLimits {
	/** 在同一个 parent task 下原子限制 active Run 数，避免 check-then-register 竞态。 */
	parentMaxParallel?: number;
	/** 注册 parent usage reservation，后续绝对快照在同一锁内更新 reservation。 */
	parentBudget?: AgentRunParentBudget;
}

export function registerAgentRun(
	fluxDir: string,
	input: Omit<AgentRunRecord, "status" | "attempt" | "turns" | "input" | "output" | "cacheRead" | "cacheWrite" | "contextTokens" | "costUsd" | "phase" | "health" | "healthReason" | "lastProgressAt" | "lastProgressType" | "lastProgressSummary" | "healthWarningAt" | "healthWarningCount" | "repeatActionSignature" | "repeatActionCount" | "repeatActionWindowStartedAt" | "lastActivityAt" | "lastActivityType" | "lastActivitySummary" | "createdAt" | "updatedAt" | "heartbeatAt" | "recentEvents">,
	limits: AgentRunRegistrationLimits = {},
): AgentRunRecord {
	const id = assertSafeOpaqueId(input.id, "runId");
	if (input.taskId) assertSafeOpaqueId(input.taskId, "taskId");
	if (input.executionId) assertSafeOpaqueId(input.executionId, "executionId");
	if (input.deadlineAt !== undefined) assertTimestamp(input.deadlineAt, "deadlineAt");
	return updateJsonStore(registryPath(fluxDir), createStore, isStore, store => {
		if (store.runs.some(run => run.id === id)) throw new Error(`Agent run already exists: ${id}`);
		if ((input.taskId || input.executionId) && store.recoveryFences?.some(fence =>
			(input.taskId !== undefined && fence.taskId === input.taskId)
			|| (input.executionId !== undefined && fence.executionId === input.executionId))) {
			throw new Error(`Agent run registration fenced during parent recovery: ${input.taskId ?? input.executionId}`);
		}
		// A recovery transaction may have terminalized the parent Task while this
		// registration was waiting on runs.json. Do not create a new child under an
		// immutable parent after that fence has been crossed.
		if (input.taskId) {
			const task = getTask(fluxDir, input.taskId);
			if (task && TASK_TERMINAL.has(task.status)) {
				throw new Error(`Agent run cannot attach to terminal Task ${input.taskId}: ${task.status}`);
			}
		}
		if (input.executionId) {
			const execution = getTaskExecution(fluxDir, input.executionId);
			if (execution && TASK_TERMINAL.has(execution.status)) {
				throw new Error(`Agent run cannot attach to terminal Execution ${input.executionId}: ${execution.status}`);
			}
		}
		if (limits.parentMaxParallel !== undefined) {
			if (!Number.isInteger(limits.parentMaxParallel) || limits.parentMaxParallel < 1) {
				throw new Error("parent maxParallel must be a positive integer");
			}
			if (input.taskId) {
				const active = store.runs.filter(run => run.taskId === input.taskId && ACTIVE.has(run.status)).length;
				if (active >= limits.parentMaxParallel) {
					throw new Error(`parent concurrency budget exhausted: ${active} active runs >= ${limits.parentMaxParallel}`);
				}
			}
		}
		const now = new Date().toISOString();
		const record: AgentRunRecord = {
			...input,
			id,
			status: "starting",
			attempt: 0,
			turns: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			contextTokens: 0,
			costUsd: 0,
			phase: "starting",
			health: "healthy",
			lastProgressAt: now,
			lastProgressType: "registered",
			lastProgressSummary: input.currentTask.slice(0, 300),
			healthWarningCount: 0,
			repeatActionCount: 0,
			lastActivityAt: now,
			lastActivityType: "registered",
			lastActivitySummary: input.currentTask.slice(0, 300),
			recentEvents: [{ at: now, type: "registered", phase: "starting", summary: input.currentTask.slice(0, 500) }],
			createdAt: now,
			updatedAt: now,
			heartbeatAt: now,
		};
		store.runs.push(record);
		if (input.taskId && hasParentBudget(limits.parentBudget)) {
			ensureReservations(store).push({ runId: id, taskId: input.taskId, costUsd: 0, turns: 0, input: 0, updatedAt: now });
		}
		return structuredClone(record);
	});
}

export function markAgentRunRunning(
	fluxDir: string,
	runId: string,
	pid: number,
	attempt: number,
	metadata: { model?: string | null; provider?: string | null } = {},
): AgentRunRecord {
	assertAttempt(attempt);
	if (!Number.isInteger(pid) || pid <= 0) throw new Error("Run Registry pid must be a positive integer");
	return updateRun(fluxDir, runId, (run, now) => {
		if (TERMINAL.has(run.status)) throw new Error(`Historical Agent run is immutable: ${runId} is ${run.status}`);
		ensureMutableRunDefaults(run);
		if (attempt < run.attempt) throw new Error(`Run Registry attempt cannot move backwards (${attempt} < ${run.attempt})`);
		run.status = "running";
		run.pid = pid;
		run.attempt = attempt;
		run.phase = "running";
		run.health = "healthy";
		run.healthReason = undefined;
		run.lastProgressAt = now;
		run.lastProgressType = "process_started";
		run.lastProgressSummary = `child process started (pid ${pid}, attempt ${attempt})`;
		run.lastActivityAt = now;
		run.lastActivityType = "process_started";
		run.lastActivitySummary = `child process started (pid ${pid}, attempt ${attempt})`;
		appendRecentRunEvent(run, { at: now, type: "process_started", phase: "running", summary: run.lastActivitySummary });
		if (metadata.model !== undefined) run.model = metadata.model === null ? undefined : metadata.model;
		if (metadata.provider !== undefined) run.provider = metadata.provider === null ? undefined : metadata.provider;
		run.heartbeatAt = now;
	});
}

/**
 * 在同一个 runs.json 更新锁内计算父 Task 聚合预算并写入在线快照。
 *
 * 先前 runner 的“写快照→再 listAgentRuns 检查”存在 check-then-act 窗口：
 * 两个并发 child 都可能先完成一次 provider 调用，再同时看到旧聚合值。
 * 这里把候选绝对快照和聚合检查放进同一事务；若候选值使父预算耗尽，
 * 仍保留真实 usage，并把当前 Run 标记为 stop_requested，交给 runner 终止，
 * 从而不丢失超限前最后一份事实，也不把它伪装成成功。
 */
export function updateAgentRunSnapshot(
	fluxDir: string,
	runId: string,
	snapshot: AgentRunSnapshot,
	parentBudget: AgentRunParentBudget = {},
): AgentRunRecord {
	return updateRun(fluxDir, runId, (run, now, store) => {
		if (!ACTIVE.has(run.status)) throw new Error(`Terminal Agent run cannot receive online updates: ${runId} is ${run.status}`);
		applyAbsoluteSnapshot(run, snapshot, now);
		const limits = [parentBudget.maxCostUsd, parentBudget.maxTurns, parentBudget.maxInputTokens];
		if (limits.every(value => value === undefined)) return;
		const invalidLimit = parentBudget.maxCostUsd !== undefined
			&& (!Number.isFinite(parentBudget.maxCostUsd) || parentBudget.maxCostUsd <= 0)
			? "parent maxCostUsd must be a finite positive number"
			: parentBudget.maxTurns !== undefined
				&& (!Number.isInteger(parentBudget.maxTurns) || parentBudget.maxTurns < 1)
				? "parent maxTurns must be a positive integer"
				: parentBudget.maxInputTokens !== undefined
					&& (!Number.isInteger(parentBudget.maxInputTokens) || parentBudget.maxInputTokens < 1)
					? "parent maxInputTokens must be a positive integer"
					: undefined;
		if (invalidLimit) {
			markRunParentBudgetExhausted(run, invalidLimit, now);
			return;
		}
		if (!run.taskId) return;
		const executionUsage = run.executionId ? getTaskExecution(fluxDir, run.executionId)?.usage : undefined;
		syncBudgetReservation(store, run, now);
		const totals = storeRunUsageForTask(run, store, executionUsage);
		const exceeded = parentBudget.maxCostUsd !== undefined && totals.cost >= parentBudget.maxCostUsd
			? `parent task budget exhausted: $${totals.cost.toFixed(6)} >= $${parentBudget.maxCostUsd.toFixed(6)}`
			: parentBudget.maxTurns !== undefined && totals.turns >= parentBudget.maxTurns
				? `parent task turn budget exhausted: ${totals.turns} >= ${parentBudget.maxTurns}`
				: parentBudget.maxInputTokens !== undefined && totals.input >= parentBudget.maxInputTokens
					? `parent task input budget exhausted: ${totals.input} >= ${parentBudget.maxInputTokens}`
					: undefined;
		if (exceeded) markRunParentBudgetExhausted(run, exceeded, now);
	});
}

function hasParentBudget(parentBudget: AgentRunParentBudget | undefined): boolean {
	return parentBudget !== undefined
		&& [parentBudget.maxCostUsd, parentBudget.maxTurns, parentBudget.maxInputTokens].some(value => value !== undefined);
}

function ensureReservations(store: AgentRunStore): AgentRunBudgetReservation[] {
	store.reservations ??= [];
	return store.reservations;
}

function syncBudgetReservation(store: AgentRunStore, run: AgentRunRecord, now: string): void {
	if (!run.taskId) return;
	const reservations = ensureReservations(store);
	const reservation = reservations.find(item => item.runId === run.id);
	if (reservation) {
		reservation.costUsd = Number.isFinite(run.costUsd) ? run.costUsd : 0;
		reservation.turns = Number.isFinite(run.turns) ? run.turns : 0;
		reservation.input = Number.isFinite(run.input) ? run.input : 0;
		reservation.updatedAt = now;
	}
}

function storeRunUsageForTask(
	current: AgentRunRecord,
	store: AgentRunStore,
	executionUsage?: { input: number; costUsd: number },
): { cost: number; turns: number; input: number } {
	const reservations = new Map(ensureReservations(store).filter(item => item.taskId === current.taskId).map(item => [item.runId, item]));
	const totals = store.runs
		.filter(run => run.taskId === current.taskId)
		.reduce((sum, run) => {
			const reservation = reservations.get(run.id);
			return {
				cost: sum.cost + (reservation ? reservation.costUsd : Number.isFinite(run.costUsd) ? run.costUsd : 0),
				turns: sum.turns + (reservation ? reservation.turns : Number.isFinite(run.turns) ? run.turns : 0),
				input: sum.input + (reservation ? reservation.input : Number.isFinite(run.input) ? run.input : 0),
			};
		}, { cost: executionUsage?.costUsd ?? 0, turns: 0, input: executionUsage?.input ?? 0 });
	return totals;
}

function markRunParentBudgetExhausted(run: AgentRunRecord, reason: string, now: string): void {
	if (TERMINAL.has(run.status)) return;
	run.status = "stop_requested";
	run.phase = "stopping";
	run.error = reason;
	run.lastActivityAt = now;
	run.lastActivityType = "parent_budget_exhausted";
	run.lastActivitySummary = reason;
	appendRecentRunEvent(run, { at: now, type: "parent_budget_exhausted", phase: "stopping", summary: reason });
	run.heartbeatAt = now;
}

/** 语义别名：调用方可按“在线进度”理解绝对快照 API。 */
export const updateAgentRunProgress = updateAgentRunSnapshot;

export interface AgentRunHealthUpdate {
	health: AgentRunHealth;
	reason?: string | null;
	lastProgressAt?: string;
	lastProgressType?: string;
	lastProgressSummary?: string;
	healthWarningAt?: string | null;
	healthWarningCount?: number;
	repeatActionSignature?: string | null;
	repeatActionCount?: number;
	repeatActionWindowStartedAt?: string | null;
}

/** 更新健康事实但不刷新 heartbeat；健康计算不能把“监控器仍在工作”冒充语义进展。 */
export function updateAgentRunHealth(fluxDir: string, runId: string, input: AgentRunHealthUpdate): AgentRunRecord {
	if (!isHealth(input.health)) throw new Error(`Run Registry health is invalid: ${input.health}`);
	assertOptionalText(input.reason, "healthReason");
	assertOptionalText(input.lastProgressType, "lastProgressType", 100);
	assertOptionalText(input.lastProgressSummary, "lastProgressSummary");
	if (input.lastProgressAt !== undefined) assertTimestamp(input.lastProgressAt, "lastProgressAt");
	if (input.healthWarningAt !== undefined && input.healthWarningAt !== null) assertTimestamp(input.healthWarningAt, "healthWarningAt");
	if (input.repeatActionWindowStartedAt !== undefined && input.repeatActionWindowStartedAt !== null) assertTimestamp(input.repeatActionWindowStartedAt, "repeatActionWindowStartedAt");
	if (input.healthWarningCount !== undefined) {
		assertNonNegativeFinite(input.healthWarningCount, "healthWarningCount");
		if (!Number.isInteger(input.healthWarningCount)) throw new Error("Run Registry healthWarningCount must be an integer");
	}
	if (input.repeatActionCount !== undefined) {
		assertNonNegativeFinite(input.repeatActionCount, "repeatActionCount");
		if (!Number.isInteger(input.repeatActionCount)) throw new Error("Run Registry repeatActionCount must be an integer");
	}
	return updateRun(fluxDir, runId, (run) => {
		if (!ACTIVE.has(run.status)) throw new Error(`Terminal Agent run cannot receive health updates: ${runId} is ${run.status}`);
		ensureMutableRunDefaults(run);
		const previousHealth = run.health;
		if (input.lastProgressAt !== undefined && Date.parse(input.lastProgressAt) < Date.parse(run.lastProgressAt)) {
			throw new Error("Run Registry lastProgressAt cannot move backwards");
		}
		run.health = input.health;
		run.healthReason = input.reason ?? undefined;
		if (input.lastProgressAt !== undefined) run.lastProgressAt = input.lastProgressAt;
		if (input.lastProgressType !== undefined) run.lastProgressType = input.lastProgressType ?? "";
		if (input.lastProgressSummary !== undefined) run.lastProgressSummary = input.lastProgressSummary ?? "";
		if (input.healthWarningAt !== undefined) run.healthWarningAt = input.healthWarningAt ?? undefined;
		if (input.healthWarningCount !== undefined) run.healthWarningCount = input.healthWarningCount;
		if (input.repeatActionSignature !== undefined) run.repeatActionSignature = input.repeatActionSignature ?? undefined;
		if (input.repeatActionCount !== undefined) run.repeatActionCount = input.repeatActionCount;
		if (input.repeatActionWindowStartedAt !== undefined) run.repeatActionWindowStartedAt = input.repeatActionWindowStartedAt ?? undefined;
		if (previousHealth !== input.health) appendRecentRunEvent(run, { at: new Date().toISOString(), type: "health", phase: run.phase, summary: input.reason ?? input.health });
	});
}

export function heartbeatAgentRun(fluxDir: string, runId: string): AgentRunRecord {
	return updateRun(fluxDir, runId, (run, now) => {
		if (!ACTIVE.has(run.status)) {
			throw new Error(`Agent run is not active: ${runId} is ${run.status}`);
		}
		ensureMutableRunDefaults(run);
		run.heartbeatAt = now;
	});
}

export function markAgentRunStopRequested(fluxDir: string, runId: string): AgentRunRecord {
	return updateRun(fluxDir, runId, (run, now) => {
		if (run.status === "stop_requested") return;
		if (run.status !== "starting" && run.status !== "running") {
			throw new Error(`Agent run cannot be stopped: ${runId} is ${run.status}`);
		}
		ensureMutableRunDefaults(run);
		run.status = "stop_requested";
		run.phase = "stopping";
		run.lastActivityAt = now;
		run.lastActivityType = "stop_requested";
		run.lastActivitySummary = "run stop requested";
		appendRecentRunEvent(run, { at: now, type: "stop_requested", phase: "stopping", summary: run.lastActivitySummary });
		run.heartbeatAt = now;
	});
}

export interface FinishAgentRunInput extends Partial<AgentRunSnapshot> {
	status: Extract<AgentRunStatus, "completed" | "failed" | "cancelled" | "timed_out">;
	error?: string;
}

export function finishAgentRun(
	fluxDir: string,
	runId: string,
	input: FinishAgentRunInput,
): AgentRunRecord {
	return updateRun(fluxDir, runId, (run, now, store) => {
		if (TERMINAL.has(run.status)) {
			throw new Error(`Historical Agent run is immutable: ${runId} is ${run.status}`);
		}
		ensureMutableRunDefaults(run);
		const snapshot: AgentRunSnapshot = {
			phase: input.phase ?? "terminal",
			turns: input.turns ?? run.turns,
			input: input.input ?? run.input,
			output: input.output ?? run.output,
			cacheRead: input.cacheRead ?? run.cacheRead,
			cacheWrite: input.cacheWrite ?? run.cacheWrite,
			contextTokens: input.contextTokens ?? run.contextTokens,
			costUsd: input.costUsd ?? run.costUsd,
			attempt: input.attempt ?? run.attempt,
			pid: input.pid,
			model: input.model,
			provider: input.provider,
			lastActivityAt: now,
			lastActivityType: "terminal",
			lastActivitySummary: input.error ? input.error.slice(0, 300) : `run ${input.status}`,
			modelError: input.modelError,
			providerError: input.providerError,
		};
		applyAbsoluteSnapshot(run, snapshot, now);
		syncBudgetReservation(store, run, now);
		run.status = input.status;
		run.phase = "terminal";
		run.error = input.error;
		run.finishedAt = now;
		run.heartbeatAt = now;
		run.pid = undefined;
	});
}

export function listAgentRuns(fluxDir: string, filter: { taskId?: string; agent?: string; activeOnly?: boolean } = {}): AgentRunRecord[] {
	return readJsonStore(registryPath(fluxDir), createStore, isStore).runs
		.map(normalizeRunRecord)
		.filter(run => !filter.taskId || run.taskId === filter.taskId)
		.filter(run => !filter.agent || run.agent === filter.agent)
		.filter(run => !filter.activeOnly || ACTIVE.has(run.status))
		.slice()
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getAgentRun(fluxDir: string, runId: string): AgentRunRecord | undefined {
	assertSafeOpaqueId(runId, "runId");
	const run = readJsonStore(registryPath(fluxDir), createStore, isStore).runs.find(item => item.id === runId);
	return run ? normalizeRunRecord(run) : undefined;
}

/**
 * 将因 dead-PID 恢复而失败的 Run 关联到同一 Task/Execution 的终态。
 * 只处理明确带 heartbeat_expired 证据的 Run，并且不改写任何已经终态的
 * Task/Execution；这样重启恢复不会按 Agent 名称误伤另一个仍存活的 Main。
 */
function claimRecoveryFence(fluxDir: string, run: AgentRunRecord, taskId: string, executionId: string): boolean {
	return updateJsonStore(registryPath(fluxDir), createStore, isStore, store => {
		const fences = store.recoveryFences ?? [];
		if (fences.some(fence => fence.taskId === taskId && fence.executionId === executionId)) return true;
		const liveSibling = store.runs.some(candidate => candidate.id !== run.id
			&& ACTIVE.has(candidate.status)
			&& (candidate.taskId === taskId || candidate.executionId === executionId));
		if (liveSibling) return false;
		// Repeat the owner check while the Run Registry lock is held.  The caller
		// also checks before/after this transaction, but this prevents a newly
		// observed live owner from acquiring a fresh parent-convergence fence.
		if (isLiveRecoveryOwner(fluxDir, taskId, executionId)) return false;
		if (fences.length >= MAX_RECOVERY_FENCES) {
			throw new Error(`Run Registry recovery fence capacity exhausted (${MAX_RECOVERY_FENCES}); existing fences must converge before another recovery can be claimed`);
		}
		// Never truncate unresolved fences.  A missing fence would remove the
		// registration barrier while the corresponding Task-store convergence may
		// still be in flight.  Capacity exhaustion is intentionally fail-closed.
		store.recoveryFences = [...fences, {
			taskId,
			executionId,
			runId: run.id,
			createdAt: new Date().toISOString(),
		}];
		return true;
	});
}

/**
 * Release either the whole parent fence (after both parent records are
 * terminal) or only the fence owned by a particular recovered Run when a
 * deferral is discovered.  The latter prevents one recovery attempt from
 * clearing another attempt's in-flight barrier.
 */
function releaseRecoveryFence(fluxDir: string, taskId: string, executionId: string, runId?: string): void {
	updateJsonStore(registryPath(fluxDir), createStore, isStore, store => {
		store.recoveryFences = (store.recoveryFences ?? [])
			.filter(fence => fence.taskId !== taskId || fence.executionId !== executionId || (runId !== undefined && fence.runId !== runId));
	});
}

/**
 * Re-read parent ownership immediately before a recovery fence is claimed (and
 * again after the claim).  A live persisted owner or exact active-context
 * owner means the child is replaceable work, not an orphaned parent.
 * Missing/corrupt ownership state is treated as live/unknown and therefore
 * defers recovery rather than widening terminalization authority.
 */
function isLiveRecoveryOwner(fluxDir: string, taskId: string, executionId: string): boolean {
	let execution;
	try {
		execution = getTaskExecution(fluxDir, executionId);
	} catch {
		return true;
	}
	if (!execution || execution.taskId !== taskId) return true;
	if (typeof execution.ownerPid === "number" && isProcessAlive(execution.ownerPid)) return true;
	try {
		return readActiveContext(dirname(fluxDir)).entries.some(entry =>
			(entry.scope === executionId || entry.scope === taskId) && isProcessAlive(entry.pid));
	} catch {
		return true;
	}
}

function reconcileRecoveredTask(fluxDir: string, run: AgentRunRecord): void {
	if (!run.taskId || run.error !== HEARTBEAT_RECOVERY_ERROR
		|| !run.recentEvents?.some(event => event.type === "heartbeat_expired")) return;
	const task = getTask(fluxDir, run.taskId);
	if (!task) return;
	const executionId = run.executionId ?? task.executionId;
	const execution = getTaskExecution(fluxDir, executionId);
	if (!execution || execution.taskId !== task.id) return;
	if (TASK_TERMINAL.has(task.status) || TASK_TERMINAL.has(execution.status)) {
		// A terminal parent is a proof that no replacement may attach, so a fence
		// left by a prior failed cleanup can be safely removed.  If the two parent
		// records disagree, preserve the fence and fail closed.
		if (TASK_TERMINAL.has(task.status) && TASK_TERMINAL.has(execution.status)) {
			releaseRecoveryFence(fluxDir, task.id, execution.id);
		}
		return;
	}

	// Dead child != dead parent. A Workflow/Main can legitimately still own the
	// same Task/Execution while one child is being replaced or another sibling is
	// running. Terminalizing the parent here would make that live execution
	// immutable and later child registration would either leak work or fail late.
	const liveSibling = listAgentRuns(fluxDir)
		.find(candidate => candidate.id !== run.id && ACTIVE.has(candidate.status)
			&& (candidate.taskId === task.id || candidate.executionId === execution.id));
	if (liveSibling) {
		// This also heals a fence left by an older recovery implementation, but
		// never clears a different Run's in-flight fence.
		releaseRecoveryFence(fluxDir, task.id, execution.id, run.id);
		return;
	}

	// Main/Workflow ownership is persisted on the execution when the host starts
	// a plan. Check it before claiming the fence: a live owner means this child is
	// replaceable work, not an orphaned parent.  Re-checking after claim closes
	// the small cross-store race where the owner starts during the first check.
	if (isLiveRecoveryOwner(fluxDir, task.id, execution.id)) {
		releaseRecoveryFence(fluxDir, task.id, execution.id, run.id);
		return;
	}
	if (!claimRecoveryFence(fluxDir, run, task.id, execution.id)) {
		// A false claim can mean a sibling won the race or the owner became live
		// during the locked check.  Only the latter owns a deferral cleanup.
		if (isLiveRecoveryOwner(fluxDir, task.id, execution.id)) {
			releaseRecoveryFence(fluxDir, task.id, execution.id, run.id);
		}
		return;
	}
	if (isLiveRecoveryOwner(fluxDir, task.id, execution.id)) {
		releaseRecoveryFence(fluxDir, task.id, execution.id, run.id);
		return;
	}

	const priorUsage = execution.usage;
	let taskStoreConverged = false;
	try {
		updateTaskStatus(fluxDir, task.id, "failed", {
			executionId,
			costUsd: Math.max(Number.isFinite(execution.costUsd) ? execution.costUsd : 0, run.costUsd),
			usage: {
				input: Math.max(priorUsage?.input ?? 0, run.input),
				output: Math.max(priorUsage?.output ?? 0, run.output),
				cacheRead: Math.max(priorUsage?.cacheRead ?? 0, run.cacheRead),
				cacheWrite: Math.max(priorUsage?.cacheWrite ?? 0, run.cacheWrite),
				costUsd: Math.max(priorUsage?.costUsd ?? 0, run.costUsd),
				model: run.model ?? priorUsage?.model,
			},
			outcome: { status: "failure", error: HEARTBEAT_RECOVERY_ERROR },
		});
		taskStoreConverged = true;
	} finally {
		// Keep the fence only while task-store convergence is outstanding. A
		// failed update intentionally leaves it durable for the next startup.
		if (taskStoreConverged) {
			try { releaseRecoveryFence(fluxDir, task.id, execution.id); } catch {}
		}
	}
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
	const recoveredCandidates: AgentRunRecord[] = [];
	const reconciled = updateJsonStore(registryPath(fluxDir), createStore, isStore, store => {
		const newlyReconciled: AgentRunRecord[] = [];
		for (const rawRun of store.runs) {
			const run = rawRun;
			ensureMutableRunDefaults(run);
			// A previous startup may have converged the Run but lost the separate
			// Task-store write. Retry only this explicit recovery evidence on every
			// later startup; ordinary historical failures are never touched.
			if (TERMINAL.has(run.status)) {
				if (run.error === HEARTBEAT_RECOVERY_ERROR && run.recentEvents?.some(event => event.type === "heartbeat_expired")) {
					recoveredCandidates.push(structuredClone(normalizeRunRecord(run)));
				}
				continue;
			}
			const heartbeatMs = Date.parse(run.heartbeatAt);
			if (Number.isFinite(heartbeatMs) && nowMs - heartbeatMs <= staleAfterMs) continue;
			// 心跳超时但进程仍存活：可能是长操作或心跳写失败，不能误标为残留。
			if (typeof run.pid === "number" && isProcessAlive(run.pid)) continue;
			const timestamp = nowDate.toISOString();
			run.status = "failed";
			run.phase = "terminal";
			run.error = HEARTBEAT_RECOVERY_ERROR;
			run.lastActivityAt = timestamp;
			run.lastActivityType = "heartbeat_expired";
			run.lastActivitySummary = run.error;
			appendRecentRunEvent(run, { at: timestamp, type: "heartbeat_expired", phase: "terminal", summary: run.error });
			run.updatedAt = timestamp;
			run.heartbeatAt = timestamp;
			run.finishedAt = timestamp;
			run.pid = undefined;
			const recovered = structuredClone(normalizeRunRecord(run));
			newlyReconciled.push(recovered);
			recoveredCandidates.push(recovered);
		}
		return newlyReconciled;
	});
	// Do not hold runs.json's lock while updating tasks.json.  The candidate list
	// is durable and is retried on the next startup if this independent store is
	// temporarily unavailable.
	for (const run of recoveredCandidates) {
		try { reconcileRecoveredTask(fluxDir, run); }
		catch (error) {
			// Surface the failure to session_start/GC while retaining the failed Run;
			// a later recovery pass can safely retry the exact same task/execution.
			throw new Error(`orphan Task recovery failed for Run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return reconciled;
}

/** 仅供 UI/测试读取，避免把 terminal 判定逻辑复制到调用方。 */
export function isTerminalAgentRun(status: AgentRunStatus): boolean {
	return TERMINAL.has(status);
}
