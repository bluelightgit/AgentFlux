# 23 - Electron 应用开发规划

> Phase 4 产品化路线图。从 pi TUI 扩展向独立桌面应用演进。
> 依据: docs/07-roadmap Phase 4, docs/12-ui-direction UI-B/C/D

## 1. 产品定位

### 1.1 AgentFlux Desktop 是什么

AgentFlux Desktop 是 AgentFlux 路由决策系统的可视化前端和项目管理中心。它不替代 pi TUI 的编码能力，而是在上层提供：

- **决策可视化**: 将路由历史、cache 趋势、成本分析从 footer 文字升级为交互式图表
- **多项目管理**: 一个界面监控多个项目的 agent 运行状态、路由决策、成本趋势
- **后台 daemon**: pi 进程在后台运行，Desktop 作为控制面板和通知中心
- **偏好调优**: 5 维偏好向量的可视化调整，A/B 对比为 RL 收集数据

### 1.2 与 pi TUI 扩展的关系

| 维度 | pi TUI 扩展 (现有) | AgentFlux Desktop (Phase 4) |
|---|---|---|
| 用户界面 | 终端 footer + SelectList | 桌面 GUI + 图表 + 通知 |
| 项目数 | 单项目 | 多项目并行监控 |
| 运行时 | pi 进程内 (extension) | 独立进程 + pi daemon |
| 数据消费 | 实时 footer | events.jsonl 历史聚合 + 实时推送 |
| 偏好调整 | `/flux preference` TUI | 雷达图拖拽 + 场景覆盖编辑 |
| 路由控制 | override_mode footer hint | 一键切换 suggest/auto + 手动选模式 |

核心理念: **pi TUI 是执行层, Desktop 是决策层和监控层**。两者共享 `.agentflux/` 配置和 `events.jsonl` 数据。

### 1.3 目标用户

1. **多项目开发者**: 同时维护 3+ 项目的开发者, 需要全局视图
2. **团队 lead**: 监控团队 agent 使用成本和效率趋势
3. **路由调优者**: 需要可视化偏好→模式映射, 对比不同配置效果
4. **成本敏感用户**: 需要精确的成本归因和预算告警

## 2. 技术架构与选型

### 2.1 Electron vs Tauri

| 维度 | Electron | Tauri | 决策 |
|---|---|---|---|
| 包大小 | ~80MB | ~8MB | Tauri 优 |
| 安全性 | Node.js 全权限 | Rust 沙箱 | Tauri 优 |
| 前端生态 | 完全兼容 | 完全兼容 | 平 |
| 原生依赖 | 无需 Rust | 需要 Rust 工具链 | Electron 优 |
| 系统集成 | 成熟 (托盘/通知/daemon) | 快速成熟中 | Electron 优 |
| 团队技能 | TS 全栈 | 需 Rust | Electron 优 |
| 开发速度 | 快 (大量模板) | 中 (Rust 学习曲线) | Electron 优 |

**决策: Phase 4 MVP 用 Electron**。理由: AgentFlux 团队是 TS 全栈, Electron 生态最成熟, 开发速度最快。Tauri 作为 Phase 5 降本选项 (如果包大小成为分发瓶颈)。

### 2.2 技术栈

```
AgentFlux Desktop
├── Main Process (Electron)
│   ├── 窗口管理 (BrowserWindow)
│   ├── 系统托盘 (Tray)
│   ├── 通知 (Notification)
│   ├── 文件监听 (chokidar → events.jsonl)
│   ├── pi 进程管理 (child_process.spawn)
│   └── IPC 桥 (ipcMain/ipcRenderer)
│
├── Renderer Process (React + TypeScript)
│   ├── UI 框架: React 18 + TypeScript
│   ├── 样式: Tailwind CSS + shadcn/ui
│   ├── 图表: Recharts (折线/柱状/雷达)
│   ├── 状态管理: Zustand (轻量)
│   ├── 路由: React Router
│   └── 终端: xterm.js (可选, 嵌入 pi TUI)
│
├── 数据层
│   ├── 实时: chokidar file watcher → WebSocket → UI
│   ├── 历史: SQLite (better-sqlite3) 索引 events.jsonl
│   └── 配置: 读写 .agentflux/ 目录
│
└── 后台 Daemon (可选)
    ├── pi 进程守护 (restart on crash)
    ├── 定时任务 (成本报告, 预算检查)
    └── 多项目状态聚合
```

### 2.3 进程架构

```
┌──────────────────────────────────────────────────┐
│              Electron Main Process               │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  Tray    │  │ Notifier │  │ File Watcher  │  │
│  │ (菜单)   │  │ (通知)   │  │ (events.jsonl)│  │
│  └──────────┘  └──────────┘  └───────┬───────┘  │
│                                      │           │
│  ┌──────────────────────────────────┐│           │
│  │      pi Process Manager          ││           │
│  │  ┌─────────┐  ┌─────────┐       ││           │
│  │  │ pi #1   │  │ pi #2   │       ││           │
│  │  │(proj-A) │  │(proj-B) │       ││           │
│  │  └─────────┘  └─────────┘       ││           │
│  └──────────────────────────────────┘│           │
│                                      │           │
│  ┌───────────┐    ┌─────────────────┐│           │
│  │  SQLite   │◄──│ Event Ingester  │◄┘           │
│  │ (索引)    │    │ (JSONL→SQL)     │             │
│  └───────────┘    └─────────────────┘             │
│         │                                         │
│         ▼                                         │
│  ┌──────────────────────────────────┐             │
│  │       IPC Bridge (WebSocket)     │             │
│  └──────────────────────────────────┘             │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│            Renderer Process (React)              │
│                                                  │
│  ┌─────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │Dashboard│ │ Control  │ │ Project Manager  │  │
│  │ (图表)  │ │ Plane    │ │ (多项目)         │  │
│  └─────────┘ └──────────┘ └──────────────────┘  │
│  ┌──────────────────────────────────────────┐    │
│  │       Terminal (xterm.js, 可选)          │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

## 3. 功能模块设计

### 3.1 UI-B: Read-only Dashboard

#### 路由历史 (Route Map)

```
┌─────────────────────────────────────────────────────────┐
│  Route History                          [Time range ▼]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   M6 ┤                              ╭──●                │
│   M5 ┤                    ●───────╮                     │
│   M4 ┤         ╭──●──╮            │                     │
│   M3 ┤    ●───╯      ╰──●        │                     │
│   M2 ┤──●                        │                     │
│   M1 ┤                            │                     │
│      └───────────────────────────────────────────────► │
│       09:00  10:00  11:00  12:00  13:00  14:00  15:00  │
│                                                         │
│  ● hover: "bugfix / tier2 / M3 / conf=0.75 / $0.003"   │
│                                                         │
│  Filter: [bugfix ▼] [feature ▼] [review ▼]              │
└─────────────────────────────────────────────────────────┘
```

数据源: `events.jsonl` 中 `routing.decision` 事件
功能:
- 时间轴展示模式选择历史, y 轴是 M1-M6
- 点击节点显示路由理由链 (reason[])
- 按任务类型/复杂度/模式过滤
- 显示置信度和成本

#### Cache 趋势图

```
┌─────────────────────────────────────────────────────────┐
│  Cache Performance                                       │
├─────────────────────────────────┬───────────────────────┤
│  Hit Rate (%)                   │  Token Breakdown      │
│  100┤────╮     ╭──╮             │  ┌─────────────────┐  │
│   80┤    ╰───╯   ╰──●           │  │ ████ input  45% │  │
│   60┤                         │  │ ███ cache   38% │  │
│   40┤                         │  │ ██  output  12% │  │
│   20┤                         │  │ █   write    5% │  │
│    0└──────────────────────►  │  └─────────────────┘  │
│     09:00  11:00  13:00  15:00│                       │
│                               │  Total saved: $0.42   │
└─────────────────────────────────┴───────────────────────┘
```

数据源: `events.jsonl` 中 `cache.sample` 事件
功能:
- cache hit rate 折线图 (per turn)
- token 构成饼图 (input/output/cacheRead/cacheWrite)
- 成本节省计算 (对比无 cache 场景)
- compaction 事件标注 (cache 骤降点)

#### 成本分析

```
┌─────────────────────────────────────────────────────────┐
│  Cost Analysis                       [Today | Week ▼]   │
├──────────────────────┬──────────────────────────────────┤
│  By Mode             │  By Model                        │
│  ┌────────────────┐  │  ┌────────────────────────────┐  │
│  │ M1  ████ $0.12 │  │  │ deepseek-v4-flash          │  │
│  │ M2  ██████ $0.18│  │  │ ████████████████ $0.28    │  │
│  │ M3  ███ $0.09  │  │  │ gpt-5.5                    │  │
│  │ M4  ██ $0.06   │  │  │ ██████ $0.12               │  │
│  │ M6  █ $0.03    │  │  └────────────────────────────┘  │
│  └────────────────┘  │                                  │
│                      │  Total: $0.48                    │
│  By Task Type        │  Avg/turn: $0.012                │
│  ┌────────────────┐  │  Budget: $2.00 [24%]           │
│  │ bugfix  ████   │  │  ████░░░░░░░░░░░░░░░░          │
│  │ feature ██████ │  │                                  │
│  │ review  ██     │  │ Projected month-end: $14.40    │
│  └────────────────┘  │                                  │
└──────────────────────┴──────────────────────────────────┘
```

数据源: `cache.sample` + `subagent.run` 事件聚合
功能:
- 按模式/模型/任务类型三维成本分解
- 预算进度条 + 预测
- 日/周/月时间范围切换
- 成本异常告警 (单 turn 超过阈值)

#### Agent 执行时间线

```
┌─────────────────────────────────────────────────────────┐
│  Agent Timeline                                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  planner-1   ████░░░░██████░░░░░░██████████             │
│  impl-1      ░░████████░░░░████████░░░░░░░░             │
│  reviewer-1  ░░░░░░░░░░░░░░░░██████░░██████░             │
│  tester-1    ░░░░░░░░░░░░░░░░░░░░░░░████████             │
│              ───────────────────────────────►           │
│              09:00  10:00  11:00  12:00  13:00         │
│                                                         │
│  █ running  ░ idle  ▓ blocked  ✗ failed                 │
│                                                         │
│  Click agent: shows run history, cost, cache hit        │
└─────────────────────────────────────────────────────────┘
```

数据源: `subagent.run` 事件 + SharedBoard `blackboard.json`
功能:
- 甘特图展示 agent 运行状态
- 点击查看单个 agent 的运行历史和成本
- 质量门结果标注 (通过/失败/重试)

#### Experience Store 可视化

```
┌─────────────────────────────────────────────────────────┐
│  Experience Store                                        │
├─────────────────────────┬───────────────────────────────┤
│  Recommendations        │  Sample Distribution          │
│                         │                               │
│  bugfix/tier1 → M2     │  ┌─────────────────────────┐  │
│  conf: 0.85 (12 sampl) │  │ M2 ████████████  16     │  │
│  success: 92%          │  │ M1 ████          4      │  │
│  avg cost: $0.001      │  │ M3 ██            2      │  │
│                         │  │ M4 █             1      │  │
│  feature/tier2 → M3    │  └─────────────────────────┘  │
│  conf: 0.70 (5 sampl)  │                               │
│  success: 80%          │  Total records: 23            │
│                         │  Unique signatures: 8         │
└─────────────────────────┴───────────────────────────────┘
```

数据源: `experience.jsonl`
功能:
- 按任务签名分组展示模式推荐
- 样本数和成功率统计
- 置信度可视化

### 3.2 UI-C: Control Plane

#### 偏好调音台 (Radar Chart)

```
┌─────────────────────────────────────────────────────────┐
│  Preference Tuner                                        │
├────────────────────────────┬────────────────────────────┤
│                            │  Scenario Overrides        │
│       accuracy_priority    │  ┌──────────────────────┐  │
│           0.8 ●            │  │ bugfix:              │  │
│          / \               │  │  accuracy: 0.9 ●    │  │
│         /   \              │  │  latency: 0.3 ●     │  │
│ cost   /     \  latency    │  │ feature:             │  │
│ 0.5 ●/───────\● 0.6        │  │  (use global)       │  │
│        \     /             │  │ refactor:            │  │
│         \   /              │  │  multi_agent: 0.8 ●  │  │
│          \ /               │  └──────────────────────┘  │
│   parallelism  multi_agent │                            │
│     0.4 ●         0.5 ●    │  Current prediction: M3   │
│                            │  Override: [suggest ▼]    │
│  [Reset] [Save] [A/B Test] │                            │
└────────────────────────────┴────────────────────────────┘
```

功能:
- 5 维偏好向量雷达图, 拖拽节点调整
- 实时预测落点模式 (调用 `route()` 预览)
- 场景覆盖编辑 (bugfix/feature/refactor/explore/review 独立覆盖)
- A/B Test: 保存两组配置, 轮流使用, 记录效果到 ExperienceStore (为 RL 收集数据)
- override_mode 切换: suggest / auto / manual

#### Agent 管理

```
┌─────────────────────────────────────────────────────────┐
│  Agent Management                                        │
├─────────┬──────────┬────────┬───────┬──────┬───────────┤
│  Name   │ Role     │ Status │ Calls │ Cost │ Actions   │
├─────────┼──────────┼────────┼───────┼──────┼───────────┤
│ planner │ planner  │ ● idle │  12   │$0.04 │ [pause]   │
│ impl-1  │ implem.. │ ● run  │   8   │$0.02 │ [abort]   │
│ rev-1   │ reviewer │ ✓ done │   5   │$0.01 │ [restart] │
│ test-1  │ tester   │ ⚠ bl.. │   3   │$0.01 │ [unblock] │
└─────────┴──────────┴────────┴───────┴──────┴───────────┘

  Selected: impl-1
  Model: deepseek-v4-flash  Thinking: medium
  Session: flux-impl-1 (cache hit 97%)
  Last output: "Implemented auth module with JWT..."
```

数据源: `persistent-agents.json` + `blackboard.json`
功能:
- 持久 agent 列表 (注册表)
- 实时状态 (running/idle/blocked/done/failed)
- 操作: pause (停止接收新任务) / abort (终止当前运行) / restart (重置 session)
- 查看运行历史和 session cache 命中率

#### 预算设置

```
┌─────────────────────────────────────────────────────────┐
│  Budget Settings                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Max cost per task:  $[2.00]                           │
│  Max iterations:     [5]                                │
│  Max wall clock:     [600] seconds                      │
│                                                         │
│  Budget Router:                                        │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Agent        Model          Thinking   Cost     │   │
│  │ planner-1    gpt-5.5        high       $0.045   │   │
│  │ impl-1       deepseek-flash medium     $0.0003  │   │
│  │ reviewer-1   gpt-5.5        high       $0.035   │   │
│  │ Total: $0.08 / Budget: $0.05 [OVER]            │   │
│  │                                                 │   │
│  │ [Auto-optimize] [Manual adjust]                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Alert threshold: $[0.50] per turn                      │
│  ☑ Notify on budget exceeded                            │
│  ☑ Notify on quality gate failure                       │
└─────────────────────────────────────────────────────────┘
```

功能:
- 全局预算参数设置 (写入 `.agentflux/agentflux.json`)
- Budget Router 预览 (调用 `optimizeBudget()` 可视化分配方案)
- 超预算时自动降级预览
- 告警阈值和通知开关

### 3.3 UI-D: Electron Shell

#### 系统托盘

```
┌───────────────────┐
│ AgentFlux Desktop │  ← 托盘图标 (带状态色: 绿=正常, 黄=警告, 红=超预算)
├───────────────────┤
│ ► Open Dashboard  │
│ ► Terminal        │
│ ───────────────── │
│ Projects:         │
│   ● AgentFlux     │  ← 绿色圆点 = 有活跃 agent
│   ○ my-app        │  ← 空心圆点 = 空闲
│ ───────────────── │
│ Total today: $0.48│
│ Budget: 24%       │
│ ───────────────── │
│ ⚙ Preferences     │
│ ⏏ Quit            │
└───────────────────┘
```

#### 通知

| 场景 | 通知内容 | 优先级 |
|---|---|---|
| 任务完成 | "✅ AgentFlux: planner-1 completed (3 turns, $0.003)" | 低 |
| 质量门失败 | "⚠️ AgentFlux: impl-1 failed quality gate, retrying (1/2)" | 中 |
| 质量门重试通过 | "✅ AgentFlux: impl-1 passed after retry" | 低 |
| 预算超限 | "🔴 AgentFlux: Budget exceeded ($2.05/$2.00)" | 高 |
| 成本异常 | "🔴 AgentFlux: Single turn cost $0.50 (threshold $0.10)" | 高 |
| DAG 完成 | "✅ AgentFlux: DAG completed (4/4 nodes, $0.012, 45s)" | 低 |
| DAG 节点失败 | "❌ AgentFlux: DAG node 'review' failed after 2 retries" | 中 |

#### 后台 Daemon

```
┌─────────────────────────────────────────────────────────┐
│  Daemon Status                                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─ Project: AgentFlux ──────────────────────────┐      │
│  │ pi process: PID 12345 ● running               │      │
│  │ uptime: 2h 15m                                │      │
│  │ current mode: M2 (balanced)                   │      │
│  │ active agents: 2 (planner, impl-1)            │      │
│  │ session cost: $0.08 today                     │      │
│  └───────────────────────────────────────────────┘      │
│                                                         │
│  ┌─ Project: my-app ─────────────────────────────┐      │
│  │ pi process: PID 0 ○ stopped                   │      │
│  │ last active: 3h ago                           │      │
│  │ session cost: $0.00 today                     │      │
│  │ [Start] [Configure]                           │      │
│  └───────────────────────────────────────────────┘      │
│                                                         │
│  [+ Add Project]                                        │
│                                                         │
│  Daemon: ● running  |  Auto-start: ☑  |  [Stop]        │
└─────────────────────────────────────────────────────────┘
```

功能:
- 多项目管理: 每个项目一个 pi 进程
- 进程守护: crash 自动重启
- 自动启动: 系统登录时启动 daemon
- 项目配置隔离: 每个项目独立 `.agentflux/` 配置

## 4. 开发路线与里程碑

### Phase 4.1: Dashboard MVP (2 周)

**目标**: 从 events.jsonl 渲染只读 dashboard, 验证数据管线。

| 任务 | 内容 | 依赖 |
|---|---|---|
| D1-1 项目脚手架 | Electron + React + TypeScript + Tailwind 初始化 | — |
| D1-2 数据管线 | events.jsonl 解析 → SQLite 索引 → 查询 API | D1-1 |
| D1-3 路由历史页 | Route Map 时间轴 (Recharts scatter) | D1-2 |
| D1-4 Cache 趋势页 | Hit rate 折线图 + token 构成饼图 | D1-2 |
| D1-5 成本分析页 | 按模式/模型/任务类型三维分解 | D1-2 |
| D1-6 实时更新 | chokidar file watcher → WebSocket → UI 自动刷新 | D1-3 |

**验证指标**:
- 能加载 1000+ 条 events.jsonl 并在 <2s 渲染图表
- 实时更新延迟 <500ms (从 event 写入到 UI 刷新)
- 三种图表数据与 footer 显示一致

### Phase 4.2: Control Plane (2 周)

**目标**: 从 Dashboard 只读升级为可调控制面板。

| 任务 | 内容 | 依赖 |
|---|---|---|
| D2-1 偏好调音台 | 5 维雷达图 + 拖拽 + 实时模式预测 | D1-1 |
| D2-2 偏好持久化 | 雷达图调整 → 写入 `.agentflux/agentflux.json` | D2-1 |
| D2-3 override 控制 | suggest/auto/manual 切换 + 手动模式选择 | D2-2 |
| D2-4 Agent 管理面板 | 持久 agent 列表 + 状态 + 操作按钮 | D1-2 |
| D2-5 预算设置 | 预算参数 + Budget Router 预览 | D2-2 |
| D2-6 A/B Test | 保存两组偏好, 轮流使用, 记录效果 | D2-2 |

**验证指标**:
- 偏好调整后 `route()` 预测模式与 pi TUI `/flux why` 一致
- Agent 操作 (pause/abort) 通过 SharedBoard 文件生效
- A/B Test 数据写入 ExperienceStore, 可用于 RL 训练

### Phase 4.3: Electron Shell (2 周)

**目标**: 系统托盘 + 通知 + 后台 daemon + 多项目。

| 任务 | 内容 | 依赖 |
|---|---|---|
| D3-1 系统托盘 | Tray 菜单 + 状态色 + 项目列表 | D1-1 |
| D3-2 通知系统 | 6 种通知场景 + 优先级 + 免打扰 | D3-1 |
| D3-3 pi 进程管理 | spawn/stop/restart pi 进程 + crash 守护 | D3-1 |
| D3-4 多项目管理 | 项目增删改 + 配置隔离 + 状态聚合 | D3-3 |
| D3-5 内嵌终端 | xterm.js + pty 嵌入 pi TUI (可选) | D3-3 |
| D3-6 自动启动 | 系统登录时启动 daemon | D3-4 |

**验证指标**:
- 托盘显示当前活跃项目数和今日总成本
- 通知在事件发生后 <2s 弹出
- pi 进程 crash 后 <5s 自动重启
- 多项目切换 <500ms

### Phase 4.4: 打磨与分发 (1 周)

| 任务 | 内容 | 依赖 |
|---|---|---|
| D4-1 自动更新 | electron-updater 集成 | D3-4 |
| D4-2 打包 | Windows installer + macOS DMG + Linux AppImage | D3-4 |
| D4-3 文档 | 用户手册 + 配置指南 + 故障排查 | D4-2 |
| D4-4 性能优化 | 大数据量 (10K+ events) 渲染优化 | D1-6 |

## 5. 数据层设计

### 5.1 数据流

```
pi Extension (events.jsonl)
    ↓ chokidar file watcher
Event Ingester
    ↓ parse JSONL → INSERT
SQLite Database
    ↓ query (SQL)
API Layer (ipcMain handlers)
    ↓ WebSocket / ipcRenderer
React UI (Recharts)
```

### 5.2 SQLite Schema

```sql
-- 路由决策
CREATE TABLE routing_decisions (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  session_id TEXT,
  project TEXT,
  mode TEXT NOT NULL,
  fallback TEXT,
  confidence REAL,
  task_type TEXT,
  complexity_tier INTEGER,
  preset TEXT,
  stage TEXT,
  override_mode TEXT,
  applied INTEGER,  -- boolean
  reason TEXT,      -- JSON array
  cost REAL,
  latency_ms INTEGER
);
CREATE INDEX idx_routing_ts ON routing_decisions(timestamp);
CREATE INDEX idx_routing_mode ON routing_decisions(mode);
CREATE INDEX idx_routing_type ON routing_decisions(task_type);

-- Cache 采样
CREATE TABLE cache_samples (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  session_id TEXT,
  project TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  cost_usd REAL,
  context_percent REAL,
  cache_hit_rate REAL
);
CREATE INDEX idx_cache_ts ON cache_samples(timestamp);

-- Subagent 运行
CREATE TABLE subagent_runs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  session_id TEXT,
  project TEXT,
  agent_name TEXT,
  agent_role TEXT,
  model TEXT,
  task TEXT,
  turns INTEGER,
  cost REAL,
  cache_hit_rate REAL,
  exit_code INTEGER,
  persistent INTEGER,
  thinking TEXT
);
CREATE INDEX idx_subagent_ts ON subagent_runs(timestamp);
CREATE INDEX idx_subagent_agent ON subagent_runs(agent_name);

-- 经验记录
CREATE TABLE experience_records (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  task_type TEXT,
  complexity_tier INTEGER,
  file_count INTEGER,
  signature_hash TEXT,
  routed_mode TEXT,
  actual_mode TEXT,
  success INTEGER,
  cost REAL,
  latency_ms INTEGER,
  cache_hit_rate REAL
);
CREATE INDEX idx_exp_hash ON experience_records(signature_hash);
CREATE INDEX idx_exp_type ON experience_records(task_type);
```

### 5.3 实时更新机制

```
1. chokidar.watch(events.jsonl) → file change event
2. 读取新增行 (append-only, 记录上次读取位置)
3. 解析 JSONL → INSERT into SQLite
4. WebSocket.send({type: "new_event", data: {...}})
5. React state update → Recharts re-render
```

延迟目标: <500ms 从 event 写入到 UI 更新。

### 5.4 数据保留策略

| 数据 | 保留期 | 聚合策略 |
|---|---|---|
| routing_decisions | 90 天 | 90 天后按天聚合 (保留 count/avg_cost/mode_dist) |
| cache_samples | 30 天 | 30 天后按小时聚合 |
| subagent_runs | 90 天 | 90 天后按天聚合 |
| experience_records | 永久 | 不删除 (RL 训练数据) |
| 聚合数据 | 永久 | 趋势分析用 |

## 6. 与 pi 的集成方案

### 方案对比

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A: 嵌入 TUI | Electron 用 pty spawn pi, xterm.js 渲染 | 完整 TUI 体验 | 终端 UI 在 GUI 中不自然 |
| B: RPC 客户端 | Electron 通过 pi RPC 连接 | 不需要 pty | pi RPC 接口可能不完整 |
| C: 独立 daemon | pi 后台运行, Electron 只读 events.jsonl | 解耦最干净 | 无法实时控制 pi |
| **D: 混合** | daemon 模式 + 可选终端嵌入 + 文件控制 | 灵活, 渐进 | 复杂度稍高 |

### 推荐: 方案 D (混合)

```
┌─ Electron ──────────────────────────────────────┐
│                                                 │
│  ┌─ Dashboard ──────┐  ┌─ Terminal (可选) ──┐  │
│  │ (读 events.jsonl)│  │ xterm.js + pty    │  │
│  │                  │  │ → pi --no-tui     │  │
│  └──────────────────┘  └───────────────────┘  │
│                                                 │
│  ┌─ Control Plane ──────────────────────────┐  │
│  │ 偏好 → 写 .agentflux/agentflux.json      │  │
│  │ override → 写 .agentflux/runtime/override│  │
│  │ agent 控制 → 写 SharedBoard messages/    │  │
│  └──────────────────────────────────────────┘  │
│                                                 │
│  ┌─ Daemon ─────────────────────────────────┐  │
│  │ spawn pi --no-tui (per project)          │  │
│  │ 监控 stdout/stderr → 通知                │  │
│  │ crash → 自动重启                          │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**集成点**:
1. **数据读取**: Electron 直接读 `events.jsonl` (无需 pi 配合)
2. **偏好写入**: Electron 写 `.agentflux/agentflux.json`, pi `session_start` 时加载
3. **override 控制**: Electron 写 `.agentflux/runtime/override.json` (新增), pi `turn_end` 时检查
4. **agent 控制**: Electron 写 `SharedBoard messages/`, agent 下次启动时读取
5. **pi 进程管理**: Electron spawn `pi --no-tui --session-id <project>`, 监控进程状态

## 7. 风险与对冲

| 风险 | 概率 | 影响 | 对冲 |
|---|---|---|---|
| Electron 包太大 (80MB+) | 中 | 分发困难 | Phase 5 评估 Tauri 迁移 |
| pi RPC 接口不足 | 中 | 控制功能受限 | 方案 D 用文件控制, 不依赖 RPC |
| events.jsonl 并发写入 | 低 | 数据丢失 | SQLite WAL 模式 + append-only |
| 大数据量渲染卡顿 | 中 | 用户体验差 | 虚拟滚动 + 数据聚合 + 分页 |
| pi 进程管理跨平台差异 | 中 | daemon 不稳定 | 优先 Windows/Linux, macOS 后置 |
| xterm.js 嵌入体验差 | 中 | 终端功能不可用 | 可选模块, 不阻塞核心功能 |

## 8. 与 Phase 1-3 的集成点

| Phase 3 成果 | Desktop 集成 |
|---|---|
| `route()` 多层路由 | Dashboard 显示路由决策链 + 置信度 |
| `classifyTask()` 任务分类 | Dashboard 按任务类型过滤路由历史 |
| `ExperienceStore` | Dashboard 经验库可视化 + 推荐展示 |
| `optimizeBudget()` | Control Plane 预算预览 + 降级模拟 |
| `executeHeterogeneousTeam()` | Dashboard agent 时间线 + 成本对比 |
| `executeDAG()` | Dashboard DAG 执行可视化 + 质量门结果 |
| `SharedBoard` | Control Plane agent 管理面板 |
| `SidecarClient` | Control Plane 显示 Python sidecar 状态 |
| `selectModelForStep()` | Dashboard step-level routing 展示 |
| `events.jsonl` 遥测 | 全部 Dashboard 数据源 |

## 9. 目录结构 (规划)

```
agentflux-desktop/
├── package.json
├── electron/
│   ├── main.ts              # Electron 主进程
│   ├── tray.ts              # 系统托盘
│   ├── daemon.ts            # pi 进程管理
│   ├── watcher.ts           # events.jsonl 文件监听
│   ├── ingester.ts          # JSONL → SQLite
│   ├── ipc.ts               # IPC 处理器
│   └── notify.ts            # 通知系统
├── src/                     # React 渲染进程
│   ├── App.tsx
│   ├── pages/
│   │   ├── Dashboard.tsx    # 路由历史 + cache + 成本
│   │   ├── Control.tsx      # 偏好 + override + agent 管理
│   │   └── Projects.tsx     # 多项目管理
│   ├── components/
│   │   ├── RouteMap.tsx
│   │   ├── CacheChart.tsx
│   │   ├── CostBreakdown.tsx
│   │   ├── AgentTimeline.tsx
│   │   ├── PreferenceRadar.tsx
│   │   ├── BudgetPreview.tsx
│   │   └── AgentManager.tsx
│   ├── store/               # Zustand stores
│   └── lib/                 # API 客户端
├── resources/
│   ├── tray-icon.png
│   └── tray-icon-alert.png
└── build/                   # 打包配置
    ├── win-installer.yml
    ├── mac-dmg.yml
    └── linux-appimage.yml
```
