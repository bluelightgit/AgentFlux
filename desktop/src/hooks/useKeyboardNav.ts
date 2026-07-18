import { useEffect, useCallback } from 'react';
import type { PageName } from '../store/dashboard-store';

const PAGE_ORDER: PageName[] = ['workbench', 'agents', 'chat', 'telemetry', 'sessions', 'dag', 'routing', 'config'];
const PAGE_KEYS: Record<string, PageName> = {
  '1': 'workbench', '2': 'agents', '3': 'chat', '4': 'telemetry',
  '5': 'sessions', '6': 'dag', '7': 'routing', '8': 'config',
};

export function useKeyboardNav(currentPage: PageName, setPage: (p: PageName) => void) {
  const goNext = useCallback(() => {
    const idx = PAGE_ORDER.indexOf(currentPage);
    setPage(PAGE_ORDER[(idx + 1) % PAGE_ORDER.length]);
  }, [currentPage, setPage]);

  const goPrev = useCallback(() => {
    const idx = PAGE_ORDER.indexOf(currentPage);
    setPage(PAGE_ORDER[(idx - 1 + PAGE_ORDER.length) % PAGE_ORDER.length]);
  }, [currentPage, setPage]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Number keys 1-8 for direct page navigation
      if (PAGE_KEYS[e.key]) { e.preventDefault(); setPage(PAGE_KEYS[e.key]); return; }
      // Arrow left/right for sequential nav
      if (e.key === 'ArrowRight' && e.altKey) { e.preventDefault(); goNext(); return; }
      if (e.key === 'ArrowLeft' && e.altKey) { e.preventDefault(); goPrev(); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setPage, goNext, goPrev]);

  return { goNext, goPrev };
}
