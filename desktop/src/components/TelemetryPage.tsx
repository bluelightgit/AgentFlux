import React from 'react';
import { useDashboardStore, type TimeRange } from '../store/dashboard-store';
import { Card, Icon, EmptyState } from './ui';
import { CacheEfficiency } from './CacheEfficiency';
import { CostBreakdown } from './CostBreakdown';
import { CacheChart } from './CacheChart';
import { EventStream } from './EventStream';

const TIME_RANGES: { id: TimeRange; label: string }[] = [
  { id: '1h', label: '1 Hour' },
  { id: '24h', label: '24 Hours' },
  { id: '7d', label: '7 Days' },
  { id: '30d', label: '30 Days' },
  { id: 'all', label: 'All Time' },
];

export const TelemetryPage: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const timeRange = useDashboardStore((s) => s.timeRange);
  const setTimeRange = useDashboardStore((s) => s.setTimeRange);
  const autoRefresh = useDashboardStore((s) => s.autoRefresh);
  const setAutoRefresh = useDashboardStore((s) => s.setAutoRefresh);
  const loading = useDashboardStore((s) => s.loading);
  const error = useDashboardStore((s) => s.error);

  if (!project) {
    return (
      <div className="p-6">
        <EmptyState
          icon="Activity"
          message="No project selected. Add a workspace to view telemetry."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold text-slate-800">Telemetry</h1>

        <div className="flex items-center gap-4">
          {/* Time range buttons */}
          <div className="flex gap-2">
            {TIME_RANGES.map((r) => {
              const active = timeRange === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setTimeRange(r.id)}
                  className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>

          {/* Auto-refresh toggle */}
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-slate-200 hover:bg-slate-50 ${
              autoRefresh ? 'text-blue-600' : 'text-slate-400'
            }`}
            title={autoRefresh ? 'Auto-refresh on' : 'Auto-refresh off'}
          >
            <Icon
              name="RefreshCw"
              size={16}
              className={autoRefresh ? 'animate-spin' : ''}
            />
            <span>Auto</span>
          </button>
        </div>
      </div>

      {/* Loading / error states */}
      {loading ? (
        <div className="text-slate-500 text-sm">Loading...</div>
      ) : null}
      {error ? (
        <div className="text-red-600 text-sm">{error}</div>
      ) : null}

      {/* Cache Efficiency */}
      <Card>
        <h2 className="text-lg font-bold text-slate-800 mb-4">Cache Efficiency</h2>
        <CacheEfficiency />
      </Card>

      {/* Cost Breakdown */}
      <Card>
        <h2 className="text-lg font-bold text-slate-800 mb-4">Cost Breakdown</h2>
        <CostBreakdown />
      </Card>

      {/* Cache Trend */}
      <Card>
        <h2 className="text-lg font-bold text-slate-800 mb-4">Cache Trend</h2>
        <CacheChart />
      </Card>

      {/* Event Stream */}
      <Card>
        <h2 className="text-lg font-bold text-slate-800 mb-4">Event Stream</h2>
        <EventStream />
      </Card>
    </div>
  );
};
