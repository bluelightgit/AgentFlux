# AgentFlux 设计规格文档

> 基于 `v0.1.0` 代码库调研产出
> 日期：2026-07-22
> 覆盖：组件层次、数据模型、接口契约、关键交互流程

---

## 目录

1. [系统概述](#1-系统概述)
2. [组件层次与包结构](#2-组件层次与包结构)
3. [核心数据模型](#3-核心数据模型)
4. [接口契约](#4-接口契约)
5. [关键交互流程](#5-关键交互流程)
6. [工作方式状态机](#6-工作方式状态机)
7. [副作用与约束](#7-副作用与约束)
8. [附录：文件索引](#8-附录文件索引)

---

## 1. 系统概述

AgentFlux 是一个基于 pi 编码 Agent 的多 Agent 工作台运行时。系统提供一个递进的任务能力体系和一个 TUI 工作台，由 Main Agent 统一调度：Direct 是基础；Team 增加动态 Agent；Workflow 与 Community 平级建立在 Team 之上，分别增加固定 DAG 和任务驱动协作。

### 1.1 核心假设

- Pi 原生 UUIDv7 作为稳定 `sessionId`
- Direct / Team / Workflow / Community 是全部且唯一的任务工作方式，但不是四套平级运行时；`agent_decides` 只是 Main Agent 的选择入口
- 模型输入中不暴露 session/task/run/agent ID
- system prompt 仅由稳定通用协议 + 四个固定工作方式模板组成
- Task Registry 位于文件系统 `.agentflux/runtime/tasks.json`

### 1.2 架构原则

| 原则 | 说明 |
|---|---|
| 只有收窄 | Agent policy 模板 → 注册实例 → 单次运行，只会收窄不会扩权 |
| 文件即状态 | 所有持久化使用 JSON 文件，不做 IPC，可审计，git 友好 |
| 隔离错误 | 并行 Agent 互相隔离，一个失败不影响其他 |
| fail-closed | 锁冲突、策略验证失败等情况下拒绝执行而非部分执行 |
| 不做过多抽象 | 当前函数模块已覆盖复用点，等第二种实现出现再抽象 |

---

## 2. 组件层次与包结构

### 2.1 目录树

```
src/
├── entry.ts                    # pi Extension 主入口（工具注册 + 生命周期 + TUI）
├── subagent-entry.ts           # 子 Agent 精简入口（仅前缀布局 + 工具门禁）
├── string-utils.ts             # 字符串工具
│
├── contracts/index.ts          # 公众类型导出（API surface）
│
├── core/                       # 核心领域逻辑
│   ├── types.ts                # 基础类型 + DEFAULT_CONFIG
│   ├── config.ts               # 配置加载/合并/验证
│   ├── task-envelope.ts        # 任务信封编码/解码
│   ├── task-execution.ts       # 执行计划创建/格式化
│   ├── task-registry.ts        # Task Registry 持久化
│   ├── shared-board.ts         # 共享黑板（团队协作状态）
│   ├── message-bus.ts          # Message V2 可靠消息
│   ├── community.ts            # Issue/Claim 状态机
│   ├── communication-policy.ts # Agent 通信策略
│   ├── capability-policy.ts    # 能力策略三层解析
│   ├── model-capability.ts     # 模型能力向量匹配
│   ├── pricing.ts              # 定价表
│   ├── cache-impact.ts         # 缓存影响评估
│   ├── lifecycle-gc.ts         # 生命周期回收
│   └── agent-message-runtime.ts # Agent 消息运行时
│
├── agents/                     # Agent 生命周期与执行
│   ├── agent-lifecycle.ts      # Ephemeral Agent 生命周期
│   ├── agent-runner.ts         # 一次 Agent 运行 + 并行 Team
│   ├── persistent-agent.ts     # Persistent Agent 注册/运行/存档
│   ├── session-fork.ts         # Pi 原生会话 fork
│   └── templates.ts            # 角色模板加载（MD/JSON/内置）
│
├── workflows/                  # DAG 工作流
│   ├── dag-executor.ts         # DAG 执行器（拓扑排序/并行/重试）
│   ├── workflow-registry.ts     # Workflow 定义、版本与选择器
│   └── quality-gate.ts         # 质量门（LLM 验收检查）
│
├── extension/                  # 扩展层
│   ├── commands.ts             # /flux 命令解析 + 补全
│   ├── tui-menu.ts             # TUI 交互菜单
│   ├── tui-autocomplete-bridge.ts # 斜杠自动补全桥接
│   ├── prefix-layout.ts        # 前缀布局缓存优化
│   ├── cache-monitor.ts        # 缓存统计监控
│   ├── compaction-advisor.ts   # 上下文压缩建议
│   ├── mask.ts                 # 上下文掩码
│   └── rpc-inbox-pump.ts       # RPC 收件箱轮询泵
│
├── telemetry/
│   └── events.ts               # Telemetry 事件写入器
│
```
（2026-08-12 已移除：原 host/ 与 contracts/ 层随 Desktop/PiDeck 放弃而删除，外部宿主 API 不再提供）
```

### 2.2 层依赖关系

```
┌─────────────────────────────────────────────┐
│              entry.ts / subagent-entry.ts    │  ← 扩展入口
├─────────────┬───────────────┬───────────────┤
│  extension/ │  telemetry/   │  host/        │  ← 扩展层
├─────────────┴───────────────┴───────────────┤
│             core/ + agents/ + workflows/    │  ← 核心层 (无 UI 依赖)
└─────────────────────────────────────────────┘
```

依赖方向：`core/` → 无外部依赖；`agents/` → 依赖 `core/`；`workflows/` → 依赖 `agents/` + `core/`；`extension/` → 依赖所有核心模块。

### 2.3 关键类（非 class 的函数模块）

| 模块 | 风格 | 关键类型 |
|---|---|---|
| SharedBoard | class | 文件级黑板 + 注册表 + 锁 |
| MessageBus | class | 文件级消息 V2 传输 |
| TelemetryWriter | class | JSONL 事件追加 |
| RpcInboxPump | class | 轮询 + 批量发送到 pi |
| AgentMessageRuntime | class | subagent 侧消息运行时 |
| 其他 | 纯函数 + 类型 | 无状态、可测试 |

---

## 3. 核心数据模型

### 3.1 类型关系全景

```
FluxConfig
  ├── CacheConfig         { prefix_layout, cache_breaker_actions, target_hit_rate }
  ├── ContextConfig       { compaction_threshold, mask_strategy, mask_keep_last_n }
  ├── BudgetConfig        { max_cost_per_task, max_iterations, max_wall_clock_seconds }
  ├── RetentionConfig     { stale_runtime_ttl_hours, terminal_agent_ttl_hours, ... }
  ├── CommunicationRuntimeConfig { rpc_inbox_pump, poll_interval_ms, ... }
  └── PricingConfig

TaskExecutionPlan
  ├── taskId: string
  ├── task: string
  ├── workStyle: WorkStyle
  ├── selectedBy: "user" | "main_agent"
  ├── operation: TaskOperation   ("new" | "reuse" | "resume" | "continue")
  ├── parentTaskId?: string
  └── budget: { maxCostUsd, maxIterations, maxWallClockMs }

TaskRecord (持久化)
  ├── id, sessionId, task, workStyle, selectedBy, operation, parentTaskId
  ├── status: TaskStatus ("created" | "running" | "completed" | "failed" | "cancelled" | "timed_out")
  ├── resource?: { type: "issue" | "workflow"; id: string }
  └── team?: Array<{ name, role?, persistent? }>

AgentRecord
  ├── id, name, kind (main|ephemeral|persistent), role, status
  ├── lineage: AgentLineage { origin, parentAgentId?, templateId?, forkPoint? }
  ├── model?, provider?, sessionId?
  ├── callCount, totalCostUsd, capabilityGeneration
  └── createdAt, updatedAt, lastTask?

AgentTemplate (运行定义)
  ├── name, role?, description
  ├── tools?, skills?, mcpServers?, workspace?
  ├── model?, provider?
  ├── systemPrompt, thinking?
  └── communication?: CommunicationPolicyInput

AgentRunResult
  ├── agent, exitCode, output
  ├── usage: { turns, input, output, cacheRead, cacheWrite, cost, contextTokens }
  ├── model, errorMessage?, retryCount?
  ├── fallbackModel?, fallbackFrom?
  ├── communication?: CommunicationContractReport
  └── capability?: { snapshotPath, narrowed[], cacheBreakingChanges[] }

CommunityIssue
  ├── id, title, description
  ├── status: IssueStatus ("open"|"triage"|"forming"|"executing"|"reviewing"|"resolved"|"blocked")
  ├── createdBy, comments[], claims[]
  └── acceptanceCriteria: string[]

IssueClaim
  ├── id, agent, scope
  └── status: "active" | "submitted" | "reviewed"

TaskDAG
  ├── description, planningCostUsd?
  └── nodes: TaskNode[]
      ├── id, title, role, dependsOn[], parallelizable
      ├── acceptanceCriteria[], files[]
      └── description?

WorkflowDefinition
  ├── id, name, version, description
  ├── dag: TaskDAG
  ├── sourceTaskId?
  └── createdAt, updatedAt

TaskNode / TaskExecutionResult
  └── DAGExecutionResult: { executionId, taskResults, allPassed, status, totalCost, ... }

ParallelRunResult
  ├── results: AgentRunResult[]
  ├── wallClockMs, sumIndividualMs, speedupRatio
  ├── totalCost, allSucceeded, errors[]

MessageEnvelopeV2
  ├── id, from, channel (direct|broadcast|group|system), type, content
  ├── recipients[], priority, createdAt, expiresAt?
  └── dedupeKey?, correlationId?, taskId?, artifactId?, senderInstanceId?

MessageDeliveryV2
  ├── messageId, recipient, status (pending|delivered|acknowledged|rejected|expired)
  ├── attempts, createdAt
  └── deliveredAt?, acknowledgedAt?, rejectedAt?

ResolvedCapabilityPolicy
  ├── schemaVersion, agentName, role, runId, instanceId?
  ├── layers: { template, registered?, run? }
  ├── effective: EffectiveCapabilityPolicy
  │     ├── tools[], skills[], mcpServers[]
  │     ├── communication: CommunicationPolicy
  │     └── workspace: { roots[], deniedPaths[], blockDangerousCommands, enforcement }
  ├── provenance[], narrowed[]
  └── updatedAt

FluxRuntimeState
  └── { workStyle, turnIndex, branch, cache: CacheStats }
```

### 3.2 文件存储布局

```
.agentflux/
├── agentflux.json              # FluxConfig (用户编辑)
├── models.json                 # 模型/角色/Skills 定义
├── events.jsonl                # Telemetry 事件流
├── issues.json                 # CommunityIssue[]
│
├── runtime/
│   ├── tasks.json              # TaskRegistry { version, tasks[] }
│   ├── agents.json             # Persistent Agent 注册表
│   ├── dag-state.json          # 最新 DAG checkpoint
│   ├── sessions/               # Persistent Agent 的 pi session 文件
│   ├── runs/<executionId>/     # Workflow 运行数据
│   │     ├── dag.json          # 规划的 TaskDAG
│   │     ├── checkpoint.json   # 执行断点
│   │     └── artifacts/        # 节点输出
│   ├── capability-overrides/   # 注册实例能力策略
│   └── capability-effective/   # 解析后的有效策略快照
│
├── shared/
│   ├── blackboard.json         # 共享黑板
│   ├─┬ agents/
│   │ └── _registry.json        # Agent 注册表 (含运行时)
│   ├─┬ groups/
│   │ └── _registry.json        # 群组与成员注册表；新消息统一进入 Message V2
│   ├─┬ tasks/                  # 任务队列 (shared-board)
│   ├── handoffs/               # 交接文档
│   ├── decisions/              # 决策记录
│   ├─┬ messages/               # V1 消息
│   ├─┬ messages-v2/            # V2 消息
│   │   ├── envelopes/          # 消息信封
│   │   ├── deliveries/<agent>/ # 投递状态
│   │   └── cursors/            # 游标
│   └── locks/                  # 文件锁
│
├── archive/lifecycle/          # GC 归档
└── test-results/               # 测试证据
```

### 3.3 状态枚举

| 枚举 | 值 |
|---|---|
| WorkStyle | `"direct"` `"team"` `"workflow"` `"community"` |
| WorkStyleSelection | WorkStyle + `"agent_decides"` |
| TaskOperation | `"new"` `"reuse"` `"resume"` `"continue"` |
| TaskStatus | `"created"` `"running"` `"completed"` `"failed"` `"cancelled"` `"timed_out"` |
| AgentKind | `"main"` `"ephemeral"` `"persistent"` |
| AgentStatus | `"idle"` `"running"` `"blocked"` `"done"` `"failed"` `"cancelled"` `"archived"` |
| IssueStatus | `"open"` `"triage"` `"forming"` `"executing"` `"reviewing"` `"resolved"` `"blocked"` |
| ClaimStatus | `"active"` `"submitted"` `"reviewed"` |
| MessagePriority | `"low"` `"normal"` `"high"` `"critical"` |
| DeliveryStatus | `"pending"` `"delivered"` `"acknowledged"` `"rejected"` `"expired"` |
| CapabilityLayer | `"template"` `"registered"` `"run"` |
| TelemetryOutcomeStatus | `"success"` `"failure"` `"partial"` `"cancelled"` `"timeout"` `"unknown"` |

---

## 4. 接口契约

### 4.1 pi Extension 生命周期钩子

| 钩子 | 触发点 | 用途 |
|---|---|---|
| `session_start` | pi 会话启动 | 初始化 runtime context、配置、定价表 |
| `context` | 上下文组装前 | 应用上下文掩码（mask 策略） |
| `before_provider_request` | 发送给 provider 前 | 注入 cache_control 前缀布局 |
| `input` | 用户输入 | 解码 AgentFlux 任务信封 → 纯用户任务 |
| `before_agent_start` | Agent 启动前 | 注入工作方式 system prompt |
| `turn_end` | LLM 一轮完成 | 递增 turnIndex |
| `agent_end` | 一次 Agent 运行完成 | 检测最后 assistant 是否错误 |
| `agent_settled` | Agent 最终结束 | 写入 task outcome、更新 Registry |
| `session_shutdown` | 会话关闭 | 中止所有活跃运行 |

### 4.2 pi Tool 契约

系统注册了 6 个工具，Main Agent 通过这些工具实现工作方式：

#### `flux_task`

| 字段 | 类型 | 说明 |
|---|---|---|
| action | `"list"`\|`"inspect"`\|`"new"`\|`"reuse"`\|`"resume"`\|`"continue"` | 任务操作 |
| selector? | `string` | Task ID / "latest" / "latest_<style>" |
| task? | `string` | 新任务正文 |
| workStyle? | WorkStyle | 工作方式 |

行为契约：
- `list`：返回当前 session 最近 10 条任务
- `inspect`：返回指定任务的详情
- `new/reuse/resume/continue`：创建 `TaskExecutionPlan`，设置 `currentPlan`，提示 Main Agent 下一步
- `resume`：仅允许 `failed/cancelled/timed_out/running` 源任务
- `reuse`：复用工作方式和成员结构，创建新执行
- `continue`：继承历史结果开启下一阶段

#### `flux_agent`

| 字段 | 类型 | 说明 |
|---|---|---|
| action | `"run_ephemeral"`\|`"create_persistent"`\|`"run_persistent"`\|`"list"`\|`"archive"` | Agent 操作 |
| name? | `string` | Agent 名称 |
| role? | `string` | 角色模板 |
| task? | `string` | 任务 |
| lockFiles? | `string[]` | 文件锁路径 |

行为契约：
- `run_ephemeral`：创建单次 Agent 子进程，结束后不保留身份
- `create_persistent`：从角色模板注册持久 Agent
- `run_persistent`：用现有持久 Agent 的稳定 session 运行任务
- `archive`：标记为 archived（GC 可回收）
- `list`：列出所有 Persistent Agents

#### `flux_team`

| 字段 | 类型 | 说明 |
|---|---|---|
| tasks | `Array<{ name, role?, task, persistent?, lockFiles? }>` | 1–5 个并行子任务 |

行为契约：
- 并行执行所有非 persistent 子任务到 Ephemeral Agent
- Persistent 子任务串行等待
- 结果使用 `formatParallelAgentResults` 聚合
- 自动注入 SharedBoard 读取的 inbox 消息

#### `flux_workflow`

| 字段 | 类型 | 说明 |
|---|---|---|
| action? | `"run"`\|`"list"`\|`"show"`\|`"reuse"`\|`"modify"` | 默认 run |
| task? | `string` | 新任务或修改要求 |
| workflow? | `string` | Workflow ID、名称或 `id@version` |
| name? | `string` | 新定义名称 |

行为契约：
- `list/show`：只读查询，不激活 Workflow 能力
- `run`：planner 生成 DAG，保存 v1 并执行
- `reuse`：读取保存的 DAG，跳过 planner，创建新 execution
- `modify`：基于当前 DAG 和修改要求重新规划，同一 ID 递增版本
- 调用 `generateTaskDAG`（内部调用 planner Agent）
- 校验 DAG 合法性（环、缺失依赖）
- 按拓扑序执行节点，支持并行
- 注入质量门检查
- 支持 reviewer 失败触发上游 implementer 重跑
- 结果持久化到 `runtime/runs/<executionId>/`

#### `flux_issue`

| 字段 | 类型 | 说明 |
|---|---|---|
| action | `"create"`\|`"list"`\|`"show"`\|`"comment"`\|`"claim"`\|`"submit"`\|`"resolve"` | Issue 操作 |
| issueId? | `string` | Issue ID |
| title?/body? | `string` | 创建参数 |
| agent?/scope? | `string` | Claim 参数 |
| claimId? | `string` | 提交 Claim |
| acceptanceCriteria? | `string[]` | 验收标准 |

行为契约：
- `create` 自动关联当前 task
- `claim` 检查 scope 冲突
- `resolve` 禁止有 active claim 时关闭
- 全操作自动调用 `selectImplicitWorkStyle("community")`

#### `flux_message`

| 字段 | 类型 | 说明 |
|---|---|---|
| action | `"send"`\|`"poll"`\|`"ack"`\|`"group_create"`\|`"group_list"`\|`"group_send"` | 消息操作 |
| sender? | `string` | 默认为 "main" |
| target? | `string` | direct 接收者或 inbox 身份 |
| content?/messageId? | `string` | 发送/确认内容 |
| group?/name? | `string` | 群组 ID / 新群组名 |
| members? | `string[]` | 新群组成员；自动包含 sender |
| priority? | `low`\|`normal`\|`high`\|`critical` | 消息优先级 |

行为契约：
- `send` 向指定 Agent 发送直接消息
- `poll` 拉取待处理消息
- `ack` 确认投递
- `group_create/group_list/group_send` 管理群组并为每个非发送者成员创建独立 V2 delivery
- direct/group send 自动关联当前 taskId；`group_list` 是跨工作方式可用的只读查询
- TUI 使用 `peek` 非消费式展示 Main inbox，只有显式打开时才 `poll` 为 delivered

#### Subagent 侧工具：`flux_agent_message`

仅在子进程 `subagent-entry.ts` 中注册（当通信策略启用时）。与 Main 侧的 `flux_message` 对应但使用 `AgentMessageRuntime` 执行，sender 和 instanceId 由环境变量固定。

### 4.3 文件级别接口

#### `agent_message` 工具（子进程侧）

```typescript
interface FluxAgentMessageInput {
  action: "send" | "poll" | "ack" | "status";
  target?: string;       // send 用
  messageType?: string;  // 消息类型
  content?: string;      // send 用
  messageId?: string;    // ack 用
  dedupeKey?: string;    // send 用（去重）
  limit?: number;        // poll 用（1-100）
  priority?: "low" | "normal" | "high" | "critical";
}
```

运行时身份由环境变量 `AGENTFLUX_AGENT_NAME`、`AGENTFLUX_AGENT_INSTANCE_ID`、`AGENTFLUX_RUN_ID` 固定。

#### ~~`Host` 模块 API~~（2026-08-12 已移除：随 Desktop/PiDeck 放弃，外部宿主 API 层删除）

```typescript
// 项目快照
function readAgentFluxProject(cwd: string): AgentFluxProjectSnapshot;

// 事件分页读取
function readAgentFluxEvents(cwd: string, cursor?: number): AgentFluxEventPage;

// 发送消息到 Agent
function sendAgentMessage(cwd: string, input: AgentFluxSendMessageInput): AgentFluxSendMessageResult;

// GC 运行
function runLifecycleGc(fluxDir: string, policy: RetentionConfig, options?: LifecycleGcOptions): LifecycleGcReport;
```

### 4.4 Shell 级接口（子进程执行）

`runAgent` 和 `checkQualityGate` 都通过 `spawn` pi CLI 子进程执行：

```
node <pi-cli.js> --mode json -p --no-prompt-templates --no-context-files --approve
  [--no-session | --session-dir <dir> --session-id <id>]
  [--skill <skill>]... [--no-skills]
  [--no-extensions -e <subagent-entry> | --no-extensions]
  [--provider <provider>] [--model <model>]
  [--thinking <level>]
  [--tools <tool1,tool2,...> | --no-tools]
  [--append-system-prompt <file>]
  Task: <task text>
```

Pi 在 `--mode json` 下输出 `message_end` JSON 事件到 stdout，AgentFlux 实时解析提取 usage/模型/output。

---

## 5. 关键交互流程

### 5.1 系统初始化流程

```
Pi session_start
  → entry.ts: loadConfig, loadModelsConfig, loadPricing
  → 创建 TelemetryWriter
  → 获取 sessionId (Pi UUIDv7)
  → 初始化 RuntimeContext { cwd, fluxDir, config, modelsConfig, sharedSkills, pricing }
  → 注册 6 个 tool + 1 个 command ("flux")

User input (含 AgentFlux 信封或直接提示)
  → input hook: parseAgentFluxTaskEnvelope → 协议头解码
    └── 无信封时跳过
  → before_agent_start:
    └── 有信封 → currentPlan = startPlan(...)
    └── 无信封 → 设置 implicitTask, 注入 operatingProtocol
  → Pi 正常执行 Main Agent
```

### 5.2 Direct 工作方式

```
User: "/flux work direct <task>" 或 自然语言
  → parseFluxCommand → createTaskExecutionPlan(workStyle="direct")
  → registerTask(status="running")
  → telemetry.writeTaskExecution("created" + "started")
  → pi.sendUserMessage(task)
  → Main Agent 正常执行
  → agent_settled → updateTaskStatus → telemetry("completed"/"failed")
```

### 5.3 Team 工作方式

```
Main Agent 通过 flux_team tool 调用并行 Agent：

flowchart LR
    A[Main Agent] -->|flux_team| B[AgentFlux]
    B -->|runAgentsParallel| C[Ephemeral Agent 1]
    B -->|runAgentsParallel| D[Ephemeral Agent 2]
    B -->|runAgentsParallel| E[Persistent Agent 3]
    C -->|formatParallelAgentResults| F[聚合结果]
    D --> F
    E -->|await| F
    F -->|返回 content| A
    A -->|整合+验证| G[最终输出]

子进程生命周期：
  1. createEphemeralRecord → status="idle"
  2. startEphemeralRecord → status="running"
  3. spawn pi CLI 子进程
  4. 子进程在 session_start 加载 subagent-entry.ts
  5. 子进程执行期间可调用 flux_agent_message 做交叉通信
  6. 子进程结束 → finishEphemeralRecord → status="done|failed|cancelled"
```

### 5.4 Workflow 工作方式

```
Main Agent 调用 flux_workflow：

flowchart TD
    A[flux_workflow called] --> B[generateTaskDAG]
    B --> B1[spawn planner Agent 子进程]
    B1 --> B2[解析 planner JSON → TaskDAG]
    B2 --> C[validateTaskDAG: 环检测, 缺失依赖]
    C --> D[executeDAG]

    subgraph executeDAG[拓扑执行循环]
        E[找就绪节点] --> F[并行执行一批]
        F --> G[每个节点: executeNodeWithGate]
        G --> H{质量门检查}
        H -->|通过| I[标记 completed]
        H -->|失败 × N| J[标记 failed]
        I --> K[解锁下游依赖]
        J --> L{reviewer 失败?}
        L -->|是| M[重新调度上游 implementer]
        L -->|否| N[继续]
    end

    D --> O[DAGExecutionResult]
    O --> P[formatDAGResult → return]
```

节点执行细节：
1. 从 roles 加载角色模板
2. `assignModel` 选择模型（直接指定 / 亲和度匹配）
3. 生成 `AgentTemplate` 并调用 `runAgent`
4. 子进程有文件锁保护（`lockFiles`）
5. 质量门用轻量级 LLM 子进程检查验收标准
6. reviewer 节点失败 → 其上游 implementer 节点解锁重跑（最多一次）

### 5.5 Community 工作方式

```
flowchart LR
    A[Main Agent 调用 flux_issue] --> B[createIssue]
    B --> C[agents 评论/讨论]
    C --> D[claimIssue: agent认领scope]
    D --> E[agent执行并 submitClaim]
    E --> F[reviewClaim]
    F -->|通过| G[resolveIssue]
    F -->|不通过| H[退回agent]
    H --> E
    G --> I[task completed]
```

状态机：

```
open → (create issue)
  → (加入 acceptance criteria) → forming
  → (claim made) → executing
  → (claim submitted) → reviewing
  → (claims converge) → resolved

特殊情况：
  executing → blocked (需要外部输入或依赖未就绪)
  reviewing 有 active claim → 不能 resolve
```

### 5.6 任务复用/恢复/继续

```
User: "/flux task reuse" 或 Main Agent 调用 flux_task action=reuse
  → resolveTask(selector, sessionId) 找到源任务
  → createTaskExecutionPlan({
      operation: "reuse|resume|continue",
      parentTaskId: source.id,
      workStyle: source.workStyle,
      task: (用户新任务 || 源任务),
    })
  → currentPlan = plan
  → 根据工作方式行为:
    ├── Direct: Main Agent 继续
    ├── Team: 复用源任务的 team 成员结构
    ├── Workflow (resume): 读取 checkpoint 跳过已完成节点
    └── Community: 复用 Issue 关联
```

### 5.7 Agent 注册→运行→存档

```
registerPersistentAgent(name, role)
  → 从 loadAllRoles 找到角色模板
  → 创建 AgentRecord { kind: "persistent", origin: "template" }
  → 写入 runtime/agents.json

runPersistentAgent(name, task)
  → 检查 status !== "running"
  → status → "running"
  → runAgent({ persistent: true, persistentSessionId, sessionDir })
  → 子进程复用 session 文件（--session-id + --session-dir）
  → 结束后 status → "idle"|"failed"|"cancelled"
  → 更新 callCount, totalCostUsd

archivePersistentAgent(name)
  → 检查 status !== "running" && status !== "archived"
  → status → "archived"
```

### 5.8 消息投递与 ACK（V2）

```
发送方:
  MessageBus.send(input)
  → 验证发送方/接收方/内容/优先级
  → 去重检查 (dedupeHash → _dedupe.json)
  → 背压检查 (maxPendingPerRecipient)
  → 创建 MessageEnvelopeV2 + MessageDeliveryV2[] (status="pending")
  → 原子写 deliveries，再写 envelope（commit marker）
  → 返回 { envelope, deliveries, deduplicated }

接收方 (poll):
  RpcInboxPump.tick()
  → MessageBus.poll(recipient, { limit, now })
  → 读取 deliveries 目录，过滤 pending/delivered 且未过期的
  → 按优先级排序 → 选 top N
  → 标记 delivery → "delivered"，递增 attempts
  → 写入 cursor
  → 格式化消息 → 调用 pi.sendUserMessage

接收方 (ACK):
  MessageBus.acknowledge(recipient, messageId)
  → delivery → status="acknowledged"
  → 更新 cursor (lastAcknowledgedMessageId)

RPC Inbox Pump 生命周期:
  1. onAgentStart → 标记 batch.agentStarted
  2. 批量注入 → 等待 assistant 回复
  3. onAssistantMessageEnd(success) → 批量 ACK（或保留 for redelivery）
```

### 5.9 能力策略解析流程

```
resolveCapabilityPolicy(input)
  ├── template layer: cleanList(tools/skills/mcpServers), resolveCommunicationPolicy
  ├── registered layer: subset(tools), subset(skills), narrowCommunication, narrowWorkspace
  ├── run layer: 同上 (继续收窄)
  └── 如果 communication.enabled && tools 没有 "flux_agent_message" → 自动添加
```

收窄规则：
- `subset(next, current, field, layer)`：next 必须是 current 的子集，跳出则 throw
- `narrowCommunication`：allowedTargets 不能扩权，requireExplicitInboxAck 不能移除
- `narrowWorkspace`：roots 必须在 current.roots 内，不能关闭危险命令阻止
- 每个层的变化记录在 `provenance[]` 和 `narrowed[]`

### 5.10 生命周期回收流程

```
runLifecycleGc(fluxDir, policy, { dryRun, activeRunIds })
  1. 验证 policy 配置合法性
  2. 如果有活跃运行 → blocked（不回收）
  3. selectExpiredOrExcess:
     ├── Persistent Agents: terminal (failed/cancelled/archived) + 超时 TTL / 超容量
     ├── Shared Agents: terminal (done/failed/cancelled) + 超时 TTL / 超容量
     ├── Stale RPC Runtimes: 心跳过期的 rpc-runtime
     ├── Blackboard Statuses: terminal 状态
     ├── Read Direct Messages (V1): 已读 + 超时 TTL / 超容量
     └── Message V2 Envelopes: 所有 delivery 终态 + 超时 TTL / 超容量
  4. 归档/删除数据，写入 manifest
  5. 清理孤儿 session 文件
```

---

## 6. 工作方式状态机

### 6.0 能力层级与选择作用域

```text
Direct
└── Team
    ├── Workflow
    └── Community
```

工作方式按 task 选择。TUI 为一条新主任务固定方式，运行中的 steer/follow-up 不切换；`agent_decides` 由 Main Agent 根据任务语义选择，不运行独立分类器。不调用调度工具时落为 Direct。

| 当前工作方式 | Main | Agent/Team | Workflow | Issue/Claim |
|---|---:|---:|---:|---:|
| Direct | 允许 | 拒绝 | 拒绝 | 拒绝 |
| Team | 允许 | 允许 | 拒绝 | 拒绝 |
| Workflow | 允许 | 允许 | 允许 | 拒绝 |
| Community | 允许 | 允许 | 拒绝 | 允许 |

该矩阵由 `core/workstyle-policy.ts` 实现，并在所有 Main 协作工具的写入/执行入口统一检查。只读历史查询保持跨方式可用；能力调用和中途切换 fail-closed。

system prompt 由稳定公共前缀和可选的固定工作方式后缀组成。相同工作方式跨 task 保持一致；跨工作方式共享公共前缀但后缀不同，因此只承诺前缀稳定，不承诺完整缓存命中。Main 工具 schema 保持静态，执行权限在工具入口检查，避免切换方式导致工具描述随之变化。

### 6.1 任务操作状态转换

```
                  ┌──────────────────────────┐
                  │         new              │
                  │   (四种工作方式均可)      │
                  └──────────┬───────────────┘
                             │
                      ┌──────▼──────┐
                      │   running   │
                      └──────┬──────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         ┌────▼───┐   ┌─────▼────┐   ┌─────▼────┐
         │completed│   │  failed  │   │cancelled │
         └────┬────┘   └─────┬────┘   └─────┬────┘
              │              │              │
              │      continue/reuse/resume
              └──────────────┴──────────────┘
                          │
                   ┌──────▼──────┐
                   │   new task   │ (parentTaskId 链接)
                   └─────────────┘
```

### 6.2 Community Issue 状态转换

```
open ───(add criteria)──→ forming
                            │
                     (claim scope)
                            │
                            ▼
                       executing
                        │      │
                   (submit)  (blocked)
                        │      │
                        ▼      ▼
                     reviewing blocking
                        │
                   (all claims resolved)
                        │
                        ▼
                      resolved
```

### 6.3 Agent 生命周期状态

```
Ephemeral:
  idle → running → done | failed | cancelled  (终态, 不可继续)

Persistent:
  idle → running → idle | failed | cancelled
  idle | failed | cancelled → archived  (GC 可回收)
```

### 6.4 DAG 执行状态

```
DAGExecutionResult.status:
  running → passed | failed | cancelled | budget_exceeded | timed_out

节点级别:
  executeNodeWithGate:
    pending → running → (gate check) → passed | failed
    running → (节点失败) → failed → (如果 role=reviewer 且 rerun 未满) → 解锁上游 implementer → running
    node budget exceeded → failed (exitCode=75)
    signal.aborted → cancelled (exitCode=130)
    timeout → failed (exitCode=124)
```

---

## 7. 副作用与约束

### 7.1 已知限制

| 限制 | 说明 |
|---|---|
| MCP 门禁 | 非空 MCP allowlist 因 pi 缺少钩子而 fail-closed |
| 并行 fork | 不支持一次派生 N 个继承同一 snapshot 的并行运行时 |
| 预算边界 | 预算在 provider 请求边界生效，单次请求可能小额越界 |
| Community 自治 | 非后台常驻社区，Main Agent 始终是 moderator |
| 通信时效 | Ephemeral Agent 停机后不可到达；常驻 RPC agent 需要 Persistent RPC runtime |
| 文件锁 | 基于进程 ID 的乐观锁，非 OS 级强制锁 |
| 缓存 | Persistent Agent 缓存收益需长任务 soak 后量化 |
| ~~Desktop~~ | 已放弃（2026-08-12 决策），不再提供 Desktop 交付物 |

### 7.2 策略规则

1. **功率递减**：任何下层不能扩权上层定义的工具/skill/communication/workspace
2. **Fail-closed**：锁冲突、策略违规、心跳过期 → 拒绝执行，不留中间态
3. **无独立自动路由器**：`agent_decides` 由 Main Agent 根据任务理解在四种工作方式中选择，不运行额外分类器
4. **显式 ACK**：通信契约要求明确发送到指定 Agent 或显式 ACK inbox 消息
5. **Mutex 序列化**：SharedBoard 和 MessageBus 使用文件锁实现进程间互斥
6. **重试隔离**：超时 + 模型降级 + provider 配额错误 → 跨 provider 降级；503/502/rate limit → 指数退避重试；代码错误 → 不重试

### 7.3 性能特征

| 指标 | 参考值 |
|---|---|
| Direct 单次 | ~3–5 秒 |
| Team（3 Agent 并行） | ~15–30 秒 |
| Workflow（3 节点 DAG） | ~60–90 秒 |
| Community 全流程 | ~120 秒 |
| Quality Gate 单次 | ~3–5 秒 |
| RPC 消息延迟（poll 间隔） | 1 秒（可配置） |
| 子进程超时默认 | 120 秒 |
| DAG 节点超时默认 | 180 秒 |

---

## 8. 附录：文件索引

| 路径 | 职责 | 关键函数/类 |
|---|---|---|
| `src/entry.ts` | Pi 扩展主入口 | `agentFlux(pi)` - 注册所有 tools/commands/hooks |
| `src/subagent-entry.ts` | 子 Agent 精简入口 | 注册 `flux_agent_message` tool + cache layout |
| `src/contracts/index.ts` | 公开类型导出 | re-export 所有公开类型 |
| `src/core/types.ts` | 基础类型 + 默认配置 | `FluxConfig`, `DEFAULT_CONFIG`, `WorkStyle` 等 |
| `src/core/config.ts` | 配置加载/合并 | `loadConfig`, `loadModelsConfig`, `validateConfig` |
| `src/core/task-envelope.ts` | 任务信封 | `encodeAgentFluxTaskEnvelope`, `parseAgentFluxTaskEnvelope` |
| `src/core/task-execution.ts` | 执行计划 | `createTaskExecutionPlan`, `formatTaskExecutionPlan` |
| `src/core/task-registry.ts` | Task 持久化 | `registerTask`, `listTasks`, `resolveTask`, `updateTaskStatus` |
| `src/core/shared-board.ts` | 共享黑板 | `SharedBoard` class |
| `src/core/message-bus.ts` | Message V2 | `MessageBus` class |
| `src/core/community.ts` | Issue/Claim | `createIssue`, `claimIssue`, `resolveIssue` |
| `src/core/communication-policy.ts` | 通信策略 | `resolveCommunicationPolicy`, `evaluateCommunicationContract` |
| `src/core/capability-policy.ts` | 能力策略 | `resolveCapabilityPolicy`, `evaluateCapabilityToolCall` |
| `src/core/model-capability.ts` | 模型匹配 | `assignModel`, `rankModels`, `resolveCapability` |
| `src/core/pricing.ts` | 定价表 | `loadPricing`, `calcCost`, `lookupPrice` |
| `src/core/cache-impact.ts` | 缓存影响 | `assessCacheImpact`, `diffRuntimeCacheShape` |
| `src/core/lifecycle-gc.ts` | GC | `runLifecycleGc`, `formatLifecycleGcReport` |
| `src/core/agent-message-runtime.ts` | 消息运行时 | `AgentMessageRuntime` class |
| `src/agents/agent-lifecycle.ts` | Ephemeral 生命周期 | `createEphemeralRecord`, `startEphemeralRecord`, `finishEphemeralRecord` |
| `src/agents/agent-runner.ts` | Agent 执行器 | `runAgent`, `runAgentsParallel` |
| `src/agents/persistent-agent.ts` | 持久 Agent | `registerPersistentAgent`, `runPersistentAgent`, `archivePersistentAgent` |
| `src/agents/session-fork.ts` | 会话 Fork | `registerSessionFork`, `handleForkCommand` |
| `src/agents/templates.ts` | 角色模板 | `loadAllRoles`, `parseFrontmatter` |
| `src/workflows/dag-executor.ts` | DAG 执行 | `generateTaskDAG`, `executeDAG`, `parsePlannerTaskDAG` |
| `src/workflows/quality-gate.ts` | 质量门 | `checkQualityGate`, `parseQualityGateJudgeOutput` |
| `src/extension/commands.ts` | /flux 命令 | `parseFluxCommand`, `getFluxArgumentCompletions` |
| `src/extension/tui-menu.ts` | TUI 菜单 | `showFluxTuiMenu`, `showWorkTuiMenu` 等 |
| `src/extension/prefix-layout.ts` | 缓存优化 | `applyPrefixLayout` |
| `src/extension/cache-monitor.ts` | 缓存监控 | `collectCacheStats` |
| `src/extension/compaction-advisor.ts` | 压缩建议 | `analyzeCompaction`, `registerCompactionAdvisor` |
| `src/extension/mask.ts` | 上下文掩码 | `applyMask` |
| `src/extension/rpc-inbox-pump.ts` | RPC 收件箱泵 | `RpcInboxPump` class |
| `src/extension/tui-autocomplete-bridge.ts` | 自动补全 | `installSlashArgumentAutocompleteBridge` |
| `src/telemetry/events.ts` | Telemetry | `TelemetryWriter` class |
| `src/host/index.ts` | 宿主 API | `readAgentFluxProject`, `sendAgentMessage` |
