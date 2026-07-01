/**
 * Budget Trend — cumulative budget usage over time against a user-defined
 * limit line.
 *
 * Reads `subagent.run` events from `${fluxDir}/events.jsonl`, groups them
 * by calendar day, and plots the running cumulative cost as a line chart.
 * A red dashed ReferenceLine marks the user-defined budget limit so it is
 * easy to see when spend crosses the threshold.
 *
 * Polls events.jsonl every 30s for near-real-time updates.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFileAsync,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { useTheme } from "./ThemeProvider";
import { Card, Icon, EmptyState } from "./ui";
import { formatCost, formatPct } from "../lib/format";

/** Polling interval for re-reading events.jsonl. */
const POLL_INTERVAL_MS = 30_000;

/** Default budget limit (USD) shown in the input on first load. */
const DEFAULT_BUDGET_LIMIT = 1.0;

/** A single day bucket on the budget-trend line. */
interface BudgetPoint {
  date: string;
  cumulativeCost: number;
}

/** Recharts passes the active payload entry to custom tooltips. */
interface TooltipEntry {
  payload: BudgetPoint;
}

/** Format a millisecond epoch as a short calendar date (YYYY-MM-DD). */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function BudgetTrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
}): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  if (!point) return null;

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow px-3 py-2 text-xs">
      <div className="text-slate-500 dark:text-slate-400">{point.date}</div>
      <div className="mt-1 font-semibold text-slate-800 dark:text-slate-100">
        Cumulative: {formatCost(point.cumulativeCost)}
      </div>
    </div>
  );
}

/** Tailwind text color class for the utilization stat, by threshold band. */
function utilizationColorClass(fraction: number): string {
  if (fraction >= 0.8) return "text-red-600 dark:text-red-400";
  if (fraction >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-green-600 dark:text-green-400";
}

export function BudgetTrendChart(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [data, setData] = useState<BudgetPoint[]>([]);
  const [budgetLimit, setBudgetLimit] = useState<number>(DEFAULT_BUDGET_LIMIT);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setData([]);
      setLoading(false);
      return;
    }
    try {
      const events = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
      const runs = filterByType(events, "subagent.run") as SubagentRunEvent[];

      // Group cost by calendar day, preserving chronological order.
      const byDay = new Map<string, number>();
      for (const r of runs) {
        if (r.ts == null || !Number.isFinite(r.costUsd)) continue;
        const key = dayKey(r.ts);
        byDay.set(key, (byDay.get(key) ?? 0) + r.costUsd);
      }

      const sortedDays = Array.from(byDay.keys()).sort();
      let cumulative = 0;
      const points: BudgetPoint[] = sortedDays.map((day) => {
        cumulative += byDay.get(day) ?? 0;
        return {
          date: day,
          cumulativeCost: Number(cumulative.toFixed(6)),
        };
      });
      setData(points);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  const currentSpend = useMemo(
    () => (data.length > 0 ? data[data.length - 1].cumulativeCost : 0),
    [data],
  );
  const budgetRemaining = budgetLimit - currentSpend;
  const utilization = budgetLimit > 0 ? currentSpend / budgetLimit : 0;

  const gridStroke = isDark ? "#334155" : "#e2e8f0";
  const axisTickFill = isDark ? "#94a3b8" : "#64748b";

  const statCardClass =
    "rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-4 py-3";

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Wallet" size={20} className="text-blue-500" />
        <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-200">
          Budget Trend
        </h3>
        <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
          {loading ? "Loading..." : "Updated"}
        </span>
      </div>

      {/* Budget limit input */}
      <div className="flex flex-col gap-1 mb-4">
        <label
          htmlFor="agentflux-budget-trend-limit"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          Budget Limit ($)
        </label>
        <input
          id="agentflux-budget-trend-limit"
          type="number"
          min={0}
          step={0.1}
          value={budgetLimit}
          onChange={(e) => {
            const n = Number(e.target.value);
            setBudgetLimit(Number.isFinite(n) && n >= 0 ? n : 0);
          }}
          className="w-40 rounded-lg bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Chart or empty state */}
      {loading ? (
        <div className="h-[250px] flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : data.length === 0 ? (
        <EmptyState icon="Wallet" message="No cost data yet" />
      ) : (
        <ResponsiveContainer width="100%" height={250}>
          <LineChart
            data={data}
            margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: axisTickFill }}
            />
            <YAxis
              tickFormatter={(v) => formatCost(Number(v))}
              tick={{ fontSize: 10, fill: axisTickFill }}
              width={70}
            />
            <Tooltip content={<BudgetTrendTooltip />} />
            <ReferenceLine
              y={budgetLimit}
              stroke="#ef4444"
              strokeDasharray="5 5"
              label="Budget Limit"
            />
            <Line
              type="monotone"
              dataKey="cumulativeCost"
              stroke="#3b82f6"
              strokeWidth={2}
              dot
            />
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Stat cards */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className={statCardClass}>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Current Spend
          </div>
          <div className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">
            {formatCost(currentSpend)}
          </div>
        </div>
        <div className={statCardClass}>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Budget Remaining
          </div>
          <div
            className={`mt-1 text-lg font-bold ${
              budgetRemaining < 0
                ? "text-red-600 dark:text-red-400"
                : "text-slate-800 dark:text-slate-100"
            }`}
          >
            {formatCost(budgetRemaining)}
          </div>
        </div>
        <div className={statCardClass}>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Budget Utilization
          </div>
          <div
            className={`mt-1 text-lg font-bold ${utilizationColorClass(utilization)}`}
          >
            {formatPct(utilization)}
          </div>
        </div>
      </div>
    </Card>
  );
}

export default BudgetTrendChart;
