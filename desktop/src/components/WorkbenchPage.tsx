/**
 * WorkbenchPage — Agent Runtime workbench UI.
 *
 * Three areas:
 *   1. Roster — list of agent sessions (name, status, PID, model, last activity)
 *   2. Conversation — event stream filtered by type, auto-follow + scrollback
 *   3. Composer — new-run mode vs selected-run mode with contextual buttons
 *
 * Onboarding (when bridge unavailable or no workspace):
 *   - Shows explanatory text and disables controls with muted styling.
 *
 * Responsive layout via matchMedia:
 *   - < 1280px: vertical flex-col (single column)
 *   - ≥ 1280px: three-column grid (240px / 1fr / 320px)
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useDashboardStore } from "../store/dashboard-store";
import { useWorkbenchStore, type WorkbenchStreamEvent, type WorkbenchEventType } from "../store/workbench-store";
import { Icon } from "./ui";
import type { AgentSession, ModePolicy, PendingExtensionUIRequest, SessionStatus, TaskPriority } from "../lib/agent-runtime";
import { formatTime } from "../lib/format";
import { CapabilityPolicyPanel } from './CapabilityPolicyPanel';
import { aggregateExecutionFamily, buildRuntimeDiagnostics, clampColumns, type ExecutionFamilyAggregate } from '../lib/workbench-p1';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BREAKPOINT_XL = 1280;
const LAYOUT_KEY = 'agentflux.control-room.layout.v1';
const DEFAULT_COLUMNS = { left: 240, right: 320 };

function readColumns(): { left: number; right: number } {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as { left?: number; right?: number } | null;
    if (value && Number.isFinite(value.left) && Number.isFinite(value.right)) {
      return { left: Math.min(420, Math.max(190, value.left!)), right: Math.min(480, Math.max(260, value.right!)) };
    }
  } catch { /* use defaults */ }
  return DEFAULT_COLUMNS;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map session status to a color name for StatusDot / badges. */
const STATUS_COLORS: Record<SessionStatus, string> = {
  starting: "bg-blue-500",
  running: "bg-green-500",
  blocked: "bg-amber-500",
  done: "bg-slate-400",
  failed: "bg-red-500",
  aborted: "bg-red-400",
};

const STATUS_LABELS: Record<SessionStatus, string> = {
  starting: "Starting",
  running: "Running",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  aborted: "Aborted",
};

/** Map event type to display styling. */
const EVENT_STYLES: Record<WorkbenchEventType, { label: string; border: string; bg: string; text: string }> = {
  user: {
    label: "You",
    border: "border-blue-400",
    bg: "bg-blue-50 dark:bg-blue-900/20",
    text: "text-blue-700 dark:text-blue-300",
  },
  assistant: {
    label: "Assistant",
    border: "border-green-400",
    bg: "bg-green-50 dark:bg-green-900/20",
    text: "text-green-700 dark:text-green-300",
  },
  tool: {
    label: "Tool",
    border: "border-purple-400",
    bg: "bg-purple-50 dark:bg-purple-900/20",
    text: "text-purple-700 dark:text-purple-300",
  },
  system: {
    label: "System",
    border: "border-slate-400",
    bg: "bg-slate-50 dark:bg-slate-800/40",
    text: "text-slate-600 dark:text-slate-400",
  },
  error: {
    label: "Error",
    border: "border-red-400",
    bg: "bg-red-50 dark:bg-red-900/20",
    text: "text-red-700 dark:text-red-300",
  },
};

/** Determine whether we are in an onboarding state (no bridge + no workspace). */
function useOnboarding(): boolean {
  const project = useDashboardStore((s) => s.project);
  const bridgeAvailable = useWorkbenchStore((s) => s.bridgeAvailable);
  // In jsdom / non-Electron, window.agentRuntime is undefined, so
  // bridgeAvailable is false. We treat it as onboarding if *either*
  // the bridge is missing or there's no workspace selected.
  return !bridgeAvailable || !project;
}

// ---------------------------------------------------------------------------
// Responsive layout hook
// ---------------------------------------------------------------------------

function useThreeColumnLayout(): boolean {
  const [threeCol, setThreeCol] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.matchMedia(`(min-width: ${BREAKPOINT_XL}px)`).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      const mq = window.matchMedia(`(min-width: ${BREAKPOINT_XL}px)`);
      const handler = (e: MediaQueryListEvent) => setThreeCol(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    } catch {
      return;
    }
  }, []);

  return threeCol;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

function RosterItem({
  session,
  active,
  onClick,
  disabled,
}: {
  session: AgentSession;
  active: boolean;
  onClick: () => void;
  disabled: boolean;
}): React.ReactElement {
  const statusColor = STATUS_COLORS[session.status] ?? "bg-slate-400";
  const displayName = session.name && session.name !== 'default'
    ? session.name
    : `Run ${session.runId.slice(0, 8)}…`;
  const lastActivity =
    session.lastActivity > 0
      ? formatTime(session.lastActivity)
      : "-";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full border-l-2 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        disabled
          ? "opacity-40 cursor-not-allowed"
          : active
            ? "border-blue-500 bg-blue-50 dark:bg-slate-700"
            : "border-transparent hover:bg-slate-50 dark:hover:bg-slate-700/60"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusColor}`} />
        <span className="flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
          {displayName}
        </span>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          {session.historical ? "History" : STATUS_LABELS[session.status]}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-4 text-xs text-slate-400 dark:text-slate-500">
        <span className="w-full truncate text-slate-600 dark:text-slate-300" title={session.taskTitle}>{session.taskTitle || "Legacy runtime"}</span>
        <span title="Run ID">ID: {session.runId.slice(0, 8)}…</span>
        {session.pid != null && (
          <span title="PID">PID: {session.pid}</span>
        )}
        <span title="Last activity">{lastActivity}</span>
      </div>
    </button>
  );
}

function ExtensionUIRequestCard({ request }: { request: PendingExtensionUIRequest }): React.ReactElement {
  const respond = useWorkbenchStore((s) => s.respondToUiRequest);
  const loading = useWorkbenchStore((s) => s.loading);
  const [value, setValue] = useState("");
  const remainingSeconds = Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000));

  return (
    <section className="border-b border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/30" aria-live="polite">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded bg-amber-500 p-1 text-white"><Icon name="MessageSquare" size={14} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="text-sm text-amber-950 dark:text-amber-100">{request.title}</strong>
            <span className="rounded border border-amber-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:border-amber-700 dark:text-amber-300">Agent input</span>
            <span className="ml-auto text-xs tabular-nums text-amber-700 dark:text-amber-300">≤ {remainingSeconds}s</span>
          </div>
          {request.message && <p className="mt-1 text-sm text-amber-900 dark:text-amber-200">{request.message}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {request.method === 'confirm' && <>
              <button type="button" disabled={loading} onClick={() => respond(request.runId, { id: request.id, confirmed: true })} className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40">Confirm</button>
              <button type="button" disabled={loading} onClick={() => respond(request.runId, { id: request.id, confirmed: false })} className="rounded border border-amber-400 px-3 py-1 text-xs text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-40">Decline</button>
            </>}
            {request.method === 'select' && request.options?.map((option) => (
              <button key={option} type="button" disabled={loading} onClick={() => respond(request.runId, { id: request.id, value: option })} className="rounded border border-amber-400 bg-white px-3 py-1 text-xs text-amber-950 hover:border-amber-600 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-100 disabled:opacity-40">{option}</button>
            ))}
            {request.method === 'input' && <>
              <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder ?? 'Enter a response'} className="min-w-48 flex-1 rounded border border-amber-300 bg-white px-2 py-1 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-700 dark:bg-slate-900 dark:text-slate-100" />
              <button type="button" disabled={loading} onClick={() => respond(request.runId, { id: request.id, value })} className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-40">Submit</button>
            </>}
            <button type="button" disabled={loading} onClick={() => respond(request.runId, { id: request.id, cancelled: true })} className="ml-auto rounded px-2 py-1 text-xs text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40 disabled:opacity-40">Cancel</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function RosterPanel({ disabled }: { disabled: boolean }): React.ReactElement {
  const runtimes = useWorkbenchStore((s) => s.runtimes);
  const selectedRunId = useWorkbenchStore((s) => s.selectedRunId);
  const selectRuntime = useWorkbenchStore((s) => s.selectRuntime);
  const loadRuntimes = useWorkbenchStore((s) => s.loadRuntimes);
  const loading = useWorkbenchStore((s) => s.loading);

  useEffect(() => {
    if (!disabled) {
      loadRuntimes();
    }
  }, [disabled, loadRuntimes]);

  return (
    <div className="flex flex-col overflow-hidden border-r border-slate-200 dark:border-slate-700">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-700 px-3 py-2">
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
          Agent roster
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => loadRuntimes()}
            disabled={disabled}
            title="Refresh runtimes"
            className="rounded p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Icon name="RefreshCw" size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto">
        {runtimes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-sm text-slate-400 dark:text-slate-500">
            <Icon name="Bot" size={32} className="mb-2 text-slate-300 dark:text-slate-600" />
            {disabled ? (
              <span>Bridge unavailable</span>
            ) : (
              <span>No agent runs yet. Create a task to start the lead runtime.</span>
            )}
          </div>
        ) : (
          runtimes.map((s) => (
            <RosterItem
              key={s.runId}
              session={s}
              active={selectedRunId === s.runId}
              onClick={() => selectRuntime(s.runId)}
              disabled={disabled}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function ConversationEvent({ event }: { event: WorkbenchStreamEvent }): React.ReactElement {
  const style = EVENT_STYLES[event.type] ?? EVENT_STYLES.system;
  return (
    <div
      className={`rounded-r-md border-l-2 ${style.border} ${style.bg} px-3 py-2`}
    >
      <div className="flex items-baseline gap-2">
        <span className={`text-sm font-medium ${style.text}`}>{style.label}</span>
        {event.runId && (
          <span className="text-xs text-slate-400 dark:text-slate-500" title="Run ID">
            {event.runId.slice(0, 8)}…
          </span>
        )}
        <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
          {formatTime(event.timestamp)}
        </span>
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-300">
        {event.content}
      </div>
      {event.metadata && Object.keys(event.metadata).length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
            Metadata
          </summary>
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-slate-100 dark:bg-slate-900 p-2 text-xs text-slate-600 dark:text-slate-400">
            {JSON.stringify(event.metadata, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function ConversationPanel({ disabled }: { disabled: boolean }): React.ReactElement {
  const eventStream = useWorkbenchStore((s) => s.eventStream);
  const selectedRunId = useWorkbenchStore((s) => s.selectedRunId);
  const clearEventStream = useWorkbenchStore((s) => s.clearEventStream);
  const runtimes = useWorkbenchStore((s) => s.runtimes);
  const pendingRequests = runtimes
    .filter((runtime) => !selectedRunId || runtime.runId === selectedRunId)
    .flatMap((runtime) => runtime.pendingUiRequests ?? []);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollBack, setShowScrollBack] = useState(false);

  // Filter events: if a run is selected, only show events for that run.
  const filteredEvents = selectedRunId
    ? eventStream.filter((e) => !e.runId || e.runId === selectedRunId)
    : eventStream;

  // Auto-scroll to bottom when new events arrive (if user is at bottom).
  useEffect(() => {
    if (isAtBottom) {
      if (typeof bottomRef.current?.scrollIntoView === "function") {
        bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    } else {
      setShowScrollBack(true);
    }
  }, [filteredEvents.length, isAtBottom]);

  // Detect scroll position.
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 60;
    setIsAtBottom(atBottom);
    if (atBottom) setShowScrollBack(false);
  }, []);

  const scrollToBottom = () => {
    if (typeof bottomRef.current?.scrollIntoView === "function") {
      bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    setShowScrollBack(false);
    setIsAtBottom(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {pendingRequests.map((request) => <ExtensionUIRequestCard key={`${request.runId}:${request.id}`} request={request} />)}
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-4 py-2">
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
          Conversation
          {selectedRunId && (
            <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
              ({selectedRunId.slice(0, 8)}…)
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={clearEventStream}
            disabled={disabled || filteredEvents.length === 0}
            title="Clear stream"
            className="rounded p-1 text-slate-400 hover:text-red-500 dark:hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Icon name="Trash2" size={16} />
          </button>
        </div>
      </div>

      {/* Event list */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-auto p-4"
      >
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-sm text-slate-400 dark:text-slate-500">
            <Icon name="MessageSquare" size={32} className="mb-2 text-slate-300 dark:text-slate-600" />
            {disabled ? (
              <span>Bridge unavailable</span>
            ) : (
              <span>No events yet. Send a prompt to start.</span>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredEvents.map((evt) => (
              <ConversationEvent key={evt.id} event={evt} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}

        {/* Scroll-back button */}
        {showScrollBack && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="sticky bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-1 text-xs text-white shadow-lg hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            ↓ New events
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function ExecutionFamilyPanel({ family }: { family: ExecutionFamilyAggregate }): React.ReactElement {
  return (
    <section className="border-b border-[var(--af-line)] bg-[var(--af-panel-subtle)] px-3 py-3" aria-label="Execution family">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Execution family</p>
          <p className="mt-0.5 text-xs text-slate-500">Child and DAG runs linked by task ID</p>
        </div>
        <span className="font-mono text-sm font-semibold text-slate-900 dark:text-white">{family.totalRuns}</span>
      </div>
      {family.totalRuns === 0 ? (
        <p className="mt-3 border-l-2 border-slate-300 pl-2 text-xs text-slate-500">No linked child runs recorded for this task.</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden border border-[var(--af-line)] bg-[var(--af-line)] text-center text-[10px]">
            <div className="bg-[var(--af-panel)] px-1 py-2"><b className="block font-mono text-emerald-600">{family.success}</b><span className="text-slate-500">Success</span></div>
            <div className="bg-[var(--af-panel)] px-1 py-2"><b className="block font-mono text-red-600">{family.failed}</b><span className="text-slate-500">Failed</span></div>
            <div className="bg-[var(--af-panel)] px-1 py-2"><b className="block font-mono text-slate-800 dark:text-slate-100">${family.totalCostUsd.toFixed(4)}</b><span className="text-slate-500">Cost</span></div>
          </div>
          {(family.cancelled > 0 || family.timeout > 0) && <p className="mt-2 text-[10px] uppercase tracking-wide text-slate-500">Cancelled {family.cancelled} · Timeout {family.timeout}</p>}
          <div className="mt-2 max-h-40 divide-y divide-[var(--af-line-soft)] overflow-y-auto border-t border-[var(--af-line)]">
            {family.details.map((detail, index) => (
              <div key={`${detail.runId ?? detail.agent}:${detail.finishedAt}:${index}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 py-2 text-xs">
                <div className="min-w-0"><p className="truncate font-medium text-slate-800 dark:text-slate-100" title={detail.agent}>{detail.agent}</p><p className="truncate font-mono text-[10px] text-slate-500" title={detail.model}>{detail.model}{detail.isDagRole ? ' · DAG' : ''}</p></div>
                <div className="text-right"><p className={`font-mono text-[10px] uppercase ${detail.status === 'success' ? 'text-emerald-600' : detail.status === 'failed' ? 'text-red-600' : 'text-amber-600'}`}>{detail.status}</p><p className="font-mono text-[10px] text-slate-500">${detail.costUsd.toFixed(4)}</p></div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ComposerPanel({ disabled }: { disabled: boolean }): React.ReactElement {
  const project = useDashboardStore((state) => state.project);
  const telemetryEvents = useDashboardStore((state) => state.events);
  const selectedRunId = useWorkbenchStore((s) => s.selectedRunId);
  const composerInput = useWorkbenchStore((s) => s.composerInput);
  const setComposerInput = useWorkbenchStore((s) => s.setComposerInput);
  const sendPrompt = useWorkbenchStore((s) => s.sendPrompt);
  const sendSteer = useWorkbenchStore((s) => s.sendSteer);
  const sendFollowUp = useWorkbenchStore((s) => s.sendFollowUp);
  const abortRuntime = useWorkbenchStore((s) => s.abortRuntime);
  const stopRuntime = useWorkbenchStore((s) => s.stopRuntime);
  const stopAllRuntimes = useWorkbenchStore((s) => s.stopAllRuntimes);
  const retryRuntime = useWorkbenchStore((s) => s.retryRuntime);
  const loading = useWorkbenchStore((s) => s.loading);
  const error = useWorkbenchStore((s) => s.error);
  const clearEventStream = useWorkbenchStore((s) => s.clearEventStream);
  const selectRuntime = useWorkbenchStore((s) => s.selectRuntime);
  const selectedRuntime = useWorkbenchStore((s) => s.runtimes.find((runtime) => runtime.runId === s.selectedRunId));
  const executionFamily = useMemo(
    () => aggregateExecutionFamily(telemetryEvents, selectedRuntime?.taskId),
    [telemetryEvents, selectedRuntime?.taskId],
  );

  const isNewMode = !selectedRunId;
  const runtimeReadOnly = Boolean(selectedRuntime?.historical);
  const runtimeWritable = Boolean(selectedRuntime && !selectedRuntime.historical && ['starting', 'running', 'blocked'].includes(selectedRuntime.status) && selectedRuntime.exitCode === null && selectedRuntime.exitSignal === null);

  const handleSendToSelected = async () => {
    const input = composerInput.trim();
    if (!input) return;
    await sendPrompt(input);
  };

  const handleSteer = async () => {
    const input = composerInput.trim();
    if (!input) return;
    await sendSteer(input);
  };

  const handleFollowUp = async () => {
    const input = composerInput.trim();
    if (!input) return;
    await sendFollowUp(input);
  };

  const handleAbort = async () => {
    await abortRuntime();
  };

  const handleStop = async () => {
    await stopRuntime();
  };

  const handleStopAll = async () => {
    await stopAllRuntimes();
  };

  const handleCopyDiagnostics = async () => {
    if (!selectedRuntime) return;
    await navigator.clipboard.writeText(buildRuntimeDiagnostics(selectedRuntime));
  };

  const handleRemoveSelection = () => {
    selectRuntime("");
  };

  return (
    <div className="flex flex-col border-t border-slate-200 dark:border-slate-700 lg:border-t-0 lg:border-l">
      {/* Header */}
      <div className="border-b border-slate-200 dark:border-slate-700 px-3 py-2">
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Execution inspector</span>
        <span className="ml-2 text-[10px] uppercase tracking-wider text-slate-400">lead runtime</span>
      </div>

      {error && (
        <div className="mx-3 mt-2 rounded bg-red-50 dark:bg-red-900/20 px-3 py-1.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {selectedRuntime ? (
        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 border-b border-slate-200 px-3 py-3 text-xs dark:border-slate-700">
          <dt className="text-slate-500">Task</dt><dd className="truncate font-medium text-slate-800 dark:text-slate-100">{selectedRuntime.taskTitle || selectedRuntime.name}</dd>
          <dt className="text-slate-500">Mode source</dt><dd>{selectedRuntime.modePolicy === 'agent_decides' ? 'Main agent decides' : 'User fixed'}</dd>
          <dt className="text-slate-500">Mode</dt><dd className="font-mono">{selectedRuntime.modePolicy === 'agent_decides' ? 'AUTO' : selectedRuntime.modePolicy}</dd>
          <dt className="text-slate-500">Priority</dt><dd className="font-mono uppercase">{selectedRuntime.priority || 'normal'}</dd>
          <dt className="text-slate-500">Status</dt><dd className="font-mono uppercase">{selectedRuntime.status}</dd>
          {selectedRuntime.errorCode && <><dt className="text-red-600 dark:text-red-400">Error code</dt><dd className="font-mono text-red-700 dark:text-red-300">{selectedRuntime.errorCode}</dd></>}
          <dt className="text-slate-500">Task ID</dt><dd className="truncate font-mono" title={selectedRuntime.taskId}>{selectedRuntime.taskId || 'legacy'}</dd>
          <dt className="text-slate-500">Execution</dt><dd className="truncate font-mono" title={selectedRuntime.executionId}>{selectedRuntime.executionId || 'legacy'}</dd>
          <dt className="text-slate-500">Run ID</dt><dd className="truncate font-mono" title={selectedRuntime.runId}>{selectedRuntime.runId}</dd>
          {selectedRuntime.rootRunId && selectedRuntime.rootRunId !== selectedRuntime.runId && <><dt className="text-slate-500">Root Run</dt><dd className="truncate font-mono" title={selectedRuntime.rootRunId}>{selectedRuntime.rootRunId}</dd></>}
          {selectedRuntime.retryOfRunId && <><dt className="text-slate-500">Retry of</dt><dd className="truncate font-mono" title={selectedRuntime.retryOfRunId}>{selectedRuntime.retryOfRunId} · attempt {selectedRuntime.retryAttempt}</dd></>}
          <dt className="text-slate-500">CLI</dt><dd className="truncate font-mono" title={selectedRuntime.cliPath}>{selectedRuntime.cliSource || 'legacy'} · {selectedRuntime.cliPath || 'unknown'}</dd>
          <dt className="text-slate-500">Node runtime</dt><dd className="truncate font-mono" title={selectedRuntime.runtimeExecutable}>{selectedRuntime.runtimeSource || 'legacy'} · {selectedRuntime.runtimeVersion || 'unknown'} · {selectedRuntime.runtimeExecutable || 'unknown'}</dd>
          {selectedRuntime.status === 'failed' && selectedRuntime.stderrSummary && <>
            <dt className="text-red-600 dark:text-red-400">Failure</dt><dd className="max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-red-700 dark:text-red-300">{selectedRuntime.stderrSummary}</dd>
          </>}
        </dl>
      ) : <p className="border-b border-slate-200 px-3 py-4 text-xs text-slate-500 dark:border-slate-700">Select a task run to inspect execution controls and identifiers.</p>}

      {selectedRuntime && <ExecutionFamilyPanel family={executionFamily} />}

      {project && selectedRuntime && (
        <details className="border-b border-slate-200 dark:border-slate-700">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Capability policy</summary>
          <CapabilityPolicyPanel projectRoot={project.projectRoot} agentName={selectedRuntime.name} />
        </details>
      )}

      {/* Controls — shown above the textarea for the selected-run mode */}
      {!isNewMode && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 dark:border-slate-700 px-3 py-2">
          <span className="mr-1 text-xs text-slate-400">Runtime controls</span>
          <button
            type="button"
            onClick={handleSteer}
            disabled={disabled || loading || !runtimeWritable}
            className="rounded bg-amber-500 px-2 py-0.5 text-xs text-white hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Steer
          </button>
          <button
            type="button"
            onClick={handleFollowUp}
            disabled={disabled || loading || !runtimeWritable}
            className="rounded bg-blue-500 px-2 py-0.5 text-xs text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Follow-up
          </button>
          <button
            type="button"
            onClick={handleAbort}
            disabled={disabled || loading || !runtimeWritable}
            className="rounded bg-red-500 px-2 py-0.5 text-xs text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Abort
          </button>
          <button
            type="button"
            onClick={handleStop}
            disabled={disabled || loading || !runtimeWritable}
            className="rounded bg-slate-600 px-2 py-0.5 text-xs text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Stop Selected
          </button>
          <button
            type="button"
            onClick={() => retryRuntime()}
            disabled={disabled || loading || !selectedRuntime?.retryable}
            title={selectedRuntime && !selectedRuntime.retryable ? 'This run has no verified workspace provenance' : 'Retry as a new execution'}
            className="rounded bg-cyan-700 px-2 py-0.5 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-40"
          >Retry</button>
          <button
            type="button"
            onClick={() => void handleCopyDiagnostics()}
            disabled={disabled || !selectedRuntime}
            className="rounded border border-slate-400 px-2 py-0.5 text-xs text-slate-600 dark:text-slate-300 disabled:opacity-40"
          >Copy diagnostics</button>
          <button
            type="button"
            onClick={handleStopAll}
            disabled={disabled || loading}
            className="rounded border border-slate-400 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Stop All
          </button>
          <button
            type="button"
            onClick={handleRemoveSelection}
            disabled={disabled}
            className="ml-auto rounded px-2 py-0.5 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            title="Remove selection"
          >
            ✕ Deselect
          </button>
        </div>
      )}

      {/* Task conversation composer */}
      <div className="flex-1 overflow-hidden px-3 py-2">
        <textarea
          value={composerInput}
          onChange={(e) => setComposerInput(e.target.value)}
          placeholder={
            disabled
              ? "Bridge unavailable — select a workspace first"
              : isNewMode
                ? 'Create a task from the New Task control above.'
                : runtimeReadOnly ? "Recovered history is read-only" : "Type a prompt and use Steer / Follow-up…"
          }
          disabled={disabled || !runtimeWritable}
          rows={4}
          className="w-full resize-none rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
        />
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-700 px-3 py-2">
        {isNewMode ? <span className="text-xs text-slate-500">No task selected</span> : (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleSendToSelected}
              disabled={disabled || loading || !runtimeWritable || !composerInput.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {loading ? (
                <Icon name="RefreshCw" size={16} className="animate-spin" />
              ) : (
                <Icon name="Send" size={16} />
              )}
              <span>{loading ? "Sending…" : "Send"}</span>
            </button>
            <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">
              Selected:{" "}
              <code className="rounded bg-slate-100 dark:bg-slate-700 px-1 py-0.5 font-mono text-xs">
                {selectedRunId.slice(0, 8)}…
              </code>
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={clearEventStream}
          disabled={disabled}
          className="rounded px-2 py-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Clear stream
        </button>
      </div>
    </div>
  );
}

function NewTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement | null {
  const createTask = useWorkbenchStore((state) => state.createTask);
  const loading = useWorkbenchStore((state) => state.loading);
  const error = useWorkbenchStore((state) => state.error);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [modePolicy, setModePolicy] = useState<ModePolicy>('agent_decides');
  const dispatchedRef = useRef(false);

  useEffect(() => {
    if (open) dispatchedRef.current = false;
  }, [open]);

  if (!open) return null;
  const dispatch = async () => {
    if (dispatchedRef.current || !title.trim() || !prompt.trim()) return;
    dispatchedRef.current = true;
    await createTask({ title, prompt, priority, modePolicy });
    if (!useWorkbenchStore.getState().error) {
      setTitle(''); setPrompt(''); setPriority('normal'); setModePolicy('agent_decides'); onClose();
    } else {
      dispatchedRef.current = false;
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="new-task-title" className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/55 pt-[10vh] backdrop-blur-[1px]">
      <div className="w-[min(620px,calc(100vw-32px))] border border-slate-300 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-700">
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-400">Dispatch contract</p><h2 id="new-task-title" className="mt-1 text-lg font-semibold">New Task</h2></div>
          <button type="button" onClick={onClose} aria-label="Close new task" className="p-1 text-slate-500 hover:text-slate-900"><Icon name="X" size={18} /></button>
        </header>
        <div className="space-y-4 p-5">
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200">Task title<input aria-label="Task title" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} className="mt-1.5 w-full border border-slate-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-cyan-600 dark:border-slate-600" placeholder="What outcome should this execution deliver?" /></label>
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200">Initial prompt<textarea aria-label="Initial prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} className="mt-1.5 w-full resize-y border border-slate-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-cyan-600 dark:border-slate-600" placeholder="Context, constraints, acceptance criteria…" /></label>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-xs font-semibold">Priority<select aria-label="Task priority" value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)} className="mt-1.5 w-full border border-slate-300 bg-transparent px-2 py-2 font-mono text-xs uppercase dark:border-slate-600"><option value="low">LOW</option><option value="normal">NORMAL</option><option value="high">HIGH</option><option value="critical">CRITICAL</option></select></label>
            <label className="text-xs font-semibold">Execution mode<select aria-label="Execution mode" value={modePolicy} onChange={(event) => setModePolicy(event.target.value as ModePolicy)} className="mt-1.5 w-full border border-slate-300 bg-transparent px-2 py-2 text-xs dark:border-slate-600"><option value="agent_decides">Main agent decides</option><option value="M1">Fixed · M1 single agent</option><option value="M2">Fixed · M2 delegated</option><option value="M5">Fixed · M5 DAG</option></select></label>
          </div>
          <p className="border-l-2 border-cyan-600 pl-3 text-xs leading-5 text-slate-500"><strong className="text-slate-700 dark:text-slate-200">Default: Main agent decides.</strong> Fix M1, M2 or M5 only when the execution shape is already known. Automatic routing and sandbox policy are not configured here.</p>
          {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-700"><button type="button" onClick={onClose} className="px-3 py-2 text-xs text-slate-500">Cancel</button><button type="button" onClick={dispatch} disabled={loading || !title.trim() || !prompt.trim()} className="bg-cyan-700 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-40">{loading ? 'Dispatching…' : 'Dispatch task'}</button></footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Onboarding overlay (shown when bridge or workspace is missing)
// ---------------------------------------------------------------------------

function OnboardingOverlay(): React.ReactElement {
  return (
    <div className="mx-auto my-8 grid w-[min(620px,calc(100%-32px))] grid-cols-[40px_minmax(0,1fr)] gap-4 border border-[var(--af-line)] bg-[var(--af-panel-subtle)] p-5 text-left">
      <div className="af-icon-plate"><Icon name="Workflow" size={18} /></div>
      <div className="min-w-0">
      <p className="af-kicker">Workspace required</p>
      <h2 className="mt-1 text-base font-semibold text-slate-800 dark:text-slate-100">Connect an AgentFlux project</h2>
      <p className="mt-2 max-w-lg text-sm leading-6 text-slate-500 dark:text-slate-400">Select or add a workspace in the top bar. Control Room will then create lead runtimes, surface agent requests, and keep task execution in one place.</p>
      <div className="mt-4 flex flex-col gap-2 text-left text-xs text-slate-500">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
          <span>Runtime bridge: {typeof window !== "undefined" && window.agentRuntime ? "available" : "not available"}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
          <span>Workspace: use the selector in the top bar</span>
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkbenchPage
// ---------------------------------------------------------------------------

export const WorkbenchPage: React.FC = () => {
  const windowWide = useThreeColumnLayout();
  const roomRef = useRef<HTMLDivElement>(null);
  const [containerWide, setContainerWide] = useState(false);
  const [containerWidth, setContainerWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const element = roomRef.current;
    if (!element || typeof ResizeObserver === 'undefined') { setContainerWide(windowWide); return; }
    const observer = new ResizeObserver(([entry]) => { setContainerWidth(entry.contentRect.width); setContainerWide(entry.contentRect.width >= 980); });
    observer.observe(element); return () => observer.disconnect();
  }, [windowWide]);
  const threeCol = windowWide && containerWide;
  const onboarding = useOnboarding();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [columns, setColumns] = useState(readColumns);
  const runtimes = useWorkbenchStore((state) => state.runtimes);
  const persistence = useWorkbenchStore((state) => state.diagnostics?.persistence);
  const persistenceWarning = persistence?.status === 'corrupt' || persistence?.status === 'unsupported';
  const attentionCount = runtimes.filter((runtime) => runtime.status === 'blocked' || runtime.status === 'failed').length;
  const liveCount = runtimes.filter((runtime) => !runtime.historical && ['starting', 'running', 'blocked'].includes(runtime.status)).length;
  const updateColumns = (next: { left: number; right: number }) => {
    const safe = clampColumns(next, containerWidth);
    setColumns(safe);
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(safe)); } catch { /* persistence is best effort */ }
  };
  const fittedColumns = clampColumns(columns, containerWidth);
  const beginResize = (side: 'left' | 'right') => (event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const start = fittedColumns;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => updateColumns(side === 'left'
      ? { ...start, left: start.left + moveEvent.clientX - startX }
      : { ...start, right: start.right - moveEvent.clientX + startX });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const resizeKey = (side: 'left' | 'right') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = side === 'left' ? fittedColumns.left : fittedColumns.right;
    const min = side === 'left' ? 190 : 260;
    const max = side === 'left' ? 420 : 480;
    let next = current;
    if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    else if (event.key === 'ArrowLeft') next += side === 'left' ? -16 : 16;
    else if (event.key === 'ArrowRight') next += side === 'left' ? 16 : -16;
    else return;
    event.preventDefault(); updateColumns({ ...columns, [side]: next });
  };

  return (
    <div ref={roomRef} className="control-room flex h-full min-w-0 flex-col border border-[var(--af-line)] bg-[var(--af-panel)]" data-testid="operations-control-room">
      <header className="flex items-center gap-4 border-b border-[var(--af-line)] bg-[var(--af-panel-subtle)] px-4 py-3">
        <div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Operate / Control Room</p><h1 className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">Task operations</h1></div>
        <div className="hidden items-center gap-4 text-xs text-slate-500 sm:flex"><span><b className="font-mono text-slate-900 dark:text-white">{liveCount}</b> LIVE</span><span><b className={`font-mono ${attentionCount ? 'text-amber-600' : 'text-slate-900 dark:text-white'}`}>{attentionCount}</b> ATTENTION</span></div>
        <button type="button" onClick={() => setNewTaskOpen(true)} disabled={onboarding} className="af-button-primary flex items-center gap-2 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"><Icon name="Plus" size={16} />New Task</button>
        {threeCol && <button type="button" onClick={() => updateColumns(DEFAULT_COLUMNS)} className="text-xs text-slate-500 hover:text-cyan-700">Reset layout</button>}
      </header>
      <div className={`flex items-center gap-2 border-b px-4 py-2 text-xs ${attentionCount ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100' : 'border-slate-200 bg-white text-slate-500 dark:border-slate-800 dark:bg-slate-950'}`} role="status">
        <Icon name={attentionCount ? 'AlertTriangle' : 'CheckCircle2'} size={14} />
        <strong>{attentionCount ? `${attentionCount} run${attentionCount === 1 ? '' : 's'} need${attentionCount === 1 ? 's' : ''} attention.` : 'No operator action required.'}</strong>
        <span>{attentionCount ? 'Select a blocked or failed runtime to respond or inspect.' : 'Live lead runtimes will surface decisions here.'}</span>
      </div>
      {persistenceWarning && (
        <div role="status" className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <Icon name="AlertTriangle" size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <strong>Runtime history was not restored.</strong>{' '}
            <span>{persistence.message}</span>
            <span className="ml-1 text-amber-700 dark:text-amber-300">Live runtimes are unaffected.</span>
          </div>
        </div>
      )}
      {onboarding ? (
        <OnboardingOverlay />
      ) : (
        <div
          className={`flex-1 ${
            threeCol
              ? "grid"
              : "flex flex-col"
          } overflow-hidden`}
          style={threeCol ? { gridTemplateColumns: `${fittedColumns.left}px 7px minmax(400px, 1fr) 7px ${fittedColumns.right}px` } : undefined}
        >
          {/* Roster — left column (or top in flex-col) */}
          <div className={threeCol ? "" : "h-48 shrink-0"}>
            <RosterPanel disabled={false} />
          </div>

          {threeCol && <div role="separator" aria-label="Resize task roster" aria-orientation="vertical" aria-valuemin={190} aria-valuemax={420} aria-valuenow={fittedColumns.left} tabIndex={0} onPointerDown={beginResize('left')} onKeyDown={resizeKey('left')} className="group cursor-col-resize border-x border-[var(--af-line)] bg-[var(--af-panel-subtle)] outline-none focus-visible:bg-cyan-600/30"><span className="mx-auto block h-full w-px bg-transparent group-hover:bg-cyan-600" /></div>}

          {/* Conversation — center column (or middle in flex-col) */}
          <ConversationPanel disabled={false} />

          {threeCol && <div role="separator" aria-label="Resize execution inspector" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={480} aria-valuenow={fittedColumns.right} tabIndex={0} onPointerDown={beginResize('right')} onKeyDown={resizeKey('right')} className="group cursor-col-resize border-x border-[var(--af-line)] bg-[var(--af-panel-subtle)] outline-none focus-visible:bg-cyan-600/30"><span className="mx-auto block h-full w-px bg-transparent group-hover:bg-cyan-600" /></div>}

          {/* Composer — right column (or bottom in flex-col) */}
          <div className={threeCol ? "" : "shrink-0"}>
            <ComposerPanel disabled={false} />
          </div>
        </div>
      )}
      <NewTaskDialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} />
    </div>
  );
};

export default WorkbenchPage;
