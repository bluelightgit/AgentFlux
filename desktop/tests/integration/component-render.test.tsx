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

function setStoreState(partial: any) {
  useDashboardStore.setState(partial);
}

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
