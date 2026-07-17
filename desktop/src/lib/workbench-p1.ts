import type { AgentSession } from './agent-runtime';

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
