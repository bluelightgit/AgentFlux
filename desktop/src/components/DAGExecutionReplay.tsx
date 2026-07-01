/**
 * DAGExecutionReplay — step-through replay of a historical DAG execution.
 *
 * Reads events.jsonl, filters to `subagent.run` events whose `agent` field
 * starts with `dag-`, sorts them by timestamp ascending, and presents a
 * player-like UI for stepping through each subagent's execution record one
 * at a time. Supports auto-play (advance every 2s) and a progress bar.
 *
 * Loads once on mount; no polling.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import {
  parseEventsFileAsync,
  filterByType,
  type SubagentRunEvent,
} from "../lib/events-parser";
import { Card, Icon, Badge, EmptyState, type BadgeColor } from "./ui";
import { formatCost, formatTs } from "../lib/format";

/** A single replay step derived from a `dag-*` subagent.run event. */
interface ReplayStep {
  agent: string;
  timestamp: string;
  turns: number;
  cost: number;
  exitCode: number;
  output: string;
}

/** Widened event type — `thinking` is the textual output we preview. */
type RunEventWide = SubagentRunEvent & { thinking?: string };

/**
 * Build the ordered list of replay steps from raw subagent.run events,
 * keeping only agents whose name starts with `dag-`.
 */
function buildSteps(events: SubagentRunEvent[]): ReplayStep[] {
  const out: ReplayStep[] = [];
  for (const e of events) {
    const agent = e.agent ?? "";
    if (!agent.startsWith("dag-")) continue;
    const we = e as RunEventWide;
    out.push({
      agent,
      timestamp: String(e.ts),
      turns: e.turns ?? 0,
      cost: e.costUsd ?? 0,
      exitCode: e.exitCode ?? 0,
      output: we.thinking ?? "",
    });
  }
  // Sort by timestamp ascending (chronological replay order).
  out.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return out;
}

/** Pick a Badge color for a DAG agent based on its role prefix. */
function agentColor(agent: string): BadgeColor {
  if (agent.startsWith("dag-planner")) return "blue";
  if (agent.startsWith("dag-t")) return "green";
  if (agent.startsWith("dag-d")) return "amber";
  if (agent.startsWith("dag-r")) return "purple";
  return "slate";
}

export function DAGExecutionReplay(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [steps, setSteps] = useState<ReplayStep[]>([]);
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [playing, setPlaying] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    if (!fluxDir) {
      setSteps([]);
      setLoading(false);
      return;
    }
    try {
      const parsed = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
      const runs = filterByType(parsed, "subagent.run") as SubagentRunEvent[];
      setSteps(buildSteps(runs));
    } catch {
      setSteps([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  // Load on mount only — no polling.
  useEffect(() => {
    load();
  }, [load]);

  // Auto-play: advance currentStep every 2s, stop at the end.
  useEffect(() => {
    if (!playing) return;
    if (steps.length === 0) {
      setPlaying(false);
      return;
    }
    if (currentStep >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const id = setInterval(() => {
      setCurrentStep((prev) => {
        if (prev >= steps.length - 1) {
          setPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 2000);
    return () => clearInterval(id);
  }, [playing, currentStep, steps.length]);

  const hasNext = currentStep < steps.length - 1;
  const hasPrev = currentStep > 0;

  const handlePrev = useCallback(() => {
    setPlaying(false);
    setCurrentStep((s) => Math.max(0, s - 1));
  }, []);

  const handleNext = useCallback(() => {
    setPlaying(false);
    setCurrentStep((s) => Math.min(steps.length - 1, s + 1));
  }, [steps.length]);

  const handleReset = useCallback(() => {
    setPlaying(false);
    setCurrentStep(0);
  }, []);

  const togglePlay = useCallback(() => {
    if (steps.length === 0) return;
    if (currentStep >= steps.length - 1) {
      // Restart from the beginning if at the end.
      setCurrentStep(0);
      setPlaying(true);
      return;
    }
    setPlaying((p) => !p);
  }, [currentStep, steps.length]);

  const progressPct = useMemo(() => {
    if (steps.length === 0) return 0;
    return ((currentStep + 1) / steps.length) * 100;
  }, [currentStep, steps.length]);

  const step = steps[currentStep];
  const outputPreview = useMemo(() => {
    if (!step || !step.output) return "";
    return step.output.length > 200 ? step.output.slice(-200) : step.output;
  }, [step]);

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon name="PlayCircle" size={20} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          DAG Execution Replay
        </h3>
      </div>

      {/* Body */}
      {loading ? (
        <div className="h-48 flex items-center justify-center text-slate-400 dark:text-slate-500">
          Loading...
        </div>
      ) : steps.length === 0 ? (
        <EmptyState
          icon="PlayCircle"
          message="No DAG execution data to replay"
        />
      ) : (
        <>
          {/* Replay controls */}
          <div className="flex items-center gap-2 mb-4">
            <button
              type="button"
              onClick={handlePrev}
              disabled={!hasPrev}
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Previous step"
            >
              <Icon name="ChevronLeft" size={18} />
            </button>
            <button
              type="button"
              onClick={togglePlay}
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-blue-600 dark:bg-blue-600 p-2 text-white hover:bg-blue-700 dark:hover:bg-blue-700"
              aria-label={playing ? "Pause" : "Play"}
            >
              <Icon name={playing ? "Pause" : "Play"} size={18} />
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={!hasNext}
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Next step"
            >
              <Icon name="ChevronRight" size={18} />
            </button>
            <span className="text-sm text-slate-500 dark:text-slate-400 ml-1">
              Step {currentStep + 1} / {steps.length}
            </span>
            <button
              type="button"
              onClick={handleReset}
              className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
              aria-label="Reset replay"
            >
              <Icon name="RotateCcw" size={14} />
              Reset
            </button>
          </div>

          {/* Current step display */}
          {step ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge color={agentColor(step.agent)}>{step.agent}</Badge>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {formatTs(Number(step.timestamp))}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Turns: {step.turns}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                  {formatCost(step.cost)}
                </span>
                <Badge color={step.exitCode === 0 ? "green" : "red"}>
                  exit {step.exitCode}
                </Badge>
              </div>

              {outputPreview ? (
                <div className="bg-slate-50 dark:bg-slate-800 rounded p-3 max-h-32 overflow-auto">
                  <pre className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words">
                    {outputPreview}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Progress bar */}
          <div className="mt-4">
            <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

export default DAGExecutionReplay;
