/**
 * AgentSessionViewer — two-panel browser for an agent's conversation history
 * stored in `.jsonl` session files under `<fluxDir>/runtime/sessions`.
 *
 * Left panel (w-72): list of session files with filename, entry count, modified date.
 * Right panel (flex-1): conversation view — role badges, extracted text content,
 * usage stats, and error messages rendered in red.
 */
import React, { useEffect, useState, useCallback } from "react";
import { Card, Badge, Icon, EmptyState } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";
import {
  listSessions,
  readSessionMessages,
  type SessionMetadata,
  type SessionMessage,
} from "../lib/session-reader";
import { formatTokens, formatTs } from "../lib/format";
import { MarkdownRenderer } from "./MarkdownRenderer";

// ─── helpers ───────────────────────────────────────────────────────────────

/** Truncate a filename to `max` chars, appending an ellipsis when exceeded. */
function truncate(name: string, max: number): string {
  if (!name) return "";
  return name.length > max ? name.slice(0, max) + "…" : name;
}

/** Extract readable text from a message content array (text / tool blocks). */
function extractText(content: any[] | undefined): string {
  if (!Array.isArray(content)) return "";
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

/** Total turn count for a session metadata entry. */
function entryCount(meta: SessionMetadata): number {
  return (meta.userMsgs || 0) + (meta.assistantMsgs || 0);
}

/** Resolve a session timestamp (string) into a locale-formatted label. */
function tsLabel(ts: string): string {
  if (!ts) return "-";
  // Numeric epoch milliseconds → use the shared formatter.
  if (/^\d+$/.test(ts)) return formatTs(Number(ts));
  // Otherwise try parsing as a date string.
  const ms = Date.parse(ts);
  if (Number.isFinite(ms)) return new Date(ms).toLocaleString();
  return ts;
}

/** Map a message role to a Badge color. */
function roleColor(role: string): "blue" | "green" | "slate" {
  switch (role) {
    case "user":
      return "blue";
    case "assistant":
      return "green";
    default:
      return "slate";
  }
}

// ─── sub-components ─────────────────────────────────────────────────────────

function SessionListItem({
  meta,
  active,
  onClick,
}: {
  meta: SessionMetadata;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-l-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/40 ${
        active
          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30"
          : "border-transparent"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="truncate font-mono text-sm text-slate-800 dark:text-slate-100"
          title={meta.fileName}
        >
          {truncate(meta.fileName, 30)}
        </span>
        {meta.hasErrors ? (
          <Icon name="AlertTriangle" size={14} className="shrink-0 text-red-500" />
        ) : null}
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{entryCount(meta)} entries</span>
        <span>{tsLabel(meta.timestamp)}</span>
      </div>
    </button>
  );
}

function MessageItem({ msg }: { msg: SessionMessage }): React.ReactElement {
  const text = extractText(msg.content);
  const usage = msg.usage;
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
      <div className="flex items-center gap-2">
        <Badge color={roleColor(msg.role)}>{msg.role}</Badge>
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
      {usage ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>in {formatTokens(Number(usage.input ?? 0))}</span>
          <span>out {formatTokens(Number(usage.output ?? 0))}</span>
          <span>cache {formatTokens(Number(usage.cacheRead ?? 0))}</span>
        </div>
      ) : null}
      {msg.errorMessage ? (
        <div className="mt-2 rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-2 text-xs text-red-600 dark:text-red-300">
          {msg.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

export function AgentSessionViewer(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [entries, setEntries] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  // Load session list on mount / when fluxDir changes.
  useEffect(() => {
    let cancelled = false;
    if (!fluxDir) {
      setSessions([]);
      return;
    }
    const sessionsDir = `${fluxDir}/runtime/sessions`;
    setLoading(true);
    listSessions(sessionsDir)
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fluxDir]);

  // Load entries when the selected file changes.
  const loadEntries = useCallback(
    async (fileName: string | null) => {
      if (!fluxDir || !fileName) {
        setEntries([]);
        return;
      }
      const filePath = `${fluxDir}/runtime/sessions/${fileName}`;
      setLoading(true);
      try {
        const msgs = await readSessionMessages(filePath);
        setEntries(msgs);
      } catch {
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [fluxDir],
  );

  useEffect(() => {
    loadEntries(selectedFile);
  }, [selectedFile, loadEntries]);

  return (
    <div className="flex h-full w-full gap-4 p-4">
      {/* Left panel — session list */}
      <Card className="w-72 shrink-0 flex flex-col p-0 overflow-hidden">
        <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Sessions
          </h2>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {sessions.length} file{sessions.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-700/60">
          {loading && sessions.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Icon
                name="Loader2"
                size={20}
                className="animate-spin text-slate-400 dark:text-slate-500"
              />
            </div>
          ) : sessions.length === 0 ? (
            <EmptyState icon="File" message="No session files found" />
          ) : (
            sessions.map((meta) => (
              <SessionListItem
                key={meta.fileName}
                meta={meta}
                active={selectedFile === meta.fileName}
                onClick={() => setSelectedFile(meta.fileName)}
              />
            ))
          )}
        </div>
      </Card>

      {/* Right panel — conversation view */}
      <Card className="flex-1 flex flex-col p-0 overflow-hidden">
        <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Conversation
          </h2>
          <p
            className="truncate font-mono text-xs text-slate-400 dark:text-slate-500"
            title={selectedFile ?? undefined}
          >
            {selectedFile ? truncate(selectedFile, 60) : "No session selected"}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {!selectedFile ? (
            <EmptyState
              icon="MessageSquare"
              message="Select a session to view its conversation"
            />
          ) : loading && entries.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Icon
                name="Loader2"
                size={20}
                className="animate-spin text-slate-400 dark:text-slate-500"
              />
            </div>
          ) : entries.length === 0 ? (
            <EmptyState icon="MessageSquare" message="No messages in this session" />
          ) : (
            <div className="flex flex-col gap-3">
              {entries.map((msg, i) => (
                <MessageItem key={i} msg={msg} />
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default AgentSessionViewer;
