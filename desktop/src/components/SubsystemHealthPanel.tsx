/**
 * Subsystem Health Panel
 * Visual health check of AgentFlux subsystems by inspecting the
 * `.agentflux/` directory structure for expected files/directories.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { pathExists } from "../lib/file-access";
import { Card, Icon, Badge } from "./ui";

/** Health check result for a single subsystem. */
interface HealthCheck {
  name: string;
  healthy: boolean;
  detail: string;
}

/** Join path segments without depending on node:path. */
function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/** List directory entries via the Electron preload bridge. Returns [] if unavailable. */
async function listDir(dirPath: string): Promise<string[]> {
  if (typeof window !== "undefined" && window.api?.listDirectory) {
    try {
      const entries = await window.api.listDirectory(dirPath);
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Get file size in bytes via the Electron preload bridge. Returns 0 if unavailable/missing. */
async function getFileSize(filePath: string): Promise<number> {
  if (typeof window !== "undefined" && window.api?.fileSize) {
    try {
      return window.api.fileSize(filePath);
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Probe all AgentFlux subsystems under the given fluxDir and return
 * a list of health-check results.
 */
async function runHealthChecks(fluxDir: string): Promise<HealthCheck[]> {
  // Config: agentflux.json present
  const configPath = joinPath(fluxDir, "agentflux.json");
  const configOk = await pathExists(configPath);

  // Models: models.json present
  const modelsPath = joinPath(fluxDir, "models.json");
  const modelsOk = await pathExists(modelsPath);

  // Telemetry: events.jsonl present and non-empty
  const eventsPath = joinPath(fluxDir, "events.jsonl");
  const eventsExists = await pathExists(eventsPath);
  const eventsSize = eventsExists ? await getFileSize(eventsPath) : 0;
  const telemetryOk = eventsExists && eventsSize > 0;

  // SharedBoard: shared/ directory present
  const sharedDir = joinPath(fluxDir, "shared");
  const sharedOk = await pathExists(sharedDir);

  // Experience: experience.jsonl present
  const expPath = joinPath(fluxDir, "experience.jsonl");
  const expOk = await pathExists(expPath);

  // Persistent Agents: runtime/persistent-agents.json present
  const persistentPath = joinPath(fluxDir, "runtime", "persistent-agents.json");
  const persistentOk = await pathExists(persistentPath);

  // DAG State: runtime/dag-state.json present
  const dagStatePath = joinPath(fluxDir, "runtime", "dag-state.json");
  const dagStateOk = await pathExists(dagStatePath);

  // Sessions: runtime/sessions/ has at least one .jsonl file
  const sessionsDir = joinPath(fluxDir, "runtime", "sessions");
  const sessionsEntries = await listDir(sessionsDir);
  const sessionsOk = sessionsEntries.some((f) => f.endsWith(".jsonl"));

  return [
    {
      name: "Config",
      healthy: configOk,
      detail: configOk ? "agentflux.json found" : "agentflux.json missing",
    },
    {
      name: "Models",
      healthy: modelsOk,
      detail: modelsOk ? "models.json found" : "models.json missing",
    },
    {
      name: "Telemetry",
      healthy: telemetryOk,
      detail: telemetryOk ? `events.jsonl (${eventsSize} bytes)` : "events.jsonl empty/missing",
    },
    {
      name: "SharedBoard",
      healthy: sharedOk,
      detail: sharedOk ? "shared/ directory found" : "shared/ missing",
    },
    {
      name: "Experience",
      healthy: expOk,
      detail: expOk ? "experience.jsonl found" : "experience.jsonl missing",
    },
    {
      name: "Persistent Agents",
      healthy: persistentOk,
      detail: persistentOk ? "persistent-agents.json found" : "persistent-agents.json missing",
    },
    {
      name: "DAG State",
      healthy: dagStateOk,
      detail: dagStateOk ? "dag-state.json found" : "dag-state.json missing",
    },
    {
      name: "Sessions",
      healthy: sessionsOk,
      detail: sessionsOk
        ? `${sessionsEntries.filter((f) => f.endsWith(".jsonl")).length} session file(s)`
        : "no session files",
    },
  ];
}

export function SubsystemHealthPanel(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!fluxDir) {
      setChecks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const results = await runHealthChecks(fluxDir);
      setChecks(results);
    } catch (err) {
      // Swallow errors; panel simply shows no data on failure.
      console.warn("[flux] subsystem health check failed:", err);
      setChecks([]);
    } finally {
      setLoading(false);
    }
  }, [fluxDir]);

  useEffect(() => {
    refresh();

    // Poll every 15 seconds.
    timerRef.current = setInterval(() => {
      refresh();
    }, 15000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [refresh]);

  const allHealthy = checks.length > 0 && checks.every((c) => c.healthy);
  const anyHealthy = checks.some((c) => c.healthy);

  // Overall badge: green if all healthy, amber if some healthy, red if none.
  let badgeColor: "green" | "amber" | "red" = "red";
  let badgeLabel = "Issues Found";
  if (allHealthy) {
    badgeColor = "green";
    badgeLabel = "All Healthy";
  } else if (anyHealthy) {
    badgeColor = "amber";
    badgeLabel = "Issues Found";
  } else {
    badgeColor = "red";
    badgeLabel = "Issues Found";
  }

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon name="HeartPulse" size={18} className="text-slate-700 dark:text-slate-200" />
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Subsystem Health
          </h3>
        </div>
        <Badge color={badgeColor}>{badgeLabel}</Badge>
      </div>

      {/* Health grid */}
      {loading && checks.length === 0 ? (
        <div className="flex items-center justify-center py-10 text-sm text-slate-400 dark:text-slate-500">
          <Icon name="Loader2" size={16} className="animate-spin mr-2" />
          Checking subsystems...
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {checks.map((c) => {
            const iconName: string = c.healthy ? "CheckCircle2" : "XCircle";
            const iconColor: string = c.healthy
              ? "text-green-600 dark:text-green-400"
              : "text-red-600 dark:text-red-400";
            return (
              <div
                key={c.name}
                className="flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 p-3"
              >
                <Icon name={iconName} size={18} className={iconColor} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    {c.name}
                  </div>
                  <div className="text-xs text-slate-400 dark:text-slate-500 truncate">
                    {c.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {checks.length === 0 && !loading ? (
        <div className="text-sm text-slate-400 dark:text-slate-500 py-6 text-center">
          No project selected.
        </div>
      ) : null}
    </Card>
  );
}
