/**
 * Watches events.jsonl for new subagent.run events and surfaces
 * notifications when an agent fails (exitCode !== 0 / errorMessage)
 * or completes successfully.
 *
 * Uses the same polling pattern as useLiveUpdate: poll the file every
 * 3s, track how many subagent.run events we have already seen, and
 * notify only for newly observed ones.
 */

import { useEffect, useRef } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { useNotifications } from "../components/NotificationProvider";
import { parseEventsFileAsync, type SubagentRunEvent } from "../lib/events-parser";

const POLL_INTERVAL_MS = 3000;

export function useEventNotifications(): void {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);
  const { notify } = useNotifications();

  // Number of subagent.run events we have already notified about.
  const lastSeenEventCount = useRef(0);

  useEffect(() => {
    if (!fluxDir) return;

    const eventsPath = `${fluxDir}/events.jsonl`;

    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const events = await parseEventsFileAsync(eventsPath);
        const runs = events.filter(
          (e): e is SubagentRunEvent => e.type === "subagent.run",
        );

        const prevCount = lastSeenEventCount.current;
        // Only look at events appended since our last check.
        const newRuns = runs.slice(prevCount);
        lastSeenEventCount.current = runs.length;

        for (const run of newRuns) {
          // errorMessage is not part of the typed event shape today,
          // but some agents may include it — read it defensively.
          const errorMessage = (run as unknown as { errorMessage?: string })
            .errorMessage;

          if (run.exitCode !== 0 || errorMessage) {
            const detail = errorMessage
              ? errorMessage
              : `exit code ${run.exitCode}`;
            notify("error", `${run.agent} failed`, detail);
          } else {
            notify(
              "success",
              `${run.agent} completed`,
              `Completed in ${run.turns} turns ($${run.costUsd.toFixed(4)})`,
            );
          }
        }
      } catch {
        // File may not exist yet or be mid-write; ignore and retry next tick.
      }
    };

    // Initial check, then poll on the configured interval.
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fluxDir, notify]);
}

export default useEventNotifications;
