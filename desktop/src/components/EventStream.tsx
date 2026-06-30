/**
 * OA-1: Real-time Event Stream — live multi-agent execution feed
 * Shows subagent.run events as they happen, with token/cache/cost details.
 */
import React, { useState, useMemo } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { formatTokens, formatCost, formatHitRate } from "../lib/agent-status-enhanced";

const STATUS_ICON: Record<number, string> = {
  0: "✅",
  124: "⏱️",
  [-1]: "❌",
};

export const EventStream: React.FC = () => {
  const agentTelemetry = useDashboardStore((s) => s.agentStatus?.agentTelemetry);
  const [filter, setFilter] = useState<string>("");
  const [sortBy, setSortBy] = useState<"recent" | "cost" | "tokens">("recent");

  const agents = useMemo(() => {
    if (!agentTelemetry) return [];
    let list = Array.from(agentTelemetry.values());
    if (filter) {
      list = list.filter((a) =>
        a.name.toLowerCase().includes(filter.toLowerCase()) ||
        a.models.some((m) => m.toLowerCase().includes(filter.toLowerCase())),
      );
    }
    switch (sortBy) {
      case "cost":
        list.sort((a, b) => b.totalCost - a.totalCost);
        break;
      case "tokens":
        list.sort((a, b) => (b.totalInput + b.totalCacheRead) - (a.totalInput + a.totalCacheRead));
        break;
      default:
        list.sort((a, b) => b.lastRunTs - a.lastRunTs);
    }
    return list;
  }, [agentTelemetry, filter, sortBy]);

  if (!agentTelemetry || agents.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-700 mb-2">Event Stream</h3>
        <div className="h-32 flex items-center justify-center text-slate-400">
          No subagent events recorded yet.
        </div>
      </div>
    );
  }

  const totalCost = agents.reduce((s, a) => s + a.totalCost, 0);
  const totalInput = agents.reduce((s, a) => s + a.totalInput, 0);
  const totalCacheRead = agents.reduce((s, a) => s + a.totalCacheRead, 0);
  const totalRuns = agents.reduce((s, a) => s + a.runs, 0);
  const totalFailures = agents.reduce((s, a) => s + a.failures, 0);

  return (
    <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-700">Multi-Agent Event Stream</h3>
        <div className="flex gap-2 text-xs">
          <span className="text-slate-500">{totalRuns} runs</span>
          <span className="text-slate-300">|</span>
          <span className="text-slate-500">{formatTokens(totalInput + totalCacheRead)} tokens</span>
          <span className="text-slate-300">|</span>
          <span className="text-green-600">{formatCost(totalCost)}</span>
          {totalFailures > 0 && (
            <>
              <span className="text-slate-300">|</span>
              <span className="text-red-500">{totalFailures} failures</span>
            </>
          )}
        </div>
      </div>

      {/* Filter + Sort */}
      <div className="flex gap-3 mb-4">
        <input
          type="text"
          placeholder="Filter by agent or model..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400"
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as any)}
          className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
        >
          <option value="recent">Most Recent</option>
          <option value="cost">By Cost</option>
          <option value="tokens">By Tokens</option>
        </select>
      </div>

      {/* Agent rows */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {agents.map((a) => (
          <div
            key={a.name}
            className="border border-slate-100 rounded-lg p-3 hover:bg-slate-50 transition-colors"
          >
            {/* Header row */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-mono font-medium ${
                  a.failures > 0 ? "text-red-600" : "text-slate-700"
                }`}>
                  {a.name}
                </span>
                {a.retries > 0 && (
                  <span className="text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                    {a.retries} retries
                  </span>
                )}
              </div>
              <div className="flex gap-3 text-xs text-slate-500">
                <span>{a.runs} runs</span>
                <span>{formatCost(a.totalCost)}</span>
                <span className={a.avgHitRate > 0.7 ? "text-green-600" : a.avgHitRate > 0.3 ? "text-amber-600" : "text-red-500"}>
                  cache {formatHitRate(a.avgHitRate)}
                </span>
              </div>
            </div>

            {/* Token breakdown bar */}
            <div className="flex items-center gap-1 h-4 rounded overflow-hidden bg-slate-100 mb-1">
              {a.totalCacheRead > 0 && (
                <div
                  className="bg-green-400 h-full"
                  style={{
                    width: `${(a.totalCacheRead / (a.totalInput + a.totalCacheRead + a.totalOutput)) * 100}%`,
                  }}
                  title={`Cache Read: ${formatTokens(a.totalCacheRead)}`}
                />
              )}
              {a.totalInput > 0 && (
                <div
                  className="bg-blue-400 h-full"
                  style={{
                    width: `${(a.totalInput / (a.totalInput + a.totalCacheRead + a.totalOutput)) * 100}%`,
                  }}
                  title={`Input: ${formatTokens(a.totalInput)}`}
                />
              )}
              {a.totalOutput > 0 && (
                <div
                  className="bg-purple-400 h-full"
                  style={{
                    width: `${(a.totalOutput / (a.totalInput + a.totalCacheRead + a.totalOutput)) * 100}%`,
                  }}
                  title={`Output: ${formatTokens(a.totalOutput)}`}
                />
              )}
            </div>

            {/* Detail line */}
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span>📦 in {formatTokens(a.totalInput)}</span>
              <span>📖 cache {formatTokens(a.totalCacheRead)}</span>
              <span>📤 out {formatTokens(a.totalOutput)}</span>
              <span>🔄 avg {a.avgTurns.toFixed(1)} turns</span>
              <span>Models: {a.models.join(", ")}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center gap-4 text-xs text-slate-400">
        <span className="flex items-center gap-1"><span className="w-3 h-3 bg-green-400 rounded-sm"/>Cache Read</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-400 rounded-sm"/>Input</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 bg-purple-400 rounded-sm"/>Output</span>
      </div>
    </div>
  );
};
