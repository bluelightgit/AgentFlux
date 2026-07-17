export type CapabilityLayer = 'template' | 'registered' | 'run';

export interface CapabilityPolicyInput {
  tools?: string[];
  skills?: string[];
  mcpServers?: string[];
  communication?: Record<string, unknown>;
  workspace?: { roots?: string[]; deniedPaths?: string[]; blockDangerousCommands?: boolean };
}

export interface EffectiveCapabilityRecord {
  schemaVersion: 1;
  agentName: string;
  role: string;
  instanceId?: string;
  runId: string;
  layers: { template: CapabilityPolicyInput; registered?: CapabilityPolicyInput; run?: CapabilityPolicyInput };
  effective: {
    tools: string[]; skills: string[]; mcpServers: string[];
    communication: Record<string, unknown>;
    workspace: { roots: string[]; deniedPaths: string[]; blockDangerousCommands: boolean; enforcement: string };
  };
  provenance: Array<{ field: string; sourceLayer: CapabilityLayer; reason: string }>;
  narrowed: string[];
  updatedAt: string;
}

export interface RegisteredCapabilityRecord {
  schemaVersion: 1; agentName: string; role: string; revision: number;
  override: CapabilityPolicyInput; updatedAt: string;
}

export interface CapabilityPolicyView {
  effective: EffectiveCapabilityRecord;
  registered?: RegisteredCapabilityRecord;
}

export interface CapabilityPolicyBundle {
  schemaVersion: 1; records: CapabilityPolicyView[]; notices: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

export function parseCapabilityPolicyBundle(raw: unknown): CapabilityPolicyBundle {
  if (!isObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.records)) {
    return { schemaVersion: 1, records: [], notices: ['Capability policy IPC returned an unsupported envelope.'] };
  }
  const notices = isStrings(raw.notices) ? [...raw.notices] : [];
  const records: CapabilityPolicyView[] = [];
  for (const item of raw.records) {
    if (!isObject(item) || !isObject(item.effective)) continue;
    const effective = item.effective;
    if (effective.schemaVersion !== 1 || typeof effective.agentName !== 'string' || typeof effective.role !== 'string'
      || typeof effective.runId !== 'string' || !isObject(effective.layers) || !isObject(effective.effective)
      || !Array.isArray(effective.provenance) || !isStrings(effective.narrowed)) continue;
    const resolved = effective.effective;
    if (!isStrings(resolved.tools) || !isStrings(resolved.skills) || !isStrings(resolved.mcpServers)
      || !isObject(resolved.communication) || !isObject(resolved.workspace)) continue;
    const registered = isObject(item.registered) && item.registered.schemaVersion === 1
      && item.registered.agentName === effective.agentName && typeof item.registered.revision === 'number'
      ? item.registered as unknown as RegisteredCapabilityRecord
      : undefined;
    records.push({ effective: effective as unknown as EffectiveCapabilityRecord, ...(registered ? { registered } : {}) });
  }
  if (records.length !== raw.records.length) notices.push('Some malformed capability records were ignored.');
  return { schemaVersion: 1, records, notices };
}

export function createCapabilitySetRequest(view: CapabilityPolicyView): Record<string, unknown> {
  return {
    action: 'set',
    agentName: view.effective.agentName,
    role: view.effective.role,
    expectedRevision: view.registered?.revision ?? 0,
    override: view.registered?.override ?? {},
  };
}
