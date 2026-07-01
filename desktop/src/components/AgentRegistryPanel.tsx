/**
 * Agent Registry panel.
 * Lists all agents registered in `${fluxDir}/shared/agents/_registry.json`
 * with live status, role, current task, model and last-seen timestamp.
 * Polls the registry every 2s for near-real-time updates.
 */
import React, { useEffect, useState } from "react";
import { Card, Badge, Icon, DataTable, EmptyState } from "./ui";
import { formatTs } from "../lib/format";
import { listAgents, type AgentInfo } from "../lib/group-reader";
import { useDashboardStore } from "../store/dashboard-store";
import { AgentDetailDrawer } from "./AgentDetailDrawer";

// ─── Status helpers ────────────────────────────────────────────────────────

type AgentStatus = AgentInfo["status"];

/** Tailwind bg color per agent status (colored dot, NOT emoji). */
const STATUS_DOT_COLOR: Record<AgentStatus, string> = {
  running: "bg-green-500",
  done: "bg-blue-500",
  failed: "bg-red-500",
  blocked: "bg-amber-500",
  idle: "bg-slate-400",
};

/** Sort weight: running first, then blocked, idle, then done/failed. */
const STATUS_SORT: Record<AgentStatus, number> = {
  running: 0,
  blocked: 1,
  idle: 2,
  done: 3,
  failed: 4,
};

function StatusDot({ status }: { status: AgentStatus }): React.ReactElement {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${STATUS_DOT_COLOR[status] ?? "bg-slate-400"}`}
    />
  );
}

// ─── Role helpers ──────────────────────────────────────────────────────────

type RoleColor = "blue" | "green" | "amber" | "purple" | "pink";

const ROLE_COLOR: Record<string, RoleColor> = {
  planner: "blue",
  implementer: "green",
  reviewer: "amber",
  tester: "purple",
  designer: "pink",
};

/**
 * Role badge. `Badge` from ui.tsx does not support pink, so render a custom
 * span matching the Badge styling for the designer role.
 */
function RoleBadge({ role }: { role: string }): React.ReactElement {
  const color = ROLE_COLOR[role.toLowerCase()] ?? "slate";

  if (color === "pink") {
    return (
      <span className="bg-pink-50 text-pink-600 border border-pink-200 dark:bg-pink-900/40 dark:text-pink-300 dark:border-pink-700 rounded-full px-2 py-0.5 text-xs">
        {role}
      </span>
    );
  }

  // Reuse the shared Badge for supported colors.
  return <Badge color={color}>{role}</Badge>;
}

// ─── Misc formatting ───────────────────────────────────────────────────────

/** Truncate a string to `max` chars, appending an ellipsis when truncated. */
function truncate(text: string | undefined, max: number): string {
  if (!text) return "-";
  if (text.length <= max) return text;
  return text.slice(0, max) + "\u2026";
}

// ─── Component ─────────────────────────────────────────────────────────────

export function AgentRegistryPanel(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!fluxDir) {
        if (!cancelled) {
          setAgents([]);
          setLoading(false);
        }
        return;
      }
      try {
        const list = await listAgents(fluxDir);
        if (cancelled) return;
        setAgents(list);
      } catch {
        if (!cancelled) setAgents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // Load immediately on mount / when fluxDir changes.
    setLoading(true);
    load();

    // Poll every 2 seconds for near-real-time registry updates.
    const timer = setInterval(load, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fluxDir]);

  // Sort: running first, then idle, then done/failed (stable on name).
  const sorted = [...agents].sort((a, b) => {
    const s = STATUS_SORT[a.status] - STATUS_SORT[b.status];
    if (s !== 0) return s;
    return a.name.localeCompare(b.name);
  });

  const columns = [
    { key: "status", label: "Status", width: "80px" },
    { key: "name", label: "Name" },
    { key: "role", label: "Role" },
    { key: "task", label: "Current Task" },
    { key: "model", label: "Model" },
    { key: "lastSeen", label: "Last Seen" },
  ];

  const rows = sorted.map((a) => ({
    __agent: a,
    status: (
      <span className="inline-flex items-center gap-2">
        <StatusDot status={a.status} />
        <span className="text-xs text-slate-500 dark:text-slate-400">{a.status}</span>
      </span>
    ),
    name: <span className="font-medium text-slate-800 dark:text-slate-200">{a.name}</span>,
    role: <RoleBadge role={a.role} />,
    task: (
      <span className="text-sm text-slate-700 dark:text-slate-300 truncate inline-block max-w-[40ch]">
        {truncate(a.currentTask, 40)}
      </span>
    ),
    model: (
      <span className="text-sm text-slate-500 dark:text-slate-400">
        {a.model ?? "-"}
        {a.thinking ? ` [${a.thinking}]` : ""}
      </span>
    ),
    lastSeen: (
      <span className="text-xs text-slate-400 dark:text-slate-500">
        {formatTs(Date.parse(a.lastSeen ?? ""))}
      </span>
    ),
  }));

  return (
    <Card className="text-slate-800 dark:text-slate-200">
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Users" size={20} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Registered Agents
        </h3>
        {loading ? (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">Loading…</span>
        ) : (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
            {sorted.length} agent{sorted.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          icon="Users"
          message="No registered agents. Dispatch agents to register."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          onRowClick={(row) => setSelectedAgent(row.__agent as AgentInfo)}
          rowClassName="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700"
        />
      )}
      {selectedAgent ? (
        <AgentDetailDrawer agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
      ) : null}
    </Card>
  );
}

export default AgentRegistryPanel;
