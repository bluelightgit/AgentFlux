/**
 * Settings — 项目配置页面
 */
import React, { useEffect, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { useTheme } from "./ThemeProvider";
import { Card, Icon, Badge, EmptyState } from "./ui";
import { formatCost } from "../lib/format";
import { readFileContent } from "../lib/file-access";
import { VersionInfo } from "./VersionInfo";

// ---------------------------------------------------------------------------
// Types for models.json
// ---------------------------------------------------------------------------
interface ModelEntry {
  provider?: string;
  contextWindow?: number;
  pricing?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  capability?: Record<string, number>;
}

interface ModelsFile {
  models?: Record<string, ModelEntry>;
  roles?: Record<string, { model?: string; thinking?: string }>;
}

// ---------------------------------------------------------------------------
// Section header helper
// ---------------------------------------------------------------------------
function SectionHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle?: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 mb-4">
      <Icon name={icon} size={20} className="text-slate-500 dark:text-slate-400" />
      <div>
        <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-100">{title}</h3>
        {subtitle ? <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export const Settings: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const setProjectPath = useDashboardStore((s) => s.setProjectPath);
  const { theme, toggleTheme } = useTheme();

  const [pathInput, setPathInput] = useState(project?.projectRoot ?? "");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Appearance state
  const [refreshInterval, setRefreshInterval] = useState<string>("5000");

  // Models state
  const [models, setModels] = useState<ModelsFile | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // About state
  const [gitBranch, setGitBranch] = useState<string>("unknown");

  // Load persisted refresh interval
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("agentflux-refresh-interval");
      if (stored !== null) setRefreshInterval(stored);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  // Persist refresh interval on change
  const handleRefreshIntervalChange = (value: string) => {
    setRefreshInterval(value);
    try {
      window.localStorage.setItem("agentflux-refresh-interval", value);
    } catch {
      // ignore persistence failures
    }
  };

  // Theme button handlers
  const handleSetLight = () => {
    if (theme !== "light") toggleTheme();
  };
  const handleSetDark = () => {
    if (theme !== "dark") toggleTheme();
  };

  // Load models.json from fluxDir
  useEffect(() => {
    const fluxDir = project?.fluxDir;
    if (!fluxDir) {
      setModels(null);
      setModelsError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const content = await readFileContent(`${fluxDir}/models.json`);
        if (cancelled) return;
        if (!content) {
          setModels(null);
          setModelsError(null);
          return;
        }
        try {
          setModels(JSON.parse(content) as ModelsFile);
          setModelsError(null);
        } catch (err) {
          setModels(null);
          setModelsError(err instanceof Error ? err.message : "Invalid models.json");
        }
      } catch {
        if (!cancelled) {
          setModels(null);
          setModelsError(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [project?.fluxDir]);

  // Attempt to detect git branch from <projectRoot>/.git/HEAD
  useEffect(() => {
    const projectRoot = project?.projectRoot;
    if (!projectRoot) {
      setGitBranch("unknown");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const head = await readFileContent(`${projectRoot}/.git/HEAD`);
        if (cancelled) return;
        if (!head) {
          setGitBranch("unknown");
          return;
        }
        const match = head.match(/ref:\s*refs\/heads\/(.+)/);
        if (match) {
          setGitBranch(match[1].trim());
        } else {
          // Detached HEAD — short sha
          setGitBranch(head.trim().slice(0, 12) || "detached");
        }
      } catch {
        if (!cancelled) setGitBranch("unknown");
      }
    })();
    return () => { cancelled = true; };
  }, [project?.projectRoot]);

  const handleApply = async () => {
    if (!pathInput.trim()) {
      setMessage({ type: "error", text: "Path cannot be empty" });
      return;
    }
    setMessage({ type: "success", text: "Reinitializing..." });
    try {
      await setProjectPath(pathInput.trim());
      setMessage({ type: "success", text: `Project set to: ${pathInput}` });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    }
  };

  // Build models table rows
  const modelEntries = models?.models
    ? Object.entries(models.models).map(([name, m]) => ({
        name,
        provider: m.provider ?? "-",
        contextWindow: m.contextWindow ? m.contextWindow.toLocaleString() : "-",
        input: m.pricing?.input != null ? formatCost(m.pricing.input) : "-",
        output: m.pricing?.output != null ? formatCost(m.pricing.output) : "-",
      }))
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Settings</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Configure AgentFlux project path and data source.</p>
      </div>

      {message && (
        <div className={`rounded-lg p-4 text-sm ${
          message.type === "success"
            ? "bg-green-50 text-green-700 border border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700"
            : "bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700"
        }`}>
          {message.text}
        </div>
      )}

      {/* Project Path */}
      <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-700 mb-2">AgentFlux Project Root</h3>
        <p className="text-sm text-slate-500 mb-4">
          Path to the AgentFlux project directory containing <code className="text-slate-700">.agentflux/</code>.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="e.g. E:/agent-projects/AgentFlux"
            className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleApply}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors whitespace-nowrap"
          >
            Apply
          </button>
        </div>
        {project && (
          <div className="mt-4 text-xs text-slate-500 space-y-1">
            <div>Project: <span className="font-mono text-slate-700">{project.projectName}</span></div>
            <div>Events: <span className="font-mono text-slate-700">{project.eventsPath}</span></div>
            <div>Config: <span className="font-mono text-slate-700">{project.configPath}</span></div>
          </div>
        )}
      </div>

      {/* Environment Info */}
      <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-700 mb-2">Environment</h3>
        <div className="text-sm text-slate-600 space-y-2">
          <div>Platform: <span className="font-mono">{typeof window !== "undefined" ? window.api?.platform : "node"}</span></div>
          <div>Electron: <span className="font-mono">{typeof window !== "undefined" && window.api ? "yes" : "no (browser only)"}</span></div>
          <div>AGENTFLUX_PROJECT_ROOT: <span className="font-mono">{typeof process !== 'undefined' ? process.env?.AGENTFLUX_PROJECT_ROOT ?? "not set" : "not set"}</span></div>
        </div>
      </div>

      {/* Appearance */}
      <Card>
        <SectionHeader icon="Palette" title="Appearance" subtitle="Theme and refresh preferences." />
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">Theme</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSetLight}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  theme === "light"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-200 border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-600"
                }`}
              >
                <Icon name="Sun" size={16} />
                Light
              </button>
              <button
                type="button"
                onClick={handleSetDark}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  theme === "dark"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-200 border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-600"
                }`}
              >
                <Icon name="Moon" size={16} />
                Dark
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="refresh-interval" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">
              Auto-refresh interval
            </label>
            <select
              id="refresh-interval"
              value={refreshInterval}
              onChange={(e) => handleRefreshIntervalChange(e.target.value)}
              className="px-3 py-2 rounded-lg text-sm bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="2000">2s</option>
              <option value="5000">5s</option>
              <option value="10000">10s</option>
              <option value="30000">30s</option>
              <option value="0">Off</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Models */}
      <Card>
        <SectionHeader icon="Cpu" title="Models" subtitle="Models defined in .agentflux/models.json." />
        {modelsError ? (
          <div className="text-sm text-red-600 dark:text-red-400">Failed to parse models.json: {modelsError}</div>
        ) : modelEntries.length === 0 ? (
          <EmptyState icon="Cpu" message="No models configured. Create .agentflux/models.json to define models." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-slate-700 dark:text-slate-200">
              <thead>
                <tr>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2">Name</th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2">Provider</th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-right px-3 py-2">Context window</th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-right px-3 py-2">Input price</th>
                  <th className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-right px-3 py-2">Output price</th>
                </tr>
              </thead>
              <tbody>
                {modelEntries.map((row) => (
                  <tr key={row.name}>
                    <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700 font-mono">{row.name}</td>
                    <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700">{row.provider}</td>
                    <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700 text-right font-mono">{row.contextWindow}</td>
                    <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700 text-right">{row.input}</td>
                    <td className="px-3 py-2 border-t border-slate-100 dark:border-slate-700 text-right">{row.output}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Keyboard Shortcuts */}
      <Card>
        <SectionHeader icon="Keyboard" title="Keyboard Shortcuts" subtitle="Global key bindings available across the app." />
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          <li className="flex items-center justify-between py-3">
            <span className="text-sm text-slate-600 dark:text-slate-300">Navigate pages</span>
            <Badge color="slate">1-8</Badge>
          </li>
          <li className="flex items-center justify-between py-3">
            <span className="text-sm text-slate-600 dark:text-slate-300">Command Palette</span>
            <Badge color="slate">Cmd/Ctrl+K</Badge>
          </li>
          <li className="flex items-center justify-between py-3">
            <span className="text-sm text-slate-600 dark:text-slate-300">Sequential navigation</span>
            <Badge color="slate">Alt+Arrow</Badge>
          </li>
        </ul>
      </Card>

      {/* About */}
      <Card>
        <SectionHeader icon="Info" title="About" subtitle="AgentFlux Desktop build and project metadata." />
        <div className="text-sm text-slate-600 dark:text-slate-300 space-y-2">
          <div className="flex justify-between">
            <span className="text-slate-500 dark:text-slate-400">Version</span>
            <span className="font-mono">1.0.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500 dark:text-slate-400">Git branch</span>
            <span className="font-mono">{gitBranch}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500 dark:text-slate-400">Project path</span>
            <span className="font-mono break-all text-right">{project?.projectRoot ?? "not set"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500 dark:text-slate-400">Flux directory</span>
            <span className="font-mono break-all text-right">{project?.fluxDir ?? "not set"}</span>
          </div>
        </div>
      </Card>

      {/* About footer */}
      <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-4 border border-slate-200 dark:border-slate-700">
        <h4 className="text-sm font-semibold text-slate-600 dark:text-slate-300 mb-1">AgentFlux Desktop</h4>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Visualization and control plane for AgentFlux multi-agent routing.
          Data is read from events.jsonl; control is via override.json.
          pi TUI remains the execution layer.
        </p>
      </div>

      <div className="mt-4">
        <VersionInfo />
      </div>
    </div>
  );
};
