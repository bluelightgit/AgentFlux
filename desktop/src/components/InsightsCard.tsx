/**
 * Insights Card — AI-powered insights about multi-agent performance.
 *
 * Renders a list of severity-tagged insight messages produced by the
 * insights engine. Each row shows a severity-colored icon, the message
 * text, and a severity Badge. The list scrolls when there are more than
 * 5 items.
 */
import React from "react";
import { Card, Icon, Badge, EmptyState } from "./ui";

// ─── Types ────────────────────────────────────────────────────────────────

export type InsightSeverity = "info" | "warning" | "critical";

export interface InsightItem {
  severity: InsightSeverity;
  /** Lucide icon name (resolved via the shared Icon component). */
  icon: string;
  message: string;
}

export interface InsightsCardProps {
  insights: InsightItem[];
}

// ─── Severity styling ─────────────────────────────────────────────────────

const SEVERITY_ICON_CLASS: Record<InsightSeverity, string> = {
  info: "text-blue-500 dark:text-blue-400",
  warning: "text-amber-500 dark:text-amber-400",
  critical: "text-red-500 dark:text-red-400",
};

const SEVERITY_BADGE_COLOR: Record<
  InsightSeverity,
  "blue" | "amber" | "red"
> = {
  info: "blue",
  warning: "amber",
  critical: "red",
};

// ─── Component ────────────────────────────────────────────────────────────

export function InsightsCard({
  insights,
}: InsightsCardProps): React.ReactElement {
  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon
          name="Lightbulb"
          size={18}
          className="text-amber-500 dark:text-amber-400"
        />
        <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          Insights
        </h3>
      </div>

      {/* Body */}
      {insights.length === 0 ? (
        <EmptyState icon="Lightbulb" message="No insights yet" />
      ) : (
        <div
          className={`flex flex-col gap-2 ${insights.length > 5 ? "max-h-64 overflow-y-auto" : ""}`}
        >
          {insights.map((insight, i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-3 py-2"
            >
              <Icon
                name={insight.icon}
                size={18}
                className={`shrink-0 mt-0.5 ${SEVERITY_ICON_CLASS[insight.severity]}`}
              />
              <p className="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-200 break-words">
                {insight.message}
              </p>
              <Badge color={SEVERITY_BADGE_COLOR[insight.severity]}>
                {insight.severity}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default InsightsCard;
