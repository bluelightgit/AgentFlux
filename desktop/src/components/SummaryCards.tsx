/**
 * Summary Cards — 顶部汇总指标卡片
 */
import React from "react";
import { useDashboardStore } from "../store/dashboard-store";

import { formatCost, formatNum } from "../lib/format";

export const SummaryCards: React.FC = () => {
  const summary = useDashboardStore((s) => s.summary);

  if (!summary) return null;

  const cards = [
    { label: "Total Events", value: formatNum(summary.totalEvents), color: "text-blue-600", bg: "bg-blue-50" },
    { label: "Total Cost", value: formatCost(summary.totalCost), color: "text-green-600", bg: "bg-green-50" },
    { label: "Avg Cache Hit", value: `${(summary.avgCacheHit * 100).toFixed(1)}%`, color: "text-purple-600", bg: "bg-purple-50" },
    { label: "Routing Decisions", value: `${summary.routingDecisions}`, color: "text-amber-600", bg: "bg-amber-50" },
    { label: "Subagent Runs", value: `${summary.subagentRuns}`, color: "text-pink-600", bg: "bg-pink-50" },
    { label: "Cache Samples", value: `${summary.cacheSamples}`, color: "text-indigo-600", bg: "bg-indigo-50" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c, i) => (
        <div key={i} className={`${c.bg} rounded-lg p-4 border border-slate-200`}>
          <div className="text-xs text-slate-500 mb-1">{c.label}</div>
          <div className={`text-xl font-bold ${c.color}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
};
