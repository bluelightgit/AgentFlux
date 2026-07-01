/**
 * MessageComposer — send messages to agents or groups from the UI.
 *
 * Renders a Card with a recipient selector (agents + groups), a message
 * textarea, and a send button. On send:
 *   - Agent recipient: writes a DM file to
 *     `<fluxDir>/shared/messages/{timestamp}_{rand}__system→{agent}.json`
 *     containing `{id, from:'user', to, type:'user_message', content,
 *     timestamp, read:false}`.
 *   - Group recipient: appends a JSON line to
 *     `<fluxDir>/shared/groups/{groupId}/messages.jsonl` with
 *     `{id, groupId, from:'user', content, timestamp}`.
 *
 * Writes go through the Electron preload bridge (`write-file` IPC),
 * matching the pattern used elsewhere in the app. Shows a green "Sent!"
 * Badge for 3s on success, or a red error Badge on failure.
 */
import React, { useEffect, useState } from "react";
import { Card, Icon, Badge } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";
import { listAgents, listGroups, type AgentGroup } from "../lib/group-reader";
import { readFileContent } from "../lib/file-access";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Recipient {
  name: string;
  type: "agent" | "group";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short unique id for a message. */
function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Write a file via the Electron preload bridge. Mirrors the `write-file`
 * IPC handler used elsewhere (creates parent dirs recursively, overwrites).
 * Falls back to a no-op when the bridge is unavailable (pure browser).
 */
async function writeFileContent(
  filePath: string,
  content: string,
): Promise<void> {
  if (typeof window !== "undefined" && window.api?.ipcRenderer) {
    await window.api.ipcRenderer.invoke("write-file", filePath, content);
    return;
  }
  if (typeof window !== "undefined" && (window.api as any)?.writeFile) {
    await (window.api as any).writeFile(filePath, content);
    return;
  }
}

/** Append a single JSON line to a .jsonl file (read-modify-write). */
async function appendJsonLine(
  filePath: string,
  lineObject: Record<string, unknown>,
): Promise<void> {
  const existing = await readFileContent(filePath);
  const next = existing
    ? `${existing.replace(/\s+$/, "")}\n${JSON.stringify(lineObject)}\n`
    : `${JSON.stringify(lineObject)}\n`;
  await writeFileContent(filePath, next);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MessageComposer(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [selectedRecipient, setSelectedRecipient] = useState<string>("");
  const [messageText, setMessageText] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);
  const [sent, setSent] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Load recipients on mount / when fluxDir changes.
  useEffect(() => {
    if (!fluxDir) {
      setRecipients([]);
      setGroups([]);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const [agentList, groupList] = await Promise.all([
          listAgents(fluxDir),
          listGroups(fluxDir),
        ]);
        if (cancelled) return;
        setGroups(groupList);
        const next: Recipient[] = [
          ...agentList.map((a) => ({ name: a.name, type: "agent" as const })),
          ...groupList.map((g) => ({ name: g.name, type: "group" as const })),
        ];
        setRecipients(next);
      } catch {
        if (!cancelled) {
          setRecipients([]);
          setGroups([]);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [fluxDir]);

  const agentRecipients = recipients.filter((r) => r.type === "agent");
  const groupRecipients = recipients.filter((r) => r.type === "group");

  const canSend =
    !sending && messageText.trim().length > 0 && selectedRecipient.length > 0;

  /** Resolve the currently selected recipient. */
  function findRecipient(name: string): Recipient | undefined {
    return recipients.find((r) => r.name === name);
  }

  /** Handle send: write the appropriate message file based on recipient type. */
  async function handleSend(): Promise<void> {
    if (!fluxDir || !canSend) return;
    const recipient = findRecipient(selectedRecipient);
    if (!recipient) return;

    setSending(true);
    setError(null);
    setSent(false);

    try {
      const id = makeId();
      const timestamp = new Date().toISOString();

      if (recipient.type === "agent") {
        const safeRand = Math.random().toString(36).slice(2);
        const fileName = `${Date.now()}_${safeRand}__system\u2192${recipient.name}.json`;
        const filePath = `${fluxDir}/shared/messages/${fileName}`;
        const payload = {
          id,
          from: "user",
          to: recipient.name,
          type: "user_message",
          content: messageText,
          timestamp,
          read: false,
        };
        await writeFileContent(filePath, JSON.stringify(payload, null, 2));
      } else {
        // Group recipient: resolve groupId by name.
        const group =
          groups.find((g) => g.name === recipient.name) ??
          groups.find((g) => g.id === recipient.name);
        const groupId = group?.id ?? recipient.name;
        const filePath = `${fluxDir}/shared/groups/${groupId}/messages.jsonl`;
        const payload = {
          id,
          groupId,
          from: "user",
          content: messageText,
          timestamp,
        };
        await appendJsonLine(filePath, payload);
      }

      setMessageText("");
      setSent(true);
      setTimeout(() => setSent(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-3 mb-3">
        <Icon name="Send" size={18} className="text-slate-500 dark:text-slate-400" />
        <span className="text-base font-semibold text-slate-800 dark:text-slate-100">
          Send Message
        </span>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-3">
        {/* Recipient selector */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Recipient
          </label>
          <select
            value={selectedRecipient}
            onChange={(e) => setSelectedRecipient(e.target.value)}
            className="w-full rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select a recipient...</option>
            {agentRecipients.length > 0 ? (
              <optgroup label="Agents">
                {agentRecipients.map((r) => (
                  <option key={`agent-${r.name}`} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {groupRecipients.length > 0 ? (
              <optgroup label="Groups">
                {groupRecipients.map((r) => (
                  <option key={`group-${r.name}`} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>

        {/* Message textarea */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Message
          </label>
          <textarea
            rows={3}
            placeholder="Type a message to send..."
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            className="w-full rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Actions / status */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? "Sending..." : "Send"}
          </button>
          {sent ? <Badge color="green">Sent!</Badge> : null}
          {error ? <Badge color="red">{error}</Badge> : null}
        </div>
      </div>
    </Card>
  );
}

export default MessageComposer;
