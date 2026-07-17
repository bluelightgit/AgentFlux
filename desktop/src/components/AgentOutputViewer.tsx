/**
 * AgentOutputViewer — real-time view of the latest output from each agent
 * session. Reads all `.jsonl` files under `<fluxDir>/runtime/sessions/`,
 * parses the most recent assistant message from each, and renders a row per
 * agent sorted by activity time (most recent first).
 *
 * Auto-refreshes every 3 seconds. Falls back to an EmptyState when no
 * sessions are present.
 */
import React, { useEffect, useState, useCallback } from "react";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";
import {
  listSessions,
  readSessionMessages,
  type SessionMetadata,
} from "../lib/session-reader";
import { formatTs } from "../lib/format";

/** A single agent's latest output snapshot. */
interface AgentOutput {
  name: string;
  lastOutput: string;
  timestamp: string;
  turns: number;
}

/** Extract readable text from a message content array (type='text' blocks). */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

/** Resolve a session timestamp string into epoch ms for formatTs. */
function toEpochMs(ts: string): number {
  if (!ts) return 0;
  if (/^\d+$/.test(ts)) return Number(ts);
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

/** Total turn count for a session metadata entry. */
function entryCount(meta: SessionMetadata): number {
  return (meta.userMsgs || 0) + (meta.assistantMsgs || 0);
}

export function AgentOutputViewer(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [agents, setAgents] = useState<AgentOutput[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setAgents([]);
      setLoading(false);
      return;
    }
    try {
      const sessionsDir = `${fluxDir}/runtime/sessions`;
      const metas = await listSessions(sessionsDir);

      const results: AgentOutput[] = [];
      for (const meta of metas) {
        // Read messages and locate the last assistant message for a preview.
        let lastOutput = "";
        let timestamp = meta.timestamp;
        try {
          const messages = await readSessionMessages(
            `${sessionsDir}/${meta.fileName}`,
          );
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === "assistant") {
              const text = extractText(m.content);
              if (text) {
                lastOutput = text;
                if (m.timestamp) timestamp = m.timestamp;
                break;
              }
            }
          }
        } catch {
          // Per-file parse failures are non-fatal; keep metadata-only snapshot.
        }

        results.push({
          name: meta.agentName || meta.sessionId || meta.fileName,
          lastOutput,
          timestamp,
          turns: entryCount(meta),
        });
      }

      // Sort by timestamp descending (most recent first).
      results.sort((a, b) => toEpochMs(b.timestamp) - toEpochMs(a.timestamp));
      setAgents(results);
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  useEffect(() => {
    load();
    const id = setInterval(load, 3_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Terminal" size={18} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          Live Agent Output
        </h3>
      </div>

      {loading ? (
        <div className="flex h-24 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
          Loading agent sessions...
        </div>
      ) : agents.length === 0 ? (
        <EmptyState icon="Terminal" message="No agent sessions yet" />
      ) : (
        <div className="space-y-3">
          {agents.map((agent, idx) => {
            const preview =
              agent.lastOutput.length > 200
                ? agent.lastOutput.slice(-200)
                : agent.lastOutput;
            return (
              <div
                key={`${agent.name}-${idx}`}
                className="flex flex-col gap-1 border-t border-slate-100 dark:border-slate-700 pt-3 first:border-t-0 first:pt-0"
              >
                <div className="flex items-center gap-2">
                  <Badge color="blue">{agent.name}</Badge>
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {formatTs(toEpochMs(agent.timestamp))}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    · {agent.turns} turns
                  </span>
                </div>
                {preview ? (
                  <p className="text-sm text-slate-600 dark:text-slate-400 truncate">
                    {preview}
                  </p>
                ) : (
                  <p className="text-sm text-slate-400 dark:text-slate-500 truncate">
                    No assistant output yet
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

    </Card>
  );
}
