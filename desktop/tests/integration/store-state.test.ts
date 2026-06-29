/**
 * IT-3 ~ IT-4: Zustand Store State Integration Tests
 * Tests store init, recompute, setTimeRange, setAutoRefresh
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock events-parser to return predictable data
vi.mock("../../src/lib/events-parser", () => ({
  parseEventsFile: vi.fn(() => [
    { type: "cache.sample", ts: 1000, sessionId: "s1", turnIndex: 0, model: "test", mode: "M2", stage: "Growth", role: "doer", preset: "balanced", input: 1000, output: 500, cacheRead: 5000, cacheWrite: 0, costUsd: 0.001, contextTokens: 10000, contextWindow: 1000000, contextPercent: 0.01, cacheHitRate: 0.83, v: 2 },
    { type: "cache.sample", ts: 2000, sessionId: "s1", turnIndex: 1, model: "test", mode: "M2", stage: "Growth", role: "doer", preset: "balanced", input: 2000, output: 600, cacheRead: 8000, cacheWrite: 0, costUsd: 0.002, contextTokens: 12000, contextWindow: 1000000, contextPercent: 0.012, cacheHitRate: 0.80, v: 2 },
    { type: "subagent.run", ts: 3000, sessionId: "s1", agent: "test-agent", task: "test task", model: "test-model", turns: 3, input: 500, output: 200, cacheRead: 1000, cacheWrite: 0, costUsd: 0.0001, cacheHitRate: 0.67, exitCode: 0, prefixLayout: true },
    { type: "routing.decision", ts: 4000, sessionId: "s1", mode: "M2", preset: "balanced", stage: "Growth", role: "doer", confidence: 0.84, reason: ["stage:Growth→baseline:M2"] },
  ]),
  parseEventsFileAsync: vi.fn(async () => [
    { type: "cache.sample", ts: 1000, sessionId: "s1", turnIndex: 0, model: "test", mode: "M2", stage: "Growth", role: "doer", preset: "balanced", input: 1000, output: 500, cacheRead: 5000, cacheWrite: 0, costUsd: 0.001, contextTokens: 10000, contextWindow: 1000000, contextPercent: 0.01, cacheHitRate: 0.83, v: 2 },
    { type: "cache.sample", ts: 2000, sessionId: "s1", turnIndex: 1, model: "test", mode: "M2", stage: "Growth", role: "doer", preset: "balanced", input: 2000, output: 600, cacheRead: 8000, cacheWrite: 0, costUsd: 0.002, contextTokens: 12000, contextWindow: 1000000, contextPercent: 0.012, cacheHitRate: 0.80, v: 2 },
    { type: "subagent.run", ts: 3000, sessionId: "s1", agent: "test-agent", task: "test task", model: "test-model", turns: 3, input: 500, output: 200, cacheRead: 1000, cacheWrite: 0, costUsd: 0.0001, cacheHitRate: 0.67, exitCode: 0, prefixLayout: true },
    { type: "routing.decision", ts: 4000, sessionId: "s1", mode: "M2", preset: "balanced", stage: "Growth", role: "doer", confidence: 0.84, reason: ["stage:Growth→baseline:M2"] },
  ]),
  filterByType: vi.fn((events, type) => events.filter(e => e.type === type)),
  filterByTimeRange: vi.fn((events) => events),
}));

// Mock project-discovery
vi.mock("../../src/lib/project-discovery", () => ({
  discoverProject: vi.fn(() => "/test/project"),
  validateProjectPath: vi.fn(async () => true),
}));

// Mock event-watcher
vi.mock("../../src/lib/event-watcher", () => {
  return {
    EventWatcher: class MockEventWatcher {
      onEvent() { return () => {}; }
      start() {}
      stop() {}
      poll() {}
    },
  };
});

// Mock agent-status
vi.mock("../../src/lib/agent-status", () => ({
  readAgentStatus: vi.fn(async () => ({
    persistentAgents: [],
    blackboardAgents: [],
    dagState: null,
    override: null,
  })),
}));

import { useDashboardStore } from "../../src/store/dashboard-store";

describe("IT-3: Store init", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      events: [], summary: null, routeHistory: [], cacheTrend: [],
      tokenBreakdown: null, costAnalysis: null, agentTimeline: [],
      agentStatus: null, loading: false, error: null,
      timeRange: "all", autoRefresh: true, currentPage: "dashboard",
    });
  });

  it("init() loads events and computes aggregations", async () => {
    await useDashboardStore.getState().init();
    const state = useDashboardStore.getState();
    expect(state.events.length).toBeGreaterThan(0);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("init() sets summary with correct total cost", async () => {
    await useDashboardStore.getState().init();
    const state = useDashboardStore.getState();
    expect(state.summary).not.toBeNull();
    // v2 events: cost = 0.001 + 0.002 = 0.003 + subagent 0.0001 = 0.0031
    expect(state.summary!.totalCost).toBeCloseTo(0.0031, 4);
  });

  it("init() populates routeHistory from routing.decision events", async () => {
    await useDashboardStore.getState().init();
    const state = useDashboardStore.getState();
    expect(state.routeHistory.length).toBeGreaterThan(0);
  });
});

describe("IT-4: Store recompute and time range", () => {
  beforeEach(async () => {
    useDashboardStore.setState({
      events: [], summary: null, routeHistory: [], cacheTrend: [],
      tokenBreakdown: null, costAnalysis: null, agentTimeline: [],
      agentStatus: null, loading: false, error: null,
      timeRange: "all", autoRefresh: true, currentPage: "dashboard",
    });
    await useDashboardStore.getState().init();
  });

  it("setTimeRange triggers recompute", async () => {
    const initialSummary = useDashboardStore.getState().summary;
    await useDashboardStore.getState().setTimeRange("24h");
    expect(useDashboardStore.getState().timeRange).toBe("24h");
    // Summary should still exist after recompute
    expect(useDashboardStore.getState().summary).not.toBeNull();
  });

  it("setAutoRefresh toggles the flag", () => {
    useDashboardStore.getState().setAutoRefresh(false);
    expect(useDashboardStore.getState().autoRefresh).toBe(false);
  });

  it("currentPage navigation works", () => {
    useDashboardStore.getState().setPage("agents");
    expect(useDashboardStore.getState().currentPage).toBe("agents");
    useDashboardStore.getState().setPage("control");
    expect(useDashboardStore.getState().currentPage).toBe("control");
    useDashboardStore.getState().setPage("settings");
    expect(useDashboardStore.getState().currentPage).toBe("settings");
    useDashboardStore.getState().setPage("dashboard");
    expect(useDashboardStore.getState().currentPage).toBe("dashboard");
  });
});
