/**
 * Settings — 项目配置页面
 */
import React, { useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";

export const Settings: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const setProjectPath = useDashboardStore((s) => s.setProjectPath);

  const [pathInput, setPathInput] = useState(project?.projectRoot ?? "");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">Configure AgentFlux project path and data source.</p>
      </div>

      {message && (
        <div className={`rounded-lg p-4 text-sm ${
          message.type === "success" ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
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
          <div>AGENTFLUX_PROJECT_ROOT: <span className="font-mono">{process.env.AGENTFLUX_PROJECT_ROOT ?? "not set"}</span></div>
        </div>
      </div>

      {/* About */}
      <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
        <h4 className="text-sm font-semibold text-slate-600 mb-1">AgentFlux Desktop</h4>
        <p className="text-xs text-slate-500">
          Visualization and control plane for AgentFlux multi-agent routing.
          Data is read from events.jsonl; control is via override.json.
          pi TUI remains the execution layer.
        </p>
      </div>
    </div>
  );
};
