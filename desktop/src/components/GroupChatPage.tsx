/**
 * GroupChatPage — multi-agent group chat panel.
 *
 * Two-panel layout:
 *   - Left (w-64): list of agent groups with type icon + member count.
 *   - Right (flex-1): selected group header (name, members, live indicator)
 *     and a scrollable message stream. New messages auto-scroll to bottom.
 *
 * Live polling is driven by `useLiveUpdate` watching the group's
 * `messages.jsonl` file; on growth it re-fetches messages.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatTime } from "../lib/format";
import { useDashboardStore } from "../store/dashboard-store";
import {
  listGroups,
  getGroupMessages,
  type AgentGroup,
  type GroupMessage,
  type GroupType,
} from "../lib/group-reader";
import { useLiveUpdate } from "../hooks/useLiveUpdate";
import { DirectMessagePanel } from "./DirectMessagePanel";
import { AgentCommGraph } from "./AgentCommGraph";

// ---------------------------------------------------------------------------
// Type → icon name (Lucide) for group list badges
// ---------------------------------------------------------------------------
const GROUP_TYPE_ICON: Record<GroupType, string> = {
  all: "Users",
  team: "Users",
  direct: "User",
};

// ---------------------------------------------------------------------------
// Sender color palette — left border + name color, keyed by a stable hash of
// the sender name so the same agent always gets the same color.
// ---------------------------------------------------------------------------
const SENDER_PALETTE: { border: string; name: string }[] = [
  { border: "border-blue-400", name: "text-blue-600 dark:text-blue-300" },
  { border: "border-green-400", name: "text-green-600 dark:text-green-300" },
  { border: "border-purple-400", name: "text-purple-600 dark:text-purple-300" },
  { border: "border-amber-400", name: "text-amber-600 dark:text-amber-300" },
  { border: "border-pink-400", name: "text-pink-600 dark:text-pink-300" },
  { border: "border-cyan-400", name: "text-cyan-600 dark:text-cyan-300" },
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function senderColor(from: string): { border: string; name: string } {
  if (!from) return SENDER_PALETTE[0];
  return SENDER_PALETTE[hashString(from) % SENDER_PALETTE.length];
}

// ---------------------------------------------------------------------------
// Group list item
// ---------------------------------------------------------------------------
function GroupListItem({
  group,
  active,
  onClick,
}: {
  group: AgentGroup;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  const iconName = GROUP_TYPE_ICON[group.type] ?? "Users";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-l-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/60 ${
        active
          ? "border-blue-500 bg-blue-50 dark:bg-slate-700"
          : "border-transparent"
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon name={iconName} size={16} className="text-slate-400 dark:text-slate-500" />
        <span className="flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
          {group.name}
        </span>
        <Badge color="slate">{group.members.length}</Badge>
      </div>
      {group.description ? (
        <div className="mt-0.5 truncate pl-6 text-xs text-slate-400 dark:text-slate-500">
          {group.description}
        </div>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Message item
// ---------------------------------------------------------------------------
function MessageItem({ msg }: { msg: GroupMessage }): React.ReactElement {
  const color = senderColor(msg.from);
  return (
    <div
      className={`rounded-r-md border-l-2 ${color.border} bg-white dark:bg-slate-800 px-3 py-2`}
    >
      <div className="flex items-baseline gap-2">
        <span className={`text-sm font-medium ${color.name}`}>
          {msg.from || "unknown"}
        </span>
        {msg.timestamp ? (
          <span className="text-xs text-slate-400">{formatTime(msg.timestamp)}</span>
        ) : null}
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-300">
        {msg.content}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export const GroupChatPage: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const fluxDir = project?.fluxDir ?? "";

  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const messagesPath = selectedGroupId
    ? `${fluxDir}/shared/groups/${selectedGroupId}/messages.jsonl`
    : null;

  // Refresh messages for the currently selected group.
  const refreshMessages = useCallback(async () => {
    if (!fluxDir || !selectedGroupId) {
      setMessages([]);
      return;
    }
    try {
      const msgs = await getGroupMessages(fluxDir, selectedGroupId);
      setMessages(msgs);
    } catch {
      setMessages([]);
    }
  }, [fluxDir, selectedGroupId]);

  // Live polling of the group's messages file.
  const { isLive, start, stop } = useLiveUpdate(messagesPath, {
    onNewData: () => {
      refreshMessages();
    },
  });

  // Load groups on mount and whenever fluxDir changes.
  useEffect(() => {
    if (!fluxDir) {
      setGroups([]);
      return;
    }
    let cancelled = false;
    listGroups(fluxDir)
      .then((gs) => {
        if (!cancelled) setGroups(gs);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fluxDir]);

  // Load messages + start live polling when selection changes.
  useEffect(() => {
    if (!fluxDir || !selectedGroupId) {
      setMessages([]);
      stop();
      return;
    }
    let cancelled = false;
    setLoading(true);
    getGroupMessages(fluxDir, selectedGroupId)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [fluxDir, selectedGroupId, start, stop]);

  // Auto-scroll to bottom when messages change.
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;

  return (
    <div className="flex h-full flex-col gap-4">
      <AgentCommGraph />
      <div className="flex min-h-0 flex-1">
      {/* Left panel — group list */}
      <div className="flex w-64 flex-col border-r border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-lg font-bold text-slate-800 dark:text-slate-100">
            Groups
          </span>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {groups.length}
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          {groups.length === 0 ? (
            <EmptyState
              icon="MessageCircle"
              message="No groups yet. Dispatch agents to create groups."
            />
          ) : (
            groups.map((g) => (
              <GroupListItem
                key={g.id}
                group={g}
                active={selectedGroupId === g.id}
                onClick={() => setSelectedGroupId(g.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Right panel — chat area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {selectedGroup ? (
          <>
            {/* Header */}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 dark:border-slate-700 px-4 py-2">
              <span className="text-base font-semibold text-slate-800 dark:text-slate-100">
                {selectedGroup.name}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {selectedGroup.members.map((m) => (
                  <Badge key={m} color="slate">
                    {m}
                  </Badge>
                ))}
              </div>
              {isLive ? (
                <div className="ml-auto flex items-center gap-1">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
                  <span className="text-xs text-green-600 dark:text-green-400">
                    Live
                  </span>
                </div>
              ) : null}
            </div>

            {/* Message list */}
            <div className="flex-1 overflow-auto p-4">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-sm text-slate-400 dark:text-slate-500">
                  <Icon
                    name="RefreshCw"
                    size={20}
                    className="mr-2 animate-spin"
                  />
                  Loading messages...
                </div>
              ) : messages.length === 0 ? (
                <EmptyState
                  icon="MessageSquare"
                  message="No messages in this group yet"
                />
              ) : (
                <div className="flex flex-col gap-2">
                  {messages.map((m) => (
                    <MessageItem key={m.id || `${m.from}-${m.timestamp}`} msg={m} />
                  ))}
                  <div ref={bottomRef} />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <Card className="w-full max-w-md text-center">
              <EmptyState
                icon="MessageCircle"
                message="Select a group to view the conversation"
              />
            </Card>
          </div>
        )}
      </div>
      </div>
      <DirectMessagePanel />
    </div>
  );
};

export default GroupChatPage;
