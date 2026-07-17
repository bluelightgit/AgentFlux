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

  const handleMinimize = () => {
    if (typeof window === 'undefined' || !window.api?.minimizeWindow) return;
    window.api.minimizeWindow();
  };

  const handleMaximize = () => {
    if (typeof window === 'undefined' || !window.api?.maximizeWindow) return;
    window.api.maximizeWindow().then(() => refreshMaximized());
  };

  const handleClose = () => {
    if (typeof window === 'undefined' || !window.api?.closeWindow) return;
    window.api.closeWindow();
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
      className="flex items-stretch shrink-0"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={handleMinimize}
        aria-label="Minimize window"
        title="Minimize"
        className="flex items-center justify-center w-12 h-full text-slate-500 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
      >
        <Icon name="Minus" size={16} />
      </button>
      <button
        type="button"
        onClick={handleMaximize}
        aria-label="Toggle maximize window"
        title={maximized ? 'Restore' : 'Maximize'}
        className="flex items-center justify-center w-12 h-full text-slate-500 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
      >
        <Icon name="Square" size={14} />
      </button>
      <button
        type="button"
        onClick={handleClose}
        aria-label="Close window"
        title="Close"
        className="flex items-center justify-center w-12 h-full text-slate-500 hover:bg-red-500 hover:text-white dark:text-slate-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
      >
        <Icon name="X" size={16} />
      </button>
    </div>
  );
};

export default TitleBar;
