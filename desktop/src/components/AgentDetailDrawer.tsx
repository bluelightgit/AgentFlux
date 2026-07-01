/**
 * AgentDetailDrawer — slide-out panel showing detailed agent info.
 *
 * Renders a fixed right-hand drawer with four sections:
 *   1. Status      — current status, task, model, thinking level
 *   2. Telemetry   — 2x2 MetricCard grid + token / failure / retry totals
 *   3. Inbox       — last 5 direct + group messages addressed to the agent
 *   4. Session     — session file path, registeredAt, lastSeen timestamps
 *
 * Inbox data is loaded on mount and whenever the agent changes by combining
 * direct messages (`getDirectMessages`) and group messages for any group the
 * agent is a member of (`listGroups` + `getGroupMessages`).
 */
import React, { useEffect, useState } from "react";
import { Card, Badge, Icon, EmptyState, MetricCard, StatusDot, type StatusKind } from "./ui";
import { formatTokens, formatCost, formatPct, formatTs } from "../lib/format";
import {
  type AgentInfo,
  type AgentRegistryStatus,
  type DirectMessage,
  type GroupMessage,
  getDirectMessages,
  listGroups,
  getGroupMessages,
} from "../lib/group-reader";
import { type AgentTelemetry } from "../lib/agent-status-enhanced";
import { useDashboardStore } from "../store/dashboard-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** AgentInfo augmented with optional session metadata fields. */
type AgentDetail = AgentInfo & {
  sessionFile?: string;
  registeredAt?: number;
};

/** A unified inbox item regardless of source (direct or group). */
interface InboxItem {
  id: string;
  from: string;
  content: string;
  timestamp: number;
}

export interface AgentDetailDrawerProps {
  agent: AgentInfo | null;
  telemetry?: AgentTelemetry;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map an AgentRegistryStatus to the StatusDot StatusKind palette. */
function toStatusKind(status: AgentRegistryStatus): StatusKind {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "blocked":
      return "pending";
    case "idle":
    default:
      return "idle";
  }
}

/** Coerce a lastSeen value (string | number | null) into a numeric ts. */
function toTs(value: string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Truncate a string to `max` chars, appending an ellipsis if needed. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

// ---------------------------------------------------------------------------
// Section: Status
// ---------------------------------------------------------------------------
function StatusSection({ agent }: { agent: AgentDetail }): React.ReactElement {
  return (
    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2">
        <StatusDot status={toStatusKind(agent.status)} />
        <span className="text-sm font-medium capitalize text-slate-700 dark:text-slate-200">
          {agent.status}
        </span>
      </div>
      {agent.currentTask ? (
        <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {agent.currentTask}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {agent.model ? (
          <span className="inline-flex items-center gap-1">
            <Icon name="Cpu" size={14} className="text-slate-400 dark:text-slate-500" />
            {agent.model}
          </span>
        ) : null}
        {agent.thinking ? (
          <span className="inline-flex items-center gap-1">
            <Icon name="Zap" size={14} className="text-slate-400 dark:text-slate-500" />
            {agent.thinking}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Telemetry
// ---------------------------------------------------------------------------
function TelemetrySection({ telemetry }: { telemetry: AgentTelemetry }): React.ReactElement {
  return (
    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Telemetry
      </div>
      <div className="grid grid-cols-2 gap-2">
        <MetricCard icon="Activity" label="Total Runs" value={telemetry.runs} />
        <MetricCard icon="DollarSign" label="Total Cost" value={formatCost(telemetry.totalCost)} />
        <MetricCard icon="Database" label="Avg Cache Hit" value={formatPct(telemetry.avgHitRate)} />
        <MetricCard icon="RefreshCw" label="Avg Turns" value={telemetry.avgTurns.toFixed(1)} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-500 dark:text-slate-400">
        <div>
          <span className="text-slate-400 dark:text-slate-500">Input:</span>{" "}
          {formatTokens(telemetry.totalInput)}
        </div>
        <div>
          <span className="text-slate-400 dark:text-slate-500">Output:</span>{" "}
          {formatTokens(telemetry.totalOutput)}
        </div>
        <div>
          <span className="text-slate-400 dark:text-slate-500">Failures:</span>{" "}
          <span className="text-red-600 dark:text-red-400">{telemetry.failures}</span>
        </div>
        <div>
          <span className="text-slate-400 dark:text-slate-500">Retries:</span>{" "}
          {telemetry.retries}
        </div>
      </div>
      {telemetry.models.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {telemetry.models.map((m) => (
            <Badge key={m} color="slate">
              {m}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Inbox
// ---------------------------------------------------------------------------
function InboxSection({ items }: { items: InboxItem[] }): React.ReactElement {
  const recent = items.slice(-5).reverse();
  return (
    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Inbox
      </div>
      {recent.length === 0 ? (
        <EmptyState icon="MessageCircle" message="Inbox empty" />
      ) : (
        <div className="flex flex-col gap-2">
          {recent.map((item) => (
            <div
              key={item.id || `${item.from}-${item.timestamp}`}
              className="rounded-md bg-slate-50 dark:bg-slate-700/40 px-3 py-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {item.from || "unknown"}
                </span>
                {item.timestamp ? (
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {formatTs(item.timestamp)}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                {truncate(item.content, 100)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Session Info
// ---------------------------------------------------------------------------
function SessionSection({ agent }: { agent: AgentDetail }): React.ReactElement {
  return (
    <div className="px-4 py-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Session Info
      </div>
      <div className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
        {agent.sessionFile ? (
          <div className="break-all text-slate-400 dark:text-slate-500">
            {agent.sessionFile}
          </div>
        ) : null}
        <div>
          <span className="text-slate-400 dark:text-slate-500">Registered:</span>{" "}
          {formatTs(agent.registeredAt ?? 0)}
        </div>
        <div>
          <span className="text-slate-400 dark:text-slate-500">Last seen:</span>{" "}
          {formatTs(toTs(agent.lastSeen))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------
export function AgentDetailDrawer(props: AgentDetailDrawerProps): React.ReactElement | null {
  const { agent, telemetry, onClose } = props;
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");
  const [inbox, setInbox] = useState<InboxItem[]>([]);

  // Load inbox data on mount / when agent or fluxDir changes.
  useEffect(() => {
    if (!agent || !fluxDir) {
      setInbox([]);
      return;
    }
    let cancelled = false;
    const name = agent.name;

    (async () => {
      const items: InboxItem[] = [];
      try {
        const dms = await getDirectMessages(fluxDir);
        for (const dm of dms as DirectMessage[]) {
          if (dm.to === name) {
            items.push({
              id: dm.id,
              from: dm.from,
              content: dm.content,
              timestamp: dm.timestamp,
            });
          }
        }
      } catch {
        // ignore — DMs unavailable
      }

      try {
        const groups = await listGroups(fluxDir);
        const memberGroups = groups.filter((g) => g.members.includes(name));
        const groupMsgs = await Promise.all(
          memberGroups.map((g) => getGroupMessages(fluxDir, g.id)),
        );
        for (const msgs of groupMsgs as GroupMessage[][]) {
          for (const m of msgs) {
            items.push({
              id: m.id,
              from: m.from,
              content: m.content,
              timestamp: m.timestamp,
            });
          }
        }
      } catch {
        // ignore — groups unavailable
      }

      items.sort((a, b) => a.timestamp - b.timestamp);
      if (!cancelled) setInbox(items);
    })();

    return () => {
      cancelled = true;
    };
  }, [agent, fluxDir]);

  if (!agent) return null;

  const detail = agent as AgentDetail;

  return (
    <>
      {/* Click-away backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
      />
      <aside
        className="fixed right-0 top-0 h-full w-96 bg-white dark:bg-slate-800 border-l dark:border-slate-700 shadow-xl z-50 animate-slide-in flex flex-col"
        role="dialog"
        aria-label={`Agent detail: ${detail.name}`}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
          <span className="flex-1 truncate text-lg font-bold text-slate-800 dark:text-slate-100">
            {detail.name}
          </span>
          {detail.role ? <Badge color="blue">{detail.role}</Badge> : null}
          <button
            type="button"
            onClick={onClose}
            className="ml-1 rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
            aria-label="Close"
          >
            <Icon name="X" size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-auto">
          <StatusSection agent={detail} />
          {telemetry ? <TelemetrySection telemetry={telemetry} /> : null}
          <InboxSection items={inbox} />
          <SessionSection agent={detail} />
        </div>
      </aside>
    </>
  );
}

export default AgentDetailDrawer;
