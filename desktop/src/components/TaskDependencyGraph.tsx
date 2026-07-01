/**
 * TaskDependencyGraph — visual graph of task dependencies from DAG state.
 *
 * Reads `.agentflux/runtime/dag-state.json` (via the Electron preload bridge
 * `readFileContent`) and renders a div-based dependency graph: nodes with no
 * dependencies appear at the top level, nodes with dependencies are rendered
 * below their parents, indented by depth level. Connector lines are drawn
 * with bordered divs between parent and child levels.
 *
 * Below the graph: a progress bar (completed / total) and the DAG description.
 * Polls every 5 seconds for live DAG execution updates.
 */
import React, { useEffect, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { readFileContent } from "../lib/file-access";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatTs } from "../lib/format";
import type { DAGState } from "../lib/agent-status-enhanced";

/** Extended DAG node including the dependency list (not on the base type). */
interface DAGNode {
  id: string;
  title?: string;
  role?: string;
  status?: string;
  dependsOn?: string[];
}

/** A node augmented with its computed depth level (0 = top). */
interface LeveledNode {
  node: DAGNode;
  level: number;
}

/** Status kinds we render distinctly. */
type NodeStatus = "completed" | "failed" | "running" | "pending";

/** Resolve a node's display status from the DAG state + node fields. */
function resolveStatus(node: DAGNode, state: DAGState): NodeStatus {
  if (state.completed?.includes(node.id)) return "completed";
  if (state.failed?.includes(node.id)) return "failed";
  const s = (node.status ?? "").toLowerCase();
  if (s === "running" || s === "in_progress" || s === "in-progress") return "running";
  if (s === "completed" || s === "done" || s === "success") return "completed";
  if (s === "failed" || s === "error") return "failed";
  return "pending";
}

/** Border / background classes for a node given its status. */
function nodeStatusClasses(status: NodeStatus): string {
  switch (status) {
    case "completed":
      return "border-green-500 bg-green-50 dark:bg-green-900/20";
    case "failed":
      return "border-red-500 bg-red-50 dark:bg-red-900/20";
    case "running":
      return "border-blue-500 bg-blue-50 dark:bg-blue-900/20 animate-pulse";
    case "pending":
    default:
      return "border-slate-300 bg-slate-50 dark:bg-slate-700/30";
  }
}

/** Badge color for a node role given its status. */
function statusBadgeColor(status: NodeStatus): "green" | "red" | "blue" | "slate" {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "running":
      return "blue";
    default:
      return "slate";
  }
}

/** Icon name (in the ICONS map) for a node status. */
function statusIconName(status: NodeStatus): string {
  switch (status) {
    case "completed":
      return "CheckCircle2";
    case "failed":
      return "XCircle";
    case "running":
      return "Loader";
    default:
      return "Circle";
  }
}

/**
 * Compute a depth level for every node using a longest-path layering:
 * nodes with no dependencies get level 0; every other node sits one level
 * below the deepest of its parents. Nodes participating in a cycle fall back
 * to level 0 to guarantee termination.
 */
function computeLevels(nodes: DAGNode[]): Map<string, number> {
  const byId = new Map<string, DAGNode>();
  for (const n of nodes) byId.set(n.id, n);

  const levels = new Map<string, number>();
  const visiting = new Set<string>();

  function levelOf(id: string): number {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    // Cycle guard: treat in-progress nodes as level 0 to terminate.
    if (visiting.has(id)) return 0;
    visiting.add(id);

    const node = byId.get(id);
    const deps = node?.dependsOn ?? [];
    let depth = 0;
    for (const dep of deps) {
      if (byId.has(dep)) {
        depth = Math.max(depth, levelOf(dep) + 1);
      }
    }

    visiting.delete(id);
    levels.set(id, depth);
    return depth;
  }

  for (const n of nodes) levelOf(n.id);
  return levels;
}

/** Group leveled nodes by their depth level, preserving input order. */
function groupByLevel(nodes: DAGNode[], levels: Map<string, number>): LeveledNode[][] {
  const maxLevel = nodes.reduce((m, n) => Math.max(m, levels.get(n.id) ?? 0), 0);
  const grouped: LeveledNode[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const n of nodes) {
    const lvl = levels.get(n.id) ?? 0;
    grouped[lvl].push({ node: n, level: lvl });
  }
  return grouped.filter((g) => g.length > 0);
}

/** Render a single node box. */
function renderNode(ln: LeveledNode, state: DAGState): React.ReactElement {
  const { node } = ln;
  const status = resolveStatus(node, state);
  const title = node.title ?? node.id;
  const role = node.role ?? "task";

  return (
    <div
      key={node.id}
      className={`w-48 p-3 rounded border-2 ${nodeStatusClasses(status)}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-sm text-slate-800 dark:text-slate-100 break-words">
          {title}
        </span>
        <Icon
          name={statusIconName(status)}
          size={16}
          className={
            status === "completed"
              ? "text-green-600 dark:text-green-400"
              : status === "failed"
                ? "text-red-600 dark:text-red-400"
                : status === "running"
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-slate-400 dark:text-slate-500"
          }
        />
      </div>
      <div className="mt-2">
        <Badge color={statusBadgeColor(status)}>{role}</Badge>
      </div>
    </div>
  );
}

export function TaskDependencyGraph(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [dagState, setDagState] = useState<DAGState | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!fluxDir) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const content = await readFileContent(`${fluxDir}/runtime/dag-state.json`);
        if (cancelled) return;
        if (!content) {
          setDagState(null);
          return;
        }
        const data = JSON.parse(content) as DAGState & { timestamp?: number };
        setDagState({
          description: data.description ?? "",
          startTime: data.startTime ?? data.timestamp ?? 0,
          completed: data.completed ?? [],
          failed: data.failed ?? [],
          totalNodes:
            data.totalNodes ??
            (data.completed?.length ?? 0) + (data.failed?.length ?? 0),
          nodes: Array.isArray(data.nodes) ? data.nodes : undefined,
        });
      } catch {
        if (!cancelled) setDagState(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fluxDir]);

  const nodes: DAGNode[] = (dagState?.nodes ?? []) as DAGNode[];
  const hasNodes = nodes.length > 0;

  const levels = hasNodes ? groupByLevel(nodes, computeLevels(nodes)) : [];
  const completedCount = dagState?.completed?.length ?? 0;
  const failedCount = dagState?.failed?.length ?? 0;
  const total = dagState?.totalNodes ?? nodes.length ?? 0;
  const doneCount = completedCount + failedCount;
  const progress = total > 0 ? Math.min(1, doneCount / total) : 0;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="Network" size={18} className="text-slate-500 dark:text-slate-400" />
          <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            Task Dependency Graph
          </h3>
        </div>
        {loading ? (
          <Icon name="RefreshCw" size={14} className="text-slate-400 dark:text-slate-500 animate-spin" />
        ) : null}
      </div>

      {!dagState || !hasNodes ? (
        <EmptyState icon="Network" message="No DAG data yet" />
      ) : (
        <>
          <div className="mt-4 flex flex-col gap-0">
            {levels.map((group, levelIdx) => (
              <div key={levelIdx} className="flex flex-col">
                {levelIdx > 0 ? (
                  /* Connector lines between parent and child levels. */
                  <div className="flex gap-4 pl-[7.5rem] py-2">
                    {group.map((ln) => (
                      <div
                        key={`conn-${ln.node.id}`}
                        className="w-48 flex justify-center"
                      >
                        <div className="border-l-2 border-slate-300 dark:border-slate-600 h-4" />
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="flex gap-4 flex-wrap">
                  {group.map((ln) => renderNode(ln, dagState))}
                </div>
              </div>
            ))}
          </div>

          {/* Progress bar */}
          <div className="mt-5">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>
                {doneCount} / {total} nodes
              </span>
              <span>
                {completedCount} completed, {failedCount} failed
              </span>
            </div>
            <div className="mt-1 h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-green-500 transition-all"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>

          {/* Description + start time */}
          {(dagState.description || dagState.startTime) ? (
            <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              {dagState.description ? (
                <div className="break-words">{dagState.description}</div>
              ) : null}
              {dagState.startTime ? (
                <div className="mt-0.5">Started: {formatTs(dagState.startTime)}</div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
