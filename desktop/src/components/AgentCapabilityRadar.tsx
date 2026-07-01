/**
 * Agent Capability Radar — radar chart comparing agent role capability vectors.
 * Static educational component illustrating the relative strengths of each role.
 */
import React from "react";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, Icon, Badge } from "./ui";
import { formatPct } from "../lib/format";

interface RoleVector {
  name: string;
  coding: number;
  reasoning: number;
  speed: number;
  context: number;
  cost_eff: number;
}

const ROLES: RoleVector[] = [
  { name: "Planner", coding: 0.3, reasoning: 0.9, speed: 0.2, context: 0.7, cost_eff: 0.3 },
  { name: "Implementer", coding: 0.9, reasoning: 0.6, speed: 0.7, context: 0.5, cost_eff: 0.7 },
  { name: "Reviewer", coding: 0.5, reasoning: 0.9, speed: 0.4, context: 0.6, cost_eff: 0.4 },
  { name: "Tester", coding: 0.7, reasoning: 0.6, speed: 0.8, context: 0.4, cost_eff: 0.6 },
  { name: "Designer", coding: 0.4, reasoning: 0.8, speed: 0.3, context: 0.7, cost_eff: 0.3 },
];

const DIMENSIONS: { key: "coding" | "reasoning" | "speed" | "context" | "cost_eff"; label: string }[] = [
  { key: "coding", label: "Coding" },
  { key: "reasoning", label: "Reasoning" },
  { key: "speed", label: "Speed" },
  { key: "context", label: "Context" },
  { key: "cost_eff", label: "Cost Eff." },
];

const ROLE_COLORS: Record<string, string> = {
  Planner: "#3b82f6", // blue
  Implementer: "#10b981", // green
  Reviewer: "#f59e0b", // amber
  Tester: "#8b5cf6", // purple
  Designer: "#ec4899", // pink
};

const ROLE_BADGE_COLOR: Record<
  string,
  "blue" | "green" | "amber" | "purple" | "pink"
> = {
  Planner: "blue",
  Implementer: "green",
  Reviewer: "amber",
  Tester: "purple",
  Designer: "pink",
};

/** Short human-readable capability summary for each role. */
const ROLE_SUMMARY: Record<string, string> = {
  Planner: "High reasoning and context awareness; trades speed and cost.",
  Implementer: "Strong coding with balanced speed and cost efficiency.",
  Reviewer: "Reasoning-first role focused on quality assessment.",
  Tester: "Fast iteration with solid coding throughput.",
  Designer: "Reasoning-driven architect; lower speed and cost priority.",
};

/** Transform ROLES into Recharts format: one entry per dimension. */
function buildChartData(): Record<string, number | string>[] {
  return DIMENSIONS.map((dim) => {
    const row: Record<string, number | string> = { dimension: dim.label };
    for (const role of ROLES) {
      row[role.name] = role[dim.key];
    }
    return row;
  });
}

const CHART_DATA = buildChartData();

/** Best (highest) capability dimension for a role. */
function topDimension(role: RoleVector): string {
  let bestKey: "coding" | "reasoning" | "speed" | "context" | "cost_eff" = "coding";
  let bestVal = -Infinity;
  for (const dim of DIMENSIONS) {
    if (role[dim.key] > bestVal) {
      bestVal = role[dim.key];
      bestKey = dim.key;
    }
  }
  const found = DIMENSIONS.find((d) => d.key === bestKey);
  return `${found?.label ?? bestKey} ${formatPct(bestVal)}`;
}

export function AgentCapabilityRadar(): React.ReactElement {
  return (
    <Card className="dark:bg-slate-800 dark:border-slate-700">
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Radar" size={20} className="text-blue-500 dark:text-blue-400" />
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
          Agent Capability Radar
        </h3>
      </div>

      <div className="w-full" style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height={300}>
          <RadarChart data={CHART_DATA} cx="50%" cy="50%" outerRadius="75%">
            <PolarGrid stroke="#334155" />
            <PolarAngleAxis
              dataKey="dimension"
              tick={{ fill: "#cbd5e1", fontSize: 12 }}
            />
            <PolarRadiusAxis
              domain={[0, 1]}
              angle={90}
              tick={{ fill: "#94a3b8", fontSize: 10 }}
              stroke="#475569"
            />
            {ROLES.map((role) => (
              <Radar
                key={role.name}
                name={role.name}
                dataKey={role.name}
                stroke={ROLE_COLORS[role.name]}
                fill={ROLE_COLORS[role.name]}
                fillOpacity={0.15}
                strokeWidth={2}
              />
            ))}
            <Legend
              wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Role legend with color dots and capability summary */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {ROLES.map((role) => (
          <div
            key={role.name}
            className="flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 p-3"
          >
            <span
              className="mt-1 inline-block rounded-full"
              style={{
                width: 10,
                height: 10,
                backgroundColor: ROLE_COLORS[role.name],
              }}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {role.name}
                </span>
                <Badge color={ROLE_BADGE_COLOR[role.name]}>
                  {topDimension(role)}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {ROLE_SUMMARY[role.name]}
              </p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
