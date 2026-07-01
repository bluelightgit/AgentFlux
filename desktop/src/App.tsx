import React, { useEffect } from "react";
import { useDashboardStore } from "./store/dashboard-store";
import { AppShell } from "./components/AppShell";
import { ThemeProvider } from "./components/ThemeProvider";
import { NotificationProvider } from "./components/NotificationProvider";
import { OverviewPage } from "./components/OverviewPage";
import { SessionsPage } from "./components/SessionsPage";
import { AgentsPage } from "./components/AgentsPage";
import { PreferenceRadar } from "./components/PreferenceRadar";
import { TelemetryPage } from "./components/TelemetryPage";
import { DAGPage } from "./components/DAGPage";
import { IssuesPage } from "./components/IssuesPage";
import { GroupChatPage } from "./components/GroupChatPage";
import { ConfigPage } from "./components/ConfigPage";
import { Settings } from "./components/Settings";
import { useEventNotifications } from "./hooks/useEventNotifications";

const App: React.FC = () => {
  const currentPage = useDashboardStore((s) => s.currentPage);
  const init = useDashboardStore((s) => s.init);
  const loadWorkspaces = useDashboardStore((s) => s.loadWorkspaces);

  useEffect(() => {
    init().then(() => loadWorkspaces());
  }, []); // eslint-disable-line

  useEventNotifications();

  return (
    <ThemeProvider>
      <NotificationProvider>
        <AppShell>
          {currentPage === "overview" && <OverviewPage />}
          {currentPage === "sessions" && <SessionsPage />}
          {currentPage === "agents" && <AgentsPage />}
          {currentPage === "routing" && <PreferenceRadar />}
          {currentPage === "telemetry" && <TelemetryPage />}
          {currentPage === "dag" && <DAGPage />}
          {currentPage === "issues" && <IssuesPage />}
          {currentPage === "chat" && <GroupChatPage />}
          {currentPage === "config" && <ConfigPage />}
          {currentPage === "settings" && <Settings />}
        </AppShell>
      </NotificationProvider>
    </ThemeProvider>
  );
};

export default App;
