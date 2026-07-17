/**
 * Model-Role Affinity Panel — static educational component showing how the
 * affinity system ranks models for each agent role.
 *
 * Data is defined locally (mock values reflecting the design from docs) and is
 * NOT wired to any live source. The matrix displays affinity scores per
 * (role, model) pair with color intensity reflecting relative fit, and the
 * best-scoring model per role is outlined in green.
 */
import React from "react";
import { Card, Icon } from "./ui";
import { formatPct } from "../lib/format";

// ---------------------------------------------------------------------------
// Static educational data
// ---------------------------------------------------------------------------

const MODELS = [
  "gpt-5.5",
  "oa/glm-5.2",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "qwen3.7-max",
];

const ROLES = ["planner", "implementer", "reviewer", "tester", "designer"];

// Affinity scores (0-1) — mock data reflecting the design from docs
const SCORES: Record<string, Record<string, number>> = {
  planner: { "gpt-5.5": 0.775, "oa/glm-5.2": 0.792, "deepseek-v4-flash": 0.78, "deepseek-v4-pro": 0.79, "qwen3.7-max": 0.785 },
  implementer: { "gpt-5.5": 0.7, "oa/glm-5.2": 0.75, "deepseek-v4-flash": 0.8, "deepseek-v4-pro": 0.78, "qwen3.7-max": 0.76 },
  reviewer: { "gpt-5.5": 0.766, "oa/glm-5.2": 0.76, "deepseek-v4-flash": 0.74, "deepseek-v4-pro": 0.755, "qwen3.7-max": 0.75 },
  tester: { "gpt-5.5": 0.68, "oa/glm-5.2": 0.74, "deepseek-v4-flash": 0.796, "deepseek-v4-pro": 0.77, "qwen3.7-max": 0.755 },
  designer: { "gpt-5.5": 0.78, "oa/glm-5.2": 0.77, "deepseek-v4-flash": 0.73, "deepseek-v4-pro": 0.76, "qwen3.7-max": 0.745 },
};

// ---------------------------------------------------------------------------
// Cell styling helpers
// ---------------------------------------------------------------------------

interface CellStyle {
  bg: string;
  text: string;
}

/** Map a 0..1 affinity score to a background/text intensity class. */
function cellStyle(score: number): CellStyle {
  if (score >= 0.8) {
    return { bg: "bg-blue-500 dark:bg-blue-500", text: "text-white" };
  }
  if (score >= 0.78) {
    return { bg: "bg-blue-300 dark:bg-blue-300", text: "text-slate-800" };
  }
  if (score >= 0.75) {
    return { bg: "bg-blue-100 dark:bg-blue-900/60", text: "text-slate-700 dark:text-slate-100" };
  }
  return { bg: "bg-slate-100 dark:bg-slate-700/50", text: "text-slate-500 dark:text-slate-300" };
}

/** Return the highest-scoring model for a given role. */
function bestModelFor(role: string): string {
  const row = SCORES[role];
  let best = MODELS[0];
  for (const m of MODELS) {
    if ((row[m] ?? 0) > (row[best] ?? 0)) best = m;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentAffinityPanel(): React.ReactElement {
  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <Icon name="Target" size={18} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Model-Role Affinity
        </h3>
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          title="Static sample data — not connected to live affinity engine"
        >
          🧪 Sample Data
        </span>
      </div>

      {/* Affinity matrix */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="bg-slate-50 dark:bg-slate-900/50 text-left text-xs font-medium text-slate-500 dark:text-slate-400 px-3 py-2 w-28 sticky left-0 z-10">
                Role
              </th>
              {MODELS.map((model) => (
                <th
                  key={model}
                  className="bg-slate-50 dark:bg-slate-900/50 text-xs font-medium text-slate-500 dark:text-slate-400 px-2 py-2 text-center"
                  title={model}
                >
                  <div className="max-w-[7rem] truncate mx-auto" title={model}>
                    {model}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROLES.map((role) => {
              const best = bestModelFor(role);
              return (
                <tr key={role} className="border-t border-slate-100 dark:border-slate-700">
                  <td className="px-3 py-2 w-28 sticky left-0 z-10 bg-white dark:bg-slate-800">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      {role}
                    </span>
                  </td>
                  {MODELS.map((model) => {
                    const score = SCORES[role][model] ?? 0;
                    const style = cellStyle(score);
                    const isBest = model === best;
                    return (
                      <td
                        key={model}
                        className={`px-2 py-2 text-center text-sm font-mono ${style.bg} ${style.text} ${
                          isBest ? "border-2 border-green-500" : "border border-slate-100 dark:border-slate-700"
                        }`}
                        title={`${role} / ${model}: ${formatPct(score)}${isBest ? " (best)" : ""}`}
                      >
                        {formatPct(score)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-medium text-slate-600 dark:text-slate-300">Intensity:</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 h-4 rounded bg-slate-100 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600" />
            &lt; 0.75
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 h-4 rounded bg-blue-100 dark:bg-blue-900/60 border border-blue-200 dark:border-blue-700" />
            0.75+
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 h-4 rounded bg-blue-300 dark:bg-blue-300 border border-blue-400" />
            0.78+
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 h-4 rounded bg-blue-500 border border-blue-600" />
            0.80+
          </span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Higher = better fit. Green border = best match per role. This is static example data from the design spec.
        </p>
      </div>
    </Card>
  );
}
