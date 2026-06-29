/**
 * D2-1: 多 Agent 状态读取
 * 从 AgentFlux runtime 文件读取实时 agent 状态
 * 文件: persistent-agents.json, blackboard.json, dag-state.json, override.json
 */

import { readFileContent, pathExists } from "./file-access";

// ─── 类型定义 ───

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

export interface AgentStatusData {
  persistentAgents: PersistentAgent[];
  blackboardAgents: BlackboardAgent[];
  dagState: DAGState | null;
  override: OverrideInfo | null;
  timestamp: number;
}

// ─── 读取函数 ───

export async function readAgentStatus(fluxDir: string): Promise<AgentStatusData> {
  const [persistentAgents, blackboardAgents, dagState, override] = await Promise.all([
    readPersistentAgents(fluxDir),
    readBlackboardAgents(fluxDir),
    readDAGState(fluxDir),
    readOverride(fluxDir),
  ]);

  return {
    persistentAgents,
    blackboardAgents,
    dagState,
    override,
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

    // blackboard.json 可能有 agents 字段或直接是 agent 列表
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
