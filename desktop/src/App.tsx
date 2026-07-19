import React, { useEffect, useState } from "react";
import { useDashboardStore } from "./store/dashboard-store";
import { AppShell } from "./components/AppShell";
import { ThemeProvider } from "./components/ThemeProvider";
import { NotificationProvider } from "./components/NotificationProvider";
import { AgentsPage } from "./components/AgentsPage";
import { TelemetryPage } from "./components/TelemetryPage";
import { IssuesPage } from "./components/IssuesPage";
import { ConfigPage } from "./components/ConfigPage";
import { HelpOverlay } from "./components/HelpOverlay";
import { useEventNotifications } from "./hooks/useEventNotifications";
import { WorkbenchPage } from "./components/WorkbenchPage";

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
        {currentPage === "workbench" && <WorkbenchPage />}
        {currentPage === "agents" && <AgentsPage />}
        {currentPage === "issues" && <IssuesPage />}
        {currentPage === "activity" && <TelemetryPage />}
        {currentPage === "config" && <ConfigPage />}
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
