/**
 * Insights Generator — produces AI-powered insights from telemetry data.
 *
 * Reads events.jsonl from the given flux directory, filters subagent.run
 * events, and derives actionable insights (cache hit, failures, cost,
 * staleness, etc). The returned list is capped at 8 items.
 */

import { parseEventsFileAsync, filterByType, type SubagentRunEvent } from "./events-parser";
import type { InsightItem } from "../components/InsightsCard";

/** Aggregate metrics for a single agent across all its runs. */
interface AgentStats {
  name: string;
  runs: number;
  failures: number;
  totalCost: number;
  cacheHitSum: number; // summed for averaging
  lastTs: number;
}

/** Format a USD cost with 2 decimal places. */
function fmtCost(cost: number): string {
  return cost.toFixed(2);
}

/** Format a duration (ms) as a human-readable "Xm" / "Xh" / "Xd" string. */
function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

/**
 * Generate insights from the telemetry data in the given flux directory.
 * Returns an empty array on error.
 */
export async function generateInsights(fluxDir: string): Promise<InsightItem[]> {
  try {
    const allEvents = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
    const runs = filterByType<SubagentRunEvent>(allEvents, "subagent.run");

    // Empty data — guide the user to dispatch agents.
    if (runs.length === 0) {
      return [
        {
          severity: "info",
          icon: "Info",
          message: "No telemetry data yet — dispatch agents to collect metrics",
        },
      ];
    }

    // Aggregate per-agent stats.
    const statsMap = new Map<string, AgentStats>();
    let totalCost = 0;
    let lastTs = 0;
    let overallCacheHitSum = 0;
    let overallFailures = 0;

    for (const r of runs) {
      const name = r.agent || "unknown";
      let s = statsMap.get(name);
      if (!s) {
        s = {
          name,
          runs: 0,
          failures: 0,
          totalCost: 0,
          cacheHitSum: 0,
          lastTs: 0,
        };
        statsMap.set(name, s);
      }
      s.runs += 1;
      if (r.exitCode !== 0) s.failures += 1;
      s.totalCost += r.costUsd || 0;
      s.cacheHitSum += r.cacheHitRate || 0;
      if (r.ts > s.lastTs) s.lastTs = r.ts;

      totalCost += r.costUsd || 0;
      overallCacheHitSum += r.cacheHitRate || 0;
      if (r.exitCode !== 0) overallFailures += 1;
      if (r.ts > lastTs) lastTs = r.ts;
    }

    const insights: InsightItem[] = [];
    const statsArr = Array.from(statsMap.values());

    // 1. Low cache hit — per agent avg < 30%.
    for (const s of statsArr) {
      const avgHit = s.runs > 0 ? s.cacheHitSum / s.runs : 0;
      if (avgHit < 30) {
        insights.push({
          severity: "warning",
          icon: "Database",
          message: `Agent ${s.name} has ${Math.round(avgHit)}% cache hit — consider persistent sessions`,
        });
      }
    }

    // 2. High failure rate — per agent > 2 failures.
    for (const s of statsArr) {
      if (s.failures > 2) {
        insights.push({
          severity: "critical",
          icon: "AlertCircle",
          message: `Agent ${s.name} has ${s.failures} failures — check model availability`,
        });
      }
    }

    // 3. Cost summary.
    insights.push({
      severity: "info",
      icon: "DollarSign",
      message: `Total cost $${fmtCost(totalCost)} across ${runs.length} agent runs`,
    });

    // 4. No recent activity — last event > 5 min ago.
    const now = Date.now();
    if (lastTs > 0 && now - lastTs > 5 * 60 * 1000) {
      insights.push({
        severity: "info",
        icon: "Clock",
        message: `No recent agent activity — last run ${fmtDuration(now - lastTs)} ago`,
      });
    }

    // 5. High cost agent — total cost > $0.50.
    for (const s of statsArr) {
      if (s.totalCost > 0.5) {
        insights.push({
          severity: "warning",
          icon: "TrendingUp",
          message: `Agent ${s.name} has accumulated $${fmtCost(s.totalCost)} — review efficiency`,
        });
      }
    }

    // 6. Good performance — overall cache hit > 70% and 0 failures.
    const overallCacheHit = runs.length > 0 ? overallCacheHitSum / runs.length : 0;
    if (overallCacheHit > 70 && overallFailures === 0) {
      insights.push({
        severity: "info",
        icon: "CheckCircle",
        message: `All agents performing well — ${Math.round(overallCacheHit)}% avg cache hit, 0 failures`,
      });
    }

    // Cap at 8 items.
    return insights.slice(0, 8);
  } catch {
    return [];
  }
}
