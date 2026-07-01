/**
 * AgentRetryHistory — shows retry counts, model failures, and fallback
 * patterns observed in `subagent.run` telemetry.
 *
 * Reads events.jsonl, filters to `subagent.run` events where the agent
 * either retried (retryCount > 0), fell back to another model
 * (fallbackModel truthy), or surfaced an error (errorMessage truthy).
 * Renders the most recent 15 entries sorted newest-first, plus a summary
 * footer (total retries, total fallbacks, most-failed model, most-retried
 * agent). Loads on mount and polls every 15 seconds.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFile,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatCost, formatTs } from "../lib/format";

/** A single retry / fallback entry derived from a subagent.run event. */
interface RetryEntry {
  agent: string;
  model: string;
  retryCount: number;
  fallbackModel: string | null;
  fallbackFrom: string | null;
  errorMessage: string;
  cost: number;
  /** Epoch ms stored as a string to match the component's state shape. */
  timestamp: string;
}

/**
 * The SubagentRunEvent type does not declare `fallbackModel`,
 * `fallbackFrom`, or `errorMessage`, but the runtime payload may include
 * them. Accept them as optional fields on a widened type.
 */
type RunEventWide = SubagentRunEvent & {
  fallbackModel?: string | null;
  fallbackFrom?: string | null;
  errorMessage?: string | null;
};

/** Build the list of retry / fallback entries from raw subagent.run events. */
function buildEntries(events: SubagentRunEvent[]): RetryEntry[] {
  const out: RetryEntry[] = [];
  for (const e of events) {
    const we = e as RunEventWide;
    const retryCount = we.retryCount ?? 0;
    const fallbackModel = we.fallbackModel ?? null;
    const fallbackFrom = we.fallbackFrom ?? null;
    const errorMessage = we.errorMessage ?? "";

    const hasRetry = retryCount > 0;
    const hasFallback = Boolean(fallbackModel);
    const hasError = Boolean(errorMessage);
    if (!hasRetry && !hasFallback && !hasError) continue;

    out.push({
      agent: e.agent ?? "unknown",
      model: e.model ?? "",
      retryCount,
      fallbackModel,
      fallbackFrom,
      errorMessage,
      cost: e.costUsd ?? 0,
      timestamp: String(e.ts),
    });
  }
  // Sort by timestamp descending (most recent first).
  out.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  return out;
}

/** Find the key with the highest count in a count map. */
function topKey(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

export function AgentRetryHistory(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [retries, setRetries] = useState<RetryEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setRetries([]);
      setLoading(false);
      return;
    }
    try {
      const parsed = await parseEventsFile(`${fluxDir}/events.jsonl`);
      const runs = filterByType(parsed, "subagent.run") as SubagentRunEvent[];
      setRetries(buildEntries(runs));
    } catch {
      setRetries([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  // Load on mount and poll every 15s.
  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  // Cap the displayed list at 15 entries.
  const visible = useMemo(() => retries.slice(0, 15), [retries]);

  // Summary stats across the full matching set.
  const summary = useMemo(() => {
    let totalRetries = 0;
    let totalFallbacks = 0;
    const failedByModel = new Map<string, number>();
    const retriesByAgent = new Map<string, number>();

    for (const r of retries) {
      totalRetries += r.retryCount;
      if (r.fallbackModel) totalFallbacks += 1;
      if (r.errorMessage) {
        // Treat an entry carrying an error message as a model failure.
        const m = r.model || "unknown";
        failedByModel.set(m, (failedByModel.get(m) ?? 0) + 1);
      }
      if (r.retryCount > 0) {
        const a = r.agent;
        retriesByAgent.set(a, (retriesByAgent.get(a) ?? 0) + r.retryCount);
      }
    }

    return {
      totalRetries,
      totalFallbacks,
      mostFailedModel: topKey(failedByModel),
      mostRetriedAgent: topKey(retriesByAgent),
    };
  }, [retries]);

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="History" size={20} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Retry &amp; Fallback History
        </h3>
      </div>

      {/* Body */}
      {loading ? (
        <div className="h-48 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : retries.length === 0 ? (
        <EmptyState
          icon="CheckCircle2"
          message="No retries or fallbacks - all agents succeeded first try"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((r, i) => (
            <div
              key={i}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {formatTs(Number(r.timestamp))}
                </span>
                <Badge color="blue">{r.agent}</Badge>
                {r.model ? (
                  <span className="text-sm font-mono text-slate-700 dark:text-slate-200">
                    {r.model}
                  </span>
                ) : null}
                {r.retryCount > 0 ? (
                  <Badge color="amber">retry x{r.retryCount}</Badge>
                ) : null}
                {r.fallbackModel ? (
                  <span className="flex items-center gap-1">
                    <Icon
                      name="ArrowLeftRight"
                      size={14}
                      className="text-slate-400 dark:text-slate-500"
                    />
                    <Badge color="green">{r.fallbackModel}</Badge>
                  </span>
                ) : null}
                <span className="ml-auto text-xs text-slate-500 dark:text-slate-400 font-mono">
                  {formatCost(r.cost)}
                </span>
              </div>
              {r.errorMessage ? (
                <p
                  className="mt-1 text-xs text-red-500 dark:text-red-400 truncate"
                  title={r.errorMessage}
                >
                  {r.errorMessage}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* Summary footer */}
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-200 dark:border-slate-700 pt-4 sm:grid-cols-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Total retries
          </div>
          <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">
            {summary.totalRetries}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Total fallbacks
          </div>
          <div className="text-sm font-semibold text-green-600 dark:text-green-400">
            {summary.totalFallbacks}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Most-failed model
          </div>
          <div className="text-sm font-semibold text-red-600 dark:text-red-400 font-mono truncate">
            {summary.mostFailedModel ?? "-"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Most-retried agent
          </div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
            {summary.mostRetriedAgent ?? "-"}
          </div>
        </div>
      </div>
    </Card>
  );
}

export default AgentRetryHistory;
