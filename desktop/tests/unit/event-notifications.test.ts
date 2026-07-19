import { describe, expect, it } from 'vitest';
import { advanceRunNotificationCursor, groupRunNotifications } from '../../src/lib/run-notifications';

describe('Event notification batching', () => {
  it('uses the first poll as a baseline instead of replaying historical failures', () => {
    const oldRuns = [{ type: 'subagent.run', agent: 'old', exitCode: 124 }, { type: 'subagent.run', agent: 'old', exitCode: 1 }] as any;
    const baseline = advanceRunNotificationCursor(oldRuns, { initialized: false, count: 0 });
    expect(baseline.freshRuns).toEqual([]);

    const nextRun = { type: 'subagent.run', agent: 'new', exitCode: 0 };
    const appended = advanceRunNotificationCursor([...oldRuns, nextRun] as any, baseline.cursor);
    expect(appended.freshRuns).toEqual([nextRun]);
  });

  it('folds identical failures and keeps different exit causes separate', () => {
    const base = { type: 'subagent.run', ts: 1, sessionId: 's', task: 't', provider: 'p', model: 'm', turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, durationMs: 1 };
    const batches = groupRunNotifications([
      { ...base, agent: 'reviewer', exitCode: 124 },
      { ...base, ts: 2, agent: 'reviewer', exitCode: 124 },
      { ...base, ts: 3, agent: 'reviewer', exitCode: 1 },
    ] as any);
    expect(batches).toHaveLength(2);
    expect(batches.find((item) => item.detail === 'exit code 124')).toMatchObject({ count: 2, title: 'reviewer failed' });
    expect(batches.find((item) => item.detail === 'exit code 1')).toMatchObject({ count: 1 });
  });
});
