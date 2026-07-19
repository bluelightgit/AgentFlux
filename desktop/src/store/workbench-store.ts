/**
 * Workbench Store — Zustand store for Agent Runtime management.
 *
 * Manages:
 *   - Runtimes list (from agentRuntimeClient.list())
 *   - Selected run ID
 *   - Event stream buffer
 *   - Composer input
 *
 * Actions delegate to agentRuntimeClient (bridge via window.agentRuntime).
 * If the bridge is unavailable, actions throw and set error state.
 *
 * 事件流：
 *   - Snapshot (kind:'snapshot') → 只更新 runtimes，不进 eventStream
 *   - Event (kind:'event') → 解析为 WorkbenchStreamEvent，加入 eventStream
 *   - message_end → 从 event.message.role 和 content blocks 提取
 *   - process_error/process_exit → 以 system/error 显示
 *   - agent_start/agent_settled → 以 system 显示
 *   - message_update → 忽略
 */
import { create } from "zustand";
import { agentRuntimeClient, type AgentSession, type ExtensionUIResponse, type RuntimeDiagnostics, type TaskPriority, type WorkStyleSelection } from "../lib/agent-runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkbenchEventType =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "error";

export interface WorkbenchStreamEvent {
  id: string;
  type: WorkbenchEventType;
  content: string;
  timestamp: number;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface NewTaskOptions {
  title: string;
  prompt: string;
  priority: TaskPriority;
  workStyle: WorkStyleSelection;
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface WorkbenchState {
  /** Snapshot of all active agent sessions. */
  runtimes: AgentSession[];
  /** Currently selected run ID (null = no selection). */
  selectedRunId: string | null;
  /** Buffered stream events for the selected run (or all if none selected). */
  eventStream: WorkbenchStreamEvent[];
  /** Current composer textarea value. */
  composerInput: string;
  /** Whether the window.agentRuntime bridge is available. */
  bridgeAvailable: boolean;
  /** Loading flag for async operations. */
  loading: boolean;
  /** Last error message, cleared on next successful action. */
  error: string | null;
  /** Non-blocking runtime/history diagnostics surfaced by the Electron main process. */
  diagnostics: RuntimeDiagnostics | null;

  // ─── Actions ──────────────────────────────────────────────────────────

  /** Re-fetch the runtimes list from the bridge. */
  loadRuntimes: () => Promise<void>;

  /** Create a new runtime session (calls bridge.start + refreshes list). */
  createRuntime: () => Promise<void>;

  /** Dispatch exactly one task-scoped lead runtime through the controlled IPC contract. */
  createTask: (options: NewTaskOptions) => Promise<void>;
  retryRuntime: (runId?: string) => Promise<void>;

  /** Select a runtime by runId, filtering event stream to that run. */
  selectRuntime: (runId: string) => void;

  /** Send a free-form prompt to the bridge.
   *
   * Semantics:
   *   - selectedRunId 存在时仅调用 agentRuntimeClient.prompt(selectedRunId, prompt)
   *   - 无选中时仅调用 agentRuntimeClient.start({initialTask: prompt})
   *   - 绝不同时调用 start + prompt
   */
  sendPrompt: (prompt: string) => Promise<void>;

  /** Send a steer instruction to the currently selected runtime. */
  sendSteer: (prompt: string) => Promise<void>;

  /** Send a follow-up to the currently selected runtime. */
  sendFollowUp: (prompt: string) => Promise<void>;

  /** Abort the given run (or selected run if omitted). */
  abortRuntime: (runId?: string) => Promise<void>;

  /** Stop the selected runtime (or an explicitly supplied runId). */
  stopRuntime: (runId?: string) => Promise<void>;

  /** Stop every runtime process visible in the roster. */
  stopAllRuntimes: () => Promise<void>;

  /** Answer or cancel an extension dialog emitted by pi RPC. */
  respondToUiRequest: (runId: string, response: ExtensionUIResponse) => Promise<void>;

  /** Clear the buffered event stream. */
  clearEventStream: () => void;

  /** Update the composer input value. */
  setComposerInput: (input: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _eventIdCounter = 0;
function nextEventId(): string {
  _eventIdCounter += 1;
  return `evt-${Date.now()}-${_eventIdCounter}`;
}

/** Event stream 缓冲上限 */
const MAX_EVENT_STREAM = 1000;

function capEventStream(events: WorkbenchStreamEvent[]): WorkbenchStreamEvent[] {
  if (events.length > MAX_EVENT_STREAM) {
    return events.slice(events.length - MAX_EVENT_STREAM);
  }
  return events;
}

/**
 * 从 message_end 事件的 content blocks 中提取文本。
 */
function extractContentText(event: Record<string, unknown>): string {
  // Try event.message.content (array of blocks)
  if (event.message && typeof event.message === 'object') {
    const msg = event.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            parts.push(b.text);
          } else if (typeof b.text === 'string') {
            parts.push(b.text);
          }
        }
      }
      if (parts.length > 0) return parts.join('\n');
    }
    if (typeof msg.content === 'string') return msg.content;
  }
  // Fallback: event.content
  if (typeof event.content === 'string') return event.content;
  if (typeof event.text === 'string') return event.text;
  // Fallback: JSON.stringify summary
  return JSON.stringify(event);
}

/**
 * 从 message_end 事件的 message.role 字段提取 WorkbenchEventType。
 * user → 'user', assistant → 'assistant', toolResult/tool → 'tool', 未知 → 'system'
 */
function getMessageRole(event: Record<string, unknown>): WorkbenchEventType {
  if (event.message && typeof event.message === 'object') {
    const msg = event.message as Record<string, unknown>;
    const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
    if (role === 'user') return 'user';
    if (role === 'assistant') return 'assistant';
    if (role === 'toolresult' || role === 'tool') return 'tool';
  }
  return 'system';
}

/**
 * Heuristically map a raw bridge event type string to a WorkbenchEventType.
 */
function classifyEventType(raw: string): WorkbenchEventType {
  const lc = raw.toLowerCase();
  if (lc === 'user' || lc === 'human' || lc === 'prompt') return 'user';
  if (lc === 'assistant' || lc === 'ai' || lc === 'response' || lc === 'message_end') return 'assistant';
  if (lc === 'tool' || lc === 'tool_call' || lc === 'function_call') return 'tool';
  if (lc === 'error' || lc === 'err' || lc === 'process_error') return 'error';
  if (lc === 'process_exit' || lc === 'agent_start' || lc === 'agent_settled' || lc === 'agent_end') return 'system';
  if (lc === 'message_update') return 'system'; // ignored later
  return 'system';
}

/**
 * Parse a raw bridge event into a WorkbenchStreamEvent, respecting the kind envelope.
 *
 * kind 规则：
 *   - kind:'snapshot' → 返回 null（由 onEvent handler 单独处理 runtimes 更新）
 *   - kind:'event' → 解析真实 RPC 事件
 *     - message_update → 忽略（返回 null）
 *     - message_end → 从 message.role/content blocks 提取
 *     - process_error/process_exit → system/error 类型
 *     - agent_start/agent_settled → system 类型
 */
function parseBridgeEvent(raw: unknown): WorkbenchStreamEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // Handle kind envelope from main process
  if (obj.kind === 'snapshot') {
    // Snapshot is handled separately — do NOT add to eventStream
    return null;
  }

  if (obj.kind === 'record_removed') {
    // record_removed is handled separately
    return null;
  }

  // For kind:'event', unwrap to the actual event
  if (obj.kind === 'event') {
    const runId = typeof obj.runId === 'string' ? obj.runId : undefined;
    const event = obj.event as Record<string, unknown> | undefined;
    if (!event || typeof event !== 'object') return null;

    // Ignore message_update — no display value
    const eventType = typeof event.type === 'string' ? event.type : '';
    if (eventType === 'message_update') return null;

    // Determine the WorkbenchEventType
    const eventTypeStr = String(event.type ?? 'system');

    // For message_end, read type from message.role instead of event type string
    let wbType: WorkbenchEventType;
    let content: string;
    if (eventType === 'message_end') {
      wbType = getMessageRole(event);
      content = extractContentText(event);
    } else {
      wbType = classifyEventType(eventTypeStr);
      content = extractEventContent(event);
    }

    const timestamp =
      typeof event.timestamp === 'number'
        ? event.timestamp
        : typeof event.ts === 'number'
          ? event.ts
          : Date.now();

    const result: WorkbenchStreamEvent = {
      id: nextEventId(),
      type: wbType,
      content,
      timestamp,
      runId,
    };

    // Include event.type as metadata for debugging
    result.metadata = { eventType: eventTypeStr };

    return result;
  }

  // Legacy flat format (for tests without kind envelope)
  const eventType = typeof obj.type === 'string' ? String(obj.type) : 'system';
  if (eventType === 'message_update') return null;

  let wbType: WorkbenchEventType;
  let content: string;
  if (eventType === 'message_end') {
    wbType = getMessageRole(obj);
    content = extractContentText(obj);
  } else {
    wbType = classifyEventType(eventType);
    content = extractEventContent(obj);
  }

  const timestamp =
    typeof obj.timestamp === 'number'
      ? obj.timestamp
      : typeof obj.ts === 'number'
        ? obj.ts
        : Date.now();
  const runId = typeof obj.runId === 'string' ? obj.runId : undefined;

  const result: WorkbenchStreamEvent = {
    id: nextEventId(),
    type: wbType,
    content,
    timestamp,
    runId,
  };

  result.metadata = { eventType };

  return result;
}

/**
 * Extract content from a generic event object (non-message_end).
 */
function extractEventContent(event: Record<string, unknown>): string {
  if (typeof event.content === 'string') {
    return event.content as string;
  }
  if (typeof event.text === 'string') {
    return event.text as string;
  }
  if (typeof event.message === 'string') {
    return event.message as string;
  }
  if (typeof event.error === 'string') {
    return event.error as string;
  }
  // For process_exit
  if (event.type === 'process_exit' && event.data && typeof event.data === 'object') {
    const d = event.data as Record<string, unknown>;
    const stderr = typeof d.stderrSummary === 'string' ? d.stderrSummary.trim() : '';
    const runtime = [d.runtimeSource, d.runtimeVersion, d.runtimeExecutable]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' · ');
    const base = `进程退出 (code: ${JSON.stringify(d.code)}, signal: ${JSON.stringify(d.signal)})`;
    return [base, runtime ? `Runtime: ${runtime}` : '', stderr ? `stderr: ${stderr}` : '']
      .filter(Boolean)
      .join('\n');
  }
  // For process_error
  if (event.type === 'process_error' && event.data && typeof event.data === 'object') {
    const d = event.data as Record<string, unknown>;
    return `进程错误: ${typeof d.message === 'string' ? d.message : JSON.stringify(d)}`;
  }
  // Fallback: short JSON summary
  return JSON.stringify(event);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWorkbenchStore = create<WorkbenchState>((set, get) => {
  // Subscribe to bridge events (if available) at store creation time.
  let unsubscribe: (() => void) | null = null;

  // Attempt to start listening for bridge events.
  function tryStartListening() {
    if (unsubscribe) return;
    try {
      if (agentRuntimeClient.isAvailable) {
        unsubscribe = agentRuntimeClient.onEvent((raw) => {
          if (!raw || typeof raw !== 'object') return;
          const obj = raw as Record<string, unknown>;

          // ── Snapshot handler: 只更新 runtimes，不加入 eventStream ──
          if (obj.kind === 'snapshot') {
            const snap = obj.snapshot as AgentSession | AgentSession[] | undefined;
            if (snap) {
              set((_s) => {
                const incoming = Array.isArray(snap) ? snap : [snap];
                // Merge incoming snapshots into existing runtimes
                const merged = new Map<string, AgentSession>();
                for (const rt of _s.runtimes) merged.set(rt.runId, rt);
                for (const rt of incoming) merged.set(rt.runId, rt);
                const updated = Array.from(merged.values());
                return { runtimes: updated };
              });
            }
            return;
          }

          // ── Event handler: 解析并加入 eventStream ──
          const parsed = parseBridgeEvent(raw);
          if (parsed) {
            set((_s) => ({
              eventStream: capEventStream([..._s.eventStream, parsed]),
            }));
          }
        });
      }
    } catch {
      // bridge not available
    }
  }

  // Attempt to start on a microtask (after store is constructed).
  setTimeout(() => {
    tryStartListening();
  }, 0);

  return {
    runtimes: [],
    selectedRunId: null,
    eventStream: [],
    composerInput: "",
    bridgeAvailable: agentRuntimeClient.isAvailable,
    loading: false,
    error: null,
    diagnostics: null,

    loadRuntimes: async () => {
      try {
        const [runtimes, diagnostics] = await Promise.all([
          agentRuntimeClient.list(),
          agentRuntimeClient.diagnostics(),
        ]);
        set({ runtimes, diagnostics, error: null });
      } catch (err: unknown) {
        set({ error: `Failed to load runtimes: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    createRuntime: async () => {
      const { project } = (await import("../store/dashboard-store")).useDashboardStore.getState();
      if (!project) {
        set({ error: "No workspace selected. Select or add a workspace first." });
        return;
      }
      set({ loading: true, error: null });
      try {
        tryStartListening();
        await agentRuntimeClient.start({
          projectRoot: project.projectRoot,
          name: "default",
          taskTitle: "Untitled task",
          initialTask: "Start a new task and wait for instructions.",
          priority: "normal",
          workStyle: "agent_decides",
        });
        const runtimes = await agentRuntimeClient.list();
        set({ runtimes, loading: false, bridgeAvailable: true });
      } catch (err: unknown) {
        set({ loading: false, error: `Failed to create runtime: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    createTask: async (options) => {
      const title = options.title.trim();
      const prompt = options.prompt.trim();
      if (!title || !prompt) {
        set({ error: "Task title and initial prompt are required." });
        return;
      }
      const { project } = (await import("../store/dashboard-store")).useDashboardStore.getState();
      if (!project) {
        set({ error: "No workspace selected. Select or add a workspace first." });
        return;
      }
      set({ loading: true, error: null });
      try {
        tryStartListening();
        const result = await agentRuntimeClient.start({
          projectRoot: project.projectRoot,
          name: "lead",
          taskTitle: title,
          initialTask: prompt,
          priority: options.priority,
          workStyle: options.workStyle,
        });
        const userEvent: WorkbenchStreamEvent = {
          id: nextEventId(), type: "user", content: prompt, timestamp: Date.now(), runId: result.runId,
          metadata: { taskId: result.taskId, executionId: result.executionId },
        };
        const runtimes = await agentRuntimeClient.list();
        set((state) => ({
          runtimes,
          selectedRunId: result.runId,
          eventStream: capEventStream([...state.eventStream, userEvent]),
          loading: false,
          bridgeAvailable: true,
        }));
      } catch (err: unknown) {
        set({ loading: false, error: `Failed to create task: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    retryRuntime: async (runId?: string) => {
      const state = get();
      const source = state.runtimes.find((runtime) => runtime.runId === (runId ?? state.selectedRunId));
      if (!source || !['failed', 'aborted'].includes(source.status)) {
        set({ error: "Select a failed or aborted run before retrying." });
        return;
      }
      const { project } = (await import("../store/dashboard-store")).useDashboardStore.getState();
      if (!project) { set({ error: "No workspace selected. Select or add a workspace first." }); return; }
      set({ loading: true, error: null });
      try {
        tryStartListening();
        const result = await agentRuntimeClient.retry(source.runId);
        const runtimes = await agentRuntimeClient.list();
        set({ runtimes, selectedRunId: result.runId, loading: false, bridgeAvailable: true });
      } catch (err: unknown) {
        const runtimes = await agentRuntimeClient.list().catch(() => get().runtimes);
        set({ runtimes, loading: false, error: `Retry failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    selectRuntime: (runId: string) => {
      set((state) => {
        const runtime = state.runtimes.find((item) => item.runId === runId);
        if (!runtime) return { selectedRunId: runId || null };
        if (!runtime.historical) return { selectedRunId: runId };
        const existingIds = new Set(state.eventStream.filter((item) => item.runId === runId).map((item) => String(item.metadata?.snapshotEventIndex ?? '')));
        const recovered = runtime.events.flatMap((event, index) => {
          if (existingIds.has(String(index))) return [];
          const raw = { type: event.type, data: event.data } as Record<string, unknown>;
          return [{
            id: `snapshot-${runId}-${index}`,
            type: classifyEventType(event.type),
            content: extractEventContent(raw),
            timestamp: event.timestamp,
            runId,
            metadata: { snapshotEventIndex: index, recovered: true },
          } satisfies WorkbenchStreamEvent];
        });
        return { selectedRunId: runId, eventStream: capEventStream([...state.eventStream, ...recovered]) };
      });
    },

    /**
     * sendPrompt 语义（验收要求 4）：
     *   - selectedRunId 存在时 → 仅调用 agentRuntimeClient.prompt(selectedRunId, prompt)
     *   - 无选中时 → 仅调用 agentRuntimeClient.start({initialTask: prompt})
     *   - 绝不同时调用 start + prompt
     *   - 用户事件携带实际 runId
     */
    sendPrompt: async (prompt: string) => {
      if (!prompt.trim()) return;

      const { selectedRunId } = get();

      set({
        loading: true,
        error: null,
        composerInput: "",
      });

      try {
        tryStartListening();
        const { project } = (await import("../store/dashboard-store")).useDashboardStore.getState();
        if (!project) {
          set({ error: "No workspace selected. Select or add a workspace first.", loading: false });
          return;
        }

        if (selectedRunId) {
          // ── 有选中：仅 prompt，不 start ──
          await agentRuntimeClient.prompt(selectedRunId, prompt);

          // 用户事件带实际 runId
          const userEvent: WorkbenchStreamEvent = {
            id: nextEventId(),
            type: "user",
            content: prompt,
            timestamp: Date.now(),
            runId: selectedRunId,
          };
          set((s) => ({
            eventStream: capEventStream([...s.eventStream, userEvent]),
            loading: false,
            bridgeAvailable: true,
          }));
        } else {
          // ── 无选中：仅 start，不 prompt ──
          const result = await agentRuntimeClient.start({
            projectRoot: project.projectRoot,
            name: "default",
            taskTitle: prompt.trim().slice(0, 80),
            initialTask: prompt,
            priority: "normal",
            workStyle: "agent_decides",
          });

          // 用户事件带实际 runId
          const userEvent: WorkbenchStreamEvent = {
            id: nextEventId(),
            type: "user",
            content: prompt,
            timestamp: Date.now(),
            runId: result.runId,
          };
          set((s) => ({
            eventStream: capEventStream([...s.eventStream, userEvent]),
            selectedRunId: result.runId,
            loading: false,
            bridgeAvailable: true,
          }));
        }

        // 刷新 runtimes 列表
        const runtimes = await agentRuntimeClient.list();
        set({ runtimes });
      } catch (err: unknown) {
        set({ loading: false, error: `sendPrompt failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    sendSteer: async (prompt: string) => {
      const { selectedRunId } = get();
      if (!selectedRunId) {
        set({ error: "No runtime selected. Select a runtime first." });
        return;
      }
      if (!prompt.trim()) return;
      const userEvent: WorkbenchStreamEvent = {
        id: nextEventId(),
        type: "user",
        content: `[steer] ${prompt}`,
        timestamp: Date.now(),
        runId: selectedRunId,
      };
      set((s) => ({
        eventStream: [...s.eventStream, userEvent],
        loading: true,
        error: null,
        composerInput: "",
      }));
      try {
        tryStartListening();
        await agentRuntimeClient.steer(selectedRunId, prompt);
        const runtimes = await agentRuntimeClient.list();
        set({ runtimes, loading: false, bridgeAvailable: true });
      } catch (err: unknown) {
        set({ loading: false, error: `sendSteer failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    sendFollowUp: async (prompt: string) => {
      const { selectedRunId } = get();
      if (!selectedRunId) {
        set({ error: "No runtime selected. Select a runtime first." });
        return;
      }
      if (!prompt.trim()) return;
      const userEvent: WorkbenchStreamEvent = {
        id: nextEventId(),
        type: "user",
        content: `[follow-up] ${prompt}`,
        timestamp: Date.now(),
        runId: selectedRunId,
      };
      set((s) => ({
        eventStream: [...s.eventStream, userEvent],
        loading: true,
        error: null,
        composerInput: "",
      }));
      try {
        tryStartListening();
        await agentRuntimeClient.followUp(selectedRunId, prompt);
        const runtimes = await agentRuntimeClient.list();
        set({ runtimes, loading: false, bridgeAvailable: true });
      } catch (err: unknown) {
        set({ loading: false, error: `sendFollowUp failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    abortRuntime: async (runId?: string) => {
      const targetRunId = runId ?? get().selectedRunId;
      if (!targetRunId) {
        set({ error: "No runtime specified or selected to abort." });
        return;
      }
      set({ loading: true, error: null });
      try {
        await agentRuntimeClient.abort(targetRunId);
        const runtimes = await agentRuntimeClient.list();
        set({ runtimes, loading: false, bridgeAvailable: true });
      } catch (err: unknown) {
        set({ loading: false, error: `abortRuntime failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    stopRuntime: async (runId?: string) => {
      const targetRunId = runId ?? get().selectedRunId;
      if (!targetRunId) {
        set({ error: "No runtime specified or selected to stop." });
        return;
      }
      set({ loading: true, error: null });
      try {
        await agentRuntimeClient.stop(targetRunId);
        const updatedRuntimes = await agentRuntimeClient.list();
        set({ runtimes: updatedRuntimes, loading: false, bridgeAvailable: true });
      } catch (err: unknown) {
        set({ loading: false, error: `stopRuntime failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    stopAllRuntimes: async () => {
      set({ loading: true, error: null });
      try {
        const { runtimes } = get();
        for (const rt of runtimes.filter((runtime) => !runtime.historical)) {
          await agentRuntimeClient.stop(rt.runId);
        }
        const updatedRuntimes = await agentRuntimeClient.list();
        set({ runtimes: updatedRuntimes, loading: false, bridgeAvailable: true });
      } catch (err: unknown) {
        set({ loading: false, error: `stopAllRuntimes failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    respondToUiRequest: async (runId, response) => {
      set({ loading: true, error: null });
      try {
        await agentRuntimeClient.respondToExtensionUI(runId, response);
        const runtimes = await agentRuntimeClient.list();
        set({ runtimes, loading: false, bridgeAvailable: true });
      } catch (err: unknown) {
        set({ loading: false, error: `UI response failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },

    clearEventStream: () => {
      set({ eventStream: [] });
    },

    setComposerInput: (input: string) => {
      set({ composerInput: input });
    },
  };
});
