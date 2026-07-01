/**
 * Workflow Statistics — aggregate metrics across all DAG, M6 and team
 * executions. Reads subagent.run events from events.jsonl, filters by agent
 * names prefixed with `dag-`, `m6-` or `team-`, and renders a grid of metric
 * cards plus a model distribution breakdown.
 *
 * Polls the events file every 15 seconds.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFile,
  filterByType,
  type AnyEvent,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatCost, formatPct } from "../lib/format";

/** Aggregate statistics derived from workflow subagent.run events. */
interface WorkflowStatsState {
  totalRuns: number;
  dagRuns: number;
  m6Runs: number;
  teamRuns: number;
  totalCost: number;
  avgCost: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  models: Map<string, number>;
  avgTurns: number;
}

const EMPTY_STATS: WorkflowStatsState = {
  totalRuns: 0,
  dagRuns: 0,
  m6Runs: 0,
  teamRuns: 0,
  totalCost: 0,
  avgCost: 0,
  successCount: 0,
  failureCount: 0,
  successRate: 0,
  models: new Map(),
  avgTurns: 0,
};

const WORKFLOW_PREFIXES = ["dag-", "m6-", "team-"] as const;

function isWorkflowAgent(agent: string): boolean {
  return WORKFLOW_PREFIXES.some((p) => agent.startsWith(p));
}

function classifyAgent(agent: string): "dag" | "m6" | "team" | null {
  if (agent.startsWith("dag-")) return "dag";
  if (agent.startsWith("m6-")) return "m6";
  if (agent.startsWith("team-")) return "team";
  return null;
}

function computeStats(runs: SubagentRunEvent[]): WorkflowStatsState {
  if (runs.length === 0) return { ...EMPTY_STATS, models: new Map() };

  let dagRuns = 0;
  let m6Runs = 0;
  let teamRuns = 0;
  let totalCost = 0;
  let successCount = 0;
  let failureCount = 0;
  let totalTurns = 0;
  const models = new Map<string, number>();

  for (const r of runs) {
    const kind = classifyAgent(r.agent);
    if (kind === "dag") dagRuns++;
    else if (kind === "m6") m6Runs++;
    else if (kind === "team") teamRuns++;

    totalCost += r.costUsd ?? 0;
    totalTurns += r.turns ?? 0;

    if (r.exitCode === 0) successCount++;
    else failureCount++;

    const model = r.model || "unknown";
    models.set(model, (models.get(model) ?? 0) + 1);
  }

  const totalRuns = runs.length;
  return {
    totalRuns,
    dagRuns,
    m6Runs,
    teamRuns,
    totalCost,
    avgCost: totalRuns > 0 ? totalCost / totalRuns : 0,
    successCount,
    failureCount,
    successRate: totalRuns > 0 ? successCount / totalRuns : 0,
    models,
    avgTurns: totalRuns > 0 ? totalTurns / totalRuns : 0,
  };
}

/** Pick a Badge color for a success rate ratio (0..1). */
function successRateColor(rate: number): "green" | "amber" | "red" {
  if (rate >= 0.9) return "green";
  if (rate >= 0.7) return "amber";
  return "red";
}

/** Small labelled metric tile used inside the stats grid. */
function StatTile({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">
        {children}
      </div>
    </div>
  );
}

export function WorkflowStats(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setEvents([]);
      setLoading(false);
      return;
    }
    try {
      const filePath = `${fluxDir}/events.jsonl`;
      const parsed = await parseEventsFile(filePath);
      setEvents(parsed);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const workflowRuns = useMemo<SubagentRunEvent[]>(
    () =>
      (filterByType(events, "subagent.run") as SubagentRunEvent[]).filter((r) =>
        isWorkflowAgent(r.agent),
      ),
    [events],
  );

  const stats = useMemo<WorkflowStatsState>(
    () => computeStats(workflowRuns),
    [workflowRuns],
  );

  const modelEntries = useMemo<[string, number][]>(
    () => Array.from(stats.models.entries()).sort((a, b) => b[1] - a[1]),
    [stats.models],
  );

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Activity" size={20} className="text-blue-500" />
        <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-200">
          Workflow Statistics
        </h3>
      </div>

      {loading ? (
        <div className="h-32 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : stats.totalRuns === 0 ? (
        <EmptyState icon="Activity" message="No workflow data yet" />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="Total Workflow Runs">
              {stats.totalRuns}
            </StatTile>
            <StatTile label="Success Rate">
              <Badge color={successRateColor(stats.successRate)}>
                {formatPct(stats.successRate)}
              </Badge>
            </StatTile>
            <StatTile label="Total Cost">{formatCost(stats.totalCost)}</StatTile>
            <StatTile label="Avg Cost per Run">
              {formatCost(stats.avgCost)}
            </StatTile>
            <StatTile label="DAG Runs">{stats.dagRuns}</StatTile>
            <StatTile label="M6 Runs">{stats.m6Runs}</StatTile>
            <StatTile label="Team Runs">{stats.teamRuns}</StatTile>
            <StatTile label="Avg Turns">
              {stats.avgTurns.toFixed(1)}
            </StatTile>
          </div>

          {modelEntries.length > 0 ? (
            <div className="mt-4">
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                Model Distribution
              </div>
              <div className="flex flex-wrap gap-2">
                {modelEntries.map(([model, count]) => (
                  <Badge key={model} color="slate">
                    {model}: {count}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
