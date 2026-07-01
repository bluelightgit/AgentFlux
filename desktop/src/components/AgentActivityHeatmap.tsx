/**
 * Agent Activity Heatmap — calendar-style heatmap showing when agents
 * were active, broken down by hour of day (0-23).
 *
 * Reads `subagent.run` events from `${fluxDir}/events.jsonl`, extracts the
 * hour-of-day from each event's timestamp, and aggregates run count and
 * cost per hour. Renders a horizontal 24-cell heatmap with intensity based
 * on run count, plus summary stats (peak hour, total runs, avg runs/hour).
 *
 * Loads on mount and polls every 30s.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFile,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { Card, Icon, EmptyState } from "./ui";
import { formatCost } from "../lib/format";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Per-hour aggregate cell. */
interface HourBucket {
  hour: number;
  count: number;
  cost: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build an empty 24-hour bucket array (0..23). */
function emptyHours(): HourBucket[] {
  const out: HourBucket[] = [];
  for (let h = 0; h < 24; h++) {
    out.push({ hour: h, count: 0, cost: 0 });
  }
  return out;
}

/** Background color class for a cell based on its run count. */
function cellColor(count: number): string {
  if (count <= 0) return "bg-slate-100 dark:bg-slate-800";
  if (count <= 2) return "bg-blue-200 dark:bg-blue-900/60";
  if (count <= 5) return "bg-blue-400 dark:bg-blue-700";
  return "bg-blue-600 dark:bg-blue-500";
}

// ─── Component ─────────────────────────────────────────────────────────────

export function AgentActivityHeatmap(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [hours, setHours] = useState<HourBucket[]>(emptyHours);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setHours(emptyHours());
      setLoading(false);
      return;
    }
    try {
      const parsed = await parseEventsFile(`${fluxDir}/events.jsonl`);
      const runs = filterByType(parsed, "subagent.run") as SubagentRunEvent[];

      const buckets = emptyHours();
      for (const r of runs) {
        if (typeof r.ts !== "number" || !isFinite(r.ts)) continue;
        const h = new Date(r.ts).getHours();
        if (h < 0 || h > 23) continue;
        buckets[h].count += 1;
        buckets[h].cost += r.costUsd ?? 0;
      }
      setHours(buckets);
    } catch {
      setHours(emptyHours());
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  // Load on mount and poll every 30s.
  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const totalRuns = hours.reduce((s, b) => s + b.count, 0);
  const peak = hours.reduce(
    (best, b) => (b.count > best.count ? b : best),
    hours[0],
  );
  const avgPerHour = totalRuns / 24;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon
          name="CalendarClock"
          size={20}
          className="text-slate-500 dark:text-slate-400"
        />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Agent Activity Heatmap
        </h3>
        {loading ? (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
            Loading...
          </span>
        ) : (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
            {totalRuns} run{totalRuns === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {loading ? (
        <div className="h-32 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : totalRuns === 0 ? (
        <EmptyState icon="CalendarClock" message="No activity data yet" />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Horizontal 24-cell heatmap */}
          <div className="overflow-x-auto">
            <div className="flex gap-1 min-w-max">
              {hours.map((b) => (
                <div key={b.hour} className="flex flex-col items-center gap-1">
                  <div
                    className={`w-8 h-8 rounded ${cellColor(b.count)}`}
                    title={`${b.hour}:00 - ${b.count} runs, ${formatCost(
                      b.cost,
                    )}`}
                  />
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {b.hour}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Peak hour
              </div>
              <div className="mt-1 text-sm font-medium text-slate-800 dark:text-slate-200">
                {peak.hour}:00{" "}
                <span className="text-slate-500 dark:text-slate-400">
                  ({peak.count} runs)
                </span>
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Total runs
              </div>
              <div className="mt-1 text-sm font-medium text-slate-800 dark:text-slate-200">
                {totalRuns}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Avg runs/hour
              </div>
              <div className="mt-1 text-sm font-medium text-slate-800 dark:text-slate-200">
                {avgPerHour.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default AgentActivityHeatmap;
