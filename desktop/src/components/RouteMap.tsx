/**
 * D1-3: Route Map — 路由历史时间轴
 * 使用 Recharts ScatterChart 展示模式选择历史
 */
import React from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { useDashboardStore } from "../store/dashboard-store";

const MODE_ORDER = ["M1", "M2", "M3", "M4", "M5", "M6"];
const MODE_COLORS: Record<string, string> = {
  M1: "#3b82f6", M2: "#10b981", M3: "#f59e0b", M4: "#8b5cf6", M5: "#ec4899", M6: "#ef4444",
};

interface RoutePoint {
  ts: number;
  mode: string;
  modeIndex: number;
  confidence: number;
  preset: string;
  reason: string;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

const RouteTooltip: React.FC<{ active?: boolean; payload?: any[] }> = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as RoutePoint;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs max-w-xs">
      <div className="font-semibold text-slate-800">{d.mode} · conf {(d.confidence * 100).toFixed(0)}%</div>
      <div className="text-slate-500 mt-1">{formatTime(d.ts)}</div>
      <div className="text-slate-600 mt-1">preset: {d.preset}</div>
      <div className="text-slate-500 mt-1 break-words">{d.reason}</div>
    </div>
  );
};

export const RouteMap: React.FC = () => {
  const routeHistory = useDashboardStore((s) => s.routeHistory);
  const timeRange = useDashboardStore((s) => s.timeRange);

  const data: RoutePoint[] = routeHistory.map((r) => ({
    ts: r.ts,
    mode: r.mode,
    modeIndex: MODE_ORDER.indexOf(r.mode),
    confidence: r.confidence,
    preset: r.preset,
    reason: r.reason,
  }));

  const groups = Object.entries(
    data.reduce((acc, d) => {
      (acc[d.mode] ??= []).push(d);
      return acc;
    }, {} as Record<string, RoutePoint[]>),
  );

  return (
    <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
      <h3 className="text-lg font-semibold text-slate-700 mb-4">Route History</h3>
      {data.length === 0 ? (
        <div className="h-64 flex items-center justify-center text-slate-400">No routing decisions in {timeRange}</div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              type="number"
              dataKey="ts"
              domain={["dataMin", "dataMax"]}
              tickFormatter={formatTime}
              tick={{ fontSize: 11, fill: "#64748b" }}
              name="Time"
            />
            <YAxis
              type="number"
              dataKey="modeIndex"
              domain={[-0.5, 5.5]}
              ticks={[0, 1, 2, 3, 4, 5]}
              tickFormatter={(v) => MODE_ORDER[v] ?? ""}
              tick={{ fontSize: 12, fill: "#64748b" }}
              name="Mode"
            />
            <ZAxis type="number" dataKey="confidence" range={[60, 400]} name="Confidence" />
            <Tooltip content={<RouteTooltip />} />
            <Legend />
            {groups.map(([mode, points]) => (
              <Scatter key={mode} name={mode} data={points} fill={MODE_COLORS[mode] ?? "#94a3b8"} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      )}
    </div>
  );
};
