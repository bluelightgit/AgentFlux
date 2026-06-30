/**
 * Sessions Page — two-panel session browser
 * Left: session list with cache hit rate / errors. Right: conversation messages.
 */
import React, { useEffect, useState } from "react";
import { Icon, StatusDot, EmptyState } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";
import { readSessionMessages, type SessionMessage, type SessionMetadata } from "../lib/session-reader";
import { formatPct, formatCost } from "../lib/format";

// Cache hit rate → StatusDot status
function cacheStatus(rate: number): "done" | "pending" | "failed" {
  if (rate > 0.7) return "done"; // green
  if (rate >= 0.3) return "pending"; // amber
  return "failed"; // red
}


// Extract readable text from a message content array
function extractContent(content: any[]): string {
  if (!Array.isArray(content)) return String(content ?? "");
  const parts: string[] = [];
  for (const item of content) {
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "toolCall") {
      parts.push(`[tool: ${item.name ?? "unknown"}]`);
    } else if (item.type === "toolResult") {
      const raw = typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? "");
      parts.push(raw.length > 200 ? raw.slice(0, 200) + "…" : raw);
    }
  }
  return parts.join("\n");
}

const ROLE_BADGE: Record<string, string> = {
  user: "bg-blue-50 text-blue-600",
  assistant: "bg-green-50 text-green-600",
  tool: "bg-slate-50 text-slate-600",
};

function roleBadgeClass(role: string): string {
  return ROLE_BADGE[role] ?? "bg-slate-50 text-slate-600";
}

// Usage bar — proportional input (blue) + cacheRead (green) + output (amber)
function UsageBar({ usage }: { usage: any }): React.ReactElement {
  if (!usage) return <></>;
  const input = Number(usage.input ?? 0);
  const cacheRead = Number(usage.cacheRead ?? 0);
  const output = Number(usage.output ?? 0);
  const total = input + cacheRead + output;
  if (total <= 0) return <></>;
  const inPct = (input / total) * 100;
  const cachePct = (cacheRead / total) * 100;
  const outPct = (output / total) * 100;
  return (
    <div className="mt-2">
      <div className="flex h-2 w-full overflow-hidden rounded bg-slate-100">
        <div style={{ width: `${inPct}%` }} className="bg-blue-500" />
        <div style={{ width: `${cachePct}%` }} className="bg-green-500" />
        <div style={{ width: `${outPct}%` }} className="bg-amber-500" />
      </div>
      <div className="mt-1 text-xs text-slate-500">
        in={input} cache={cacheRead} out={output}
      </div>
    </div>
  );
}

function MessageItem({ msg }: { msg: SessionMessage }): React.ReactElement {
  const text = extractContent(msg.content);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${roleBadgeClass(msg.role)}`}>
          {msg.role}
        </span>
        {msg.timestamp ? (
          <span className="text-xs text-slate-400">{msg.timestamp}</span>
        ) : null}
      </div>
      {text ? (
        <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-slate-700">
          {text}
        </pre>
      ) : null}
      {msg.usage ? <UsageBar usage={msg.usage} /> : null}
      {msg.errorMessage ? (
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-600">
          {msg.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

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
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50 ${
        active ? "border-l-2 border-blue-500 bg-blue-50" : "border-l-2 border-transparent"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-800">{meta.agentName || meta.sessionId}</span>
        {meta.hasErrors ? (
          <Icon name="AlertTriangle" size={14} className="text-red-500" />
        ) : null}
      </div>
      <div className="text-xs text-slate-500">
        {meta.model || "unknown"} · {meta.userMsgs + meta.assistantMsgs} turns · {formatCost(meta.totalCost)}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <StatusDot status={cacheStatusKind} />
        <span className="text-xs text-slate-500">
          cache {formatPct(meta.cacheHitRate)}
        </span>
      </div>
      <div className="text-xs text-slate-400">{meta.timestamp}</div>
    </button>
  );
}

export const SessionsPage: React.FC = () => {
  const sessions = useDashboardStore((s) => s.sessions);
  const selectedSessionFile = useDashboardStore((s) => s.selectedSessionFile);
  const selectSession = useDashboardStore((s) => s.selectSession);
  const loadSessions = useDashboardStore((s) => s.loadSessions);
  const project = useDashboardStore((s) => s.project);

  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="flex h-full">
      {/* Left panel */}
      <div className="w-80 overflow-auto border-r border-slate-200">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-lg font-bold text-slate-800">Sessions</span>
          <button
            type="button"
            onClick={() => loadSessions()}
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            title="Refresh"
          >
            <Icon name="RefreshCw" size={16} />
          </button>
        </div>
        {sessions.length === 0 ? (
          <EmptyState icon="MessageSquare" message="No sessions found" />
        ) : (
          sessions.map((s) => (
            <SessionListItem
              key={s.fileName}
              meta={s}
              active={selectedSessionFile === s.fileName}
              onClick={() => selectSession(s.fileName)}
            />
          ))
        )}
      </div>

      {/* Right panel */}
      <div className="flex-1 overflow-auto p-6">
        {!selectedSessionFile ? (
          <EmptyState icon="MessageSquare" message="Select a session to view conversation" />
        ) : loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-slate-400">
            <Icon name="RefreshCw" size={20} className="mr-2 animate-spin" />
            Loading messages…
          </div>
        ) : messages.length === 0 ? (
          <EmptyState icon="MessageSquare" message="No messages in this session" />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m, i) => (
              <MessageItem key={i} msg={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionsPage;
