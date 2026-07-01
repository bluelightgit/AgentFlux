/**
 * Agent Workflow Timeline — Gantt-style timeline showing when each agent was
 * active. Reads subagent.run events from events.jsonl, groups them by agent
 * name, and renders a horizontal colored bar per run positioned along a shared
 * time axis (earliest -> latest event).
 *
 * Bar color: green (#22c55e) when exitCode === 0, red (#ef4444) otherwise.
 * Hovering a bar shows a tooltip with agent, turns, cost and cache hit rate.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFileAsync,
  filterByType,
  type AnyEvent,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { Card, Icon, EmptyState } from "./ui";
import { formatCost, formatTime } from "../lib/format";

/** A run positioned along the global time axis. */
interface PositionedRun {
  key: string;
  agent: string;
  ts: number;
  /** Fractional left offset [0,1] within the timeline. */
  left: number;
  /** Fractional width [0,1] within the timeline. */
  width: number;
  exitCode: number;
  turns: number;
  costUsd: number;
  cacheHitRate: number;
}

/** Per-agent row in the Gantt chart. */
interface AgentRow {
  agent: string;
  runs: PositionedRun[];
}

/** Group tooltip payload. */
interface BarTooltipData {
  agent: string;
  turns: number;
  costUsd: number;
  cacheHitRate: number;
  exitCode: number;
  ts: number;
}

function BarTooltip({ data }: { data: BarTooltipData }): React.ReactElement {
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow px-3 py-2 text-xs space-y-0.5">
      <div className="font-semibold text-slate-800 dark:text-slate-100">{data.agent}</div>
      <div className="text-slate-500 dark:text-slate-400">Time: {formatTime(data.ts)}</div>
      <div className="text-slate-500 dark:text-slate-400">Turns: {data.turns}</div>
      <div className="text-slate-500 dark:text-slate-400">Cost: {formatCost(data.costUsd)}</div>
      <div className="text-slate-500 dark:text-slate-400">
        Cache hit: {data.cacheHitRate != null ? `${(data.cacheHitRate * 100).toFixed(1)}%` : "-"}
      </div>
      <div className="text-slate-500 dark:text-slate-400">
        Exit: <span className={data.exitCode === 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>{data.exitCode}</span>
      </div>
    </div>
  );
}

export function AgentWorkflowTimeline(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [hover, setHover] = useState<{ run: PositionedRun; x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setEvents([]);
      setLoading(false);
      return;
    }
    try {
      const filePath = `${fluxDir}/events.jsonl`;
      const parsed = await parseEventsFileAsync(filePath);
      setEvents(parsed);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, [load]);

  // Filter to subagent.run events and take the last 50.
  const runs = useMemo<SubagentRunEvent[]>(
    () => filterByType(events, "subagent.run") as SubagentRunEvent[],
    [events],
  );

  const recentRuns = useMemo<SubagentRunEvent[]>(
    () => runs.slice(-50),
    [runs],
  );

  const rows = useMemo<AgentRow[]>(() => {
    if (recentRuns.length === 0) return [];
    const minTs = Math.min(...recentRuns.map((r) => r.ts));
    const maxTs = Math.max(...recentRuns.map((r) => r.ts));
    const span = Math.max(maxTs - minTs, 1);

    const positioned: PositionedRun[] = recentRuns.map((r, i) => {
      const left = (r.ts - minTs) / span;
      // Width: proportional to a notional duration if we can infer one from
      // neighboring runs, otherwise a fixed minimum slice so the bar is
      // visible. We don't have explicit end timestamps, so use a small fixed
      // fraction (1.5%) clamped so bars never vanish.
      const next = recentRuns[i + 1];
      const width = next ? Math.max((next.ts - r.ts) / span, 0.01) : 0.015;
      return {
        key: `${r.agent}-${r.ts}-${i}`,
        agent: r.agent,
        ts: r.ts,
        left,
        width: Math.min(width, 1 - left),
        exitCode: r.exitCode,
        turns: r.turns,
        costUsd: r.costUsd,
        cacheHitRate: r.cacheHitRate,
      };
    });

    // Group by agent preserving first-seen order.
    const order: string[] = [];
    const byAgent = new Map<string, PositionedRun[]>();
    for (const p of positioned) {
      if (!byAgent.has(p.agent)) {
        byAgent.set(p.agent, []);
        order.push(p.agent);
      }
      byAgent.get(p.agent)!.push(p);
    }
    return order.map((agent) => ({ agent, runs: byAgent.get(agent)! }));
  }, [recentRuns]);

  const minTs = useMemo(
    () => (recentRuns.length ? Math.min(...recentRuns.map((r) => r.ts)) : 0),
    [recentRuns],
  );
  const maxTs = useMemo(
    () => (recentRuns.length ? Math.max(...recentRuns.map((r) => r.ts)) : 0),
    [recentRuns],
  );

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon name="GanttChart" size={20} className="text-blue-500" />
        <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-200">
          Agent Workflow Timeline
        </h3>
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : recentRuns.length === 0 ? (
        <EmptyState icon="GanttChart" message="No agent runs yet" />
      ) : (
        <div className="max-h-96 overflow-y-auto">
          {/* Time axis labels */}
          <div className="flex items-center gap-2 mb-2 pl-32">
            <div className="flex-1 flex justify-between text-[10px] text-slate-400 dark:text-slate-500">
              <span>{formatTime(minTs)}</span>
              <span>{formatTime((minTs + maxTs) / 2)}</span>
              <span>{formatTime(maxTs)}</span>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            {rows.map((row) => (
              <div key={row.agent} className="flex items-center gap-2">
                <div className="w-32 shrink-0 truncate text-xs text-slate-600 dark:text-slate-300" title={row.agent}>
                  {row.agent}
                </div>
                <div className="flex-1 relative h-6 bg-slate-100 dark:bg-slate-900/40 rounded">
                  {row.runs.map((run) => {
                    const isOk = run.exitCode === 0;
                    const bg = isOk ? "#22c55e" : "#ef4444";
                    return (
                      <div
                        key={run.key}
                        className="absolute rounded cursor-pointer transition-opacity hover:opacity-80"
                        style={{
                          left: `${run.left * 100}%`,
                          width: `${Math.max(run.width * 100, 1)}%`,
                          height: 20,
                          top: "50%",
                          transform: "translateY(-50%)",
                          backgroundColor: bg,
                        }}
                        onMouseEnter={(e) => {
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setHover({ run, x: rect.left, y: rect.top });
                        }}
                        onMouseLeave={() => setHover(null)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 mt-3 pl-32 text-xs text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1">
              <span className="inline-block rounded" style={{ width: 10, height: 10, backgroundColor: "#22c55e" }} />
              Success
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block rounded" style={{ width: 10, height: 10, backgroundColor: "#ef4444" }} />
              Failed
            </span>
            <span className="ml-auto text-slate-400 dark:text-slate-500">
              Showing last {recentRuns.length} run{recentRuns.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}

      {hover ? (
        <>
          {/* invisible overlay to capture leave when moving between tooltip and bar */}
          <div
            className="fixed inset-0 z-40"
            onMouseMove={() => setHover(null)}
          />
          <div
            className="fixed z-50 pointer-events-none"
            style={{
              left: hover.x,
              top: hover.y - 8,
              transform: "translate(-50%, -100%)",
            }}
          >
            <BarTooltip
              data={{
                agent: hover.run.agent,
                turns: hover.run.turns,
                costUsd: hover.run.costUsd,
                cacheHitRate: hover.run.cacheHitRate,
                exitCode: hover.run.exitCode,
                ts: hover.run.ts,
              }}
            />
          </div>
        </>
      ) : null}
    </Card>
  );
}
