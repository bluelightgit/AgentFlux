import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind, AgentOrigin, AgentStatus } from "../core/types";
import type { TaskOperation } from "../core/task-execution";

export type TelemetryOutcomeStatus = "success" | "failure" | "partial" | "cancelled" | "timeout" | "unknown";
export interface TelemetryOutcome { status: TelemetryOutcomeStatus; success?: boolean; exitCode?: number; gatePassed?: boolean; retryCount?: number; error?: string; }
export interface TelemetryEvidence { type: "test" | "build" | "lint" | "typecheck" | "review" | "quality_gate" | "user" | "artifact" | "other"; name?: string; passed?: boolean; value?: string | number | boolean; detail?: string; source?: string; path?: string; }
/** Main 会话逐轮 usage 累计（turn_end 从 pi message_end 事件读取） */
export interface MainUsage { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; model?: string; }
export interface BaseEvent { ts: number; sessionId: string; type: string; taskId?: string; runId?: string; startedAt?: number; finishedAt?: number; latencyMs?: number; costUsd?: number; outcome?: TelemetryOutcome; evidence?: TelemetryEvidence[]; }

export interface TaskExecutionEvent extends BaseEvent {
	type: "task.execution";
	action: "created" | "started" | "completed" | "failed" | "cancelled";
	selectedBy: "user" | "main_agent";
	task: string;
	operation?: TaskOperation;
	parentTaskId?: string;
	executionId?: string;
	parentExecutionId?: string;
	deadlineAt?: string;
	/** Main 会话侧逐轮累计 usage（子 Agent usage 记录在 SubagentRunEvent/checkpoint） */
	usage?: MainUsage;
}

export interface AgentLifecycleEvent extends BaseEvent {
	type: "agent.lifecycle";
	action: "created" | "started" | "completed" | "failed" | "cancelled" | "archived" | "forked";
	agentId: string;
	agent: string;
	kind: AgentKind;
	origin: AgentOrigin;
	status: AgentStatus;
	parentAgentId?: string;
	forkPoint?: string;
	role?: string;
	currentTask?: string;
	model?: string;
}

export interface ContextEvent extends BaseEvent { type: "context.event"; turnIndex: number; action: "mask_applied" | "compact_triggered" | "compaction_advice" | "fork" | "fork_created" | "tree_navigate" | "handoff" | "prefix_layout_rewrite"; detail?: string; contextPercentBefore: number | null; contextPercentAfter: number | null; }
export interface SubagentRunEvent extends BaseEvent { type: "subagent.run"; agent: string; task: string; model: string | null; turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; contextTokens: number; cacheHitRate: number; prefixLayout: boolean; exitCode: number; timedOut?: boolean; persistent?: boolean; thinking?: string; retryCount?: number; communication?: { passed: boolean; missingSendTo: string[]; unacknowledgedInbox: string[]; }; }
export interface MessageProtocolEvent extends BaseEvent { type: "message.protocol"; action: "send" | "poll" | "ack" | "status"; agent: string; instanceId: string; messageId?: string; target?: string; result: "success" | "denied" | "failure"; detail?: string; content?: string; deliveryStatus?: "pending" | "delivered" | "acknowledged" | "rejected" | "expired"; priority?: "low" | "normal" | "high" | "critical"; }
export interface CapabilityPolicyEvent extends BaseEvent { type: "capability.policy"; action: "resolve" | "set" | "reject"; agent: string; role: string; instanceId?: string; revision?: number; result: "success" | "denied" | "failure"; narrowed?: string[]; cacheImpact?: string[]; detail?: string; }
export type FluxEvent = TaskExecutionEvent | AgentLifecycleEvent | ContextEvent | SubagentRunEvent | MessageProtocolEvent | CapabilityPolicyEvent;

export class TelemetryWriter {
	private readonly filePath: string;
	constructor(fluxDir: string, private readonly enabled = true) { mkdirSync(fluxDir, { recursive: true }); this.filePath = join(fluxDir, "events.jsonl"); }
	write(ev: FluxEvent): void { if (!this.enabled) return; try { appendFileSync(this.filePath, JSON.stringify(ev) + "\n"); } catch {} }
	writeTaskExecution(ev: Omit<TaskExecutionEvent, "ts" | "type">): void { this.write({ ts: Date.now(), type: "task.execution", ...ev }); }
	writeAgentLifecycle(ev: Omit<AgentLifecycleEvent, "ts" | "type">): void { this.write({ ts: Date.now(), type: "agent.lifecycle", ...ev }); }
	writeContextEvent(ev: Omit<ContextEvent, "ts" | "type">): void { this.write({ ts: Date.now(), type: "context.event", ...ev }); }
	writeSubagentRun(ev: Omit<SubagentRunEvent, "ts" | "type">): void {
		const ts = Date.now(); const finishedAt = ev.finishedAt ?? ts; const runId = ev.runId ?? `run-${ts}-${Math.random().toString(36).slice(2, 8)}`;
		this.write({ ts, type: "subagent.run", ...ev, runId, finishedAt, latencyMs: ev.startedAt === undefined ? ev.latencyMs : Math.max(0, finishedAt - ev.startedAt), outcome: ev.outcome ?? { status: ev.exitCode === 0 ? "success" : ev.exitCode === 130 ? "cancelled" : ev.timedOut === true ? "timeout" : "failure", success: ev.exitCode === 0, exitCode: ev.exitCode, retryCount: ev.retryCount } });
	}
	writeMessageProtocol(ev: Omit<MessageProtocolEvent, "ts" | "type">): void { this.write({ ts: Date.now(), type: "message.protocol", ...ev }); }
	writeCapabilityPolicy(ev: Omit<CapabilityPolicyEvent, "ts" | "type">): void { this.write({ ts: Date.now(), type: "capability.policy", ...ev }); }
	get path(): string { return this.filePath; }
}
