/**
 * Agents Page — three-section view of agents in the AgentFlux project:
 *   1. Agent Definitions (parsed from .agentflux/agents/*.md frontmatter)
 *   2. Agent Status (persistent + blackboard agents from store.agentStatus)
 *   3. Agent Telemetry (per-agent run stats from store.agentStatus.agentTelemetry)
 */
import React, { useEffect, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  Icon,
  StatusDot,
  Badge,
  DataTable,
  EmptyState,
  type DataTableColumn,
  type StatusKind,
} from "./ui";
import {
  formatHitRate,
  formatTokens,
  formatCost,
  type AgentTelemetry,
} from "../lib/agent-status-enhanced";
import { AgentRegistryPanel } from "./AgentRegistryPanel";
import { AgentPerformanceTable } from "./AgentPerformanceTable";
import { AgentOutputViewer } from "./AgentOutputViewer";
import { AgentRetryHistory } from "./AgentRetryHistory";
import { AgentToolMatrix } from "./AgentToolMatrix";
import { AgentCapabilityRadar } from "./AgentCapabilityRadar";
import { AgentComparisonTable } from "./AgentComparisonTable";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentDefinition {
  name: string;
  description: string;
  model: string;
  thinking: string;
  tools: string[];
}

interface DirectoryFile {
  name: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (lightweight YAML subset)
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, any> {
  const fm: Record<string, any> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return fm;

  const block = match[1];
  const lines = block.split(/\r?\n/);
  let currentKey: string | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // List item under current key (  - value)
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentKey) {
      const existing = fm[currentKey];
      const arr = Array.isArray(existing) ? existing : [];
      arr.push(stripQuotes(listMatch[1].trim()));
      fm[currentKey] = arr;
      continue;
    }

    // key: value
    const kvMatch = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const raw = kvMatch[2].trim();
      currentKey = key;
      if (raw === "") {
        fm[key] = [];
      } else if (raw.startsWith("[") && raw.endsWith("]")) {
        // inline array: [a, b, c]
        fm[key] = raw
          .slice(1, -1)
          .split(",")
          .map((s) => stripQuotes(s.trim()))
          .filter((s) => s.length > 0);
      } else {
        fm[key] = stripQuotes(raw);
      }
    }
  }

  return fm;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function toAgentDefinition(file: DirectoryFile): AgentDefinition | null {
  if (!file.name.endsWith(".md")) return null;
  const fm = parseFrontmatter(file.content);
  const name = String(fm.name ?? file.name.replace(/\.md$/, ""));
  const description = String(fm.description ?? "");
  const model = String(fm.model ?? "default");
  const thinking = String(fm.thinking ?? "off");
  let tools: string[] = [];
  if (Array.isArray(fm.tools)) {
    tools = fm.tools.map(String);
  } else if (typeof fm.tools === "string" && fm.tools.length > 0) {
    tools = fm.tools.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return { name, description, model, thinking, tools };
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function toStatusKind(status: string | undefined): StatusKind {
  switch (status) {
    case "running":
      return "running";
    case "done":
    case "completed":
    case "success":
      return "done";
    case "failed":
    case "error":
      return "failed";
    default:
      return "idle";
  }
}

// ---------------------------------------------------------------------------
// AgentsPage
// ---------------------------------------------------------------------------

export const AgentsPage: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const agentStatus = useDashboardStore((s) => s.agentStatus);
  const refreshAgentStatus = useDashboardStore((s) => s.refreshAgentStatus);

  const [definitions, setDefinitions] = useState<AgentDefinition[]>([]);
  const [loadingDefs, setLoadingDefs] = useState(false);

  // Load agent definitions from .agentflux/agents/*.md
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!project) {
        setDefinitions([]);
        return;
      }
      setLoadingDefs(true);
      try {
        const files: DirectoryFile[] =
          typeof window !== "undefined" && window.api
            ? await window.api.readDirectoryFiles(`${project.fluxDir}/agents`)
            : [];
        const parsed = files
          .map(toAgentDefinition)
          .filter((d): d is AgentDefinition => d !== null);
        if (!cancelled) setDefinitions(parsed);
      } catch {
        if (!cancelled) setDefinitions([]);
      } finally {
        if (!cancelled) setLoadingDefs(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [project]);

  const handleRefresh = () => {
    refreshAgentStatus();
  };

  // ── Section 2: Agent Status rows ──
  const statusColumns: DataTableColumn[] = [
    { key: "name", label: "Name" },
    { key: "role", label: "Role" },
    { key: "model", label: "Model" },
    { key: "status", label: "Status", width: "120px" },
    { key: "calls", label: "Calls", width: "80px" },
    { key: "cost", label: "Cost", width: "100px" },
    { key: "cacheRead", label: "Cache Read", width: "110px" },
  ];

  const statusRows: Record<string, any>[] = [];
  if (agentStatus) {
    for (const a of agentStatus.persistentAgents) {
      statusRows.push({
        name: <span className="font-medium text-slate-700 dark:text-slate-200">{a.name}</span>,
        role: a.role ?? "-",
        model: <span className="text-xs text-slate-500 dark:text-slate-400">{a.model || "-"}</span>,
        status: (
          <div className="flex items-center gap-2">
            <StatusDot status={toStatusKind(a.status)} />
            <span className="text-slate-600 dark:text-slate-400">{a.status}</span>
          </div>
        ),
        calls: a.callCount ?? 0,
        cost: formatCost(a.totalCost ?? 0),
        cacheRead: a.totalCacheRead > 0 ? formatTokens(a.totalCacheRead) : "0",
      });
    }
    for (const a of agentStatus.blackboardAgents) {
      statusRows.push({
        name: <span className="font-medium text-slate-700 dark:text-slate-200">{a.name}</span>,
        role: a.role ?? "-",
        model: <span className="text-xs text-slate-400">blackboard</span>,
        status: (
          <div className="flex items-center gap-2">
            <StatusDot status={toStatusKind(a.status)} />
            <span className="text-slate-600 dark:text-slate-400">{a.status}</span>
          </div>
        ),
        calls: "-",
        cost: "-",
        cacheRead: "-",
      });
    }
  }

  // ── Section 3: Agent Telemetry rows ──
  const telemetryColumns: DataTableColumn[] = [
    { key: "name", label: "Name" },
    { key: "runs", label: "Runs", width: "80px" },
    { key: "hitRate", label: "Avg Hit Rate", width: "120px" },
    { key: "turns", label: "Avg Turns", width: "100px" },
    { key: "failures", label: "Failures", width: "90px" },
    { key: "retries", label: "Retries", width: "90px" },
    { key: "models", label: "Models" },
  ];

  let telemetry: AgentTelemetry[] = [];
  if (agentStatus?.agentTelemetry) {
    telemetry = Array.from(agentStatus.agentTelemetry.values());
  }
  const telemetryRows: Record<string, any>[] = telemetry.map((t) => ({
    name: <span className="font-medium text-slate-700 dark:text-slate-200">{t.name}</span>,
    runs: t.runs,
    hitRate: formatHitRate(t.avgHitRate),
    turns: t.avgTurns.toFixed(1),
    failures: t.failures,
    retries: t.retries,
    models: (
      <span className="text-xs text-slate-500 dark:text-slate-400">{t.models.join(", ") || "-"}</span>
    ),
  }));

  // ── Section 1: Definition cards ──
  const renderDefinitions = () => {
    if (loadingDefs) {
      return (
        <div className="py-8 text-center text-sm text-slate-400">
          Loading agent definitions...
        </div>
      );
    }
    if (definitions.length === 0) {
      return (
        <EmptyState
          icon="Bot"
          message="No agent definitions found in .agentflux/agents/"
        />
      );
    }
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {definitions.map((d) => (
          <div
            key={d.name}
            className="bg-white dark:bg-slate-800 rounded-lg shadow border border-slate-200 dark:border-slate-700 p-5 flex flex-col gap-2"
          >
            <div className="flex items-center gap-2">
              <Icon name="Bot" size={18} className="text-blue-500" />
              <span className="font-bold text-slate-800 dark:text-slate-200">{d.name}</span>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">{d.description || "No description"}</p>
            <div className="flex flex-wrap gap-1.5 mt-1">
              <Badge color="blue">{d.model}</Badge>
              <Badge color="purple">thinking: {d.thinking}</Badge>
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {d.tools.length > 0 ? d.tools.join(", ") : "no tools"}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <AgentRegistryPanel />

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-200">Agents</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Agent definitions, live status, and per-agent telemetry.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/40 text-sm text-slate-600 dark:text-slate-400"
          title="Refresh agent status"
        >
          <Icon name="RefreshCw" size={16} className="text-slate-500 dark:text-slate-400" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Section 1: Agent Definitions */}
      <section className="bg-white dark:bg-slate-800 rounded-lg shadow border border-slate-200 dark:border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-slate-700 dark:text-slate-200 mb-4">
          Agent Definitions
        </h2>
        {renderDefinitions()}
      </section>

      {/* Section 2: Agent Status */}
      <section className="bg-white dark:bg-slate-800 rounded-lg shadow border border-slate-200 dark:border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-slate-700 dark:text-slate-200 mb-4">
          Agent Status
        </h2>
        {statusRows.length === 0 ? (
          <EmptyState
            icon="Users"
            message="No active agents. Run a multi-agent command to see live status."
          />
        ) : (
          <div className="overflow-x-auto">
            <DataTable columns={statusColumns} rows={statusRows} />
          </div>
        )}
      </section>

      {/* Section 3: Agent Telemetry */}
      <section className="bg-white dark:bg-slate-800 rounded-lg shadow border border-slate-200 dark:border-slate-700 p-6">
        <h2 className="text-lg font-semibold text-slate-700 dark:text-slate-200 mb-4">
          Agent Telemetry
        </h2>
        {telemetryRows.length === 0 ? (
          <EmptyState
            icon="Activity"
            message="No telemetry data yet. Subagent run events will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <DataTable columns={telemetryColumns} rows={telemetryRows} />
          </div>
        )}
      </section>

      <div className="mt-4">
        <AgentPerformanceTable />
      </div>

      <div className="mt-4">
        <AgentOutputViewer />
      </div>

      <div className="mt-4">
        <AgentRetryHistory />
      </div>

      <div className="mt-4">
        <AgentToolMatrix />
      </div>

      <div className="mt-4">
        <AgentCapabilityRadar />
      </div>

      <div className="mt-4">
        <AgentComparisonTable />
      </div>
    </div>
  );
};

export default AgentsPage;
