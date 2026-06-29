/**
 * D1-2: 数据聚合层
 * 从原始事件计算聚合指标 (图表数据)
 */

import type {
  RoutingDecisionEvent,
  CacheSampleEvent,
  SubagentRunEvent,
  AnyEvent,
} from "./events-parser";
import { filterByType, filterByTimeRange } from "./events-parser";

/** 路由历史时间轴数据点 */
export interface RouteHistoryPoint {
  ts: number;
  mode: string;
  confidence: number;
  preset: string;
  taskType?: string;
  complexityTier?: number;
  reason: string;
  cost?: number;
}

export function aggregateRouteHistory(events: AnyEvent[], range: "1h" | "24h" | "7d" | "30d" | "all"): RouteHistoryPoint[] {
  const filtered = filterByTimeRange(events, range);
  return filterByType<RoutingDecisionEvent>(filtered, "routing.decision").map((e) => ({
    ts: e.ts,
    mode: e.mode,
    confidence: e.confidence,
    preset: e.preset,
    taskType: e.taskType,
    complexityTier: e.complexityTier,
    reason: (e.reason ?? []).join("; ").slice(0, 200),
    cost: e.cost,
  }));
}

/** Cache 趋势数据点 */
export interface CacheTrendPoint {
  ts: number;
  turnIndex: number;
  hitRate: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextPercent: number;
  mode: string;
}

export function aggregateCacheTrend(events: AnyEvent[], range: "1h" | "24h" | "7d" | "30d" | "all"): CacheTrendPoint[] {
  const filtered = filterByTimeRange(events, range);
  return filterByType<CacheSampleEvent>(filtered, "cache.sample").map((e) => ({
    ts: e.ts,
    turnIndex: e.turnIndex,
    hitRate: e.cacheHitRate,
    input: e.input,
    output: e.output,
    cacheRead: e.cacheRead,
    cacheWrite: e.cacheWrite,
    cost: e.costUsd,
    contextPercent: e.contextPercent,
    mode: e.mode,
  }));
}

/** Token 构成饼图数据 */
export interface TokenBreakdown {
  name: string;
  value: number;
  color: string;
}

export function aggregateTokenBreakdown(events: AnyEvent[], range: "1h" | "24h" | "7d" | "30d" | "all"): TokenBreakdown[] {
  const filtered = filterByTimeRange(events, range);
  const samples = filterByType<CacheSampleEvent>(filtered, "cache.sample");
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
  for (const s of samples) {
    totalInput += s.input;
    totalOutput += s.output;
    totalCacheRead += s.cacheRead;
    totalCacheWrite += s.cacheWrite;
  }
  return [
    { name: "Input", value: totalInput, color: "#3b82f6" },
    { name: "Cache Read", value: totalCacheRead, color: "#10b981" },
    { name: "Output", value: totalOutput, color: "#f59e0b" },
    { name: "Cache Write", value: totalCacheWrite, color: "#ef4444" },
  ].filter((d) => d.value > 0);
}

/** 成本分析维度 */
export interface CostByMode { mode: string; cost: number; }
export interface CostByModel { model: string; cost: number; }
export interface CostByTaskType { taskType: string; cost: number; }

export function aggregateCostAnalysis(events: AnyEvent[], range: "1h" | "24h" | "7d" | "30d" | "all"): {
  byMode: CostByMode[];
  byModel: CostByModel[];
  byTaskType: CostByTaskType[];
  total: number;
  avgPerTurn: number;
} {
  const filtered = filterByTimeRange(events, range);
  const cacheSamples = filterByType<CacheSampleEvent>(filtered, "cache.sample");
  const subagentRuns = filterByType<SubagentRunEvent>(filtered, "subagent.run");

  // 使用有效事件 (兼容 v1/v2)
  const effectiveSamples = effectiveCacheSamples(cacheSamples);

  // By mode (from cache samples)
  const modeMap = new Map<string, number>();
  for (const s of effectiveSamples) {
    modeMap.set(s.mode, (modeMap.get(s.mode) ?? 0) + s.costUsd);
  }
  // Also add subagent costs to mode (approximate: use mode from event if available)
  for (const r of subagentRuns) {
    // subagent.run doesn't have mode field; attribute to "subagent"
    modeMap.set("subagent", (modeMap.get("subagent") ?? 0) + r.costUsd);
  }
  const byMode: CostByMode[] = [...modeMap.entries()]
    .map(([mode, cost]) => ({ mode, cost: Number(cost.toFixed(6)) }))
    .sort((a, b) => b.cost - a.cost);

  // By model
  const modelMap = new Map<string, number>();
  for (const s of effectiveSamples) {
    modelMap.set(s.model, (modelMap.get(s.model) ?? 0) + s.costUsd);
  }
  for (const r of subagentRuns) {
    modelMap.set(r.model, (modelMap.get(r.model) ?? 0) + r.costUsd);
  }
  const byModel: CostByModel[] = [...modelMap.entries()]
    .map(([model, cost]) => ({ model, cost: Number(cost.toFixed(6)) }))
    .sort((a, b) => b.cost - a.cost);

  // By task type (from routing decisions, approximate cost)
  const routingEvents = filterByType<RoutingDecisionEvent>(filtered, "routing.decision");
  const taskTypeMap = new Map<string, number>();
  for (const r of routingEvents) {
    const tt = r.taskType ?? "unknown";
    // Approximate: use cost field if available, else 0
    taskTypeMap.set(tt, (taskTypeMap.get(tt) ?? 0) + (r.cost ?? 0));
  }
  const byTaskType: CostByTaskType[] = [...taskTypeMap.entries()]
    .map(([taskType, cost]) => ({ taskType, cost: Number(cost.toFixed(6)) }))
    .sort((a, b) => b.cost - a.cost);

  // 使用智能聚合 (兼容 v1 累计 + v2 增量)
  const cacheSum = sumCacheSamples(cacheSamples);
  const total = cacheSum.totalCost + subagentRuns.reduce((s, e) => s + e.costUsd, 0);
  const turnCount = new Set(cacheSamples.map((s) => s.sessionId + ":" + s.turnIndex)).size;
  const avgPerTurn = turnCount > 0 ? total / turnCount : 0;

  return {
    byMode,
    byModel,
    byTaskType,
    total: Number(total.toFixed(6)),
    avgPerTurn: Number(avgPerTurn.toFixed(6)),
  };
}

/**
 * 返回有效的 cache.sample 事件 (v2 全保留, v1 只保留每个 session 的最后一条)
 * 用于 byMode/byModel 等分组聚合
 */
function effectiveCacheSamples(cacheSamples: CacheSampleEvent[]): CacheSampleEvent[] {
  const v2 = cacheSamples.filter(e => (e as any).v === 2);
  const v1 = cacheSamples.filter(e => (e as any).v !== 2);
  // v1: 按 session 分组取最后一条
  const v1BySession = new Map<string, CacheSampleEvent>();
  for (const e of v1) {
    const existing = v1BySession.get(e.sessionId);
    if (!existing || e.ts > existing.ts) v1BySession.set(e.sessionId, e);
  }
  return [...v2, ...v1BySession.values()];
}

/**
 * 智能聚合 cache.sample 事件的 cost/token (兼容 v1 累计格式 和 v2 增量格式)
 * - v=2 事件: 直接求和 (每 turn 增量)
 * - v=1 或无 v: 按 session 分组取最后一个值 (累计值的最终值)
 */
function sumCacheSamples(cacheSamples: CacheSampleEvent[]): {
  totalCost: number; totalInput: number; totalOutput: number;
  totalCacheRead: number; totalCacheWrite: number;
} {
  const v2Events = cacheSamples.filter(e => (e as any).v === 2);
  const v1Events = cacheSamples.filter(e => (e as any).v !== 2);

  // v2: 直接求和
  const v2Sum = v2Events.reduce((s, e) => ({
    totalCost: s.totalCost + e.costUsd,
    totalInput: s.totalInput + e.input,
    totalOutput: s.totalOutput + e.output,
    totalCacheRead: s.totalCacheRead + e.cacheRead,
    totalCacheWrite: s.totalCacheWrite + e.cacheWrite,
  }), { totalCost: 0, totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0 });

  // v1: 按 session 分组取最后一个事件 (累计值的最终值)
  const v1BySession = new Map<string, CacheSampleEvent>();
  for (const e of v1Events) {
    const existing = v1BySession.get(e.sessionId);
    if (!existing || e.ts > existing.ts) v1BySession.set(e.sessionId, e);
  }
  const v1Sum = [...v1BySession.values()].reduce((s, e) => ({
    totalCost: s.totalCost + e.costUsd,
    totalInput: s.totalInput + e.input,
    totalOutput: s.totalOutput + e.output,
    totalCacheRead: s.totalCacheRead + e.cacheRead,
    totalCacheWrite: s.totalCacheWrite + e.cacheWrite,
  }), { totalCost: 0, totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0 });

  return {
    totalCost: v2Sum.totalCost + v1Sum.totalCost,
    totalInput: v2Sum.totalInput + v1Sum.totalInput,
    totalOutput: v2Sum.totalOutput + v1Sum.totalOutput,
    totalCacheRead: v2Sum.totalCacheRead + v1Sum.totalCacheRead,
    totalCacheWrite: v2Sum.totalCacheWrite + v1Sum.totalCacheWrite,
  };
}
export interface AgentTimelineEntry {
  ts: number;
  agent: string;
  task: string;
  model: string;
  turns: number;
  cost: number;
  cacheHitRate: number;
  exitCode: number;
  retryCount?: number;
  thinking?: string;
}

export function aggregateAgentTimeline(events: AnyEvent[], range: "1h" | "24h" | "7d" | "30d" | "all"): AgentTimelineEntry[] {
  const filtered = filterByTimeRange(events, range);
  return filterByType<SubagentRunEvent>(filtered, "subagent.run").map((e) => ({
    ts: e.ts,
    agent: e.agent,
    task: e.task.slice(0, 80),
    model: e.model,
    turns: e.turns,
    cost: e.costUsd,
    cacheHitRate: e.cacheHitRate,
    exitCode: e.exitCode,
    retryCount: e.retryCount,
    thinking: e.thinking,
  }));
}

/** 汇总统计 */
export function aggregateSummary(events: AnyEvent[]): {
  totalEvents: number;
  totalCost: number;
  avgCacheHit: number;
  routingDecisions: number;
  subagentRuns: number;
  contextEvents: number;
  cacheSamples: number;
  timeRange: { earliest: number; latest: number };
} {
  const routingDecisions = filterByType(events, "routing.decision");
  const cacheSamples = filterByType<CacheSampleEvent>(events, "cache.sample");
  const subagentRuns = filterByType<SubagentRunEvent>(events, "subagent.run");
  const contextEvents = filterByType(events, "context.event");

  // 使用智能聚合 (兼容 v1 累计 + v2 增量)
  const cacheSum = sumCacheSamples(cacheSamples);
  const totalCost = cacheSum.totalCost + subagentRuns.reduce((s, e) => s + e.costUsd, 0);

  const avgCacheHit = cacheSamples.length > 0
    ? cacheSamples.reduce((s, e) => s + e.cacheHitRate, 0) / cacheSamples.length
    : 0;

  const allTs = events.map((e) => e.ts).filter(Boolean);
  const earliest = allTs.length > 0 ? Math.min(...allTs) : 0;
  const latest = allTs.length > 0 ? Math.max(...allTs) : 0;

  return {
    totalEvents: events.length,
    totalCost: Number(totalCost.toFixed(6)),
    avgCacheHit: Number(avgCacheHit.toFixed(4)),
    routingDecisions: routingDecisions.length,
    subagentRuns: subagentRuns.length,
    contextEvents: contextEvents.length,
    cacheSamples: cacheSamples.length,
    timeRange: { earliest, latest },
  };
}
