import React from "react";
import { useDashboardStore, type PageName } from "./store/dashboard-store";
import Dashboard from "./Dashboard";
import { AgentStatusPanel } from "./components/AgentStatusPanel";
import { ControlPanel } from "./components/ControlPanel";
import { Settings } from "./components/Settings";

const NAV_ITEMS: { id: PageName; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "📊" },
  { id: "agents", label: "Agents", icon: "🤖" },
  { id: "control", label: "Control", icon: "⚙️" },
  { id: "settings", label: "Settings", icon: "🔧" },
];

const Sidebar: React.FC = () => {
  const currentPage = useDashboardStore((s) => s.currentPage);
  const setPage = useDashboardStore((s) => s.setPage);
  const project = useDashboardStore((s) => s.project);
  const agentStatus = useDashboardStore((s) => s.agentStatus);

  const activeCount = agentStatus
    ? [...agentStatus.persistentAgents, ...agentStatus.blackboardAgents].filter(
        (a) => a.status === "running",
      ).length
    : 0;

  return (
    <aside className="w-64 bg-slate-900 text-slate-200 min-h-screen flex flex-col">
      <div className="px-6 py-6 text-xl font-bold border-b border-slate-700">
        AgentFlux
      </div>

      <nav className="flex-1 px-4 py-4 space-y-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setPage(item.id)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              currentPage === item.id
                ? "bg-slate-800 text-white"
                : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
            }`}
          >
            <span className="text-lg">{item.icon}</span>
            <span>{item.label}</span>
            {item.id === "agents" && activeCount > 0 && (
              <span className="ml-auto bg-blue-500 text-white text-xs px-2 py-0.5 rounded-full">
                {activeCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Project info */}
      {project && (
        <div className="px-4 py-4 border-t border-slate-700 text-xs">
          <div className="text-slate-500 mb-1">Project</div>
          <div className="font-medium text-slate-300 truncate">{project.projectName}</div>
        </div>
      )}
    </aside>
  );
};

const App: React.FC = () => {
  const currentPage = useDashboardStore((s) => s.currentPage);

  return (
    <div className="flex min-h-screen bg-slate-100">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">
        {currentPage === "dashboard" && <Dashboard />}
        {currentPage === "agents" && <AgentStatusPanel />}
        {currentPage === "control" && <ControlPanel />}
        {currentPage === "settings" && <Settings />}
      </main>
    </div>
  );
};

export default App;
