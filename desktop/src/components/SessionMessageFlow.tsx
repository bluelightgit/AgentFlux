/**
 * SessionMessageFlow — visualizes the conversation flow pattern within a
 * single session file as an alternating left/right chat timeline, plus a
 * summary of message counts and token usage.
 *
 * Reads `.jsonl` session files from `<fluxDir>/runtime/sessions` using the
 * shared `readSessionMessages` parser, and polls the active file every 5s
 * for live updates.
 */
import React, { useEffect, useState, useCallback } from "react";
import { Card, Badge, Icon, EmptyState } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";
import { readSessionMessages } from "../lib/session-reader";
import { formatTokens, formatTs } from "../lib/format";

// ─── types ─────────────────────────────────────────────────────────────────

interface FlowMessage {
  role: string;
  timestamp: string;
  contentPreview: string;
  tokenCount: number;
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** Extract readable text from a message content array (type='text' blocks). */
function extractText(content: any[] | undefined): string {
  if (!Array.isArray(content)) return "";
  for (const item of content) {
    if (item && item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

/** Trim a string to its last `max` characters, ellipsis-prefixed when longer. */
function tailPreview(text: string, max: number): string {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return "…" + collapsed.slice(-(max - 1));
}

/** Sum input + output tokens from a usage object, if present. */
function usageTokens(usage: any | undefined): number {
  if (!usage) return 0;
  const input = Number(usage.input ?? 0);
  const output = Number(usage.output ?? 0);
  const cacheRead = Number(usage.cacheRead ?? 0);
  const cacheCreation = Number(usage.cacheCreation ?? 0);
  return input + output + cacheRead + cacheCreation;
}

/** Resolve a session timestamp (string) into a locale-formatted label. */
function tsLabel(ts: string): string {
  if (!ts) return "-";
  if (/^\d+$/.test(ts)) return formatTs(Number(ts));
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

// ─── main component ──────────────────────────────────────────────────────────

export function SessionMessageFlow(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);
  const selectedSessionFile = useDashboardStore((s) => s.selectedSessionFile);

  const [messages, setMessages] = useState<FlowMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const load = useCallback(async () => {
    if (!fluxDir || !selectedSessionFile) {
      setMessages([]);
      return;
    }
    const filePath = `${fluxDir}/runtime/sessions/${selectedSessionFile}`;
    setLoading(true);
    try {
      const parsed = await readSessionMessages(filePath);
      const flow: FlowMessage[] = parsed.map((m) => ({
        role: m.role,
        timestamp: m.timestamp,
        contentPreview: tailPreview(extractText(m.content), 100),
        tokenCount: usageTokens(m.usage),
      }));
      setMessages(flow);
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir, selectedSessionFile]);

  // Load on selection change.
  useEffect(() => {
    load();
  }, [load]);

  // Poll every 5s for live updates while a session is selected.
  useEffect(() => {
    if (!fluxDir || !selectedSessionFile) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  // ─── summary stats ─────────────────────────────────────────────────────
  const total = messages.length;
  const userCount = messages.filter((m) => m.role === "user").length;
  const assistantCount = messages.filter((m) => m.role === "assistant").length;
  const totalTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0);
  const avgTokens = total > 0 ? Math.round(totalTokens / total) : 0;

  // Visible messages (cap at 50 most recent; older ones are dropped from view).
  const visible = messages.slice(-50);

  return (
    <Card className="flex flex-col gap-4">
      {/* header */}
      <div className="flex items-center gap-2">
        <Icon name="MessageSquare" size={18} className="text-slate-400 dark:text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Message Flow
        </h2>
        {loading ? (
          <Icon
            name="Loader2"
            size={14}
            className="animate-spin text-slate-400 dark:text-slate-500"
          />
        ) : null}
      </div>

      {/* body */}
      {!selectedSessionFile ? (
        <EmptyState
          icon="MessageSquare"
          message="Select a session to view message flow"
        />
      ) : visible.length === 0 ? (
        <EmptyState icon="MessageSquare" message="No messages in this session" />
      ) : (
        <>
          <div className="max-h-[28rem] overflow-y-auto flex flex-col gap-3 pr-1">
            {visible.map((m, i) => {
              const isUser = m.role === "user";
              return (
                <div
                  key={i}
                  className={`flex ${isUser ? "justify-start" : "justify-end"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 ${
                      isUser
                        ? "border-l-2 border-l-blue-400 dark:border-l-blue-500"
                        : "border-l-2 border-l-green-400 dark:border-l-green-500"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Badge color={roleColor(m.role)}>{m.role}</Badge>
                      <span className="text-xs text-slate-400 dark:text-slate-500">
                        {tsLabel(m.timestamp)}
                      </span>
                    </div>
                    {m.contentPreview ? (
                      <p className="mt-1 text-sm text-slate-700 dark:text-slate-200 break-words">
                        {m.contentPreview}
                      </p>
                    ) : null}
                    <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                      {formatTokens(m.tokenCount)} tokens
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* summary */}
          <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 text-center">
              <div>
                <div className="text-lg font-bold text-slate-800 dark:text-slate-100">
                  {total}
                </div>
                <div className="text-xs text-slate-400 dark:text-slate-500">
                  total messages
                </div>
              </div>
              <div>
                <div className="text-lg font-bold text-blue-600 dark:text-blue-300">
                  {userCount}
                </div>
                <div className="text-xs text-slate-400 dark:text-slate-500">
                  user
                </div>
              </div>
              <div>
                <div className="text-lg font-bold text-green-600 dark:text-green-300">
                  {assistantCount}
                </div>
                <div className="text-xs text-slate-400 dark:text-slate-500">
                  assistant
                </div>
              </div>
              <div>
                <div className="text-lg font-bold text-slate-800 dark:text-slate-100">
                  {formatTokens(totalTokens)}
                </div>
                <div className="text-xs text-slate-400 dark:text-slate-500">
                  total tokens
                </div>
              </div>
              <div>
                <div className="text-lg font-bold text-slate-800 dark:text-slate-100">
                  {formatTokens(avgTokens)}
                </div>
                <div className="text-xs text-slate-400 dark:text-slate-500">
                  avg / message
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

export default SessionMessageFlow;
