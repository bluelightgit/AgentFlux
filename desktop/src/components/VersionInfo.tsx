import { useEffect, useState } from "react";
import { Card, Icon, Badge } from "./ui";
import { formatTs } from "../lib/format";
import { readFileContent } from "../lib/file-access";
import { useDashboardStore } from "../store/dashboard-store";

/**
 * VersionInfo
 *
 * Static information panel: current git branch, last commit, commit time,
 * and hardcoded desktop/AgentFlux version labels.
 *
 * Data is read from the project's `.git/HEAD` and `.git/logs/HEAD` plain
 * text files via the Electron preload bridge (`readFileContent`). Loaded
 * once on mount — no polling.
 *
 * NOTE: The dashboard store exposes the project root as `project.projectRoot`
 * (the task spec referenced `project.path`; that field does not exist on
 * `ProjectConfig`, so `projectRoot` is used instead).
 */
export function VersionInfo(): React.ReactElement {
  const projectRoot = useDashboardStore((s) => s.project?.projectRoot ?? "");

  const [branch, setBranch] = useState<string>("");
  const [lastCommit, setLastCommit] = useState<string>("");
  const [commitHash, setCommitHash] = useState<string>("");
  const [commitTime, setCommitTime] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (!projectRoot) {
      setLoading(false);
      setError("Not a git repository");
      return;
    }

    (async () => {
      try {
        const headText = await readFileContent(`${projectRoot}/.git/HEAD`);
        if (cancelled) return;
        if (!headText) {
          if (!cancelled) {
            setError("Not a git repository");
            setLoading(false);
          }
          return;
        }

        // Branch from HEAD: "ref: refs/heads/<branch>" or detached HEAD sha.
        const refMatch = headText.match(/ref:\s*refs\/heads\/(.+)/);
        if (refMatch) {
          setBranch(refMatch[1].trim());
        } else {
          setBranch(headText.trim().slice(0, 12) || "detached");
        }

        // Last commit from .git/logs/HEAD — final non-empty line.
        const logsText = await readFileContent(`${projectRoot}/.git/logs/HEAD`);
        if (cancelled) return;
        if (logsText) {
          const lines = logsText.split(/\r?\n/).filter((l) => l.trim().length > 0);
          const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
          if (lastLine) {
            // Format:
            // <old> <new> <Name> <email> <unix-secs> <tz>\t<message>
            const [meta, ...msgParts] = lastLine.split("\t");
            const message = msgParts.join("\t").trim();
            const metaParts = meta.trim().split(/\s+/);
            const newHash = metaParts.length > 1 ? metaParts[1] : "";
            const tsRaw = metaParts.length > 5 ? metaParts[4] : "";
            const ts = tsRaw ? Number(tsRaw) * 1000 : 0;
            setCommitHash(newHash);
            setLastCommit(message);
            setCommitTime(ts);
          }
        }

        if (!cancelled) setLoading(false);
      } catch {
        if (!cancelled) {
          setError("Not a git repository");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  const shortHash = commitHash ? commitHash.slice(0, 7) : "";
  const truncatedCommit =
    lastCommit.length > 50 ? lastCommit.slice(0, 50) + "..." : lastCommit;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Icon name="GitBranch" size={18} className="text-slate-400 dark:text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Version Info</h3>
      </div>

      {loading ? (
        <div className="text-xs text-slate-400 dark:text-slate-500">Loading...</div>
      ) : error ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">{error}</div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400 dark:text-slate-500">Branch</span>
            <Badge color="green">{branch || "unknown"}</Badge>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-400 dark:text-slate-500">Last Commit</span>
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate max-w-[60%]">
              {shortHash ? `${shortHash} ` : ""}
              {truncatedCommit || "-"}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400 dark:text-slate-500">Commit Time</span>
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {formatTs(commitTime)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400 dark:text-slate-500">Desktop Version</span>
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">v2.1</span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400 dark:text-slate-500">AgentFlux Version</span>
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Phase 4</span>
          </div>
        </div>
      )}
    </Card>
  );
}

export default VersionInfo;
