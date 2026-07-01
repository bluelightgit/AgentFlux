/**
 * AgentPerformanceTable
 * Compares agents side by side using key telemetry metrics aggregated
 * from `subagent.run` events. Loads on mount and polls every 10 seconds.
 */
import React, { useEffect, useState } from "react";
import { Card, DataTable, Badge, Icon, EmptyState } from "./ui";
import { formatCost, formatPct, formatTokens } from "../lib/format";
import { parseEventsFileAsync, type SubagentRunEvent } from "../lib/events-parser";
import { useDashboardStore } from "../store/dashboard-store";

/** Per-agent aggregated performance metrics. */
interface AgentPerfRow {
  name: string;
  runs: number;
  totalCost: number;
  avgHitRate: number;
  avgTurns: number;
  totalInput: number;
  totalCacheRead: number;
  successes: number;
  failures: number;
  successRate: number;
}

/** Cache-hit color thresholds (ratio is 0..1). */
function hitRateColor(ratio: number): "green" | "amber" | "red" {
  if (ratio >= 0.7) return "green";
  if (ratio >= 0.4) return "amber";
  return "red";
}

/** Success-rate color thresholds (ratio is 0..1). */
function successRateColor(ratio: number): "green" | "amber" | "red" {
  if (ratio >= 0.9) return "green";
  if (ratio >= 0.7) return "amber";
  return "red";
}

/** Aggregate raw subagent.run events into per-agent rows. */
function aggregateRows(events: SubagentRunEvent[]): AgentPerfRow[] {
  const byName = new Map<string, AgentPerfRow>();

  for (const e of events) {
    const name = e.agent || "unknown";
    let row = byName.get(name);
    if (!row) {
      row = {
        name,
        runs: 0,
        totalCost: 0,
        avgHitRate: 0,
        avgTurns: 0,
        totalInput: 0,
        totalCacheRead: 0,
        successes: 0,
        failures: 0,
        successRate: 0,
      };
      byName.set(name, row);
    }

    row.runs += 1;
    row.totalCost += e.costUsd ?? 0;
    row.totalInput += e.input ?? 0;
    row.totalCacheRead += e.cacheRead ?? 0;

    // exitCode 0 == success; anything else is a failure.
    if (e.exitCode === 0) {
      row.successes += 1;
    } else {
      row.failures += 1;
    }

    // Accumulate hit-rate and turns as running sums; finalize below.
    row.avgHitRate += e.cacheHitRate ?? 0;
    row.avgTurns += e.turns ?? 0;
  }

  // Finalize averages and derived rates.
  const rows: AgentPerfRow[] = [];
  for (const r of byName.values()) {
    const runs = r.runs > 0 ? r.runs : 1;
    r.avgHitRate = r.avgHitRate / runs;
    r.avgTurns = r.avgTurns / runs;
    r.successRate = r.runs > 0 ? r.successes / r.runs : 0;
    rows.push(r);
  }

  // Sort by total cost descending.
  rows.sort((a, b) => b.totalCost - a.totalCost);
  return rows;
}

export function AgentPerformanceTable(): React.ReactElement {
  const project = useDashboardStore((s) => s.project);
  const eventsPath = project?.eventsPath ?? null;

  const [rows, setRows] = useState<AgentPerfRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!eventsPath) {
      setRows([]);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const all = await parseEventsFileAsync(eventsPath);
        if (cancelled) return;
        const subagentEvents = all.filter(
          (e): e is SubagentRunEvent => e.type === "subagent.run",
        );
        setRows(aggregateRows(subagentEvents));
      } catch (err) {
        if (!cancelled) {
          console.warn("[flux] agent performance load failed:", err);
          setRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    load();

    // Poll every 10 seconds for fresh telemetry.
    const timer = setInterval(load, 10_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [eventsPath]);

  const columns = [
    { key: "agent", label: "Agent" },
    { key: "runs", label: "Runs" },
    { key: "successRate", label: "Success Rate" },
    { key: "avgHit", label: "Avg Cache Hit" },
    { key: "avgTurns", label: "Avg Turns" },
    { key: "totalCost", label: "Total Cost" },
    { key: "totalInput", label: "Total Input" },
    { key: "totalCacheRead", label: "Total Cache Read" },
    { key: "failures", label: "Failures" },
  ];

  const tableRows = rows.map((r) => ({
    agent: (
      <span className="font-medium text-slate-800 dark:text-slate-100">
        {r.name}
      </span>
    ),
    runs: <span className="text-slate-700 dark:text-slate-200">{r.runs}</span>,
    successRate: (
      <Badge color={successRateColor(r.successRate)}>
        {formatPct(r.successRate)}
      </Badge>
    ),
    avgHit: (
      <Badge color={hitRateColor(r.avgHitRate)}>
        {formatPct(r.avgHitRate)}
      </Badge>
    ),
    avgTurns: (
      <span className="text-slate-700 dark:text-slate-200">
        {r.avgTurns.toFixed(1)}
      </span>
    ),
    totalCost: (
      <span className="font-mono text-slate-800 dark:text-slate-100">
        {formatCost(r.totalCost)}
      </span>
    ),
    totalInput: (
      <span className="text-slate-600 dark:text-slate-300">
        {formatTokens(r.totalInput)}
      </span>
    ),
    totalCacheRead: (
      <span className="text-slate-600 dark:text-slate-300">
        {formatTokens(r.totalCacheRead)}
      </span>
    ),
    failures: (
      <span
        className={
          r.failures > 0
            ? "text-red-600 dark:text-red-400 font-medium"
            : "text-slate-500 dark:text-slate-400"
        }
      >
        {r.failures}
      </span>
    ),
  }));

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-800 dark:text-slate-200">
          <Icon name="BarChart3" size={20} className="text-slate-500 dark:text-slate-400" />
          Agent Performance
        </h3>
        {loading ? (
          <Badge color="slate">loading</Badge>
        ) : (
          <Badge color="slate">{rows.length} agents</Badge>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="BarChart3"
          message="No agent performance data yet"
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <DataTable columns={columns} rows={tableRows} />
        </div>
      )}
    </Card>
  );
}

export default AgentPerformanceTable;
