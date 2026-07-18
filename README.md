# AgentFlux

Agent working mode router — multi-mode orchestration + intelligent routing for [pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

## Quick Start

### Option 1: Project-local auto-load

AgentFlux is configured in `.pi/settings.json` to auto-load when you run `pi` in this project:

```bash
cd <agentflux-dir>
pi --provider <your-provider> --model <your-model>
```

No `-e` flag needed. The extension loads automatically.

### Option 2: Manual load (any directory)

```bash
pi -e ./src/entry.ts --provider <your-provider> --model <your-model>
```

### Option 3: Install as pi package (for other projects)

```bash
# From local path
pi install ./

# Or from git (when published)
pi install git:github.com/user/agentflux@v0.1.0
```

After installation, AgentFlux loads automatically in any pi session.

## Commands

| Command | Description |
|---------|-------------|
| `/flux` | Open control panel menu (mode/preference/team/info) |
| `/flux work [--mode M1\|M2\|M5] <task>` | Execute with a user/main-Agent-selected mode, or omit `--mode` to use the configured route decision |
| `/flux cancel [runId\|all]` | Cancel active AgentFlux DAG runs and their child processes |
| `/flux gc dry-run` | Preview terminal/stale-runtime/message/session retention cleanup |
| `/flux gc` | Archive eligible terminal or stale RPC runtime state; refuses while subagents are active |
| `/flux gc legacy dry-run <names...>` | Preview TTL-gated cleanup for explicitly named pre-instance records |
| `/flux gc legacy <names...>` | Archive named stale legacy records only when they have no instance/PID and no AgentFlux run is active |
| `/flux why` | Route inspector — why this mode was chosen |
| `/flux mode <preset>` | Switch mode preset (eco/fast/balanced/accurate/custom) |
| `/flux preference` | 5-dimension routing preference tuner |
| `/flux project` | Project maturity panel |
| `/flux complexity` | Code complexity analysis |
| `/flux compact` | Compaction advisor |
| `/flux fork` | M3 conversation tree fork |
| `/flux fork merge` | Fork merge strategies |
| `/flux team plan <task>` | Launch planner agent |
| `/flux team build <task>` | Launch implementer agent |
| `/flux team review` | Launch reviewer agent |
| `/flux team pipeline <task>` | Run plan→build→review in sequence |
| `/flux team status` | Show agent instances + blackboard |
| `/flux team roles` | List role definitions |
| `/flux team models` | List models + capability vectors |
| `/flux team affinity` | Per-role model affinity ranking |
| `/flux agents` | Show active runs, persistent agents, and DAG state |
| `/flux chat [group]` | Read SharedBoard group messages |
| `/flux groups` | List SharedBoard groups and registered agents |
| `/flux status` | Full runtime/cost/agent/issue status |
| `/flux health` | Deterministic subsystem health checks |
| `/flux restart` | Reload config, models, pricing, and router state |
| `/flux upgrade` | Check for repository updates |

## Configuration

```
.agentflux/
├── agentflux.json       # User config (mode, cache, context, preference)
├── models.json          # Model pricing + capability + role definitions
├── pricing-cache.json   # OpenRouter price cache (auto, 24h TTL)
├── project-profile.json # Project maturity (auto-generated)
├── events.jsonl         # Telemetry log
├── runtime/             # Agent instance registry
└── shared/              # Multi-agent blackboard (tasks/handoffs/decisions)
```

## Documentation

See `docs/` for design and status documents. Start with [`docs/26-implementation-status.md`](docs/26-implementation-status.md) for verified implementation status and [`docs/28-agent-workstyle-redesign.md`](docs/28-agent-workstyle-redesign.md) for the planned simplification from M1–M6 to Agent lifecycle, creation origin (including context fork), and four work styles.

## Verification

```bash
npm run verify       # offline typecheck + deterministic regression suite
npm run test:desktop-modes-zero-cost # AUTO/M1/M2/M5 through Desktop AgentRuntime; no model prompt
npm run test:all-modes-zero-cost     # M1-M6 runtime/fallback contract through Desktop workspace; no model prompt
npm run test:desktop-deepseek-live   # paid: DeepSeek Pro M1/M5 + DeepSeek Flash M2/subagent/DAG in an isolated fixture
npm run test:desktop-retry-zero-cost # failed -> Retry -> Extension UI -> done; no model prompt
npm run test:live    # opt-in live-model tests; may incur cost
```

## Update

```bash
# If installed as local path — just git pull
cd <agentflux-dir> && git pull

# If installed as pi package
pi update --extensions
```
