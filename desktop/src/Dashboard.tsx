/**
 * D1-3/4/5/6: Dashboard 主页面
 * 整合 RouteMap, CacheChart, CostBreakdown, AgentTimeline
 */
import React, { useEffect } from "react";
import { useDashboardStore, type TimeRange } from "./store/dashboard-store";
import { SummaryCards } from "./components/SummaryCards";
import { RouteMap } from "./components/RouteMap";
import { CacheChart } from "./components/CacheChart";
import { CostBreakdown } from "./components/CostBreakdown";
import { AgentTimeline } from "./components/AgentTimeline";

const TIME_RANGES: TimeRange[] = ["1h", "24h", "7d", "30d", "all"];

const Dashboard: React.FC = () => {
  const init = useDashboardStore((s) => s.init);
  const timeRange = useDashboardStore((s) => s.timeRange);
  const setTimeRange = useDashboardStore((s) => s.setTimeRange);
  const autoRefresh = useDashboardStore((s) => s.autoRefresh);
  const setAutoRefresh = useDashboardStore((s) => s.setAutoRefresh);
  const loading = useDashboardStore((s) => s.loading);
  const error = useDashboardStore((s) => s.error);
  const project = useDashboardStore((s) => s.project);

  useEffect(() => {
    init();
  }, [init]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">AgentFlux Dashboard</h1>
          {project && (
            <p className="text-sm text-slate-500 mt-1">
              {project.projectName} · {project.eventsPath}
            </p>
          )}
        </div>

        <div className="flex items-center gap-4">
          {/* Auto-refresh toggle */}
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh
          </label>

          {/* Time range selector */}
          <div className="flex bg-white rounded-lg border border-slate-200 overflow-hidden">
            {TIME_RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  timeRange === r
                    ? "bg-blue-600 text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-center py-8 text-slate-500">Loading events...</div>
      )}

      {/* Content */}
      {!loading && !error && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <SummaryCards />

          {/* Route Map + Cache Chart */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <RouteMap />
            <CacheChart />
          </div>

          {/* Cost Breakdown */}
          <CostBreakdown />

          {/* Agent Timeline */}
          <AgentTimeline />
        </div>
      )}
    </div>
  );
};

export default Dashboard;
