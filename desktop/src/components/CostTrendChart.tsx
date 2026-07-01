/**
 * Cost Trend — cumulative cost accumulation over time across all agents.
 * Reads subagent.run events from events.jsonl, sorts by timestamp, and
 * plots the running total as a line chart with a per-agent breakdown tooltip.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFile,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { useTheme } from "./ThemeProvider";
import { Card, Icon } from "./ui";
import { formatCost, formatTs } from "../lib/format";

/** A single point on the cost-trend line. */
interface CostPoint {
  ts: number;
  time: string;
  cost: number;
  cumulative: number;
  agent: string;
  /** Running per-agent totals at this point in time. */
  perAgent: Record<string, number>;
}

/** Recharts passes the active payload entry to custom tooltips. */
interface TooltipEntry {
  payload: CostPoint;
}

function CostTrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const perAgent = point?.perAgent ?? {};
  const agents = Object.keys(perAgent).sort();

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow px-3 py-2 text-xs">
      <div className="text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 font-semibold text-slate-800 dark:text-slate-100">
        Cumulative: {point ? formatCost(point.cumulative) : "-"}
      </div>
      {agents.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          <div className="text-slate-400 dark:text-slate-500">Per agent:</div>
          {agents.map((a) => (
            <div key={a} className="flex justify-between gap-4 text-slate-600 dark:text-slate-300">
              <span>{a}</span>
              <span>{formatCost(perAgent[a])}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CostTrendChart(): React.ReactElement {
  const project = useDashboardStore((s) => s.project);
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [data, setData] = useState<CostPoint[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!project) {
      setData([]);
      setLoading(false);
      return;
    }
    try {
      const filePath = `${project.fluxDir}/events.jsonl`;
      const events = await parseEventsFile(filePath);
      const runs = filterByType(events, "subagent.run") as SubagentRunEvent[];
      runs.sort((a, b) => a.ts - b.ts);

      let cumulative = 0;
      const perAgentTotals: Record<string, number> = {};
      const points: CostPoint[] = runs.map((r) => {
        cumulative += r.costUsd;
        perAgentTotals[r.agent] = (perAgentTotals[r.agent] ?? 0) + r.costUsd;
        return {
          ts: r.ts,
          time: formatTs(r.ts),
          cost: r.costUsd,
          cumulative: Number(cumulative.toFixed(6)),
          agent: r.agent,
          perAgent: { ...perAgentTotals },
        };
      });
      setData(points);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  // Show only the last 50 points when there are many.
  const displayed = useMemo(
    () => (data.length > 50 ? data.slice(-50) : data),
    [data],
  );
  const manyPoints = displayed.length > 12;

  const gridStroke = isDark ? "#334155" : "#e2e8f0";
  const axisTickFill = isDark ? "#94a3b8" : "#64748b";

  const totalCost = data.length > 0 ? data[data.length - 1].cumulative : 0;
  const agentCount = useMemo(
    () => new Set(data.map((d) => d.agent)).size,
    [data],
  );
  const runCount = data.length;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon name="TrendingUp" size={20} className="text-blue-500" />
        <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-200">
          Cost Trend
        </h3>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : displayed.length === 0 ? (
        <div className="h-64 flex items-center justify-center text-slate-400 dark:text-slate-500">
          No cost data
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart
            data={displayed}
            margin={{ top: 5, right: 20, bottom: manyPoints ? 50 : 5, left: 10 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: axisTickFill }}
              angle={manyPoints ? -45 : 0}
              textAnchor={manyPoints ? "end" : "middle"}
              height={manyPoints ? 60 : 30}
              interval={0}
            />
            <YAxis
              tickFormatter={(v) => formatCost(Number(v))}
              tick={{ fontSize: 10, fill: axisTickFill }}
              width={70}
            />
            <Tooltip content={<CostTrendTooltip />} />
            <Line
              type="monotone"
              dataKey="cumulative"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Summary row */}
      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Total Cost</div>
          <div className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">
            {formatCost(totalCost)}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Agent Count</div>
          <div className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">
            {agentCount}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Run Count</div>
          <div className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">
            {runCount}
          </div>
        </div>
      </div>
    </Card>
  );
}
