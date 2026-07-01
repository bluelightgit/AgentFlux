/**
 * DirectMessagePanel — 1-on-1 direct messages between agents.
 *
 * Reads the shared direct-message stream (`<fluxDir>/shared/direct/
 * messages.jsonl`) via `getDirectMessages`, groups messages by conversation
 * pair (sorted [from, to] join), and renders each conversation as a header
 * (from → to + count badge) followed by its message list. Unread messages
 * are highlighted with a blue left border.
 *
 * Loads on mount and polls every 3 seconds.
 */
import React, { useEffect, useState, useMemo } from "react";
import { Card, Badge, Icon, EmptyState } from "./ui";
import { formatTime } from "../lib/format";
import { useDashboardStore } from "../store/dashboard-store";
import { getDirectMessages, type DirectMessage } from "../lib/group-reader";

// ---------------------------------------------------------------------------
// Conversation grouping
// ---------------------------------------------------------------------------

/** Build a stable conversation key from a sorted [from, to] pair. */
function conversationKey(from: string, to: string): string {
  return [from, to].sort().join("\u2192");
}

/**
 * Group direct messages into conversation buckets keyed by sorted
 * [from, to] pair. Preserves first-seen `from`/`to` for header rendering.
 */
function groupByConversation(
  messages: DirectMessage[],
): { key: string; from: string; to: string; messages: DirectMessage[] }[] {
  const map = new Map<
    string,
    { from: string; to: string; messages: DirectMessage[] }
  >();
  for (const msg of messages) {
    const key = conversationKey(msg.from, msg.to);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { from: msg.from, to: msg.to, messages: [] };
      map.set(key, bucket);
    }
    bucket.messages.push(msg);
  }
  return Array.from(map.entries()).map(([key, bucket]) => ({
    key,
    from: bucket.from,
    to: bucket.to,
    messages: bucket.messages,
  }));
}

// ---------------------------------------------------------------------------
// Message item
// ---------------------------------------------------------------------------

function MessageItem({ msg }: { msg: DirectMessage }): React.ReactElement {
  const unreadClass = msg.read
    ? "border-l-2 border-transparent"
    : "border-l-2 border-blue-400";
  return (
    <div className={`pl-3 py-1 ${unreadClass}`}>
      <span className="text-xs text-slate-400 dark:text-slate-500">
        {msg.timestamp ? formatTime(msg.timestamp) : "-"}
      </span>
      <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-300">
        {msg.content}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function DirectMessagePanel(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  // Load direct messages from the shared stream.
  useEffect(() => {
    if (!fluxDir) {
      setMessages([]);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const msgs = await getDirectMessages(fluxDir);
        if (!cancelled) setMessages(msgs);
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    load();
    const timer = setInterval(load, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fluxDir]);

  const conversations = useMemo(
    () => groupByConversation(messages),
    [messages],
  );

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-3 mb-3">
        <Icon name="Mail" size={18} className="text-slate-500 dark:text-slate-400" />
        <span className="text-base font-semibold text-slate-800 dark:text-slate-100">
          Direct Messages
        </span>
        {conversations.length > 0 ? (
          <Badge color="slate">{messages.length}</Badge>
        ) : null}
      </div>

      {/* Body */}
      {loading && messages.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-sm text-slate-400 dark:text-slate-500">
          <Icon name="RefreshCw" size={20} className="mr-2 animate-spin" />
          Loading direct messages...
        </div>
      ) : messages.length === 0 ? (
        <EmptyState icon="Mail" message="No direct messages yet" />
      ) : (
        <div className="flex flex-col gap-4">
          {conversations.map((conv) => (
            <div
              key={conv.key}
              className="rounded-md border border-slate-200 dark:border-slate-700 p-3"
            >
              {/* Conversation header */}
              <div className="flex items-center gap-2 pb-2 mb-2 border-b border-slate-100 dark:border-slate-700">
                <Icon
                  name="ArrowLeftRight"
                  size={14}
                  className="text-slate-400 dark:text-slate-500"
                />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {conv.from}
                </span>
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  &rarr;
                </span>
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {conv.to}
                </span>
                <Badge color="blue">{conv.messages.length}</Badge>
              </div>

              {/* Messages */}
              <div className="flex flex-col gap-1">
                {conv.messages.map((msg) => (
                  <MessageItem
                    key={msg.id || `${conv.key}-${msg.timestamp}-${msg.from}`}
                    msg={msg}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default DirectMessagePanel;
