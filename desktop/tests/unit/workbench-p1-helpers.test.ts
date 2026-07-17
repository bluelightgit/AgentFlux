import { describe, expect, it } from 'vitest';
import { buildRuntimeDiagnostics, clampColumns, redactDiagnosticsText } from '../../src/lib/workbench-p1';

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
});
