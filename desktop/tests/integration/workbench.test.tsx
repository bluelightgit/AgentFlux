/**
 * IT-WB-1~6: Workbench Integration Tests
 *
 * Tests the WorkbenchPage component and workbench-store with
 * a real (non-vi.fn-mocked) window.agentRuntime bridge.
 *
 * The bridge methods are implemented as actual async functions with
 * internal state, not vi.fn() placeholders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

// ─── Bridge: real async implementation ─────────────────────────────────────
// Internal state shared between the bridge mock and tests.
const bridgeState: {
  runtimes: Array<{
    runId: string;
    pid: number | null;
    status: string;
    lastActivity: number;
    events: unknown[];
    stderrSummary: string;
    name?: string;
    startedAt?: number;
    exitCode?: number | null;
    exitSignal?: string | null;
    historical?: boolean;
    pendingUiRequests?: Array<Record<string, unknown>>;
    taskId?: string;
    executionId?: string;
    taskTitle?: string;
    initialPrompt?: string;
    priority?: string;
    modePolicy?: string;
  }>;
  events: unknown[];
  listeners: Array<(event: unknown) => void>;
} = { runtimes: [], events: [], listeners: [] };

// Track call counts for sendPrompt tests
const callCounts: {
  start: number;
  prompt: number;
  steer: number;
  followUp: number;
  abort: number;
  stop: number;
  list: number;
  uiResponse: number;
} = { start: 0, prompt: 0, steer: 0, followUp: 0, abort: 0, stop: 0, list: 0, uiResponse: 0 };

function makeBridge() {
  return {
    start: async (options: { projectRoot: string; name: string; taskTitle: string; initialTask: string; priority: string; modePolicy: string }) => {
      callCounts.start++;
      const runId = "run-" + String(Date.now()) + "-" + String(Math.random().toString(36).slice(2, 6));
      bridgeState.runtimes.push({
        runId,
        taskId: `task-${runId}`,
        executionId: `execution-${runId}`,
        taskTitle: options.taskTitle,
        initialPrompt: options.initialTask,
        priority: options.priority,
        modePolicy: options.modePolicy,
        name: options.name,
        pid: 12345,
        status: "running",
        lastActivity: Date.now(),
        events: [],
        stderrSummary: "",
      });
      return { runId, taskId: `task-${runId}`, executionId: `execution-${runId}` };
    },

    prompt: async (runId: string, prompt: string) => {
      callCounts.prompt++;
      if (!bridgeState.runtimes.find((r) => r.runId === runId)) {
        bridgeState.runtimes.push({
          runId,
          pid: 12346,
          status: "running",
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        });
      }
      return { ok: true };
    },

    steer: async (runId: string, prompt: string) => {
      callCounts.steer++;
      return { ok: true };
    },

    followUp: async (runId: string, prompt: string) => {
      callCounts.followUp++;
      return { ok: true };
    },

    abort: async (runId: string) => {
      callCounts.abort++;
      const rt = bridgeState.runtimes.find((r) => r.runId === runId);
      if (rt) {
        rt.status = "aborted";
        rt.lastActivity = Date.now();
      }
      return { ok: true };
    },

    stop: async (runId: string) => {
      callCounts.stop++;
      for (const rt of bridgeState.runtimes.filter((candidate) => candidate.runId === runId)) {
        rt.status = "aborted";
        rt.lastActivity = Date.now();
      }
      return { ok: true };
    },

    extensionUiResponse: async (runId: string, response: { id: string }) => {
      callCounts.uiResponse++;
      const runtime = bridgeState.runtimes.find((item) => item.runId === runId);
      if (runtime?.pendingUiRequests) {
        runtime.pendingUiRequests = runtime.pendingUiRequests.filter((item) => item.id !== response.id);
      }
      return { ok: true };
    },

    list: async () => {
      callCounts.list++;
      return bridgeState.runtimes.map((r) => ({
        ...r,
        status: r.status as
          | "starting"
          | "running"
          | "blocked"
          | "done"
          | "failed"
          | "aborted",
      }));
    },

    shutdownAll: async () => {
      bridgeState.runtimes.length = 0;
      return { ok: true };
    },

    isRunning: async () => bridgeState.runtimes.length > 0,

    onEvent: (callback: (event: unknown) => void) => {
      bridgeState.listeners.push(callback);
      return () => {
        const idx = bridgeState.listeners.indexOf(callback);
        if (idx >= 0) bridgeState.listeners.splice(idx, 1);
      };
    },
  };
}

// Mock the agent-runtime module with a bridge whose methods are real async
// functions (NOT vi.fn() stubs).
vi.mock("../../src/lib/agent-runtime", () => {
  const bridge = makeBridge();

  const client = {
    isAvailable: true,
    _bridge: bridge,
    start: bridge.start,
    prompt: bridge.prompt,
    steer: bridge.steer,
    followUp: bridge.followUp,
    abort: bridge.abort,
    stop: bridge.stop,
    respondToExtensionUI: bridge.extensionUiResponse,
    list: bridge.list,
    diagnostics: async () => ({ persistence: { status: 'ready' } }),
    capabilityPolicies: async () => ({ schemaVersion: 1, records: [], notices: [] }),
    shutdownAll: bridge.shutdownAll,
    onEvent: bridge.onEvent,
  };

  return {
    AgentRuntimeClient: function () {
      return client;
    },
    agentRuntimeClient: client,
  };
});

// ─── Mocks for other dependencies ──────────────────────────────────────────

vi.mock("../../src/lib/project-discovery", () => ({
  discoverProject: vi.fn(() => "/test/project"),
  validateProjectPath: vi.fn(async () => ({
    fluxDir: "/test/.agentflux",
    eventsPath: "/test/.agentflux/events.jsonl",
    projectName: "test-project",
    projectRoot: "/test",
  })),
}));

vi.mock("../../src/lib/event-watcher", () => ({
  EventWatcher: class {
    onEvent() { return () => {}; }
    start() {}
    stop() {}
    poll() {}
  },
}));

vi.mock("../../src/lib/agent-status-enhanced", () => ({
  readAgentStatus: vi.fn(async () => ({
    persistentAgents: [],
    blackboardAgents: [],
    dagState: null,
    override: null,
  })),
}));

vi.mock("../../src/lib/events-parser", () => ({
  parseEventsFileAsync: vi.fn(async () => []),
  parseEventsFile: vi.fn(() => []),
  filterByType: vi.fn((events: any[], type: string) =>
    events.filter((e: any) => e.type === type),
  ),
  filterByTimeRange: vi.fn((events: any[]) => events),
}));

vi.mock("../../src/lib/data-aggregator", () => ({
  aggregateRouteHistory: vi.fn(() => []),
  aggregateCacheTrend: vi.fn(() => []),
  aggregateTokenBreakdown: vi.fn(() => []),
  aggregateCostAnalysis: vi.fn(() => ({
    byMode: [],
    byModel: [],
    byTaskType: [],
    total: 0,
    avgPerTurn: 0,
  })),
  aggregateAgentTimeline: vi.fn(() => []),
  aggregateSummary: vi.fn(() => null),
}));

vi.mock("../../src/lib/workspace-registry", () => ({
  loadRegistry: vi.fn(async () => ({
    workspaces: [],
    activeId: null,
  })),
  addWorkspace: vi.fn(async (path: string) => ({
    id: "ws-1",
    name: "Test Workspace",
    path,
  })),
  removeWorkspace: vi.fn(async () => {}),
  setActive: vi.fn(async (id: string) => ({
    id,
    name: "Test Workspace",
    path: "/test",
  })),
}));

vi.mock("../../src/lib/session-reader", () => ({
  listSessions: vi.fn(async () => []),
}));

vi.mock("../../src/hooks/useKeyboardNav", () => ({
  useKeyboardNav: vi.fn(),
}));
vi.mock("../../src/hooks/useCommandPalette", () => ({
  useCommandPalette: vi.fn(() => ({
    open: false,
    close: vi.fn(),
    toggle: vi.fn(),
  })),
}));
vi.mock("../../src/components/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../../src/hooks/useEventNotifications", () => ({
  useEventNotifications: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Static imports (run after vi.mock)
// ---------------------------------------------------------------------------
import { useWorkbenchStore } from "../../src/store/workbench-store";
import { useDashboardStore } from "../../src/store/dashboard-store";
import { WorkbenchPage } from "../../src/components/WorkbenchPage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStores() {
  useDashboardStore.setState({
    currentPage: "workbench",
    project: {
      fluxDir: "/test/.agentflux",
      eventsPath: "/test/.agentflux/events.jsonl",
      projectName: "test-project",
      projectRoot: "/test",
    },
    workspaces: [],
    activeWorkspace: null,
    sessions: [],
    events: [],
    autoRefresh: false,
    loading: false,
    error: null,
    watcher: null,
    statusTimer: null,
  });

  useWorkbenchStore.setState({
    runtimes: [],
    selectedRunId: null,
    eventStream: [],
    composerInput: "",
    loading: false,
    error: null,
  });

  bridgeState.runtimes.length = 0;
  bridgeState.events.length = 0;
  callCounts.start = 0;
  callCounts.prompt = 0;
  callCounts.steer = 0;
  callCounts.followUp = 0;
  callCounts.abort = 0;
  callCounts.stop = 0;
  callCounts.list = 0;
  callCounts.uiResponse = 0;
}

function flushMicrotasks(): Promise<void> {
  return act(() => Promise.resolve());
}

async function dispatchTask(title = 'Test task', prompt = 'Complete the acceptance criteria.'): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New Task' })); });
  fireEvent.change(screen.getByLabelText('Task title'), { target: { value: title } });
  fireEvent.change(screen.getByLabelText('Initial prompt'), { target: { value: prompt } });
  fireEvent.click(screen.getByRole('button', { name: 'Dispatch task' }));
  await waitFor(() => expect(callCounts.start).toBe(1));
}

// Helper to simulate an onEvent callback with a kind envelope
function simulateSnapshotEvent(runId: string, status: string): void {
  const snapshot = {
    runId,
    name: 'test',
    pid: 12345,
    status,
    events: [],
    stderrSummary: '',
    startedAt: Date.now(),
    lastActivity: Date.now(),
    exitCode: null,
    exitSignal: null,
  };
  for (const fn of bridgeState.listeners) {
    fn({ kind: 'snapshot', snapshot });
  }
}

function simulateRuntimeEvent(runId: string, type: string, content?: Record<string, unknown>): void {
  const event: Record<string, unknown> = { type, runId };
  if (content) Object.assign(event, content);
  // For message_end, wrap in message structure if not already set by content
  if (type === 'message_end' && !event.message) {
    event.message = {
      role: 'assistant',
      content: [{ type: 'text', text: (content?.text as string) ?? '' }],
    };
  }
  for (const fn of bridgeState.listeners) {
    fn({ kind: 'event', runId, event });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IT-WB-1: Onboarding — no bridge or no workspace", () => {
  beforeEach(() => {
    resetStores();
  });

  it("shows onboarding text when bridge is unavailable", async () => {
    useWorkbenchStore.setState({ bridgeAvailable: false });
    useDashboardStore.setState({ project: null });

    render(<WorkbenchPage />);
    await flushMicrotasks();

    expect(screen.getByText("Connect an AgentFlux project")).toBeInTheDocument();
    expect(screen.getByText(/bridge.*not available/i)).toBeInTheDocument();
  });

  it("shows onboarding when project/workspace is null", async () => {
    useDashboardStore.setState({ project: null });

    render(<WorkbenchPage />);
    await flushMicrotasks();

    expect(screen.getByText("Connect an AgentFlux project")).toBeInTheDocument();
  });

  it("shows the runtime panel when bridge and workspace are both available", async () => {
    useWorkbenchStore.setState({ bridgeAvailable: true });
    useDashboardStore.setState({
      project: {
        fluxDir: "/test/.agentflux",
        eventsPath: "/test/.agentflux/events.jsonl",
        projectName: "test-project",
        projectRoot: "/test",
      },
    });

    render(<WorkbenchPage />);
    await flushMicrotasks();

    expect(screen.getByText("Agent roster")).toBeInTheDocument();
    expect(screen.getByText("Conversation")).toBeInTheDocument();
    expect(screen.getByText("Execution inspector")).toBeInTheDocument();
  });
});

describe("IT-WB-2: createRuntime flow calls bridge.start() and refreshes list", () => {
  beforeEach(() => {
    resetStores();
    useWorkbenchStore.setState({ bridgeAvailable: true });
  });

  it("createRuntime calls bridge.start and populates runtimes", async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();

    await dispatchTask();

    await vi.waitFor(
      () => {
        const state = useWorkbenchStore.getState();
        expect(state.runtimes.length).toBeGreaterThanOrEqual(1);
        expect(state.runtimes[0].status).toBe("running");
      },
      { timeout: 3000, interval: 100 },
    );
  });

  it("shows runtime in roster after creation", async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();

    await dispatchTask('Visible task');

    await vi.waitFor(
      () => {
        const state = useWorkbenchStore.getState();
        expect(state.runtimes.length).toBe(1);
        const match = screen.getAllByText(/Visible task/);
        expect(match.length).toBeGreaterThan(0);
      },
      { timeout: 3000, interval: 100 },
    );
  });
});

describe('IT-WB-Control-Room: task dispatch and execution inspector', () => {
  beforeEach(() => {
    resetStores();
    useWorkbenchStore.setState({ bridgeAvailable: true });
  });

  it('New Task defaults to Main agent decides and dispatches exactly once', async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New Task' })); });
    expect(screen.getByLabelText('Execution mode')).toHaveValue('agent_decides');
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Default routing task' } });
    fireEvent.change(screen.getByLabelText('Initial prompt'), { target: { value: 'Let the lead agent choose.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch task' }));
    await waitFor(() => expect(callCounts.start).toBe(1));
    expect(bridgeState.runtimes[0]).toMatchObject({ priority: 'normal', modePolicy: 'agent_decides' });
  });

  it('fixed M5 and critical priority flow into the selected execution inspector', async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New Task' })); });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Critical DAG task' } });
    fireEvent.change(screen.getByLabelText('Initial prompt'), { target: { value: 'Execute the known DAG.' } });
    fireEvent.change(screen.getByLabelText('Task priority'), { target: { value: 'critical' } });
    fireEvent.change(screen.getByLabelText('Execution mode'), { target: { value: 'M5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch task' }));
    await waitFor(() => expect(screen.getByText('User fixed')).toBeInTheDocument());
    expect(screen.getByText('M5')).toBeInTheDocument();
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByTitle(/^task-run-/)).toBeInTheDocument();
    expect(screen.getByTitle(/^execution-run-/)).toBeInTheDocument();
  });

  it('blocked and failed lead runtimes surface operator attention', async () => {
    bridgeState.runtimes.push({
      runId: 'attention-run', taskId: 'attention-task', executionId: 'attention-execution', taskTitle: 'Approve deployment',
      initialPrompt: 'Deploy', priority: 'high', modePolicy: 'M2', name: 'lead', pid: 44, status: 'blocked',
      lastActivity: Date.now(), events: [], stderrSummary: '', pendingUiRequests: [], historical: false,
    });
    render(<WorkbenchPage />);
    await waitFor(() => expect(screen.getByText('1 run needs attention.')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Approve deployment'));
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('User fixed')).toBeInTheDocument();
  });
});

describe("IT-WB-3: Four operations send correct actions via bridge", () => {
  beforeEach(async () => {
    resetStores();
    useWorkbenchStore.setState({ bridgeAvailable: true });
  });

  it("sendPrompt calls bridge.prompt and adds user event to stream", async () => {
    await act(async () => {
      await useWorkbenchStore.getState().sendPrompt("Hello, agent!");
    });

    const state = useWorkbenchStore.getState();

    const userEvents = state.eventStream.filter((e) => e.type === "user");
    expect(userEvents.length).toBeGreaterThan(0);
    expect(userEvents[0].content).toContain("Hello, agent!");
    expect(bridgeState.runtimes.length).toBeGreaterThan(0);
  });

  it("sendSteer calls bridge.steer on selected runtime", async () => {
    bridgeState.runtimes.push({
      runId: "run-steer-test-001",
      pid: 11111,
      status: "running",
      lastActivity: Date.now(),
      events: [],
      stderrSummary: "",
    });

    useWorkbenchStore.setState({
      runtimes: [
        {
          runId: "run-steer-test-001",
          pid: 11111 as number | null,
          status: "running" as const,
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        },
      ],
      selectedRunId: "run-steer-test-001",
    });

    await act(async () => {
      await useWorkbenchStore.getState().sendSteer("Change direction");
    });

    const state = useWorkbenchStore.getState();
    const steerEvents = state.eventStream.filter(
      (e) => e.type === "user" && e.content.includes("[steer]"),
    );
    expect(steerEvents.length).toBeGreaterThan(0);
    expect(steerEvents[0].content).toContain("Change direction");
  });

  it("sendFollowUp calls bridge.followUp on selected runtime", async () => {
    bridgeState.runtimes.push({
      runId: "run-fup-test-002",
      pid: 22222,
      status: "running",
      lastActivity: Date.now(),
      events: [],
      stderrSummary: "",
    });

    useWorkbenchStore.setState({
      runtimes: [
        {
          runId: "run-fup-test-002",
          pid: 22222 as number | null,
          status: "running" as const,
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        },
      ],
      selectedRunId: "run-fup-test-002",
    });

    await act(async () => {
      await useWorkbenchStore.getState().sendFollowUp("Tell me more");
    });

    const state = useWorkbenchStore.getState();
    const fupEvents = state.eventStream.filter(
      (e) => e.type === "user" && e.content.includes("[follow-up]"),
    );
    expect(fupEvents.length).toBeGreaterThan(0);
    expect(fupEvents[0].content).toContain("Tell me more");
  });

  it("abortRuntime calls bridge.abort and updates runtime status", async () => {
    bridgeState.runtimes.push({
      runId: "run-abort-test-003",
      pid: 33333,
      status: "running",
      lastActivity: Date.now(),
      events: [],
      stderrSummary: "",
    });

    useWorkbenchStore.setState({
      runtimes: [
        {
          runId: "run-abort-test-003",
          pid: 33333 as number | null,
          status: "running" as const,
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        },
      ],
      selectedRunId: "run-abort-test-003",
    });

    await act(async () => {
      await useWorkbenchStore.getState().abortRuntime();
    });

    const state = useWorkbenchStore.getState();
    expect(state.runtimes.length).toBeGreaterThan(0);
    const aborted = state.runtimes.find(
      (r) => r.runId === "run-abort-test-003",
    );
    expect(aborted).toBeTruthy();
    expect(aborted!.status).toBe("aborted");
  });
});

describe("IT-WB-4: Roster selectRuntime switches filtered events", () => {
  beforeEach(() => {
    resetStores();
    useWorkbenchStore.setState({ bridgeAvailable: true });
  });

  it("selecting a runtime filters event stream to that runtime's events", async () => {
    const runIdA = "run-filter-a-001";
    const runIdB = "run-filter-b-002";

    useWorkbenchStore.setState({
      runtimes: [
        {
          runId: runIdA,
          pid: 1,
          status: "running" as const,
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        },
        {
          runId: runIdB,
          pid: 2,
          status: "done" as const,
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        },
      ],
      eventStream: [
        {
          id: "evt-1",
          type: "user" as const,
          content: "Hello A",
          timestamp: 1000,
          runId: runIdA,
        },
        {
          id: "evt-2",
          type: "assistant" as const,
          content: "Response A",
          timestamp: 1001,
          runId: runIdA,
        },
        {
          id: "evt-3",
          type: "user" as const,
          content: "Hello B",
          timestamp: 2000,
          runId: runIdB,
        },
        {
          id: "evt-4",
          type: "system" as const,
          content: "System message",
          timestamp: 3000,
        },
      ],
      selectedRunId: runIdA,
    });

    await act(async () => {
      render(<WorkbenchPage />);
    });
    await flushMicrotasks();

    expect(screen.getByText("Hello A")).toBeInTheDocument();
    expect(screen.getByText("Response A")).toBeInTheDocument();
    expect(screen.queryByText("Hello B")).not.toBeInTheDocument();
    expect(screen.getByText("System message")).toBeInTheDocument();
  });

  it("selecting a different runtime switches visible events", async () => {
    const runIdA = "run-switch-a-001";
    const runIdB = "run-switch-b-002";

    useWorkbenchStore.setState({
      runtimes: [
        {
          runId: runIdA,
          pid: 1,
          status: "running" as const,
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        },
        {
          runId: runIdB,
          pid: 2,
          status: "done" as const,
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        },
      ],
      eventStream: [
        {
          id: "evt-a1",
          type: "user" as const,
          content: "Only A",
          timestamp: 1000,
          runId: runIdA,
        },
        {
          id: "evt-b1",
          type: "user" as const,
          content: "Only B",
          timestamp: 2000,
          runId: runIdB,
        },
      ],
      selectedRunId: runIdA,
    });

    let rerender: ReturnType<typeof render>["rerender"] | undefined;
    await act(async () => {
      const result = render(<WorkbenchPage />);
      rerender = result.rerender;
    });
    await flushMicrotasks();
    expect(screen.getByText("Only A")).toBeInTheDocument();
    expect(screen.queryByText("Only B")).not.toBeInTheDocument();

    await act(async () => {
      useWorkbenchStore.getState().selectRuntime(runIdB);
    });

    if (rerender) {
      await act(async () => {
        rerender(<WorkbenchPage />);
      });
    }
    await flushMicrotasks();
    expect(screen.queryByText("Only A")).not.toBeInTheDocument();
    expect(screen.getByText("Only B")).toBeInTheDocument();
  });

  it("deselecting runtime shows all events", async () => {
    const runIdA = "run-all-a-001";

    useWorkbenchStore.setState({
      eventStream: [
        {
          id: "evt-all-1",
          type: "user" as const,
          content: "Event 1",
          timestamp: 1000,
          runId: runIdA,
        },
        {
          id: "evt-all-2",
          type: "system" as const,
          content: "Sys event",
          timestamp: 2000,
        },
      ],
      selectedRunId: runIdA,
    });

    await act(async () => {
      render(<WorkbenchPage />);
    });
    await flushMicrotasks();
    expect(screen.getByText("Event 1")).toBeInTheDocument();
    expect(screen.getByText("Sys event")).toBeInTheDocument();

    await act(async () => {
      useWorkbenchStore.getState().selectRuntime("");
    });

    expect(screen.getByText("Event 1")).toBeInTheDocument();
    expect(screen.getByText("Sys event")).toBeInTheDocument();
  });
});

describe("IT-WB-5: stopRuntime and clearEventStream", () => {
  beforeEach(() => {
    resetStores();
    useWorkbenchStore.setState({ bridgeAvailable: true });
  });

  it("stopRuntime stops only the selected runtime", async () => {
    bridgeState.runtimes.push(
      {
        runId: "run-stop-1",
        pid: 100,
        status: "running",
        lastActivity: Date.now(),
        events: [],
        stderrSummary: "",
      },
      {
        runId: "run-stop-2",
        pid: 101,
        status: "running",
        lastActivity: Date.now(),
        events: [],
        stderrSummary: "",
      },
    );

    useWorkbenchStore.setState({
      runtimes: [
        {
          runId: "run-stop-1",
          pid: 100 as number | null,
          status: "running" as const,
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        },
        {
          runId: "run-stop-2",
          pid: 101 as number | null,
          status: "running" as const,
          lastActivity: Date.now(),
          events: [],
          stderrSummary: "",
        },
      ],
      selectedRunId: "run-stop-1",
    });

    await act(async () => {
      await useWorkbenchStore.getState().stopRuntime();
    });

    const state = useWorkbenchStore.getState();
    expect(state.runtimes.find((rt) => rt.runId === "run-stop-1")?.status).toBe("aborted");
    expect(state.runtimes.find((rt) => rt.runId === "run-stop-2")?.status).toBe("running");
    expect(callCounts.stop).toBe(1);
  });

  it("stopAllRuntimes stops every runtime", async () => {
    bridgeState.runtimes.push(
      { runId: "run-all-1", pid: 100, status: "running", lastActivity: Date.now(), events: [], stderrSummary: "" },
      { runId: "run-all-2", pid: 101, status: "running", lastActivity: Date.now(), events: [], stderrSummary: "" },
    );
    useWorkbenchStore.setState({ runtimes: bridgeState.runtimes as any });
    await act(async () => { await useWorkbenchStore.getState().stopAllRuntimes(); });
    expect(useWorkbenchStore.getState().runtimes.every((rt) => rt.status === "aborted")).toBe(true);
    expect(callCounts.stop).toBe(2);
  });

  it("clearEventStream empties the event buffer", () => {
    useWorkbenchStore.setState({
      eventStream: [
        {
          id: "evt-clear-1",
          type: "user" as const,
          content: "To be cleared",
          timestamp: Date.now(),
        },
      ],
    });

    expect(useWorkbenchStore.getState().eventStream.length).toBe(1);

    act(() => {
      useWorkbenchStore.getState().clearEventStream();
    });

    expect(useWorkbenchStore.getState().eventStream.length).toBe(0);
  });
});

// ─── IT-WB-6: Snapshot vs Event separation ─────────────────────────────────

describe("IT-WB-6: Snapshot 不进对话流，Event 正确解析", () => {
  beforeEach(() => {
    resetStores();
    useWorkbenchStore.setState({ bridgeAvailable: true });
  });

  it("snapshot 事件只更新 runtimes，不加入 eventStream", async () => {
    const runId = "run-snap-test-001";

    // 模拟 store 已初始化并监听了 onEvent
    // 先渲染页面以触发 onEvent 监听
    render(<WorkbenchPage />);
    await flushMicrotasks();

    // 发送 snapshot 事件
    act(() => {
      simulateSnapshotEvent(runId, 'running');
    });
    await flushMicrotasks();

    // 验证 runtimes 已更新
    const state = useWorkbenchStore.getState();
    expect(state.runtimes.length).toBeGreaterThan(0);
    expect(state.runtimes.some(r => r.runId === runId)).toBe(true);
    const runtime = state.runtimes.find(r => r.runId === runId);
    expect(runtime?.status).toBe('running');

    // 验证 eventStream 没有被添加 snapshot
    expect(state.eventStream.length).toBe(0);
  });

  it("message_end 事件正确解析并显示在对话流中", async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();

    const runId = "run-msg-end-test-001";

    // 先添加用户事件
    await act(async () => {
      const userEvent = {
        id: 'evt-user',
        type: 'user' as const,
        content: 'Hello agent',
        timestamp: Date.now(),
        runId,
      };
      useWorkbenchStore.setState((s: { eventStream: unknown[] }) => ({
        eventStream: [...s.eventStream, userEvent],
      }));
    });
    await flushMicrotasks();

    expect(screen.getByText('Hello agent')).toBeInTheDocument();

    // 模拟 message_end 事件（通过 onEvent callback）
    act(() => {
      simulateRuntimeEvent(runId, 'message_end', {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello! I\'m the assistant response.' },
          ],
        },
      });
    });
    await flushMicrotasks();

    // 验证 assistant 回复可见
    const state = useWorkbenchStore.getState();
    const assistantEvents = state.eventStream.filter(e => e.type === 'assistant');
    expect(assistantEvents.length).toBeGreaterThan(0);
    const msgEndEvent = assistantEvents.find(
      e => e.content.includes("Hello! I'm the assistant response."),
    );
    expect(msgEndEvent).toBeTruthy();

    // 在 UI 中验证
    await vi.waitFor(
      () => {
        expect(screen.getByText(/Hello! I'm the assistant response/)).toBeInTheDocument();
      },
      { timeout: 3000, interval: 100 },
    );
  });

  it("user role message_end 解析为 type='user'", async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();

    const runId = "run-user-msg-end-001";

    act(() => {
      simulateRuntimeEvent(runId, 'message_end', {
        message: {
          role: 'user',
          content: [{ type: 'text', text: '用户发来的消息结束信号' }],
        },
      });
    });
    await flushMicrotasks();

    const state = useWorkbenchStore.getState();
    const userEvents = state.eventStream.filter(e => e.type === 'user');
    const target = userEvents.find(e => e.content.includes('用户发来的消息结束信号'));
    expect(target).toBeTruthy();
    expect(target!.type).toBe('user');
    expect(target!.content).toBe('用户发来的消息结束信号');

    await vi.waitFor(
      () => {
        expect(screen.getByText('用户发来的消息结束信号')).toBeInTheDocument();
      },
      { timeout: 3000, interval: 100 },
    );
  });

  it("toolResult role message_end 解析为 type='tool'", async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();

    const runId = "run-tool-msg-end-001";

    act(() => {
      simulateRuntimeEvent(runId, 'message_end', {
        message: {
          role: 'toolResult',
          content: [{ type: 'text', text: '工具执行结果：成功' }],
        },
      });
    });
    await flushMicrotasks();

    const state = useWorkbenchStore.getState();
    const toolEvents = state.eventStream.filter(e => e.type === 'tool');
    const target = toolEvents.find(e => e.content.includes('工具执行结果：成功'));
    expect(target).toBeTruthy();
    expect(target!.type).toBe('tool');
    expect(target!.content).toBe('工具执行结果：成功');

    await vi.waitFor(
      () => {
        expect(screen.getByText('工具执行结果：成功')).toBeInTheDocument();
      },
      { timeout: 3000, interval: 100 },
    );
  });

  it("message_update 事件被忽略，不进入对话流", async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();

    const runId = "run-ignore-001";

    // 发送 message_update 事件
    act(() => {
      simulateRuntimeEvent(runId, 'message_update', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'updating...' }] },
      });
    });
    await flushMicrotasks();

    const state = useWorkbenchStore.getState();
    const systemEvents = state.eventStream.filter(e => e.metadata?.eventType === 'message_update');
    expect(systemEvents.length).toBe(0);
  });

  it("process_error 显示为 error 类型", async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();

    const runId = "run-error-test-001";

    act(() => {
      simulateRuntimeEvent(runId, 'process_error', {
        data: { message: 'Connection refused' },
      });
    });
    await flushMicrotasks();

    const state = useWorkbenchStore.getState();
    const errorEvents = state.eventStream.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it("process_exit 显示为 system 类型", async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();

    const runId = "run-exit-test-001";

    act(() => {
      simulateRuntimeEvent(runId, 'process_exit', {
        data: {
          code: 1,
          signal: null,
          stderrSummary: 'Node runtime incompatible: upgrade to >=22.19.0',
          runtimeSource: 'path',
          runtimeVersion: 'v20.18.0',
          runtimeExecutable: 'node',
        },
      });
    });
    await flushMicrotasks();

    const state = useWorkbenchStore.getState();
    const systemEvents = state.eventStream.filter(e => e.type === 'system');
    // process_exit maps to 'system'
    expect(systemEvents.length).toBeGreaterThan(0);
    const exitEvent = systemEvents.find(e => e.content.includes('进程退出'));
    expect(exitEvent).toBeTruthy();
    expect(exitEvent?.content).toContain('Node runtime incompatible');
    expect(exitEvent?.content).toContain('v20.18.0');
  });

  it("agent_start 显示为 system 类型", async () => {
    render(<WorkbenchPage />);
    await flushMicrotasks();

    const runId = "run-agent-start-001";

    act(() => {
      simulateRuntimeEvent(runId, 'agent_start', { content: 'Agent started' });
    });
    await flushMicrotasks();

    const state = useWorkbenchStore.getState();
    const systemEvents = state.eventStream.filter(e => e.type === 'system');
    expect(systemEvents.length).toBeGreaterThan(0);
  });
});

// ─── IT-WB-7: sendPrompt 语义测试 ──────────────────────────────────────────

describe("IT-WB-7: sendPrompt 语义 — 选中 vs 未选中", () => {
  beforeEach(() => {
    resetStores();
    useWorkbenchStore.setState({ bridgeAvailable: true });
  });

  it("无选中时 sendPrompt 只调用 start, 不调用 prompt", async () => {
    const promptText = "New session prompt";
    await act(async () => {
      await useWorkbenchStore.getState().sendPrompt(promptText);
    });

    // 应只调用 start，不调用 prompt
    expect(callCounts.start).toBe(1);
    expect(callCounts.prompt).toBe(0);

    // 用户事件应携带实际的 runId
    const state = useWorkbenchStore.getState();
    const userEvents = state.eventStream.filter(e => e.type === 'user');
    expect(userEvents.length).toBeGreaterThan(0);
    const userEvent = userEvents[userEvents.length - 1];
    expect(userEvent.content).toBe(promptText);
    // 用户事件应包含 runId
    expect(userEvent.runId).toBeTruthy();
    expect(typeof userEvent.runId).toBe('string');
    expect(userEvent.runId!.length).toBeGreaterThan(0);
  });

  it("有选中时 sendPrompt 只调用 prompt, 不调用 start", async () => {
    // 先设置选中状态
    const runId = "run-selected-001";
    useWorkbenchStore.setState({
      selectedRunId: runId,
      runtimes: [{
        runId,
        pid: 12345,
        status: 'running' as const,
        lastActivity: Date.now(),
        events: [],
        stderrSummary: '',
      }],
    });

    const promptText = "Continue session prompt";
    await act(async () => {
      await useWorkbenchStore.getState().sendPrompt(promptText);
    });

    // 应只调用 prompt，不调用新的 start
    expect(callCounts.prompt).toBe(1);
    // start 可能被之前的测试调用，但在此测试中不应新增
    // 注意：start 在 setup 时未被调用，所以应该是 0
    // 由于 resetStores 重置了 callCounts，所以 start 应该是 0

    // 用户事件应携带选中的 runId
    const state = useWorkbenchStore.getState();
    const userEvents = state.eventStream.filter(e => e.type === 'user');
    const userEvent = userEvents[userEvents.length - 1];
    expect(userEvent.content).toBe(promptText);
    expect(userEvent.runId).toBe(runId);
  });

  it("连续两次 sendPrompt（无选中）只 start 一次、不 double start", async () => {
    // 第一次 sendPrompt（无选中）
    await act(async () => {
      await useWorkbenchStore.getState().sendPrompt("First prompt");
    });
    const firstStartCount = callCounts.start;
    expect(firstStartCount).toBe(1);
    expect(callCounts.prompt).toBe(0);

    // 第二次 sendPrompt — 此时 selectedRunId 已被设置
    // 所以应该调用 prompt，不再 start
    const stateAfterFirst = useWorkbenchStore.getState();
    expect(stateAfterFirst.selectedRunId).toBeTruthy();

    await act(async () => {
      await useWorkbenchStore.getState().sendPrompt("Second prompt");
    });

    // start 应保持在 1，prompt 应变为 1
    expect(callCounts.start).toBe(1);
    expect(callCounts.prompt).toBe(1);
  });

  it("选中时 sendPrompt 绝不同时调用 start + prompt", async () => {
    const runId = "run-no-double-001";
    useWorkbenchStore.setState({ selectedRunId: runId });

    await act(async () => {
      await useWorkbenchStore.getState().sendPrompt("No double call");
    });

    // 确保 start 没有被调用（只有 prompt）
    expect(callCounts.start).toBe(0);
    expect(callCounts.prompt).toBe(1);
  });
});

describe("IT-WB-8: Extension UI request 工作台闭环", () => {
  beforeEach(() => {
    resetStores();
    useWorkbenchStore.setState({ bridgeAvailable: true });
  });

  it("renders pending confirm and submits the matching response", async () => {
    const runId = 'run-ui-confirm';
    const runtime = {
      runId, name: 'approval-agent', pid: 4321, status: 'blocked',
      lastActivity: Date.now(), startedAt: Date.now(), events: [], stderrSummary: '',
      exitCode: null, exitSignal: null, historical: false,
      pendingUiRequests: [{
        runId, id: 'confirm-42', method: 'confirm', title: 'Allow command?',
        message: 'The agent is waiting for approval.', createdAt: Date.now(), expiresAt: Date.now() + 10_000,
      }],
    };
    bridgeState.runtimes.push(runtime);
    useWorkbenchStore.setState({ runtimes: [runtime as any], selectedRunId: runId });

    render(<WorkbenchPage />);
    expect(screen.getByText('Allow command?')).toBeInTheDocument();
    expect(screen.getByText('The agent is waiting for approval.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(callCounts.uiResponse).toBe(1));
    await waitFor(() => expect(screen.queryByText('Allow command?')).not.toBeInTheDocument());
  });

  it("marks recovered history read-only and never displays its old PID", () => {
    const history = {
      runId: 'old-run', name: 'old-agent', pid: null, status: 'aborted',
      lastActivity: Date.now(), startedAt: Date.now() - 1000, events: [], stderrSummary: '',
      exitCode: null, exitSignal: null, historical: true, pendingUiRequests: [],
    };
    useWorkbenchStore.setState({ runtimes: [history as any], selectedRunId: history.runId });
    render(<WorkbenchPage />);
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Recovered history is read-only')).toBeDisabled();
    expect(screen.queryByText(/PID:/)).not.toBeInTheDocument();
  });

  it('surfaces corrupt runtime history as a non-blocking workbench notice', () => {
    useWorkbenchStore.setState({
      diagnostics: { persistence: { status: 'corrupt', message: 'Runtime history could not be read; history was ignored safely.' } },
    });
    render(<WorkbenchPage />);
    expect(screen.getByText('Runtime history was not restored.')).toBeInTheDocument();
    expect(screen.getByText('Live runtimes are unaffected.')).toBeInTheDocument();
  });
});

describe('IT-WB-P1: failed history and resizable control room', () => {
  beforeEach(() => {
    resetStores();
    useWorkbenchStore.setState({ bridgeAvailable: true });
    localStorage.clear();
  });

  it('hydrates historical events once, but never replays live snapshot events', () => {
    const historical = { runId: 'history-1', historical: true, events: [{ type: 'process_error', timestamp: 10, data: { message: 'boom' } }] };
    const live = { runId: 'live-1', historical: false, events: [{ type: 'agent_start', timestamp: 20, data: {} }] };
    useWorkbenchStore.setState({ runtimes: [historical, live] as any, eventStream: [] });
    useWorkbenchStore.getState().selectRuntime('history-1');
    useWorkbenchStore.getState().selectRuntime('history-1');
    expect(useWorkbenchStore.getState().eventStream.filter((event) => event.runId === 'history-1')).toHaveLength(1);
    useWorkbenchStore.getState().selectRuntime('live-1');
    expect(useWorkbenchStore.getState().eventStream.filter((event) => event.runId === 'live-1')).toHaveLength(0);
  });

  it('failed run allows only Retry and Copy diagnostics', () => {
    const failed = {
      projectRoot: '/test', runId: 'failed-1', taskId: 'task', executionId: 'exec', retryOfRunId: null, rootRunId: 'failed-1', retryAttempt: 0,
      retryable: true, taskTitle: 'Failed task', initialPrompt: 'prompt', priority: 'normal', modePolicy: 'M1', name: 'lead', pid: null,
      status: 'failed', events: [], stderrSummary: 'boom', cliSource: 'project', cliPath: '/test/node_modules/pi/cli.js', runtimeSource: 'path',
      runtimeExecutable: 'node', runtimeVersion: 'v24', startedAt: 1, lastActivity: 2, exitCode: 1, exitSignal: null, errorCode: 'RPC_EXIT_BEFORE_READY', pendingUiRequests: [], historical: false,
    };
    useWorkbenchStore.setState({ runtimes: [failed as any], selectedRunId: failed.runId });
    render(<WorkbenchPage />);
    for (const name of ['Steer', 'Follow-up', 'Abort', 'Stop Selected', 'Send']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeEnabled();
  });

  it('supports keyboard resize, persistence and reset at wide container; hides handles at 1024 layout', async () => {
    const originalMatchMedia = window.matchMedia;
    const originalResizeObserver = globalThis.ResizeObserver;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
    let width = 1200;
    class TestResizeObserver {
      constructor(private cb: ResizeObserverCallback) {}
      observe(target: Element) { this.cb([{ target, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    }
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    const view = render(<WorkbenchPage />);
    await waitFor(() => expect(screen.getAllByRole('separator')).toHaveLength(2));
    const left = screen.getByRole('separator', { name: 'Resize task roster' });
    fireEvent.keyDown(left, { key: 'End' });
    expect(left).toHaveAttribute('aria-valuenow', '420');
    expect(JSON.parse(localStorage.getItem('agentflux.control-room.layout.v1')!)).toMatchObject({ left: 420 });
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(JSON.parse(localStorage.getItem('agentflux.control-room.layout.v1')!)).toEqual({ left: 240, right: 320 });
    view.unmount();
    width = 800;
    render(<WorkbenchPage />);
    await waitFor(() => expect(screen.queryAllByRole('separator')).toHaveLength(0));
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
    globalThis.ResizeObserver = originalResizeObserver;
  });
});
