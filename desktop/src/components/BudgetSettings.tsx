/**
 * D2-5: Budget Settings — 预算参数配置 + Budget Router 预览
 * 配置最大总成本、各角色成本分配比例, 并预览基于当前 models.json 的估算成本.
 */
import React, { useState, useEffect } from "react";
import { useDashboardStore } from "../store/dashboard-store";

interface RoleBudget {
  role: string;
  label: string;
  percentage: number;
  color: string;
}

const DEFAULT_ROLES: RoleBudget[] = [
  { role: "planner", label: "Planner", percentage: 25, color: "bg-blue-500" },
  { role: "implementer", label: "Implementer", percentage: 40, color: "bg-green-500" },
  { role: "reviewer", label: "Reviewer", percentage: 20, color: "bg-purple-500" },
  { role: "tester", label: "Tester", percentage: 15, color: "bg-amber-500" },
];

export const BudgetSettings: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const refreshAgentStatus = useDashboardStore((s) => s.refreshAgentStatus);

  const [maxCost, setMaxCost] = useState("1.00");
  const [roles, setRoles] = useState<RoleBudget[]>(DEFAULT_ROLES);
  const [budgetConfig, setBudgetConfig] = useState<any>(null);
  const [preview, setPreview] = useState<{ role: string; model: string; estCost: number }[] | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const fluxDir = project?.fluxDir ?? "";
  const totalPercentage = roles.reduce((s, r) => s + r.percentage, 0);

  // Load existing budget config
  useEffect(() => {
    const load = async () => {
      if (!fluxDir) return;
      try {
        if (typeof window !== "undefined" && window.api?.ipcRenderer) {
          const content = await window.api.ipcRenderer.invoke("read-file", `${fluxDir}/agentflux.json`);
          const config = JSON.parse(content);
          if (config.budget) {
            setBudgetConfig(config.budget);
            if (config.budget.maxTotalCost) setMaxCost(String(config.budget.maxTotalCost));
            if (config.budget.roleAllocation) {
              setRoles(DEFAULT_ROLES.map(r => ({
                ...r,
                percentage: config.budget.roleAllocation[r.role] ?? r.percentage,
              })));
            }
          }
        }
      } catch {}
    };
    load();
  }, [fluxDir]);

  const handleRolePercentage = (index: number, value: number) => {
    setRoles(prev => prev.map((r, i) => i === index ? { ...r, percentage: value } : r));
  };

  const handlePreview = async () => {
    const max = parseFloat(maxCost) || 0;
    const roleEstimates = roles.map(r => ({
      role: r.role,
      model: r.role === "planner" || r.role === "reviewer" ? "gpt-5.5" : "glm-5.2",
      estCost: max * (r.percentage / 100),
    }));
    setPreview(roleEstimates);
  };

  const handleSave = async () => {
    if (!fluxDir) {
      setMessage({ type: "error", text: "No project configured" });
      return;
    }
    if (Math.abs(totalPercentage - 100) > 0.1) {
      setMessage({ type: "error", text: `Role allocations must sum to 100% (currently ${totalPercentage}%)` });
      return;
    }
    try {
      if (typeof window !== "undefined" && window.api?.ipcRenderer) {
        let config: any = {};
        try {
          const content = await window.api.ipcRenderer.invoke("read-file", `${fluxDir}/agentflux.json`);
          config = JSON.parse(content);
        } catch {}

        config.budget = {
          maxTotalCost: parseFloat(maxCost) || 0,
          roleAllocation: Object.fromEntries(roles.map(r => [r.role, r.percentage])),
        };

        await window.api.ipcRenderer.invoke("write-file", `${fluxDir}/agentflux.json`, JSON.stringify(config, null, 2));
        setBudgetConfig(config.budget);
        setMessage({ type: "success", text: `Budget saved: max $${maxCost}, allocations saved to agentflux.json` });
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
        <h1 className="text-2xl font-bold text-slate-800">Budget Settings</h1>
        <p className="text-sm text-slate-500 mt-1">
          Configure max cost and per-role allocation. The Budget Router uses these constraints to select models.
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
        {/* Max Cost + Role Allocation */}
        <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
          <h3 className="text-lg font-semibold text-slate-700 mb-4">Cost Configuration</h3>

          {/* Max total cost */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Max Total Cost (per task)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-slate-500 text-lg">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={maxCost}
                onChange={(e) => setMaxCost(e.target.value)}
                className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400"
              />
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Budget Router will downgrade non-critical agents if estimated cost exceeds this limit.
            </div>
          </div>

          {/* Role allocation sliders */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">Role Cost Allocation</label>
              <span className={`text-sm font-mono ${Math.abs(totalPercentage - 100) > 0.1 ? "text-red-500" : "text-green-600"}`}>
                {totalPercentage}%
              </span>
            </div>
            {roles.map((r, i) => (
              <div key={r.role}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-slate-700">{r.label}</span>
                  <span className="text-sm font-mono text-slate-500">{r.percentage}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={r.percentage}
                  onChange={(e) => handleRolePercentage(i, parseInt(e.target.value))}
                  className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
              </div>
            ))}
          </div>

          {/* Allocation bar */}
          <div className="mt-4 h-3 rounded-lg overflow-hidden flex">
            {roles.map((r) => (
              <div
                key={r.role}
                className={r.color}
                style={{ width: `${r.percentage}%` }}
                title={`${r.label}: ${r.percentage}%`}
              />
            ))}
          </div>

          <button
            onClick={handleSave}
            className="mt-6 w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Save Budget
          </button>
        </div>

        {/* Preview */}
        <div className="bg-white rounded-lg shadow p-6 border border-slate-200">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-slate-700">Budget Preview</h3>
            <button
              onClick={handlePreview}
              className="px-3 py-1.5 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
            >
              Calculate
            </button>
          </div>

          {preview ? (
            <div className="space-y-3">
              <div className="bg-slate-50 rounded-lg p-3 mb-3">
                <div className="text-xs text-slate-500">Max Total Cost</div>
                <div className="text-xl font-bold text-slate-700">${parseFloat(maxCost).toFixed(2)}</div>
              </div>
              {preview.map((p) => (
                <div key={p.role} className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div>
                    <div className="text-sm font-medium text-slate-700 capitalize">{p.role}</div>
                    <div className="text-xs text-slate-400">model: {p.model}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-mono text-slate-700">${p.estCost.toFixed(4)}</div>
                    <div className="text-xs text-slate-400">
                      {((p.estCost / parseFloat(maxCost)) * 100).toFixed(0)}% of budget
                    </div>
                  </div>
                </div>
              ))}
              <div className="bg-blue-50 rounded-lg p-3 mt-3">
                <div className="text-xs text-blue-600">
                  Budget Router will select models within these per-role cost limits.
                  Non-critical roles (implementer, tester) will be downgraded first if over budget.
                </div>
              </div>
            </div>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-400 text-sm">
              Click "Calculate" to preview per-role cost estimates.
            </div>
          )}

          {/* Current config */}
          {budgetConfig && (
            <div className="mt-4 bg-slate-50 rounded-lg p-3">
              <div className="text-xs text-slate-500 mb-1">Current Saved Config</div>
              <pre className="text-xs font-mono text-slate-600 overflow-x-auto">
                {JSON.stringify(budgetConfig, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
