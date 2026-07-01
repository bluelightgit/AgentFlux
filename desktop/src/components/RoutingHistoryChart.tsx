/**
 * Routing History chart.
 *
 * Visualises `routing.decision` events (from `${fluxDir}/events.jsonl`) over
 * time. The top section is a vertical list of the most recent 20 routing
 * decisions — each row showing timestamp, mode badge, preset, confidence
 * (color-coded), and stage. The bottom section is a simple div-based bar
 * chart showing the distribution of modes across all recorded decisions.
 *
 * Polls events.jsonl every 10s for near-real-time updates.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatTs, formatPct } from "../lib/format";
import {
  parseEventsFileAsync,
  type AnyEvent,
  type RoutingDecisionEvent,
} from "../lib/events-parser";
import { useDashboardStore } from "../store/dashboard-store";

// Polling interval for re-reading events.jsonl.
const POLL_INTERVAL_MS = 10_000;

// How many recent decisions to render in the list.
const RECENT_LIMIT = 20;

// ─── Mode → color mapping ──────────────────────────────────────────────────

type ModeColor = {
  badge: "slate" | "blue" | "green" | "amber" | "purple" | "pink";
  bar: string; // solid tailwind bg class for the bar chart fill
};

const MODE_COLORS: Record<string, ModeColor> = {
  M1: { badge: "slate", bar: "bg-slate-500" },
  M2: { badge: "blue", bar: "bg-blue-500" },
  M3: { badge: "green", bar: "bg-green-500" },
  M4: { badge: "amber", bar: "bg-amber-500" },
  M5: { badge: "purple", bar: "bg-purple-500" },
  M6: { badge: "pink", bar: "bg-pink-500" },
};

/**
 * Resolve the color set for a mode string. Matches the leading `M\d` token
 * (e.g. "M3-extended" → "M3"); falls back to slate when unknown.
 */
function modeColor(mode: string): ModeColor {
  const key = /^M\d/i.exec(mode)?.[0]?.toUpperCase();
  if (key && MODE_COLORS[key]) return MODE_COLORS[key];
  return { badge: "slate", bar: "bg-slate-500" };
}

// ─── Confidence coloring ───────────────────────────────────────────────────

function confidenceClass(c: number): string {
  if (c > 0.8) return "text-green-600 dark:text-green-400";
  if (c > 0.5) return "text-blue-600 dark:text-blue-400";
  return "text-amber-600 dark:text-amber-400";
}

// ─── Component ─────────────────────────────────────────────────────────────

export function RoutingHistoryChart(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Load + poll events.jsonl.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!fluxDir) {
        if (!cancelled) {
          setEvents([]);
          setLoading(false);
        }
        return;
      }
      try {
        const all = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
        if (cancelled) return;
        setEvents(all);
      } catch {
        if (!cancelled) setEvents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fluxDir]);

  // Filter + sort routing decisions (newest last; we slice the tail).
  const decisions = useMemo<RoutingDecisionEvent[]>(() => {
    return events
      .filter((e): e is RoutingDecisionEvent => e.type === "routing.decision")
      .sort((a, b) => a.ts - b.ts);
  }, [events]);

  // Most recent N (newest at the bottom of the list).
  const recent = useMemo(
    () => decisions.slice(-RECENT_LIMIT),
    [decisions],
  );

  // Mode distribution across ALL decisions (for the bar chart).
  const distribution = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of decisions) {
      const key = /^M\d/i.exec(d.mode)?.[0]?.toUpperCase() ?? d.mode;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Sort modes M1..M6 then any others alphabetically.
    const entries = Array.from(counts.entries());
    entries.sort((a, b) => {
      const ai = /^M(\d)$/i.exec(a[0]);
      const bi = /^M(\d)$/i.exec(b[0]);
      if (ai && bi) return Number(ai[1]) - Number(bi[1]);
      if (ai) return -1;
      if (bi) return 1;
      return a[0].localeCompare(b[0]);
    });
    return entries;
  }, [decisions]);

  const maxCount = distribution.reduce((m, [, c]) => Math.max(m, c), 0);

  return (
    <Card className="text-slate-800 dark:text-slate-200">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Route" size={20} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Routing History
        </h3>
        <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
          {loading ? "Loading…" : "Updated"}
        </span>
      </div>

      {decisions.length === 0 ? (
        <EmptyState icon="Route" message="No routing decisions yet" />
      ) : (
        <>
          {/* Recent decisions list */}
          <ul className="flex flex-col gap-2 max-h-96 overflow-y-auto pr-1">
            {recent.map((d, i) => {
              const mc = modeColor(d.mode);
              return (
                <li
                  key={`${d.ts}-${i}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2"
                >
                  <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums">
                    {formatTs(d.ts)}
                  </span>
                  <Badge color={mc.badge}>{d.mode}</Badge>
                  <span className="text-sm text-slate-700 dark:text-slate-200">
                    {d.preset || "-"}
                  </span>
                  <span
                    className={`text-xs font-medium tabular-nums ${confidenceClass(d.confidence)}`}
                  >
                    {formatPct(d.confidence)}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {d.stage || "-"}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* Mode distribution bar chart */}
          <div className="mt-5">
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">
              Mode Distribution
            </div>
            {maxCount > 0 ? (
              <div className="flex flex-col gap-1.5">
                {distribution.map(([mode, count]) => {
                  const mc = modeColor(mode);
                  const widthPct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  return (
                    <div key={mode} className="flex items-center gap-2">
                      <span className="w-10 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        {mode}
                      </span>
                      <div className="flex-1 h-4 rounded bg-slate-100 dark:bg-slate-700 overflow-hidden">
                        <div
                          className={`h-full rounded transition-all duration-300 ${mc.bar}`}
                          style={{ width: `${Math.max(widthPct, 0)}%` }}
                        />
                      </div>
                      <span className="w-8 text-right text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        {count}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}

export default RoutingHistoryChart;
