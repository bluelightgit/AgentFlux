/**
 * Cache Hit Distribution — visualizes cache hit rate distribution across
 * agents. Reads `subagent.run` events from events.jsonl, groups them by agent
 * name, computes the average cache hit rate per agent, and renders a
 * horizontal bar chart (div-based, no Recharts).
 *
 * Bar color: >=70% green, >=40% amber, else red.
 * Below the bars: a summary row with overall avg hit rate, total cache-read
 * tokens, total input tokens, and estimated savings (cacheRead * avgInputPrice,
 * with 0 used as a fallback when no model pricing is available).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFileAsync,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { readFileContent } from "../lib/file-access";
import { Card, Icon, EmptyState } from "./ui";
import { formatPct, formatTokens, formatCost } from "../lib/format";

/** Per-agent aggregate row. */
interface AgentHitRow {
  agent: string;
  /** Average cache hit rate [0,1] across the agent's runs. */
  hitRate: number;
  /** Number of runs contributing to the average. */
  runs: number;
}

/** Raw models.json shape (only the bits we care about). */
interface RawModelsJson {
  models?: Record<string, { pricing?: { input?: number } }>;
}

/** Resolve a hit rate for a single run, preferring the event field. */
function resolveHitRate(r: SubagentRunEvent): number {
  if (typeof r.cacheHitRate === "number" && isFinite(r.cacheHitRate)) {
    return r.cacheHitRate;
  }
  const denom = (r.cacheRead ?? 0) + (r.input ?? 0);
  return denom > 0 ? (r.cacheRead ?? 0) / denom : 0;
}

/** Background color class for a hit-rate bar. */
function barColor(hitRate: number): string {
  if (hitRate >= 0.7) return "bg-green-500";
  if (hitRate >= 0.4) return "bg-amber-500";
  return "bg-red-500";
}

export function CacheHitDistribution(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [data, setData] = useState<AgentHitRow[]>([]);
  const [totals, setTotals] = useState<{ cacheRead: number; input: number }>({
    cacheRead: 0,
    input: 0,
  });
  const [loading, setLoading] = useState<boolean>(true);
  /** Average per-million input price across models in models.json (0 if none). */
  const [avgInputPrice, setAvgInputPrice] = useState<number>(0);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setData([]);
      setTotals({ cacheRead: 0, input: 0 });
      setLoading(false);
      return;
    }
    try {
      const parsed = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
      const runs = filterByType(parsed, "subagent.run") as SubagentRunEvent[];

      const order: string[] = [];
      const agg = new Map<string, { sum: number; count: number }>();
      let totalCacheRead = 0;
      let totalInput = 0;
      for (const r of runs) {
        const agent = r.agent ?? "unknown";
        const rate = resolveHitRate(r);
        if (!agg.has(agent)) {
          agg.set(agent, { sum: 0, count: 0 });
          order.push(agent);
        }
        const t = agg.get(agent)!;
        t.sum += rate;
        t.count += 1;
        totalCacheRead += r.cacheRead ?? 0;
        totalInput += r.input ?? 0;
      }

      const rows: AgentHitRow[] = order.map((agent) => {
        const t = agg.get(agent)!;
        return { agent, hitRate: t.sum / t.count, runs: t.count };
      });
      rows.sort((a, b) => b.hitRate - a.hitRate);
      setData(rows);
      setTotals({ cacheRead: totalCacheRead, input: totalInput });
    } catch {
      setData([]);
      setTotals({ cacheRead: 0, input: 0 });
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  // Load on mount and poll every 10s.
  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  // Load models.json once per fluxDir to estimate avg input price.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!fluxDir) {
        setAvgInputPrice(0);
        return;
      }
      try {
        const raw = await readFileContent(`${fluxDir}/models.json`);
        if (cancelled || !raw) {
          if (!cancelled) setAvgInputPrice(0);
          return;
        }
        const parsed = JSON.parse(raw) as RawModelsJson;
        const prices = Object.values(parsed.models ?? {})
          .map((m) => m?.pricing?.input ?? 0)
          .filter((p) => p > 0);
        if (cancelled) return;
        setAvgInputPrice(
          prices.length
            ? prices.reduce((a, b) => a + b, 0) / prices.length
            : 0,
        );
      } catch {
        if (!cancelled) setAvgInputPrice(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fluxDir]);

  // Overall average hit rate weighted by run count.
  const overallHitRate = useMemo(() => {
    const totalRuns = data.reduce((s, r) => s + r.runs, 0);
    if (totalRuns === 0) return 0;
    return data.reduce((s, r) => s + r.hitRate * r.runs, 0) / totalRuns;
  }, [data]);

  // Estimated savings: cache-read tokens billed at the avg input price
  // (per-million). Use 0 when no pricing is available.
  const savings = useMemo(() => {
    if (!avgInputPrice) return 0;
    return (totals.cacheRead / 1_000_000) * avgInputPrice;
  }, [totals.cacheRead, avgInputPrice]);

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Database" size={20} className="text-blue-500" />
        <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-200">
          Cache Hit Distribution
        </h3>
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : data.length === 0 ? (
        <EmptyState icon="Database" message="No cache data yet" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {data.map((row) => (
              <div key={row.agent} className="flex items-center gap-2">
                <div
                  className="w-32 shrink-0 truncate text-xs text-slate-600 dark:text-slate-300"
                  title={row.agent}
                >
                  {row.agent}
                </div>
                <div className="flex-1 relative h-6 bg-slate-100 dark:bg-slate-700 rounded overflow-hidden">
                  <div
                    className={`h-full rounded ${barColor(row.hitRate)}`}
                    style={{
                      width: `${Math.min(Math.max(row.hitRate * 100, 0), 100)}%`,
                    }}
                  />
                </div>
                <div className="w-12 shrink-0 text-right text-xs font-medium text-slate-700 dark:text-slate-200">
                  {formatPct(row.hitRate)}
                </div>
              </div>
            ))}
          </div>

          {/* Summary row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 border-t border-slate-200 dark:border-slate-700 pt-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Overall hit rate
              </div>
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {formatPct(overallHitRate)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Cache read tokens
              </div>
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {formatTokens(totals.cacheRead)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Input tokens
              </div>
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {formatTokens(totals.input)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Est. savings
              </div>
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {formatCost(savings)}
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
