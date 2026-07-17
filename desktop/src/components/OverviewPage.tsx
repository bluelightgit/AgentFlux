/**
 * Overview Page — workspace-centric dashboard
 */
import React, { useEffect, useState } from 'react';
import { useDashboardStore } from '../store/dashboard-store';
import { Card, Icon, MetricCard, DataTable, Badge, EmptyState } from './ui';
import { SummaryCards } from './SummaryCards';
import { RouteMap } from './RouteMap';
import { InsightsCard, type InsightItem } from './InsightsCard';
import { generateInsights } from '../lib/insights-generator';
import { CostBudgetPanel } from './CostBudgetPanel';
import { SubsystemHealthPanel } from './SubsystemHealthPanel';
import { RecentFilesPanel } from './RecentFilesPanel';
import { ErrorLogPanel } from './ErrorLogPanel';
import { WorkflowStats } from './WorkflowStats';
import { ModelHealthDashboard } from './ModelHealthDashboard';
import { AgentActivityHeatmap } from './AgentActivityHeatmap';
import { CostForecastChart } from './CostForecastChart';
import { BudgetTrendChart } from './BudgetTrendChart';

/** Context link — navigates to a target page without full import. */
function contextLink(page: string, label: string): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => useDashboardStore.getState().setPage(page as any)}
      className="text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 underline underline-offset-2"
    >
      {label} →
    </button>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function confidenceBadge(conf: number): React.ReactElement {
  const pct = (conf * 100).toFixed(0);
  const color = conf >= 0.8 ? 'green' : conf >= 0.5 ? 'amber' : 'red';
  return <Badge color={color as any}>{pct}%</Badge>;
}

export const OverviewPage: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const events = useDashboardStore((s) => s.events);
  const activeWorkspace = useDashboardStore((s) => s.activeWorkspace);
  const agentStatus = useDashboardStore((s) => s.agentStatus);

  const [insights, setInsights] = useState<InsightItem[]>([]);

  useEffect(() => {
    const fluxDir = useDashboardStore.getState().project?.fluxDir;
    if (!fluxDir) return;
    generateInsights(fluxDir).then(setInsights);
    const interval = setInterval(() => generateInsights(fluxDir).then(setInsights), 10000);
    return () => clearInterval(interval);
  }, []);

  // If no project loaded, show empty state with add-workspace action
  if (!project) {
    const addWorkspacePath = useDashboardStore.getState().addWorkspacePath;

    let action: React.ReactNode;

    if (typeof window !== 'undefined' && window.api?.showFolderDialog) {
      // Electron: button that opens native folder dialog
      action = (
        <button
          type="button"
          onClick={async () => {
            const path = await window.api.showFolderDialog!();
            if (path) {
              await addWorkspacePath(path);
            }
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-blue-600 dark:hover:bg-blue-700"
        >
          <Icon name="Plus" size={16} />
          Add Workspace
        </button>
      );
    } else {
      // Non-Electron: read-only prompt — folder selection only available in desktop app
      action = (
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Folder selection is only available in the desktop app
          </span>
        </div>
      );
    }

    return (
      <div className="p-6">
        <EmptyState
          icon="FolderOpen"
          message="No project loaded. Select or add a workspace to get started."
          action={action}
        />
      </div>
    );
  }

  // Quick metric counts
  const totalEvents = events?.length || 0;
  const subagentRuns = (events || []).filter((e) => e.type === 'subagent.run').length;
  const routingDecisions = (events || []).filter((e) => e.type === 'routing.decision').length;
  const activeAgents = agentStatus?.persistentAgents?.length || 0;

  // Mode history rows (last 10 routing decisions, reversed to newest first)
  const routingEvents = (events || []).filter((e) => e.type === 'routing.decision');
  const modeHistoryRows = routingEvents
    .slice(-10)
    .reverse()
    .map((e: any) => ({
      time: <span className="text-xs text-slate-500 font-mono">{formatTime(e.ts)}</span>,
      mode: <Badge color="blue">{e.mode}</Badge>,
      preset: <span className="text-slate-600">{e.preset}</span>,
      confidence: confidenceBadge(e.confidence),
    }));

  const modeHistoryColumns = [
    { key: 'time', label: 'Time', width: '120px' },
    { key: 'mode', label: 'Mode', width: '100px' },
    { key: 'preset', label: 'Preset' },
    { key: 'confidence', label: 'Confidence', width: '120px' },
  ];

  return (
    <div className="space-y-6 p-6">
      {/* 1. Workspace Info Card */}
      <Card>
        {activeWorkspace ? (
          <div className="flex items-start gap-3">
            <Icon name="FolderOpen" size={24} className="text-blue-500 mt-1" />
            <div className="flex-1 min-w-0">
              <div className="text-xl font-bold text-slate-800">{activeWorkspace.name}</div>
              <div className="text-sm text-slate-500 font-mono mt-1 break-all">{activeWorkspace.path}</div>
              <div className="text-xs text-slate-400 mt-1">
                Last opened: {formatTimestamp(activeWorkspace.lastOpened)}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState
            icon="FolderOpen"
            message="No workspace selected. Use the workspace selector in the top bar to add one."
          />
        )}
      </Card>

      {/* 2. Quick Metrics Row */}
      <div className="grid grid-cols-4 gap-4">
        <MetricCard icon="Activity" label="Total Events" value={totalEvents} />
        <MetricCard icon="Bot" label="Subagent Runs" value={subagentRuns} />
        <MetricCard icon="Route" label="Routing Decisions" value={routingDecisions} />
        <MetricCard icon="Users" label="Active Agents" value={activeAgents} />
      </div>

      {/* 3. Summary Cards */}
      <SummaryCards />

      {/* 4. Mode History */}
      <Card>
        <h3 className="text-lg font-semibold text-slate-700 mb-4">Routing History</h3>
        {modeHistoryRows.length === 0 ? (
          <EmptyState icon="Route" message="No routing decisions recorded yet" />
        ) : (
          <DataTable columns={modeHistoryColumns} rows={modeHistoryRows} />
        )}
      </Card>

      {/* 5. Route Map */}
      <RouteMap />

      {/* 6. Cost Trend — summary card linking to Telemetry for full chart */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Cost Trend</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              View detailed cost trends, breakdowns, and forecasts in Telemetry.
            </p>
          </div>
          {contextLink('telemetry', 'Open Telemetry')}
        </div>
      </Card>

      <InsightsCard insights={insights} />
      <CostBudgetPanel />

      <div className="mt-4">
        <SubsystemHealthPanel />
      </div>

      {/* Context navigation: Control Room is the only dispatch entry */}
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="Layers" size={20} className="text-blue-500" />
            <div>
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Task Dispatch</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Create and dispatch tasks exclusively from Control Room — this view is read-only.
              </p>
            </div>
          </div>
          {contextLink('workbench', 'Open Control Room')}
        </div>
      </Card>

      <div className="mt-4">
        <RecentFilesPanel />
      </div>

      <div className="mt-4">
        <ErrorLogPanel />
      </div>

      <div className="mt-4">
        <WorkflowStats />
      </div>

      <div className="mt-4">
        <ModelHealthDashboard />
      </div>

      <div className="mt-4">
        <AgentActivityHeatmap />
      </div>

      <div className="mt-4">
        <CostForecastChart />
      </div>

      <div className="mt-4">
        <BudgetTrendChart />
      </div>
    </div>
  );
};
