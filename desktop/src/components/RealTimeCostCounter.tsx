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
  type SubagentRunEvent,
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
  totalCost: number;
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

  // For now total cost == subagent cost. Main-agent cache.sample costs
  // are intentionally excluded (unreliable v2 delta format).
  const totalCost = subagentCost;

  return { totalCost, subagentCost, runCount };
}

export function RealTimeCostCounter(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [totalCost, setTotalCost] = useState<number>(0);
  const [subagentCost, setSubagentCost] = useState<number>(0);
  const [runCount, setRunCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);

  // Poll events.jsonl for cost updates.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!fluxDir) {
        if (!cancelled) {
          setTotalCost(0);
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
        const { totalCost: total, subagentCost: sub, runCount: runs } =
          computeCost(events);
        setTotalCost(total);
        setSubagentCost(sub);
        setRunCount(runs);
        setLoading(false);
      } catch {
        // File may not exist yet or be mid-write; ignore and retry next tick.
        if (!cancelled) {
          setTotalCost(0);
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

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800">
      <Icon
        name="DollarSign"
        size={16}
        className="text-green-600 dark:text-green-400"
      />
      <span className="font-mono text-sm font-bold text-slate-800 dark:text-slate-100">
        {loading ? "—" : formatCost(totalCost)}
      </span>
      <span className="text-slate-400 text-xs">/</span>
      <span className="text-xs text-slate-500 dark:text-slate-400">
        ({formatCost(subagentCost)})
      </span>
      <span className="text-slate-400 text-xs">|</span>
      <span className="text-xs text-slate-500 dark:text-slate-400">
        {runCount} runs
      </span>
    </div>
  );
}

export default RealTimeCostCounter;
