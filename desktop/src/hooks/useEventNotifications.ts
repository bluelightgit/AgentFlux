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
import {
  advanceRunNotificationCursor,
  groupRunNotifications,
  type RunNotificationCursor,
} from "../lib/run-notifications";

const POLL_INTERVAL_MS = 3000;

export function useEventNotifications(): void {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? null);
  const { notify } = useNotifications();

  // Number of subagent.run events we have already notified about.
  const cursor = useRef<RunNotificationCursor>({ initialized: false, count: 0 });

  useEffect(() => {
    if (!fluxDir) return;

    cursor.current = { initialized: false, count: 0 };

    const eventsPath = `${fluxDir}/events.jsonl`;

    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const events = await parseEventsFileAsync(eventsPath);
        const runs = events.filter(
          (e): e is SubagentRunEvent => e.type === "subagent.run",
        );

        const advanced = advanceRunNotificationCursor(runs, cursor.current);
        cursor.current = advanced.cursor;

        for (const batch of groupRunNotifications(advanced.freshRuns)) {
          notify(batch.kind, batch.title, batch.detail, batch.key, batch.count);
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
