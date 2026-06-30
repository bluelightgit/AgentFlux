import React from 'react';
import { Card, Icon, Badge } from './ui';
import { useNotifications, type Notification, type NotificationKind } from './NotificationProvider';

// ---------------------------------------------------------------------------
// Kind metadata
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  if (sameDay) {
    return `${hh}:${mm}:${ss}`;
  }
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${mo}/${da} ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// NotificationCenter
// ---------------------------------------------------------------------------
export interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationCenter({
  open,
  onClose,
}: NotificationCenterProps): React.ReactElement | null {
  const { notifications, clearAll, markAsRead } = useNotifications();

  if (!open) return null;

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <>
      {/* Backdrop to capture outside clicks */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      <Card className="fixed right-4 top-14 z-50 w-96 max-h-[70vh] flex flex-col p-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <Icon name="Activity" size={16} className="text-slate-500 dark:text-slate-400" />
            <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
              Notifications
            </span>
            {unreadCount > 0 ? (
              <Badge color="red">{unreadCount}</Badge>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close notification center"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <Icon name="X" size={16} />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-slate-400 dark:text-slate-500">
              No notifications
            </div>
          ) : (
            notifications.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onClick={() => markAsRead(n.id)}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700">
          <button
            type="button"
            onClick={clearAll}
            disabled={notifications.length === 0}
            className="w-full text-sm text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Clear all
          </button>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------
interface NotificationRowProps {
  notification: Notification;
  onClick: () => void;
}

function NotificationRow({
  notification,
  onClick,
}: NotificationRowProps): React.ReactElement {
  const { kind, title, body, timestamp, read } = notification;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-start gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-700/60 hover:bg-slate-50 dark:hover:bg-slate-700/40 transition-colors"
    >
      {!read ? (
        <span className="mt-1.5 shrink-0 w-2 h-2 rounded-full bg-blue-500" />
      ) : (
        <span className="mt-1.5 shrink-0 w-2 h-2 rounded-full bg-transparent" />
      )}
      <Icon
        name={KIND_ICON[kind]}
        size={16}
        className={`mt-0.5 shrink-0 ${KIND_ICON_COLOR[kind]}`}
      />
      <div className="min-w-0 flex-1">
        <div
          className={`text-sm break-words ${
            read
              ? 'text-slate-500 dark:text-slate-400 font-normal'
              : 'text-slate-800 dark:text-slate-100 font-medium'
          }`}
        >
          {title}
        </div>
        {body ? (
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 break-words">
            {body}
          </div>
        ) : null}
        <div className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
          {formatTimestamp(timestamp)}
        </div>
      </div>
    </button>
  );
}

export default NotificationCenter;
