/**
 * D2-1: 多 Agent 状态面板
 * 显示 persistent agents, blackboard agents, DAG 状态, override 状态
 */
import React from "react";
import { useDashboardStore } from "../store/dashboard-store";

const STATUS_ICON: Record<string, string> = {
  running: "●",
  done: "✓",
  failed: "✗",
  idle: "○",
  blocked: "⏸",
  unknown: "?",
};

const STATUS_COLOR: Record<string, string> = {
  running: "text-blue-600",
  done: "text-green-600",
  failed: "text-red-600",
  idle: "text-slate-400",
  blocked: "text-amber-600",
  unknown: "text-slate-400",
};

function formatCost(c: number): string {
  if (c === 0) return "$0";
  if (c < 0.001) return `$${c.toExponential(2)}`;
  return `$${c.toFixed(6)}`;
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const AgentStatusPanel: React.FC = () => {
  const agentStatus = useDashboardStore((s) => s.agentStatus);

  if (!agentStatus) {
    return (
      <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-700 mb-4">Agent Status</h3>
        <div className="h-32 flex items-center justify-center text-slate-400">
          Loading agent status...
        </div>
      </div>
    );
  }

  const { persistentAgents, blackboardAgents, dagState, override } = agentStatus;
  const activeAgents = [...persistentAgents, ...blackboardAgents].filter(
    (a) => a.status === "running",
  );

  return (
    <div className="space-y-4">
      {/* Active Agents Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="bg-blue-50 rounded-lg p-4 border border-slate-200">
          <div className="text-xs text-slate-500 mb-1">Active (Running)</div>
          <div className="text-xl font-bold text-blue-600">{activeAgents.length}</div>
        </div>
        <div className="bg-green-50 rounded-lg p-4 border border-slate-200">
          <div className="text-xs text-slate-500 mb-1">Persistent Agents</div>
          <div className="text-xl font-bold text-green-600">{persistentAgents.length}</div>
        </div>
        <div className="bg-purple-50 rounded-lg p-4 border border-slate-200">
          <div className="text-xs text-slate-500 mb-1">Blackboard Agents</div>
          <div className="text-xl font-bold text-purple-600">{blackboardAgents.length}</div>
        </div>
        <div className="bg-amber-50 rounded-lg p-4 border border-slate-200">
          <div className="text-xs text-slate-500 mb-1">Override Active</div>
          <div className="text-xl font-bold text-amber-600">
            {override ? (override.forceMode ?? override.preset ?? "yes") : "no"}
          </div>
        </div>
      </div>

      {/* DAG State */}
      {dagState && (
        <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-slate-700">DAG Execution</h3>
            <span className="text-xs text-slate-400">
              {dagState.startTime > 0 ? `age: ${formatAge(Date.now() - dagState.startTime)}` : ""}
            </span>
          </div>
          <p className="text-sm text-slate-600 mb-3">{dagState.description.slice(0, 200)}</p>
          <div className="flex gap-4 text-sm">
            <span className="text-green-600">✓ {dagState.completed.length} completed</span>
            <span className="text-red-600">✗ {dagState.failed.length} failed</span>
            <span className="text-slate-500">
              {dagState.totalNodes - dagState.completed.length - dagState.failed.length} remaining
            </span>
          </div>
          {/* Progress bar */}
          <div className="mt-3 h-2 bg-slate-100 rounded-full overflow-hidden flex">
            <div
              className="bg-green-500 h-full"
              style={{ width: `${(dagState.completed.length / Math.max(dagState.totalNodes, 1)) * 100}%` }}
            />
            <div
              className="bg-red-500 h-full"
              style={{ width: `${(dagState.failed.length / Math.max(dagState.totalNodes, 1)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Persistent Agents */}
      {persistentAgents.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
          <h3 className="text-lg font-semibold text-slate-700 mb-4">Persistent Agents</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-2 px-2"></th>
                  <th className="py-2 px-2">Name</th>
                  <th className="py-2 px-2">Role</th>
                  <th className="py-2 px-2">Model</th>
                  <th className="py-2 px-2 text-right">Calls</th>
                  <th className="py-2 px-2 text-right">Cost</th>
                  <th className="py-2 px-2 text-right">Cache Read</th>
                </tr>
              </thead>
              <tbody>
                {persistentAgents.map((a, i) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className={`py-1.5 px-2 text-lg ${STATUS_COLOR[a.status] ?? "text-slate-400"}`}>
                      {STATUS_ICON[a.status] ?? "?"}
                    </td>
                    <td className="py-1.5 px-2 font-medium text-slate-700">{a.name}</td>
                    <td className="py-1.5 px-2 text-slate-500">{a.role}</td>
                    <td className="py-1.5 px-2 text-slate-500 text-xs">{a.model}</td>
                    <td className="py-1.5 px-2 text-right text-slate-600">{a.callCount}</td>
                    <td className="py-1.5 px-2 text-right text-slate-600">{formatCost(a.totalCost)}</td>
                    <td className="py-1.5 px-2 text-right text-slate-600">
                      {a.totalCacheRead > 0 ? `${(a.totalCacheRead / 1000).toFixed(1)}k` : "0"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Blackboard Agents (DAG/M6) */}
      {blackboardAgents.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
          <h3 className="text-lg font-semibold text-slate-700 mb-4">Blackboard Agents (DAG / M6)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-2 px-2"></th>
                  <th className="py-2 px-2">Agent</th>
                  <th className="py-2 px-2">Role</th>
                  <th className="py-2 px-2">Working On</th>
                </tr>
              </thead>
              <tbody>
                {blackboardAgents.map((a, i) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className={`py-1.5 px-2 text-lg ${STATUS_COLOR[a.status] ?? "text-slate-400"}`}>
                      {STATUS_ICON[a.status] ?? "?"}
                    </td>
                    <td className="py-1.5 px-2 font-medium text-slate-700">{a.name}</td>
                    <td className="py-1.5 px-2 text-slate-500">{a.role ?? "-"}</td>
                    <td className="py-1.5 px-2 text-slate-600 text-xs">{a.workingOn ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Override Status */}
      {override && (
        <div className="bg-amber-50 rounded-lg shadow p-6 border border-amber-200">
          <h3 className="text-lg font-semibold text-amber-800 mb-2">⚠ Runtime Override Active</h3>
          <div className="text-sm text-amber-700 space-y-1">
            {override.preset && <div>Preset override: <span className="font-mono">{override.preset}</span></div>}
            {override.forceMode && <div>Force mode: <span className="font-mono">{override.forceMode}</span></div>}
            <div>Ephemeral: {override.ephemeral ? "yes (one-time)" : "no (persistent)"}</div>
          </div>
        </div>
      )}

      {/* No agents */}
      {persistentAgents.length === 0 && blackboardAgents.length === 0 && !dagState && (
        <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
          <div className="h-32 flex items-center justify-center text-slate-400">
            No active agents. Run a multi-agent command (e.g. /flux team, DAG, M6) to see status here.
          </div>
        </div>
      )}
    </div>
  );
};
