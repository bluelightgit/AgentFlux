import { randomUUID } from "node:crypto";
import type { AgentLineage, AgentRecord } from "../core/types";
import type { TelemetryWriter } from "../telemetry/events";

export function createEphemeralRecord(input: { name: string; role: string; lineage?: AgentLineage; sessionId: string; taskId?: string; runId?: string; currentTask?: string; model?: string; telemetry?: TelemetryWriter }): AgentRecord {
	const now = new Date().toISOString();
	const record: AgentRecord = { id: `agent-${randomUUID()}`, name: input.name, kind: "ephemeral", role: input.role, status: "idle", lineage: input.lineage ?? { origin: "fresh" }, createdAt: now, updatedAt: now, callCount: 0, totalCostUsd: 0, capabilityGeneration: 1 };
	input.telemetry?.writeAgentLifecycle({ sessionId: input.sessionId, taskId: input.taskId, runId: input.runId, agentId: record.id, agent: record.name, kind: record.kind, origin: record.lineage.origin, status: record.status, action: record.lineage.origin === "fork" ? "forked" : "created", parentAgentId: record.lineage.parentAgentId, forkPoint: record.lineage.forkPoint, role: input.role, currentTask: input.currentTask, model: input.model });
	return record;
}

export function startEphemeralRecord(record: AgentRecord, input: { sessionId: string; taskId?: string; runId?: string; currentTask: string; model?: string; telemetry?: TelemetryWriter }): AgentRecord {
	record.status = "running";
	record.lastTask = input.currentTask;
	record.updatedAt = new Date().toISOString();
	input.telemetry?.writeAgentLifecycle({ sessionId: input.sessionId, taskId: input.taskId, runId: input.runId, agentId: record.id, agent: record.name, kind: "ephemeral", origin: record.lineage.origin, status: "running", action: "started", parentAgentId: record.lineage.parentAgentId, forkPoint: record.lineage.forkPoint, role: record.role, currentTask: input.currentTask.slice(0, 200), model: input.model });
	return record;
}

export function finishEphemeralRecord(record: AgentRecord, exitCode: number, costUsd: number, telemetry: TelemetryWriter | undefined, sessionId: string, taskId?: string, runId?: string): AgentRecord {
	record.status = exitCode === 0 ? "done" : exitCode === 130 ? "cancelled" : "failed"; record.callCount = 1; record.totalCostUsd = costUsd; record.updatedAt = new Date().toISOString();
	telemetry?.writeAgentLifecycle({ sessionId, taskId, runId, agentId: record.id, agent: record.name, kind: "ephemeral", origin: record.lineage.origin, status: record.status, action: record.status === "done" ? "completed" : record.status === "cancelled" ? "cancelled" : "failed", parentAgentId: record.lineage.parentAgentId, forkPoint: record.lineage.forkPoint, role: record.role, currentTask: record.lastTask });
	return record;
}
