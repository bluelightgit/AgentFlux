import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { Card, Icon } from './ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type NotificationKind = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  timestamp: number;
  read: boolean;
  key?: string;
  count: number;
}

export interface NotificationContextValue {
  notifications: Notification[];
  notify: (kind: NotificationKind, title: string, body?: string, key?: string, occurrences?: number) => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
  markAsRead: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const NotificationContext = createContext<NotificationContextValue | undefined>(
  undefined,
);

// ---------------------------------------------------------------------------
// Kind metadata
// ---------------------------------------------------------------------------
const KIND_BORDER: Record<NotificationKind, string> = {
  info: 'border-l-blue-500',
  success: 'border-l-green-500',
  warning: 'border-l-amber-500',
  error: 'border-l-red-500',
};

const KIND_ICON: Record<NotificationKind, string> = {
  info: 'Info',
  success: 'CheckCircle2',
  warning: 'AlertTriangle',
  error: 'XCircle',
};

const KIND_ICON_COLOR: Record<NotificationKind, string> = {
  info: 'text-blue-500',
  success: 'text-green-500',
  warning: 'text-amber-500',
  error: 'text-red-500',
};

const KIND_AUTO_DISMISS: Record<NotificationKind, number | null> = {
  info: 5000,
  success: 5000,
  warning: 10000,
  error: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let idCounter = 0;
function genId(): string {
  idCounter += 1;
  return `notif-${Date.now()}-${idCounter}`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export interface NotificationProviderProps {
  children: React.ReactNode;
  /** Maximum number of notifications retained in the list. */
  max?: number;
}

export function NotificationProvider({
  children,
  max = 50,
}: NotificationProviderProps): React.ReactElement {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  // Keep a ref of timers so we can clear them when a notification is dismissed
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    clearTimer(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, [clearTimer]);

  const notify = useCallback(
    (kind: NotificationKind, title: string, body?: string, key?: string, occurrences = 1) => {
      const id = genId();
      const notification: Notification = {
        id,
        kind,
        title,
        body,
        timestamp: Date.now(),
        read: false,
        key,
        count: Math.max(1, occurrences),
      };
      setNotifications((prev) => {
        const existingIndex = key ? prev.findIndex((item) => item.key === key) : -1;
        if (existingIndex >= 0) {
          const existing = prev[existingIndex];
          const updated = { ...existing, kind, title, body, timestamp: notification.timestamp, read: false, count: existing.count + notification.count };
          return [updated, ...prev.filter((_, index) => index !== existingIndex)];
        }
        const next = [notification, ...prev];
        // Trim oldest entries beyond max
        if (next.length > max) {
          const removed = next.slice(max);
          removed.forEach((n) => clearTimer(n.id));
          return next.slice(0, max);
        }
        return next;
      });

      const delay = KIND_AUTO_DISMISS[kind];
      if (delay !== null) {
        const timer = setTimeout(() => {
          dismiss(id);
        }, delay);
        timers.current.set(id, timer);
      }
    },
    [dismiss, max, clearTimer],
  );

  const clearAll = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
    setNotifications([]);
  }, []);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  }, []);

  // Cleanup all timers on unmount
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const value: NotificationContextValue = {
    notifications,
    notify,
    dismiss,
    clearAll,
    markAsRead,
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <ToastStack notifications={notifications} onDismiss={dismiss} />
    </NotificationContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Toast stack (visible only for unread/auto-dismissible recent toasts)
// ---------------------------------------------------------------------------
interface ToastStackProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
}

function ToastStack({ notifications, onDismiss }: ToastStackProps): React.ReactElement | null {
  // Show the most recent few toasts that are still unread as active toasts.
  // Once read (e.g. via NotificationCenter) they leave the toast stack.
  const visible = notifications.filter((n) => !n.read).slice(0, 3);

  if (visible.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col space-y-2 w-80">
      {visible.map((n) => (
        <Toast key={n.id} notification={n} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

interface ToastProps {
  notification: Notification;
  onDismiss: (id: string) => void;
}

function Toast({ notification, onDismiss }: ToastProps): React.ReactElement {
  const { id, kind, title, body, timestamp, count } = notification;

  return (
    <Card
      className={`animate-slide-in border-l-4 ${KIND_BORDER[kind]} p-4 pr-8 relative`}
    >
      <div className="flex items-start gap-3">
        <Icon
          name={KIND_ICON[kind]}
          size={18}
          className={`mt-0.5 shrink-0 ${KIND_ICON_COLOR[kind]}`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-800 dark:text-slate-100 break-words">
            {title}{count > 1 ? <span className="ml-2 font-mono text-[10px] text-[var(--af-muted)]">×{count}</span> : null}
          </div>
          {body ? (
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 break-words">
              {body}
            </div>
          ) : null}
          <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
            {formatTimestamp(timestamp)}
          </div>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(id)}
        className="absolute top-2 right-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
      >
        <Icon name="X" size={14} />
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return ctx;
}

export default NotificationProvider;
