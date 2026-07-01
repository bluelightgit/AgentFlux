/**
 * AgentDispatchForm — form to dispatch new agent tasks from the UI.
 *
 * Renders a Card with a Role selector, a Priority selector, a task textarea,
 * and a Dispatch button. On submit:
 *   - Reads the existing task queue at `<fluxDir>/runtime/task-queue.json`
 *     (if present) via the Electron preload bridge.
 *   - Appends a new task object:
 *     `{id:'task-<ts>', role, priority, task, status:'pending',
 *     createdAt: ISO timestamp}`.
 *   - Writes the queue back through `writeFileContent`.
 *
 * Shows a green "Dispatched!" Badge for 3s on success (and clears the form),
 * or a red error Badge on failure. Dark mode throughout.
 */
import React, { useState } from "react";
import { Card, Icon, Badge } from "./ui";
import { useDashboardStore } from "../store/dashboard-store";
import { readFileContent, writeFileContent } from "../lib/file-access";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueuedTask {
  id: string;
  role: string;
  priority: string;
  task: string;
  status: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLE_OPTIONS: string[] = ["planner", "implementer", "reviewer", "tester", "designer"];
const PRIORITY_OPTIONS: string[] = ["low", "medium", "high"];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentDispatchForm(): React.ReactElement {
  const fluxDir = useDashboardStore((s) => s.project?.fluxDir ?? "");

  const [taskText, setTaskText] = useState<string>("");
  const [role, setRole] = useState<string>("implementer");
  const [priority, setPriority] = useState<string>("medium");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitted, setSubmitted] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const canDispatch = !submitting && taskText.trim().length > 0;

  /** Handle dispatch: read queue, append task, write back. */
  async function handleDispatch(): Promise<void> {
    if (!fluxDir || !canDispatch) return;

    setSubmitting(true);
    setError(null);
    setSubmitted(false);

    try {
      const queuePath = `${fluxDir}/runtime/task-queue.json`;

      // Read existing queue (if any).
      let tasks: QueuedTask[] = [];
      try {
        const existing = await readFileContent(queuePath);
        if (existing && existing.trim().length > 0) {
          const parsed = JSON.parse(existing);
          if (Array.isArray(parsed)) {
            tasks = parsed as QueuedTask[];
          }
        }
      } catch {
        // File missing or invalid JSON — start from an empty queue.
        tasks = [];
      }

      // Append the new task.
      const newTask: QueuedTask = {
        id: `task-${Date.now()}`,
        role,
        priority,
        task: taskText,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      tasks.push(newTask);

      // Write the queue back.
      await writeFileContent(queuePath, JSON.stringify(tasks, null, 2));

      // Clear the form and show success.
      setTaskText("");
      setSubmitted(true);
      setTimeout(() => setSubmitted(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dispatch task");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-3 mb-3">
        <Icon name="Rocket" size={18} className="text-slate-500 dark:text-slate-400" />
        <span className="text-base font-semibold text-slate-800 dark:text-slate-100">
          Dispatch Task
        </span>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-3">
        {/* Role selector */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {/* Priority selector */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Priority
          </label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="w-full rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        {/* Task textarea */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Task
          </label>
          <textarea
            rows={4}
            placeholder="Describe the task for the agent..."
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            className="w-full rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Actions / status */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleDispatch}
            disabled={!canDispatch}
            className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Dispatching..." : "Dispatch"}
          </button>
          {submitted ? <Badge color="green">Dispatched!</Badge> : null}
          {error ? <Badge color="red">{error}</Badge> : null}
        </div>
      </div>
    </Card>
  );
}

export default AgentDispatchForm;
