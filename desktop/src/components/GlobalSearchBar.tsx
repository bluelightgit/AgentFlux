/**
 * GlobalSearchBar: compact search bar for the TopBar.
 * Searches across agents (subagent.run events), sessions (session files),
 * and events. Debounced 300ms. Dropdown results with type Badges.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDashboardStore } from '../store/dashboard-store';
import { Icon, Badge, type BadgeColor } from './ui';
import { parseEventsFileAsync } from '../lib/events-parser';
import { formatTs, formatCost } from '../lib/format';

export interface SearchResult {
  type: 'agent' | 'session' | 'event';
  title: string;
  detail: string;
  action: () => void;
}

export function GlobalSearchBar(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? '');
  const setPage = useDashboardStore((s) => s.setPage);
  const selectSession = useDashboardStore((s) => s.selectSession);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showResults) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [showResults]);

  const runSearch = useCallback(
    async (q: string) => {
      if (!fluxDir || q.trim().length <= 2) {
        setResults([]);
        return;
      }
      const needle = q.trim().toLowerCase();
      const found: SearchResult[] = [];

      // 1. Agents & events: read events.jsonl, filter subagent.run where
      //    agent name includes query OR task includes query. Each match is
      //    surfaced twice: as an agent row (jump to agents page) and as an
      //    event row (jump to telemetry page).
      try {
        const events = await parseEventsFileAsync(`${fluxDir}/events.jsonl`);
        const subRuns = events.filter(
          (e): e is Extract<typeof e, { type: 'subagent.run' }> =>
            e.type === 'subagent.run' &&
            (e.agent.toLowerCase().includes(needle) ||
              e.task.toLowerCase().includes(needle)),
        );
        for (const e of subRuns) {
          found.push({
            type: 'agent',
            title: e.agent,
            detail: `${e.task.slice(0, 80)} - ${formatTs(e.ts)}`,
            action: () => {
              setPage('agents');
              setShowResults(false);
            },
          });
          found.push({
            type: 'event',
            title: `subagent.run - ${e.agent}`,
            detail: `${formatCost(e.costUsd)} - ${e.model} - ${formatTs(e.ts)}`,
            action: () => {
              setPage('activity');
              setShowResults(false);
            },
          });
        }
      } catch {
        // ignore — events may be unreadable
      }

      // 2. Sessions: filter session files where filename includes query
      try {
        const sessionsDir = `${fluxDir}/runtime/sessions`;
        let files: string[] = [];
        if (typeof window !== 'undefined' && window.api?.listDirectory) {
          files = await window.api.listDirectory(sessionsDir);
        }
        const matched = files
          .filter((f) => f.endsWith('.jsonl'))
          .filter((f) => f.toLowerCase().includes(needle));
        for (const f of matched) {
          found.push({
            type: 'session',
            title: f,
            detail: `${sessionsDir}/${f}`,
            action: () => {
              selectSession(f);
              setPage('activity');
              setShowResults(false);
            },
          });
        }
      } catch {
        // ignore — sessions dir may be missing
      }

      // Combine, max 10
      setResults(found.slice(0, 10));
    },
    [fluxDir, setPage, selectSession],
  );

  // Debounced search trigger
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length <= 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      runSearch(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    if (v.trim().length > 2) {
      setShowResults(true);
    } else {
      setResults([]);
      setShowResults(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setQuery('');
      setResults([]);
      setShowResults(false);
    }
  };

  const handleFocus = () => {
    if (query.trim().length > 2) setShowResults(true);
  };

  const badgeColorFor = (t: SearchResult['type']): BadgeColor =>
    t === 'agent' ? 'blue' : t === 'session' ? 'green' : 'amber';

  const badgeLabelFor = (t: SearchResult['type']): string =>
    t.charAt(0).toUpperCase() + t.slice(1);

  return (
    <div ref={containerRef} className="relative flex items-center">
      <Icon
        name="Search"
        size={16}
        className="absolute left-2.5 text-slate-400 pointer-events-none"
      />
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        placeholder="Search agents, sessions, events..."
        className="pl-9 w-64 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {showResults && query.trim().length > 2 && (
        <div className="absolute top-full mt-1 w-96 max-h-80 overflow-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50">
          {results.length === 0 ? (
            <div className="px-3 py-4 text-sm text-slate-400 dark:text-slate-500">
              No results found
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={i}
                type="button"
                onClick={r.action}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 border-b border-slate-100 dark:border-slate-700 last:border-b-0"
              >
                <Badge color={badgeColorFor(r.type)}>{badgeLabelFor(r.type)}</Badge>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                    {r.title}
                  </div>
                  <div className="text-xs text-slate-400 truncate">{r.detail}</div>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default GlobalSearchBar;
