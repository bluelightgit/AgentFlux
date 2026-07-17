/**
 * OA-4: Cache Efficiency Panel
 * Shows per-agent L1 cache hit rates, cache miss cost impact, and overall efficiency.
 */
import React, { useMemo } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { formatTokens, formatCost, formatHitRate } from "../lib/agent-status-enhanced";

export const CacheEfficiency: React.FC = () => {
  const agentTelemetry = useDashboardStore((s) => s.agentStatus?.agentTelemetry);

  const stats = useMemo(() => {
    if (!agentTelemetry || agentTelemetry.size === 0) return null;

    let totalInput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalOutput = 0;
    let totalCost = 0;
    let totalRuns = 0;
    let highHitRuns = 0; // >70%
    let lowHitRuns = 0; // <30%

    const perAgent: Array<{
      name: string;
      hitRate: number;
      cacheRead: number;
      input: number;
      cost: number;
      runs: number;
    }> = [];

    for (const t of agentTelemetry.values()) {
      totalInput += t.totalInput;
      totalCacheRead += t.totalCacheRead;
      totalCacheWrite += t.totalCacheWrite;
      totalOutput += t.totalOutput;
      totalCost += t.totalCost;
      totalRuns += t.runs;

      for (const r of t.runs_detail) {
        if (r.hitRate > 0.7) highHitRuns++;
        else if (r.hitRate < 0.3) lowHitRuns++;
      }

      perAgent.push({
        name: t.name,
        hitRate: t.avgHitRate,
        cacheRead: t.totalCacheRead,
        input: t.totalInput,
        cost: t.totalCost,
        runs: t.runs,
      });
    }

    perAgent.sort((a, b) => b.cacheRead - a.cacheRead);

    const overallHitRate = totalCacheRead / (totalCacheRead + totalInput + 1e-9);
    const estimatedFullCost = (totalInput + totalCacheRead) * 5e-6; // if all at input price
    const actualCost = totalCost;
    const savings = Math.max(0, estimatedFullCost - actualCost);

    return {
      overallHitRate,
      totalInput,
      totalCacheRead,
      totalCacheWrite,
      totalOutput,
      totalCost,
      totalRuns,
      highHitRuns,
      lowHitRuns,
      perAgent: perAgent.slice(0, 10),
      savings,
    };
  }, [agentTelemetry]);

  if (!stats) {
    return (
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow p-6 border border-slate-200 dark:border-slate-700">
        <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-200 mb-2">Cache Efficiency</h3>
        <div className="h-32 flex items-center justify-center text-slate-400">
          No cache data available.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow p-6 border border-slate-200 dark:border-slate-700">
      <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-200 mb-4">Cache Efficiency</h3>

      {/* Overall stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3">
          <div className="text-xs text-slate-500 dark:text-slate-400">Overall Hit Rate</div>
          <div className={`text-lg font-bold ${
            stats.overallHitRate > 0.7 ? "text-green-600 dark:text-green-400" :
            stats.overallHitRate > 0.3 ? "text-amber-600 dark:text-amber-400" : "text-red-500 dark:text-red-400"
          }`}>
            {formatHitRate(stats.overallHitRate)}
          </div>
        </div>
        <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3">
          <div className="text-xs text-slate-500 dark:text-slate-400">Cache Read</div>
          <div className="text-lg font-bold text-green-600 dark:text-green-400">{formatTokens(stats.totalCacheRead)}</div>
        </div>
        <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3">
          <div className="text-xs text-slate-500 dark:text-slate-400">Cache Miss (Input)</div>
          <div className="text-lg font-bold text-blue-600 dark:text-blue-400">{formatTokens(stats.totalInput)}</div>
        </div>
        <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3">
          <div className="text-xs text-slate-500 dark:text-slate-400">Est. Savings</div>
          <div className="text-lg font-bold text-purple-600 dark:text-purple-400">{formatCost(stats.savings)}</div>
        </div>
      </div>

      {/* Hit rate distribution */}
      <div className="mb-4">
        <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">Run Hit Rate Distribution ({stats.totalRuns} runs)</div>
        <div className="flex h-6 rounded-lg overflow-hidden">
          <div
            className="bg-green-500 flex items-center justify-center text-xs text-white"
            style={{ width: `${(stats.highHitRuns / Math.max(stats.totalRuns, 1)) * 100}%` }}
            title={`High (>70%): ${stats.highHitRuns} runs`}
          >
            {stats.highHitRuns > 0 && `${stats.highHitRuns}`}
          </div>
          <div
            className="bg-amber-400 flex items-center justify-center text-xs text-white"
            style={{ width: `${((stats.totalRuns - stats.highHitRuns - stats.lowHitRuns) / Math.max(stats.totalRuns, 1)) * 100}%` }}
            title={`Medium (30-70%): ${stats.totalRuns - stats.highHitRuns - stats.lowHitRuns} runs`}
          />
          <div
            className="bg-red-400 flex items-center justify-center text-xs text-white"
            style={{ width: `${(stats.lowHitRuns / Math.max(stats.totalRuns, 1)) * 100}%` }}
            title={`Low (<30%): ${stats.lowHitRuns} runs`}
          >
            {stats.lowHitRuns > 0 && `${stats.lowHitRuns}`}
          </div>
        </div>
        <div className="flex justify-between text-xs text-slate-400 mt-1">
          <span>High (&gt;70%)</span>
          <span>Medium</span>
          <span>Low (&lt;30%)</span>
        </div>
      </div>

      {/* Per-agent breakdown */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="py-2 px-2">Agent</th>
              <th className="py-2 px-2 text-right">Runs</th>
              <th className="py-2 px-2 text-right">Cache Read</th>
              <th className="py-2 px-2 text-right">Input</th>
              <th className="py-2 px-2 text-right">Hit Rate</th>
              <th className="py-2 px-2 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {stats.perAgent.map((a, i) => (
              <tr key={i} className="border-b border-slate-100 dark:border-slate-700/60">
                <td className="py-1.5 px-2 font-mono text-xs text-slate-700 dark:text-slate-200">{a.name}</td>
                <td className="py-1.5 px-2 text-right text-slate-600 dark:text-slate-400">{a.runs}</td>
                <td className="py-1.5 px-2 text-right text-green-600 dark:text-green-400">{formatTokens(a.cacheRead)}</td>
                <td className="py-1.5 px-2 text-right text-blue-600 dark:text-blue-400">{formatTokens(a.input)}</td>
                <td className={`py-1.5 px-2 text-right font-medium ${
                  a.hitRate > 0.7 ? "text-green-600 dark:text-green-400" : a.hitRate > 0.3 ? "text-amber-600 dark:text-amber-400" : "text-red-500 dark:text-red-400"
                }`}>
                  {formatHitRate(a.hitRate)}
                </td>
                <td className="py-1.5 px-2 text-right text-slate-600 dark:text-slate-400">{formatCost(a.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
