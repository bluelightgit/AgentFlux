import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDashboardStore, type PageName } from '../store/dashboard-store';
import { useTheme } from './ThemeProvider';
import { Icon } from './ui';
import { SearchIndex, type SearchResult } from '../lib/SearchIndex';

// ---------------------------------------------------------------------------
// Navigation page entries (mirrors AppShell sidebar)
// ---------------------------------------------------------------------------
const PAGE_ENTRIES: { id: PageName; label: string; icon: string }[] = [
  { id: 'workbench', label: 'Control Room', icon: 'Workflow' },
  { id: 'agents', label: 'Agents', icon: 'Users' },
  { id: 'chat', label: 'Agent Channels', icon: 'MessageCircle' },
  { id: 'telemetry', label: 'Activity & Cost', icon: 'Activity' },
  { id: 'sessions', label: 'Sessions', icon: 'MessageSquare' },
  { id: 'dag', label: 'DAG Inspector', icon: 'Workflow' },
  { id: 'routing', label: 'Routing', icon: 'Route' },
  { id: 'config', label: 'Configuration', icon: 'Settings2' },
];

// ---------------------------------------------------------------------------
// CommandPalette
// ---------------------------------------------------------------------------
export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({
  open,
  onClose,
}: CommandPaletteProps): React.ReactElement | null {
  const setPage = useDashboardStore((s) => s.setPage);
  const reload = useDashboardStore((s) => s.reload);
  const addWorkspacePath = useDashboardStore((s) => s.addWorkspacePath);
  const { toggleTheme } = useTheme();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build a fresh SearchIndex per mount; pages & actions are static config.
  const searchIndex = useMemo(() => {
    const idx = new SearchIndex();
    idx.setPages(PAGE_ENTRIES);
    idx.setActions([
      { id: 'toggle-dark-mode', title: 'Toggle Dark Mode', icon: 'ArrowLeftRight', subtitle: 'Theme' },
      { id: 'refresh-data', title: 'Refresh Data', icon: 'RefreshCw', subtitle: 'Reload events' },
      { id: 'add-workspace', title: 'Add Workspace', icon: 'Plus', subtitle: 'Open folder dialog' },
    ]);
    return idx;
  }, []);

  // Reset state whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  // Autofocus the input when opened.
  useEffect(() => {
    if (open) {
      // Defer focus until after paint so the element is mounted.
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const results: SearchResult[] = useMemo(
    () => searchIndex.query(query),
    [searchIndex, query],
  );

  // Reset selection when results change.
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // Keep the selected item scrolled into view.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Execute a result's action.
  const selectResult = (result: SearchResult): void => {
    if (result.type === 'page') {
      setPage(result.id as PageName);
      onClose();
    } else if (result.type === 'action') {
      switch (result.id) {
        case 'toggle-dark-mode':
          toggleTheme();
          break;
        case 'refresh-data':
          void reload();
          break;
        case 'add-workspace':
          void (async () => {
            try {
              const api = (window as any).api;
              const path: string | undefined = await api?.showFolderDialog?.();
              if (path) await addWorkspacePath(path);
            } catch (e) {
              console.error('Failed to add workspace from command palette:', e);
            }
          })();
          break;
        default:
          break;
      }
      onClose();
    }
  };

  // Keyboard navigation within the palette.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const result = results[selectedIndex];
      if (result) selectResult(result);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  // Split results into page/action groups for header rendering.
  const pageResults = results.filter((r) => r.type === 'page');
  const actionResults = results.filter((r) => r.type === 'action');

  // Compute a flat index for a given result so keyboard selection maps
  // correctly to the rendered (grouped) order: pages first, then actions.
  const indexOf = (result: SearchResult): number => {
    if (result.type === 'page') {
      return pageResults.indexOf(result);
    }
    return pageResults.length + actionResults.indexOf(result);
  };

  const renderGroup = (
    label: string,
    items: SearchResult[],
  ): React.ReactNode => {
    if (items.length === 0) return null;
    return (
      <div>
        <div className="text-xs text-slate-400 uppercase tracking-wide px-4 py-1">
          {label}
        </div>
        {items.map((result) => {
          const idx = indexOf(result);
          const selected = idx === selectedIndex;
          return (
            <button
              key={`${result.type}-${result.id}`}
              type="button"
              data-index={idx}
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={() => selectResult(result)}
              className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                selected
                  ? 'bg-blue-50 dark:bg-slate-700 text-slate-900 dark:text-white'
                  : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50'
              }`}
            >
              <Icon name={result.icon} size={18} className="text-slate-500 dark:text-slate-400 shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block truncate">{result.title}</span>
                {result.subtitle && (
                  <span className="block text-xs text-slate-400 dark:text-slate-500 truncate">
                    {result.subtitle}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onMouseDown={(e) => {
        // Close when clicking the backdrop itself (not its children).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />

      {/* Panel */}
      <div
        className="relative bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command or search..."
          className="w-full border-b border-slate-200 dark:border-slate-700 px-4 py-3 bg-transparent text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none"
        />

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-auto py-2">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
              No results found
            </div>
          ) : (
            <>
              {renderGroup('Pages', pageResults)}
              {renderGroup('Actions', actionResults)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
