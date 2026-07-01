/**
 * Per-agent cost dashboard.
 * Renders a sortable breakdown of telemetry per agent with expandable
 * detail rows showing models used, last run timestamp, and retry count.
 */
import React, { useMemo, useState } from "react";
import { Card, DataTable, MetricCard, Badge, Icon, EmptyState } from "./ui";
import { formatCost, formatTokens, formatPct, formatTs } from "../lib/format";
import type { AgentTelemetry } from "../lib/agent-status-enhanced";

export interface AgentCostPanelProps {
  agents: AgentTelemetry[];
}

// Cache-hit ratio color thresholds (ratio is 0..1).
function hitRateColor(ratio: number): "green" | "amber" | "red" {
  if (ratio > 0.7) return "green";
  if (ratio >= 0.4) return "amber";
  return "red";
}

export const AgentCostPanel: React.FC<AgentCostPanelProps> = ({ agents }) => {
  const [expanded, setExpanded] = useState<string | null>(null);

  // Sort by total cost descending by default.
  const sorted = useMemo(
    () => [...agents].sort((a, b) => b.totalCost - a.totalCost),
    [agents],
  );

  // Aggregate totals for the summary row.
  const totals = useMemo(() => {
    const totalCost = sorted.reduce((s, a) => s + a.totalCost, 0);
    const totalRuns = sorted.reduce((s, a) => s + a.runs, 0);
    const totalCacheRead = sorted.reduce((s, a) => s + a.totalCacheRead, 0);
    const totalInput = sorted.reduce((s, a) => s + a.totalInput, 0);
    const totalOutput = sorted.reduce((s, a) => s + a.totalOutput, 0);
    const avgHit =
      sorted.length > 0
        ? sorted.reduce((s, a) => s + a.avgHitRate, 0) / sorted.length
        : 0;
    return { totalCost, totalRuns, totalCacheRead, totalInput, totalOutput, avgHit };
  }, [sorted]);

  const toggle = (name: string) =>
    setExpanded((cur) => (cur === name ? null : name));

  // Column header set mirrors the DataTable layout used for the summary row.
  const summaryColumns = [
    { key: "label", label: "" },
    { key: "runs", label: "Runs" },
    { key: "cost", label: "Total Cost" },
    { key: "input", label: "Input" },
    { key: "output", label: "Output" },
    { key: "cache", label: "Cache Read" },
    { key: "hit", label: "Cache Hit" },
    { key: "extra", label: "" },
  ];

  const summaryRow = {
    label: (
      <span className="font-semibold text-slate-700 dark:text-slate-200">
        Total
      </span>
    ),
    runs: (
      <span className="font-medium text-slate-700 dark:text-slate-200">
        {totals.totalRuns}
      </span>
    ),
    cost: (
      <span className="font-semibold text-right block text-slate-800 dark:text-slate-100">
        {formatCost(totals.totalCost)}
      </span>
    ),
    input: <span className="text-slate-600 dark:text-slate-300">{formatTokens(totals.totalInput)}</span>,
    output: <span className="text-slate-600 dark:text-slate-300">{formatTokens(totals.totalOutput)}</span>,
    cache: <span className="text-slate-600 dark:text-slate-300">{formatTokens(totals.totalCacheRead)}</span>,
    hit: (
      <Badge color={hitRateColor(totals.avgHit)}>
        {formatPct(totals.avgHit)}
      </Badge>
    ),
    extra: <span className="text-xs text-slate-400 dark:text-slate-500">avg</span>,
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Agent Cost Breakdown
        </h3>
        <Badge color="slate">{sorted.length} agents</Badge>
      </div>

      {sorted.length === 0 ? (
        <EmptyState icon="Users" message="No agent telemetry available." />
      ) : (
        <>
          {/* Main breakdown table — custom render to support expandable rows. */}
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm text-slate-800 dark:text-slate-200">
              <thead>
                <tr>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2">
                    Agent
                  </th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 w-20">
                    Runs
                  </th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-right px-3 py-2 w-28">
                    Total Cost
                  </th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 w-24">
                    Input
                  </th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 w-24">
                    Output
                  </th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 w-24">
                    Cache Read
                  </th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 w-24">
                    Cache Hit
                  </th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 w-20">
                    Failures
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => {
                  const isOpen = expanded === a.name;
                  return (
                    <React.Fragment key={a.name}>
                      <tr
                        onClick={() => toggle(a.name)}
                        className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40 transition-colors"
                      >
                        <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700 text-left font-medium">
                          <span className="inline-flex items-center gap-2">
                            <Icon
                              name="ChevronRight"
                              size={16}
                              className={`text-slate-400 dark:text-slate-500 transition-transform ${isOpen ? "rotate-90" : ""}`}
                            />
                            {a.name}
                          </span>
                        </td>
                        <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700">
                          {a.runs}
                        </td>
                        <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700 text-right font-mono">
                          {formatCost(a.totalCost)}
                        </td>
                        <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700">
                          {formatTokens(a.totalInput)}
                        </td>
                        <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700">
                          {formatTokens(a.totalOutput)}
                        </td>
                        <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700">
                          {formatTokens(a.totalCacheRead)}
                        </td>
                        <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700">
                          <Badge color={hitRateColor(a.avgHitRate)}>
                            {formatPct(a.avgHitRate)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700">
                          <span
                            className={
                              a.failures > 0
                                ? "text-red-600 dark:text-red-400 font-medium"
                                : "text-slate-500 dark:text-slate-400"
                            }
                          >
                            {a.failures}
                          </span>
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr>
                          <td colSpan={8} className="px-3 py-3 border-t border-slate-100 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/30">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              <div>
                                <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">
                                  Models
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {a.models.length > 0 ? (
                                    a.models.map((m) => (
                                      <Badge key={m} color="purple">
                                        {m}
                                      </Badge>
                                    ))
                                  ) : (
                                    <span className="text-xs text-slate-400 dark:text-slate-500">none</span>
                                  )}
                                </div>
                              </div>
                              <div>
                                <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">
                                  Last Run
                                </div>
                                <div className="text-sm text-slate-700 dark:text-slate-200">
                                  {formatTs(a.lastRunTs)}
                                </div>
                              </div>
                              <div>
                                <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">
                                  Retries
                                </div>
                                <div className="text-sm text-slate-700 dark:text-slate-200">
                                  {a.retries}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Summary row rendered via DataTable for consistency with ui patterns. */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            <DataTable columns={summaryColumns} rows={[summaryRow]} />
          </div>

          {/* Headline metrics. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <MetricCard
              icon="DollarSign"
              label="Total Cost"
              value={formatCost(totals.totalCost)}
            />
            <MetricCard
              icon="Activity"
              label="Total Runs"
              value={totals.totalRuns}
            />
            <MetricCard
              icon="Target"
              label="Avg Cache Hit"
              value={formatPct(totals.avgHit)}
            />
          </div>
        </>
      )}
    </Card>
  );
};

export default AgentCostPanel;
