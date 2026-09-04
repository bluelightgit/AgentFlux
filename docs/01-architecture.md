# AgentFlux 项目架构

更新日期：2026-09-01。

## 总体结构

```text
pi Main session
  └─ src/entry.ts
       ├─ flux_task      → Task/Execution Registry
       ├─ flux_agent     → Agent child pi process
       ├─ flux_workflow  → planner → DAG nodes → quality gate
       ├─ flux_issue     → Issue/Claim state machine
       └─ flux_message   → Message V2

Core Registry / atomic JSON stores
  ├─ agents / sessions / capability snapshots
  ├─ tasks / executions / runs / telemetry
  ├─ workflows / checkpoints / artifacts
  ├─ issues / proposals / claims / reviews
  ├─ messages / deliveries / groups
  └─ active-context / locks / control files

pi TUI
  └─ 只呈现 Core 事实并发起命令
```

## 核心原则

1. **Core 是事实源**：Task、Agent、Workflow、Issue、Message、状态和权限都由 Core 返回；TUI 不自己推断。
2. **统一 Agent 身份**：一个 Agent 通过 `roles[]` 承担多个职责，每次 Run 选择一个 role；不为不同职责复制身份。
3. **历史不可变**：继续、复用、恢复和重试创建新的 Task/Execution/Run，并保存父谱系。
4. **稳定协议**：system prompt 和工具 schema 保持稳定；动态任务正文、ID、预算和名册不写入稳定 prompt。
5. **失败关闭**：未知 role、模型、能力、selector、checkpoint、权限或关键 verdict 必须拒绝，不把不确定状态当成功。
6. **预算向下聚合**：并行 Agent/Workflow 节点共享父 Task 的成本、轮次和并发上限；子 Run 可以继续收窄，但不能各自重新获得完整父预算。
7. **时限与健康分离**：模型执行的 wall-clock deadline 是可选的显式约束，不使用固定默认值推导失败；liveness、progress 和疑似停滞/循环属于可观察健康事实，不能自行改写运行终态。

## Agent 与会话

- 作用域：global、project、session；session Agent 按 ownerSessionId 隔离。
- 创建：默认、角色模板、真实 pi 会话 fork。
- 会话：`shared` 复用会话，`fresh` 使用新会话键，`fork` 使用 pi 原生真实分支。
- 模型解析：单次覆盖 → role/Agent 配置 → Main 当前 model/provider → capability affinity。
- 能力层级：角色模板上界 → 注册实例收窄 → 单次运行继续收窄。
- capability generation 包含 role、prompt、model、provider、thinking、tools、Skills 和 MCP，防止复用不兼容上下文。
- 写密集型并行 Run 可绑定独立 Git worktree/checkout；workspace 绑定、基线、分支和 merge/apply 结果属于 Core Run 事实，不能产生第二套 Agent 身份或执行器。

## 执行空间

- Main 直接执行或协调 Agent。
- Workflow 是固定 DAG 空间，节点支持依赖、并行、文件声明、质量门、重试、预算和 checkpoint。
- Community 是 Issue/Proposal/Claim/Submit/Review/Resolve 状态机。
- `active-context.json` 管理项目级空间互斥；空间内可并行。Main 作为正式 Workflow 节点时必须拥有节点级状态和 lease。

## 消息与运行事实

Message V2 是 Agent 间消息基础设施，提供 direct/group、独立 recipient delivery、priority、dedupe、ACK、reject、expire、lease redelivery 和 backpressure。对 busy Agent 的 steer/follow-up 也必须进入同一路径和有界 pending 队列；Rpc pump 只有成功的目标 assistant 响应才 ACK，失败、崩溃和 watchdog 超时保留 delivery 重投。

每个物理 Run 至少记录 `runId`、`taskId`、`executionId`、`sessionId`、Agent、role、status、phase、health、attempt、model/provider、turns/tokens/costUsd、PID、liveness heartbeat、最近语义进展、重复动作证据、有限 `recentEvents`、可选 deadline 和终态时间。运行中事实持续写入 Core，终态汇总不得是第一次出现 usage；最终收敛以 `agent_settled` 为准。

`status` 与 `health` 是两个维度：`status=running` 时可同时标记 healthy、waiting_provider、waiting_tool、quiet、suspected_stall、suspected_loop 或 context_pressure。健康状态只产生持久事实、限频提示和 inspect/steer/stop 入口；新进展必须能够清除告警。heartbeat 只能证明进程存活，不能冒充语义进展；循环判断必须保留规范化动作签名、重复次数和时间窗口，不得仅凭总耗时自动终止。

父 Task 未设置 deadline 时，Agent、planner、Workflow 节点和 judge 不得补造固定硬时限；父级显式 deadline 必须向下继承，子级只能进一步收窄。成本、轮次、并发上限、显式取消和真实进程/provider 失败仍可结束 Run。启动握手、锁等待、消息 lease、网络元数据读取和停止后的进程树清理等基础设施操作继续使用各自有界超时。

## 存储与安全

- JSON/JSONL 写入使用文件锁、临时文件、原子替换和损坏 fail-closed。
- Dead-PID orphan recovery 只有在同一 Task/Execution 没有 active sibling Run、且持久化的 Main/Workflow owner 已退出后，才可通过 Task Registry 同步 terminalize Run、TaskExecution、Task 和 Agent；Run Registry fence 只覆盖已确认需要父级收敛到 Task-store 写入完成的窗口，因 owner/active-context 存活而 defer 时必须释放，尚未收敛的 fence 不得因容量截断被静默淘汰。
- Run、Task、事件、delivery、dedupe、控制文件和子进程输出必须有容量/保留边界。
- workspace、lockFiles、Git worktree/独立 checkout 和 bash 门禁是 Host 策略，不是操作系统级沙箱。
- production 入口是 `dist/extension/entry.js`，子代理入口是 `dist/extension/subagent-entry.js`。

## 模块边界

- `src/entry.ts`：pi 生命周期、工具、命令和 Main 状态。
- `src/agents/`：Agent、角色、会话、运行和子进程。
- `src/workflows/`：DAG、planner、checkpoint 和质量门。
- `src/core/`：Task、Community、Message V2、权限、成本、锁和回收。
- `src/extension/`：TUI、补全、通知和 RPC pump。

任何新功能必须先说明属于哪个模块、使用哪个事实源、如何保持谱系和权限边界，再进入当前开发规划。
