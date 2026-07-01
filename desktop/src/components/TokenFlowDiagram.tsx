/**
 * Token Flow Diagram — visual diagram showing token flow per agent.
 *
 * Reads `subagent.run` events from `${fluxDir}/events.jsonl`, groups them by
 * the `agent` field, and aggregates input/output/cacheRead/cacheWrite tokens.
 * For each agent (top 10 by total tokens, descending) renders a horizontal
 * flow diagram of four stacked bars (input → cache read → output → cache
 * write), with widths proportional to that token volume over the agent's
 * total. Below the per-agent rows an aggregate totals row is shown.
 *
 * Loads on mount and polls every 10s.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFileAsync,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { Card, Icon, EmptyState } from "./ui";
import { formatTokens } from "../lib/format";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Per-agent token-flow aggregate row. */
interface TokenFlowRow {
  name: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

// ─── Bar styling ───────────────────────────────────────────────────────────

interface BarSpec {
  label: string;
  value: (r: TokenFlowRow) => number;
  barClass: string;
  textClass: string;
}

/** The four flow stages, rendered top-to-bottom within each agent row. */
const FLOW_BARS: BarSpec[] = [
  {
    label: "Input",
    value: (r) => r.input,
    barClass: "bg-blue-500",
    textClass: "text-blue-600 dark:text-blue-300",
  },
  {
    label: "Cache Read",
    value: (r) => r.cacheRead,
    barClass: "bg-green-500",
    textClass: "text-green-600 dark:text-green-300",
  },
  {
    label: "Output",
    value: (r) => r.output,
    barClass: "bg-amber-500",
    textClass: "text-amber-600 dark:text-amber-300",
  },
  {
    label: "Cache Write",
    value: (r) => r.cacheWrite,
    barClass: "bg-purple-500",
    textClass: "text-purple-600 dark:text-purple-300",
  },
];

// ─── Component ─────────────────────────────────────────────────────────────

export function TokenFlowDiagram(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [agents, setAgents] = useState<TokenFlowRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setAgents([]);
      setLoading(false);
      return;
    }
    try {
      const parsed = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
      const runs = filterByType(parsed, "subagent.run") as SubagentRunEvent[];

      const order: string[] = [];
      const agg = new Map<
        string,
        { input: number; output: number; cacheRead: number; cacheWrite: number }
      >();

      for (const r of runs) {
        const name = r.agent ?? "unknown";
        if (!agg.has(name)) {
          agg.set(name, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
          order.push(name);
        }
        const t = agg.get(name)!;
        t.input += r.input ?? 0;
        t.output += r.output ?? 0;
        t.cacheRead += r.cacheRead ?? 0;
        t.cacheWrite += r.cacheWrite ?? 0;
      }

      const rows: TokenFlowRow[] = order.map((name) => {
        const t = agg.get(name)!;
        const total = t.input + t.output + t.cacheRead + t.cacheWrite;
        return {
          name,
          input: t.input,
          output: t.output,
          cacheRead: t.cacheRead,
          cacheWrite: t.cacheWrite,
          total,
        };
      });
      rows.sort((a, b) => b.total - a.total);
      setAgents(rows.slice(0, 10));
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  // Load on mount and poll every 10s.
  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  // Aggregate totals across all agents (after the top-10 slice).
  const totals = agents.reduce(
    (acc, r) => {
      acc.input += r.input;
      acc.output += r.output;
      acc.cacheRead += r.cacheRead;
      acc.cacheWrite += r.cacheWrite;
      acc.total += r.total;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon
          name="ArrowRightLeft"
          size={20}
          className="text-slate-500 dark:text-slate-400"
        />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Token Flow
        </h3>
        {loading ? (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
            Loading...
          </span>
        ) : (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
            {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {loading ? (
        <div className="h-32 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : agents.length === 0 ? (
        <EmptyState
          icon="ArrowRightLeft"
          message="No token flow data yet"
        />
      ) : (
        <div className="flex flex-col gap-4">
          {agents.map((agent) => {
            const denom = agent.total > 0 ? agent.total : 1;
            return (
              <div
                key={agent.name}
                className="flex flex-col gap-2 pb-4 border-b border-slate-100 dark:border-slate-700 last:border-0 last:pb-0"
              >
                <div className="flex items-center gap-3">
                  {/* Agent name (fixed width) */}
                  <div
                    className="w-24 shrink-0 text-sm font-medium text-slate-700 dark:text-slate-200 truncate"
                    title={agent.name}
                  >
                    {agent.name}
                  </div>

                  {/* Four stacked horizontal bars */}
                  <div className="flex-1 flex flex-col gap-1.5">
                    {FLOW_BARS.map((bar) => {
                      const value = bar.value(agent);
                      const pct = (value / denom) * 100;
                      return (
                        <div key={bar.label} className="flex items-center gap-2">
                          <div
                            className={`w-20 shrink-0 text-xs ${bar.textClass}`}
                          >
                            {bar.label}
                          </div>
                          <div className="flex-1 relative h-4 bg-slate-100 dark:bg-slate-700/50 rounded overflow-hidden">
                            <div
                              className={`h-4 rounded ${bar.barClass} min-w-4`}
                              style={{
                                width: `${Math.min(Math.max(pct, 0), 100)}%`,
                              }}
                            />
                          </div>
                          <div className="w-16 shrink-0 text-right text-xs font-medium text-slate-700 dark:text-slate-200">
                            {formatTokens(value)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Aggregate totals row */}
          <div className="flex items-center gap-3 pt-2">
            <div className="w-24 shrink-0 text-sm font-semibold text-slate-800 dark:text-slate-100">
              Total
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              {FLOW_BARS.map((bar) => {
                const value =
                  bar.value(totals as unknown as TokenFlowRow);
                const pct = totals.total > 0 ? (value / totals.total) * 100 : 0;
                return (
                  <div key={bar.label} className="flex items-center gap-2">
                    <div className={`w-20 shrink-0 text-xs ${bar.textClass}`}>
                      {bar.label}
                    </div>
                    <div className="flex-1 relative h-4 bg-slate-100 dark:bg-slate-700/50 rounded overflow-hidden">
                      <div
                        className={`h-4 rounded ${bar.barClass} min-w-4`}
                        style={{
                          width: `${Math.min(Math.max(pct, 0), 100)}%`,
                        }}
                      />
                    </div>
                    <div className="w-16 shrink-0 text-right text-xs font-semibold text-slate-800 dark:text-slate-100">
                      {formatTokens(value)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default TokenFlowDiagram;
