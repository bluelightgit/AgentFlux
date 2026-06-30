# AgentFlux Desktop v2 — Architecture Specification

> **Status**: Design directive from main agent
> **Date**: 2026-06-30
> **Reference products**: Paperclip (72K stars), AionUi (29K stars)
> **Constraint**: All UI icons use SVG (Lucide React), NO emoji

## 1. Core Problems with Current Desktop v1

1. **No workspace concept** — hardcoded single project path, no switching
2. **No session management** — sessions exist in .agentflux/runtime/sessions/ but UI never shows them
3. **No agent management** — agent definitions in .agentflux/agents/*.md invisible to user
4. **Emoji icons** — inconsistent, unprofessional, platform-dependent rendering
5. **Fragmented data view** — 6 pages of loosely connected dashboards, no coherent workflow
6. **No persistent config view** — agentflux.json, models.json, project-profile.json not viewable/editable
7. **No real-time multi-agent monitoring** — DAG state, blackboard, agent messages not surfaced

## 2. Target Architecture (Paperclip + AionUi inspired)

### 2.1 Workspace-Centric Model

A **Workspace** = a project directory containing `.agentflux/`. The app supports multiple registered workspaces with seamless switching.

**Workspace data sources** (all under `.agentflux/`):

| File | Purpose | UI Surface |
|---|---|---|
| `agentflux.json` | Routing preference, budget config | Config page, Preference page |
| `models.json` | Model definitions, pricing, capability, role mapping | Models page, Agent page |
| `events.jsonl` | Telemetry (cache.sample, subagent.run, routing.decision, context.event) | Telemetry page, Dashboard |
| `project-profile.json` | Project maturity (stage, signals, role, baseline_mode) | Overview page |
| `agents/*.md` | Agent role definitions (planner, implementer, reviewer, tester) | Agents page |
| `runtime/sessions/*.jsonl` | Pi session files (conversation history per agent) | Sessions page |
| `runtime/persistent-agents.json` | Persistent agent registry (name, role, model, status, cost) | Agents page |
| `runtime/dag-state.json` | DAG execution state (completed, failed, nodes) | DAG page |
| `blackboard.json` | Shared board (agents status, tasks, messages) | Agents page, DAG page |
| `runtime/override.json` | Runtime routing override (preset, forceMode) | Control page |

### 2.2 Navigation Architecture

```
┌─────────────────────────────────────────────────────────┐
│  [Workspace Selector ▼]  AgentFlux              [⚙]     │  ← Top bar
├──────────────┬──────────────────────────────────────────┤
│  Sidebar     │  Main Content Area                       │
│              │                                          │
│  ◌ Overview  │  (page content)                          │
│  ◌ Sessions  │                                          │
│  ◌ Agents    │                                          │
│  ◌ Routing   │                                          │
│  ◌ Telemetry │                                          │
│  ◌ DAG       │                                          │
│  ◌ Config    │                                          │
│  ───────     │                                          │
│  ◌ Settings  │                                          │
│              │                                          │
│  [Workspace] │                                          │
│  status      │                                          │
└──────────────┴──────────────────────────────────────────┘
```

**Sidebar items** (all SVG icons from Lucide React):

| Page | Icon | Purpose |
|---|---|---|
| Overview | `LayoutDashboard` | Summary metrics, mode history, project maturity, active agents |
| Sessions | `MessageSquare` | List pi sessions, view conversation, switch active session |
| Agents | `Users` | Agent definitions, status, telemetry, model assignment |
| Routing | `Route` | Preference radar, routing decisions, mode prediction |
| Telemetry | `Activity` | Cache efficiency, cost breakdown, token analysis, event stream |
| DAG | `Workflow` | DAG visualization, execution history, node status |
| Config | `Settings2` | Edit agentflux.json, models.json, agent role definitions |
| Settings | `Settings` | App-level settings (workspace registry, theme, data refresh) |

### 2.3 Workspace Selection

- **Workspace registry**: stored in Electron app userData (`~/.agentflux-desktop/workspaces.json`)
- Each workspace entry: `{ id, name, path, lastOpened, pinned }`
- On startup: show workspace selector if multiple, or auto-open last workspace
- Workspace switch: reload all data sources from new `.agentflux/` directory
- Add workspace: folder picker dialog → validate `.agentflux/` exists → register

### 2.4 Session Management

- **List sessions**: scan `.agentflux/runtime/sessions/*.jsonl`, parse each file's first line (`type: "session"`) for metadata
- **Session metadata**: session ID, agent name, timestamp, model, turn count, total cost, cache hit rate
- **Session detail**: show conversation messages (user/assistant/tool), token usage per turn, cache hit evolution
- **Session switch**: mark a session as "active" in the UI (does not affect pi runtime, just UI focus)
- **New session**: placeholder — actual session creation happens via pi TUI or `/flux work`

### 2.5 Agent Management

- **Agent definitions**: parse `.agentflux/agents/*.md` frontmatter (name, description, model, thinking, tools)
- **Agent status**: merge `persistent-agents.json` (M4 agents) + `blackboard.json` agents (DAG/M6) + `dag-state.json` (DAG nodes)
- **Agent telemetry**: aggregate `subagent.run` events from `events.jsonl` per agent (runs, cost, cache hit, failures, retries)
- **Model assignment**: show current model per agent, allow switching model (writes to agent .md file or models.json role mapping)
- **Agent switch**: change active agent role for a session (updates agentflux.json or runtime override)

### 2.6 SVG Icon System

- Use **Lucide React** (same as Paperclip): `npm install lucide-react`
- All navigation, status, and action icons use Lucide SVG components
- NO emoji anywhere in the UI
- Status indicators: colored dots (CSS) or Lucide icons (`Circle`, `CheckCircle2`, `XCircle`, `Clock`, `Loader2`)
- DAG node status: SVG shapes with fill colors (green=done, blue=running, red=failed, gray=pending)

### 2.7 Technology Stack

| Layer | Current | Target | Reason |
|---|---|---|---|
| Icons | Emoji | **Lucide React** | SVG, consistent, professional |
| Layout | Single page | **Sidebar + Top bar** | Paperclip pattern, scalable |
| Data | Single store | **Workspace-scoped store** | Multi-workspace support |
| Navigation | Hardcoded | **Dynamic per workspace** | Data availability varies |
| Components | Flat | **Hierarchical with shared primitives** | Reusability, consistency |
| State | Zustand | **Zustand (kept)** | Already works, add workspace context |

## 3. Implementation Task Decomposition

### Group A: Designer (Research + Design Spec)
- Research Paperclip and AionUi UI patterns
- Produce detailed component hierarchy and layout spec
- Define SVG icon mapping for all UI elements
- Design color system and typography

### Group B: Core Infrastructure
- B1: Workspace registry + selector + switching logic
- B2: IPC handlers expansion (workspace list, session file parsing, agent definition reading)
- B3: Zustand store refactor (workspace context, multi-workspace data isolation)
- B4: Lucide React integration, SVG icon system, remove all emoji

### Group C: UI Components
- C1: App shell (top bar + sidebar + main content area)
- C2: Overview page (summary metrics, mode history, maturity, active agents)
- C3: Sessions page (session list, session detail with conversation view)
- C4: Agents page (definitions, status, telemetry, model assignment)
- C5: Routing page (preference radar, routing decisions, mode prediction)
- C6: Telemetry page (cache efficiency, cost breakdown, token analysis, event stream)
- C7: DAG page (DAG visualization, execution history, node status)
- C8: Config page (JSON editors for agentflux.json, models.json, agent roles)
- C9: Settings page (workspace registry, theme, refresh settings)

### Group D: Reviewer
- Review all components for consistency, SVG usage, no emoji
- Verify workspace switching works correctly
- Verify all data sources are properly read and displayed
