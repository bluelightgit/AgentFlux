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

export interface BaseEvent {
	ts: number;
	sessionId: string;
	type: string;
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
}

export interface CacheSampleEvent extends BaseEvent {
	type: "cache.sample";
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
	action: "mask_applied" | "compact_triggered" | "fork" | "handoff" | "prefix_layout_rewrite";
	detail?: string;
	contextPercentBefore: number | null;
	contextPercentAfter: number | null;
}

export type FluxEvent = RoutingDecisionEvent | CacheSampleEvent | ContextEvent;

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
		this.write({ ts: Date.now(), type: "routing.decision", ...ev } as RoutingDecisionEvent);
	}

	writeCacheSample(ev: Omit<CacheSampleEvent, "ts" | "type">): void {
		this.write({ ts: Date.now(), type: "cache.sample", ...ev } as CacheSampleEvent);
	}

	writeContextEvent(ev: Omit<ContextEvent, "ts" | "type">): void {
		this.write({ ts: Date.now(), type: "context.event", ...ev } as ContextEvent);
	}

	get path(): string { return this.filePath; }
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
	};
}
