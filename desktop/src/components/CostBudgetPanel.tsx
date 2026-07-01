/**
 * Cost Budget panel.
 *
 * Tracks total agent spend (sum of `costUsd` across `subagent.run` and
 * `cache.sample` events in `${fluxDir}/events.jsonl`) against a user-defined
 * budget. The budget is persisted to localStorage and a horizontal progress
 * bar visualises usage (green / amber / red by threshold).
 *
 * Polls events.jsonl every 10s for near-real-time cost updates.
 */
import React, { useEffect, useState } from "react";
import { Card, Icon, Badge, MetricCard, EmptyState } from "./ui";
import { formatCost } from "../lib/format";
import { parseEventsFileAsync, type AnyEvent } from "../lib/events-parser";
import { useDashboardStore } from "../store/dashboard-store";

// localStorage key for the user-defined budget limit (in USD).
const BUDGET_STORAGE_KEY = "agentflux-budget-limit";

// Polling interval for re-reading events.jsonl.
const POLL_INTERVAL_MS = 10_000;

// Progress-bar color thresholds (fraction of budget used).
const THRESHOLD_AMBER = 0.5;
const THRESHOLD_RED = 0.8;

/**
 * Sum the cost across all billable event types.
 *
 * `subagent.run` events carry the per-run subagent cost, while
 * `cache.sample` events carry the main-agent per-turn cost. Both are
 * summed to produce a total spend figure.
 */
function computeCost(events: AnyEvent[]): { totalCost: number; runCount: number } {
  let totalCost = 0;
  let runCount = 0;

  for (const e of events) {
    if (e.type === "subagent.run") {
      totalCost += e.costUsd ?? 0;
      runCount += 1;
    } else if (e.type === "cache.sample") {
      totalCost += e.costUsd ?? 0;
    }
  }

  return { totalCost, runCount };
}

/** Read the persisted budget limit (USD) from localStorage, if any. */
function loadBudgetLimit(): number {
  try {
    const raw = localStorage.getItem(BUDGET_STORAGE_KEY);
    if (raw == null || raw === "") return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Persist the budget limit (USD) to localStorage. */
function saveBudgetLimit(value: number): void {
  try {
    localStorage.setItem(BUDGET_STORAGE_KEY, String(value));
  } catch {
    // localStorage may be unavailable (e.g. privacy mode); ignore.
  }
}

/** Tailwind classes for the progress bar fill, by threshold band. */
function progressFillClass(fraction: number): string {
  if (fraction >= THRESHOLD_RED) return "bg-red-500";
  if (fraction >= THRESHOLD_AMBER) return "bg-amber-500";
  return "bg-green-500";
}

// ─── Component ─────────────────────────────────────────────────────────────

export function CostBudgetPanel(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [totalCost, setTotalCost] = useState<number>(0);
  const [runCount, setRunCount] = useState<number>(0);
  const [budgetLimit, setBudgetLimit] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);

  // Budget input is edited locally and committed on Save.
  const [budgetInput, setBudgetInput] = useState<string>("");

  // Load persisted budget on mount.
  useEffect(() => {
    const stored = loadBudgetLimit();
    setBudgetLimit(stored);
    setBudgetInput(stored > 0 ? String(stored) : "");
  }, []);

  // Poll events.jsonl for cost updates.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!fluxDir) {
        if (!cancelled) {
          setTotalCost(0);
          setRunCount(0);
          setLoading(false);
        }
        return;
      }
      try {
        const events = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
        if (cancelled) return;
        const { totalCost: cost, runCount: runs } = computeCost(events);
        setTotalCost(cost);
        setRunCount(runs);
      } catch {
        if (!cancelled) {
          setTotalCost(0);
          setRunCount(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fluxDir]);

  const handleSaveBudget = () => {
    const n = Number(budgetInput);
    const next = Number.isFinite(n) && n > 0 ? n : 0;
    setBudgetLimit(next);
    saveBudgetLimit(next);
  };

  const overBudget = budgetLimit > 0 && totalCost > budgetLimit;
  const fraction = budgetLimit > 0 ? Math.min(totalCost / budgetLimit, 1) : 0;
  const pct = budgetLimit > 0 ? (totalCost / budgetLimit) * 100 : 0;
  const avgPerRun = runCount > 0 ? totalCost / runCount : 0;

  return (
    <Card className="text-slate-800 dark:text-slate-200">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Wallet" size={20} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Cost Budget
        </h3>
        {overBudget ? (
          <Badge color="red">Over Budget</Badge>
        ) : null}
        <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
          {loading ? "Loading…" : "Updated"}
        </span>
      </div>

      {/* Budget input + Save */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-3 mb-4">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="agentflux-budget-input"
            className="text-xs text-slate-500 dark:text-slate-400"
          >
            Budget ($)
          </label>
          <input
            id="agentflux-budget-input"
            type="number"
            min={0}
            step="0.01"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            placeholder="e.g. 50"
            className="w-40 rounded-lg bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="button"
          onClick={handleSaveBudget}
          className="inline-flex items-center gap-1.5 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          <Icon name="Save" size={16} />
          Save
        </button>
      </div>

      {/* Progress bar OR empty prompt */}
      {budgetLimit > 0 ? (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {formatCost(totalCost)} of {formatCost(budgetLimit)} used
            </span>
            <span
              className={`text-xs font-medium ${
                overBudget
                  ? "text-red-600 dark:text-red-400"
                  : fraction >= THRESHOLD_RED
                    ? "text-red-600 dark:text-red-400"
                    : fraction >= THRESHOLD_AMBER
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-green-600 dark:text-green-400"
              }`}
            >
              {pct.toFixed(1)}%
            </span>
          </div>
          <div className="w-full h-3 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${progressFillClass(fraction)}`}
              style={{ width: `${Math.max(fraction * 100, 0)}%` }}
            />
          </div>
        </div>
      ) : (
        <EmptyState
          icon="Wallet"
          message="Set a budget to track spending"
        />
      )}

      {/* Metrics grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
        <MetricCard
          icon="DollarSign"
          label="Total Cost"
          value={
            <span className={overBudget ? "text-red-600 dark:text-red-400" : ""}>
              {formatCost(totalCost)}
            </span>
          }
        />
        <MetricCard
          icon="Activity"
          label="Run Count"
          value={runCount}
        />
        <MetricCard
          icon="Coins"
          label="Avg Cost/Run"
          value={formatCost(avgPerRun)}
        />
      </div>
    </Card>
  );
}

export default CostBudgetPanel;
