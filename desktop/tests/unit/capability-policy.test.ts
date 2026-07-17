import { describe, expect, it } from 'vitest';
import { createCapabilitySetRequest, parseCapabilityPolicyBundle } from '../../src/lib/capability-policy';

const effective = {
  schemaVersion: 1, agentName: 'reviewer-1', role: 'reviewer', runId: 'run-1',
  layers: { template: { tools: ['read', 'bash'] }, registered: { tools: ['read'] }, run: { tools: ['read'] } },
  effective: {
    tools: ['flux_agent_message', 'read'], skills: ['review'], mcpServers: [],
    communication: { enabled: true, actions: ['poll'], allowedTargets: ['lead'] },
    workspace: { roots: ['E:/project'], deniedPaths: ['E:/project/.env'], blockDangerousCommands: true, enforcement: 'tool_hook_partial' },
  },
  provenance: [
    { field: 'tools', sourceLayer: 'template', reason: 'role allowlist' },
    { field: 'tools', sourceLayer: 'registered', reason: 'instance narrowed' },
    { field: 'tools', sourceLayer: 'run', reason: 'run narrowed' },
  ],
  narrowed: ['registered:tools', 'run:tools'], updatedAt: '2026-07-16T00:00:00.000Z',
};

describe('Capability policy Desktop adapter', () => {
  it('preserves effective values, provenance, narrowed layers and revision', () => {
    const bundle = parseCapabilityPolicyBundle({
      schemaVersion: 1,
      records: [{ effective, registered: {
        schemaVersion: 1, agentName: 'reviewer-1', role: 'reviewer', revision: 3,
        override: { tools: ['read'] }, updatedAt: '2026-07-16T00:00:00.000Z',
      } }], notices: [],
    });
    expect(bundle.records[0].effective.narrowed).toEqual(['registered:tools', 'run:tools']);
    expect(bundle.records[0].effective.provenance.map((item) => item.sourceLayer)).toEqual(['template', 'registered', 'run']);
    expect(createCapabilitySetRequest(bundle.records[0])).toEqual({
      action: 'set', agentName: 'reviewer-1', role: 'reviewer', expectedRevision: 3,
      override: { tools: ['read'] },
    });
  });

  it('fails closed to an empty view for unknown envelope and drops malformed records', () => {
    expect(parseCapabilityPolicyBundle({ schemaVersion: 2 }).records).toEqual([]);
    const parsed = parseCapabilityPolicyBundle({ schemaVersion: 1, records: [{ effective: { schemaVersion: 1 } }], notices: [] });
    expect(parsed.records).toEqual([]);
    expect(parsed.notices).toContain('Some malformed capability records were ignored.');
  });
});
