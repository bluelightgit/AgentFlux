/**
 * AgentTimelineGantt — horizontal Gantt chart of agent execution timing.
 *
 * Reads `subagent.run` events from `${fluxDir}/events.jsonl`, using each
 * event's timestamp as the bar start and estimating the end as
 * `start + turns * 5000ms` (5s per turn estimate). Bars are colored by
 * model family and laid out along a shared time axis.
 *
 * Data is loaded on mount and polled every 10 seconds.
 */
import React, { useEffect, useState } from "react";
import { Card, Icon, EmptyState } from "./ui";
import { formatTime, formatCost } from "../lib/format";
import { parseEventsFileAsync, type SubagentRunEvent } from "../lib/events-parser";
import { useDashboardStore } from "../store/dashboard-store";

// ---------------------------------------------------------------------------
// Polling interval for re-reading events.jsonl.
// ---------------------------------------------------------------------------
const POLL_INTERVAL_MS = 10_000;

/** Estimated duration of a single agent turn (ms). */
const TURN_DURATION_MS = 5000;

/** Maximum number of agents to display (most recent first). */
const MAX_AGENTS = 15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentBar {
  name: string;
  startTs: number;
  endTs: number;
  cost: number;
  model: string;
  turns: number;
}

// ---------------------------------------------------------------------------
// Color map
// ---------------------------------------------------------------------------

/** Tailwind background class keyed by model family (lowercased substring match). */
function modelBarClass(model: string): string {
  const m = (model ?? "").toLowerCase();
  if (m.includes("deepseek")) return "bg-blue-500";
  if (m.includes("glm")) return "bg-purple-500";
  if (m.includes("gpt")) return "bg-amber-500";
  return "bg-slate-500";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentTimelineGantt(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [agents, setAgents] = useState<AgentBar[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!fluxDir) {
        if (!cancelled) setAgents([]);
        return;
      }
      if (!cancelled) setLoading(true);
      try {
        const all = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
        if (cancelled) return;
        const runs = all.filter(
          (e): e is SubagentRunEvent => e.type === "subagent.run",
        );
        const bars: AgentBar[] = runs.map((e) => ({
          name: e.agent,
          startTs: e.ts,
          endTs: e.ts + (e.turns ?? 0) * TURN_DURATION_MS,
          cost: e.costUsd ?? 0,
          model: e.model,
          turns: e.turns ?? 0,
        }));
        // Sort by startTs descending (most recent at top), keep last 15.
        bars.sort((a, b) => b.startTs - a.startTs);
        if (!cancelled) setAgents(bars.slice(0, MAX_AGENTS));
      } catch {
        if (!cancelled) setAgents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fluxDir]);

  // Axis bounds across all visible bars.
  const minTs = agents.length ? Math.min(...agents.map((a) => a.startTs)) : 0;
  const maxTs = agents.length ? Math.max(...agents.map((a) => a.endTs)) : 0;
  const span = maxTs - minTs || 1;

  return (
    <Card className="text-slate-800 dark:text-slate-200">
      <div className="mb-4 flex items-center gap-2">
        <Icon name="GanttChart" size={20} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Execution Timeline
        </h3>
        {loading ? (
          <Icon name="Loader2" size={16} className="ml-auto animate-spin text-slate-400 dark:text-slate-500" />
        ) : null}
      </div>

      {agents.length === 0 ? (
        <EmptyState
          icon="GanttChart"
          message="No execution timeline data yet"
        />
      ) : (
        <div className="flex flex-col gap-1">
          {/* Time axis labels */}
          <div className="flex items-center justify-between pl-36 pr-1 mb-1">
            <span className="text-xs text-slate-400 dark:text-slate-500">
              {formatTime(minTs)}
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500">
              {formatTime(maxTs)}
            </span>
          </div>

          {/* Rows */}
          {agents.map((a, i) => {
            const leftPct = ((a.startTs - minTs) / span) * 100;
            const widthPct = Math.max(
              ((a.endTs - a.startTs) / span) * 100,
              1,
            );
            return (
              <div key={`${a.name}-${i}`} className="flex items-center gap-2">
                <div className="w-32 shrink-0 text-sm text-slate-700 dark:text-slate-300 truncate">
                  {a.name}
                </div>
                <div className="relative h-6 flex-1 rounded bg-slate-100 dark:bg-slate-900/40">
                  <div
                    className={`absolute h-6 rounded ${modelBarClass(a.model)} hover:opacity-80`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    title={`${a.model} · ${a.turns} turn${a.turns === 1 ? "" : "s"} · ${formatCost(a.cost)}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default AgentTimelineGantt;
