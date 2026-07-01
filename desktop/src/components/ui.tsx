import React, { useState } from 'react';
import {
  Send,
  Download,
  Stethoscope,
  Terminal,
  Rocket,
  HeartPulse,
  File,
  FileClock,
  Wallet,
  LayoutDashboard,
  MessageSquare,
  Users,
  User,
  Route,
  Activity,
  Workflow,
  Settings2,
  Settings,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
  Clock,
  RefreshCw,
  Save,
  Copy,
  Trash2,
  ArrowLeftRight,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  Search,
  FolderOpen,
  ExternalLink,
  Database,
  DollarSign,
  Coins,
  Bot,
  Cpu,
  AlertTriangle,
  Info,
  Target,
  Zap,
  Split,
  Sun,
  Moon,
  Bell,
  ClipboardList,
  MessageCircle,
  Lightbulb,
  Palette,
  Keyboard,
  GanttChart,
  BarChart3,
  Grid3x3,
  Check,
  History,
  Shrink,
  Leaf,
  Scale,
  GitBranch,
  Network,
  Loader,
  Radar,
  CalendarClock,
  TrendingUp,
  GitCompare,
  PlayCircle,
  Play,
  Pause,
  ChevronLeft,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';

export type { LucideIcon };

// Icon name → Lucide component map
const ICONS: Record<string, LucideIcon> = {
  Send,
  Download,
  Stethoscope,
  Terminal,
  Rocket,
  HeartPulse,
  File,
  FileClock,
  Wallet,
  LayoutDashboard,
  MessageSquare,
  Users,
  User,
  Route,
  Activity,
  Workflow,
  Settings2,
  Settings,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
  Clock,
  RefreshCw,
  Save,
  Copy,
  Trash2,
  ArrowLeftRight,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  Search,
  FolderOpen,
  ExternalLink,
  Database,
  DollarSign,
  Coins,
  Bot,
  Cpu,
  AlertTriangle,
  Info,
  Target,
  Zap,
  Split,
  Sun,
  Moon,
  Bell,
  ClipboardList,
  MessageCircle,
  Lightbulb,
  Palette,
  Keyboard,
  GanttChart,
  BarChart3,
  Grid3x3,
  Check,
  History,
  Shrink,
  Leaf,
  Scale,
  GitBranch,
  Network,
  Loader,
  Radar,
  CalendarClock,
  TrendingUp,
  GitCompare,
  ArrowRightLeft: ArrowLeftRight,
  PlayCircle,
  Play,
  Pause,
  ChevronLeft,
  RotateCcw,
};

// ----------------------------------------------------------------------------
// Card
// ----------------------------------------------------------------------------
export interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export function Card({ children, className }: CardProps): React.ReactElement {
  return (
    <div
      className={`bg-white dark:bg-slate-800 rounded-lg shadow border border-slate-200 dark:border-slate-700 p-6 ${className ?? ''}`}
    >
      {children}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Badge
// ----------------------------------------------------------------------------
export type BadgeColor = 'blue' | 'green' | 'red' | 'amber' | 'slate' | 'purple' | 'pink';

export interface BadgeProps {
  children: React.ReactNode;
  color?: BadgeColor;
}

const BADGE_CLASSES: Record<BadgeColor, string> = {
  blue: 'bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700',
  green: 'bg-green-50 text-green-600 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700',
  red: 'bg-red-50 text-red-600 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700',
  amber: 'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
  slate: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-700/40 dark:text-slate-300 dark:border-slate-600',
  purple: 'bg-purple-50 text-purple-600 border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-700',
  pink: 'bg-pink-50 text-pink-600 border-pink-200 dark:bg-pink-900/40 dark:text-pink-300 dark:border-pink-700',
};

export function Badge({ children, color = 'slate' }: BadgeProps): React.ReactElement {
  return (
    <span
      className={`${BADGE_CLASSES[color]} border rounded-full px-2 py-0.5 text-xs`}
    >
      {children}
    </span>
  );
}

// ----------------------------------------------------------------------------
// StatusDot
// ----------------------------------------------------------------------------
export type StatusKind = 'running' | 'done' | 'failed' | 'idle' | 'pending';

export interface StatusDotProps {
  status: StatusKind;
}

const STATUS_DOT_CLASSES: Record<StatusKind, string> = {
  running: 'bg-blue-500',
  done: 'bg-green-500',
  failed: 'bg-red-500',
  idle: 'bg-slate-400',
  pending: 'bg-amber-500',
};

export function StatusDot({ status }: StatusDotProps): React.ReactElement {
  return (
    <div
      className={`${STATUS_DOT_CLASSES[status]} rounded-full`}
      style={{ width: 8, height: 8 }}
    />
  );
}

// ----------------------------------------------------------------------------
// Icon
// ----------------------------------------------------------------------------
export interface IconProps {
  name: string;
  size?: number;
  className?: string;
}

export function Icon({
  name,
  size = 20,
  className,
}: IconProps): React.ReactElement {
  const Comp = ICONS[name] ?? Circle;
  return <Comp size={size} className={className} />;
}

// ----------------------------------------------------------------------------
// DataTable
// ----------------------------------------------------------------------------
export interface DataTableColumn {
  key: string;
  label: string;
  width?: string;
}

export interface DataTableProps {
  columns: DataTableColumn[];
  rows: Record<string, any>[];
  onRowClick?: (row: Record<string, any>) => void;
  rowClassName?: string;
}

export function DataTable({
  columns,
  rows,
  onRowClick,
  rowClassName,
}: DataTableProps): React.ReactElement {
  return (
    <table className="w-full text-sm text-slate-700 dark:text-slate-200">
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={col.key}
              className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-medium text-left px-3 py-2"
              style={col.width ? { width: col.width } : undefined}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr
            key={i}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={rowClassName}
          >
            {columns.map((col) => (
              <td key={col.key} className="px-3 py-2 border-t border-slate-100 dark:border-slate-700">
                {row[col.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ----------------------------------------------------------------------------
// JsonEditor
// ----------------------------------------------------------------------------
export interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
}

export function JsonEditor({
  value,
  onChange,
  onSave,
}: JsonEditorProps): React.ReactElement {
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    onChange(next);
    if (next.trim() === '') {
      setError(null);
      return;
    }
    try {
      JSON.parse(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={value}
        onChange={handleChange}
        spellCheck={false}
        className="w-full h-80 font-mono text-sm rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {error ? (
        <div className="text-xs text-red-600">Invalid JSON: {error}</div>
      ) : null}
      <div>
        <button
          type="button"
          onClick={onSave}
          className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
          disabled={!!error}
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// MetricCard
// ----------------------------------------------------------------------------
export interface MetricCardProps {
  icon: string;
  label: string;
  value: React.ReactNode;
  trend?: string;
}

export function MetricCard({
  icon,
  label,
  value,
  trend,
}: MetricCardProps): React.ReactElement {
  const isUp = trend?.startsWith('+');
  const isDown = trend?.startsWith('-');
  const trendClass = isUp
    ? 'text-green-600 dark:text-green-400'
    : isDown
      ? 'text-red-600 dark:text-red-400'
      : 'text-slate-500 dark:text-slate-400';

  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
        <Icon name={icon} size={18} className="text-slate-400 dark:text-slate-500" />
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-800 dark:text-slate-100">{value}</div>
      {trend ? <div className={`mt-1 text-xs ${trendClass}`}>{trend}</div> : null}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// EmptyState
// ----------------------------------------------------------------------------
export interface EmptyStateProps {
  icon: string;
  message: string;
}

export function EmptyState({
  icon,
  message,
}: EmptyStateProps): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <Icon name={icon} size={48} className="text-slate-300 dark:text-slate-600" />
      <p className="mt-3 text-sm text-slate-400 dark:text-slate-500">{message}</p>
    </div>
  );
}
