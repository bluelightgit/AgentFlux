# AgentFlux Desktop v2 — Design Spec

> 产出方式: 主 agent 补充（设计者 subagent 因 gpt-5.5 过载失败）
> 实现方式: 多 agent 并行开发

## 1. SVG Icon System (Lucide React)

**安装**: `npm install lucide-react`

### Navigation Icons
| Page | Lucide Icon | Import |
|---|---|---|
| Overview | LayoutDashboard | `import { LayoutDashboard } from 'lucide-react'` |
| Sessions | MessageSquare | `import { MessageSquare } from 'lucide-react'` |
| Agents | Users | `import { Users } from 'lucide-react'` |
| Routing | Route | `import { Route } from 'lucide-react'` |
| Telemetry | Activity | `import { Activity } from 'lucide-react'` |
| DAG | Workflow | `import { Workflow } from 'lucide-react'` |
| Config | Settings2 | `import { Settings2 } from 'lucide-react'` |
| Settings | Settings | `import { Settings } from 'lucide-react'` |

### Status Icons
| Status | Lucide Icon | Color |
|---|---|---|
| running | Loader2 (animate-spin) | text-blue-500 |
| done | CheckCircle2 | text-green-500 |
| failed | XCircle | text-red-500 |
| idle | Circle | text-slate-400 |
| pending | Clock | text-slate-400 |

### Action Icons
| Action | Lucide Icon |
|---|---|
| refresh | RefreshCw |
| save | Save |
| copy | Copy |
| delete | Trash2 |
| switch | ArrowLeftRight |
| add | Plus |
| close | X |
| expand | ChevronDown |
| collapse | ChevronRight |
| search | Search |
| folder | FolderOpen |
| external | ExternalLink |

### Data Type Icons
| Type | Lucide Icon |
|---|---|
| cache | Database |
| cost | DollarSign |
| token | Coins |
| route | Route |
| agent | Bot |
| session | MessageSquare |
| model | Cpu |
| warning | AlertTriangle |
| info | Info |

## 2. Color System (Tailwind CSS)

### Status Colors
```
running:  bg-blue-50  text-blue-600  border-blue-200
done:     bg-green-50 text-green-600 border-green-200
failed:   bg-red-50   text-red-600   border-red-200
idle:     bg-slate-50 text-slate-500 border-slate-200
pending:  bg-amber-50 text-amber-600 border-amber-200
```

### Mode Colors (M1-M6)
```
M1: text-slate-600  (single agent, minimal)
M2: text-blue-600   (sequential multi-agent)
M3: text-purple-600 (fork explore)
M4: text-green-600  (persistent multi-agent)
M5: text-amber-600  (DAG pipeline)
M6: text-red-600    (heterogeneous team)
```

### Layout Colors
```
App background:    bg-slate-100
Card background:   bg-white
Sidebar:           bg-slate-900 text-slate-200
Sidebar active:    bg-slate-800 text-white
Sidebar hover:     bg-slate-800/50
Top bar:           bg-white border-b border-slate-200
Border:            border-slate-200
Text primary:      text-slate-800
Text secondary:    text-slate-500
Text muted:        text-slate-400
```

## 3. Component Hierarchy

```
App
├── AppShell
│   ├── TopBar
│   │   ├── WorkspaceSelector (dropdown, shows registered workspaces)
│   │   ├── AppTitle ("AgentFlux")
│   │   └── QuickActions (refresh button, command palette trigger)
│   ├── Sidebar
│   │   ├── NavItem × 8 (Overview, Sessions, Agents, Routing, Telemetry, DAG, Config, Settings)
│   │   ├── NavBadge (active agent count on Agents page)
│   │   └── WorkspaceStatusFooter (project name, maturity stage, active mode)
│   └── MainContent
│       └── {currentPage component}
│
├── Pages
│   ├── OverviewPage
│   │   ├── SummaryCards (6 metric cards: total cost, cache hit, agent runs, routing decisions, sessions, context %)
│   │   ├── ModeHistoryChart (ScatterChart: mode over time, bubble=confidence)
│   │   ├── MaturityCard (stage, signals, role, baseline_mode)
│   │   └── ActiveAgentsList (agents currently running)
│   │
│   ├── SessionsPage
│   │   ├── SessionList (left panel: list of session files with metadata)
│   │   │   └── SessionListItem (agent name, model, turns, cost, cache hit, timestamp)
│   │   └── SessionDetail (right panel: conversation messages)
│   │       ├── MessageView (role, content, tool calls, usage)
│   │       └── UsageBar (input/cacheRead/output visual bar)
│   │
│   ├── AgentsPage
│   │   ├── AgentDefinitionList (from .agentflux/agents/*.md)
│   │   │   └── AgentDefCard (name, description, model, thinking, tools)
│   │   ├── AgentStatusTable (from persistent-agents.json + blackboard.json)
│   │   │   └── AgentStatusRow (name, role, model, status, calls, cost, cacheRead)
│   │   ├── AgentTelemetryTable (from events.jsonl subagent.run aggregation)
│   │   │   └── AgentTelemetryRow (name, runs, avgHitRate, avgTurns, failures, retries, models)
│   │   └── ModelAssignmentEditor (change model per role, writes to agent .md)
│   │
│   ├── RoutingPage
│   │   ├── PreferenceRadar (5-dim SVG radar + sliders + mode prediction)
│   │   ├── RoutingDecisionList (from events.jsonl routing.decision)
│   │   └── ModePredictionPanel (real-time mode prediction from current preference)
│   │
│   ├── TelemetryPage
│   │   ├── CacheEfficiencyPanel (overall hit rate, cache read vs miss, savings)
│   │   ├── CostBreakdownPanel (by mode, by model)
│   │   ├── TokenBreakdownPanel (input/cacheRead/output per turn)
│   │   └── EventStreamPanel (real-time event feed with filters)
│   │
│   ├── DAGPage
│   │   ├── DAGVisualization (SVG nodes with status colors, edges)
│   │   ├── DAGProgress (progress bar: completed/failed/total)
│   │   ├── DAGNodeList (table: node id, role, status, model, cost)
│   │   └── DAGHistory (past DAG executions from telemetry)
│   │
│   ├── ConfigPage
│   │   ├── AgentFluxConfigEditor (JSON editor for agentflux.json)
│   │   ├── ModelsConfigEditor (JSON editor for models.json)
│   │   └── AgentRoleEditor (list .agentflux/agents/*.md, edit frontmatter)
│   │
│   └── SettingsPage
│       ├── WorkspaceRegistry (list registered workspaces, add/remove)
│       ├── ThemeSelector (light/dark)
│       └── RefreshSettings (auto-refresh interval, status polling interval)
│
└── Shared Primitives
    ├── Card (bg-white rounded-lg shadow border p-6)
    ├── Badge (colored pill with icon)
    ├── StatusDot (colored circle)
    ├── DataTable (sortable table with columns)
    ├── JsonEditor (textarea with JSON validation)
    ├── MetricCard (icon + label + value + trend)
    └── EmptyState (icon + message)
```

## 4. Page Layouts

### Overview Page
```
┌──────────────────────────────────────────────────────────┐
│  [SummaryCards: 6 metric cards in a row]                 │
├──────────────────────────────┬───────────────────────────┤
│  ModeHistoryChart            │  MaturityCard             │
│  (ScatterChart)              │  (stage, signals, role)   │
├──────────────────────────────┴───────────────────────────┤
│  ActiveAgentsList                                         │
│  (table: name, role, model, status, working on)          │
└──────────────────────────────────────────────────────────┘
```
Data: events.jsonl (all event types), project-profile.json, persistent-agents.json, blackboard.json

### Sessions Page
```
┌────────────────────┬────────────────────────────────────┐
│  SessionList       │  SessionDetail                     │
│  ┌──────────────┐  │  ┌──────────────────────────────┐ │
│  │ dag-t2       │  │  │ #1 user: Task: Read types... │ │
│  │ glm-5.2      │  │  │ #2 assistant: ContextTop...  │ │
│  │ 5 turns $0.04│  │  │    [usage: in=84 cache=1920] │ │
│  ├──────────────┤  │  │ #3 user: What was the...    │ │
│  │ hetero-planner│ │  │ #4 assistant: ContextTop... │ │
│  │ gpt-5.5      │  │  │    [usage: in=144 cache=3840]│ │
│  │ 3 turns $0.01│  │  └──────────────────────────────┘ │
│  └──────────────┘  │                                    │
└────────────────────┴────────────────────────────────────┘
```
Data: .agentflux/runtime/sessions/*.jsonl (parse pi session format: type=session/message/model_change)

### Agents Page
```
┌──────────────────────────────────────────────────────────┐
│  Agent Definitions (from .agentflux/agents/*.md)         │
│  [planner] [implementer] [reviewer] [tester] [designer]  │
│  Each: model, thinking, tools, description               │
├──────────────────────────────────────────────────────────┤
│  Agent Status (persistent-agents.json + blackboard.json) │
│  Table: name, role, model, status, calls, cost, cache    │
├──────────────────────────────────────────────────────────┤
│  Agent Telemetry (events.jsonl subagent.run)             │
│  Table: name, runs, avgHit, avgTurns, fails, retries     │
└──────────────────────────────────────────────────────────┘
```

### Config Page
```
┌──────────────────────────────────────────────────────────┐
│  Tabs: [agentflux.json] [models.json] [Agent Roles]      │
├──────────────────────────────────────────────────────────┤
│  JSON Editor (textarea with syntax highlighting)         │
│  [Save] button writes to .agentflux/                     │
└──────────────────────────────────────────────────────────┘
```

## 5. Workspace Data Flow

```
User selects workspace
  → store.setWorkspace(path)
    → validate .agentflux/ exists (IPC: path-exists)
    → update project config (fluxDir, eventsPath, etc.)
    → clear all cached data (events, agentStatus, etc.)
    → reload events (IPC: read-file → parseEventsFileAsync)
    → reload agent status (IPC: read-file × multiple)
    → restart event watcher (new eventsPath)
    → restart status polling (new fluxDir)
    → recompute aggregations
    → update UI
```

## 6. IPC Handler Expansion

New IPC handlers needed in electron/main.ts:

| Channel | Params | Returns | Purpose |
|---|---|---|---|
| `list-directory` | dirPath | string[] | List session files, agent definitions |
| `read-directory-files` | dirPath | {name, content}[] | Batch read agent .md files |
| `get-user-data-path` | — | string | Get Electron userData path for workspace registry |
| `show-folder-dialog` | — | string\|null | Native folder picker for workspace selection |
