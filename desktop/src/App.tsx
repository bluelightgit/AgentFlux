import React, { useEffect } from "react";
import { useDashboardStore } from "./store/dashboard-store";
import { AppShell } from "./components/AppShell";
import { EmptyState } from "./components/ui";
import Dashboard from "./Dashboard";
import { SessionsPage } from "./components/SessionsPage";
import { AgentsPage } from "./components/AgentsPage";
import { PreferenceRadar } from "./components/PreferenceRadar";
import { ConfigPage } from "./components/ConfigPage";
import { Settings } from "./components/Settings";

// Placeholder for pages not yet implemented
const Placeholder: React.FC<{ page: string; icon: string }> = ({ page, icon }) => (
  <div className="flex-1 flex items-center justify-center">
    <EmptyState icon={icon} message={`${page} page — implementation pending`} />
  </div>
);

const App: React.FC = () => {
  const currentPage = useDashboardStore((s) => s.currentPage);
  const init = useDashboardStore((s) => s.init);
  const loadWorkspaces = useDashboardStore((s) => s.loadWorkspaces);

  useEffect(() => {
    init().then(() => loadWorkspaces());
  }, []); // eslint-disable-line

  return (
    <AppShell>
      {currentPage === "overview" && <Dashboard />}
      {currentPage === "sessions" && <SessionsPage />}
      {currentPage === "agents" && <AgentsPage />}
      {currentPage === "routing" && <PreferenceRadar />}
      {currentPage === "telemetry" && <Placeholder page="Telemetry" icon="Activity" />}
      {currentPage === "dag" && <Placeholder page="DAG" icon="Workflow" />}
      {currentPage === "config" && <ConfigPage />}
      {currentPage === "settings" && <Settings />}
    </AppShell>
  );
};

export default App;
