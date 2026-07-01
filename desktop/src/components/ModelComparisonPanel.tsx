/**
 * Model Comparison panel.
 * Reads `${fluxDir}/models.json` and renders all available models side by
 * side with provider, context window, per-million pricing and capability
 * scores (coding / reasoning / speed).
 */
import React, { useEffect, useState } from "react";
import { Card, Icon, Badge, DataTable, EmptyState } from "./ui";
import { formatTokens, formatCost } from "../lib/format";
import { readFileContent } from "../lib/file-access";
import { useDashboardStore } from "../store/dashboard-store";

// ─── Types ─────────────────────────────────────────────────────────────────

interface RawModel {
  provider?: string;
  contextWindow?: number;
  pricing?: {
    input?: number;
    output?: number;
    cacheRead?: number;
  };
  capability?: {
    coding?: number;
    reasoning?: number;
    speed?: number;
  };
}

interface RawModelsJson {
  models?: Record<string, RawModel>;
}

interface ModelRow {
  name: string;
  provider: string;
  contextWindow: number;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  coding: number;
  reasoning: number;
  speed: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Badge color for a 0..1 capability score. */
function scoreColor(score: number): "green" | "blue" | "slate" {
  if (score >= 0.8) return "green";
  if (score >= 0.6) return "blue";
  return "slate";
}

/** Format a 0..1 capability score as a two-decimal badge. */
function ScoreBadge({ score }: { score: number }): React.ReactElement {
  const value = Number.isFinite(score) ? score : 0;
  return <Badge color={scoreColor(value)}>{value.toFixed(2)}</Badge>;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function ModelComparisonPanel(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [models, setModels] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!fluxDir) {
        if (!cancelled) {
          setModels([]);
          setLoading(false);
        }
        return;
      }
      try {
        const raw = await readFileContent(`${fluxDir}/models.json`);
        if (cancelled) return;
        if (!raw) {
          if (!cancelled) setModels([]);
          return;
        }
        const parsed = JSON.parse(raw) as RawModelsJson;
        const entries = parsed.models ?? {};
        const rows: ModelRow[] = Object.entries(entries).map(([name, m]) => ({
          name,
          provider: m.provider ?? "-",
          contextWindow: m.contextWindow ?? 0,
          inputPrice: m.pricing?.input ?? 0,
          outputPrice: m.pricing?.output ?? 0,
          cacheReadPrice: m.pricing?.cacheRead ?? 0,
          coding: m.capability?.coding ?? 0,
          reasoning: m.capability?.reasoning ?? 0,
          speed: m.capability?.speed ?? 0,
        }));
        if (!cancelled) setModels(rows);
      } catch {
        if (!cancelled) setModels([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    load();

    return () => {
      cancelled = true;
    };
  }, [fluxDir]);

  const columns = [
    { key: "name", label: "Model" },
    { key: "provider", label: "Provider" },
    { key: "context", label: "Context" },
    { key: "input", label: "Input $/M" },
    { key: "output", label: "Output $/M" },
    { key: "cache", label: "Cache $/M" },
    { key: "coding", label: "Coding" },
    { key: "reasoning", label: "Reasoning" },
    { key: "speed", label: "Speed" },
  ];

  const rows = models.map((m) => ({
    name: <span className="font-medium text-slate-800 dark:text-slate-200">{m.name}</span>,
    provider: <span className="text-sm text-slate-500 dark:text-slate-400">{m.provider}</span>,
    context: (
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {m.contextWindow > 0 ? formatTokens(m.contextWindow) : "-"}
      </span>
    ),
    input: (
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {formatCost(m.inputPrice * 1_000_000)}
      </span>
    ),
    output: (
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {formatCost(m.outputPrice * 1_000_000)}
      </span>
    ),
    cache: (
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {formatCost(m.cacheReadPrice * 1_000_000)}
      </span>
    ),
    coding: <ScoreBadge score={m.coding} />,
    reasoning: <ScoreBadge score={m.reasoning} />,
    speed: <ScoreBadge score={m.speed} />,
  }));

  return (
    <Card className="text-slate-800 dark:text-slate-200">
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Cpu" size={20} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Model Comparison
        </h3>
        {loading ? (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">Loading...</span>
        ) : (
          <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
            {models.length} model{models.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {models.length === 0 ? (
        <EmptyState icon="Cpu" message="No models configured" />
      ) : (
        <DataTable columns={columns} rows={rows} />
      )}
    </Card>
  );
}

export default ModelComparisonPanel;
