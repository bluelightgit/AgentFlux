/**
 * OA-5: Enhanced agent status reader
 * Reads persistent-agents.json, blackboard.json, dag-state.json, override.json,
 * AND scans sessions/ directory for per-agent telemetry details.
 * Also aggregates subagent.run events from events.jsonl for per-agent stats.
 */

import { readDirectoryFiles, readFileContent, listDirectory, pathExists } from "./file-access";

// ─── Types ───

export interface PersistentAgent {
  name: string;
  role: string;
  model: string;
  sessionFile: string;
  status: string;
  callCount: number;
  totalCost: number;
  totalCacheRead: number;
}

export interface BlackboardAgent {
  name: string;
  role?: string;
  status: string;
  workingOn?: string;
  lastUpdate?: number;
}

export interface DAGState {
  executionId: string;
  status: string;
  description: string;
  startTime: number;
  timestamp: number;
  nodeIds: string[];
  completed: string[];
  failed: string[];
  totalNodes: number;
  totalCost: number;
  iterationCount: number;
  taskResults: unknown[];
  artifactPaths: Record<string, string>;
  nodes?: { id: string; title?: string; role?: string; status?: string }[];
}

export type DeliveryV2Status = "pending" | "delivered" | "acknowledged" | "rejected" | "expired";

export interface MessageV2Observation {
  id: string;
  from: string;
  type: string;
  content: string;
  recipients: string[];
  priority: string;
  createdAt: string;
  correlationId?: string;
  taskId?: string;
  senderInstanceId?: string;
  deliveries: Array<{ recipient: string; status: DeliveryV2Status; attempts: number }>;
}

export interface OverrideInfo {
  preset?: string;
  forceMode?: string;
  ephemeral?: boolean;
  ts?: number;
}

/** Per-agent telemetry aggregated from subagent.run events */
export interface AgentTelemetry {
  name: string;
  runs: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  avgHitRate: number;
  avgTurns: number;
  failures: number;
  retries: number;
  communicationPassed: number;
  communicationFailed: number;
  models: string[];
  lastRunTs: number;
  /** Per-run breakdown for detailed view */
  runs_detail: Array<{
    ts: number;
    model: string;
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    cost: number;
    hitRate: number;
    exitCode: number;
    persistent: boolean;
    thinking: string;
    retryCount: number;
    runId?: string;
    outcome?: string;
    communication?: {
      passed: boolean;
      missingSendTo: string[];
      unacknowledgedInbox: string[];
    };
  }>;
}

export interface AgentStatusData {
  persistentAgents: PersistentAgent[];
  blackboardAgents: BlackboardAgent[];
  dagState: DAGState | null;
  override: OverrideInfo | null;
  agentTelemetry: Map<string, AgentTelemetry>;
  messagesV2: MessageV2Observation[];
  timestamp: number;
}

// ─── Readers ───

export async function readAgentStatus(fluxDir: string): Promise<AgentStatusData> {
  const [persistentAgents, blackboardAgents, dagState, override, agentTelemetry, messagesV2] = await Promise.all([
    readPersistentAgents(fluxDir),
    readBlackboardAgents(fluxDir),
    readDAGState(fluxDir),
    readOverride(fluxDir),
    readAgentTelemetry(fluxDir),
    readMessagesV2(fluxDir),
  ]);

  return {
    persistentAgents,
    blackboardAgents,
    dagState,
    override,
    agentTelemetry,
    messagesV2,
    timestamp: Date.now(),
  };
}

async function readPersistentAgents(fluxDir: string): Promise<PersistentAgent[]> {
  const filePath = `${fluxDir}/runtime/persistent-agents.json`;
  const exists = await pathExists(filePath);
  if (!exists) return [];

  const content = await readFileContent(filePath);
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) return data;
    if (data.agents && Array.isArray(data.agents)) return data.agents;
    return [];
  } catch {
    return [];
  }
}

async function readBlackboardAgents(fluxDir: string): Promise<BlackboardAgent[]> {
  const filePath = `${fluxDir}/shared/blackboard.json`;
  const exists = await pathExists(filePath);
  if (!exists) return [];

  const content = await readFileContent(filePath);
  try {
    const data = JSON.parse(content);
    const agents: BlackboardAgent[] = [];
    const agentMap = data.agents ?? data;
    if (agentMap && typeof agentMap === "object" && !Array.isArray(agentMap)) {
      for (const [name, info] of Object.entries(agentMap)) {
        const a = info as any;
        agents.push({
          name,
          role: a.role,
          status: a.status ?? "unknown",
          workingOn: a.workingOn,
          lastUpdate: a.lastUpdate ?? a.ts,
        });
      }
    } else if (Array.isArray(agentMap)) {
      for (const a of agentMap) {
        agents.push({
          name: a.name ?? a.agent ?? "unknown",
          role: a.role,
          status: a.status ?? "unknown",
          workingOn: a.workingOn,
          lastUpdate: a.lastUpdate ?? a.ts,
        });
      }
    }
    return agents;
  } catch {
    return [];
  }
}

async function readDAGState(fluxDir: string): Promise<DAGState | null> {
  const filePath = `${fluxDir}/runtime/dag-state.json`;
  const exists = await pathExists(filePath);
  if (!exists) return null;

  const content = await readFileContent(filePath);
  try {
    const data = JSON.parse(content);
    const nodeIds = Array.isArray(data.nodeIds) ? data.nodeIds : [];
    const timestamp = data.timestamp ?? data.startTime ?? data.ts ?? 0;
    return {
      executionId: data.executionId ?? "",
      status: data.status ?? "unknown",
      description: data.description ?? "",
      startTime: timestamp,
      timestamp,
      nodeIds,
      completed: data.completed ?? [],
      failed: data.failed ?? [],
      totalNodes: data.totalNodes ?? (nodeIds.length > 0
        ? nodeIds.length
        : (data.completed?.length ?? 0) + (data.failed?.length ?? 0)),
      totalCost: data.totalCost ?? 0,
      iterationCount: data.iterationCount ?? 0,
      taskResults: Array.isArray(data.taskResults) ? data.taskResults : [],
      artifactPaths: data.artifactPaths && typeof data.artifactPaths === "object" ? data.artifactPaths : {},
      nodes: Array.isArray(data.nodes) ? data.nodes : undefined,
    };
  } catch {
    return null;
  }
}

async function readMessagesV2(fluxDir: string): Promise<MessageV2Observation[]> {
  const root = `${fluxDir}/shared/messages-v2`;
  const envelopeFiles = await readDirectoryFiles(`${root}/envelopes`);
  if (envelopeFiles.length === 0) return [];

  const deliveryByMessage = new Map<string, MessageV2Observation["deliveries"]>();
  for (const recipient of await listDirectory(`${root}/deliveries`)) {
    for (const file of await readDirectoryFiles(`${root}/deliveries/${recipient}`)) {
      try {
        const delivery = JSON.parse(file.content);
        if (!delivery.messageId) continue;
        const list = deliveryByMessage.get(delivery.messageId) ?? [];
        list.push({
          recipient: delivery.recipient ?? recipient,
          status: delivery.status ?? "pending",
          attempts: delivery.attempts ?? 0,
        });
        deliveryByMessage.set(delivery.messageId, list);
      } catch { /* ignore incomplete atomic snapshots */ }
    }
  }

  return envelopeFiles.flatMap((file) => {
    try {
      const envelope = JSON.parse(file.content);
      if (!envelope.id) return [];
      return [{
        id: envelope.id,
        from: envelope.from ?? "unknown",
        type: envelope.type ?? "message",
        content: envelope.content ?? "",
        recipients: Array.isArray(envelope.recipients) ? envelope.recipients : [],
        priority: envelope.priority ?? "normal",
        createdAt: envelope.createdAt ?? "",
        correlationId: envelope.correlationId,
        taskId: envelope.taskId,
        senderInstanceId: envelope.senderInstanceId,
        deliveries: deliveryByMessage.get(envelope.id) ?? [],
      } satisfies MessageV2Observation];
    } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
}

async function readOverride(fluxDir: string): Promise<OverrideInfo | null> {
  const filePath = `${fluxDir}/runtime/override.json`;
  const exists = await pathExists(filePath);
  if (!exists) return null;

  const content = await readFileContent(filePath);
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Parse subagent.run events from events.jsonl and aggregate per-agent telemetry.
 * This is the key observability data source for multi-agent execution.
 */
async function readAgentTelemetry(fluxDir: string): Promise<Map<string, AgentTelemetry>> {
  const filePath = `${fluxDir}/events.jsonl`;
  const exists = await pathExists(filePath);
  if (!exists) return new Map();

  const content = await readFileContent(filePath);
  const telemetry = new Map<string, AgentTelemetry>();

  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== "subagent.run") continue;

      const name = e.agent;
      if (!name) continue;

      if (!telemetry.has(name)) {
        telemetry.set(name, {
          name,
          runs: 0,
          totalInput: 0,
          totalOutput: 0,
          totalCacheRead: 0,
          totalCacheWrite: 0,
          totalCost: 0,
          avgHitRate: 0,
          avgTurns: 0,
          failures: 0,
          retries: 0,
          communicationPassed: 0,
          communicationFailed: 0,
          models: [],
          lastRunTs: 0,
          runs_detail: [],
        });
      }

      const t = telemetry.get(name)!;
      t.runs++;
      t.totalInput += e.input ?? 0;
      t.totalOutput += e.output ?? 0;
      t.totalCacheRead += e.cacheRead ?? 0;
      t.totalCacheWrite += e.cacheWrite ?? 0;
      t.totalCost += e.costUsd ?? 0;
      t.avgTurns += e.turns ?? 0;
      if (e.exitCode !== 0) t.failures++;
      if (e.retryCount && e.retryCount > 0) t.retries += e.retryCount;
      if (e.communication?.passed === true) t.communicationPassed++;
      if (e.communication?.passed === false) t.communicationFailed++;
      if (e.model && !t.models.includes(e.model)) t.models.push(e.model);
      if (e.ts > t.lastRunTs) t.lastRunTs = e.ts;

      const hitRate = (e.cacheRead ?? 0) / ((e.cacheRead ?? 0) + (e.input ?? 0) + 1e-9);
      t.runs_detail.push({
        ts: e.ts ?? 0,
        model: e.model ?? "unknown",
        turns: e.turns ?? 0,
        input: e.input ?? 0,
        output: e.output ?? 0,
        cacheRead: e.cacheRead ?? 0,
        cost: e.costUsd ?? 0,
        hitRate,
        exitCode: e.exitCode ?? 0,
        persistent: e.persistent ?? false,
        thinking: e.thinking ?? "off",
        retryCount: e.retryCount ?? 0,
        runId: e.runId,
        outcome: e.outcome?.status,
        communication: e.communication,
      });
    } catch {
      // skip malformed lines
    }
  }

  // Compute averages
  for (const t of telemetry.values()) {
    t.avgHitRate = t.runs > 0
      ? t.runs_detail.reduce((s, r) => s + r.hitRate, 0) / t.runs
      : 0;
    t.avgTurns = t.runs > 0 ? t.avgTurns / t.runs : 0;
    // Keep only last 20 runs for detail view
    if (t.runs_detail.length > 20) {
      t.runs_detail = t.runs_detail.slice(-20);
    }
  }

  return telemetry;
}

// ─── Formatting helpers (re-exported from shared lib/format.ts) ───

export { formatTokens, formatCost, formatPct as formatHitRate } from './format';
