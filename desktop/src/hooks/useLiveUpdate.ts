import { useEffect, useRef, useState, useCallback } from 'react';

interface LiveUpdateState {
  lastSize: number;
  lastModified: number;
  hasNewData: boolean;
}

/**
 * Polls a file's size via IPC at regular intervals.
 * When the file grows, sets hasNewData=true.
 * The component can then call the provided refresh callback.
 */
export function useLiveUpdate(
  filePath: string | null,
  options?: { intervalMs?: number; onNewData?: () => void }
) {
  const intervalMs = options?.intervalMs ?? 2000;
  const onNewDataRef = useRef(options?.onNewData);
  onNewDataRef.current = options?.onNewData;
  const [state, setState] = useState<LiveUpdateState>({ lastSize: 0, lastModified: 0, hasNewData: false });
  const [isLive, setIsLive] = useState(false);

  const start = useCallback(() => setIsLive(true), []);
  const stop = useCallback(() => setIsLive(false), []);

  useEffect(() => {
    if (!filePath || !isLive) return;
    if (typeof window === 'undefined' || !window.api?.getFileSize) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const size = await window.api.getFileSize(filePath);
        if (cancelled) return;
        setState(prev => {
          if (size > prev.lastSize) {
            onNewDataRef.current?.();
            return { lastSize: size, lastModified: Date.now(), hasNewData: true };
          }
          return { ...prev, hasNewData: false };
        });
      } catch { /* ignore */ }
    };

    poll(); // initial check
    const timer = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [filePath, isLive, intervalMs]);

  return { ...state, isLive, start, stop };
}
