/**
 * DAG Page — visualization of DAG execution state and history.
 *
 * Section 1: Current DAG State
 *   - Reads dagState from store.agentStatus?.dagState
 *   - Shows description, progress bar (completed/failed/running), DAGWorkflow
 *     visual, and a node details DataTable.
 *   - Live updates: watches `.agentflux/runtime/dag-state.json` for changes and
 *     auto-refreshes agent status. A 'Live' indicator + start/stop toggle.
 *   - Progress ETA: estimates remaining time from average node duration in
 *     history (gaps between consecutive dag-* subagent.run events).
 *
 * Execution Logs Panel:
 *   - Collapsible panel below the DAG visualization.
 *   - Lists recent dag-* subagent.run events chronologically with timestamp,
 *     agent name, exit code, cost, and turns. Color-coded by exit code.
 *   - Auto-scrolls to bottom when new logs arrive (if live mode is on).
 *   - Max 50 entries shown, with 'Show All' to expand.
 *
 * Section 2: DAG Execution History
 *   - Filters store.events for subagent.run events whose agent name starts
 *     with 'dag-'.
 *   - Groups events into runs by sessionId (falling back to timestamp
 *     proximity when sessionId is missing).
 *   - Renders a DataTable summarizing each past DAG run.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { useLiveUpdate } from "../hooks/useLiveUpdate";
import {
  Card,
  Icon,
  StatusDot,
  DataTable,
  EmptyState,
  Badge,
  type DataTableColumn,
  type StatusKind,
} from "./ui";
import { DAGWorkflow } from "./DAGWorkflow";
import { TaskDependencyGraph } from "./TaskDependencyGraph";
import type { AnyEvent, SubagentRunEvent } from "../lib/events-parser";
import type { DAGState } from "../lib/agent-status-enhanced";
import { formatTs, formatCost, formatPct } from "../lib/format";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Status of a single DAG node derived from dagState + blackboard agents. */
function nodeStatus(
  nodeId: string,
  dagState: DAGState,
  runningIds: Set<string>,
): StatusKind {
  if (dagState.completed.includes(nodeId)) return "done";
  if (dagState.failed.includes(nodeId)) return "failed";
  if (runningIds.has(nodeId)) return "running";
  return "pending";
}

/** Filter events to dag-* subagent.run events, sorted ascending by ts. */
function filterDagEvents(events: AnyEvent[]): SubagentRunEvent[] {
  return events
    .filter(
      (e): e is SubagentRunEvent =>
        e.type === "subagent.run" &&
        typeof (e as any).agent === "string" &&
        (e as any).agent.startsWith("dag-"),
    )
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Estimate average per-node execution duration (ms) from the gaps between
 * consecutive dag-* subagent.run events in history. Returns 0 when there
 * is not enough data to estimate.
 */
function estimateAvgNodeDurationMs(dagEvents: SubagentRunEvent[]): number {
  if (dagEvents.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < dagEvents.length; i++) {
    const gap = dagEvents[i].ts - dagEvents[i - 1].ts;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  return gaps.reduce((s, g) => s + g, 0) / gaps.length;
}

interface DagRunSummary {
  /** Session/group identifier for the run. */
  key: string;
  /** Timestamp of the first event in the run. */
  startTs: number;
  /** Number of node executions in the run. */
  nodeCount: number;
  /** Sum of costUsd across events. */
  totalCost: number;
  /** Average cache hit rate across events. */
  avgHitRate: number;
  /** Number of events with non-zero exitCode. */
  failedCount: number;
  /** 'Completed' | 'Partial' | 'Failed' */
  status: "Completed" | "Partial" | "Failed";
}

/**
 * Group dag-* subagent.run events into runs. Events sharing a sessionId
 * belong to the same run. When sessionId is missing, events within a
 * 60-second window of each other are merged into the same run.
 */
function groupDagRuns(events: SubagentRunEvent[]): DagRunSummary[] {
  const WINDOW_MS = 60_000;
  // Sort ascending by timestamp.
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  type Group = { key: string; events: SubagentRunEvent[] };
  const groups: Group[] = [];

  for (const ev of sorted) {
    const sid = ev.sessionId && ev.sessionId.trim() !== "" ? ev.sessionId : null;

    let target: Group | undefined;
    if (sid) {
      // Find an existing group with the same sessionId.
      target = groups.find((g) => g.key === `sid:${sid}`);
    }
    if (!target) {
      // Fall back to timestamp proximity: append to the last group if its
      // last event is within WINDOW_MS of this event.
      const last = groups[groups.length - 1];
      if (last && last.events.length > 0) {
        const lastTs = last.events[last.events.length - 1].ts;
        if (Math.abs(ev.ts - lastTs) <= WINDOW_MS) target = last;
      }
    }

    if (target) {
      target.events.push(ev);
    } else {
      const key = sid ? `sid:${sid}` : `ts:${ev.ts}`;
      groups.push({ key, events: [ev] });
    }
  }

  return groups.map((g) => {
    const startTs = g.events.reduce((m, e) => Math.min(m, e.ts), g.events[0].ts);
    const totalCost = g.events.reduce((s, e) => s + (e.costUsd ?? 0), 0);
    const failedCount = g.events.filter((e) => (e.exitCode ?? 0) !== 0).length;
    const hitRates = g.events
      .map((e) => e.cacheHitRate ?? 0)
      .filter((r) => isFinite(r));
    const avgHitRate =
      hitRates.length > 0
        ? hitRates.reduce((s, r) => s + r, 0) / hitRates.length
        : 0;

    let status: DagRunSummary["status"];
    if (failedCount === 0) status = "Completed";
    else if (failedCount === g.events.length) status = "Failed";
    else status = "Partial";

    return {
      key: g.key,
      startTs,
      nodeCount: g.events.length,
      totalCost,
      avgHitRate,
      failedCount,
      status,
    };
  });
}

// ---------------------------------------------------------------------------
// Section 1: Current DAG State
// ---------------------------------------------------------------------------

interface Section1Props {
  dagState: DAGState | null;
  events: AnyEvent[];
  isLive: boolean;
  onToggleLive: () => void;
}

const Section1: React.FC<Section1Props> = ({
  dagState,
  events,
  isLive,
  onToggleLive,
}) => {
  const blackboardAgents = useDashboardStore(
    (s) => s.agentStatus?.blackboardAgents ?? [],
  );

  // dag-* events for ETA estimation.
  const dagEvents = useMemo(() => filterDagEvents(events), [events]);
  const avgDurationMs = useMemo(
    () => estimateAvgNodeDurationMs(dagEvents),
    [dagEvents],
  );

  if (!dagState) {
    return (
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-700">
            <Icon name="Workflow" size={18} className="text-slate-500" />
            Current DAG State
          </h2>
          <LiveToggle isLive={isLive} onToggle={onToggleLive} />
        </div>
        <EmptyState icon="Workflow" message="No active DAG execution" />
      </Card>
    );
  }

  // Build the set of running node ids from blackboard agents.
  const runningIds = new Set<string>();
  for (const a of blackboardAgents) {
    if (a.name.startsWith("dag-") && a.status === "running") {
      runningIds.add(a.name.replace("dag-", ""));
    }
  }

  // Collect all known node ids: from nodes array (if present), completed,
  // failed, and running blackboard agents.
  const allIds = new Set<string>();
  if (Array.isArray(dagState.nodes)) {
    for (const n of dagState.nodes) {
      if (n && typeof n === "object" && typeof n.id === "string") allIds.add(n.id);
    }
  }
  for (const id of dagState.completed) allIds.add(id);
  for (const id of dagState.failed) allIds.add(id);
  for (const id of runningIds) allIds.add(id);

  const nodeIds = Array.from(allIds).sort((a, b) => a.localeCompare(b));
  const completedCount = dagState.completed.length;
  const failedCount = dagState.failed.length;
  const runningCount = runningIds.size;
  const pendingCount = Math.max(
    0,
    nodeIds.length - completedCount - failedCount - runningCount,
  );
  const totalNodes = nodeIds.length > 0 ? nodeIds.length : dagState.totalNodes;
  const finishedCount = completedCount + failedCount;
  const progressPct =
    totalNodes > 0 ? (finishedCount / totalNodes) * 100 : 0;

  // Progress bar segment widths (percent of bar).
  const segCompleted = totalNodes > 0 ? (completedCount / totalNodes) * 100 : 0;
  const segFailed = totalNodes > 0 ? (failedCount / totalNodes) * 100 : 0;
  const segRunning = totalNodes > 0 ? (runningCount / totalNodes) * 100 : 0;

  // ETA: only show when DAG is actively executing (some done, some pending/running).
  const isExecuting =
    completedCount > 0 && (pendingCount > 0 || runningCount > 0) && totalNodes > 0;
  const remainingNodes = pendingCount + runningCount;
  let etaText: string | null = null;
  if (isExecuting) {
    if (avgDurationMs > 0) {
      const etaSeconds = Math.round((remainingNodes * avgDurationMs) / 1000);
      etaText = `ETA: ~${etaSeconds}s remaining`;
    } else {
      etaText = "ETA: calculating...";
    }
  }

  // Build node detail rows.
  const nodeRows = nodeIds.map((id) => {
    const status = nodeStatus(id, dagState, runningIds);
    const bbAgent = blackboardAgents.find((a) => a.name === `dag-${id}`);
    const role =
      bbAgent?.role ??
      (Array.isArray(dagState.nodes)
        ? (dagState.nodes as any[]).find((n) => n?.id === id)?.role
        : undefined) ??
      "unknown";
    return {
      nodeId: <span className="font-mono text-xs">{id}</span>,
      status: (
        <div className="flex items-center gap-2">
          <StatusDot status={status} />
          <span className="text-xs capitalize text-slate-600">{status}</span>
        </div>
      ),
      role: <span className="text-xs text-slate-600">{role}</span>,
    };
  });

  const nodeColumns: DataTableColumn[] = [
    { key: "nodeId", label: "Node ID" },
    { key: "status", label: "Status", width: "140px" },
    { key: "role", label: "Role" },
  ];

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-700">
          <Icon name="Workflow" size={18} className="text-slate-500" />
          Current DAG State
        </h2>
        <LiveToggle isLive={isLive} onToggle={onToggleLive} />
      </div>

      {/* Description */}
      <p className="text-lg font-bold text-slate-800 mb-3 break-words">
        {dagState.description || "DAG execution in progress"}
      </p>

      {/* Legend + counts */}
      <div className="flex flex-wrap items-center gap-4 mb-2 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />
          Completed {completedCount}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500" />
          Running {runningCount}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />
          Failed {failedCount}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />
          Pending {pendingCount}
        </span>
        <span className="text-slate-400">
          {finishedCount}/{totalNodes} nodes
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-3 w-full bg-slate-100 rounded-full overflow-hidden flex mb-2">
        <div
          className="bg-green-500 h-full transition-all duration-500"
          style={{ width: `${segCompleted}%` }}
        />
        <div
          className="bg-red-500 h-full transition-all duration-500"
          style={{ width: `${segFailed}%` }}
        />
        <div
          className="bg-blue-500 h-full transition-all duration-500 animate-pulse"
          style={{ width: `${segRunning}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 mb-4">
        <span>{progressPct.toFixed(1)}% complete</span>
        {dagState.startTime ? (
          <span>— started {formatTs(dagState.startTime)}</span>
        ) : null}
        {etaText ? (
          <span className="text-slate-600 font-medium">{etaText}</span>
        ) : null}
      </div>

      {/* Visual DAG workflow */}
      <div className="mb-6">
        <DAGWorkflow />
      </div>

      {/* Node details table */}
      <h3 className="text-sm font-semibold text-slate-700 mb-2">Node Details</h3>
      {nodeRows.length === 0 ? (
        <EmptyState icon="Workflow" message="No DAG nodes recorded yet." />
      ) : (
        <div className="overflow-x-auto">
          <DataTable columns={nodeColumns} rows={nodeRows} />
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Live indicator + toggle
// ---------------------------------------------------------------------------

const LiveToggle: React.FC<{ isLive: boolean; onToggle: () => void }> = ({
  isLive,
  onToggle,
}) => (
  <div className="flex items-center gap-3">
    {isLive && (
      <span className="flex items-center gap-1.5 text-xs font-medium text-green-600">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
        Live
      </span>
    )}
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded border transition-colors ${
        isLive
          ? "border-green-300 bg-green-50 text-green-700 hover:bg-green-100"
          : "border-slate-300 bg-slate-50 text-slate-600 hover:bg-slate-100"
      }`}
      aria-label={isLive ? "Stop live updates" : "Start live updates"}
    >
      <Icon
        name="RefreshCw"
        size={14}
        className={isLive ? "animate-spin" : ""}
      />
      {isLive ? "Stop" : "Live"}
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Execution Logs Panel
// ---------------------------------------------------------------------------

const MAX_LOG_ENTRIES = 50;

const ExecutionLogsPanel: React.FC<{
  events: AnyEvent[];
  isLive: boolean;
}> = ({ events, isLive }) => {
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const dagEvents = useMemo(() => filterDagEvents(events), [events]);
  const visible = showAll ? dagEvents : dagEvents.slice(-MAX_LOG_ENTRIES);
  const hiddenCount = Math.max(0, dagEvents.length - visible.length);

  // Auto-scroll to bottom when new logs arrive (only if live mode is on and
  // the panel is expanded).
  useEffect(() => {
    if (collapsed || !isLive) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dagEvents.length, collapsed, isLive]);

  return (
    <Card>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 text-lg font-semibold text-slate-700 w-full text-left"
      >
        <Icon
          name={collapsed ? "ChevronRight" : "ChevronDown"}
          size={18}
          className="text-slate-500"
        />
        Execution Logs
        <span className="text-xs font-normal text-slate-400">
          {dagEvents.length} {dagEvents.length === 1 ? "entry" : "entries"}
        </span>
      </button>

      {!collapsed && (
        <>
          {dagEvents.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                icon="Activity"
                message="No dag-* subagent.run events recorded yet."
              />
            </div>
          ) : (
            <>
              <div
                ref={listRef}
                className="mt-4 max-h-80 overflow-y-auto bg-slate-50 dark:bg-slate-900/40 rounded border border-slate-200 dark:border-slate-700 p-3 space-y-1"
              >
                {visible.map((e, i) => {
                  const exitCode = e.exitCode ?? 0;
                  const ok = exitCode === 0;
                  return (
                    <div
                      key={`${e.ts}-${i}`}
                      className={`font-mono text-xs flex flex-wrap items-center gap-x-3 gap-y-0.5 ${
                        ok ? "text-green-700" : "text-red-600"
                      }`}
                    >
                      <span className="text-slate-500">{formatTs(e.ts)}</span>
                      <span className="font-semibold">{e.agent}</span>
                      <span>exit={exitCode}</span>
                      <span>{formatCost(e.costUsd ?? 0)}</span>
                      <span className="text-slate-500">
                        {e.turns ?? 0} turns
                      </span>
                    </div>
                  );
                })}
              </div>
              {!showAll && hiddenCount > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700"
                  >
                    Show All ({dagEvents.length} entries)
                  </button>
                </div>
              )}
              {showAll && dagEvents.length > MAX_LOG_ENTRIES && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setShowAll(false)}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700"
                  >
                    Show Recent ({MAX_LOG_ENTRIES})
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Section 2: DAG Execution History
// ---------------------------------------------------------------------------

const STATUS_BADGE_COLOR: Record<
  DagRunSummary["status"],
  "green" | "amber" | "red"
> = {
  Completed: "green",
  Partial: "amber",
  Failed: "red",
};

const Section2: React.FC<{ events: AnyEvent[] }> = ({ events }) => {
  const runs = useMemo(() => {
    const dagEvents = events.filter(
      (e): e is SubagentRunEvent =>
        e.type === "subagent.run" &&
        typeof (e as any).agent === "string" &&
        (e as any).agent.startsWith("dag-"),
    );
    return groupDagRuns(dagEvents).sort((a, b) => b.startTs - a.startTs);
  }, [events]);

  const historyColumns: DataTableColumn[] = [
    { key: "ts", label: "Timestamp", width: "200px" },
    { key: "nodes", label: "Nodes", width: "80px" },
    { key: "cost", label: "Total Cost", width: "110px" },
    { key: "hitRate", label: "Avg Cache Hit", width: "130px" },
    { key: "status", label: "Status", width: "120px" },
  ];

  const rows = runs.map((r) => ({
    ts: <span className="text-xs text-slate-600">{formatTs(r.startTs)}</span>,
    nodes: <span className="text-xs font-mono text-slate-700">{r.nodeCount}</span>,
    cost: <span className="text-xs font-mono text-slate-700">{formatCost(r.totalCost)}</span>,
    hitRate: (
      <span className="text-xs font-mono text-slate-700">
        {formatPct(r.avgHitRate)}
      </span>
    ),
    status: (
      <Badge color={STATUS_BADGE_COLOR[r.status]}>{r.status}</Badge>
    ),
  }));

  return (
    <Card>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-700 mb-4">
        <Icon name="Clock" size={18} className="text-slate-500" />
        DAG Execution History
      </h2>
      {runs.length === 0 ? (
        <EmptyState
          icon="Workflow"
          message="No past DAG runs recorded. Subagent run events for dag-* agents will appear here."
        />
      ) : (
        <div className="overflow-x-auto">
          <DataTable columns={historyColumns} rows={rows} />
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const DAGPage: React.FC = () => {
  const agentStatus = useDashboardStore((s) => s.agentStatus);
  const events = useDashboardStore((s) => s.events);
  const project = useDashboardStore((s) => s.project);
  const refreshAgentStatus = useDashboardStore((s) => s.refreshAgentStatus);

  // Path to the DAG state file we watch for live changes.
  const dagStatePath = project
    ? `${project.fluxDir}/runtime/dag-state.json`
    : null;

  const { isLive, start, stop } = useLiveUpdate(dagStatePath, {
    onNewData: () => {
      refreshAgentStatus();
    },
  });

  const handleToggleLive = () => {
    if (isLive) stop();
    else start();
  };

  return (
    <div className="space-y-6 p-6">
      <Section1
        dagState={agentStatus?.dagState ?? null}
        events={events}
        isLive={isLive}
        onToggleLive={handleToggleLive}
      />
      <ExecutionLogsPanel events={events} isLive={isLive} />
      <Section2 events={events} />

      <div className="mt-4">
        <TaskDependencyGraph />
      </div>
    </div>
  );
};

export default DAGPage;
