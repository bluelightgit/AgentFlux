/**
 * Agent Timeline — agent 执行历史列表
 */
import React from "react";
import { useDashboardStore } from "../store/dashboard-store";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatCost(c: number): string {
  if (c === 0) return "$0";
  if (c < 0.001) return `$${c.toExponential(2)}`;
  return `$${c.toFixed(6)}`;
}

const statusIcon = (exitCode: number, retryCount?: number): string => {
  if (exitCode === 0 && (!retryCount || retryCount === 0)) return "✅";
  if (exitCode === 0 && retryCount && retryCount > 0) return "🔄";
  return "❌";
};

export const AgentTimeline: React.FC = () => {
  const agentTimeline = useDashboardStore((s) => s.agentTimeline);
  const timeRange = useDashboardStore((s) => s.timeRange);

  // Show last 20 entries
  const recent = agentTimeline.slice(-20).reverse();

  return (
    <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
      <h3 className="text-lg font-semibold text-slate-700 mb-4">Agent Timeline</h3>
      {recent.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-slate-400">No agent runs in {timeRange}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th className="py-2 px-2">Time</th>
                <th className="py-2 px-2">Agent</th>
                <th className="py-2 px-2">Model</th>
                <th className="py-2 px-2 text-right">Turns</th>
                <th className="py-2 px-2 text-right">Cache</th>
                <th className="py-2 px-2 text-right">Cost</th>
                <th className="py-2 px-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((a, i) => (
                <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-1.5 px-2 text-slate-500 text-xs">{formatTime(a.ts)}</td>
                  <td className="py-1.5 px-2 font-medium text-slate-700">{a.agent}</td>
                  <td className="py-1.5 px-2 text-slate-500 text-xs">{a.model}</td>
                  <td className="py-1.5 px-2 text-right text-slate-600">{a.turns}</td>
                  <td className="py-1.5 px-2 text-right text-slate-600">{(a.cacheHitRate * 100).toFixed(0)}%</td>
                  <td className="py-1.5 px-2 text-right text-slate-600">{formatCost(a.cost)}</td>
                  <td className="py-1.5 px-2">{statusIcon(a.exitCode, a.retryCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
