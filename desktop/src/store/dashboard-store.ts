/**
 * D1-2/D1-6: Zustand 全局状态管理
 * 集成事件解析、数据聚合、实时更新、多 Agent 状态
 * 使用异步文件访问 (通过 Electron preload bridge)
 */

import { create } from "zustand";
import { parseEventsFileAsync, type AnyEvent } from "../lib/events-parser";
import { aggregateSummary, aggregateRouteHistory, aggregateCacheTrend, aggregateTokenBreakdown, aggregateCostAnalysis, aggregateAgentTimeline } from "../lib/data-aggregator";
import { EventWatcher } from "../lib/event-watcher";
import { discoverProject, validateProjectPath, type ProjectConfig } from "../lib/project-discovery";
import { readAgentStatus, type AgentStatusData } from "../lib/agent-status-enhanced";
import { loadRegistry, addWorkspace, removeWorkspace, setActive, type WorkspaceEntry, type WorkspaceRegistry } from "../lib/workspace-registry";
import { listSessions, type SessionMetadata } from "../lib/session-reader";

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "all";
export type PageName = 'overview' | 'sessions' | 'agents' | 'routing' | 'telemetry' | 'dag' | 'issues' | 'config' | 'settings';

interface DashboardState {
  // 导航
  currentPage: PageName;
  setPage: (page: PageName) => void;

  // 配置
  project: ProjectConfig | null;

  // 工作区与会话
  workspaces: WorkspaceEntry[];
  activeWorkspace: WorkspaceEntry | null;
  sessions: SessionMetadata[];
  selectedSessionFile: string | null;

  // 原始数据
  events: AnyEvent[];

  // 聚合数据
  summary: ReturnType<typeof aggregateSummary> | null;
  routeHistory: ReturnType<typeof aggregateRouteHistory>;
  cacheTrend: ReturnType<typeof aggregateCacheTrend>;
  tokenBreakdown: ReturnType<typeof aggregateTokenBreakdown>;
  costAnalysis: ReturnType<typeof aggregateCostAnalysis>;
  agentTimeline: ReturnType<typeof aggregateAgentTimeline>;

  // 多 Agent 状态
  agentStatus: AgentStatusData | null;

  // UI 状态
  timeRange: TimeRange;
  loading: boolean;
  error: string | null;
  autoRefresh: boolean;

  // 实时监听
  watcher: EventWatcher | null;
  statusTimer: ReturnType<typeof setInterval> | null;

  // Actions
  init: (fallbackPath?: string) => Promise<void>;
  reload: () => Promise<void>;
  setTimeRange: (range: TimeRange) => void;
  setAutoRefresh: (enabled: boolean) => void;
  recompute: () => void;
  refreshAgentStatus: () => Promise<void>;
  setProjectPath: (path: string) => Promise<void>;

  // 工作区与会话 Actions
  loadWorkspaces: () => Promise<void>;
  selectWorkspace: (id: string) => Promise<void>;
  addWorkspacePath: (path: string) => Promise<void>;
  removeWorkspaceById: (id: string) => Promise<void>;
  loadSessions: () => Promise<void>;
  selectSession: (fileName: string) => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  currentPage: "overview",
  setPage: (page) => set({ currentPage: page }),

  project: null,
  workspaces: [],
  activeWorkspace: null,
  sessions: [],
  selectedSessionFile: null,
  events: [],
  summary: null,
  routeHistory: [],
  cacheTrend: [],
  tokenBreakdown: [],
  costAnalysis: { byMode: [], byModel: [], byTaskType: [], total: 0, avgPerTurn: 0 },
  agentTimeline: [],
  agentStatus: null,

  timeRange: "24h",
  loading: false,
  error: null,
  autoRefresh: true,
  watcher: null,
  statusTimer: null,

  init: async (fallbackPath?: string) => {
    const candidate = discoverProject(fallbackPath);
    if (!candidate) {
      set({ error: "AgentFlux project not found. Set AGENTFLUX_PROJECT_ROOT env var or configure path in Settings." });
      return;
    }
    // Async validate that .agentflux directory actually exists
    const project = await validateProjectPath(candidate.projectRoot);
    if (!project) {
      set({ error: `AgentFlux directory not found at ${candidate.fluxDir}. Check path in Settings.` });
      return;
    }
    set({ project, loading: true });

    try {
      // 异步加载全量事件 (通过 Electron preload bridge)
      const events = await parseEventsFileAsync(project.eventsPath);
      set({ events, loading: false });
      get().recompute();

      // 加载多 Agent 状态
      await get().refreshAgentStatus();

      // 启动实时监听
      if (get().autoRefresh) {
        startWatcher(set, get, project.eventsPath);
        startStatusPolling(set, get, project.fluxDir);
      }

      // 加载工作区列表与会话列表
      await get().loadWorkspaces();
      await get().loadSessions();
    } catch (err: any) {
      set({ loading: false, error: `Failed to load events: ${err.message}` });
    }
  },

  reload: async () => {
    const { project } = get();
    if (!project) return;
    set({ loading: true });
    try {
      const events = await parseEventsFileAsync(project.eventsPath);
      set({ events, loading: false });
      get().recompute();
      await get().refreshAgentStatus();
    } catch (err: any) {
      set({ loading: false, error: err.message });
    }
  },

  setTimeRange: (range) => {
    set({ timeRange: range });
    get().recompute();
  },

  setAutoRefresh: (enabled) => {
    const state = get();
    if (enabled && !state.watcher && state.project) {
      startWatcher(set, get, state.project.eventsPath);
      startStatusPolling(set, get, state.project.fluxDir);
    } else if (!enabled) {
      state.watcher?.stop();
      if (state.statusTimer) clearInterval(state.statusTimer);
      set({ watcher: null, statusTimer: null, autoRefresh: false });
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

  refreshAgentStatus: async () => {
    const { project } = get();
    if (!project) return;
    try {
      const status = await readAgentStatus(project.fluxDir);
      set({ agentStatus: status });
    } catch (e) { console.warn("[flux] agent status refresh failed:", e); }
  },

  setProjectPath: async (path: string) => {
    // 停止现有监听
    const state = get();
    state.watcher?.stop();
    if (state.statusTimer) clearInterval(state.statusTimer);
    set({ watcher: null, statusTimer: null, events: [], summary: null });

    // 重新初始化
    await get().init(path);
  },

  // ─── 工作区与会话 Actions ───
  loadWorkspaces: async () => {
    try {
      const reg: WorkspaceRegistry = await loadRegistry();
      const active = reg.activeId ? reg.workspaces.find((w) => w.id === reg.activeId) ?? null : null;
      set({ workspaces: reg.workspaces, activeWorkspace: active });
    } catch {
      // 无注册表或读取失败：保持空状态，回退到 discoverProject 已由 init 处理
      set({ workspaces: [], activeWorkspace: null });
    }
  },

  selectWorkspace: async (id: string) => {
    try {
      const entry = await setActive(id);
      if (!entry) return;
      set({ activeWorkspace: entry });
      // 通过 setProjectPath 重新加载项目数据
      await get().setProjectPath(entry.path);
      await get().loadSessions();
    } catch (err: any) {
      set({ error: `Failed to select workspace: ${err.message}` });
    }
  },

  addWorkspacePath: async (path: string) => {
    try {
      const entry = await addWorkspace(path);
      await get().loadWorkspaces();
      await get().selectWorkspace(entry.id);
    } catch (err: any) {
      set({ error: `Failed to add workspace: ${err.message}` });
    }
  },

  removeWorkspaceById: async (id: string) => {
    try {
      await removeWorkspace(id);
      await get().loadWorkspaces();
    } catch (err: any) {
      set({ error: `Failed to remove workspace: ${err.message}` });
    }
  },

  loadSessions: async () => {
    const { project } = get();
    if (!project) {
      set({ sessions: [] });
      return;
    }
    try {
      const sessions = await listSessions(project.fluxDir + '/runtime/sessions');
      set({ sessions });
    } catch {
      set({ sessions: [] });
    }
  },

  selectSession: (fileName: string) => {
    set({ selectedSessionFile: fileName });
  },
}));

// ─── 辅助函数 ───

function startWatcher(
  set: (partial: Partial<DashboardState>) => void,
  get: () => DashboardState,
  eventsPath: string,
) {
  const watcher = new EventWatcher(eventsPath, 500);
  watcher.onEvent((newEvents) => {
    const allEvents = [...get().events, ...newEvents];
    set({ events: allEvents });
    get().recompute();
  });
  watcher.start();
  set({ watcher, autoRefresh: true });
}

function startStatusPolling(
  set: (partial: Partial<DashboardState>) => void,
  get: () => DashboardState,
  fluxDir: string,
) {
  const timer = setInterval(async () => {
    try {
      const status = await readAgentStatus(fluxDir);
      set({ agentStatus: status });
    } catch (e) { console.warn("[flux] agent status refresh failed:", e); }
  }, 2000); // 每 2 秒刷新 agent 状态
  set({ statusTimer: timer });
}
