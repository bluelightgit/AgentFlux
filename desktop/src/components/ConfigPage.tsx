/**
 * Config Page — edit AgentFlux configuration files
 * Tabs: agentflux.json, models.json, Agent Roles (.md files)
 */
import React, { useState, useEffect } from "react";
import { JsonEditor, Icon, Card } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";

type ActiveTab = "agentflux" | "models" | "roles";

interface RoleFile {
  name: string;
  content: string;
}

const TABS: { id: ActiveTab; label: string; icon: string }[] = [
  { id: "agentflux", label: "agentflux.json", icon: "Settings2" },
  { id: "models", label: "models.json", icon: "Cpu" },
  { id: "roles", label: "Agent Roles", icon: "Users" },
];

export const ConfigPage: React.FC = () => {
  const project = useDashboardStore((s) => s.project);
  const fluxDir = project?.fluxDir ?? "";

  const [activeTab, setActiveTab] = useState<ActiveTab>("agentflux");

  // agentflux.json / models.json state
  const [agentfluxValue, setAgentfluxValue] = useState("");
  const [agentfluxError, setAgentfluxError] = useState<string | null>(null);
  const [agentfluxSaved, setAgentfluxSaved] = useState(false);
  const [agentfluxLoading, setAgentfluxLoading] = useState(true);

  const [modelsValue, setModelsValue] = useState("");
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsSaved, setModelsSaved] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(true);

  // roles state
  const [roleFiles, setRoleFiles] = useState<RoleFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [rolesSaved, setRolesSaved] = useState(false);
  const [rolesLoading, setRolesLoading] = useState(true);

  // ── Load agentflux.json ──
  useEffect(() => {
    if (!fluxDir) {
      setAgentfluxLoading(false);
      setAgentfluxError("No project configured");
      return;
    }
    const path = `${fluxDir}/agentflux.json`;
    setAgentfluxLoading(true);
    setAgentfluxError(null);
    setAgentfluxSaved(false);
    try {
      const content = window.api?.readFile ? window.api.readFile(path) : "";
      setAgentfluxValue(content ?? "");
    } catch (err: any) {
      setAgentfluxError(err?.message ?? "Failed to load agentflux.json");
    } finally {
      setAgentfluxLoading(false);
    }
  }, [fluxDir]);

  // ── Load models.json ──
  useEffect(() => {
    if (!fluxDir) {
      setModelsLoading(false);
      setModelsError("No project configured");
      return;
    }
    const path = `${fluxDir}/models.json`;
    setModelsLoading(true);
    setModelsError(null);
    setModelsSaved(false);
    try {
      const content = window.api?.readFile ? window.api.readFile(path) : "";
      setModelsValue(content ?? "");
    } catch (err: any) {
      setModelsError(err?.message ?? "Failed to load models.json");
    } finally {
      setModelsLoading(false);
    }
  }, [fluxDir]);

  // ── Load agent roles ──
  useEffect(() => {
    if (!fluxDir) {
      setRolesLoading(false);
      setRolesError("No project configured");
      return;
    }
    const dir = `${fluxDir}/agents`;
    setRolesLoading(true);
    setRolesError(null);
    setRolesSaved(false);
    (async () => {
      try {
        if (!window.api?.readDirectoryFiles) {
          setRolesError("Electron API not available");
          return;
        }
        const files: RoleFile[] = await window.api.readDirectoryFiles(dir);
        const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
        setRoleFiles(sorted);
        if (sorted.length > 0 && !selectedFile) {
          setSelectedFile(sorted[0].name);
          setFileContent(sorted[0].content ?? "");
        } else if (selectedFile) {
          const match = sorted.find((f) => f.name === selectedFile);
          setFileContent(match?.content ?? "");
        }
      } catch (err: any) {
        setRolesError(err?.message ?? "Failed to load agent roles");
        setRoleFiles([]);
      } finally {
        setRolesLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fluxDir]);

  // ── Save agentflux.json ──
  const saveAgentflux = async () => {
    if (!fluxDir) {
      setAgentfluxError("No project configured");
      return;
    }
    const path = `${fluxDir}/agentflux.json`;
    setAgentfluxError(null);
    setAgentfluxSaved(false);
    try {
      if (!window.api?.ipcRenderer) {
        setAgentfluxError("Electron API not available");
        return;
      }
      await window.api.ipcRenderer.invoke("write-file", path, agentfluxValue);
      setAgentfluxSaved(true);
      setTimeout(() => setAgentfluxSaved(false), 3000);
    } catch (err: any) {
      setAgentfluxError(err?.message ?? "Failed to save agentflux.json");
    }
  };

  // ── Save models.json ──
  const saveModels = async () => {
    if (!fluxDir) {
      setModelsError("No project configured");
      return;
    }
    const path = `${fluxDir}/models.json`;
    setModelsError(null);
    setModelsSaved(false);
    try {
      if (!window.api?.ipcRenderer) {
        setModelsError("Electron API not available");
        return;
      }
      await window.api.ipcRenderer.invoke("write-file", path, modelsValue);
      setModelsSaved(true);
      setTimeout(() => setModelsSaved(false), 3000);
    } catch (err: any) {
      setModelsError(err?.message ?? "Failed to save models.json");
    }
  };

  // ── Save selected role file ──
  const saveRoleFile = async () => {
    if (!fluxDir || !selectedFile) {
      setRolesError("No file selected");
      return;
    }
    const path = `${fluxDir}/agents/${selectedFile}`;
    setRolesError(null);
    setRolesSaved(false);
    try {
      if (!window.api?.ipcRenderer) {
        setRolesError("Electron API not available");
        return;
      }
      await window.api.ipcRenderer.invoke("write-file", path, fileContent);
      // update local cache
      setRoleFiles((prev) =>
        prev.map((f) => (f.name === selectedFile ? { ...f, content: fileContent } : f)),
      );
      setRolesSaved(true);
      setTimeout(() => setRolesSaved(false), 3000);
    } catch (err: any) {
      setRolesError(err?.message ?? "Failed to save role file");
    }
  };

  const selectRole = (name: string) => {
    setSelectedFile(name);
    setRolesSaved(false);
    const match = roleFiles.find((f) => f.name === name);
    setFileContent(match?.content ?? "");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Config</h1>
        <p className="text-sm text-slate-500 mt-1">
          Edit AgentFlux configuration files. Changes are written back to the project directory.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-200">
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                active
                  ? "bg-white border-blue-500 text-blue-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              <Icon name={tab.icon} size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "agentflux" && (
        <Card>
          <h3 className="text-lg font-semibold text-slate-700 mb-1">agentflux.json</h3>
          <p className="text-xs text-slate-500 mb-4 font-mono">
            {fluxDir ? `${fluxDir}/agentflux.json` : "No project configured"}
          </p>
          {agentfluxLoading ? (
            <div className="text-sm text-slate-400 py-8 text-center">Loading...</div>
          ) : (
            <>
              {agentfluxError && (
                <div className="mb-3 rounded-lg p-3 text-sm bg-red-50 text-red-700 border border-red-200">
                  {agentfluxError}
                </div>
              )}
              {agentfluxSaved && (
                <div className="mb-3 rounded-lg p-3 text-sm bg-green-50 text-green-700 border border-green-200">
                  Saved agentflux.json
                </div>
              )}
              <JsonEditor
                value={agentfluxValue}
                onChange={setAgentfluxValue}
                onSave={saveAgentflux}
              />
            </>
          )}
        </Card>
      )}

      {activeTab === "models" && (
        <Card>
          <h3 className="text-lg font-semibold text-slate-700 mb-1">models.json</h3>
          <p className="text-xs text-slate-500 mb-4 font-mono">
            {fluxDir ? `${fluxDir}/models.json` : "No project configured"}
          </p>
          {modelsLoading ? (
            <div className="text-sm text-slate-400 py-8 text-center">Loading...</div>
          ) : (
            <>
              {modelsError && (
                <div className="mb-3 rounded-lg p-3 text-sm bg-red-50 text-red-700 border border-red-200">
                  {modelsError}
                </div>
              )}
              {modelsSaved && (
                <div className="mb-3 rounded-lg p-3 text-sm bg-green-50 text-green-700 border border-green-200">
                  Saved models.json
                </div>
              )}
              <JsonEditor
                value={modelsValue}
                onChange={setModelsValue}
                onSave={saveModels}
              />
            </>
          )}
        </Card>
      )}

      {activeTab === "roles" && (
        <Card>
          <h3 className="text-lg font-semibold text-slate-700 mb-1">Agent Roles</h3>
          <p className="text-xs text-slate-500 mb-4 font-mono">
            {fluxDir ? `${fluxDir}/agents` : "No project configured"}
          </p>

          {rolesLoading ? (
            <div className="text-sm text-slate-400 py-8 text-center">Loading...</div>
          ) : rolesError ? (
            <div className="rounded-lg p-3 text-sm bg-red-50 text-red-700 border border-red-200">
              {rolesError}
            </div>
          ) : roleFiles.length === 0 ? (
            <div className="text-sm text-slate-400 py-8 text-center">
              No agent role files found in <code className="font-mono">{fluxDir}/agents</code>.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* File list */}
              <div className="lg:col-span-1 border border-slate-200 rounded-lg overflow-hidden">
                <div className="bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500 border-b border-slate-200">
                  Role Files ({roleFiles.length})
                </div>
                <ul className="max-h-96 overflow-y-auto divide-y divide-slate-100">
                  {roleFiles.map((f) => {
                    const active = selectedFile === f.name;
                    return (
                      <li key={f.name}>
                        <button
                          type="button"
                          onClick={() => selectRole(f.name)}
                          className={`w-full text-left px-3 py-2 text-sm font-mono transition-colors ${
                            active
                              ? "bg-blue-50 text-blue-700"
                              : "text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          {f.name}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* Editor */}
              <div className="lg:col-span-2 flex flex-col gap-3">
                {rolesSaved && (
                  <div className="rounded-lg p-3 text-sm bg-green-50 text-green-700 border border-green-200">
                    Saved {selectedFile}
                  </div>
                )}
                {selectedFile ? (
                  <>
                    <div className="text-sm font-medium text-slate-700 font-mono">
                      {selectedFile}
                    </div>
                    <textarea
                      value={fileContent}
                      onChange={(e) => {
                        setFileContent(e.target.value);
                        setRolesSaved(false);
                      }}
                      spellCheck={false}
                      className="w-full h-80 font-mono text-sm rounded-lg border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <div>
                      <button
                        type="button"
                        onClick={saveRoleFile}
                        className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-blue-700"
                      >
                        Save
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-slate-400 py-8 text-center">
                    Select a role file to edit.
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};
