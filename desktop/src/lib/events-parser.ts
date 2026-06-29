/**
 * D1-2: Events.jsonl 解析器
 * 读取 AgentFlux 遥测数据并转为结构化类型
 */

export interface RoutingDecisionEvent {
  ts: number;
  type: "routing.decision";
  sessionId: string;
  mode: string;
  preset: string;
  stage: string;
  role: string;
  reason: string[];
  confidence: number;
  fallback?: string;
  biasSources?: any;
  expected?: any;
  taskType?: string;
  complexityTier?: number;
  overrideMode?: string;
  applied?: boolean;
  cost?: number;
  latencyMs?: number;
}

export interface CacheSampleEvent {
  ts: number;
  type: "cache.sample";
  sessionId: string;
  turnIndex: number;
  model: string;
  mode: string;
  stage: string;
  role: string;
  preset: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  contextTokens: number;
  contextWindow: number;
  contextPercent: number;
  cacheHitRate: number;
}

export interface SubagentRunEvent {
  ts: number;
  type: "subagent.run";
  sessionId: string;
  agent: string;
  task: string;
  model: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  contextTokens: number;
  cacheHitRate: number;
  prefixLayout?: boolean;
  exitCode: number;
  retryCount?: number;
  persistent?: boolean;
  thinking?: string;
}

export interface ContextEvent {
  ts: number;
  type: "context.event";
  sessionId: string;
  turnIndex: number;
  action: string;
  detail: string;
  contextPercentBefore: number | null;
  contextPercentAfter: number | null;
}

export type AnyEvent = RoutingDecisionEvent | CacheSampleEvent | SubagentRunEvent | ContextEvent;

/** 解析 events.jsonl 文件，返回结构化事件数组 */
export function parseEventsFile(filePath: string): AnyEvent[] {
  const fs = require("fs");
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const events: AnyEvent[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

/** 增量读取: 只获取 offset 之后的新行 */
export function parseEventsIncremental(
  filePath: string,
  lastOffset: number,
): { events: AnyEvent[]; newOffset: number } {
  const fs = require("fs");
  if (!fs.existsSync(filePath)) return { events: [], newOffset: 0 };
  const stat = fs.statSync(filePath);
  if (stat.size <= lastOffset) return { events: [], newOffset: lastOffset };

  const fd = fs.openSync(filePath, "r");
  const length = stat.size - lastOffset;
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, lastOffset);
  fs.closeSync(fd);

  const content = buffer.toString("utf-8");
  const events: AnyEvent[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return { events, newOffset: stat.size };
}

/** 按类型过滤事件 */
export function filterByType<T extends AnyEvent>(
  events: AnyEvent[],
  type: T["type"],
): T[] {
  return events.filter((e) => e.type === type) as T[];
}

/** 时间范围过滤 */
export function filterByTimeRange(
  events: AnyEvent[],
  range: "1h" | "24h" | "7d" | "30d" | "all",
): AnyEvent[] {
  if (range === "all") return events;
  const now = Date.now();
  const ms: Record<string, number> = {
    "1h": 3600_000,
    "24h": 86400_000,
    "7d": 604800_000,
    "30d": 2592000_000,
  };
  const cutoff = now - ms[range];
  return events.filter((e) => e.ts >= cutoff);
}
