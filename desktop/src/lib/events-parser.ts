/**
 * D1-2: Events.jsonl 解析器
 * 读取 AgentFlux 遥测数据并转为结构化类型
 * 支持同步 (Node) 和异步 (Electron 渲染进程) 两种模式
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { readFileContent, readFileIncremental, getFileSize, pathExists } from "./file-access";

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

function parseJsonl(content: string): AnyEvent[] {
  const events: AnyEvent[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

/** 同步解析 (Node 环境) */
export function parseEventsFile(filePath: string): AnyEvent[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return parseJsonl(content);
}

/** 异步解析 (Electron 渲染进程) */
export async function parseEventsFileAsync(filePath: string): Promise<AnyEvent[]> {
  const content = await readFileContent(filePath);
  return parseJsonl(content);
}

/** 同步增量读取 (Node 环境) */
export function parseEventsIncremental(
  filePath: string,
  lastOffset: number,
): { events: AnyEvent[]; newOffset: number } {
  if (!existsSync(filePath)) return { events: [], newOffset: 0 };
  const stat = statSync(filePath);
  if (stat.size <= lastOffset) return { events: [], newOffset: lastOffset };

  const fd = openSync(filePath, "r");
  const length = stat.size - lastOffset;
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, lastOffset);
  closeSync(fd);

  return { events: parseJsonl(buffer.toString("utf-8")), newOffset: stat.size };
}

/** 异步增量读取 (Electron 渲染进程) */
export async function parseEventsIncrementalAsync(
  filePath: string,
  lastOffset: number,
): Promise<{ events: AnyEvent[]; newOffset: number }> {
  const { content, newSize } = await readFileIncremental(filePath, lastOffset);
  if (newSize <= lastOffset) return { events: [], newOffset: lastOffset };
  return { events: parseJsonl(content), newOffset: newSize };
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
    "1h": 3600_000, "24h": 86400_000, "7d": 604800_000, "30d": 2592000_000,
  };
  const cutoff = now - ms[range];
  return events.filter((e) => e.ts >= cutoff);
}
