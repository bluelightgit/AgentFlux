/**
 * D1-4: Cache Performance — cache 命中率趋势 + token 构成饼图
 */
import React from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from "recharts";
import { useDashboardStore } from "../store/dashboard-store";

import { formatTime, formatTokens } from "../lib/format";
export const CacheChart: React.FC = () => {
  const cacheTrend = useDashboardStore((s) => s.cacheTrend);
  const tokenBreakdown = useDashboardStore((s) => s.tokenBreakdown);
  const timeRange = useDashboardStore((s) => s.timeRange);

  const lineData = cacheTrend.map((c) => ({
    ts: c.ts,
    hitRate: Number((c.hitRate * 100).toFixed(1)),
    turn: c.turnIndex,
  }));

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow p-6 border border-slate-200 dark:border-slate-700">
      <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-200 mb-4">Cache Performance</h3>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Hit Rate Line Chart */}
        <div className="lg:col-span-2">
          {lineData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-slate-400">No cache data in {timeRange}</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={lineData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={formatTime}
                  tick={{ fontSize: 10, fill: "#64748b" }}
                />
                <YAxis
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 10, fill: "#64748b" }}
                />
                <Tooltip
                  labelFormatter={formatTime}
                  formatter={(v: number) => [`${v}%`, "Hit Rate"]}
                />
                <Line
                  type="monotone"
                  dataKey="hitRate"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Token Breakdown Pie */}
        <div>
          {tokenBreakdown.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-slate-400">No tokens</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={tokenBreakdown}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  label={(e: any) => `${e.name}: ${formatTokens(e.value)}`}
                  labelLine={false}
                >
                  {tokenBreakdown.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => formatTokens(v)} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
};
