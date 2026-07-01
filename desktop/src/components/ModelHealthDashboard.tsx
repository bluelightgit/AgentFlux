/**
 * Model Health Dashboard
 * Shows per-model availability and health derived from `subagent.run` error
 * patterns in events.jsonl. Aggregates runs, successes, failures, retries,
 * success rate, last error message/timestamp, and an overall status
 * (healthy / degraded / down).
 *
 * Loads on mount and polls every 15 seconds.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFile,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatPct, formatTs } from "../lib/format";

/** Health status bucket for a single model. */
type ModelStatus = "healthy" | "degraded" | "down";

/** Aggregated health metrics for a single model. */
interface ModelHealth {
  name: string;
  totalRuns: number;
  successes: number;
  failures: number;
  retries: number;
  successRate: number;
  lastError: string;
  lastErrorTs: string;
  status: ModelStatus;
}

/**
 * The SubagentRunEvent type does not declare `errorMessage`, but the runtime
 * payload may include it. Accept it as an optional field on a widened type.
 */
type RunEventWithMessage = SubagentRunEvent & { errorMessage?: string };

/** Status badge color per health bucket. */
const STATUS_BADGE_COLOR: Record<ModelStatus, "green" | "amber" | "red"> = {
  healthy: "green",
  degraded: "amber",
  down: "red",
};

/** Card border color per health bucket. */
const STATUS_BORDER_CLASS: Record<ModelStatus, string> = {
  healthy: "border-green-300 dark:border-green-700",
  degraded: "border-amber-300 dark:border-amber-700",
  down: "border-red-300 dark:border-red-700",
};

/** Determine the health bucket from a 0..1 success rate. */
function bucketStatus(successRate: number): ModelStatus {
  if (successRate > 0.9) return "healthy";
  if (successRate >= 0.7) return "degraded";
  return "down";
}

/** Aggregate raw subagent.run events into per-model health metrics. */
function aggregateModelHealth(events: SubagentRunEvent[]): ModelHealth[] {
  interface Accum {
    totalRuns: number;
    successes: number;
    failures: number;
    retries: number;
    lastError: string;
    lastErrorTs: number;
  }

  const map = new Map<string, Accum>();

  for (const e of events) {
    const model = e.model ?? "unknown";
    const we = e as RunEventWithMessage;
    const msg = we.errorMessage ?? "";
    const hasError = e.exitCode !== 0 || Boolean(msg);

    let acc = map.get(model);
    if (!acc) {
      acc = {
        totalRuns: 0,
        successes: 0,
        failures: 0,
        retries: 0,
        lastError: "",
        lastErrorTs: 0,
      };
      map.set(model, acc);
    }

    acc.totalRuns += 1;
    if (hasError) {
      acc.failures += 1;
    } else {
      acc.successes += 1;
    }
    acc.retries += e.retryCount ?? 0;

    // Track most recent error message/timestamp.
    if (hasError && e.ts >= acc.lastErrorTs) {
      acc.lastErrorTs = e.ts;
      acc.lastError = msg || `exit code ${e.exitCode}`;
    }
  }

  const out: ModelHealth[] = [];
  for (const [name, acc] of map) {
    const successRate =
      acc.totalRuns > 0 ? acc.successes / acc.totalRuns : 0;
    out.push({
      name,
      totalRuns: acc.totalRuns,
      successes: acc.successes,
      failures: acc.failures,
      retries: acc.retries,
      successRate,
      lastError: acc.lastError,
      lastErrorTs:
        acc.lastErrorTs > 0 ? formatTs(acc.lastErrorTs) : "",
      status: bucketStatus(successRate),
    });
  }

  // Stable ordering: by total runs descending, then name.
  out.sort((a, b) => b.totalRuns - a.totalRuns || a.name.localeCompare(b.name));
  return out;
}

export function ModelHealthDashboard(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [models, setModels] = useState<ModelHealth[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setModels([]);
      setLoading(false);
      return;
    }
    try {
      const parsed = await parseEventsFile(`${fluxDir}/events.jsonl`);
      const runs = filterByType(parsed, "subagent.run") as SubagentRunEvent[];
      setModels(aggregateModelHealth(runs));
    } catch (err) {
      // Swallow errors; the panel simply shows no data on failure.
      console.warn("[flux] model health load failed:", err);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  // Load on mount and poll every 15 seconds.
  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 15_000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [load]);

  // Overall summary counts.
  const summary = React.useMemo(() => {
    let healthy = 0;
    let degraded = 0;
    let down = 0;
    for (const m of models) {
      if (m.status === "healthy") healthy += 1;
      else if (m.status === "degraded") degraded += 1;
      else down += 1;
    }
    return { total: models.length, healthy, degraded, down };
  }, [models]);

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Stethoscope" size={20} className="text-slate-700 dark:text-slate-200" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
          Model Health
        </h3>
      </div>

      {/* Body */}
      {loading && models.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-sm text-slate-400 dark:text-slate-500">
          <Icon name="Loader2" size={16} className="animate-spin mr-2" />
          Loading model health...
        </div>
      ) : models.length === 0 ? (
        <EmptyState icon="Stethoscope" message="No model health data yet" />
      ) : (
        <>
          {/* Per-model grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {models.map((m) => (
              <div
                key={m.name}
                className={`rounded-lg border bg-white dark:bg-slate-900/40 p-4 ${STATUS_BORDER_CLASS[m.status]}`}
              >
                {/* Name + status */}
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm text-slate-800 dark:text-slate-100 truncate">
                    {m.name}
                  </span>
                  <Badge color={STATUS_BADGE_COLOR[m.status]}>{m.status}</Badge>
                </div>

                {/* Metrics */}
                <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      Success
                    </div>
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {formatPct(m.successRate)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      Runs
                    </div>
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {m.totalRuns}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      Failures
                    </div>
                    <div
                      className={`text-sm font-semibold ${
                        m.failures > 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-slate-800 dark:text-slate-100"
                      }`}
                    >
                      {m.failures}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      Retries
                    </div>
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {m.retries}
                    </div>
                  </div>
                </div>

                {/* Last error */}
                {m.lastError ? (
                  <div className="mt-3">
                    {m.lastErrorTs ? (
                      <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                        Last error {m.lastErrorTs}
                      </div>
                    ) : null}
                    <p
                      className="text-xs text-red-500 dark:text-red-400 truncate"
                      title={m.lastError}
                    >
                      {m.lastError}
                    </p>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {/* Overall summary */}
          <div className="mt-4 grid grid-cols-4 gap-3 border-t border-slate-200 dark:border-slate-700 pt-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Total models
              </div>
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {summary.total}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Healthy
              </div>
              <div className="text-sm font-semibold text-green-600 dark:text-green-400">
                {summary.healthy}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Degraded
              </div>
              <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                {summary.degraded}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Down
              </div>
              <div className="text-sm font-semibold text-red-600 dark:text-red-400">
                {summary.down}
              </div>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
