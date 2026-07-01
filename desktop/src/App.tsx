import React, { useEffect, useState } from "react";
import { useDashboardStore } from "./store/dashboard-store";
import { AppShell } from "./components/AppShell";
import { ThemeProvider } from "./components/ThemeProvider";
import { NotificationProvider } from "./components/NotificationProvider";
import { OverviewPage } from "./components/OverviewPage";
import { SessionsPage } from "./components/SessionsPage";
import { AgentsPage } from "./components/AgentsPage";
import { PreferenceRadar } from "./components/PreferenceRadar";
import { RoutingHistoryChart } from "./components/RoutingHistoryChart";
import { RoutingFlowDiagram } from "./components/RoutingFlowDiagram";
import { AgentAffinityPanel } from "./components/AgentAffinityPanel";
import { TelemetryPage } from "./components/TelemetryPage";
import { DAGPage } from "./components/DAGPage";
import { IssuesPage } from "./components/IssuesPage";
import { GroupChatPage } from "./components/GroupChatPage";
import { ConfigPage } from "./components/ConfigPage";
import { Settings } from "./components/Settings";
import { HelpOverlay } from "./components/HelpOverlay";
import { useEventNotifications } from "./hooks/useEventNotifications";

const AppInner: React.FC = () => {
  const currentPage = useDashboardStore((s) => s.currentPage);
  const init = useDashboardStore((s) => s.init);
  const loadWorkspaces = useDashboardStore((s) => s.loadWorkspaces);

  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    init().then(() => loadWorkspaces());
  }, []); // eslint-disable-line

  useEventNotifications();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '?' && !['INPUT','TEXTAREA','SELECT'].includes((e.target as HTMLElement)?.tagName)) {
        setShowHelp(true);
      }
      if (e.key === 'Escape') setShowHelp(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <>
      <AppShell>
        {currentPage === "overview" && <OverviewPage />}
        {currentPage === "sessions" && <SessionsPage />}
        {currentPage === "agents" && <AgentsPage />}
        {currentPage === "routing" && (
          <div className="space-y-4">
            <PreferenceRadar />
            <RoutingHistoryChart />
            <RoutingFlowDiagram />
            <AgentAffinityPanel />
          </div>
        )}
        {currentPage === "telemetry" && <TelemetryPage />}
        {currentPage === "dag" && <DAGPage />}
        {currentPage === "issues" && <IssuesPage />}
        {currentPage === "chat" && <GroupChatPage />}
        {currentPage === "config" && <ConfigPage />}
        {currentPage === "settings" && <Settings />}
      </AppShell>
      {showHelp && <HelpOverlay isOpen={showHelp} onClose={() => setShowHelp(false)} />}
    </>
  );
};

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <NotificationProvider>
        <AppInner />
      </NotificationProvider>
    </ThemeProvider>
  );
};

export default App;
