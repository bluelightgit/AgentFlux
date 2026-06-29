/**
 * OA-5: Enhanced agent status reader
 * Reads persistent-agents.json, blackboard.json, dag-state.json, override.json,
 * AND scans sessions/ directory for per-agent telemetry details.
 * Also aggregates subagent.run events from events.jsonl for per-agent stats.
 */

import { readFileContent, pathExists, getFileSize } from "./file-access";

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
  description: string;
  startTime: number;
  completed: string[];
  failed: string[];
  totalNodes: number;
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
  }>;
}

export interface AgentStatusData {
  persistentAgents: PersistentAgent[];
  blackboardAgents: BlackboardAgent[];
  dagState: DAGState | null;
  override: OverrideInfo | null;
  agentTelemetry: Map<string, AgentTelemetry>;
  timestamp: number;
}

// ─── Readers ───

export async function readAgentStatus(fluxDir: string): Promise<AgentStatusData> {
  const [persistentAgents, blackboardAgents, dagState, override, agentTelemetry] = await Promise.all([
    readPersistentAgents(fluxDir),
    readBlackboardAgents(fluxDir),
    readDAGState(fluxDir),
    readOverride(fluxDir),
    readAgentTelemetry(fluxDir),
  ]);

  return {
    persistentAgents,
    blackboardAgents,
    dagState,
    override,
    agentTelemetry,
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
  const filePath = `${fluxDir}/blackboard.json`;
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
    return {
      description: data.description ?? "",
      startTime: data.startTime ?? data.ts ?? 0,
      completed: data.completed ?? [],
      failed: data.failed ?? [],
      totalNodes: data.totalNodes ?? (data.completed?.length ?? 0) + (data.failed?.length ?? 0),
    };
  } catch {
    return null;
  }
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

// ─── Formatting helpers ───

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

export function formatCost(c: number): string {
  if (c === 0) return "$0";
  if (c < 0.001) return `$${c.toExponential(2)}`;
  if (c < 0.01) return `$${c.toFixed(6)}`;
  return `$${c.toFixed(4)}`;
}

export function formatHitRate(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}
