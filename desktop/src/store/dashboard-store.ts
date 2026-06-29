/**
 * D1-2/D1-6: Zustand 全局状态管理
 * 集成事件解析、数据聚合、实时更新
 */

import { create } from "zustand";
import { parseEventsFile, type AnyEvent } from "../lib/events-parser";
import { aggregateSummary, aggregateRouteHistory, aggregateCacheTrend, aggregateTokenBreakdown, aggregateCostAnalysis, aggregateAgentTimeline } from "../lib/data-aggregator";
import { EventWatcher } from "../lib/event-watcher";
import { discoverProject, type ProjectConfig } from "../lib/project-discovery";

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "all";

interface DashboardState {
  // 配置
  project: ProjectConfig | null;

  // 原始数据
  events: AnyEvent[];

  // 聚合数据
  summary: ReturnType<typeof aggregateSummary> | null;
  routeHistory: ReturnType<typeof aggregateRouteHistory>;
  cacheTrend: ReturnType<typeof aggregateCacheTrend>;
  tokenBreakdown: ReturnType<typeof aggregateTokenBreakdown>;
  costAnalysis: ReturnType<typeof aggregateCostAnalysis>;
  agentTimeline: ReturnType<typeof aggregateAgentTimeline>;

  // UI 状态
  timeRange: TimeRange;
  loading: boolean;
  error: string | null;
  autoRefresh: boolean;

  // 实时监听
  watcher: EventWatcher | null;

  // Actions
  init: (fallbackPath?: string) => void;
  reload: () => void;
  setTimeRange: (range: TimeRange) => void;
  setAutoRefresh: (enabled: boolean) => void;
  recompute: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  project: null,
  events: [],
  summary: null,
  routeHistory: [],
  cacheTrend: [],
  tokenBreakdown: [],
  costAnalysis: { byMode: [], byModel: [], byTaskType: [], total: 0, avgPerTurn: 0 },
  agentTimeline: [],
  timeRange: "24h",
  loading: false,
  error: null,
  autoRefresh: true,
  watcher: null,

  init: (fallbackPath?: string) => {
    const project = discoverProject(fallbackPath);
    if (!project) {
      set({ error: "AgentFlux project not found. Set AGENTFLUX_PROJECT_ROOT env var." });
      return;
    }
    set({ project, loading: true });

    // 加载全量事件
    const events = parseEventsFile(project.eventsPath);
    set({ events, loading: false });

    // 计算聚合
    get().recompute();

    // 启动实时监听
    if (get().autoRefresh) {
      const watcher = new EventWatcher(project.eventsPath, 500);
      watcher.onEvent((newEvents) => {
        const allEvents = [...get().events, ...newEvents];
        set({ events: allEvents });
        get().recompute();
      });
      watcher.start();
      set({ watcher });
    }
  },

  reload: () => {
    const { project } = get();
    if (!project) return;
    set({ loading: true });
    const events = parseEventsFile(project.eventsPath);
    set({ events, loading: false });
    get().recompute();
  },

  setTimeRange: (range: TimeRange) => {
    set({ timeRange: range });
    get().recompute();
  },

  setAutoRefresh: (enabled: boolean) => {
    const state = get();
    if (enabled && !state.watcher && state.project) {
      const watcher = new EventWatcher(state.project.eventsPath, 500);
      watcher.onEvent((newEvents) => {
        const allEvents = [...get().events, ...newEvents];
        set({ events: allEvents });
        get().recompute();
      });
      watcher.start();
      set({ watcher, autoRefresh: true });
    } else if (!enabled && state.watcher) {
      state.watcher.stop();
      set({ watcher: null, autoRefresh: false });
    }
  },

  recompute: () => {
    const { events, timeRange } = get();
    set({
      summary: aggregateSummary(events),
      routeHistory: aggregateRouteHistory(events, timeRange),
      cacheTrend: aggregateCacheTrend(events, timeRange),
      tokenBreakdown: aggregateTokenBreakdown(events, timeRange),
      costAnalysis: aggregateCostAnalysis(events, timeRange),
      agentTimeline: aggregateAgentTimeline(events, timeRange),
    });
  },
}));
