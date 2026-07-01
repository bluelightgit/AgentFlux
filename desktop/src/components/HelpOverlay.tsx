import { Card, Icon } from './ui';

interface ShortcutRow {
  keys: string;
  description: string;
}

const SHORTCUTS: ShortcutRow[] = [
  { keys: '1-9', description: 'Navigate to page' },
  { keys: 'Alt + ←/→', description: 'Previous/Next page' },
  { keys: 'Cmd/Ctrl + K', description: 'Command palette' },
  { keys: 'Esc', description: 'Close overlay/palette' },
  { keys: '?', description: 'Toggle this help (if implemented)' },
];

const TIPS: string[] = [
  'Click an agent in the Agents page to see details',
  'Use the Chat page to view agent conversations',
  'Set a budget in Overview to track spending',
  'Use Quick Actions to control routing mode',
];

export function HelpOverlay(props: { isOpen: boolean; onClose: () => void }) {
  const { isOpen, onClose } = props;
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
      <Card className="w-96 max-w-md p-6 relative">
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"
          aria-label="Close help"
        >
          <Icon name="X" size={18} />
        </button>

        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <Icon name="Keyboard" size={20} className="text-slate-600 dark:text-slate-300" />
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">
            Keyboard Shortcuts
          </h2>
        </div>

        {/* Shortcuts list */}
        <ul className="space-y-2">
          {SHORTCUTS.map((row) => (
            <li key={row.keys} className="flex items-center gap-3">
              <span className="inline-block px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-sm font-mono text-slate-700 dark:text-slate-200 whitespace-nowrap">
                {row.keys}
              </span>
              <span className="text-sm text-slate-600 dark:text-slate-300">
                {row.description}
              </span>
            </li>
          ))}
        </ul>

        {/* Divider */}
        <hr className="my-4 border-slate-200 dark:border-slate-700" />

        {/* Tips */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 mb-2">
            Tips
          </h3>
          <ul className="space-y-1 text-sm text-slate-500 dark:text-slate-400">
            {TIPS.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      </Card>
    </div>
  );
}

export default HelpOverlay;
