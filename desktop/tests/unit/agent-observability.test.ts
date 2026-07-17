import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();
const directories = new Map<string, Array<{ name: string; content: string }>>();
const listings = new Map<string, string[]>();

vi.mock('../../src/lib/file-access', () => ({
  pathExists: vi.fn(async (path: string) => files.has(path) || directories.has(path)),
  readFileContent: vi.fn(async (path: string) => files.get(path) ?? ''),
  readDirectoryFiles: vi.fn(async (path: string) => directories.get(path) ?? []),
  listDirectory: vi.fn(async (path: string) => listings.get(path) ?? []),
}));

import { readAgentStatus } from '../../src/lib/agent-status-enhanced';

describe('Desktop agent observability contract', () => {
  beforeEach(() => {
    files.clear();
    directories.clear();
    listings.clear();
  });

  it('reads shared blackboard and preserves the real DAG execution schema', async () => {
    files.set('/flux/shared/blackboard.json', JSON.stringify({
      agents: { reviewer: { role: 'reviewer', status: 'running', workingOn: 'gate' } },
    }));
    files.set('/flux/runtime/dag-state.json', JSON.stringify({
      executionId: 'task-123',
      description: 'full chain',
      nodeIds: ['plan', 'review'],
      completed: ['plan'],
      failed: [],
      status: 'running',
      totalCost: 0.42,
      iterationCount: 2,
      taskResults: [['plan', { passed: true }]],
      artifactPaths: { plan: '/artifact/plan.md' },
      timestamp: 123456,
    }));

    const status = await readAgentStatus('/flux');
    expect(status.blackboardAgents).toEqual([
      expect.objectContaining({ name: 'reviewer', status: 'running', workingOn: 'gate' }),
    ]);
    expect(status.dagState).toMatchObject({
      executionId: 'task-123',
      status: 'running',
      nodeIds: ['plan', 'review'],
      totalNodes: 2,
      totalCost: 0.42,
      iterationCount: 2,
      timestamp: 123456,
    });
    expect(status.dagState?.taskResults).toHaveLength(1);
    expect(status.dagState?.artifactPaths).toEqual({ plan: '/artifact/plan.md' });
  });

  it('joins V2 envelopes with per-recipient delivery state', async () => {
    directories.set('/flux/shared/messages-v2/envelopes', [{
      name: 'msg2-1.json',
      content: JSON.stringify({
        schemaVersion: 2,
        id: 'msg2-1',
        from: 'planner',
        type: 'handoff',
        content: 'review this',
        recipients: ['reviewer'],
        priority: 'high',
        createdAt: '2026-07-16T00:00:00.000Z',
        correlationId: 'run-1',
      }),
    }]);
    listings.set('/flux/shared/messages-v2/deliveries', ['reviewer']);
    directories.set('/flux/shared/messages-v2/deliveries/reviewer', [{
      name: 'msg2-1.json',
      content: JSON.stringify({
        messageId: 'msg2-1', recipient: 'reviewer', status: 'acknowledged', attempts: 1,
      }),
    }]);

    const status = await readAgentStatus('/flux');
    expect(status.messagesV2).toEqual([
      expect.objectContaining({
        id: 'msg2-1',
        correlationId: 'run-1',
        deliveries: [{ recipient: 'reviewer', status: 'acknowledged', attempts: 1 }],
      }),
    ]);
  });

  it('aggregates communication completion-gate outcomes from subagent.run', async () => {
    files.set('/flux/events.jsonl', [
      JSON.stringify({
        ts: 1, type: 'subagent.run', agent: 'reviewer', model: 'm', exitCode: 0,
        communication: { passed: true, missingSendTo: [], unacknowledgedInbox: [] },
        outcome: { status: 'success' }, runId: 'run-ok',
      }),
      JSON.stringify({
        ts: 2, type: 'subagent.run', agent: 'reviewer', model: 'm', exitCode: 76,
        communication: { passed: false, missingSendTo: ['leader'], unacknowledgedInbox: [] },
        outcome: { status: 'failure' }, runId: 'run-fail',
      }),
    ].join('\n'));

    const reviewer = (await readAgentStatus('/flux')).agentTelemetry.get('reviewer');
    expect(reviewer).toMatchObject({ communicationPassed: 1, communicationFailed: 1, failures: 1 });
    expect(reviewer?.runs_detail[1]).toMatchObject({ runId: 'run-fail', outcome: 'failure' });
  });
});
