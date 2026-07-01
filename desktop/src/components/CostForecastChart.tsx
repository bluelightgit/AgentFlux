/**
 * Cost Forecast — projects future costs based on current trends using simple
 * linear regression over daily subagent.run cost totals.
 *
 * Reads subagent.run events from events.jsonl, groups them by day, sums
 * costUsd per day, then fits a least-squares line through the daily costs to
 * project the next 7 days. The chart shows the last 14 days of actual daily
 * cost plus the 7-day projected forecast.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
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
import { formatCost } from "../lib/format";

/** A single point on the forecast chart. */
interface ForecastPoint {
  label: string;
  actual: number | null;
  projected: number | null;
}

/** Aggregate stats derived from the regression fit. */
interface ForecastStats {
  dailyAvg: number;
  weeklyProjection: number;
  monthlyProjection: number;
}

/** Recharts passes the active payload entry to custom tooltips. */
interface TooltipEntry {
  payload: ForecastPoint;
}

function ForecastTooltip({
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
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow px-3 py-2 text-xs">
      <div className="text-slate-500 dark:text-slate-400">{label}</div>
      {point.actual != null ? (
        <div className="mt-1 font-semibold text-blue-600 dark:text-blue-300">
          Actual: {formatCost(point.actual)}
        </div>
      ) : null}
      {point.projected != null ? (
        <div className="mt-1 font-semibold text-amber-600 dark:text-amber-300">
          Projected: {formatCost(point.projected)}
        </div>
      ) : null}
    </div>
  );
}

/** Format a day-key (ms epoch at local midnight) as a short date label. */
function dayLabel(dayMs: number): string {
  return new Date(dayMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** Convert a timestamp to its local-midnight day key (ms epoch). */
function toDayKey(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 86_400_000;

/**
 * Compute the least-squares regression line for the given (x, y) points.
 * Returns { slope, intercept }. If the fit is degenerate (e.g. all x equal),
 * slope = 0 and intercept = mean(y).
 */
function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number } {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export function CostForecastChart(): React.ReactElement {
  const project = useDashboardStore((s) => s.project);
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [forecastData, setForecastData] = useState<ForecastPoint[]>([]);
  const [stats, setStats] = useState<ForecastStats>({
    dailyAvg: 0,
    weeklyProjection: 0,
    monthlyProjection: 0,
  });
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!project) {
      setForecastData([]);
      setStats({ dailyAvg: 0, weeklyProjection: 0, monthlyProjection: 0 });
      setLoading(false);
      return;
    }
    try {
      const filePath = `${project.fluxDir}/events.jsonl`;
      const events = await parseEventsFileAsync(filePath);
      const runs = filterByType(events, "subagent.run") as SubagentRunEvent[];

      // Group by day and sum costUsd per day.
      const byDay = new Map<number, number>();
      for (const r of runs) {
        if (!r.ts || !isFinite(r.costUsd)) continue;
        const key = toDayKey(r.ts);
        byDay.set(key, (byDay.get(key) ?? 0) + r.costUsd);
      }

      // Sort ascending by day and fill gaps so the regression sees continuous days.
      const dayKeys = Array.from(byDay.keys()).sort((a, b) => a - b);
      if (dayKeys.length < 2) {
        setForecastData([]);
        setStats({ dailyAvg: 0, weeklyProjection: 0, monthlyProjection: 0 });
        setLoading(false);
        return;
      }

      const firstDay = dayKeys[0];
      const lastDay = dayKeys[dayKeys.length - 1];
      const continuousDays: number[] = [];
      for (let d = firstDay; d <= lastDay; d += DAY_MS) {
        continuousDays.push(d);
      }

      // Daily cost series (0 for days with no events). x is the day index.
      const xs: number[] = continuousDays.map((_, i) => i);
      const ys: number[] = continuousDays.map(
        (d) => Number((byDay.get(d) ?? 0).toFixed(6)),
      );

      const { slope, intercept } = linearRegression(xs, ys);

      // Last 14 days of actual data (or fewer if we have less).
      const actualCount = Math.min(14, continuousDays.length);
      const actualStartIdx = continuousDays.length - actualCount;

      const points: ForecastPoint[] = [];

      // Actual daily costs for the visible window.
      for (let i = actualStartIdx; i < continuousDays.length; i++) {
        const day = continuousDays[i];
        const isLast = i === continuousDays.length - 1;
        points.push({
          label: dayLabel(day),
          actual: ys[i],
          // Bridge the projected line onto the last actual point so the
          // dashed segment visually connects to the solid segment.
          projected: isLast ? Number((intercept + slope * i).toFixed(6)) : null,
        });
      }

      // Projected next 7 days.
      const n = continuousDays.length;
      for (let i = 0; i < 7; i++) {
        const xIdx = n + i;
        const day = lastDay + (i + 1) * DAY_MS;
        points.push({
          label: dayLabel(day),
          actual: null,
          projected: Number((intercept + slope * xIdx).toFixed(6)),
        });
      }

      // Stats: daily average from actuals; weekly/monthly from regression.
      const dailyAvg = ys.reduce((a, b) => a + b, 0) / ys.length;
      let weeklySum = 0;
      for (let i = 0; i < 7; i++) {
        weeklySum += intercept + slope * (n + i);
      }
      let monthlySum = 0;
      for (let i = 0; i < 30; i++) {
        monthlySum += intercept + slope * (n + i);
      }

      setForecastData(points);
      setStats({
        dailyAvg: Number(dailyAvg.toFixed(6)),
        weeklyProjection: Number(weeklySum.toFixed(6)),
        monthlyProjection: Number(monthlySum.toFixed(6)),
      });
    } catch {
      setForecastData([]);
      setStats({ dailyAvg: 0, weeklyProjection: 0, monthlyProjection: 0 });
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const gridStroke = isDark ? "#334155" : "#e2e8f0";
  const axisTickFill = isDark ? "#94a3b8" : "#64748b";

  const manyLabels = forecastData.length > 12;

  const statCards = useMemo(
    () => [
      { label: "Daily Avg", value: formatCost(stats.dailyAvg) },
      { label: "Weekly Projection", value: formatCost(stats.weeklyProjection) },
      { label: "Monthly Projection", value: formatCost(stats.monthlyProjection) },
    ],
    [stats],
  );

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon name="TrendingUp" size={20} className="text-amber-500" />
        <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-200">
          Cost Forecast
        </h3>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : forecastData.length === 0 ? (
        <EmptyState
          icon="TrendingUp"
          message="Need at least 2 days of data for forecast"
        />
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart
            data={forecastData}
            margin={{
              top: 5,
              right: 20,
              bottom: manyLabels ? 50 : 5,
              left: 10,
            }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: axisTickFill }}
              angle={manyLabels ? -45 : 0}
              textAnchor={manyLabels ? "end" : "middle"}
              height={manyLabels ? 60 : 30}
              interval={0}
            />
            <YAxis
              tickFormatter={(v) => formatCost(Number(v))}
              tick={{ fontSize: 10, fill: axisTickFill }}
              width={70}
            />
            <Tooltip content={<ForecastTooltip />} />
            <Legend />
            <Line
              type="monotone"
              dataKey="actual"
              name="Actual"
              stroke="#3b82f6"
              strokeWidth={2}
              dot
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="projected"
              name="Projected"
              stroke="#f59e0b"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Stat cards */}
      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        {statCards.map((s) => (
          <div
            key={s.label}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2"
          >
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {s.label}
            </div>
            <div className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">
              {s.value}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
