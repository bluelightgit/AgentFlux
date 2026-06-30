import React, { useState, useEffect } from 'react';
import { useDashboardStore, type PageName } from '../store/dashboard-store';
import { Icon, StatusDot } from './ui';
import { useTheme } from './ThemeProvider';
import { useKeyboardNav } from '../hooks/useKeyboardNav';
import { useCommandPalette } from '../hooks/useCommandPalette';
import { CommandPalette } from './CommandPalette';

// ---------------------------------------------------------------------------
// Navigation items (per design spec §2.2 / §3)
// ---------------------------------------------------------------------------
const NAV_ITEMS: { id: PageName; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'LayoutDashboard' },
  { id: 'sessions', label: 'Sessions', icon: 'MessageSquare' },
  { id: 'agents', label: 'Agents', icon: 'Users' },
  { id: 'routing', label: 'Routing', icon: 'Route' },
  { id: 'telemetry', label: 'Telemetry', icon: 'Activity' },
  { id: 'dag', label: 'DAG', icon: 'Workflow' },
  { id: 'config', label: 'Config', icon: 'Settings2' },
  { id: 'settings', label: 'Settings', icon: 'Settings' },
];

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------
const TopBar: React.FC = () => {
  const workspaces = useDashboardStore((s) => s.workspaces);
  const activeWorkspace = useDashboardStore((s) => s.activeWorkspace);
  const selectWorkspace = useDashboardStore((s) => s.selectWorkspace);
  const addWorkspacePath = useDashboardStore((s) => s.addWorkspacePath);
  const removeWorkspaceById = useDashboardStore((s) => s.removeWorkspaceById);
  const reload = useDashboardStore((s) => s.reload);
  const { theme, toggleTheme } = useTheme();
  const { toggle: togglePalette } = useCommandPalette();

  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Close dropdown on outside click / escape
  useEffect(() => {
    if (!dropdownOpen) return;
    const onDown = () => setDropdownOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [dropdownOpen]);

  const handleAddWorkspace = async () => {
    setDropdownOpen(false);
    try {
      if (typeof window === 'undefined' || !window.api?.showFolderDialog) return;
      const path = await window.api.showFolderDialog();
      if (path) {
        await addWorkspacePath(path);
      }
    } catch (e) {
      console.error('Failed to open folder dialog:', e);
    }
  };

  const handleSelect = (id: string) => {
    setDropdownOpen(false);
    selectWorkspace(id);
  };

  const currentName = activeWorkspace?.name ?? 'Select Workspace';

  return (
    <header className="h-14 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center px-4 gap-4">
      {/* Left: Workspace selector */}
      <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setDropdownOpen((v) => !v)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm text-slate-700"
        >
          <Icon name="FolderOpen" size={18} className="text-slate-500" />
          <span className="font-medium truncate max-w-[180px]">{currentName}</span>
          <Icon name="ChevronDown" size={16} className="text-slate-400" />
        </button>

        {dropdownOpen && (
          <div className="absolute left-0 top-full mt-1 w-64 bg-white border border-slate-200 rounded-lg shadow-lg z-50 overflow-hidden">
            <ul className="max-h-72 overflow-auto py-1">
              {workspaces.length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-400">No workspaces</li>
              )}
              {workspaces.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(w.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 ${
                      activeWorkspace?.id === w.id
                        ? 'text-blue-600 font-medium'
                        : 'text-slate-700'
                    }`}
                  >
                    <Icon name="FolderOpen" size={16} className="text-slate-400 shrink-0" />
                    <span className="flex-1 min-w-0 text-left">
                      <span className="block truncate">{w.name}</span>
                      <span className="block text-xs text-slate-400 truncate">{w.path}</span>
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Remove workspace ${w.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeWorkspaceById(w.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation();
                          removeWorkspaceById(w.id);
                        }
                      }}
                      className="shrink-0 p-1 rounded text-slate-400 hover:text-red-500 hover:bg-slate-100 cursor-pointer"
                    >
                      <Icon name="X" size={14} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t border-slate-200">
              <button
                type="button"
                onClick={handleAddWorkspace}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-blue-600 hover:bg-slate-50"
              >
                <Icon name="Plus" size={16} />
                <span>Add Workspace</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Center: App title */}
      <div className="flex-1 text-center text-lg font-bold text-slate-800">
        AgentFlux
      </div>

      {/* Right: Live indicator, Command palette, Theme toggle, Refresh */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5" title="Live updates active">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-xs text-green-600">Live</span>
        </div>

        <button
          type="button"
          onClick={togglePalette}
          aria-label="Command palette"
          title="Command palette (Cmd+K)"
          className="flex items-center px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
        >
          <Icon name="Search" size={18} />
          <span className="text-xs text-slate-400 ml-2">Cmd+K</span>
        </button>

        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          title="Toggle theme"
          className="flex items-center px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm text-slate-600"
        >
          <Icon name={theme === 'dark' ? 'Sun' : 'Moon'} size={18} className="text-slate-500" />
        </button>

        <button
          type="button"
          onClick={() => reload()}
          aria-label="Refresh"
          title="Refresh"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm text-slate-600"
        >
          <Icon name="RefreshCw" size={16} className="text-slate-500" />
          <span>Refresh</span>
        </button>
      </div>
    </header>
  );
};

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
const Sidebar: React.FC = () => {
  const currentPage = useDashboardStore((s) => s.currentPage);
  const setPage = useDashboardStore((s) => s.setPage);
  const project = useDashboardStore((s) => s.project);
  const agentStatus = useDashboardStore((s) => s.agentStatus);

  const activeCount = agentStatus
    ? [...agentStatus.persistentAgents, ...agentStatus.blackboardAgents].filter(
        (a) => a.status === 'running',
      ).length
    : 0;

  return (
    <aside className="w-60 bg-slate-900 dark:bg-black text-slate-200 dark:text-slate-300 min-h-screen flex flex-col">
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = currentPage === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setPage(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-slate-800 dark:bg-slate-700 text-white'
                  : 'text-slate-400 dark:text-slate-500 hover:bg-slate-800/50 dark:hover:bg-slate-800/50 hover:text-slate-200'
              }`}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.id === 'agents' && activeCount > 0 && (
                <span className="ml-auto bg-blue-500 text-white text-xs px-2 py-0.5 rounded-full">
                  {activeCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {project && (
        <div className="px-4 py-4 border-t border-slate-700 text-xs">
          <div className="text-slate-500 mb-1 flex items-center gap-1.5">
            <StatusDot status="running" />
            <span>Workspace</span>
          </div>
          <div className="font-medium text-slate-300 truncate">
            {project.projectName}
          </div>
        </div>
      )}
    </aside>
  );
};

// ---------------------------------------------------------------------------
// MainContent
// ---------------------------------------------------------------------------
const MainContent: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <main className="flex-1 p-8 overflow-auto bg-slate-100 dark:bg-slate-900">{children}</main>
);

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------
export function AppShell({ children }: { children: React.ReactNode }) {
  const currentPage = useDashboardStore((s) => s.currentPage);
  const setPage = useDashboardStore((s) => s.setPage);
  const { open: paletteOpen, close: closePalette } = useCommandPalette();
  useKeyboardNav(currentPage, setPage);

  return (
    <div className="flex flex-col min-h-screen">
      <TopBar />
      <div className="flex flex-1">
        <Sidebar />
        <MainContent>{children}</MainContent>
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}

export default AppShell;
