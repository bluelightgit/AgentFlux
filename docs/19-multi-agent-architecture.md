# 19 - 多 Agent 架构

> 共享黑板 + 角色信箱。文件沟通,不做 IPC。MCP 全局共享,tools/skills 角色隔离。

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

子进程启动时通过 pi 的工具过滤机制限制可用工具 (当前 pi 子进程通过 `--no-skills` 等参数控制,后续可扩展为精确工具白名单)。

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

`sharedSkills` 是所有角色都加载的基础 skill,`roles[x].skills` 是角色特有的。子进程启动时用 `--skills` 参数传入完整列表 (shared + role-specific)。

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
2. **MCP 全局共享,tools/skills 角色隔离** — 重资源共享,轻资源按需
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
