/**
 * AgentFlux Telemetry — 统一事件模型 + JSONL writer
 * 文档依据: docs/11-system-architecture.md (Telemetry Store)
 *
 * 统一事件 schema: TUI 是第一观察者, Web 是第二观察者, Electron 是 Web shell, 都消费同一数据。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RoutingDecision, CacheStats, Mode, ProjectStage, ProjectRole, Preset } from "../core/types";

// ---------- 事件类型 ----------

export type TelemetryOutcomeStatus = "success" | "failure" | "partial" | "cancelled" | "timeout" | "unknown";

/**
 * 任务/运行结果的统一表示。
 *
 * `success` 保留布尔形式，便于旧代码与经验库消费；`status` 则能表达
 * partial/cancelled/timeout/unknown，避免把“没有结果”误认为成功。
 */
export interface TelemetryOutcome {
	status: TelemetryOutcomeStatus;
	success?: boolean;
	exitCode?: number;
	gatePassed?: boolean;
	retryCount?: number;
	error?: string;
}

/** 可验证结果证据，字段保持宽松以容纳 test/build/review/user 等来源。 */
export interface TelemetryEvidence {
	type: "test" | "build" | "lint" | "typecheck" | "review" | "quality_gate" | "user" | "artifact" | "other";
	name?: string;
	passed?: boolean;
	value?: string | number | boolean;
	detail?: string;
	source?: string;
	path?: string;
}

export interface BaseEvent {
	ts: number;
	sessionId: string;
	type: string;
	/** 跨事件因果标识；对旧事件均可缺省。 */
	taskId?: string;
	runId?: string;
	decisionId?: string;
	stepId?: string;
	attemptId?: string;
	/** epoch milliseconds。旧 schema 可仅有 `ts`。 */
	startedAt?: number;
	finishedAt?: number;
	latencyMs?: number;
	/** USD；子类事件可将它收紧为必填字段。 */
	costUsd?: number;
	outcome?: TelemetryOutcome;
	evidence?: TelemetryEvidence[];
}

export interface RoutingDecisionEvent extends BaseEvent {
	type: "routing.decision";
	mode: Mode;
	preset: Preset;
	stage: ProjectStage;
	role: ProjectRole;
	reason: string[];
	confidence: number;
	fallback: Mode;
	biasSources: RoutingDecision["biasSources"];
	expected: RoutingDecision["expected"];
	/** 任务签名字段，供 ExperienceStore 建立可用的反馈样本。 */
	taskType?: string;
	complexityTier?: number;
	fileCount?: number;
	diffLines?: number;
	actualMode?: Mode;
	overrideMode?: "auto" | "manual" | "suggest";
	applied?: boolean;
}

export interface CacheSampleEvent extends BaseEvent {
	type: "cache.sample";
	/** v=2: 增量值 (per-turn delta); v=1 或缺省: 累计值 (旧格式) */
	v?: number;
	turnIndex: number;
	model: string | null;
	mode: Mode;
	stage: ProjectStage;
	role: ProjectRole;
	preset: Preset;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	contextTokens: number;
	contextWindow: number;
	contextPercent: number | null;
	cacheHitRate: number;
}

export interface ContextEvent extends BaseEvent {
	type: "context.event";
	turnIndex: number;
	action: "mask_applied" | "compact_triggered" | "compaction_advice" | "fork" | "fork_created" | "tree_navigate" | "handoff" | "prefix_layout_rewrite";
	detail?: string;
	contextPercentBefore: number | null;
	contextPercentAfter: number | null;
}

export interface SubagentRunEvent extends BaseEvent {
	type: "subagent.run";
	agent: string;
	task: string;
	model: string | null;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	contextTokens: number;
	cacheHitRate: number;
	prefixLayout: boolean;
	exitCode: number;
	persistent?: boolean;   // M2-2: 是否使用持久 session
	thinking?: string;     // M2-4: reasoning effort 级别
	retryCount?: number;   // 自动重试次数 (0=首次成功)
	communication?: {
		passed: boolean;
		missingSendTo: string[];
		unacknowledgedInbox: string[];
	};
}

export interface MessageProtocolEvent extends BaseEvent {
	type: "message.protocol";
	action: "send" | "poll" | "ack" | "status";
	agent: string;
	instanceId: string;
	messageId?: string;
	target?: string;
	result: "success" | "denied" | "failure";
	detail?: string;
}

export interface CapabilityPolicyEvent extends BaseEvent {
	type: "capability.policy";
	action: "resolve" | "set" | "reject";
	agent: string;
	role: string;
	instanceId?: string;
	revision?: number;
	result: "success" | "denied" | "failure";
	narrowed?: string[];
	cacheImpact?: string[];
	detail?: string;
}

export type FluxEvent = RoutingDecisionEvent | CacheSampleEvent | ContextEvent | SubagentRunEvent | MessageProtocolEvent | CapabilityPolicyEvent;

// ---------- JSONL Writer ----------

export class TelemetryWriter {
	private filePath: string;
	private enabled: boolean;

	constructor(fluxDir: string, enabled = true) {
		try { mkdirSync(fluxDir, { recursive: true }); } catch { /* exists */ }
		this.filePath = join(fluxDir, "events.jsonl");
		this.enabled = enabled;
	}

	write(ev: FluxEvent): void {
		if (!this.enabled) return;
		try { appendFileSync(this.filePath, JSON.stringify(ev) + "\n"); } catch { /* best effort */ }
	}

	writeRoutingDecision(ev: Omit<RoutingDecisionEvent, "ts" | "type">): void {
		const ts = Date.now();
		this.write({
			ts,
			type: "routing.decision",
			...ev,
			decisionId: ev.decisionId ?? makeEventId("decision", [ev.sessionId], ts),
		} as RoutingDecisionEvent);
	}

	writeCacheSample(ev: Omit<CacheSampleEvent, "ts" | "type">): void {
		this.write({ ts: Date.now(), type: "cache.sample", ...ev } as CacheSampleEvent);
	}

	writeContextEvent(ev: Omit<ContextEvent, "ts" | "type">): void {
		this.write({ ts: Date.now(), type: "context.event", ...ev } as ContextEvent);
	}

	writeSubagentRun(ev: Omit<SubagentRunEvent, "ts" | "type">): void {
		const ts = Date.now();
		const finishedAt = ev.finishedAt ?? ts;
		const latencyMs = ev.latencyMs ?? (
			ev.startedAt !== undefined ? Math.max(0, finishedAt - ev.startedAt) : undefined
		);
		const startedAt = ev.startedAt ?? (
			latencyMs !== undefined ? Math.max(0, finishedAt - latencyMs) : undefined
		);
		const runId = ev.runId ?? makeEventId("run", [ev.sessionId, ev.agent], ts);
		const attemptId = ev.attemptId ?? `${runId}-attempt-${ev.retryCount ?? 0}`;
		const outcome = ev.outcome ?? {
			status: ev.exitCode === 0 ? "success" : "failure",
			success: ev.exitCode === 0,
			exitCode: ev.exitCode,
			retryCount: ev.retryCount,
		} satisfies TelemetryOutcome;

		this.write({
			ts,
			type: "subagent.run",
			...ev,
			runId,
			attemptId,
			startedAt,
			finishedAt,
			latencyMs,
			outcome,
		} as SubagentRunEvent);
	}

	writeMessageProtocol(ev: Omit<MessageProtocolEvent, "ts" | "type">): void {
		this.write({ ts: Date.now(), type: "message.protocol", ...ev } as MessageProtocolEvent);
	}

	writeCapabilityPolicy(ev: Omit<CapabilityPolicyEvent, "ts" | "type">): void {
		this.write({ ts: Date.now(), type: "capability.policy", ...ev } as CapabilityPolicyEvent);
	}

	get path(): string { return this.filePath; }
}

function sanitizeIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function makeEventId(prefix: string, parts: string[], ts: number): string {
	const suffix = Math.random().toString(36).slice(2, 8);
	return [prefix, ...parts.map(sanitizeIdPart), ts, suffix].join("-");
}

/** 从 CacheStats 构造 cache.sample 事件 payload (去 ts/type) */
export function cacheStatsToSample(
	stats: CacheStats,
	meta: { turnIndex: number; model: string | null; mode: Mode; stage: ProjectStage; role: ProjectRole; preset: Preset; sessionId: string },
): Omit<CacheSampleEvent, "ts" | "type"> {
	return {
		sessionId: meta.sessionId, turnIndex: meta.turnIndex, model: meta.model,
		mode: meta.mode, stage: meta.stage, role: meta.role, preset: meta.preset,
		input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite,
		costUsd: stats.costUsd, contextTokens: stats.contextTokens, contextWindow: stats.contextWindow,
		contextPercent: stats.contextPercent, cacheHitRate: stats.cacheHitRate,
		v: 2, // 标记为增量格式
	};
}
