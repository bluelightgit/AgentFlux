/**
 * Sessions Page — two-panel session browser.
 *
 * Left panel  (w-80, fixed):    search/filter bar + session list with cache
 *                               hit rate, turn count, cost, error badges.
 * Right panel (flex-1, scroll): view-mode tab bar (Conversation / Agent
 *                               Sessions) + message stream rendered through
 *                               MarkdownRenderer.
 *
 * All text content is rendered via MarkdownRenderer — no plain <pre> blocks.
 */
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Icon, StatusDot, EmptyState } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";
import { readSessionMessages, type SessionMessage, type SessionMetadata } from "../lib/session-reader";
import { formatTokens, formatTs, formatPct, formatCost } from "../lib/format";
import { useLiveUpdate } from "../hooks/useLiveUpdate";
import { AgentSessionViewer } from "./AgentSessionViewer";
import { SessionMessageFlow } from "./SessionMessageFlow";
import { MarkdownRenderer } from "./MarkdownRenderer";

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

/** Cache hit rate → StatusDot status. */
function cacheStatus(rate: number): "done" | "pending" | "failed" {
  if (rate > 0.7) return "done";
  if (rate >= 0.3) return "pending";
  return "failed";
}

/** Extract readable text from a message content array (text / tool blocks). */
function extractContent(content: any[]): string {
  if (!Array.isArray(content)) return String(content ?? "");
  const parts: string[] = [];
  for (const item of content) {
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "toolCall") {
      parts.push(`**[tool: ${item.name ?? "unknown"}]**`);
    } else if (item.type === "toolResult") {
      const raw = typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? "");
      parts.push("```\n" + (raw.length > 200 ? raw.slice(0, 200) + "…" : raw) + "\n```");
    }
  }
  return parts.join("\n\n");
}

const ROLE_BADGE: Record<string, string> = {
  user: "bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300",
  assistant: "bg-green-50 text-green-600 dark:bg-green-900/40 dark:text-green-300",
  tool: "bg-slate-50 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300",
};

function roleBadgeClass(role: string): string {
  return ROLE_BADGE[role] ?? "bg-slate-50 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300";
}

/** Resolve a session/message timestamp (string) into a locale label. */
function tsLabel(ts: string): string {
  if (!ts) return "";
  if (/^\d+$/.test(ts)) return formatTs(Number(ts));
  const ms = Date.parse(ts);
  if (Number.isFinite(ms)) return new Date(ms).toLocaleString();
  return ts;
}

// ----------------------------------------------------------------------------
// UsageBar — proportional input (blue) + cacheRead (green) + output (amber)
// ----------------------------------------------------------------------------

function UsageBar({ usage }: { usage: any }): React.ReactElement | null {
  if (!usage) return null;
  const input = Number(usage.input ?? 0);
  const cacheRead = Number(usage.cacheRead ?? 0);
  const output = Number(usage.output ?? 0);
  const total = input + cacheRead + output;
  if (total <= 0) return null;
  const inPct = (input / total) * 100;
  const cachePct = (cacheRead / total) * 100;
  const outPct = (output / total) * 100;
  return (
    <div className="mt-3">
      <div className="flex h-2 w-full overflow-hidden rounded bg-slate-100 dark:bg-slate-700/60">
        <div style={{ width: `${inPct}%` }} className="bg-blue-500" />
        <div style={{ width: `${cachePct}%` }} className="bg-green-500" />
        <div style={{ width: `${outPct}%` }} className="bg-amber-500" />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
        <span>in {formatTokens(input)}</span>
        <span>cache {formatTokens(cacheRead)}</span>
        <span>out {formatTokens(output)}</span>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// MessageItem
// ----------------------------------------------------------------------------

function MessageItem({ msg }: { msg: SessionMessage }): React.ReactElement {
  const text = extractContent(msg.content);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${roleBadgeClass(msg.role)}`}
        >
          {msg.role}
        </span>
        {msg.timestamp ? (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {tsLabel(msg.timestamp)}
          </span>
        ) : null}
      </div>
      {text ? (
        <div className="mt-2">
          <MarkdownRenderer content={text} />
        </div>
      ) : null}
      {msg.usage ? <UsageBar usage={msg.usage} /> : null}
      {msg.errorMessage ? (
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-600 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
          {msg.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------------------
// SessionListItem
// ----------------------------------------------------------------------------

function SessionListItem({
  meta,
  active,
  onClick,
}: {
  meta: SessionMetadata;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  const cacheStatusKind = cacheStatus(meta.cacheHitRate);
  const turns = meta.userMsgs + meta.assistantMsgs;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-b border-slate-100 px-3 py-2.5 text-left hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/40 ${
        active
          ? "border-l-2 border-blue-500 bg-blue-50 dark:bg-blue-900/30"
          : "border-l-2 border-transparent"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-slate-800 dark:text-slate-100">
          {meta.agentName || meta.sessionId}
        </span>
        {meta.hasErrors ? (
          <Icon name="AlertTriangle" size={14} className="shrink-0 text-red-500" />
        ) : null}
      </div>
      <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
        {meta.model || "unknown"}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{turns} turns</span>
        <span>{formatCost(meta.totalCost)}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <StatusDot status={cacheStatusKind} />
        <span className="text-xs text-slate-500 dark:text-slate-400">
          cache {formatPct(meta.cacheHitRate)}
        </span>
      </div>
      <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
        {tsLabel(meta.timestamp)}
      </div>
    </button>
  );
}

// ----------------------------------------------------------------------------
// FilterBar — search + model / status / sort controls
// ----------------------------------------------------------------------------

type StatusFilter = "all" | "errors" | "no-errors";
type SortKey = "recent" | "cost" | "cache" | "turns";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "cost", label: "Cost" },
  { value: "cache", label: "Cache Hit" },
  { value: "turns", label: "Turns" },
];

function FilterBar({
  search,
  onSearch,
  models,
  modelFilter,
  onModelFilter,
  statusFilter,
  onStatusFilter,
  sort,
  onSort,
}: {
  search: string;
  onSearch: (v: string) => void;
  models: string[];
  modelFilter: string;
  onModelFilter: (v: string) => void;
  statusFilter: StatusFilter;
  onStatusFilter: (v: StatusFilter) => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
}): React.ReactElement {
  const selectClass =
    "flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200";
  return (
    <div className="flex flex-col gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
      <div className="relative">
        <Icon
          name="Search"
          size={14}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search agent or model"
          className="w-full rounded-md border border-slate-200 bg-white py-1 pl-7 pr-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        />
      </div>
      <div className="flex items-center gap-2">
        <select
          value={modelFilter}
          onChange={(e) => onModelFilter(e.target.value)}
          className={selectClass}
          title="Filter by model"
        >
          <option value="all">All models</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => onStatusFilter(e.target.value as StatusFilter)}
          className={selectClass}
          title="Filter by status"
        >
          <option value="all">All</option>
          <option value="errors">Has Errors</option>
          <option value="no-errors">No Errors</option>
        </select>
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className={selectClass}
          title="Sort sessions"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// SessionTabs — recently viewed sessions
// ----------------------------------------------------------------------------

function SessionTabs({
  openTabs,
  activeTab,
  metaByFile,
  onActivate,
  onClose,
}: {
  openTabs: string[];
  activeTab: string | null;
  metaByFile: Map<string, SessionMetadata>;
  onActivate: (fileName: string) => void;
  onClose: (fileName: string) => void;
}): React.ReactElement | null {
  if (openTabs.length === 0) return null;
  return (
    <div className="flex items-stretch gap-1 border-b border-slate-200 bg-slate-50 px-2 pt-1 dark:border-slate-700 dark:bg-slate-900/40">
      {openTabs.map((fileName) => {
        const meta = metaByFile.get(fileName);
        const label = meta ? meta.agentName || meta.sessionId : fileName;
        const isActive = activeTab === fileName;
        return (
          <div
            key={fileName}
            className={`group flex items-center gap-1 rounded-t border border-b-0 px-3 py-1.5 text-sm ${
              isActive
                ? "border-slate-200 bg-white text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:text-blue-300"
                : "border-transparent bg-white/60 text-slate-600 hover:bg-white dark:bg-slate-800/40 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            <button
              type="button"
              onClick={() => onActivate(fileName)}
              className="truncate focus:outline-none"
              title={fileName}
            >
              {label}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(fileName);
              }}
              className="ml-1 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
              title="Close tab"
            >
              <Icon name="X" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------
// ViewModeTabBar — switch right panel between Conversation / Agent Sessions
// ----------------------------------------------------------------------------

type ViewMode = "conversation" | "agent-sessions";

function ViewModeTabBar({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}): React.ReactElement {
  const tabs: { id: ViewMode; label: string; icon: string }[] = [
    { id: "conversation", label: "Conversation", icon: "MessageSquare" },
    { id: "agent-sessions", label: "Agent Sessions", icon: "Users" },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-slate-200 px-3 py-1.5 dark:border-slate-700">
      {tabs.map((t) => {
        const isActive = mode === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium ${
              isActive
                ? "bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700/40 dark:hover:text-slate-200"
            }`}
          >
            <Icon name={t.icon} size={14} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------
// main component
// ----------------------------------------------------------------------------

export const SessionsPage: React.FC = () => {
  const sessions = useDashboardStore((s) => s.sessions);
  const selectedSessionFile = useDashboardStore((s) => s.selectedSessionFile);
  const selectSession = useDashboardStore((s) => s.selectSession);
  const loadSessions = useDashboardStore((s) => s.loadSessions);
  const project = useDashboardStore((s) => s.project);

  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(false);

  // Session tabs state
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  // Right-panel view mode
  const [viewMode, setViewMode] = useState<ViewMode>("conversation");

  // Filter state
  const [search, setSearch] = useState("");
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");

  // Live update
  const sessionsDir = project ? project.fluxDir + "/runtime/sessions" : null;
  const { isLive, hasNewData, start, stop } = useLiveUpdate(sessionsDir, {
    onNewData: () => {
      loadSessions();
    },
  });

  // map fileName -> meta (for tab labels + lookups)
  const metaByFile = useMemo(() => {
    const m = new Map<string, SessionMetadata>();
    for (const s of sessions) m.set(s.fileName, s);
    return m;
  }, [sessions]);

  // available models for the filter dropdown
  const models = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) if (s.model) set.add(s.model);
    return Array.from(set).sort();
  }, [sessions]);

  // Filtered + sorted session list
  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = sessions.filter((s) => {
      if (q) {
        const hay = `${s.agentName} ${s.model}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (modelFilter !== "all" && s.model !== modelFilter) return false;
      if (statusFilter === "errors" && !s.hasErrors) return false;
      if (statusFilter === "no-errors" && s.hasErrors) return false;
      return true;
    });
    list = list.slice();
    switch (sort) {
      case "cost":
        list.sort((a, b) => b.totalCost - a.totalCost);
        break;
      case "cache":
        list.sort((a, b) => b.cacheHitRate - a.cacheHitRate);
        break;
      case "turns":
        list.sort((a, b) => (b.userMsgs + b.assistantMsgs) - (a.userMsgs + a.assistantMsgs));
        break;
      case "recent":
      default:
        list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        break;
    }
    return list;
  }, [sessions, search, modelFilter, statusFilter, sort]);

  // open a session: push into openTabs (cap last 5), set active
  const openSession = useCallback(
    (fileName: string) => {
      selectSession(fileName);
      setActiveTab(fileName);
      setOpenTabs((prev) => {
        const next = prev.filter((f) => f !== fileName);
        next.push(fileName);
        if (next.length > 5) next.splice(0, next.length - 5);
        return next;
      });
      setViewMode("conversation");
    },
    [selectSession],
  );

  // close a tab: remove, switch to next available or clear
  const closeTab = useCallback(
    (fileName: string) => {
      setOpenTabs((prev) => {
        const next = prev.filter((f) => f !== fileName);
        if (next.length === 0) {
          setActiveTab(null);
          selectSession("");
        } else if (activeTab === fileName) {
          const replacement = next[next.length - 1];
          setActiveTab(replacement);
          selectSession(replacement);
        }
        return next;
      });
    },
    [activeTab, selectSession],
  );

  // Load messages when selection changes
  useEffect(() => {
    if (!selectedSessionFile || !project) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const filePath = project.fluxDir + "/runtime/sessions/" + selectedSessionFile;
    readSessionMessages(filePath)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionFile, project]);

  // Prune tabs that no longer exist in the session list (e.g. after refresh)
  useEffect(() => {
    if (openTabs.length === 0) return;
    const valid = openTabs.filter((f) => metaByFile.has(f));
    if (valid.length !== openTabs.length) {
      setOpenTabs(valid);
      if (activeTab && !metaByFile.has(activeTab)) {
        const replacement = valid.length > 0 ? valid[valid.length - 1] : null;
        setActiveTab(replacement);
        selectSession(replacement ?? "");
      }
    }
  }, [sessions, metaByFile, openTabs, activeTab, selectSession]);

  const activeMeta = selectedSessionFile ? metaByFile.get(selectedSessionFile) : null;

  return (
    <div className="flex h-full">
      {/* ─── Left panel — session list ─────────────────────────────────── */}
      <div className="flex w-80 shrink-0 flex-col border-r border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-lg font-bold text-slate-800 dark:text-slate-100">
            Sessions
          </span>
          <div className="flex items-center gap-2">
            {isLive ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-600 dark:bg-green-900/40 dark:text-green-300">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
                Live
                {hasNewData ? <span className="text-green-400">·</span> : null}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => (isLive ? stop() : start())}
              className={`rounded p-1 ${
                isLive
                  ? "text-green-600 hover:bg-green-100 dark:text-green-400 dark:hover:bg-green-900/40"
                  : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700/40"
              }`}
              title={isLive ? "Stop live updates" : "Start live updates"}
            >
              <Icon name={isLive ? "Activity" : "RefreshCw"} size={14} />
            </button>
            <button
              type="button"
              onClick={() => loadSessions()}
              className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700/40"
              title="Refresh"
            >
              <Icon name="RefreshCw" size={16} />
            </button>
          </div>
        </div>
        <FilterBar
          search={search}
          onSearch={setSearch}
          models={models}
          modelFilter={modelFilter}
          onModelFilter={setModelFilter}
          statusFilter={statusFilter}
          onStatusFilter={setStatusFilter}
          sort={sort}
          onSort={setSort}
        />
        <div className="flex-1 overflow-auto">
          {filteredSessions.length === 0 ? (
            <EmptyState icon="MessageSquare" message="No sessions found" />
          ) : (
            filteredSessions.map((s) => (
              <SessionListItem
                key={s.fileName}
                meta={s}
                active={selectedSessionFile === s.fileName}
                onClick={() => openSession(s.fileName)}
              />
            ))
          )}
        </div>
      </div>

      {/* ─── Right panel — tab bar + message stream ────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <SessionTabs
          openTabs={openTabs}
          activeTab={activeTab}
          metaByFile={metaByFile}
          onActivate={(fileName) => openSession(fileName)}
          onClose={closeTab}
        />
        <ViewModeTabBar mode={viewMode} onChange={setViewMode} />

        {viewMode === "conversation" ? (
          <div className="flex-1 overflow-auto p-6">
            {!selectedSessionFile ? (
              <EmptyState
                icon="MessageSquare"
                message="Select a session to view conversation"
              />
            ) : loading ? (
              <div className="flex items-center justify-center py-12 text-sm text-slate-400 dark:text-slate-500">
                <Icon name="RefreshCw" size={20} className="mr-2 animate-spin" />
                Loading messages…
              </div>
            ) : messages.length === 0 ? (
              <EmptyState
                icon="MessageSquare"
                message="No messages in this session"
              />
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col gap-3">
                {activeMeta ? (
                  <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-medium text-slate-700 dark:text-slate-200">
                      {activeMeta.agentName || activeMeta.sessionId}
                    </span>
                    <span>{activeMeta.model || "unknown"}</span>
                    <span>{activeMeta.userMsgs + activeMeta.assistantMsgs} turns</span>
                    <span>cache {formatPct(activeMeta.cacheHitRate)}</span>
                    <span>{formatCost(activeMeta.totalCost)}</span>
                  </div>
                ) : null}
                {messages.map((m, i) => (
                  <MessageItem key={i} msg={m} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-4">
            <AgentSessionViewer />
            <div className="mt-4">
              <SessionMessageFlow />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionsPage;
