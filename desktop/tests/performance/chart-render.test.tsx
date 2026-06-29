/**
 * P-1 ~ P-2: Chart Rendering Performance Benchmarks
 * Measures render time for Recharts components with varying data sizes.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

// Minimal recharts mock — just render children to DOM (no canvas)
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => React.createElement("div", { style: { width: 800, height: 300 } }, children),
  ScatterChart: ({ children }: any) => React.createElement("div", null, children),
  LineChart: ({ children }: any) => React.createElement("div", null, children),
  PieChart: ({ children }: any) => React.createElement("div", null, children),
  BarChart: ({ children }: any) => React.createElement("div", null, children),
  Scatter: ({ data }: any) => React.createElement("div", null, `${data?.length ?? 0} points`),
  Line: ({ data }: any) => React.createElement("div", null, `${data?.length ?? 0} points`),
  Pie: ({ data }: any) => React.createElement("div", null, `${data?.length ?? 0} slices`),
  Bar: ({ data }: any) => React.createElement("div", null, `${data?.length ?? 0} bars`),
  XAxis: () => null,
  YAxis: () => null,
  ZAxis: () => null,
  Tooltip: () => null,
  Legend: () => null,
  CartesianGrid: () => null,
  Cell: () => null,
}));

// Mock store + node:fs dependent modules
vi.mock("../../src/lib/file-access", () => ({
  readFile: vi.fn(async () => "{}"), readFileIncremental: vi.fn(async () => ({ data: "", newOffset: 0 })),
  fileSize: vi.fn(async () => 0), pathExists: vi.fn(async () => true),
  writeFile: vi.fn(async () => {}), deleteFile: vi.fn(async () => {}),
}));
vi.mock("../../src/lib/events-parser", () => ({
  parseEventsFile: vi.fn(() => []), parseEventsFileAsync: vi.fn(async () => []),
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
vi.mock("../../src/lib/event-watcher", () => ({ EventWatcher: class { onEvent() { return () => {}; } start() {} stop() {} poll() {} } }));
vi.mock("../../src/lib/project-discovery", () => ({ discoverProject: vi.fn(() => "/test"), validateProjectPath: vi.fn(async () => true) }));

import { useDashboardStore } from "../../src/store/dashboard-store";
import { RouteMap } from "../../src/components/RouteMap";
import { CacheChart } from "../../src/components/CacheChart";

function generateRouteData(n: number) {
  const modes = ["M1", "M2", "M3", "M4", "M5", "M6"];
  return Array.from({ length: n }, (_, i) => ({
    ts: 1000 + i * 1000,
    mode: modes[i % modes.length],
    modeIndex: i % modes.length,
    confidence: 0.5 + Math.random() * 0.5,
    preset: "balanced",
    reason: ["test"],
  }));
}

function generateCacheData(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1000 + i * 1000,
    hitRate: 0.7 + Math.random() * 0.3,
    input: Math.floor(Math.random() * 5000),
    cacheRead: Math.floor(Math.random() * 50000),
  }));
}

describe("P-1: Chart rendering — 100 data points", () => {
  it("RouteMap renders 100 points in < 500ms", () => {
    useDashboardStore.setState({ routeHistory: generateRouteData(100) });
    const start = performance.now();
    render(React.createElement(RouteMap));
    const elapsed = performance.now() - start;
    console.log(`  RouteMap 100 points: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(500);
  });

  it("CacheChart renders 100 points in < 500ms", () => {
    useDashboardStore.setState({
      cacheTrend: generateCacheData(100),
      tokenBreakdown: [{ name: "Input", value: 50000, color: "#3b82f6" }, { name: "Cache", value: 200000, color: "#10b981" }],
    });
    const start = performance.now();
    render(React.createElement(CacheChart));
    const elapsed = performance.now() - start;
    console.log(`  CacheChart 100 points: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("P-2: Chart rendering — 1000 data points", () => {
  it("RouteMap renders 1000 points in < 2s", () => {
    useDashboardStore.setState({ routeHistory: generateRouteData(1000) });
    const start = performance.now();
    render(React.createElement(RouteMap));
    const elapsed = performance.now() - start;
    console.log(`  RouteMap 1000 points: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(2000);
  });

  it("CacheChart renders 1000 points in < 2s", () => {
    useDashboardStore.setState({
      cacheTrend: generateCacheData(1000),
      tokenBreakdown: [{ name: "Input", value: 500000, color: "#3b82f6" }, { name: "Cache", value: 2000000, color: "#10b981" }],
    });
    const start = performance.now();
    render(React.createElement(CacheChart));
    const elapsed = performance.now() - start;
    console.log(`  CacheChart 1000 points: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});
