/**
 * AgentComparisonTable
 * Compare two selected agents side by side using aggregated metrics from
 * `subagent.run` events in `<fluxDir>/events.jsonl`. Loads the unique agent
 * list on mount and recomputes per-agent stats whenever the selection changes.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatCost, formatTokens, formatPct } from "../lib/format";
import {
  parseEventsFileAsync,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { useDashboardStore } from "../store/dashboard-store";

/** Per-agent aggregated comparison stats. */
interface AgentStats {
  runs: number;
  totalCost: number;
  avgCost: number;
  avgHitRate: number;
  avgTurns: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  successes: number;
  failures: number;
  successRate: number;
}

/** Compute aggregated stats for a single agent from its raw events. */
function computeStats(events: SubagentRunEvent[]): AgentStats {
  const stats: AgentStats = {
    runs: 0,
    totalCost: 0,
    avgCost: 0,
    avgHitRate: 0,
    avgTurns: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    successes: 0,
    failures: 0,
    successRate: 0,
  };

  let hitRateSum = 0;
  let turnsSum = 0;

  for (const e of events) {
    stats.runs += 1;
    stats.totalCost += e.costUsd ?? 0;
    stats.totalInput += e.input ?? 0;
    stats.totalOutput += e.output ?? 0;
    stats.totalCacheRead += e.cacheRead ?? 0;
    hitRateSum += e.cacheHitRate ?? 0;
    turnsSum += e.turns ?? 0;

    if (e.exitCode === 0) {
      stats.successes += 1;
    } else {
      stats.failures += 1;
    }
  }

  const runs = stats.runs > 0 ? stats.runs : 1;
  stats.avgCost = stats.totalCost / runs;
  stats.avgHitRate = hitRateSum / runs;
  stats.avgTurns = turnsSum / runs;
  stats.successRate = stats.runs > 0 ? stats.successes / stats.runs : 0;
  return stats;
}

/** Success-rate badge color thresholds (ratio 0..1). */
function successRateColor(ratio: number): "green" | "amber" | "red" {
  if (ratio >= 0.9) return "green";
  if (ratio >= 0.7) return "amber";
  return "red";
}

/** Cache-hit badge color thresholds (ratio 0..1). */
function hitRateColor(ratio: number): "green" | "amber" | "red" {
  if (ratio >= 0.7) return "green";
  if (ratio >= 0.4) return "amber";
  return "red";
}

/** Metric row descriptor for the comparison table. */
interface MetricRow {
  label: string;
  valueA: React.ReactNode;
  valueB: React.ReactNode;
  /** Which side is better: 'A' | 'B' | null (tie / not applicable). */
  better: "A" | "B" | null;
}

const HIGHLIGHT = "bg-green-50 dark:bg-green-900/20";

export function AgentComparisonTable(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [agents, setAgents] = useState<string[]>([]);
  const [agentA, setAgentA] = useState<string>("");
  const [agentB, setAgentB] = useState<string>("");
  const [statsA, setStatsA] = useState<AgentStats | null>(null);
  const [statsB, setStatsB] = useState<AgentStats | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // All raw subagent.run events keyed by agent name, loaded once per fluxDir.
  const [eventsByAgent, setEventsByAgent] = useState<
    Map<string, SubagentRunEvent[]>
  >(new Map());

  // Load agents list on mount / when fluxDir changes.
  useEffect(() => {
    if (!fluxDir) {
      setAgents([]);
      setEventsByAgent(new Map());
      setAgentA("");
      setAgentB("");
      setStatsA(null);
      setStatsB(null);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        const all = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
        if (cancelled) return;
        const sub = all.filter(
          (e): e is SubagentRunEvent => e.type === "subagent.run",
        );

        const byAgent = new Map<string, SubagentRunEvent[]>();
        for (const e of sub) {
          const name = e.agent || "unknown";
          const arr = byAgent.get(name);
          if (arr) {
            arr.push(e);
          } else {
            byAgent.set(name, [e]);
          }
        }

        const names = Array.from(byAgent.keys()).sort();
        if (cancelled) return;
        setEventsByAgent(byAgent);
        setAgents(names);

        // Default-select the first two agents if available.
        setAgentA((prev) => (prev && names.includes(prev) ? prev : names[0] ?? ""));
        setAgentB((prev) =>
          prev && names.includes(prev)
            ? prev
            : names.length >= 2
              ? names[1]
              : names[0] ?? "",
        );
      } catch (err) {
        if (!cancelled) {
          console.warn("[flux] agent comparison load failed:", err);
          setAgents([]);
          setEventsByAgent(new Map());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [fluxDir]);

  // Recompute stats when selection or underlying events change.
  useEffect(() => {
    if (agentA && eventsByAgent.has(agentA)) {
      setStatsA(computeStats(eventsByAgent.get(agentA)!));
    } else {
      setStatsA(null);
    }

    if (agentB && eventsByAgent.has(agentB)) {
      setStatsB(computeStats(eventsByAgent.get(agentB)!));
    } else {
      setStatsB(null);
    }
  }, [agentA, agentB, eventsByAgent]);

  // Build comparison rows when both stats are available.
  const rows: MetricRow[] = useMemo(() => {
    if (!statsA || !statsB) return [];

    const betterNum = (a: number, b: number, lowerIsBetter: boolean) => {
      if (a === b) return null;
      if (lowerIsBetter) return a < b ? "A" : "B";
      return a > b ? "A" : "B";
    };

    const cell = (
      val: React.ReactNode,
      side: "A" | "B",
      better: "A" | "B" | null,
    ) => (
      <td
        className={`px-3 py-2 border-t border-slate-100 dark:border-slate-700 ${
          better === side ? HIGHLIGHT : ""
        }`}
      >
        {val}
      </td>
    );

    return [
      {
        label: "Runs",
        valueA: cell(statsA.runs, "A", betterNum(statsA.runs, statsB.runs, false)),
        valueB: cell(statsB.runs, "B", betterNum(statsA.runs, statsB.runs, false)),
        better: betterNum(statsA.runs, statsB.runs, false),
      },
      {
        label: "Success Rate",
        valueA: cell(
          <Badge color={successRateColor(statsA.successRate)}>
            {formatPct(statsA.successRate)}
          </Badge>,
          "A",
          betterNum(statsA.successRate, statsB.successRate, false),
        ),
        valueB: cell(
          <Badge color={successRateColor(statsB.successRate)}>
            {formatPct(statsB.successRate)}
          </Badge>,
          "B",
          betterNum(statsA.successRate, statsB.successRate, false),
        ),
        better: betterNum(statsA.successRate, statsB.successRate, false),
      },
      {
        label: "Avg Cost",
        valueA: cell(
          <span className="font-mono text-slate-800 dark:text-slate-100">
            {formatCost(statsA.avgCost)}
          </span>,
          "A",
          betterNum(statsA.avgCost, statsB.avgCost, true),
        ),
        valueB: cell(
          <span className="font-mono text-slate-800 dark:text-slate-100">
            {formatCost(statsB.avgCost)}
          </span>,
          "B",
          betterNum(statsA.avgCost, statsB.avgCost, true),
        ),
        better: betterNum(statsA.avgCost, statsB.avgCost, true),
      },
      {
        label: "Avg Cache Hit",
        valueA: cell(
          <Badge color={hitRateColor(statsA.avgHitRate)}>
            {formatPct(statsA.avgHitRate)}
          </Badge>,
          "A",
          betterNum(statsA.avgHitRate, statsB.avgHitRate, false),
        ),
        valueB: cell(
          <Badge color={hitRateColor(statsB.avgHitRate)}>
            {formatPct(statsB.avgHitRate)}
          </Badge>,
          "B",
          betterNum(statsA.avgHitRate, statsB.avgHitRate, false),
        ),
        better: betterNum(statsA.avgHitRate, statsB.avgHitRate, false),
      },
      {
        label: "Avg Turns",
        valueA: cell(
          <span className="text-slate-700 dark:text-slate-200">
            {statsA.avgTurns.toFixed(1)}
          </span>,
          "A",
          betterNum(statsA.avgTurns, statsB.avgTurns, true),
        ),
        valueB: cell(
          <span className="text-slate-700 dark:text-slate-200">
            {statsB.avgTurns.toFixed(1)}
          </span>,
          "B",
          betterNum(statsA.avgTurns, statsB.avgTurns, true),
        ),
        better: betterNum(statsA.avgTurns, statsB.avgTurns, true),
      },
      {
        label: "Total Input",
        valueA: cell(
          <span className="text-slate-600 dark:text-slate-300">
            {formatTokens(statsA.totalInput)}
          </span>,
          "A",
          betterNum(statsA.totalInput, statsB.totalInput, true),
        ),
        valueB: cell(
          <span className="text-slate-600 dark:text-slate-300">
            {formatTokens(statsB.totalInput)}
          </span>,
          "B",
          betterNum(statsA.totalInput, statsB.totalInput, true),
        ),
        better: betterNum(statsA.totalInput, statsB.totalInput, true),
      },
      {
        label: "Total Output",
        valueA: cell(
          <span className="text-slate-600 dark:text-slate-300">
            {formatTokens(statsA.totalOutput)}
          </span>,
          "A",
          betterNum(statsA.totalOutput, statsB.totalOutput, false),
        ),
        valueB: cell(
          <span className="text-slate-600 dark:text-slate-300">
            {formatTokens(statsB.totalOutput)}
          </span>,
          "B",
          betterNum(statsA.totalOutput, statsB.totalOutput, false),
        ),
        better: betterNum(statsA.totalOutput, statsB.totalOutput, false),
      },
      {
        label: "Total Cache Read",
        valueA: cell(
          <span className="text-slate-600 dark:text-slate-300">
            {formatTokens(statsA.totalCacheRead)}
          </span>,
          "A",
          betterNum(statsA.totalCacheRead, statsB.totalCacheRead, false),
        ),
        valueB: cell(
          <span className="text-slate-600 dark:text-slate-300">
            {formatTokens(statsB.totalCacheRead)}
          </span>,
          "B",
          betterNum(statsA.totalCacheRead, statsB.totalCacheRead, false),
        ),
        better: betterNum(statsA.totalCacheRead, statsB.totalCacheRead, false),
      },
      {
        label: "Failures",
        valueA: cell(
          <span
            className={
              statsA.failures > 0
                ? "text-red-600 dark:text-red-400 font-medium"
                : "text-slate-500 dark:text-slate-400"
            }
          >
            {statsA.failures}
          </span>,
          "A",
          betterNum(statsA.failures, statsB.failures, true),
        ),
        valueB: cell(
          <span
            className={
              statsB.failures > 0
                ? "text-red-600 dark:text-red-400 font-medium"
                : "text-slate-500 dark:text-slate-400"
            }
          >
            {statsB.failures}
          </span>,
          "B",
          betterNum(statsA.failures, statsB.failures, true),
        ),
        better: betterNum(statsA.failures, statsB.failures, true),
      },
    ];
  }, [statsA, statsB]);

  // Cost-difference summary line.
  const costSummary = useMemo(() => {
    if (!statsA || !statsB) return null;
    if (statsB.avgCost === 0 && statsA.avgCost === 0) {
      return "Both agents have zero average cost.";
    }
    if (statsB.avgCost === 0) {
      return `Agent A has non-zero cost while Agent B has zero cost.`;
    }
    const diff = (statsA.avgCost - statsB.avgCost) / statsB.avgCost;
    if (diff === 0) return "Both agents have equal average cost.";
    const more = diff > 0;
    const pct = Math.abs(diff * 100).toFixed(1);
    const name = more ? "Agent A" : "Agent B";
    return `${name} costs ${pct}% ${more ? "more" : "less"} than ${
      more ? "Agent B" : "Agent A"
    }`;
  }, [statsA, statsB]);

  const selectClass =
    "w-full rounded-lg bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-800 dark:text-slate-200">
          <Icon
            name="GitCompare"
            size={20}
            className="text-slate-500 dark:text-slate-400"
          />
          Agent Comparison
        </h3>
        {loading ? (
          <Badge color="slate">loading</Badge>
        ) : (
          <Badge color="slate">{agents.length} agents</Badge>
        )}
      </div>

      {agents.length < 2 ? (
        <EmptyState
          icon="GitCompare"
          message="Need at least 2 agents for comparison"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500 dark:text-slate-400">
                Agent A
              </label>
              <select
                value={agentA}
                onChange={(e) => setAgentA(e.target.value)}
                className={selectClass}
              >
                {agents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500 dark:text-slate-400">
                Agent B
              </label>
              <select
                value={agentB}
                onChange={(e) => setAgentB(e.target.value)}
                className={selectClass}
              >
                {agents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {statsA && statsB ? (
            <>
              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                <table className="w-full text-sm text-slate-700 dark:text-slate-200">
                  <thead>
                    <tr>
                      <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 w-1/3">
                        Metric
                      </th>
                      <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 w-1/3">
                        {agentA}
                      </th>
                      <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2 w-1/3">
                        {agentB}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700 text-slate-600 dark:text-slate-300">
                          {r.label}
                        </td>
                        {r.valueA}
                        {r.valueB}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {costSummary ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {costSummary}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-slate-400 dark:text-slate-500">
              Select two agents to compare.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export default AgentComparisonTable;
