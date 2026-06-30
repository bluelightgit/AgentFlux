/**
 * Issues Page — Kanban board for task/issue tracking
 * Inspired by Paperclip's issue management.
 *
 * Data source: `.agentflux/issues.json` (array of issues)
 * Loaded/written via Electron preload bridge (ipcRenderer).
 */
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Card, Badge, Icon, StatusDot, EmptyState } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";

// ─── Types ────────────────────────────────────────────────────────────────

type IssueStatus = "open" | "in_progress" | "review" | "done";
type Priority = "low" | "medium" | "high" | "critical";

interface Issue {
  id: string;
  title: string;
  status: IssueStatus;
  assignee?: string;
  priority: Priority;
  created: number;
  updated: number;
  tags: string[];
  dagRef?: string;
  description?: string;
}

interface ColumnDef {
  status: IssueStatus;
  label: string;
}

const COLUMNS: ColumnDef[] = [
  { status: "open", label: "Open" },
  { status: "in_progress", label: "In Progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

const PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];

// Map issue priority → StatusDot kind (critical=red, high=amber, medium=blue, low=gray)
const PRIORITY_DOT: Record<Priority, "failed" | "pending" | "running" | "idle"> = {
  critical: "failed",
  high: "pending",
  medium: "running",
  low: "idle",
};

const PRIORITY_BADGE_COLOR: Record<
  Priority,
  "red" | "amber" | "blue" | "slate"
> = {
  critical: "red",
  high: "amber",
  medium: "blue",
  low: "slate",
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

function formatRelative(ts: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function generateId(): string {
  return `iss_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function normalizeIssues(raw: unknown): Issue[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === "object")
    .map((r: any) => ({
      id: String(r.id ?? generateId()),
      title: String(r.title ?? "Untitled"),
      status: (["open", "in_progress", "review", "done"].includes(r.status)
        ? r.status
        : "open") as IssueStatus,
      assignee: r.assignee ? String(r.assignee) : undefined,
      priority: (["low", "medium", "high", "critical"].includes(r.priority)
        ? r.priority
        : "medium") as Priority,
      created: Number(r.created) || Date.now(),
      updated: Number(r.updated) || Date.now(),
      tags: Array.isArray(r.tags)
        ? r.tags.map(String).filter(Boolean)
        : [],
      dagRef: r.dagRef ? String(r.dagRef) : undefined,
      description: r.description ? String(r.description) : undefined,
    }));
}

// ─── Component ─────────────────────────────────────────────────────────────

export const IssuesPage: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const fluxDir = project?.fluxDir ?? "";

  const issuesPath = useMemo(
    () => (fluxDir ? `${fluxDir}/issues.json` : ""),
    [fluxDir],
  );

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── Load issues ──
  const loadIssues = useCallback(async () => {
    if (!issuesPath) {
      setLoading(false);
      setError("No project configured");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (!window.api?.ipcRenderer) {
        setError("Electron API not available");
        setLoading(false);
        return;
      }
      const raw = await window.api.ipcRenderer.invoke("read-file", issuesPath);
      if (raw == null || raw === "") {
        setIssues([]);
      } else {
        try {
          setIssues(normalizeIssues(JSON.parse(raw)));
        } catch {
          setIssues([]);
          setError("issues.json is not valid JSON");
        }
      }
    } catch (err: any) {
      // File doesn't exist or unreadable → empty board
      setIssues([]);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [issuesPath]);

  useEffect(() => {
    loadIssues();
  }, [loadIssues]);

  // ── Persist issues ──
  const persistIssues = useCallback(
    async (next: Issue[]) => {
      if (!issuesPath || !window.api?.ipcRenderer) return;
      try {
        await window.api.ipcRenderer.invoke(
          "write-file",
          issuesPath,
          JSON.stringify(next, null, 2),
        );
      } catch (err: any) {
        setError(`Failed to save issues: ${err?.message ?? err}`);
      }
    },
    [issuesPath],
  );

  // ── Create new issue ──
  const handleCreate = useCallback(
    async (draft: {
      title: string;
      priority: Priority;
      assignee: string;
    }) => {
      const now = Date.now();
      const issue: Issue = {
        id: generateId(),
        title: draft.title.trim() || "Untitled",
        status: "open",
        assignee: draft.assignee.trim() || undefined,
        priority: draft.priority,
        created: now,
        updated: now,
        tags: [],
      };
      const next = [issue, ...issues];
      setIssues(next);
      await persistIssues(next);
      setShowForm(false);
    },
    [issues, persistIssues],
  );

  // ── Change status ──
  const handleStatusChange = useCallback(
    async (id: string, status: IssueStatus) => {
      const next = issues.map((i) =>
        i.id === id ? { ...i, status, updated: Date.now() } : i,
      );
      setIssues(next);
      await persistIssues(next);
    },
    [issues, persistIssues],
  );

  // ── Group by column ──
  const grouped = useMemo(() => {
    const map: Record<IssueStatus, Issue[]> = {
      open: [],
      in_progress: [],
      review: [],
      done: [],
    };
    for (const i of issues) map[i.status].push(i);
    return map;
  }, [issues]);

  const hasIssues = issues.length > 0;

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">
            Issues
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Kanban board for tracking tasks and issues across the project.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-2 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          <Icon name="Plus" size={16} />
          New Issue
        </button>
      </div>

      {/* New issue form */}
      {showForm && (
        <NewIssueForm onCreate={handleCreate} onCancel={() => setShowForm(false)} />
      )}

      {/* Error banner */}
      {error && (
        <div className="rounded-lg p-3 text-sm bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-700">
          {error}
        </div>
      )}

      {/* Board */}
      {loading ? (
        <div className="text-sm text-slate-400 dark:text-slate-500 py-12 text-center">
          Loading issues...
        </div>
      ) : !hasIssues ? (
        <Card>
          <EmptyState
            icon="FolderOpen"
            message={
              issuesPath
                ? "No issues yet. Create one with the New Issue button."
                : "No project configured."
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {COLUMNS.map((col) => (
            <Column
              key={col.status}
              column={col}
              issues={grouped[col.status]}
              expandedId={expandedId}
              onToggleExpand={(id) =>
                setExpandedId((cur) => (cur === id ? null : id))
              }
              onStatusChange={handleStatusChange}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Column ────────────────────────────────────────────────────────────────

interface ColumnProps {
  column: ColumnDef;
  issues: Issue[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onStatusChange: (id: string, status: IssueStatus) => void;
}

const Column: React.FC<ColumnProps> = ({
  column,
  issues,
  expandedId,
  onToggleExpand,
  onStatusChange,
}) => {
  return (
    <div className="flex flex-col rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 min-h-[200px]">
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {column.label}
        </span>
        <Badge color="slate">{issues.length}</Badge>
      </div>

      {/* Issue cards */}
      <div className="flex flex-col gap-2 p-2 overflow-y-auto">
        {issues.length === 0 ? (
          <div className="text-xs text-slate-400 dark:text-slate-500 text-center py-6">
            No issues
          </div>
        ) : (
          issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              expanded={expandedId === issue.id}
              onToggleExpand={() => onToggleExpand(issue.id)}
              onStatusChange={(status) => onStatusChange(issue.id, status)}
            />
          ))
        )}
      </div>
    </div>
  );
};

// ─── IssueCard ─────────────────────────────────────────────────────────────

interface IssueCardProps {
  issue: Issue;
  expanded: boolean;
  onToggleExpand: () => void;
  onStatusChange: (status: IssueStatus) => void;
}

const IssueCard: React.FC<IssueCardProps> = ({
  issue,
  expanded,
  onToggleExpand,
  onStatusChange,
}) => {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggleExpand}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleExpand();
        }
      }}
      className="cursor-pointer rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 shadow-sm hover:shadow-md hover:border-blue-300 dark:hover:border-blue-600 transition-shadow"
    >
      {/* Top row: priority dot + title */}
      <div className="flex items-start gap-2">
        <div className="mt-1.5 shrink-0">
          <StatusDot status={PRIORITY_DOT[issue.priority]} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-800 dark:text-slate-100 break-words">
            {issue.title}
          </div>
        </div>
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          size={16}
          className="text-slate-400 dark:text-slate-500 shrink-0"
        />
      </div>

      {/* Meta row */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {issue.assignee ? (
          <Badge color="purple">{issue.assignee}</Badge>
        ) : null}
        <Badge color={PRIORITY_BADGE_COLOR[issue.priority]}>
          {issue.priority}
        </Badge>
        {issue.tags.slice(0, 4).map((tag) => (
          <span
            key={tag}
            className="text-xs rounded-full px-2 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600"
          >
            {tag}
          </span>
        ))}
        {issue.tags.length > 4 ? (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            +{issue.tags.length - 4}
          </span>
        ) : null}
      </div>

      {/* Timestamp */}
      <div className="mt-2 text-xs text-slate-400 dark:text-slate-500">
        Updated {formatRelative(issue.updated)}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          {issue.description ? (
            <div className="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap">
              {issue.description}
            </div>
          ) : (
            <div className="text-xs text-slate-400 dark:text-slate-500 italic">
              No description provided.
            </div>
          )}

          {issue.dagRef ? (
            <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
              <Icon name="ExternalLink" size={12} />
              <span className="font-mono break-all">{issue.dagRef}</span>
            </div>
          ) : null}

          <div className="flex flex-col gap-0.5 text-xs text-slate-500 dark:text-slate-400">
            <span>Created: {formatTimestamp(issue.created)}</span>
            <span>Updated: {formatTimestamp(issue.updated)}</span>
            <span className="font-mono text-slate-400 dark:text-slate-500">
              ID: {issue.id}
            </span>
          </div>

          {/* Status change dropdown */}
          <div className="flex items-center gap-2 pt-1">
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Move to:
            </label>
            <select
              value={issue.status}
              onChange={(e) =>
                onStatusChange(e.target.value as IssueStatus)
              }
              className="text-xs rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {COLUMNS.map((col) => (
                <option key={col.status} value={col.status}>
                  {col.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── NewIssueForm ──────────────────────────────────────────────────────────

interface NewIssueFormProps {
  onCreate: (draft: {
    title: string;
    priority: Priority;
    assignee: string;
  }) => void;
  onCancel: () => void;
}

const NewIssueForm: React.FC<NewIssueFormProps> = ({ onCreate, onCancel }) => {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assignee, setAssignee] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onCreate({ title, priority, assignee });
  };

  const inputClass =
    "w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-700 dark:text-slate-200">
            Create New Issue
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            aria-label="Cancel"
          >
            <Icon name="X" size={16} />
          </button>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title..."
            autoFocus
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
              Priority
            </label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className={inputClass}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
              Assignee
            </label>
            <input
              type="text"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="Optional..."
              className={inputClass}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={!title.trim()}
            className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            Create
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
};

export default IssuesPage;
