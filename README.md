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

See `docs/` for 21 design documents covering trilemma formalization, six work modes, routing layers, cache strategy, multi-agent architecture, and empirical findings.

## Update

```bash
# If installed as local path — just git pull
cd <agentflux-dir> && git pull

# If installed as pi package
pi update --extensions
```
