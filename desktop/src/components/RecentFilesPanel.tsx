/**
 * RecentFilesPanel
 * Shows recently changed files derived from the project's git history.
 *
 * The Electron renderer cannot spawn `git` directly, so this panel reads
 * the plain-text reflog at `<projectRoot>/.git/logs/HEAD` via the preload
 * bridge (window.api.readFile). Each line records a commit; the most recent
 * entries are parsed and surfaced as "recent changes".
 *
 * NOTE: `.git/logs/HEAD` records commits (sha + message + author + time)
 * but not per-file paths. To honour the row layout (a monospace identifier
 * + commit message + relative time), the short SHA is used as the primary
 * `path` field. When a real `runCommand`/`git log --name-only` IPC handler
 * becomes available, this can be upgraded to show true file paths.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { readFileContent } from "../lib/file-access";
import { formatTs } from "../lib/format";
import { Card, Icon, EmptyState } from "./ui";

/** A single recent change row. */
interface RecentFile {
  /** Short commit SHA (monospace identifier for the row). */
  path: string;
  /** Commit message subject. */
  lastCommit: string;
  /** Author name extracted from the reflog line. */
  author: string;
  /** Commit timestamp (ms epoch). */
  ts: number;
}

/** Format a timestamp (ms epoch) as a compact relative time string. */
function formatRelative(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Parse the contents of `.git/logs/HEAD` into recent-change rows.
 *
 * Reflog line format:
 *   <old-sha> <new-sha> <author> <<email>> <unix-ts> <tz>\t<message>
 *
 * Only the most recent `limit` entries are returned, newest first.
 */
function parseGitLogHead(content: string, limit: number): RecentFile[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // `.git/logs/HEAD` is appended chronologically; reverse for newest first.
  const newest = lines.slice().reverse();
  const out: RecentFile[] = [];
  for (const line of newest) {
    if (out.length >= limit) break;
    // Split off the message (everything after the first tab).
    const tabIdx = line.indexOf("\t");
    const head = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
    const message = tabIdx >= 0 ? line.slice(tabIdx + 1).trim() : "";
    const parts = head.split(" ");
    if (parts.length < 4) continue;
    const newSha = parts[1] ?? "";
    // Author token(s) sit between the second sha and the email `<...>`.
    // Reconstruct by scanning tokens until we hit the email angle bracket.
    let i = 2;
    const authorTokens: string[] = [];
    while (i < parts.length && !parts[i].startsWith("<")) {
      authorTokens.push(parts[i]);
      i++;
    }
    // Skip the email token.
    i++;
    const tsTok = parts[i] ?? "";
    const tsSec = Number(tsTok);
    if (!isFinite(tsSec) || tsSec <= 0) continue;

    // Strip a leading "commit:" / "commit (initial):" / "checkout:" action prefix.
    const subject = message.replace(/^[a-z]+(?:\s+\([^)]+\))?:\s*/i, "").trim() || message;

    out.push({
      path: newSha.slice(0, 7),
      lastCommit: subject,
      author: authorTokens.join(" ").trim() || "unknown",
      ts: tsSec * 1000,
    });
  }
  return out;
}

/** Maximum number of rows to display. */
const MAX_ROWS = 15;
/** Poll interval (ms). */
const POLL_INTERVAL = 30_000;

export function RecentFilesPanel(): React.ReactElement {
  const projectRoot = useDashboardStore((s) => s.project?.projectRoot ?? null);
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);

  const [files, setFiles] = useState<RecentFile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!projectRoot) {
      setFiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const logPath = `${projectRoot}/.git/logs/HEAD`;
      const content = await readFileContent(logPath);
      if (!content) {
        setFiles([]);
      } else {
        setFiles(parseGitLogHead(content, MAX_ROWS));
      }
    } catch (err) {
      console.warn("[flux] recent files refresh failed:", err);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(() => {
      refresh();
    }, POLL_INTERVAL);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [refresh]);

  // fluxDir is part of the component's project context (per spec) but is not
  // required to read the git reflog. Reference it so the dependency is
  // explicit and the panel re-evaluates when the project changes.
  void fluxDir;

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon name="FileClock" size={18} className="text-slate-700 dark:text-slate-200" />
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Recent Changes
          </h3>
        </div>
        {files.length > 0 ? (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {files.length} commit{files.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {/* Body */}
      {loading && files.length === 0 ? (
        <div className="flex items-center justify-center py-10 text-sm text-slate-400 dark:text-slate-500">
          <Icon name="Loader2" size={16} className="animate-spin mr-2" />
          Loading recent changes...
        </div>
      ) : files.length === 0 ? (
        <EmptyState icon="FileClock" message="No recent changes" />
      ) : (
        <ul className="flex flex-col divide-y divide-slate-100 dark:divide-slate-700">
          {files.map((f, idx) => (
            <li
              key={`${f.path}-${idx}`}
              className="flex items-center gap-3 py-2"
              title={`${f.author} - ${formatTs(f.ts)}`}
            >
              <span className="text-sm font-mono text-slate-700 dark:text-slate-200 truncate shrink-0 w-16">
                {f.path}
              </span>
              <span className="text-xs text-slate-400 dark:text-slate-500 truncate flex-1 min-w-0">
                {f.lastCommit}
              </span>
              <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">
                {formatRelative(f.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
