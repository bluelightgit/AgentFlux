/**
 * D1-5: Cost Analysis — 按模式/模型/任务类型三维成本分解
 */
import React from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import { useDashboardStore } from "../store/dashboard-store";

const MODE_COLORS: Record<string, string> = {
  M1: "#3b82f6", M2: "#10b981", M3: "#f59e0b", M4: "#8b5cf6", M5: "#ec4899", M6: "#ef4444",
  subagent: "#64748b",
};

import { formatCost } from "../lib/format";

export const CostBreakdown: React.FC = () => {
  const costAnalysis = useDashboardStore((s) => s.costAnalysis);
  const timeRange = useDashboardStore((s) => s.timeRange);

  const hasData = costAnalysis.total > 0;

  return (
    <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-700">Cost Analysis</h3>
        {hasData && (
          <div className="text-right">
            <div className="text-2xl font-bold text-slate-800">{formatCost(costAnalysis.total)}</div>
            <div className="text-xs text-slate-500">avg {formatCost(costAnalysis.avgPerTurn)}/turn</div>
          </div>
        )}
      </div>

      {!hasData ? (
        <div className="h-48 flex items-center justify-center text-slate-400">No cost data in {timeRange}</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* By Mode */}
          <div>
            <h4 className="text-sm font-medium text-slate-600 mb-2">By Mode</h4>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={costAnalysis.byMode} layout="horizontal" margin={{ top: 5, right: 10, bottom: 5, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="mode" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis tickFormatter={(v) => formatCost(v)} tick={{ fontSize: 10, fill: "#64748b" }} width={70} />
                <Tooltip formatter={(v: number) => formatCost(v)} />
                <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                  {costAnalysis.byMode.map((entry, i) => (
                    <Cell key={i} fill={MODE_COLORS[entry.mode] ?? "#94a3b8"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* By Model */}
          <div>
            <h4 className="text-sm font-medium text-slate-600 mb-2">By Model</h4>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={costAnalysis.byModel} layout="horizontal" margin={{ top: 5, right: 10, bottom: 5, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="model" tick={{ fontSize: 10, fill: "#64748b" }} interval={0} angle={-15} textAnchor="end" height={50} />
                <YAxis tickFormatter={(v) => formatCost(v)} tick={{ fontSize: 10, fill: "#64748b" }} width={70} />
                <Tooltip formatter={(v: number) => formatCost(v)} />
                <Bar dataKey="cost" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
};
