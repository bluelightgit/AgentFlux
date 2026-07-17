/**
 * Operator-oriented communication inspector.
 *
 * A free-form node canvas becomes unreadable as the roster grows. This view
 * renders observed conversations as ranked, non-crossing lanes. Membership is
 * strictly a filter dimension and never creates a conversation.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Card, EmptyState, Icon, StatusDot } from "./ui";
import { formatNum } from "../lib/format";
import {
  getDirectMessages,
  getGroupMessages,
  listAgents,
  listGroups,
  type AgentGroup,
  type AgentInfo,
  type DirectMessage,
  type GroupMessage,
} from "../lib/group-reader";
import { useDashboardStore } from "../store/dashboard-store";

const DEFAULT_EDGE_LIMIT = 12;
const EDGE_PAGE_SIZE = 50;

export interface DirectConversationEdge {
  from: string;
  to: string;
  count: number;
}

export interface GroupSummary {
  group: AgentGroup;
  messageCount: number;
  system: boolean;
}

export type GraphFocus =
  | { type: "agent"; name: string }
  | { type: "group"; id: string; members: string[] }
  | null;

/** Aggregate repeated messages while preserving the observed direction. */
export function aggregateDirectConversations(messages: DirectMessage[]): DirectConversationEdge[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (!message.from || !message.to || message.from === message.to) continue;
    const key = `${message.from}\u0001${message.to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [from, to] = key.split("\u0001");
    return { from, to, count };
  }).sort((a, b) => b.count - a.count || `${a.from}\u0001${a.to}`.localeCompare(`${b.from}\u0001${b.to}`));
}

export function summarizeGroups(groups: AgentGroup[], messageCounts: ReadonlyMap<string, number>): GroupSummary[] {
  return groups.map((group) => ({
    group,
    messageCount: messageCounts.get(group.id) ?? 0,
    system: group.type === "all",
  }));
}

export function isEdgeRelevant(edge: DirectConversationEdge, focus: GraphFocus): boolean {
  if (!focus) return true;
  if (focus.type === "agent") return edge.from === focus.name || edge.to === focus.name;
  const members = new Set(focus.members);
  return members.has(edge.from) && members.has(edge.to);
}

export function isNodeRelevant(agentName: string, focus: GraphFocus, edges: DirectConversationEdge[]): boolean {
  if (!focus) return true;
  if (focus.type === "group") return focus.members.includes(agentName);
  if (agentName === focus.name) return true;
  return edges.some((edge) =>
    (edge.from === focus.name && edge.to === agentName) ||
    (edge.to === focus.name && edge.from === agentName));
}

/** Focus first, then rank by observed traffic and apply the operator limit. */
export function selectConversationEdges(
  edges: DirectConversationEdge[],
  focus: GraphFocus,
  limit = DEFAULT_EDGE_LIMIT,
): DirectConversationEdge[] {
  const relevant = focus ? edges.filter((edge) => isEdgeRelevant(edge, focus)) : edges;
  const ranked = [...relevant].sort((a, b) => b.count - a.count || `${a.from}-${a.to}`.localeCompare(`${b.from}-${b.to}`));
  return ranked.slice(0, limit);
}

export function edgesInScope(edges: DirectConversationEdge[], focus: GraphFocus): DirectConversationEdge[] {
  return focus ? edges.filter((edge) => isEdgeRelevant(edge, focus)) : edges;
}

function statusKind(status?: AgentInfo["status"]): "running" | "done" | "failed" | "idle" | "pending" {
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "running") return "running";
  if (status === "done") return "done";
  return "idle";
}

function AgentEndpoint({ name, agent, direction, onFocus }: { name: string; agent?: AgentInfo; direction: "sender" | "recipient"; onFocus: () => void }) {
  const status = agent?.status ?? "unknown";
  return (
    <button type="button" onClick={onFocus} className="af-agent-endpoint group" aria-label={`Focus ${direction} ${name}, status ${status}`}>
      <StatusDot status={statusKind(agent?.status)} />
      <span className="min-w-0">
        <strong className="block truncate font-mono text-xs font-semibold text-[var(--af-ink)]">{name}</strong>
        <span className="block truncate text-[10px] uppercase tracking-wide text-[var(--af-muted)]">{agent?.role || "unassigned"} · {status}</span>
      </span>
    </button>
  );
}

export function AgentCommGraph(): React.ReactElement {
  const fluxDir = useDashboardStore((state) => state.project?.fluxDir ?? "");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [directEdges, setDirectEdges] = useState<DirectConversationEdge[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [focus, setFocus] = useState<GraphFocus>(null);
  const [visibleLimit, setVisibleLimit] = useState(DEFAULT_EDGE_LIMIT);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!fluxDir) {
        if (!cancelled) { setAgents([]); setDirectEdges([]); setGroups([]); }
        return;
      }
      try {
        const [agentList, messages, groupList] = await Promise.all([
          listAgents(fluxDir), getDirectMessages(fluxDir), listGroups(fluxDir),
        ]);
        const counts = new Map<string, number>();
        await Promise.all(groupList.map(async (group) => {
          try {
            const messagesForGroup: GroupMessage[] = await getGroupMessages(fluxDir, group.id);
            counts.set(group.id, messagesForGroup.length);
          } catch { counts.set(group.id, 0); }
        }));
        if (!cancelled) {
          setAgents(agentList);
          setDirectEdges(aggregateDirectConversations(messages));
          setGroups(summarizeGroups(groupList, counts));
        }
      } catch {
        if (!cancelled) { setAgents([]); setDirectEdges([]); setGroups([]); }
      }
    };
    void load();
    const timer = setInterval(load, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [fluxDir]);

  const agentByName = useMemo(() => new Map(agents.map((agent) => [agent.name, agent])), [agents]);
  const scopedEdges = useMemo(() => edgesInScope(directEdges, focus), [directEdges, focus]);
  const visibleEdges = useMemo(() => selectConversationEdges(directEdges, focus, visibleLimit), [directEdges, focus, visibleLimit]);
  const activeNames = useMemo(() => new Set(scopedEdges.flatMap((edge) => [edge.from, edge.to])), [scopedEdges]);
  const scopedAgentNames = useMemo(() => {
    if (!focus) return new Set(agents.map((agent) => agent.name));
    if (focus.type === "group") return new Set(focus.members);
    return new Set([focus.name, ...scopedEdges.flatMap((edge) => [edge.from, edge.to])]);
  }, [agents, focus, scopedEdges]);
  const isolatedAgents = agents.filter((agent) => scopedAgentNames.has(agent.name) && !activeNames.has(agent.name));
  const maxCount = Math.max(1, ...visibleEdges.map((edge) => edge.count));
  const userGroups = groups.filter((summary) => !summary.system);
  const systemGroup = groups.find((summary) => summary.system);
  const totalMessages = directEdges.reduce((sum, edge) => sum + edge.count, 0);

  const focusAgent = (name: string) => setFocus((current) =>
    current?.type === "agent" && current.name === name ? null : { type: "agent", name });

  useEffect(() => { setVisibleLimit(DEFAULT_EDGE_LIMIT); }, [focus]);

  return (
    <Card className="af-comm-inspector p-0">
      <header className="af-panel-header">
        <div className="flex min-w-0 items-center gap-3">
          <span className="af-icon-plate"><Icon name="Network" size={16} /></span>
          <div className="min-w-0">
            <p className="af-kicker">Observed traffic</p>
            <h3 className="af-panel-title">Communication lanes</h3>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4 font-mono text-[10px] uppercase tracking-wider text-[var(--af-muted)]">
          <span><b className="text-[var(--af-ink)]">{agents.length}</b> agents</span>
          <span><b className="text-[var(--af-ink)]">{directEdges.length}</b> links</span>
          <span><b className="text-[var(--af-ink)]">{formatNum(totalMessages)}</b> msgs</span>
        </div>
      </header>

      <div className="border-b border-[var(--af-line)] px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="af-field-label mr-1">Scope</span>
          {userGroups.map(({ group, messageCount }) => {
            const selected = focus?.type === "group" && focus.id === group.id;
            return (
              <button key={group.id} type="button" aria-pressed={selected}
                className={`af-filter-chip ${selected ? "is-active" : ""}`}
                onClick={() => setFocus(selected ? null : { type: "group", id: group.id, members: group.members })}>
                {group.name}<span>{group.members.length} · {messageCount}</span>
              </button>
            );
          })}
          {focus && <button type="button" className="af-link-button ml-auto" onClick={() => setFocus(null)}>Clear scope</button>}
          {!focus && systemGroup && <span className="ml-auto font-mono text-[10px] text-[var(--af-muted)]">Directory: {systemGroup.group.members.length} registered</span>}
        </div>
      </div>

      {agents.length === 0 ? (
        <EmptyState icon="Network" message="No agents registered. Dispatch agents to observe traffic." />
      ) : (
        <div className="grid min-h-[320px] lg:grid-cols-[minmax(0,1fr)_220px]">
          <section className="min-w-0 border-b border-[var(--af-line)] lg:border-b-0 lg:border-r" aria-label="Observed direct conversations">
            <div role="row" className="grid grid-cols-[minmax(110px,1fr)_minmax(120px,2fr)_minmax(110px,1fr)] border-b border-[var(--af-line)] bg-[var(--af-panel-subtle)] px-3 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--af-muted)]">
              <span role="columnheader">Sender</span><span role="columnheader" className="text-center">Direction / messages</span><span role="columnheader" className="text-right">Recipient</span>
            </div>
            {visibleEdges.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center px-4 text-center text-xs text-[var(--af-muted)]">No observed direct conversations in this scope.</div>
            ) : (
              <div data-testid="communication-lanes" className="max-h-[420px] divide-y divide-[var(--af-line-soft)] overflow-y-auto">
                {visibleEdges.map((edge) => (
                  <div key={`${edge.from}-${edge.to}`} data-testid="direct-conversation-edge" className="af-traffic-lane" role="group" aria-label={`Sender ${edge.from} to recipient ${edge.to}, ${edge.count} direct messages`}>
                    <AgentEndpoint name={edge.from} agent={agentByName.get(edge.from)} direction="sender" onFocus={() => focusAgent(edge.from)} />
                    <div className="min-w-0 px-3" title={`Sender ${edge.from} → recipient ${edge.to}: ${edge.count} direct messages`}>
                      <div className="flex items-center gap-2">
                        <div className="h-px flex-1 bg-[var(--af-line-strong)]"><span className="block h-px bg-[var(--af-operate)]" style={{ width: `${Math.max(8, edge.count / maxCount * 100)}%` }} /></div>
                        <span aria-hidden="true" className="font-mono text-sm text-[var(--af-operate)]">→</span>
                        <span className="w-10 text-right font-mono text-[10px] tabular-nums text-[var(--af-operate)]">{formatNum(edge.count)} msg</span>
                      </div>
                    </div>
                    <div className="flex justify-end"><AgentEndpoint name={edge.to} agent={agentByName.get(edge.to)} direction="recipient" onFocus={() => focusAgent(edge.to)} /></div>
                  </div>
                ))}
              </div>
            )}
            {visibleLimit < scopedEdges.length && (
              <button type="button" className="af-expand-row" onClick={() => setVisibleLimit((current) => Math.min(scopedEdges.length, current + EDGE_PAGE_SIZE))}>
                Show next {Math.min(EDGE_PAGE_SIZE, scopedEdges.length - visibleLimit)} of {scopedEdges.length - visibleLimit} remaining links
              </button>
            )}
            {visibleLimit > DEFAULT_EDGE_LIMIT && <button type="button" className="af-expand-row" onClick={() => setVisibleLimit(DEFAULT_EDGE_LIMIT)}>Collapse to top {DEFAULT_EDGE_LIMIT}</button>}
          </section>

          <aside className="bg-[var(--af-panel-subtle)] p-3" aria-label="Agent directory summary">
            <p className="af-field-label">No traffic in scope</p>
            <p className="mt-1 text-[11px] leading-4 text-[var(--af-muted)]">Agents in the current scope without an observed scoped direct lane.</p>
            <div className="mt-3 max-h-64 space-y-1 overflow-auto">
              {isolatedAgents.length === 0 ? <span className="text-xs text-[var(--af-muted)]">None</span> : isolatedAgents.map((agent) => (
                <button key={agent.name} type="button" onClick={() => focusAgent(agent.name)} className="af-directory-row">
                  <StatusDot status={statusKind(agent.status)} /><span className="truncate font-mono text-[11px]">{agent.name}</span><span className="ml-auto text-[9px] uppercase text-[var(--af-muted)]">{agent.role || "—"} · {agent.status}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 border-t border-[var(--af-line)] pt-3 font-mono text-[9px] uppercase leading-4 tracking-wider text-[var(--af-muted)]">
              Membership is a scope filter.<br />Only observed messages create lanes.
            </div>
          </aside>
        </div>
      )}
    </Card>
  );
}

export default AgentCommGraph;
