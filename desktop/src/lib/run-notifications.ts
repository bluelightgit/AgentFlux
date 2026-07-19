import type { SubagentRunEvent } from './events-parser';

export interface RunNotificationBatch {
  kind: 'success' | 'error';
  title: string;
  detail: string;
  key: string;
  count: number;
}

export interface RunNotificationCursor {
  initialized: boolean;
  count: number;
}

export function advanceRunNotificationCursor(
  runs: SubagentRunEvent[],
  cursor: RunNotificationCursor,
): { cursor: RunNotificationCursor; freshRuns: SubagentRunEvent[] } {
  if (!cursor.initialized || runs.length < cursor.count) {
    return { cursor: { initialized: true, count: runs.length }, freshRuns: [] };
  }
  return {
    cursor: { initialized: true, count: runs.length },
    freshRuns: runs.slice(cursor.count),
  };
}

export function groupRunNotifications(runs: SubagentRunEvent[]): RunNotificationBatch[] {
  const groups = new Map<string, RunNotificationBatch>();
  for (const run of runs) {
    const errorMessage = (run as unknown as { errorMessage?: string }).errorMessage;
    const failed = run.exitCode !== 0 || Boolean(errorMessage);
    const detail = failed ? (errorMessage || `exit code ${run.exitCode}`) : `Completed in ${run.turns} turns ($${run.costUsd.toFixed(4)})`;
    const key = failed ? `subagent-failed:${run.agent}:${run.exitCode}:${errorMessage ?? ''}` : `subagent-completed:${run.agent}:${run.ts}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { kind: failed ? 'error' : 'success', title: `${run.agent} ${failed ? 'failed' : 'completed'}`, detail, key, count: 1 });
  }
  return [...groups.values()];
}
