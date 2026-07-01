/**
 * Model Usage Stats — statistics on which models are used most.
 *
 * Reads `subagent.run` events from `${fluxDir}/events.jsonl`, groups them by
 * the `model` field, and aggregates runs, total cost, token throughput
 * (input/output/cache-read), average cache hit rate and failure count.
 *
 * Renders a sortable table (sorted by total cost descending) followed by a
 * div-based horizontal bar chart showing cost distribution across models.
 * Loads on mount and polls every 15s.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFile,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatCost, formatTokens, formatPct } from "../lib/format";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Per-model aggregate row. */
interface ModelUsageRow {
  name: string;
  runs: number;
  totalCost: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  avgHitRate: number;
  failures: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Resolve a hit rate for a single run, preferring the event field. */
function resolveHitRate(r: SubagentRunEvent): number {
  if (typeof r.cacheHitRate === "number" && isFinite(r.cacheHitRate)) {
    return r.cacheHitRate;
  }
  const denom = (r.cacheRead ?? 0) + (r.input ?? 0);
  return denom > 0 ? (r.cacheRead ?? 0) / denom : 0;
}

/** Badge color for a 0..1 average hit rate. */
function hitRateColor(r: number): "green" | "blue" | "amber" | "red" {
  if (r >= 0.7) return "green";
  if (r >= 0.5) return "blue";
  if (r >= 0.3) return "amber";
  return "red";
}

/** Distinct background color classes for the cost-distribution bars. */
const BAR_COLORS = [
  "bg-blue-500",
  "bg-purple-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-pink-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-orange-500",
];

// ─── Component ─────────────────────────────────────────────────────────────

export function ModelUsageStats(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [models, setModels] = useState<ModelUsageRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setModels([]);
      setLoading(false);
      return;
    }
    try {
      const parsed = await parseEventsFile(`${fluxDir}/events.jsonl`);
      const runs = filterByType(parsed, "subagent.run") as SubagentRunEvent[];

      const order: string[] = [];
      const agg = new Map<
        string,
        {
          runs: number;
          totalCost: number;
          totalInput: number;
          totalOutput: number;
          totalCacheRead: number;
          hitSum: number;
          hitCount: number;
          failures: number;
        }
      >();

      for (const r of runs) {
        const name = r.model ?? "unknown";
        if (!agg.has(name)) {
          agg.set(name, {
            runs: 0,
            totalCost: 0,
            totalInput: 0,
            totalOutput: 0,
            totalCacheRead: 0,
            hitSum: 0,
            hitCount: 0,
            failures: 0,
          });
          order.push(name);
        }
        const t = agg.get(name)!;
        t.runs += 1;
        t.totalCost += r.costUsd ?? 0;
        t.totalInput += r.input ?? 0;
        t.totalOutput += r.output ?? 0;
        t.totalCacheRead += r.cacheRead ?? 0;
        const rate = resolveHitRate(r);
        t.hitSum += rate;
        t.hitCount += 1;
        if (typeof r.exitCode === "number" && r.exitCode !== 0) {
          t.failures += 1;
        }
      }

      const rows: ModelUsageRow[] = order.map((name) => {
        const t = agg.get(name)!;
        return {
          name,
          runs: t.runs,
          totalCost: t.totalCost,
          totalInput: t.totalInput,
          totalOutput: t.totalOutput,
          totalCacheRead: t.totalCacheRead,
          avgHitRate: t.hitCount > 0 ? t.hitSum / t.hitCount : 0,
          failures: t.failures,
        };
      });
      rows.sort((a, b) => b.totalCost - a.totalCost);
      setModels(rows);
    } catch {
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  // Load on mount and poll every 15s.
  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  // Total cost across all models (drives the cost-distribution chart).
  const totalCost = models.reduce((s, m) => s + m.totalCost, 0);

  const columns = [
    { key: "name", label: "Model" },
    { key: "runs", label: "Runs" },
    { key: "cost", label: "Total Cost" },
    { key: "input", label: "Total Input" },
    { key: "output", label: "Total Output" },
    { key: "cacheRead", label: "Cache Read" },
    { key: "hitRate", label: "Avg Hit Rate" },
    { key: "failures", label: "Failures" },
  ];

  const rows = models.map((m) => ({
    name: (
      <span className="font-mono text-sm text-slate-800 dark:text-slate-200">
        {m.name}
      </span>
    ),
    runs: (
      <span className="text-sm text-slate-600 dark:text-slate-300">{m.runs}</span>
    ),
    cost: (
      <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {formatCost(m.totalCost)}
      </span>
    ),
    input: (
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {formatTokens(m.totalInput)}
      </span>
    ),
    output: (
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {formatTokens(m.totalOutput)}
      </span>
    ),
    cacheRead: (
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {formatTokens(m.totalCacheRead)}
      </span>
    ),
    hitRate: (
      <Badge color={hitRateColor(m.avgHitRate)}>{formatPct(m.avgHitRate)}</Badge>
    ),
    failures: (
      <span
        className={
          m.failures > 0
            ? "text-sm font-medium text-red-600 dark:text-red-400"
            : "text-sm text-slate-600 dark:text-slate-300"
        }
      >
        {m.failures}
      </span>
    ),
  }));

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Cpu" size={20} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Model Usage
        </h3>
        {loading ? (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
            Loading...
          </span>
        ) : (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
            {models.length} model{models.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {loading ? (
        <div className="h-32 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : models.length === 0 ? (
        <EmptyState icon="Cpu" message="No model usage data yet" />
      ) : (
        <div className="flex flex-col gap-6">
          {/* Sortable table (sorted by total cost desc) */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-slate-700 dark:text-slate-200">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 whitespace-nowrap"
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className="px-3 py-2 border-t border-slate-100 dark:border-slate-700"
                      >
                        {row[col.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cost distribution bar chart */}
          <div>
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
              Cost distribution by model
            </div>
            <div className="flex flex-col gap-2">
              {models.map((m, i) => {
                const pct =
                  totalCost > 0
                    ? (m.totalCost / totalCost) * 100
                    : 0;
                return (
                  <div key={m.name} className="flex items-center gap-2">
                    <div
                      className="w-40 shrink-0 truncate font-mono text-xs text-slate-600 dark:text-slate-300"
                      title={m.name}
                    >
                      {m.name}
                    </div>
                    <div className="flex-1 relative h-5 bg-slate-100 dark:bg-slate-700 rounded overflow-hidden">
                      <div
                        className={`h-full rounded ${
                          BAR_COLORS[i % BAR_COLORS.length]
                        }`}
                        style={{
                          width: `${Math.min(Math.max(pct, 0), 100)}%`,
                        }}
                      />
                    </div>
                    <div className="w-16 shrink-0 text-right text-xs font-medium text-slate-700 dark:text-slate-200">
                      {formatCost(m.totalCost)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default ModelUsageStats;
