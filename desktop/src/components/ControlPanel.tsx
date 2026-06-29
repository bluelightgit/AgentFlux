/**
 * D2-2: Control Panel — 路由偏好覆盖
 * 通过写入 .agentflux/runtime/override.json 控制 pi 的路由
 */
import React, { useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { readFileContent, pathExists } from "../lib/file-access";

const PRESETS = [
  { value: "eco", label: "Eco (M1)", desc: "Single agent, minimal cost" },
  { value: "balanced", label: "Balanced (M2)", desc: "Serial subagent, balanced" },
  { value: "fast", label: "Fast (M3)", desc: "Fork exploration, parallel" },
  { value: "accurate", label: "Accurate (M6)", desc: "Heterogeneous team, best quality" },
];

const FORCE_MODES = ["M1", "M2", "M3", "M4", "M5", "M6"];

export const ControlPanel: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const refreshAgentStatus = useDashboardStore((s) => s.refreshAgentStatus);

  const [preset, setPreset] = useState("");
  const [forceMode, setForceMode] = useState("");
  const [ephemeral, setEphemeral] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const fluxDir = project?.fluxDir ?? "";

  const writeOverride = async (override: Record<string, any>) => {
    if (!fluxDir) {
      setMessage({ type: "error", text: "No project configured" });
      return;
    }
    try {
      // 通过 IPC 写入文件
      if (typeof window !== "undefined" && window.api?.ipcRenderer) {
        await window.api.ipcRenderer.invoke("write-file", `${fluxDir}/runtime/override.json`, JSON.stringify(override, null, 2));
      } else {
        setMessage({ type: "error", text: "File writing requires Electron environment" });
        return;
      }
      setMessage({ type: "success", text: `Override written: ${JSON.stringify(override)}` });
      setTimeout(() => refreshAgentStatus(), 500);
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    }
  };

  const handleApplyPreset = () => {
    if (!preset) {
      setMessage({ type: "error", text: "Select a preset first" });
      return;
    }
    writeOverride({ preset, ephemeral });
  };

  const handleForceMode = () => {
    if (!forceMode) {
      setMessage({ type: "error", text: "Select a mode first" });
      return;
    }
    writeOverride({ forceMode, ephemeral });
  };

  const handleClearOverride = async () => {
    if (!fluxDir) return;
    try {
      if (typeof window !== "undefined" && window.api?.ipcRenderer) {
        await window.api.ipcRenderer.invoke("delete-file", `${fluxDir}/runtime/override.json`);
        setMessage({ type: "success", text: "Override cleared" });
        setTimeout(() => refreshAgentStatus(), 500);
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Control Panel</h1>
        <p className="text-sm text-slate-500 mt-1">
          Override routing decisions in real-time. Changes take effect on the next pi turn.
        </p>
      </div>

      {message && (
        <div className={`rounded-lg p-4 text-sm ${
          message.type === "success" ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
        }`}>
          {message.text}
        </div>
      )}

      {/* Preset Override */}
      <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-700 mb-2">Preset Override</h3>
        <p className="text-sm text-slate-500 mb-4">
          Override the routing preset. This triggers a router re-evaluation on the next turn.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPreset(p.value)}
              className={`text-left p-3 rounded-lg border transition-colors ${
                preset === p.value
                  ? "border-blue-500 bg-blue-50"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <div className="font-medium text-slate-700">{p.label}</div>
              <div className="text-xs text-slate-500 mt-1">{p.desc}</div>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={ephemeral}
              onChange={(e) => setEphemeral(e.target.checked)}
              className="rounded"
            />
            Ephemeral (apply once, then auto-delete)
          </label>
          <button
            onClick={handleApplyPreset}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Apply Preset
          </button>
        </div>
      </div>

      {/* Force Mode */}
      <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-700 mb-2">Force Mode</h3>
        <p className="text-sm text-slate-500 mb-4">
          Directly force a specific work mode, bypassing the router entirely.
        </p>
        <div className="flex flex-wrap gap-2 mb-4">
          {FORCE_MODES.map((m) => (
            <button
              key={m}
              onClick={() => setForceMode(m)}
              className={`px-4 py-2 rounded-lg text-sm font-mono font-medium border transition-colors ${
                forceMode === m
                  ? "border-purple-500 bg-purple-50 text-purple-700"
                  : "border-slate-200 text-slate-600 hover:border-slate-300"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={handleForceMode}
          className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
        >
          Force Mode
        </button>
      </div>

      {/* Clear Override */}
      <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-700 mb-2">Clear Override</h3>
        <p className="text-sm text-slate-500 mb-4">
          Remove any active override, returning to normal routing behavior.
        </p>
        <button
          onClick={handleClearOverride}
          className="px-4 py-2 bg-slate-600 text-white rounded-lg text-sm font-medium hover:bg-slate-700 transition-colors"
        >
          Clear All Overrides
        </button>
      </div>

      {/* Info */}
      <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
        <h4 className="text-sm font-semibold text-slate-600 mb-2">How it works</h4>
        <ul className="text-xs text-slate-500 space-y-1 list-disc list-inside">
          <li>Override is written to <code className="text-slate-700">.agentflux/runtime/override.json</code></li>
          <li>pi checks this file at every <code className="text-slate-700">turn_end</code> event</li>
          <li>Ephemeral overrides are deleted after being read once</li>
          <li>Preset override triggers router re-evaluation; Force mode bypasses router entirely</li>
          <li>The AgentFlux extension must be loaded in pi for this to work</li>
        </ul>
      </div>
    </div>
  );
};
