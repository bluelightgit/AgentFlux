/**
 * IT-5 ~ IT-8: React Component Rendering Tests
 * Components read from Zustand store, so we mock the store state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// Mock recharts to avoid canvas issues in jsdom
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => React.createElement("div", { "data-testid": "responsive-container" }, children),
  ScatterChart: ({ children }: any) => React.createElement("div", { "data-testid": "scatter-chart" }, children),
  LineChart: ({ children }: any) => React.createElement("div", { "data-testid": "line-chart" }, children),
  PieChart: ({ children }: any) => React.createElement("div", { "data-testid": "pie-chart" }, children),
  BarChart: ({ children }: any) => React.createElement("div", { "data-testid": "bar-chart" }, children),
  Scatter: () => React.createElement("div", { "data-testid": "scatter" }),
  Line: () => React.createElement("div", { "data-testid": "line" }),
  Pie: () => React.createElement("div", { "data-testid": "pie" }),
  Bar: () => React.createElement("div", { "data-testid": "bar" }),
  XAxis: () => React.createElement("div"),
  YAxis: () => React.createElement("div"),
  ZAxis: () => React.createElement("div"),
  Tooltip: () => React.createElement("div"),
  Legend: () => React.createElement("div"),
  CartesianGrid: () => React.createElement("div"),
  Cell: () => React.createElement("div"),
}));

// Mock all node:fs dependent modules
vi.mock("../../src/lib/file-access", () => ({
  readFile: vi.fn(async () => "{}"),
  readFileIncremental: vi.fn(async () => ({ data: "", newOffset: 0 })),
  fileSize: vi.fn(async () => 0),
  pathExists: vi.fn(async () => true),
  writeFile: vi.fn(async () => {}),
  deleteFile: vi.fn(async () => {}),
}));
vi.mock("../../src/lib/events-parser", () => ({
  parseEventsFile: vi.fn(() => []),
  parseEventsFileAsync: vi.fn(async () => []),
  parseEventsIncremental: vi.fn(() => ({ events: [], newOffset: 0 })),
  parseEventsIncrementalAsync: vi.fn(async () => ({ events: [], newOffset: 0 })),
  filterByType: vi.fn((events: any[], type: string) => events.filter(e => e.type === type)),
  filterByTimeRange: vi.fn((events: any[]) => events),
}));
vi.mock("../../src/lib/data-aggregator", () => ({
  aggregateRouteHistory: vi.fn(() => []),
  aggregateCacheTrend: vi.fn(() => []),
  aggregateTokenBreakdown: vi.fn(() => null),
  aggregateCostAnalysis: vi.fn(() => ({ byMode: [], byModel: [], byTaskType: [], total: 0, avgPerTurn: 0 })),
  aggregateAgentTimeline: vi.fn(() => []),
  aggregateSummary: vi.fn(() => null),
}));
vi.mock("../../src/lib/event-watcher", () => ({
  EventWatcher: class MockEventWatcher {
    onEvent() { return () => {}; }
    start() {}
    stop() {}
    poll() {}
  },
}));
vi.mock("../../src/lib/project-discovery", () => ({
  discoverProject: vi.fn(() => "/test/project"),
  validateProjectPath: vi.fn(async () => true),
}));

import { useDashboardStore } from "../../src/store/dashboard-store";
import { SummaryCards } from "../../src/components/SummaryCards";
import { RouteMap } from "../../src/components/RouteMap";
import { CacheChart } from "../../src/components/CacheChart";
import { AppShell } from "../../src/components/AppShell";
import { RealTimeCostCounter } from "../../src/components/RealTimeCostCounter";
import { AgentAffinityPanel } from "../../src/components/AgentAffinityPanel";
import { PreferenceRadar } from "../../src/components/PreferenceRadar";

// Mock hooks used by AppShell / TopBar / PreferenceRadar
vi.mock("../../src/hooks/useKeyboardNav", () => ({
  useKeyboardNav: vi.fn(),
}));
vi.mock("../../src/hooks/useCommandPalette", () => ({
  useCommandPalette: vi.fn(() => ({ open: false, close: vi.fn(), toggle: vi.fn() })),
}));
vi.mock("../../src/components/ThemeProvider", () => ({
  useTheme: vi.fn(() => ({ theme: "light", toggleTheme: vi.fn() })),
}));
vi.mock("../../src/components/TitleBar", () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock("../../src/components/GlobalSearchBar", () => ({
  GlobalSearchBar: () => null,
}));
vi.mock("../../src/components/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../../src/lib/format", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Use real implementations for formatTime, formatNum, formatTokens, formatBytes, formatTs, formatPct
    // Only override formatCost for deterministic test output
    formatCost: vi.fn((c: number) => `$${c.toFixed(2)}`),
  };
});

function setStoreState(partial: any) {
  useDashboardStore.setState(partial);
}

// Reset store between tests
beforeEach(() => {
  useDashboardStore.setState({
    currentPage: "overview",
    project: null,
    workspaces: [],
    activeWorkspace: null,
    events: [],
    autoRefresh: true,
    loading: false,
    error: null,
  });
});

describe("IT-5: RouteMap renders with routing data", () => {
  beforeEach(() => setStoreState({
    routeHistory: [
      { ts: 1000, mode: "M2", modeIndex: 1, confidence: 0.84, preset: "balanced", reason: ["test"] },
      { ts: 2000, mode: "M4", modeIndex: 3, confidence: 0.90, preset: "accurate", reason: ["test2"] },
    ],
  }));

  it("renders scatter chart with routing decisions", () => {
    render(React.createElement(RouteMap));
    expect(screen.getByTestId("scatter-chart")).toBeInTheDocument();
  });

  it("renders empty state when no data", () => {
    setStoreState({ routeHistory: [] });
    render(React.createElement(RouteMap));
    expect(screen.getByText(/Route Map|No routing/i)).toBeTruthy();
  });
});

describe("IT-6: CacheChart renders dual charts", () => {
  beforeEach(() => setStoreState({
    cacheTrend: [
      { ts: 1000, hitRate: 0.85, input: 1000, cacheRead: 5000 },
      { ts: 2000, hitRate: 0.80, input: 2000, cacheRead: 8000 },
    ],
    tokenBreakdown: [
      { name: "Input", value: 3000, color: "#3b82f6" },
      { name: "Cache Read", value: 13000, color: "#10b981" },
    ],
  }));

  it("renders line chart and pie chart", () => {
    render(React.createElement(CacheChart));
    expect(screen.getByTestId("line-chart")).toBeInTheDocument();
    expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
  });
});

describe("IT-7: SummaryCards renders metric cards", () => {
  it("renders all 6 metric cards with values", () => {
    setStoreState({
      summary: {
        totalEvents: 1000,
        totalCost: 13.73,
        avgCacheHit: 0.949,
        routingDecisions: 15,
        subagentRuns: 140,
        cacheSamples: 775,
        timeRange: { earliest: 1000, latest: 2000 },
      },
    });
    render(React.createElement(SummaryCards));
    // SummaryCards formats 1000 as "1.0k"
    expect(screen.getByText("1.0k")).toBeInTheDocument();
    expect(screen.getByText("$13.73")).toBeInTheDocument();
  });

  it("renders null when summary is null", () => {
    setStoreState({ summary: null });
    const { container } = render(React.createElement(SummaryCards));
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IT-8: AppShell — Live indicator states
// ---------------------------------------------------------------------------
describe("IT-8: AppShell renders with correct Live indicator states", () => {
  it("shows amber dot + 'Local data' when events exist", () => {
    setStoreState({
      project: { fluxDir: "/test", eventsPath: "/test/events.jsonl", projectName: "test", projectRoot: "/test" },
      events: [{ type: "test" }],
    });
    render(React.createElement(AppShell, null, React.createElement("div", null, "child")));
    expect(screen.getByText("Local data")).toBeInTheDocument();
    expect(screen.getByLabelText("Local data available")).toBeInTheDocument();
  });

  it("shows amber dot + 'Local data' when isLive is false but events exist (backend unavailable scenario)", () => {
    setStoreState({
      project: { fluxDir: "/test", eventsPath: "/test/events.jsonl", projectName: "test", projectRoot: "/test" },
      events: [{ type: "test" }],
    });
    render(React.createElement(AppShell, null, React.createElement("div", null, "child")));
    expect(screen.getByText("Local data")).toBeInTheDocument();
  });

  it("shows grey dot + 'Offline snapshot' when no project is loaded", () => {
    setStoreState({
      project: null,
      events: [],
    });
    render(React.createElement(AppShell, null, React.createElement("div", null, "child")));
    expect(screen.getByText("Offline snapshot")).toBeInTheDocument();
    expect(screen.getByLabelText("No live data source")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// IT-9: RealTimeCostCounter — data source status
// ---------------------------------------------------------------------------
describe("IT-9: RealTimeCostCounter status indicators", () => {
  beforeEach(() => {
    (window as any).api = {
      ipcRenderer: { invoke: vi.fn(async () => "[]") } as any,
      readFile: vi.fn(async () => "[]"),
    };
  });

  it("shows loading state initially", () => {
    setStoreState({ project: { fluxDir: "/test", eventsPath: "/test/events.jsonl", projectName: "test", projectRoot: "/test" } });
    render(React.createElement(RealTimeCostCounter));
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Tracked subagent cost")).toBeInTheDocument();
  });

  it("shows cost when events are parsed successfully", async () => {
    const { parseEventsFileAsync } = await import("../../src/lib/events-parser");
    (parseEventsFileAsync as any).mockResolvedValue([
      { type: "subagent.run", costUsd: 1.5 },
      { type: "subagent.run", costUsd: 2.3 },
    ]);
    setStoreState({ project: { fluxDir: "/test", eventsPath: "/test/events.jsonl", projectName: "test", projectRoot: "/test" } });
    render(React.createElement(RealTimeCostCounter));
    // After the async load completes, the component should show cost
    await vi.waitFor(() => {
      expect(screen.getByText("$3.80")).toBeInTheDocument();
    });
    expect(screen.getByText("Tracked subagent cost")).toBeInTheDocument();
  });

  it("shows muted $0 (0 runs) when parseEventsFileAsync throws (file missing)", async () => {
    const { parseEventsFileAsync } = await import("../../src/lib/events-parser");
    (parseEventsFileAsync as any).mockRejectedValue(new Error("File not found"));
    setStoreState({ project: { fluxDir: "/test", eventsPath: "/test/events.jsonl", projectName: "test", projectRoot: "/test" } });
    render(React.createElement(RealTimeCostCounter));
    await vi.waitFor(() => {
      expect(screen.getByText("$0.00")).toBeInTheDocument();
      expect(screen.getByText("(0 runs)")).toBeInTheDocument();
    });
    expect(screen.getByText("Tracked subagent cost")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// IT-10: AgentAffinityPanel — static sample data badge
// ---------------------------------------------------------------------------
describe("IT-10: AgentAffinityPanel static data badge", () => {
  it("renders the 🧪 Sample Data badge", () => {
    render(React.createElement(AgentAffinityPanel));
    expect(screen.getByText("🧪 Sample Data")).toBeInTheDocument();
  });

  it("renders all 5 roles and 5 models", () => {
    render(React.createElement(AgentAffinityPanel));
    ["planner", "implementer", "reviewer", "tester", "designer"].forEach((role) => {
      expect(screen.getByText(role)).toBeInTheDocument();
    });
    ["gpt-5.5", "oa/glm-5.2", "deepseek-v4-flash", "deepseek-v4-pro", "qwen3.7-max"].forEach((model) => {
      const titles = screen.getAllByTitle(model);
      expect(titles.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("indicates static example data in the legend", () => {
    render(React.createElement(AgentAffinityPanel));
    expect(screen.getByText(/static example data/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// IT-11: PreferenceRadar — IPC connection indicator
// ---------------------------------------------------------------------------
describe("IT-11: PreferenceRadar IPC connection indicator", () => {
  it("shows '✅ Connected' when IPC is available and project is configured", () => {
    (window as any).api = { ipcRenderer: { invoke: vi.fn(async () => "{}") } as any };
    setStoreState({
      project: { fluxDir: "/test", eventsPath: "/test/events.jsonl", projectName: "test", projectRoot: "/test" },
    });
    render(React.createElement(PreferenceRadar));
    expect(screen.getByText("✅ Connected")).toBeInTheDocument();
    expect(screen.getByText("Simulation estimate")).toBeInTheDocument();
  });

  it("shows '⚠️ Read-Only' when IPC is unavailable", () => {
    (window as any).api = undefined;
    setStoreState({
      project: { fluxDir: "/test", eventsPath: "/test/events.jsonl", projectName: "test", projectRoot: "/test" },
    });
    render(React.createElement(PreferenceRadar));
    expect(screen.getByText("⚠️ Read-Only")).toBeInTheDocument();
    expect(screen.getByText("Simulation estimate")).toBeInTheDocument();
  });

  it("shows '🚫 No Project' when project is null", () => {
    (window as any).api = { ipcRenderer: { invoke: vi.fn() } as any };
    setStoreState({ project: null });
    render(React.createElement(PreferenceRadar));
    expect(screen.getByText("🚫 No Project")).toBeInTheDocument();
    expect(screen.getByText("Simulation estimate")).toBeInTheDocument();
  });
});
