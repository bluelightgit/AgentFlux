# 19 - 多 Agent 架构

> 共享黑板 + 角色信箱。持久消息用可审计文件协议，实时 runtime 由受控 RPC pump 注入；能力按角色、注册实例和单次运行逐层收窄。

## 问题

多 agent 要解决三个问题:
1. **agent 之间怎么沟通** — 信息传递机制
2. **共享能力怎么管理** — MCP / skill / tool 的分配
3. **共享状态怎么维护** — 任务队列、决策记录、全局上下文

## 已有项目的做法

| 项目 | 沟通方式 | Skill/MCP 管理 |
|---|---|---|
| Anthropic Agent Teams | 共享 task list (所有 agent 读写同一任务列表) | 全局共享, 无隔离 |
| agent-collab | 文件交接 (`.agent/handoffs/` 写 handoff 文档) | SKILL.md 随项目走 |
| agent-teams-rs | mailbox 收件箱 (每 agent 有 inbox, DAG 依赖) | 各 backend 自带工具 |
| GitSwarm | git 分支 (stream = feature branch, commit/review/merge) | 插件按 governance tier 分 |
| AWS agent-team | 共享队列 (parent agent 维护, specialist 取任务) | .claude config 统一配置 |

**共同点**:几乎没有项目做严格的 skill/MCP 隔离。沟通方式分两类:共享状态 (task list/queue) 和文件交接 (handoff documents)。

## 核心矛盾

```
信息共享 ←→ 上下文隔离
  共享越多    隔离越强
  协作越好    各自 context 越干净
  但 context  但协作困难
  互相污染
```

研究 (reflection df9994ef174a) 指出:**context inconsistency 是多 agent 生产中失败的首要原因**——不是拓扑选择问题,而是 agent 间信息不同步导致各自做错误决策。

## 设计:共享黑板 + 角色信箱

### 目录结构

```
.agentflux/
  ├── models.json              ← 模型 + 角色定义 (docs/17, 18)
  ├── runtime/
  │   └── registry.json        ← 实例注册表 (docs/18)
  ├── shared/                  ← 共享层 (所有 agent 可读)
  │   ├── blackboard.json      ← 全局状态
  │   ├── tasks/               ← 任务队列
  │   │   ├── task-001.json
  │   │   └── task-002.json
  │   ├── handoffs/            ← 交接文档
  │   │   ├── planner-1→impl-frontend.md
  │   │   └── impl-frontend→reviewer-1.md
  │   └── decisions/           ← 决策记录
  │       └── decision-001.json
  └── events.jsonl             ← telemetry (docs/11)
```

### 黑板 (blackboard.json)

所有 agent 可读,只有写入者可写自己的 section:

```json
{
  "project": "AgentFlux",
  "currentMode": "M4",
  "sharedContext": {
    "goal": "实现 model-capability 路由",
    "constraints": ["纯TS", "零外部依赖"],
    "decidedArchitecture": "亲和度点积匹配"
  },
  "agentStatuses": {
    "planner-1": { "status": "done", "output": "handoffs/planner-1→impl-frontend.md" },
    "impl-frontend": { "status": "running", "workingOn": "task-001" },
    "reviewer-1": { "status": "blocked", "waitingFor": "impl-frontend" }
  }
}
```

**设计约束**:
- 黑板只存结构化状态,不存对话历史
- agent 启动时读黑板获取全局上下文,不读其他 agent 的完整对话
- 黑板更新是 append-only (决策记录) 或 section-write (状态更新),不是全局覆写

### 任务队列 (tasks/)

Leader (主 agent) 分配任务,worker (实例) 认领:

```json
{
  "id": "task-001",
  "title": "实现 src/core/model-capability.ts",
  "assignedTo": "impl-frontend",
  "status": "in_progress",
  "dependsOn": ["task-000"],
  "createdAt": "2026-06-26T12:05:00Z",
  "inputHandoff": "handoffs/planner-1→impl-frontend.md",
  "acceptanceCriteria": ["文件存在", "calcAffinity 函数返回正确值", "无 TypeScript 错误"]
}
```

### 交接文档 (handoffs/)

agent 间信息传递的载体。不是塞整个对话历史,而是写结构化的交接信息:

```markdown
# Handoff: planner-1 → impl-frontend

## Task
实现 model-capability 路由模块

## Context
- 设计文档: docs/17-model-capability.md
- 相关代码: src/core/pricing.ts (价格层, 可复用降级架构)
- 约束: 纯 TypeScript, 零外部依赖

## Plan
1. 创建 src/core/model-capability.ts
2. 实现 ModelCapability 类型 + capabilityHeuristic
3. 实现 calcAffinity(model, requirement) 点积
4. 实现 assignModel(role, models) 分配逻辑
5. 集成到 routing.ts

## Files to Read
- docs/17-model-capability.md (设计)
- src/core/pricing.ts (降级架构参考)
- src/core/types.ts (类型定义)

## Acceptance Criteria
- calcAffinity 返回 0-1 标准化分数
- 启发式能识别 GPT/Claude/DeepSeek/Gemini/Qwen 家族
- 只有一个模型时退化为同构分配
```

### 决策记录 (decisions/)

审计用,append-only:

```json
{
  "id": "decision-001",
  "by": "reviewer-1",
  "type": "review_verdict",
  "verdict": "approve_with_suggestions",
  "issues": [],
  "suggestions": ["建议在 calcAffinity 中加入 NaN 防护"],
  "timestamp": "2026-06-26T12:30:00Z"
}
```

## 沟通流程

### 串行管道 (planner → implementer → reviewer)

```
planner-1 完成
  → 写 handoffs/planner-1→impl-frontend.md
  → 更新 blackboard.agentStatuses.planner-1 = { status: "done", output: "..." }

impl-frontend 启动
  → 读 blackboard 获取全局上下文
  → 读 handoffs/planner-1→impl-frontend.md 获取任务细节
  → 执行任务 (写代码)
  → 写 handoffs/impl-frontend→reviewer-1.md
  → 更新 blackboard

reviewer-1 启动
  → 读 blackboard + 读 handoffs/impl-frontend→reviewer-1.md
  → 审查代码 (读 diff)
  → 写 decisions/decision-001.json
  → 更新 blackboard
  → 如果有 issues, 创建新 task 给 impl-frontend 修复
```

### 并行执行 (多个 implementer)

```
planner-1 完成
  → 写 handoffs/planner-1→impl-frontend.md
  → 写 handoffs/planner-1→impl-backend.md
  → 创建 task-001 (impl-frontend) 和 task-002 (impl-backend)
  → 更新 blackboard

impl-frontend 和 impl-backend 并行启动
  → 各读自己的 handoff
  → 各自执行 (独立 session, 独立 context)
  → 各写自己的 handoff → reviewer

reviewer-1 启动
  → 读两个 handoff
  → 统一审查
```

## 为什么用文件而不是 IPC

1. **pi 限制**:每个 agent 是独立 pi 进程,没有内建 IPC。文件是唯一自然共享方式
2. **可审计**:所有沟通留文件,用户可以检查决策链
3. **可恢复**:进程崩了,状态在文件里,重启能续上
4. **git 友好**:handoff/decision 文件可以 commit,天然版本控制
5. **上下文可控**:agent 只读它需要的文件,不是把整个对话历史塞过来

## Skill / MCP 管理

### MCP servers: 项目级共享

MCP 提供项目级能力 (搜索代码库、查数据库、调 API),对所有角色都有用。MCP server 是重进程 (启动慢、占资源),不应该每个 agent 跑一份。

```
项目级 MCP (所有 agent 共享):
  - filesystem-server    (所有角色都需要读文件)
  - git-server           (所有角色都需要查 git)
  - database-server      (如果有 DB 查询需求)
```

子进程启动时继承主 agent 的 MCP 配置,不需要额外处理。

### Tools: 角色级隔离

通过角色定义的 `tools` 字段限制子进程可用工具:

```
planner:     read, grep, find, ls, bash  (只读)
implementer: read, write, edit, bash, grep, find  (可写)
reviewer:    read, grep, bash  (只读)
tester:      read, write, edit, bash  (可写测试文件)
```

子进程启动时通过 pi 的 `--tools` 参数应用角色工具白名单；通信策略启用时，宿主会将 `flux_agent_message` 追加到该白名单，禁用时不追加。未配置 Skill 时使用 `--no-skills`，配置后按项传递 `--skill`。这属于进程级可用能力过滤，但 reviewer/planner 若仍获准 `bash`，仅靠 prompt 中的“只读”约束不等同于安全沙箱。

### Skills: 角色级过滤 + 共享继承

```json
{
  "sharedSkills": ["project-context", "git-workflow"],
  "roles": {
    "planner": { "skills": ["planning", "architecture-review"] },
    "implementer": { "skills": ["coding-patterns", "error-handling"] },
    "reviewer": { "skills": ["code-review", "security-checklist"] }
  }
}
```

`sharedSkills` 是所有角色都加载的基础 Skill，规范位置是 `.agentflux/models.json`；`roles[x].skills` 或 Agent Markdown frontmatter 的 `skills` 是角色特有配置。运行时合并、去重后，每项用一个 `--skill` 传给子进程；如果 `models.json` 未声明，兼容读取旧版 `.agentflux/agentflux.json.sharedSkills`。直接、并行、team 与 DAG 入口使用同一合并规则。

## Message/Delivery V2

V2 使用消息本体与逐接收者 Delivery 分离的文件协议，目录位于 `.agentflux/shared/messages-v2/`：

- direct、broadcast、group 都在发送时快照实际接收者，每个接收者独立维护 `pending → delivered → acknowledged/rejected/expired`。
- `dedupeKey` 提供发送者作用域的幂等发送；`correlationId`、`taskId`、`artifactId` 用于问题/回复和任务 provenance。
- 每个 Agent 有独立 cursor、优先级队列、pending 上限和消息大小/接收者数量限制。
- poll 只把消息标记为 `delivered`；一次性 subagent 成功完成后才 ack，失败时保留 delivered 状态并在 lease 到期后重投。
- `flux_message_v2` 提供给主协调 Agent；`flux_agent_message` 由精简子进程入口按角色策略注册。后者不接受 sender 参数，发送身份、实例 ID 和 run ID 由父进程注入。
- 角色模板可声明 actions/targets 白名单、单次消息上限、`requiredSendTo` 和显式 inbox ACK；注册实例可以持久收窄，直接 `flux_subagent` 调用还可以在其上做单次动态收窄。扩大动作、目标或 quota 会在 provider 调用前 fail-closed。
- required handoff 只接受当前 run correlation 的出站消息；显式 ACK 契约要求子 Agent 主动确认。任一条件缺失时 completion gate 以 exit 76 fail-closed，并记录 `message.protocol`/`subagent.run` 审计信息。

该协议和身份/契约层已做 offline 验证。Persistent/RPC runtime 已具备实验性的 inbox pump：空闲消息注入新 prompt，忙碌的 high/critical 或 `steer` 消息注入 steer，普通消息排入 follow-up；只有对应轮次成功返回 assistant 结果后才 ACK，失败或断线保留 Delivery 并等待 lease 重投。pi 的 queued follow-up 在同一 agent lifecycle 内 drain，pump 以当前轮和下一次 assistant 结果为 ACK 边界，不依赖第二个 `agent_start`。pump 默认关闭，由配置或受控启动器显式开启。

Runtime 注册采用 name（可路由身份）+ instanceId（具体进程身份）两层模型：heartbeat 续租、活跃租约拒绝同名接管、presence 更新按 instanceId fencing；crash 后新实例必须等待租约，到期后才可用同名接管并重投 delivered 消息。Desktop live smoke 已验证 normal follow-up、critical steer、idle prompt、abort cancelled、同名租约冲突和 crash 后 attempts=2 的恢复 ACK。

## 分层能力与隔离边界

tools、skills、MCP、通信与 workspace 使用统一的三层策略：角色模板是能力上限，注册实例覆盖持久化到 `.agentflux/runtime/capability-overrides/`，单次运行只能继续收窄。有效策略、provenance 与收窄字段写入 `.agentflux/runtime/capability-effective/`，Desktop 通过只读 IPC 消费；修改必须走带 expected revision 的 `flux_capability_policy set`。

有效 tool/skill 集合会直接成为子进程 CLI 参数；宿主 `tool_call` hook 同时检查工具白名单、workspace roots、denied paths、路径逃逸与危险 shell 模式。能力扩大在启动 provider 前以 exit 77 拒绝，策略解析和拒绝均写入 `capability.policy` 审计。该门禁不等于 OS 沙箱；当前 pi 也没有可验证的 MCP server 级 hook，因此非空 MCP 策略暂时 fail-closed。能力形状改变会产生 cache-impact 提示并改变持久 session 的能力 hash，避免权限撤销后命中旧 session。

这仍不等于所有一次性 subagent 都具备实时收件能力：普通 `flux_subagent` 子进程没有常驻 RPC 控制通道，运行期间仍需模型主动调用 `flux_agent_message poll`。实时自动收件只承诺给启用了 pump 且身份唯一的 Persistent/RPC runtime；跨进程断线恢复的完整 Desktop live smoke 在实现状态文档中单独跟踪。

## 生命周期与回收

子进程的运行时生命周期由 abort signal、超时和进程树终止负责；完成后的 registry、消息和 session 文件属于持久状态，不会占用主 Agent 的上下文，但无限增长会增加状态扫描、UI 展示和磁盘开销。

当前生产策略：

- `session_start` 按 `retention` 配置自动执行安全 GC；也可用 `/flux gc dry-run` 预览或 `/flux gc` 手动执行。
- 只处理带有效时间戳的终态 Agent；运行中存在子进程时正式 GC fail-closed。
- V1 已读点对点消息可归档；V1 未读、广播和群组消息保留。V2 只有在所有接收者的 Delivery 均为 `acknowledged/rejected/expired` 后，才按 `read_message_ttl_hours` 和 `max_read_messages` 归档 envelope 与逐成员 delivery；任何 pending/delivered Delivery 都会保留。
- 被活跃 Agent 引用的 session 永远保留；移除终态 Agent 后的 session 和超过 TTL 的孤儿 session 移入审计归档。
- 归档目录为 `.agentflux/archive/lifecycle/<run-id>/`，包含 manifest、V1/V2 消息和 session。Retention health 同时报告 V2 terminal/outstanding delivery 和活跃消息字节数。当前 GC 收缩活跃状态集，但归档本身的磁盘 TTL/总容量上限尚未实现。

## 主 agent 作为协调者

主 agent (用户的 pi 会话) 就是 leader。它通过 `flux_subagent` tool 或 `/flux team` 命令创建和管理 agent 实例:

```
用户 → 主 agent (pi TUI)
         │
         ├─ /flux team plan <task>    → 创建 planner 实例, 分配规划任务
         │                               planner 写 handoff → done
         ├─ /flux team build <task>   → 创建 impl 实例(s), 分配实现任务
         │                               impl 读 handoff, 写代码, 写 handoff → done
         ├─ /flux team review         → 创建 reviewer 实例, 分配审查任务
         │                               reviewer 读 handoff, 审查, 写 decision → done
         ├─ /flux team status         → 读 blackboard, 展示所有 agent 状态
         └─ /flux team abort <name>   → 终止指定实例
```

主 agent 不直接参与子 agent 的 LLM 对话——它只做调度:创建实例、分配任务、收集结果、做最终决策。

## 架构图

```
                ┌──────────────────┐
                │   主 agent (pi)   │  ← 用户交互, 调度, 最终决策
                │   AgentFlux ext   │
                └────────┬─────────┘
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │planner-1 │ │impl-fe   │ │reviewer-1│  ← 各自独立 pi 进程
     │gpt-5.5   │ │ds-flash  │ │gpt-5.5   │     独立 session/context
     └────┬─────┘ └────┬─────┘ └────┬─────┘
          │            │            │
          ▼            ▼            ▼
     ┌──────────────────────────────────────┐
     │     .agentflux/shared/               │  ← 共享层
     │  blackboard.json (全局状态)           │     文件-based, 可审计
     │  tasks/         (任务队列)            │     git-friendly
     │  handoffs/      (交接文档)            │
     │  decisions/     (决策记录)            │
     └──────────────────────────────────────┘
          │            │            │
          ▼            ▼            ▼
     ┌──────────────────────────────────────┐
     │     项目级共享资源                     │
     │  MCP servers (filesystem, git, ...)  │  ← 所有 agent 共享
     │  sharedSkills (project-context, ...) │
     └──────────────────────────────────────┘
          │            │            │
          ▼            ▼            ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │role skill│ │role skill│ │role skill│  ← 角色级隔离
     │planning  │ │coding-pat│ │code-rev  │
     │+tools    │ │+tools    │ │+tools    │
     └──────────┘ └──────────┘ └──────────┘
```

## 关键设计决策

1. **文件沟通,不做 IPC** — 简单、可审计、可恢复、git 友好
2. **能力默认最小化并逐层收窄** — tools/skills/通信/workspace 已有宿主门禁；MCP 在缺少 server 级 hook 时 fail-closed
3. **主 agent 是 leader** — 和用户日常工作流一致,不需要额外协调层
4. **实例化而非单例** — 同一角色可以多个实例并行工作
5. **handoff 文档是沟通载体** — 不是塞整个对话历史,而是写结构化的交接信息

## 与 A2A 协议的关系

Linux Foundation 的 A2A (Agent-to-Agent) 协议是跨 vendor 的 agent 通信标准。如果未来 AgentFlux 要和外部 agent (非 pi 的 agent) 协作,A2A 是对接路径。但**现阶段不需要**——AgentFlux 管理的都是 pi 子进程,文件共享足够了。A2A 是 Phase 3+ 的扩展点,架构上预留接口但不提前实现。

## 交叉引用

- 模型能力: [17](17-model-capability.md) — 角色-模型亲和度匹配
- 角色设计: [18](18-agent-roles.md) — 角色定义格式和实例化
- 模式定义: [03](03-modes.md) — M4/M5/M6 模式定义
- pi 集成: [10](10-pi-integration.md) — pi subagent/fork/handoff 能力映射
- 系统架构: [11](11-system-architecture.md) — 五层架构和 telemetry 事件
- 路由: [05](05-routing.md) — 模型策略维度 (D) 路由
- 配置: [04](04-config-schema.md) — 配置体系
