/**
 * D2-1/D2-2: Preference Radar — 5-dim preference vector with sliders + persistence
 * Adjusts the 5-dimensional routing preference vector and writes to agentflux.json.
 */
import React, { useState, useEffect } from "react";
import { Icon } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";

const DIMENSIONS = [
  { key: "cost_sensitivity", label: "Cost", icon: "DollarSign", desc: "Lower cost = higher priority" },
  { key: "accuracy_priority", label: "Accuracy", icon: "Target", desc: "Quality over speed" },
  { key: "latency_priority", label: "Latency", icon: "Zap", desc: "Faster response" },
  { key: "parallelism_willingness", label: "Parallel", icon: "Split", desc: "Parallel execution" },
  { key: "multi_agent_willingness", label: "Multi-Agent", icon: "Bot", desc: "Multiple agents" },
] as const;

const PRESET_PROFILES: Record<string, Record<string, number>> = {
  eco: { cost_sensitivity: 0.9, accuracy_priority: 0.4, latency_priority: 0.3, parallelism_willingness: 0.3, multi_agent_willingness: 0.2 },
  balanced: { cost_sensitivity: 0.7, accuracy_priority: 0.6, latency_priority: 0.4, parallelism_willingness: 0.6, multi_agent_willingness: 0.7 },
  fast: { cost_sensitivity: 0.3, accuracy_priority: 0.5, latency_priority: 0.9, parallelism_willingness: 0.8, multi_agent_willingness: 0.5 },
  accurate: { cost_sensitivity: 0.3, accuracy_priority: 0.95, latency_priority: 0.2, parallelism_willingness: 0.7, multi_agent_willingness: 0.9 },
};

// Mode prediction (simplified version of route() scoring)
const MODE_SCORES: Record<string, Record<string, number>> = {
  M1: { cost_sensitivity: 1.0, accuracy_priority: 0.4, latency_priority: 0.5, parallelism_willingness: 0.2, multi_agent_willingness: 0.1 },
  M2: { cost_sensitivity: 0.7, accuracy_priority: 0.6, latency_priority: 0.6, parallelism_willingness: 0.5, multi_agent_willingness: 0.4 },
  M3: { cost_sensitivity: 0.6, accuracy_priority: 0.7, latency_priority: 0.8, parallelism_willingness: 0.4, multi_agent_willingness: 0.2 },
  M4: { cost_sensitivity: 0.3, accuracy_priority: 0.8, latency_priority: 0.9, parallelism_willingness: 1.0, multi_agent_willingness: 1.0 },
  M5: { cost_sensitivity: 0.5, accuracy_priority: 0.6, latency_priority: 0.7, parallelism_willingness: 0.6, multi_agent_willingness: 0.5 },
  M6: { cost_sensitivity: 0.2, accuracy_priority: 0.95, latency_priority: 0.85, parallelism_willingness: 1.0, multi_agent_willingness: 1.0 },
};

function predictMode(vector: Record<string, number>): { mode: string; confidence: number } {
  let best = "M1";
  let bestScore = -Infinity;
  let secondScore = -Infinity;

  for (const [mode, weights] of Object.entries(MODE_SCORES)) {
    let score = 0;
    for (const dim of DIMENSIONS) {
      score += vector[dim.key] * weights[dim.key];
    }
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = mode;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  const confidence = bestScore > 0 ? 1 - (secondScore / bestScore) : 0;
  return { mode: best, confidence: Math.min(0.95, Math.max(0.3, confidence * 3)) };
}

export const PreferenceRadar: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const refreshAgentStatus = useDashboardStore((s) => s.refreshAgentStatus);

  const [vector, setVector] = useState<Record<string, number>>(PRESET_PROFILES.balanced);
  const [profile, setProfile] = useState("balanced");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Try to load current preference from agentflux.json
  useEffect(() => {
    const loadPreference = async () => {
      if (!project?.fluxDir) return;
      try {
        if (typeof window !== "undefined" && window.api?.ipcRenderer) {
          const content = await window.api.ipcRenderer.invoke("read-file", `${project.fluxDir}/agentflux.json`);
          const config = JSON.parse(content);
          if (config.preference?.vector) {
            setVector({ ...PRESET_PROFILES.balanced, ...config.preference.vector });
            setProfile(config.preference.profile ?? "custom");
          }
        }
      } catch {
        // File might not exist yet
      }
    };
    loadPreference();
  }, [project?.fluxDir]);

  const prediction = predictMode(vector);

  const handleSlider = (key: string, value: number) => {
    setVector((prev) => ({ ...prev, [key]: value }));
    setProfile("custom");
  };

  const handlePreset = (preset: string) => {
    setVector(PRESET_PROFILES[preset]);
    setProfile(preset);
  };

  const handleSave = async () => {
    if (!project?.fluxDir) {
      setMessage({ type: "error", text: "No project configured" });
      return;
    }
    try {
      if (typeof window !== "undefined" && window.api?.ipcRenderer) {
        // Read existing config first
        let config: any = {};
        try {
          const content = await window.api.ipcRenderer.invoke("read-file", `${project.fluxDir}/agentflux.json`);
          config = JSON.parse(content);
        } catch { /* file might not exist */ }

        config.preference = {
          profile,
          vector,
          scenarios: config.preference?.scenarios ?? {},
          escalate_hint: config.preference?.escalate_hint ?? "suggest",
        };

        await window.api.ipcRenderer.invoke("write-file", `${project.fluxDir}/agentflux.json`, JSON.stringify(config, null, 2));
        setMessage({ type: "success", text: `Preference saved (profile: ${profile}). Takes effect on next pi session or /flux restart.` });
        setTimeout(() => refreshAgentStatus(), 500);
      } else {
        setMessage({ type: "error", text: "Requires Electron environment" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Preference Radar</h1>
        <p className="text-sm text-slate-500 mt-1">
          Adjust the 5-dimensional routing preference vector. The predicted mode updates in real-time.
        </p>
      </div>

      {message && (
        <div className={`rounded-lg p-4 text-sm ${
          message.type === "success" ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
        }`}>
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Radar chart visualization */}
        <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
          <h3 className="text-lg font-semibold text-slate-700 mb-4">Preference Vector</h3>

          {/* SVG Radar */}
          <div className="flex justify-center mb-4">
            <svg width="240" height="240" viewBox="0 0 240 240">
              {/* Grid pentagons */}
              {[0.2, 0.4, 0.6, 0.8, 1.0].map((scale, i) => {
                const points = DIMENSIONS.map((_, j) => {
                  const angle = (j / 5) * Math.PI * 2 - Math.PI / 2;
                  const x = 120 + Math.cos(angle) * 90 * scale;
                  const y = 120 + Math.sin(angle) * 90 * scale;
                  return `${x},${y}`;
                }).join(" ");
                return (
                  <polygon
                    key={i}
                    points={points}
                    fill="none"
                    stroke="#e2e8f0"
                    strokeWidth="1"
                  />
                );
              })}

              {/* Axes */}
              {DIMENSIONS.map((dim, i) => {
                const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
                const x = 120 + Math.cos(angle) * 90;
                const y = 120 + Math.sin(angle) * 90;
                return (
                  <line key={dim.key} x1="120" y1="120" x2={x} y2={y} stroke="#e2e8f0" strokeWidth="1" />
                );
              })}

              {/* Data polygon */}
              <polygon
                points={DIMENSIONS.map((dim, i) => {
                  const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
                  const val = vector[dim.key] ?? 0.5;
                  const x = 120 + Math.cos(angle) * 90 * val;
                  const y = 120 + Math.sin(angle) * 90 * val;
                  return `${x},${y}`;
                }).join(" ")}
                fill="rgba(59, 130, 246, 0.2)"
                stroke="#3b82f6"
                strokeWidth="2"
              />

              {/* Data points */}
              {DIMENSIONS.map((dim, i) => {
                const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
                const val = vector[dim.key] ?? 0.5;
                const x = 120 + Math.cos(angle) * 90 * val;
                const y = 120 + Math.sin(angle) * 90 * val;
                return <circle key={dim.key} cx={x} cy={y} r="4" fill="#3b82f6" />;
              })}

              {/* Labels */}
              {DIMENSIONS.map((dim, i) => {
                const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
                const x = 120 + Math.cos(angle) * 110;
                const y = 120 + Math.sin(angle) * 110;
                return (
                  <text
                    key={dim.key}
                    x={x}
                    y={y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="text-xs fill-slate-600"
                  >
                    {dim.label}
                  </text>
                );
              })}
            </svg>
          </div>

          {/* Mode prediction */}
          <div className="bg-slate-50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-500">Predicted Mode</div>
              <div className="text-2xl font-bold text-blue-600">{prediction.mode}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Confidence</div>
              <div className="text-2xl font-bold text-slate-700">{(prediction.confidence * 100).toFixed(0)}%</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Profile</div>
              <div className="text-sm font-medium text-slate-600">{profile}</div>
            </div>
          </div>
        </div>

        {/* Sliders + presets */}
        <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
          <h3 className="text-lg font-semibold text-slate-700 mb-4">Dimensions</h3>

          {/* Preset buttons */}
          <div className="flex gap-2 mb-6">
            {Object.keys(PRESET_PROFILES).map((p) => (
              <button
                key={p}
                onClick={() => handlePreset(p)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors capitalize ${
                  profile === p
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-200 text-slate-600 hover:border-slate-300"
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Sliders */}
          <div className="space-y-4">
            {DIMENSIONS.map((dim) => (
              <div key={dim.key}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-slate-700">
                    <Icon name={dim.icon} size={16} className="inline mr-1" /> {dim.label}
                  </span>
                  <span className="text-sm font-mono text-slate-500">
                    {vector[dim.key]?.toFixed(2) ?? "0.50"}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={vector[dim.key] ?? 0.5}
                  onChange={(e) => handleSlider(dim.key, parseFloat(e.target.value))}
                  className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <div className="text-xs text-slate-400 mt-0.5">{dim.desc}</div>
              </div>
            ))}
          </div>

          {/* Save button */}
          <button
            onClick={handleSave}
            className="mt-6 w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Save to agentflux.json
          </button>
        </div>
      </div>
    </div>
  );
};
