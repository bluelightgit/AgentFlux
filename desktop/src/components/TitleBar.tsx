import React, { useState, useEffect } from 'react';
import { Icon } from './ui';

// ---------------------------------------------------------------------------
// Platform-aware window controls that merge INTO the existing TopBar.
// - macOS: render an 80px drag region on the left (for traffic lights).
// - Windows/Linux: render minimize / maximize / close buttons on the RIGHT.
// ---------------------------------------------------------------------------

const TitleBar: React.FC = () => {
  const [isMac, setIsMac] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.api?.platform) return;
    setIsMac(window.api.platform === 'darwin');
  }, []);

  const refreshMaximized = async () => {
    try {
      if (typeof window === 'undefined' || !window.api?.isMaximized) return;
      const m = await window.api.isMaximized();
      setMaximized(Boolean(m));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    refreshMaximized();
    // Listen for window state changes (focus/resize) to update maximize icon.
    const onFocus = () => refreshMaximized();
    const onResize = () => refreshMaximized();
    window.addEventListener('focus', onFocus);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const handleMinimize = async () => {
    if (typeof window === 'undefined' || !window.api?.minimizeWindow) return;
    await window.api.minimizeWindow();
  };

  const handleMaximize = async () => {
    if (typeof window === 'undefined' || !window.api?.maximizeWindow) return;
    setMaximized(await window.api.maximizeWindow());
  };

  const handleClose = async () => {
    if (typeof window === 'undefined' || !window.api?.closeWindow) return;
    await window.api.closeWindow();
  };

  // macOS: the native traffic lights live on the left; reserve a drag region.
  if (isMac) {
    return (
      <div
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        className="w-20 h-full shrink-0"
        aria-hidden="true"
      />
    );
  }

  // Windows/Linux: render minimize / maximize / close buttons on the right.
  return (
    <div
      className="af-window-controls flex shrink-0 items-stretch self-stretch"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={() => void handleMinimize()}
        aria-label="Minimize window"
        title="Minimize"
        className="af-window-button text-slate-500 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700"
      >
        <span className="block h-px w-3 bg-current" />
      </button>
      <button
        type="button"
        onClick={() => void handleMaximize()}
        aria-label="Toggle maximize window"
        title={maximized ? 'Restore' : 'Maximize'}
        className="af-window-button text-slate-500 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700"
      >
        {maximized ? <span className="af-window-restore" /> : <span className="block h-2.5 w-2.5 border border-current" />}
      </button>
      <button
        type="button"
        onClick={() => void handleClose()}
        aria-label="Close window"
        title="Close"
        className="af-window-button text-slate-500 hover:bg-red-500 hover:text-white dark:text-slate-300"
      >
        <Icon name="X" size={16} />
      </button>
    </div>
  );
};

export default TitleBar;
