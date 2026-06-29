/**
 * OA-3: DAG Workflow Visualization
 * Shows DAG nodes with status colors and dependency arrows.
 */
import React, { useMemo } from "react";
import { useDashboardStore } from "../store/dashboard-store";

interface DAGNode {
  id: string;
  title: string;
  role: string;
  status: "completed" | "failed" | "running" | "pending" | "unknown";
  dependsOn: string[];
}

const STATUS_COLOR: Record<string, string> = {
  completed: "bg-green-500 border-green-600",
  failed: "bg-red-500 border-red-600",
  running: "bg-blue-500 border-blue-600 animate-pulse",
  pending: "bg-slate-300 border-slate-400",
  unknown: "bg-slate-200 border-slate-300",
};

const STATUS_ICON: Record<string, string> = {
  completed: "✓",
  failed: "✗",
  running: "●",
  pending: "○",
  unknown: "?",
};

export const DAGWorkflow: React.FC = () => {
  const dagState = useDashboardStore((s) => s.agentStatus?.dagState);
  const blackboardAgents = useDashboardStore((s) => s.agentStatus?.blackboardAgents);

  // Build node list from DAG state + blackboard agents
  const nodes: DAGNode[] = useMemo(() => {
    if (!dagState) return [];

    // Try to read DAG nodes from dag-state.json (if it has nodes field)
    // For now, reconstruct from completed/failed + blackboard agents
    const allNodeIds = new Set<string>([
      ...dagState.completed,
      ...dagState.failed,
    ]);

    // Also check blackboard for dag-* agents
    for (const a of blackboardAgents) {
      if (a.name.startsWith("dag-")) {
        allNodeIds.add(a.name.replace("dag-", ""));
      }
    }

    return Array.from(allNodeIds).map((id) => {
      let status: DAGNode["status"] = "pending";
      if (dagState.completed.includes(id)) status = "completed";
      else if (dagState.failed.includes(id)) status = "failed";
      else {
        // Check blackboard for running status
        const bbAgent = blackboardAgents.find((a) => a.name === `dag-${id}`);
        if (bbAgent?.status === "running") status = "running";
      }

      return {
        id,
        title: id,
        role: blackboardAgents.find((a) => a.name === `dag-${id}`)?.role ?? "unknown",
        status,
        dependsOn: [],
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
  }, [dagState, blackboardAgents]);

  if (!dagState) {
    return (
      <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-700 mb-2">DAG Workflow</h3>
        <div className="h-32 flex items-center justify-center text-slate-400">
          No DAG execution in progress.
        </div>
      </div>
    );
  }

  const completedCount = nodes.filter((n) => n.status === "completed").length;
  const failedCount = nodes.filter((n) => n.status === "failed").length;
  const runningCount = nodes.filter((n) => n.status === "running").length;
  const progress = nodes.length > 0 ? ((completedCount + failedCount) / nodes.length) * 100 : 0;

  return (
    <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-700">DAG Workflow</h3>
        <div className="flex gap-3 text-xs">
          <span className="text-green-600">✓ {completedCount}</span>
          <span className="text-blue-600">● {runningCount}</span>
          <span className="text-red-600">✗ {failedCount}</span>
          <span className="text-slate-400">○ {nodes.length - completedCount - failedCount - runningCount}</span>
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-slate-600 mb-3 truncate">{dagState.description}</p>

      {/* Progress bar */}
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden mb-4">
        <div
          className="bg-green-500 h-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Node grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {nodes.map((node) => (
          <div
            key={node.id}
            className={`rounded-lg border-2 p-3 ${STATUS_COLOR[node.status]}`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-white text-xs font-mono font-bold">{node.id}</span>
              <span className="text-white text-sm">{STATUS_ICON[node.status]}</span>
            </div>
            <div className="text-white/80 text-xs">{node.role}</div>
          </div>
        ))}
      </div>

      {nodes.length === 0 && (
        <div className="text-center py-4 text-slate-400 text-sm">
          DAG has no nodes (completed: {dagState.completed.length}, failed: {dagState.failed.length})
        </div>
      )}
    </div>
  );
};
