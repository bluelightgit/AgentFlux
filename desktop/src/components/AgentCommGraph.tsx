/**
 * AgentCommGraph — SVG visualization of agent communication topology.
 *
 * Renders every registered agent as a node positioned in a circular layout
 * around the canvas center. Direct (1-on-1) messages are drawn as edges
 * between the two participating agents, with stroke width scaling by
 * message count. Group chats are drawn as spokes from each member to the
 * group's centroid (lighter opacity).
 *
 * Data is loaded on mount and polled every 5 seconds.
 */
import React, { useEffect, useState } from "react";
import { Card, Icon, EmptyState } from "./ui";
import { formatNum } from "../lib/format";
import {
  listAgents,
  getDirectMessages,
  listGroups,
  getGroupMessages,
  type AgentInfo,
  type DirectMessage,
  type AgentGroup,
  type GroupMessage,
} from "../lib/group-reader";
import { useDashboardStore } from "../store/dashboard-store";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const CENTER_X = 400;
const CENTER_Y = 200;
const RADIUS = 150;
const NODE_R = 20;

// ---------------------------------------------------------------------------
// Color maps
// ---------------------------------------------------------------------------

/** Node fill color keyed by agent role (lowercased). */
const ROLE_FILL: Record<string, string> = {
  planner: "#3b82f6",
  implementer: "#22c55e",
  reviewer: "#f59e0b",
  tester: "#a855f7",
  designer: "#ec4899",
};

const ROLE_FILL_UNKNOWN = "#64748b";

/** Node stroke color keyed by agent status. */
const STATUS_STROKE: Record<string, string> = {
  running: "#22c55e",
  idle: "#94a3b8",
  failed: "#ef4444",
};

const STATUS_STROKE_DEFAULT = "#94a3b8";

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

interface DmEdge {
  from: string;
  to: string;
  count: number;
}

interface GroupEdge {
  group: AgentGroup;
  members: string[];
  count: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

/** Compute a node's position for the circular layout. */
function nodePosition(index: number, total: number): Point {
  if (total <= 1) return { x: CENTER_X, y: CENTER_Y };
  const angle = (2 * Math.PI * index) / total;
  return {
    x: CENTER_X + RADIUS * Math.cos(angle),
    y: CENTER_Y + RADIUS * Math.sin(angle),
  };
}

/** Centroid of a set of points (group center). */
function centroid(points: Point[]): Point {
  if (points.length === 0) return { x: CENTER_X, y: CENTER_Y };
  const sum = points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Aggregate raw direct messages into per-conversation edge counts. */
function aggregateDmEdges(messages: DirectMessage[]): DmEdge[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (!m.from || !m.to) continue;
    // Canonicalize the pair so A→B and B→A collapse into one edge.
    const key = [m.from, m.to].sort().join("\u0001");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const edges: DmEdge[] = [];
  for (const [key, count] of counts) {
    const [from, to] = key.split("\u0001");
    edges.push({ from, to, count });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentCommGraph(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [dmEdges, setDmEdges] = useState<DmEdge[]>([]);
  const [groupEdges, setGroupEdges] = useState<GroupEdge[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!fluxDir) {
        if (!cancelled) {
          setAgents([]);
          setDmEdges([]);
          setGroupEdges([]);
        }
        return;
      }
      try {
        const [agentList, dms, groups] = await Promise.all([
          listAgents(fluxDir),
          getDirectMessages(fluxDir),
          listGroups(fluxDir),
        ]);
        if (cancelled) return;

        // Fetch message counts for each group.
        const gEdges: GroupEdge[] = [];
        await Promise.all(
          groups.map(async (g) => {
            try {
              const msgs: GroupMessage[] = await getGroupMessages(
                fluxDir,
                g.id,
              );
              if (!cancelled) {
                gEdges.push({
                  group: g,
                  members: g.members,
                  count: msgs.length,
                });
              }
            } catch {
              if (!cancelled) {
                gEdges.push({ group: g, members: g.members, count: 0 });
              }
            }
          }),
        );
        if (cancelled) return;

        setAgents(agentList);
        setDmEdges(aggregateDmEdges(dms));
        setGroupEdges(gEdges);
      } catch {
        if (!cancelled) {
          setAgents([]);
          setDmEdges([]);
          setGroupEdges([]);
        }
      }
    };

    load();

    // Poll every 5 seconds for topology updates.
    const timer = setInterval(load, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fluxDir]);

  // Pre-compute node positions keyed by agent name.
  const positions = new Map<string, Point>();
  agents.forEach((a, i) => {
    positions.set(a.name, nodePosition(i, agents.length));
  });

  const totalDmCount = dmEdges.reduce((sum, e) => sum + e.count, 0);

  return (
    <Card className="text-slate-800 dark:text-slate-200">
      <div className="mb-4 flex items-center gap-2">
        <Icon name="Share2" size={20} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Communication Graph
        </h3>
        <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
          {agents.length} agent{agents.length === 1 ? "" : "s"}
          {" \u00b7 "}
          {formatNum(totalDmCount)} direct message{totalDmCount === 1 ? "" : "s"}
        </span>
      </div>

      {agents.length === 0 ? (
        <EmptyState
          icon="Share2"
          message="No agents registered. Dispatch agents to populate the graph."
        />
      ) : (
        <svg
          width="100%"
          height={400}
          viewBox="0 0 800 400"
          className="fill-slate-700 dark:fill-slate-300"
        >
          {/* Group edges — member → group centroid (lighter) */}
          {groupEdges.flatMap((ge) => {
            const memberPoints = ge.members
              .map((m) => positions.get(m))
              .filter((p): p is Point => !!p);
            if (memberPoints.length === 0) return [];
            const center = centroid(memberPoints);
            return memberPoints.map((p, i) => (
              <line
                key={`g-${ge.group.id}-${i}`}
                x1={p.x}
                y1={p.y}
                x2={center.x}
                y2={center.y}
                stroke="#64748b"
                strokeWidth={1}
                strokeOpacity={0.3}
              />
            ));
          })}

          {/* Direct-message edges */}
          {dmEdges.map((e, i) => {
            const from = positions.get(e.from);
            const to = positions.get(e.to);
            if (!from || !to) return null;
            return (
              <line
                key={`dm-${i}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="#3b82f6"
                strokeWidth={Math.min(1 + e.count, 6)}
                strokeOpacity={0.6}
              />
            );
          })}

          {/* Agent nodes */}
          {agents.map((a, i) => {
            const pos = positions.get(a.name)!;
            const fill =
              ROLE_FILL[a.role.toLowerCase()] ?? ROLE_FILL_UNKNOWN;
            const stroke =
              STATUS_STROKE[a.status] ?? STATUS_STROKE_DEFAULT;
            return (
              <g key={a.name}>
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={NODE_R}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={2}
                />
                <text
                  x={pos.x}
                  y={pos.y + NODE_R + 14}
                  textAnchor="middle"
                  className="text-xs fill-slate-700 dark:fill-slate-300"
                  fontSize={11}
                >
                  {a.name}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </Card>
  );
}

export default AgentCommGraph;
