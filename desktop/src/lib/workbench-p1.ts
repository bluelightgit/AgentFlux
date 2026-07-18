import type { AgentSession } from './agent-runtime';
import type { AnyEvent, SubagentRunEvent } from './events-parser';

export type ExecutionRunStatus = 'success' | 'failed' | 'cancelled' | 'timeout';

export interface ExecutionRunDetail {
  agent: string;
  model: string;
  status: ExecutionRunStatus;
  costUsd: number;
  runId?: string;
  startedAt: number;
  finishedAt: number;
  isDagRole: boolean;
  dagLabel?: string;
}

export interface ExecutionFamilyAggregate {
  totalRuns: number;
  success: number;
  running: 0;
  failed: number;
  cancelled: number;
  timeout: number;
  totalCostUsd: number;
  lastActivity: number;
  details: ExecutionRunDetail[];
}

function runStatus(event: SubagentRunEvent): ExecutionRunStatus {
  const status = event.outcome?.status;
  if (status === 'success') return 'success';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'timeout') return 'timeout';
  if (status === 'failure' || status === 'partial' || status === 'unknown') return 'failed';
  return event.exitCode === 0 ? 'success' : 'failed';
}

/** Aggregate only telemetry explicitly linked to the requested task. */
export function aggregateExecutionFamily(events: AnyEvent[], taskId?: string): ExecutionFamilyAggregate {
  if (taskId === undefined || taskId === '') {
    return { totalRuns: 0, success: 0, running: 0, failed: 0, cancelled: 0, timeout: 0, totalCostUsd: 0, lastActivity: 0, details: [] };
  }
  const runs = events.filter(
    (event): event is SubagentRunEvent => event.type === 'subagent.run' && event.taskId === taskId,
  );
  const details = runs.map((event) => ({
    agent: event.agent || 'unknown',
    model: event.model || 'unknown',
    status: runStatus(event),
    costUsd: Number.isFinite(event.costUsd) ? event.costUsd : 0,
    runId: event.runId,
    startedAt: event.startedAt ?? event.ts,
    finishedAt: event.finishedAt ?? event.ts,
    isDagRole: typeof event.agent === 'string' && event.agent.startsWith('dag-'),
    dagLabel: (event as any).dagLabel,
  })).sort((a, b) => b.finishedAt - a.finishedAt);

  return {
    totalRuns: details.length,
    success: details.filter((detail) => detail.status === 'success').length,
    running: 0,
    failed: details.filter((detail) => detail.status === 'failed').length,
    cancelled: details.filter((detail) => detail.status === 'cancelled').length,
    timeout: details.filter((detail) => detail.status === 'timeout').length,
    totalCostUsd: details.reduce((total, detail) => total + detail.costUsd, 0),
    lastActivity: details[0]?.finishedAt ?? 0,
    details,
  };
}

export function clampColumns(value: { left: number; right: number }, containerWidth = Number.POSITIVE_INFINITY): { left: number; right: number } {
  let left = Math.min(420, Math.max(190, value.left));
  let right = Math.min(480, Math.max(260, value.right));
  const budget = containerWidth - 414;
  if (Number.isFinite(budget) && left + right > budget) {
    const excess = left + right - budget;
    const rightReduction = Math.min(excess, right - 260);
    right -= rightReduction;
    left = Math.max(190, left - (excess - rightReduction));
  }
  return { left, right };
}

export function redactDiagnosticsText(value: string): string {
  return value
    .replace(/\b(authorization|cookie)\s*:\s*[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|api[_-]?key|password|secret|session|credential|private[_ -]?key|access[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

export function buildRuntimeDiagnostics(runtime: AgentSession): string {
  return JSON.stringify({
    runId: runtime.runId, taskId: runtime.taskId, executionId: runtime.executionId,
    retryOfRunId: runtime.retryOfRunId, retryAttempt: runtime.retryAttempt,
    status: runtime.status, exitCode: runtime.exitCode, exitSignal: runtime.exitSignal,
    errorCode: runtime.errorCode, cliSource: runtime.cliSource, cliPath: runtime.cliPath,
    runtimeSource: runtime.runtimeSource, runtimeExecutable: runtime.runtimeExecutable,
    runtimeVersion: runtime.runtimeVersion, stderrSummary: redactDiagnosticsText(runtime.stderrSummary),
  }, null, 2);
}
