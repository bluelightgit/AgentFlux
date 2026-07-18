import { describe, expect, it } from 'vitest';
import type { SubagentRunEvent } from '../../src/lib/events-parser';
import { aggregateExecutionFamily, buildRuntimeDiagnostics, clampColumns, redactDiagnosticsText } from '../../src/lib/workbench-p1';

function run(overrides: Partial<SubagentRunEvent> = {}): SubagentRunEvent {
  return {
    ts: 100, type: 'subagent.run', sessionId: 'session', taskId: 'task-a', agent: 'implementer', task: 'work', model: 'deepseek-v4-pro',
    turns: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.002, contextTokens: 15, cacheHitRate: 0,
    exitCode: 0, startedAt: 90, finishedAt: 100, outcome: { status: 'success', success: true, exitCode: 0 },
    ...overrides,
  };
}

describe('Control Room P1 helpers', () => {
  it('clamps panel widths and always reserves the 400px center lane', () => {
    expect(clampColumns({ left: 999, right: 999 }, 980)).toEqual({ left: 306, right: 260 });
    const value = clampColumns({ left: -1, right: -1 }, 980);
    expect(value).toEqual({ left: 190, right: 260 });
    expect(value.left + value.right + 414).toBeLessThanOrEqual(980);
  });

  it('redacts full headers, bearer values, and common credential assignments', () => {
    const raw = 'Authorization: Bearer authValue123\nCookie: sid=cookieValue234\npassword=passwordValue345 token:tokenValue456 api_key=apiValue567 private key: privateValue678 access-key=accessValue789';
    const redacted = redactDiagnosticsText(raw);
    for (const secret of ['authValue123', 'sid=cookieValue234', 'passwordValue345', 'tokenValue456', 'apiValue567', 'privateValue678', 'accessValue789']) expect(redacted).not.toContain(secret);
    expect(redacted).toContain('[REDACTED]');
  });

  it('diagnostics excludes prompt and includes only the runtime whitelist', () => {
    const output = buildRuntimeDiagnostics({
      projectRoot: 'C:/work', runId: 'r', taskId: 't', executionId: 'e', retryOfRunId: null, rootRunId: 'r', retryAttempt: 0,
      taskTitle: 'title', initialPrompt: 'TOP SECRET PROMPT', priority: 'normal', modePolicy: 'M1', name: 'lead', pid: null,
      status: 'failed', events: [], stderrSummary: 'Authorization: Bearer abc123', cliSource: 'project', cliPath: 'cli', runtimeSource: 'path',
      runtimeExecutable: 'node', runtimeVersion: 'v24', startedAt: 1, lastActivity: 2, exitCode: 1, exitSignal: null,
      errorCode: 'RPC_EXIT_BEFORE_READY', retryable: true, pendingUiRequests: [], historical: false,
    });
    expect(output).not.toContain('TOP SECRET PROMPT');
    expect(output).not.toContain('abc123');
    expect(output).toContain('RPC_EXIT_BEFORE_READY');
  });

  it('aggregates only the exact taskId and sorts newest child run first', () => {
    const family = aggregateExecutionFamily([
      run({ runId: 'old', agent: 'implementer', finishedAt: 120, costUsd: 0.002 }),
      run({ runId: 'other', taskId: 'task-b', finishedAt: 999, costUsd: 99 }),
      run({ runId: 'new', agent: 'dag-review', finishedAt: 180, costUsd: 0.003 }),
    ], 'task-a');
    expect(family).toMatchObject({ totalRuns: 2, success: 2, failed: 0, totalCostUsd: 0.005, lastActivity: 180 });
    expect(family.details.map((detail) => detail.runId)).toEqual(['new', 'old']);
    expect(family.details[0]).toMatchObject({ isDagRole: true, status: 'success' });
  });

  it('normalizes failure-like outcomes without losing cancelled and timeout counts', () => {
    const family = aggregateExecutionFamily([
      run({ outcome: { status: 'failure' }, exitCode: 1 }),
      run({ outcome: { status: 'partial' }, exitCode: 0 }),
      run({ outcome: { status: 'unknown' }, exitCode: 0 }),
      run({ outcome: { status: 'cancelled' }, exitCode: 130 }),
      run({ outcome: { status: 'timeout' }, exitCode: 124 }),
      run({ outcome: undefined, exitCode: 0 }),
      run({ outcome: undefined, exitCode: 2 }),
    ], 'task-a');
    expect(family).toMatchObject({ totalRuns: 7, success: 1, failed: 4, cancelled: 1, timeout: 1 });
    expect(family.details.map((detail) => detail.status)).toEqual(expect.arrayContaining(['success', 'failed', 'cancelled', 'timeout']));
  });

  it('fails closed to an empty family when taskId is missing', () => {
    expect(aggregateExecutionFamily([run()], undefined)).toMatchObject({ totalRuns: 0, totalCostUsd: 0, details: [] });
    expect(aggregateExecutionFamily([run()], '')).toMatchObject({ totalRuns: 0, details: [] });
  });
});
