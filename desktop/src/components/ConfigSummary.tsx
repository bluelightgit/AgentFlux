/**
 * ConfigSummary — compact summary of the current AgentFlux configuration.
 *
 * Reads `.agentflux/agentflux.json` (and `models.json` for model/role counts)
 * via the Electron preload bridge (`window.api?.readFileContent`) and renders
 * a grid of the most important config values. Configuration is static, so the
 * file is loaded once on mount (no polling).
 */
import React, { useEffect, useState } from "react";
import { Card, Icon, Badge, EmptyState } from "./ui";
import type { BadgeColor } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";

interface FluxConfig {
  preset?: string;
  mode?: string;
  override_mode?: string;
  prefix_layout?: string;
  models_count?: number;
  roles_count?: number;
}

/** Resolve a value from a nested config object, trying several key paths. */
function pick<T = unknown>(cfg: any, keys: string[]): T | undefined {
  if (!cfg || typeof cfg !== "object") return undefined;
  for (const path of keys) {
    const parts = path.split(".");
    let cur: any = cfg;
    let found = true;
    for (const p of parts) {
      if (cur == null || typeof cur !== "object" || !(p in cur)) {
        found = false;
        break;
      }
      cur = cur[p];
    }
    if (found && cur !== undefined && cur !== null) return cur as T;
  }
  return undefined;
}

/** Read a file as text via the preload bridge, with a sync fallback. */
async function readText(path: string): Promise<string> {
  if (typeof window !== "undefined") {
    const api = (window as any).api;
    if (api?.readFileContent) {
      return (await api.readFileContent(path)) ?? "";
    }
    if (api?.readFile) {
      return api.readFile(path) ?? "";
    }
  }
  return "";
}

const PRESET_COLORS: Record<string, BadgeColor> = {
  eco: "green",
  fast: "blue",
  balanced: "amber",
  accurate: "purple",
  custom: "slate",
};

const OVERRIDE_COLORS: Record<string, BadgeColor> = {
  suggest: "slate",
  auto: "blue",
  silent: "slate",
};

function ConfigItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {children}
      </span>
    </div>
  );
}

export function ConfigSummary(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [config, setConfig] = useState<FluxConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      if (!fluxDir) {
        setConfig(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const raw = await readText(`${fluxDir}/agentflux.json`);
        if (!raw) {
          if (!cancelled) {
            setConfig(null);
            setLoading(false);
          }
          return;
        }
        let cfg: any;
        try {
          cfg = JSON.parse(raw);
        } catch {
          if (!cancelled) {
            setConfig(null);
            setLoading(false);
          }
          return;
        }

        const preset = pick<string>(cfg, ["preset", "preference.profile"]);
        const mode = pick<string>(cfg, [
          "mode",
          "baseline_mode",
          "preference.mode",
        ]);
        const overrideMode = pick<string>(cfg, [
          "override_mode",
          "preference.override_mode",
          "preference.escalate_hint",
        ]);
        const prefixLayout = pick<string>(cfg, [
          "prefix_layout",
          "preference.prefix_layout",
        ]);

        let modelsCount: number | undefined = pick<number>(cfg, [
          "models_count",
          "models.count",
        ]);
        let rolesCount: number | undefined = pick<number>(cfg, [
          "roles_count",
          "roles.count",
        ]);

        // If counts aren't in agentflux.json, derive them from models.json.
        if (modelsCount === undefined || rolesCount === undefined) {
          try {
            const modelsRaw = await readText(`${fluxDir}/models.json`);
            if (modelsRaw) {
              const modelsCfg = JSON.parse(modelsRaw);
              if (modelsCount === undefined && modelsCfg?.models) {
                modelsCount = Object.keys(modelsCfg.models).length;
              }
              if (rolesCount === undefined && modelsCfg?.roles) {
                rolesCount = Object.keys(modelsCfg.roles).length;
              }
            }
          } catch {
            // models.json is optional; ignore.
          }
        }

        if (cancelled) return;
        setConfig({
          preset,
          mode,
          override_mode: overrideMode,
          prefix_layout: prefixLayout,
          models_count: modelsCount,
          roles_count: rolesCount,
        });
      } catch {
        if (!cancelled) setConfig(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [fluxDir]);

  const presetColor: BadgeColor | undefined = config?.preset
    ? PRESET_COLORS[config.preset] ?? "slate"
    : undefined;
  const overrideColor: BadgeColor | undefined = config?.override_mode
    ? OVERRIDE_COLORS[config.override_mode] ?? "slate"
    : undefined;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon name="Settings" size={18} className="text-slate-500 dark:text-slate-400" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Configuration Summary
        </h3>
      </div>

      {loading ? (
        <div className="text-sm text-slate-400 dark:text-slate-500 py-6 text-center">
          Loading...
        </div>
      ) : !config ? (
        <EmptyState
          icon="Settings"
          message="No configuration file found"
        />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <ConfigItem label="Preset">
            {config.preset ? (
              <Badge color={presetColor}>{config.preset}</Badge>
            ) : (
              "-"
            )}
          </ConfigItem>

          <ConfigItem label="Mode">{config.mode ?? "-"}</ConfigItem>

          <ConfigItem label="Override Mode">
            {config.override_mode ? (
              <Badge color={overrideColor}>{config.override_mode}</Badge>
            ) : (
              "-"
            )}
          </ConfigItem>

          <ConfigItem label="Prefix Layout">
            {config.prefix_layout ?? "-"}
          </ConfigItem>

          <ConfigItem label="Models Count">
            {config.models_count ?? "-"}
          </ConfigItem>

          <ConfigItem label="Roles Count">
            {config.roles_count ?? "-"}
          </ConfigItem>
        </div>
      )}
    </Card>
  );
}
