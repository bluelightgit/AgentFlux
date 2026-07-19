import React, { useState, useEffect } from 'react';
import { useDashboardStore, type PageName } from '../store/dashboard-store';
import { AppFrame, Icon, StatusDot } from './ui';
import { useTheme } from './ThemeProvider';
import { useKeyboardNav } from '../hooks/useKeyboardNav';
import { useCommandPalette } from '../hooks/useCommandPalette';

import { CommandPalette } from './CommandPalette';
import { RealTimeCostCounter } from './RealTimeCostCounter';
import TitleBar from './TitleBar';

// ---------------------------------------------------------------------------
// Navigation items (per design spec §2.2 / §3)
// ---------------------------------------------------------------------------
const NAV_GROUPS: { label: string; items: { id: PageName; label: string; icon: string; note?: string }[] }[] = [
  { label: 'WORKSPACE', items: [
    { id: 'workbench', label: 'Workbench', icon: 'Workflow' },
    { id: 'agents', label: 'Agents', icon: 'Users' },
    { id: 'issues', label: 'Issues', icon: 'CircleDot' },
    { id: 'activity', label: 'Activity', icon: 'Activity' },
    { id: 'config', label: 'Configuration', icon: 'Settings2' },
  ] },
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
  const project = useDashboardStore((s) => s.project);
  const events = useDashboardStore((s) => s.events);
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
    <header
      className="af-topbar"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left: Workspace selector */}
      <div className="relative" onMouseDown={(e) => e.stopPropagation()} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          onClick={() => setDropdownOpen((v) => !v)}
          aria-expanded={dropdownOpen}
          aria-haspopup="listbox"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm text-slate-700 dark:text-slate-300 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
        >
          <Icon name="FolderOpen" size={18} className="text-slate-500" />
          <span className="max-w-[112px] truncate font-medium sm:max-w-[180px]">{currentName}</span>
          <Icon name="ChevronDown" size={16} className="text-slate-400" />
        </button>

        {dropdownOpen && (
          <div className="absolute left-0 top-full mt-1 w-64 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 overflow-hidden">
            <ul className="max-h-72 overflow-auto py-1">
              {workspaces.length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-400">No workspaces</li>
              )}
              {workspaces.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(w.id)}
                    aria-pressed={activeWorkspace?.id === w.id}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400 ${
                      activeWorkspace?.id === w.id
                        ? 'text-blue-600 dark:text-blue-400 font-medium'
                        : 'text-slate-700 dark:text-slate-300'
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
                      className="shrink-0 p-1 rounded text-slate-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
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
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-slate-50 dark:hover:bg-slate-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
              >
                <Icon name="Plus" size={16} />
                <span>Add Workspace</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Center: App title */}
      <div className="flex-1 min-w-0 text-center">
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.16em] text-[var(--af-ink)]">AgentFlux</span>
        <span className="ml-2 hidden text-[9px] uppercase tracking-wider text-[var(--af-muted)] 2xl:inline">Multi-agent workbench</span>
      </div>

      {/* Right: Cost counter, Live indicator, Command palette, Theme toggle, Refresh */}
      <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* Live / status indicator — derived from store signals only */}
        {(() => {
          const hasEvents = project !== null && events.length > 0;

          if (hasEvents) {
            return (
              <div className="flex items-center gap-1.5" title="Viewing locally cached events." aria-label="Local data available">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                <span className="hidden xl:inline text-xs text-amber-600 dark:text-amber-400">Local data</span>
              </div>
            );
          }
          return (
            <div className="flex items-center gap-1.5" title="No project selected. No data source available." aria-label="No live data source">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              <span className="hidden xl:inline text-xs text-gray-500 dark:text-gray-400">Offline snapshot</span>
            </div>
          );
        })()}

        <div className="hidden xl:block">
          <RealTimeCostCounter />
        </div>

        <button
          type="button"
          onClick={togglePalette}
          aria-label="Command palette (Cmd+K)"
          title="Command palette (Cmd+K)"
          className="flex items-center px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
        >
          <Icon name="Search" size={18} />
          <span className="hidden xl:inline text-xs text-slate-400 ml-2">Cmd+K</span>
        </button>

        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          title="Toggle theme"
          className="flex items-center px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm text-slate-600 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
        >
          <Icon name={theme === 'dark' ? 'Sun' : 'Moon'} size={18} className="text-slate-500" />
        </button>

        <button
          type="button"
          onClick={() => reload()}
          aria-label="Refresh"
          title="Refresh"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm text-slate-600 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Icon name="RefreshCw" size={16} className="text-slate-500" />
          <span className="hidden xl:inline">Refresh</span>
        </button>
      </div>

      <TitleBar />
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
    <aside className="af-sidebar h-full overflow-y-auto flex flex-col">
      <nav className="flex-1 px-3 py-4 space-y-5">
        {NAV_GROUPS.map((group) => <section key={group.label} aria-label={group.label}>
          <h2 className="mb-1 px-3 font-mono text-[10px] font-semibold tracking-[0.18em] text-slate-600">{group.label}</h2>
          <div className="space-y-0.5">{group.items.map((item) => {
          const active = currentPage === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setPage(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2 border-l-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--af-operate)] focus-visible:ring-inset ${
                active
                  ? 'bg-slate-800 text-white border-[var(--af-operate)]'
                  : 'border-transparent text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
              }`}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.note && <span className="ml-auto font-mono text-[9px] uppercase text-slate-600">{item.note}</span>}
              {item.id === 'agents' && activeCount > 0 && (
                <span className="ml-auto bg-blue-500 dark:bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">
                  {activeCount}
                </span>
              )}
            </button>
          );
          })}</div>
        </section>)}
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
const MainContent: React.FC<{ children: React.ReactNode; compact?: boolean }> = ({ children, compact }) => (
  <main className={`af-main min-w-0 ${compact ? 'p-2' : 'p-3 lg:p-5'}`}>{children}</main>
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
    <AppFrame>
      <TopBar />
      <div className="flex flex-1 overflow-hidden min-h-0">
        <Sidebar />
        <MainContent compact={currentPage === 'workbench'}>{children}</MainContent>
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </AppFrame>
  );
}

export default AppShell;
