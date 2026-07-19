# AgentFlux Desktop v2.1 — Improvement Plan (Archived)

> 已归档：旧八页改良方案已被五入口工作台方案取代。当前规范见 `../docs/29-desktop-workbench-plan.md`。

> Baseline: `desktop/docs-v2-design-spec.md` (v2 component hierarchy, color, icon systems)
> Scope: Close 14 known gaps by adapting Paperclip + AionUi patterns to the existing 8-page architecture.
> Constraint: ALL icons are Lucide React SVG. NO emoji anywhere. Tailwind CSS only for styling.

---

## 1. Gap Analysis Table

| # | Current State (v2) | Desired State (v2.1) | Reference Pattern | Affected Files |
|---|---|---|---|---|
| 1 | No task/issue tracking | Full issue lifecycle: open → in_progress → review → done, with assignment to agents | Paperclip issue workflow | New `IssuesPage.tsx`, `IssueBoard.tsx`, `IssueDetailDrawer.tsx` |
| 2 | No command palette | Cmd+K global palette for page nav, agent actions, issue creation, search | Paperclip Command Palette | New `CommandPalette.tsx`; hook into `AppShell.tsx` |
| 3 | No file preview | Preview code/md/images/PDF/CSV/JSON inside session detail | AionUi File Preview Panel | New `FilePreviewPanel.tsx`, `FilePreviewTab.tsx` |
| 4 | Manual refresh only (polling) | WebSocket live updates; event watcher pushes diffs into store | Paperclip WebSocket cache invalidation | `electron/main.ts` WS bridge, `dashboard-store.ts` subscriptions |
| 5 | Cost shown only in telemetry aggregate | Per-agent cost dashboard with budget caps, alerts, burn-down | Paperclip agent cost control | New `AgentCostPanel.tsx` inside `AgentsPage.tsx` |
| 6 | Sessions = single conversation view | Multi-session parallel tabs; switch between running sessions | AionUi multi-agent cowork | `SessionsPage.tsx` SessionTabs refactor |
| 7 | No agent-to-agent visualization | Message graph between agents (blackboard reads/writes as edges) | AionUi multi-agent cowork | New `AgentCommGraph.tsx` on `AgentsPage.tsx` |
| 8 | DAG renders final state only | Real-time node status updates, live progress bar, streaming logs | Paperclip Live Run counts | `DAGPage.tsx` WS subscription |
| 9 | Overview shows metrics only | Actionable insights card: anomalies, recommendations, next-best-action | Paperclip insights | New `InsightsCard.tsx` on `OverviewPage.tsx` |
| 10 | Mouse navigation only | Full keyboard nav: tab cycle, j/k lists, Enter/Escape, `?` for help | Paperclip keyboard-first | `AppShell.tsx` keymap, `useKeyboardNav.ts` hook |
| 11 | Light mode only (bg-slate-100 / bg-slate-900 sidebar) | Dark mode toggle persisted to settings | AionUi theme switch | `ThemeProvider.tsx`, Tailwind `dark:` variants across all pages |
| 12 | Settings = project path + env only | Add model config UI, agent role editor UI (visual, not JSON-only) | Paperclip governance UI | `SettingsPage.tsx` expand; reuse `AgentRoleEditor` as visual form |
| 13 | No notifications | Toast + bell for task completion, errors, budget breaches | Paperclip Inbox badges | New `NotificationProvider.tsx`, `NotificationCenter.tsx` |
| 14 | No cross-page search | Global search over sessions + events + issues + agents | Paperclip search-in-sidebar | `CommandPalette.tsx` search mode; `SearchIndex.ts` |

---

## 2. Priority Ranking

| Priority | Items | Rationale |
|---|---|---|
| **P0** (block release) | #2 Command Palette, #4 Real-time updates, #10 Keyboard nav, #11 Dark mode | Foundational UX primitives every other feature depends on; cheap to land early; high perceived quality |
| **P1** (core value) | #1 Issue tracking, #6 Parallel sessions, #8 Live DAG, #13 Notifications, #14 Search | Directly close feature parity gap with Paperclip/AionUi; visible to users every session |
| **P2** (depth) | #3 File preview, #5 Per-agent cost dashboard, #7 Agent comm graph, #9 Insights, #12 Settings expansion | Enrichment features that build on P0/P1 foundations; can ship incrementally |

---

## 3. New Components Proposed

### 3.1 `CommandPalette.tsx` (P0)
- **Purpose**: Global Cmd+K / Ctrl+K overlay for navigation, actions, and unified search.
- **Props**: `open: boolean`, `onClose: () => void`, `commands: Command[]`
- **Command shape**: `{ id: string; label: string; icon: string; group: 'nav'|'action'|'search'|'issue'; keywords: string[]; perform: () => void }`
- **State**: `query`, `activeIndex`, `recentCommands[]`
- **Wireframe**:
```
┌─────────────────────────────────────────────────────┐
│  🔍  Search pages, agents, issues, sessions…   Esc │   (Search icon, no emoji)
├─────────────────────────────────────────────────────┤
│  Navigation                                         │
│  ▸ Overview                LayoutDashboard          │
│    Sessions                MessageSquare            │
│  Actions                                            │
│  ▸ New Issue              PlusCircle                │
│    Refresh Workspace      RefreshCw                 │
│  Search Results (debounced)                         │
│    session: dag-t2 (5 turns)                        │
│    issue: #142 "Refactor router"  in_progress       │
└─────────────────────────────────────────────────────┘
```
- **Icons**: `Search`, `CornerDownLeft`, `Esc` (use `X`), `Command`, `PlusCircle`, `ArrowUp`/`ArrowDown`, `Hash`, `MessageSquare`, `Users`, `LayoutDashboard`.
- **Keymap**: `Cmd/Ctrl+K` toggle; `↑/↓` move; `Enter` run; `Esc` close; `Tab` cycle group.

### 3.2 `IssuesPage.tsx` (P1) + `IssueBoard.tsx` + `IssueDetailDrawer.tsx`
- **Purpose**: Kanban board for tasks/issues assigned to agents with full lifecycle.
- **Data source**: New `.agentflux/issues.json` (array of `{id, title, status, assignee, created, updated, priority, tags, dagRef?}`).
- **Statuses**: `open` → `in_progress` → `review` → `done` (+ `blocked`).
- **Wireframe**:
```
┌─────────────┬─────────────┬─────────────┬─────────────┐
│  Open (3)   │ In Progress │  Review (1) │  Done (12)  │
│ ┌─────────┐ │ ┌─────────┐ │ ┌─────────┐ │ ┌─────────┐ │
│ │ #143    │ │ │ #142    │ │ │ #140    │ │ │ #139    │ │
│ │ Refactor│ │ │ Router  │ │ │ Tests   │ │ │ Docs    │ │
│ │ planner │ │ │ impl... │ │ │ tester  │ │ │ writer  │ │
│ │ ●low    │ │ │ ●high   │ │ │ ●med    │ │ │ ●low    │ │
│ └─────────┘ │ └─────────┘ │ └─────────┘ │ └─────────┘ │
└─────────────┴─────────────┴─────────────┴─────────────┘
```
- **Drawer** (right slide-in): description, assignee picker, status stepper, linked DAG, linked session, comment thread, activity log.
- **Icons**: `CircleDot` (open), `Loader2` (in_progress), `Eye` (review), `CheckCircle2` (done), `OctagonAlert`/`AlertOctagon` (blocked), `PlusCircle` (new), `GitBranch`, `MessageSquare`.
- **Nav item**: add `{ id: 'issues', label: 'Issues', icon: 'SquareCheckBig' }` to `NAV_ITEMS` (insert between `sessions` and `agents`).

### 3.3 `FilePreviewPanel.tsx` (P2)
- **Purpose**: Render file contents referenced in a session message (code, md, image, PDF, CSV, JSON).
- **Props**: `path: string`, `onClose: () => void`
- **Sub-tabs**: `Code` (`FileCode`), `Preview` (`Eye`), `Raw` (`Braces`).
- **Wireframe**: 40%-width right panel inside `SessionDetail`, split below `MessageView`.
```
┌──────────────────────────────┬──────────────────────┐
│  Session messages            │  File Preview        │
│  #3 assistant: edited src/... │  ◀ src/router.ts    │
│    [Open File ▸]              │  Tabs: Code|Preview  │
│                              │  ┌──────────────────┐│
│                              │  │ 1  import {R}... ││
│                              │  │ 2  export const ││
│                              │  └──────────────────┘│
└──────────────────────────────┴──────────────────────┘
```
- **Icons**: `FileCode`, `FileText`, `FileImage`, `File`, `Braces`, `Eye`, `Download`, `Copy`, `X`.
- **Renderers**: code → syntax-highlighted `<pre>`; md → rendered; image → `<img>`; PDF → `<iframe>`/`<embed>`; CSV → `DataTable`; JSON → `JsonEditor` (read-only).

### 3.4 `AgentCostPanel.tsx` (P2)
- **Purpose**: Per-agent cost dashboard with budget caps and burn-down.
- **Props**: `agents: AgentTelemetry[]`, `budgets: Record<agentName, {cap, spent}>`
- **Wireframe**: 3-column grid inside `AgentsPage` below `AgentTelemetryTable`.
```
┌────────────┬────────────┬────────────┐
│ planner    │ implementer│ tester     │
│ $1.42/$5   │ $8.91/$10  │ $0.20/$2   │
│ ▓▓░░░ 28%  │ ▓▓▓▓▓ 89%  │ ▓ 10%      │
│ ↗ +$0.12/h │ ↗ +$1.04/h │ → stable   │
└────────────┴────────────┴────────────┘
```
- Red `AlertTriangle` + `bg-red-50 border-red-200` when spent/cap > 0.9.
- **Icons**: `DollarSign`, `TrendingUp`, `TrendingDown`, `Minus`, `AlertTriangle`, `Wallet`, `Gauge`.

### 3.5 `AgentCommGraph.tsx` (P2)
- **Purpose**: Force-directed SVG graph of agent-to-agent messages via blackboard.
- **Nodes**: agents (circle, colored by mode color from v2 spec §2). **Edges**: directed arrows labeled with message count.
- **Wireframe**: 400px-tall card on `AgentsPage`.
```
        planner ──3──▶ implementer
           │                  │
           1                  2
           ▼                  ▼
        reviewer ◀──2──   tester
```
- **Icons**: `Bot`, `ArrowRight`, `MessageSquare`, `RefreshCw` (re-layout), `Maximize2`.

### 3.6 `InsightsCard.tsx` (P2)
- **Purpose**: Actionable recommendations on `OverviewPage`.
- **Insight types**: `anomaly` (cache hit drop), `recommendation` (switch to cheaper model), `budget_alert`, `stale_agent`, `mode_drift`.
- **Wireframe**: full-width card above `SummaryCards`.
```
┌──────────────────────────────────────────────────────┐
│ ✨ Insights (3)                       [Dismiss All]  │  (Sparkles icon)
├──────────────────────────────────────────────────────┤
│ ⚠ Cache hit rate dropped 18% on implementer — review│
│   recent prompts.                  [Investigate ▸]  │
│ 💡 Switch planner from gpt-5.5 to glm-5.2 for 40%   │  (Lightbulb)
│   savings on routing tasks.         [Apply ▸]       │
│ 🔔 implementer at 89% of budget.    [Open Cost ▸]   │  (BellRing)
└──────────────────────────────────────────────────────┘
```
- **Icons**: `Sparkles`, `AlertTriangle`, `Lightbulb`, `BellRing`, `ChevronRight`, `X`, `TrendingDown`.

### 3.7 `NotificationProvider.tsx` + `NotificationCenter.tsx` (P1)
- **Purpose**: Toast stack (bottom-right) + bell dropdown (top-right `TopBar`).
- **Notification shape**: `{ id, kind: 'info'|'success'|'warning'|'error', title, body, action? }`
- **Triggers**: task completion, agent failure, budget breach, DAG node failed, new issue assigned.
- **Wireframe (toast)**:
```
┌──────────────────────────────────┐
│ ✓ DAG "build-pipeline" completed │  (CheckCircle2, green)
│   6 nodes, $0.43, 2m 14s         │
│                       [View] [×] │
└──────────────────────────────────┘
```
- **Bell**: `Bell` icon in `TopBar` with unread `bg-red-500` pill.
- **Icons**: `Bell`, `CheckCircle2`, `AlertTriangle`, `XCircle`, `Info`, `X`, `BellOff` (mute).

### 3.8 `SearchIndex.ts` (P1, logic only)
- **Purpose**: In-memory index over sessions, events, issues, agents for command palette + dedicated search.
- **API**: `index(workspace)`, `query(text): SearchResult[]` where `SearchResult = { type, id, title, subtitle, icon }`.
- **Build**: lazy on first open of palette; rebuild on workspace switch.

### 3.9 `useKeyboardNav.ts` (P0, hook)
- **Purpose**: Global keymap hook mounted in `AppShell`.
- **Bindings**:
  - `Cmd/Ctrl+K` → open palette
  - `g then o/s/a/r/t/d/c/i` → go to page (vim-style)
  - `r` → refresh
  - `?` → show keyboard help overlay
  - `Escape` → close any overlay/drawer
  - `j/k` → move selection in active list (SessionList, IssueBoard, EventStream)
  - `Enter` → open selected item
- **Icons for help overlay**: `Keyboard`, `CornerDownLeft`, `ArrowUp`, `ArrowDown`, `Command`, `X`.

### 3.10 `ThemeProvider.tsx` (P0)
- **Purpose**: Provides `theme: 'light'|'dark'`, persists to Electron userData, toggles `document.documentElement.classList`.
- **Default**: respect `prefers-color-scheme`.
- **Toggle UI**: `Sun`/`Moon` icon button in `TopBar` next to Refresh.
- **Tailwind**: all v2 color classes get `dark:` variants (e.g. `bg-white dark:bg-slate-800`, `text-slate-800 dark:text-slate-100`).

---

## 4. Existing Component Improvements

### 4.1 `AppShell.tsx`
**File**: `desktop/src/components/AppShell.tsx`

| Change | Detail |
|---|---|
| Add `Issues` nav item | Insert `{ id: 'issues', label: 'Issues', icon: 'SquareCheckBig' }` between `sessions` and `agents` in `NAV_ITEMS`. Update `PageName` type in store. |
| Add `Inbox` badge | Mirror Paperclip: unread issue count pill on `issues` nav item (reuse existing `NavBadge` pattern shown for agents). |
| Add Command Palette trigger | New button in `TopBar` right cluster: `Search` icon + "Search" label + `⌘K` kbd hint. Mount `<CommandPalette>` at shell root. |
| Add Notification bell | `Bell` icon button with unread pill; opens `NotificationCenter` dropdown. |
| Add Theme toggle | `Sun`/`Moon` button next to Refresh. |
| Add live status indicator | Pulsing `bg-green-500` dot in `TopBar` when WS connected; `bg-amber-500` when reconnecting; `bg-red-500` when disconnected. Tooltip shows latency. |
| Mount global hooks | `useKeyboardNav()`, `useWebSocket()` (new), `<NotificationProvider>`, `<ThemeProvider>`. |
| Add `SidebarProjects` + `SidebarAgents` sections (Paperclip pattern) | Below nav, collapsible groups listing active projects (top 3 by recency) and active agents (status dot + name). Clicking jumps to relevant page filtered. |
| Sidebar footer | Keep existing workspace footer; add maturity stage badge (M1–M6 color from v2 §2). |

### 4.2 `OverviewPage.tsx`
- Insert `<InsightsCard>` at top (above `SummaryCards`).
- `SummaryCards`: add `dark:` variants; add `Sparkles` icon to any card with an active insight.
- `ActiveAgentsList`: make rows keyboard-selectable (`j/k` + `Enter`); add "Open in Issues" action per row (`ArrowUpRight`).
- Add `RecommendationsPanel` (subset of insights) when no active agents.

### 4.3 `SessionsPage.tsx` (major refactor for #6)
- Replace single `SessionDetail` with `SessionTabs`:
```
┌────────────┬──────────────────────────────────────────┐
│SessionList │ [dag-t2 ×] [hetero-planner ×] [live ●] + │
│            ├──────────────────────────────────────────┤
│            │ SessionDetail (active tab)               │
│            │  + FilePreviewPanel (toggle, 40% width)  │
└────────────┴──────────────────────────────────────────┘
```
- Live sessions (still streaming) get a pulsing `bg-green-500` dot on tab.
- Tabs draggable to reorder; close button per tab (`X`).
- `SessionList` gains filter bar: search input (`Search`), status filter (`Filter`), agent filter (`Users`).
- Each `SessionListItem` shows mini usage bar (reuse `UsageBar`).

### 4.4 `AgentsPage.tsx`
- Add `AgentCostPanel` (§3.4) below `AgentTelemetryTable`.
- Add `AgentCommGraph` (§3.5) as a new card.
- `AgentStatusTable`: rows update live via WS (no manual refresh); `Loader2` spin on `running` rows.
- `ModelAssignmentEditor`: upgrade to visual dropdown (model picker with cost/latency preview) instead of raw text; writes still go to agent `.md` frontmatter.

### 4.5 `DAGPage.tsx` (live execution #8)
- Subscribe to WS `dag.node.*` events; update node fill colors in real time.
- `DAGProgress`: animated bar; show `completed/failed/total` + ETA (`Clock`).
- Add streaming log panel below visualization: `Terminal`-styled monospace, auto-scroll, `Pause`/`Play` (`CirclePause`/`CirclePlay`) toggle.
- Node tooltips show: role, model, status, cost, duration, last message preview.

### 4.6 `TelemetryPage.tsx`
- `EventStreamPanel`: add filter chips (`Filter`), search box, pause/resume; virtualize rows for >1000 events.
- Add `CacheTrendChart` overlay toggles: 1h / 24h / 7d (`Clock`).

### 4.7 `ConfigPage.tsx`
- Keep JSON editors but add "Visual" tab per config: form-based editor with validation, save writes JSON.
- `AgentRoleEditor`: render as form (name, description, model picker, thinking toggle, tools multi-select) backed by frontmatter.

### 4.8 `SettingsPage.tsx` (expand #12)
- New sections:
  1. **Appearance**: theme toggle, density (compact/comfortable), sidebar collapse default.
  2. **Models**: model registry table (name, provider, context window, cost/1M in/out, latency); add/remove/test connection (`Plug`/`PlugZap`).
  3. **Agent Roles**: reuse visual `AgentRoleEditor`.
  4. **Budgets**: per-agent cost caps (numeric inputs, `DollarSign`).
  5. **Notifications**: enable/disable per kind (`Bell`), sound toggle (`Volume2`/`VolumeX`).
  6. **Keyboard**: link to `?` help; remap support (future).
  7. **Data & Storage**: clear cache, export events, session retention days.
- Icons: `Palette`, `Cpu`, `Bot`, `Wallet`, `Bell`, `Keyboard`, `Database`, `Download`, `Trash2`.

### 4.9 Shared `ui.tsx`
- Add `dark:` variants to `Card`, `Badge`, `StatusDot`, `DataTable`, `EmptyState`.
- Add new primitives:
  - `Tabs` ({tabs, active, onChange}) — for SessionTabs, ConfigPage, IssuesPage drawer.
  - `Drawer` ({side:'right', open, onClose, title, children}) — for IssueDetailDrawer.
  - `Toast` container — rendered by `NotificationProvider`.
  - `Modal` ({open, onClose, children}) — for confirmations, New Issue form.
  - `Kbd` — renders `<kbd>` styled for keyboard hints (`⌘K`).
  - `Tooltip` — wraps children, shows on hover/focus.
  - `LiveBadge` — pulsing dot + label for live/streaming state.

---

## 5. Interaction Flow Updates

### 5.1 Real-time update flow (#4)
```
Electron main process
  ├─ Watch .agentflux/runtime/events.jsonl (chokokidar/fs.watch tail)
  ├─ Watch sessions/*.jsonl (append mode)
  └─ Emit over WebSocket (ws://localhost:<port>) JSON envelopes:
       { kind: 'event.append', event }
       { kind: 'agent.status', agent }
       { kind: 'dag.node', nodeId, status }
       { kind: 'session.message', sessionId, message }
       { kind: 'issue.update', issue }
Renderer (dashboard-store)
  ├─ useWebSocket() hook subscribes on mount
  ├─ On event.append → append to events[], recompute aggregations (debounced 200ms)
  ├─ On agent.status → patch agentStatus map
  ├─ On dag.node → patch DAG node state, nudge progress bar
  ├─ On session.message → if tab open, append message; else increment unread pill
  └─ On issue.update → patch issues[], bump Inbox badge
Connection lifecycle:
  - On open: full sync (request snapshot)
  - On close: exponential backoff reconnect (max 10s), show amber dot
  - On error: red dot + notification toast
```

### 5.2 Command Palette flow (#2)
```
User presses Cmd/Ctrl+K
  → AppShell useKeyboardNav captures
  → setPaletteOpen(true)
  → CommandPalette mounts, focuses input, builds index (lazy)
  → User types query
    → debounced 80ms filter over commands + SearchIndex.query()
    → grouped results rendered
  → User navigates ↑/↓, Enter
    → perform(): setPage / openIssue / newIssue / openSession
    → push to recentCommands (persist top 8)
    → onClose()
```

### 5.3 Issue lifecycle flow (#1)
```
User: Cmd+K → "New Issue"  OR  IssuesPage → PlusCircle button
  → Modal: title, assignee (agent picker), priority, tags, linked DAG?
  → On save: write issues.json, emit issue.update via WS
  → Assigned agent's next subagent.run picks up issue (AgentFlux runtime contract)
  → Status transitions flow back via WS as agent updates blackboard
  → Board card animates between columns
  → Notification fires on status change to review/done/blocked
```

### 5.4 Parallel sessions flow (#6)
```
SessionsPage mounts
  → list sessions (sorted: live first, then recent)
  → User clicks session → opens as new tab (or focuses existing)
  → Live session: subscribe to session.message WS channel for that id
  → Switching tabs: pause message append for non-active, keep unread count
  → Closing tab: if live, confirm "Session still running — keep watching?"
  → File preview: message contains file ref → click → open FilePreviewPanel
```

### 5.5 Live DAG flow (#8)
```
DAGPage mounts
  → fetch current DAG snapshot (REST/IPC)
  → subscribe to dag.node WS channel
  → On dag.node: patch node.status, recolor, bump progress bar
  → Streaming logs: subscribe to dag.log channel, append to terminal panel
  → On DAG complete: notification "DAG completed", offer "Open in Issues"
```

### 5.6 Notification flow (#13)
```
WS event or local action → NotificationProvider.notify(kind, title, body, action)
  → Push to toasts[] (max 4 visible; queue rest)
  → Auto-dismiss after 6s (errors persist until dismissed)
  → Increment bell unread counter
  → Click action → navigate (setPage / openDrawer)
  → Mute per kind from Settings
```

### 5.7 Dark mode flow (#11)
```
ThemeProvider init:
  → read persisted theme from Electron userData settings.json
  → fallback to window.matchMedia('(prefers-color-scheme: dark)')
  → apply: document.documentElement.classList.toggle('dark', isDark)
Toggle:
  → flip state, persist, reapply class
  → all components rely on dark: Tailwind variants (no JS conditionals)
```

---

## 6. Implementation Order (dependency-aware)

### Phase 0 — Foundation (P0, weeks 1–2)
| Step | Component | Depends on |
|---|---|---|
| 0.1 | `ThemeProvider.tsx` + `dark:` variants across `ui.tsx` | — |
| 0.2 | `useKeyboardNav.ts` hook + `?` help overlay | — |
| 0.3 | WebSocket bridge in `electron/main.ts` (fs watch → WS emit) + `useWebSocket()` hook | — |
| 0.4 | `CommandPalette.tsx` + `SearchIndex.ts` (nav + actions only) | 0.2 |
| 0.5 | `AppShell.tsx` integration: palette mount, theme toggle, live dot, sidebar projects/agents sections | 0.1, 0.2, 0.3, 0.4 |

### Phase 1 — Core value (P1, weeks 3–5)
| Step | Component | Depends on |
|---|---|---|
| 1.1 | `NotificationProvider.tsx` + `NotificationCenter.tsx` + bell in TopBar | 0.3, 0.5 |
| 1.2 | `IssuesPage.tsx` + `IssueBoard.tsx` + `IssueDetailDrawer.tsx` + issues.json contract + `issues` nav item + WS issue.update | 0.3, 0.5 |
| 1.3 | `SessionsPage.tsx` refactor: `SessionTabs`, filter bar, live session subscribe | 0.3 |
| 1.4 | `DAGPage.tsx` live updates + streaming logs + progress ETA | 0.3 |
| 1.5 | Extend `SearchIndex.ts` to include sessions, events, issues, agents; wire into palette `search` group | 1.2, 1.3 |

### Phase 2 — Depth (P2, weeks 6–8)
| Step | Component | Depends on |
|---|---|---|
| 2.1 | `FilePreviewPanel.tsx` integrated into `SessionDetail` | 1.3 |
| 2.2 | `AgentCostPanel.tsx` + budgets in Settings + budget breach notifications | 1.1, 0.5 |
| 2.3 | `AgentCommGraph.tsx` on AgentsPage | 0.3 (for live edges) |
| 2.4 | `InsightsCard.tsx` on OverviewPage (anomaly + recommendation engine) | 0.3, 1.2 |
| 2.5 | `SettingsPage.tsx` expansion: Models, Roles (visual), Budgets, Notifications, Data, Keyboard, Appearance | 0.1, 0.2, 2.2 |
| 2.6 | `ConfigPage.tsx` visual tab editors (agentflux.json, models.json, roles) | 2.5 |

### Phase 3 — Polish (week 9)
- Keyboard help overlay content + onboarding tooltip tour (`Sparkles`/`CircleHelp`).
- Performance: virtualize `EventStreamPanel` and `SessionList`; memoize WS patches.
- Accessibility pass: focus traps in palette/drawer/modal; `aria-live` on toasts and progress bar.
- Empty states for new pages (`IssuesPage` empty: `SquareCheckBig` icon + "No issues yet — create one with ⌘K").

---

## Appendix A — New Lucide Icons to add to `ui.tsx` Icon registry

| Icon name (lucide-react) | Used by |
|---|---|
| `SquareCheckBig` | Issues nav, issue cards |
| `CircleDot` | issue status: open |
| `Eye` | issue status: review |
| `OctagonAlert` | issue status: blocked |
| `Command` | palette hint |
| `CornerDownLeft` | palette enter hint |
| `ArrowUp` / `ArrowDown` | palette nav |
| `PlusCircle` | new issue, new tab |
| `Keyboard` | keyboard help |
| `Bell` / `BellOff` / `BellRing` | notifications |
| `Sun` / `Moon` | theme toggle |
| `Sparkles` | insights |
| `Lightbulb` | recommendations |
| `FileCode` / `FileText` / `FileImage` / `Braces` | file preview |
| `Wallet` / `Gauge` | cost panel |
| `TrendingUp` / `TrendingDown` / `Minus` | trends |
| `Palette` | appearance settings |
| `Plug` / `PlugZap` | model connection |
| `Volume2` / `VolumeX` | notification sound |
| `Terminal` | DAG logs |
| `CirclePause` / `CirclePlay` | log stream control |
| `Filter` | list filters |
| `Maximize2` | graph expand |
| `GitBranch` | issue → DAG link |
| `ArrowUpRight` | open-in action |
| `LiveBadge` (built from `Circle` + animate-pulse) | live sessions/agents |

## Appendix B — New Tailwind class additions (semantic, all with `dark:` variants)

| Token | Light | Dark |
|---|---|---|
| surface-app | `bg-slate-100` | `dark:bg-slate-900` |
| surface-card | `bg-white` | `dark:bg-slate-800` |
| surface-sidebar | `bg-slate-900` | `dark:bg-black` |
| surface-overlay | `bg-white` | `dark:bg-slate-800` |
| border-default | `border-slate-200` | `dark:border-slate-700` |
| text-primary | `text-slate-800` | `dark:text-slate-100` |
| text-secondary | `text-slate-500` | `dark:text-slate-400` |
| accent | `text-blue-600` | `dark:text-blue-400` |
| live-pulse | `bg-green-500 animate-pulse` | `dark:bg-green-400` |
| warning-surface | `bg-amber-50 border-amber-200` | `dark:bg-amber-950/40 dark:border-amber-800` |
| error-surface | `bg-red-50 border-red-200` | `dark:bg-red-950/40 dark:border-red-800` |
| success-surface | `bg-green-50 border-green-200` | `dark:bg-green-950/40 dark:border-green-800` |

## Appendix C — New IPC / WS channels

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `ws:connect` | renderer←main | envelope `{kind, ...}` | all live updates |
| `ws:snapshot` | renderer→main | `{since: timestamp}` | reconnect sync |
| `issue:list` | renderer↔main | `Issue[]` | read/write `.agentflux/issues.json` |
| `issue:update` | renderer→main | `Issue` | upsert + broadcast |
| `search:index` | renderer→main | `{workspaceId}` | build/refresh search index |
| `search:query` | renderer→main | `{q}` → `SearchResult[]` | unified search |
| `model:test` | renderer→main | `{modelId}` → `{ok, latencyMs}` | connection test |
| `file:read` | renderer→main | `{path}` → `{content, mimeType}` | file preview |
| `budget:set` | renderer→main | `{agentName, capUsd}` | persist budget cap |

---

_End of v2.1 spec. Implementers: start at Phase 0.1; do not skip the `dark:` variant pass in `ui.tsx` — every later component depends on it._
