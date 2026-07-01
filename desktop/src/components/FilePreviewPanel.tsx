import React, { useEffect, useState } from 'react';
import { Card, Icon, EmptyState, DataTable, type DataTableColumn } from './ui';
import { formatBytes, formatTs } from '../lib/format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface FilePreviewPanelProps {
  path: string;
  onClose: () => void;
}

type FileKind = 'code' | 'json' | 'markdown' | 'csv' | 'image' | 'text';

interface LoadResult {
  content: string;
  size: number;
  dataUrl?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Basename of a path (cross-platform). */
function basename(p: string): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Lowercased extension including the dot, e.g. ".tsx". */
function extOf(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  if (i < 0) return '';
  return base.slice(i).toLowerCase();
}

/** Detect the logical file kind from its extension. */
function detectKind(p: string): FileKind {
  const ext = extOf(p);
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return 'code';
  if (ext === '.json') return 'json';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.csv') return 'csv';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  return 'text';
}

/** Read file content + size. Falls back to sync APIs when the async one is missing. */
async function loadFile(path: string, kind: FileKind): Promise<LoadResult> {
  const api: any = typeof window !== 'undefined' ? (window as any).api : undefined;

  // Size — prefer async getFileSize, fall back to sync fileSize.
  let size = 0;
  try {
    if (api?.getFileSize) {
      size = (await api.getFileSize(path)) ?? 0;
    } else if (api?.fileSize) {
      size = api.fileSize(path) ?? 0;
    }
  } catch {
    size = 0;
  }

  // Images: try a base64 reader; build a data URL.
  if (kind === 'image') {
    const ext = extOf(path).slice(1) || 'png';
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    let b64: string | undefined;
    try {
      b64 = api?.readFileBase64 ? await api.readFileBase64(path) : undefined;
    } catch {
      b64 = undefined;
    }
    if (!b64) {
      throw new Error('Unable to read image as base64');
    }
    return { content: '', size, dataUrl: `data:${mime};base64,${b64}` };
  }

  // Text-like: prefer the required async readFileContent, fall back to sync readFile.
  let content = '';
  try {
    if (api?.readFileContent) {
      content = (await api.readFileContent(path)) ?? '';
    } else if (api?.readFile) {
      content = api.readFile(path) ?? '';
    }
  } catch (err) {
    throw err instanceof Error ? err : new Error('Failed to read file');
  }

  if (!content) {
    throw new Error('File is empty or could not be read');
  }
  return { content, size };
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

/** Code / plain text view: monospace <pre> with overflow. */
function CodeView({ content }: { content: string }): React.ReactElement {
  return (
    <pre className="overflow-auto m-0 p-4 font-mono text-sm leading-relaxed text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-900 rounded-lg whitespace-pre">
      {content}
    </pre>
  );
}

/** A single JSON value rendered with collapsible details/summary. */
function JsonNode({ value, name }: { value: unknown; name?: string }): React.ReactElement {
  const label = name !== undefined ? (
    <span className="text-slate-500 dark:text-slate-400">{JSON.stringify(name)}: </span>
  ) : null;

  if (value === null) {
    return (
      <div className="pl-4">
        {label}
        <span className="text-red-600 dark:text-red-400">null</span>
      </div>
    );
  }

  const type = typeof value;
  if (type === 'boolean') {
    return (
      <div className="pl-4">
        {label}
        <span className="text-purple-600 dark:text-purple-400">{String(value)}</span>
      </div>
    );
  }
  if (type === 'number') {
    return (
      <div className="pl-4">
        {label}
        <span className="text-blue-600 dark:text-blue-400">{String(value)}</span>
      </div>
    );
  }
  if (type === 'string') {
    return (
      <div className="pl-4 break-all">
        {label}
        <span className="text-green-600 dark:text-green-400">{JSON.stringify(value)}</span>
      </div>
    );
  }

  const arr = Array.isArray(value);
  const entries: [string, unknown][] = arr
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);

  if (entries.length === 0) {
    return (
      <div className="pl-4">
        {label}
        <span className="text-slate-400 dark:text-slate-500">{arr ? '[]' : '{}'}</span>
      </div>
    );
  }

  return (
    <details open className="pl-4 group">
      <summary className="cursor-pointer select-none text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
        {label}
        <span className="text-slate-400 dark:text-slate-500">
          {arr ? '[' : '{'} {entries.length} {arr ? 'items' : 'keys'} {arr ? ']' : '}'}
        </span>
      </summary>
      <div className="border-l border-slate-200 dark:border-slate-700 ml-1">
        {entries.map(([k, v]) => (
          <JsonNode key={k} name={k} value={v} />
        ))}
      </div>
    </details>
  );
}

function JsonView({ content }: { content: string }): React.ReactElement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Fall back to raw code view if it isn't valid JSON.
    return <CodeView content={content} />;
  }
  return (
    <div className="overflow-auto p-4 font-mono text-sm text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-900 rounded-lg">
      <JsonNode value={parsed} />
    </div>
  );
}

/** Minimal markdown: heading sizing by # count, paragraphs otherwise. */
function MarkdownView({ content }: { content: string }): React.ReactElement {
  const lines = content.split(/\r?\n/);
  const blocks: React.ReactElement[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length > 0) {
      blocks.push(
        <p key={`p-${blocks.length}`} className="my-2 leading-relaxed text-slate-700 dark:text-slate-300">
          {para.join(' ')}
        </p>,
      );
      para = [];
    }
  };

  for (const raw of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (m) {
      flush();
      const level = m[1].length;
      const sizes = [
        'text-3xl',
        'text-2xl',
        'text-xl',
        'text-lg',
        'text-base',
        'text-sm',
      ];
      const cls = sizes[Math.min(level - 1, sizes.length - 1)];
      blocks.push(
        <div key={`h-${blocks.length}`} className={`mt-4 mb-2 font-bold text-slate-800 dark:text-slate-100 ${cls}`}>
          {m[2]}
        </div>,
      );
      continue;
    }
    if (raw.trim() === '') {
      flush();
      continue;
    }
    para.push(raw.trim());
  }
  flush();

  return (
    <div className="overflow-auto p-4 text-sm bg-white dark:bg-slate-800 rounded-lg text-slate-700 dark:text-slate-300">
      {blocks}
    </div>
  );
}

/** CSV view: parse header + rows into a DataTable. */
function CsvView({ content }: { content: string }): React.ReactElement {
  const rows = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (rows.length === 0) {
    return (
      <div className="p-4 text-sm text-slate-500 dark:text-slate-400">Empty CSV</div>
    );
  }
  const splitLine = (l: string): string[] => l.split(',').map((c) => c.trim());
  const header = splitLine(rows[0]);
  const columns: DataTableColumn[] = header.map((h, i) => ({
    key: `c${i}`,
    label: h || `Col ${i + 1}`,
  }));
  const dataRows: Record<string, string>[] = rows.slice(1).map((line) => {
    const cells = splitLine(line);
    const row: Record<string, string> = {};
    columns.forEach((col, i) => {
      row[col.key] = cells[i] ?? '';
    });
    return row;
  });
  return (
    <div className="overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <DataTable columns={columns} rows={dataRows} />
    </div>
  );
}

function ImageView({ dataUrl, name }: { dataUrl: string; name: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-900 rounded-lg overflow-auto">
      <img
        src={dataUrl}
        alt={name}
        className="max-w-full max-h-full object-contain rounded"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function FilePreviewPanel({
  path,
  onClose,
}: FilePreviewPanelProps): React.ReactElement {
  const name = basename(path);
  const kind = detectKind(path);

  const [result, setResult] = useState<LoadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openedAt] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    loadFile(path, kind)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to read file');
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <Card className="flex flex-col h-full p-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        <div className="flex items-center gap-2 min-w-0">
          <Icon
            name="File"
            size={18}
            className="text-slate-400 dark:text-slate-500 shrink-0"
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
              {name || path}
            </div>
            <div className="truncate text-xs text-slate-400 dark:text-slate-500">
              {path}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {result ? (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {formatBytes(result.size)}
            </span>
          ) : null}
          <span className="text-xs text-slate-300 dark:text-slate-600" title="Preview opened at">
            {formatTs(openedAt)}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <Icon name="X" size={18} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto p-4 bg-slate-50 dark:bg-slate-900/30">
        {error ? (
          <EmptyState icon="AlertTriangle" message={`Could not preview file: ${error}`} />
        ) : !result ? (
          <EmptyState icon="Loader2" message="Loading file..." />
        ) : kind === 'code' || kind === 'text' ? (
          <CodeView content={result.content} />
        ) : kind === 'json' ? (
          <JsonView content={result.content} />
        ) : kind === 'markdown' ? (
          <MarkdownView content={result.content} />
        ) : kind === 'csv' ? (
          <CsvView content={result.content} />
        ) : kind === 'image' ? (
          result.dataUrl ? (
            <ImageView dataUrl={result.dataUrl} name={name} />
          ) : (
            <EmptyState icon="AlertTriangle" message="Image data unavailable" />
          )
        ) : (
          // Defensive default: detectKind always returns a handled kind,
          // so this branch is unreachable. Kept to satisfy exhaustiveness.
          <EmptyState icon="Info" message="Unsupported file type" />
        )}
      </div>
    </Card>
  );
}

export default FilePreviewPanel;
