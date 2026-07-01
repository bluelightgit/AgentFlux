/**
 * DataExportPanel — export telemetry data from events.jsonl to CSV or JSON.
 *
 * Reads the project's events.jsonl (via the dashboard store's fluxDir),
 * filters by the selected data type and time range, then writes the result
 * to `${fluxDir}/exports/${datatype}_${timestamp}.${ext}` through the
 * Electron preload bridge. Shows transient success/error feedback.
 */
import React, { useCallback, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFileAsync,
  filterByType,
  type AnyEvent,
} from "../lib/events-parser";
import { writeFileContent } from "../lib/file-access";
import { Card, Icon, Badge } from "./ui";

/** Telemetry data type selected for export. */
type DataType = "subagent_runs" | "routing_decisions" | "cache_samples" | "all_events";

/** Export file format. */
type Format = "CSV" | "JSON";

/** Time range filter applied before export. */
type TimeRange = "all" | "last_24h" | "last_7d";

/** Map the UI time-range labels onto the parser's range tokens. */
const TIME_RANGE_MAP: Record<TimeRange, "all" | "24h" | "7d"> = {
  all: "all",
  last_24h: "24h",
  last_7d: "7d",
};

/** Map UI data-type labels onto the underlying event `type` strings. */
const DATA_TYPE_EVENT: Record<Exclude<DataType, "all_events">, AnyEvent["type"]> = {
  subagent_runs: "subagent.run",
  routing_decisions: "routing.decision",
  cache_samples: "cache.sample",
};

/**
 * Convert an array of records to CSV text. The first row is the union of
 * all keys across the records (column headers); each subsequent row is the
 * corresponding value. Nested objects/arrays are JSON-encoded; commas and
 * quotes in string values are escaped per RFC 4180.
 */
function toCSV(rows: Record<string, any>[]): string {
  if (rows.length === 0) return "";

  // Collect the union of keys, preserving first-seen order.
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }

  const escape = (val: any): string => {
    if (val === null || val === undefined) return "";
    let s: string;
    if (typeof val === "object") {
      s = JSON.stringify(val);
    } else {
      s = String(val);
    }
    // Quote any value containing a comma, double quote, or newline.
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines: string[] = [];
  lines.push(keys.map((k) => escape(k)).join(","));
  for (const row of rows) {
    lines.push(keys.map((k) => escape(row[k])).join(","));
  }
  return lines.join("\n");
}

/** Filter the raw event list by the selected data type. */
function filterDataType(events: AnyEvent[], type: DataType): AnyEvent[] {
  if (type === "all_events") return events;
  const eventType = DATA_TYPE_EVENT[type];
  return filterByType(events, eventType);
}

/** Filter the event list by the selected time range. */
function filterTimeRange(events: AnyEvent[], range: TimeRange): AnyEvent[] {
  const token = TIME_RANGE_MAP[range];
  if (token === "all") return events;
  const now = Date.now();
  const ms = token === "24h" ? 86_400_000 : 604_800_000; // 7d
  const cutoff = now - ms;
  return events.filter((e) => e.ts >= cutoff);
}

export function DataExportPanel(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [dataType, setDataType] = useState<DataType>("all_events");
  const [format, setFormat] = useState<Format>("JSON");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");

  const [exporting, setExporting] = useState<boolean>(false);
  const [exported, setExported] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-clear the "Exported to ..." badge after 5 seconds.
  React.useEffect(() => {
    if (!exported) return;
    const id = setTimeout(() => setExported(null), 5_000);
    return () => clearTimeout(id);
  }, [exported]);

  const handleExport = useCallback(async () => {
    if (!fluxDir) {
      setError("No project flux directory available");
      setExported(null);
      return;
    }
    setExporting(true);
    setError(null);
    setExported(null);
    try {
      const events = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
      const filtered = filterTimeRange(filterDataType(events, dataType), timeRange);

      const ext = format === "CSV" ? "csv" : "json";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `${dataType}_${stamp}.${ext}`;
      const outPath = `${fluxDir}/exports/${fileName}`;

      let content: string;
      if (format === "CSV") {
        content = toCSV(filtered as Record<string, any>[]);
      } else {
        content = JSON.stringify(filtered, null, 2);
      }

      const ok = await writeFileContent(outPath, content);
      if (!ok) {
        throw new Error("File write unavailable (no Electron bridge)");
      }
      setExported(fileName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [fluxDir, dataType, format, timeRange]);

  const selectClass =
    "rounded-lg bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Download" size={20} className="text-blue-500" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
          Data Export
        </h3>
      </div>

      {/* Options */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Data type
          </label>
          <select
            value={dataType}
            onChange={(e) => setDataType(e.target.value as DataType)}
            className={selectClass}
          >
            <option value="subagent_runs">Subagent runs</option>
            <option value="routing_decisions">Routing decisions</option>
            <option value="cache_samples">Cache samples</option>
            <option value="all_events">All events</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Format
          </label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as Format)}
            className={selectClass}
          >
            <option value="CSV">CSV</option>
            <option value="JSON">JSON</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Time range
          </label>
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as TimeRange)}
            className={selectClass}
          >
            <option value="all">All time</option>
            <option value="last_24h">Last 24 hours</option>
            <option value="last_7d">Last 7 days</option>
          </select>
        </div>
      </div>

      {/* Export button + feedback */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting || !fluxDir}
          className="inline-flex items-center gap-2 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Icon name="Download" size={16} />
          {exporting ? "Exporting..." : "Export Data"}
        </button>

        {exported ? (
          <Badge color="green">Exported to {exported}</Badge>
        ) : null}
        {error ? <Badge color="red">{error}</Badge> : null}
      </div>

      {/* Info */}
      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        Exports are saved to .agentflux/exports/
      </p>
    </Card>
  );
}
