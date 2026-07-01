/**
 * ErrorLogPanel — centralized display of errors and warnings from telemetry.
 *
 * Reads `subagent.run` events from events.jsonl and filters to those that
 * represent problems: a non-zero `exitCode` (error) or a truthy
 * `errorMessage` (warning when exitCode is 0). Renders the most recent 20
 * entries sorted newest-first, with filter buttons (All / Errors Only /
 * Warnings Only) and a summary footer (total errors, total warnings, affected
 * agents). Loads on mount and polls every 10 seconds.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFile,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatTs } from "../lib/format";

/** A single error/warning entry derived from a subagent.run event. */
interface ErrorEntry {
  timestamp: number;
  agent: string;
  errorMessage: string;
  exitCode: number;
  model: string;
  /** true when exitCode !== 0 (error); false when only an errorMessage (warning). */
  isError: boolean;
}

/**
 * The SubagentRunEvent type does not declare `errorMessage`, but the runtime
 * payload may include it. Accept it as an optional field on a widened type.
 */
type RunEventWithMessage = SubagentRunEvent & { errorMessage?: string };

/** Filter mode for the displayed list. */
type FilterMode = "all" | "errors" | "warnings";

/** Build the list of error/warning entries from raw subagent.run events. */
function buildEntries(events: SubagentRunEvent[]): ErrorEntry[] {
  const out: ErrorEntry[] = [];
  for (const e of events) {
    const we = e as RunEventWithMessage;
    const msg = we.errorMessage ?? "";
    const hasError = e.exitCode !== 0;
    const hasMessage = Boolean(msg);
    if (!hasError && !hasMessage) continue;
    out.push({
      timestamp: e.ts,
      agent: e.agent ?? "unknown",
      errorMessage: msg,
      exitCode: e.exitCode ?? 0,
      model: e.model ?? "",
      isError: hasError,
    });
  }
  // Sort by timestamp descending (most recent first).
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

export function ErrorLogPanel(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filter, setFilter] = useState<FilterMode>("all");

  const load = useCallback(async () => {
    if (!fluxDir) {
      setErrors([]);
      setLoading(false);
      return;
    }
    try {
      const parsed = await parseEventsFile(`${fluxDir}/events.jsonl`);
      const runs = filterByType(parsed, "subagent.run") as SubagentRunEvent[];
      setErrors(buildEntries(runs));
    } catch {
      setErrors([]);
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

  // Apply the active filter.
  const visible = useMemo(() => {
    let list = errors;
    if (filter === "errors") list = errors.filter((e) => e.isError);
    else if (filter === "warnings")
      list = errors.filter((e) => !e.isError);
    return list.slice(0, 20);
  }, [errors, filter]);

  // Summary counts.
  const summary = useMemo(() => {
    let totalErrors = 0;
    let totalWarnings = 0;
    const agents = new Set<string>();
    for (const e of errors) {
      if (e.isError) totalErrors += 1;
      else totalWarnings += 1;
      agents.add(e.agent);
    }
    return {
      totalErrors,
      totalWarnings,
      affectedAgents: agents.size,
    };
  }, [errors]);

  const filterButtons: { key: FilterMode; label: string }[] = [
    { key: "all", label: "All" },
    { key: "errors", label: "Errors Only" },
    { key: "warnings", label: "Warnings Only" },
  ];

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="AlertTriangle" size={20} className="text-red-500" />
        <h3 className="text-lg font-semibold text-red-600 dark:text-red-400">
          Error Log
        </h3>
      </div>

      {/* Filter buttons */}
      <div className="flex items-center gap-2 mb-4">
        {filterButtons.map((b) => {
          const active = filter === b.key;
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => setFilter(b.key)}
              className={`text-xs rounded-full px-3 py-1 border transition-colors ${
                active
                  ? "bg-red-600 text-white border-red-600 dark:bg-red-500 dark:border-red-500"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700"
              }`}
            >
              {b.label}
            </button>
          );
        })}
      </div>

      {/* Body */}
      {loading ? (
        <div className="h-48 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : errors.length === 0 ? (
        <EmptyState
          icon="CheckCircle2"
          message="No errors detected"
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="CheckCircle2"
          message="No entries match this filter"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((e, i) => {
            const rowBg = e.isError
              ? "bg-red-50 dark:bg-red-900/20"
              : "bg-amber-50 dark:bg-amber-900/20";
            return (
              <div
                key={i}
                className={`rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 ${rowBg}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {formatTs(e.timestamp)}
                  </span>
                  <Badge color="red">{e.agent}</Badge>
                  <span
                    className={`text-xs ${
                      e.exitCode !== 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    exit: {e.exitCode}
                  </span>
                  {e.model ? (
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      {e.model}
                    </span>
                  ) : null}
                </div>
                {e.errorMessage ? (
                  <p
                    className="mt-1 text-sm text-red-500 dark:text-red-400 truncate"
                    title={e.errorMessage}
                  >
                    {e.errorMessage}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Summary footer */}
      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-slate-200 dark:border-slate-700 pt-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Total errors
          </div>
          <div className="text-sm font-semibold text-red-600 dark:text-red-400">
            {summary.totalErrors}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Total warnings
          </div>
          <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">
            {summary.totalWarnings}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Affected agents
          </div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {summary.affectedAgents}
          </div>
        </div>
      </div>
    </Card>
  );
}
