/**
 * Agent Tool Matrix — grid showing which agents have which tools/skills.
 *
 * Data source: reads `.agentflux/agents/*.md` files, parses YAML frontmatter
 * to extract the `tools` field (comma-separated or inline array), and builds
 * a matrix of agents (rows) x tools (columns).
 */
import React, { useEffect, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { readFileContent } from "../lib/file-access";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentRow {
  name: string;
  model: string;
  thinking: string;
  tools: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter parser (lightweight YAML subset)
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, any> {
  const fm: Record<string, any> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return fm;

  const block = match[1];
  const lines = block.split(/\r?\n/);
  let currentKey: string | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // List item under current key (  - value)
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentKey) {
      const existing = fm[currentKey];
      const arr = Array.isArray(existing) ? existing : [];
      arr.push(stripQuotes(listMatch[1].trim()));
      fm[currentKey] = arr;
      continue;
    }

    // key: value
    const kvMatch = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const raw = kvMatch[2].trim();
      currentKey = key;
      if (raw === "") {
        fm[key] = [];
      } else if (raw.startsWith("[") && raw.endsWith("]")) {
        // inline array: [a, b, c]
        fm[key] = raw
          .slice(1, -1)
          .split(",")
          .map((s) => stripQuotes(s.trim()))
          .filter((s) => s.length > 0);
      } else {
        fm[key] = stripQuotes(raw);
      }
    }
  }

  return fm;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Directory listing via Electron preload bridge
// ---------------------------------------------------------------------------

async function listAgentFiles(dir: string): Promise<string[]> {
  if (typeof window !== "undefined" && window.api?.listDirectory) {
    try {
      const entries = await window.api.listDirectory(dir);
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }
  // Fallback: readDirectory (returns entries with name field)
  if (typeof window !== "undefined" && window.api?.readDirectory) {
    try {
      const entries = await window.api.readDirectory(dir);
      if (Array.isArray(entries)) {
        return entries.map((e: any) =>
          typeof e === "string" ? e : e?.name ?? "",
        );
      }
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentToolMatrix(): React.ReactElement {
  const project = useDashboardStore((s) => s.project);

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [allTools, setAllTools] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!project) {
        setAgents([]);
        setAllTools([]);
        return;
      }
      setLoading(true);
      try {
        const dir = `${project.fluxDir}/agents`;
        const entries = await listAgentFiles(dir);
        const mdFiles = entries
          .map((e) => (typeof e === "string" ? e : e?.name ?? ""))
          .filter((name) => name.endsWith(".md"));

        const rows: AgentRow[] = [];
        for (const name of mdFiles) {
          const filePath = `${dir}/${name}`;
          const content = await readFileContent(filePath);
          const fm = parseFrontmatter(content);
          const agentName = String(fm.name ?? name.replace(/\.md$/, ""));
          const model = String(fm.model ?? "default");
          const thinking = String(fm.thinking ?? "off");
          let tools: string[] = [];
          if (Array.isArray(fm.tools)) {
            tools = fm.tools.map(String);
          } else if (typeof fm.tools === "string" && fm.tools.length > 0) {
            tools = fm.tools
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          }
          rows.push({ name: agentName, model, thinking, tools });
        }

        // Sort agents by name for stable display
        rows.sort((a, b) => a.name.localeCompare(b.name));

        // Collect unique tools, sorted for stable column order
        const toolSet = new Set<string>();
        for (const r of rows) {
          for (const t of r.tools) toolSet.add(t);
        }
        const tools = Array.from(toolSet).sort((a, b) =>
          a.localeCompare(b),
        );

        if (!cancelled) {
          setAgents(rows);
          setAllTools(tools);
        }
      } catch {
        if (!cancelled) {
          setAgents([]);
          setAllTools([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Most-equipped agent = agent with the most tools (ties broken by name)
  const mostEquipped =
    agents.length > 0
      ? agents.reduce((best, cur) =>
          cur.tools.length > best.tools.length
            ? cur
            : best,
        )
      : null;

  const hasAgents = agents.length > 0;

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Grid3x3" size={18} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Agent Tool Matrix
        </h3>
        {loading ? (
          <Icon name="Loader2" size={14} className="ml-auto text-slate-400 dark:text-slate-500 animate-spin" />
        ) : null}
      </div>

      {!hasAgents && !loading ? (
        <EmptyState
          icon="Grid3x3"
          message="No agent definitions found"
        />
      ) : null}

      {hasAgents ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="bg-slate-50 dark:bg-slate-900/50 text-left text-xs font-medium text-slate-500 dark:text-slate-400 px-3 py-2 w-32 sticky left-0 z-10">
                  Agent
                </th>
                {allTools.map((tool) => (
                  <th
                    key={tool}
                    className="bg-slate-50 dark:bg-slate-900/50 text-xs font-medium text-slate-400 dark:text-slate-500 px-2 py-2 text-center"
                    title={tool}
                  >
                    <div className="max-w-[5rem] truncate mx-auto" title={tool}>
                      {tool}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.name} className="border-t border-slate-100 dark:border-slate-700">
                  <td className="px-3 py-2 w-32 sticky left-0 z-10 bg-white dark:bg-slate-800">
                    <div className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate" title={agent.name}>
                      {agent.name}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                      <Badge color="slate">{agent.model}</Badge>
                      <span className="text-xs text-slate-400 dark:text-slate-500">
                        {agent.thinking}
                      </span>
                    </div>
                  </td>
                  {allTools.map((tool) => {
                    const has = agent.tools.includes(tool);
                    return (
                      <td
                        key={tool}
                        className="px-2 py-2 text-center border-t border-slate-100 dark:border-slate-700"
                      >
                        {has ? (
                          <Icon
                            name="Check"
                            size={16}
                            className="text-green-600 dark:text-green-400 inline-block"
                          />
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">&mdash;</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Summary row */}
      {hasAgents ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-500 dark:text-slate-400">
          <span>
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              {agents.length}
            </span>{" "}
            agents
          </span>
          <span>
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              {allTools.length}
            </span>{" "}
            tools
          </span>
          {mostEquipped ? (
            <span>
              most-equipped:{" "}
              <span className="font-semibold text-slate-700 dark:text-slate-200">
                {mostEquipped.name}
              </span>{" "}
              ({mostEquipped.tools.length})
            </span>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
