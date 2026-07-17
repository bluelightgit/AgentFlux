/**
 * Compact real-time cost counter for the TopBar.
 *
 * Reads `events.jsonl` every 5s and surfaces a running total of agent
 * spend derived from `subagent.run` events (the per-run subagent cost
 * field `costUsd`). Main-agent cost lives in `cache.sample` events but
 * those use a v2 delta format that may be unreliable, so for now the
 * widget only reports the subagent cost — which is the meaningful
 * billable figure for dispatched agent runs.
 *
 * Layout is a compact inline pill (NOT a Card) designed to sit inside
 * the TopBar alongside other indicators.
 */
import React, { useEffect, useState } from "react";
import { Icon } from "./ui";
import { formatCost } from "../lib/format";
import {
  parseEventsFileAsync,
  type AnyEvent,
} from "../lib/events-parser";
import { useDashboardStore } from "../store/dashboard-store";

// Polling interval for re-reading events.jsonl.
const POLL_INTERVAL_MS = 5_000;

/**
 * Tally subagent costs and run counts from the parsed event stream.
 * Only `subagent.run` events are counted (see module docstring).
 */
function computeCost(events: AnyEvent[]): {
  subagentCost: number;
  runCount: number;
} {
  let subagentCost = 0;
  let runCount = 0;

  for (const e of events) {
    if (e.type === "subagent.run") {
      subagentCost += e.costUsd ?? 0;
      runCount += 1;
    }
  }

  return { subagentCost, runCount };
}

export function RealTimeCostCounter(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [subagentCost, setSubagentCost] = useState<number>(0);
  const [runCount, setRunCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);

  // Poll events.jsonl for cost updates.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!fluxDir) {
        if (!cancelled) {
          setSubagentCost(0);
          setRunCount(0);
          setLoading(false);
        }
        return;
      }
      try {
        const events = await parseEventsFileAsync(
          `${fluxDir}/events.jsonl`,
        );
        if (cancelled) return;
        const { subagentCost: sub, runCount: runs } =
          computeCost(events);
        setSubagentCost(sub);
        setRunCount(runs);
        setLoading(false);
      } catch {
        // File may not exist yet or be mid-write; treat as no data.
        if (!cancelled) {
          setSubagentCost(0);
          setRunCount(0);
          setLoading(false);
        }
      }
    };

    // Initial load, then poll on the configured interval.
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fluxDir]);

  const tooltipText = loading
    ? "Reading events.jsonl for cost data..."
    : runCount === 0
      ? "No subagent.run events found in events.jsonl"
      : `Tracked subagent cost: $${subagentCost.toFixed(4)} from ${runCount} ${runCount === 1 ? "run" : "runs"}`;

  // Muted styling when no events are available
  const hasNoData = !loading && runCount === 0;
  const costClass = loading
    ? "text-slate-500 dark:text-slate-400"
    : hasNoData
      ? "text-slate-400 dark:text-slate-500"
      : "text-slate-800 dark:text-slate-100";
  const labelClass = hasNoData
    ? "text-slate-400 dark:text-slate-500"
    : "text-slate-500 dark:text-slate-400";

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800"
      title={tooltipText}
      aria-label={tooltipText}
    >
      <Icon
        name="DollarSign"
        size={16}
        className={`${hasNoData ? "text-slate-400 dark:text-slate-500" : "text-green-600 dark:text-green-400"}`}
      />
      <span className={`text-xs whitespace-nowrap ${labelClass}`}>Tracked subagent cost</span>
      <span className={`font-mono text-sm font-bold ${costClass}`}>
        {loading ? "—" : formatCost(subagentCost)}
      </span>
      {!loading && (
        <span className="text-xs text-slate-400">
          ({runCount} {runCount === 1 ? "run" : "runs"})
        </span>
      )}
    </div>
  );
}

export default RealTimeCostCounter;
