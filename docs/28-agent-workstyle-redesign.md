# 28 - Agent 生命周期与工作方式

更新日期：2026-07-23。本文同时区分目标模型与当前实现事实，不是兼容迁移草案。

## 领域模型

```ts
type AgentKind = "main" | "ephemeral" | "persistent";
type AgentOrigin = "fresh" | "template" | "fork";
type WorkStyle = "direct" | "team" | "workflow" | "community";
```

- **Main** 是用户主要对话、调度和最终验收入口。
- **Ephemeral** 只执行一个有界任务，完成后进入终态，不保留可再次调用的身份。
- **Persistent** 从完整角色模板注册，保留身份、session、统计与 capability generation，强调稳定 cache prefix。
- **fresh/template/fork** 描述创建来源，不是工作方式。fork 必须是真实继承上下文；当前仅使用 pi 原生 session fork，不用重新拼 prompt 模拟。

权限属于 Agent policy：模板定义上界，注册实例可持久收窄，单次运行可继续收窄。任何下层都不能扩权。模型异构只是每个 Agent/Workflow node 的配置，不构成独立模式。

## 递进的工作方式

四个名称不是四套互不相关的平级产品，也不是四份彼此替代的 Agent 实现。它们描述 Main Agent 在同一个任务运行时上使用的协作拓扑：

```text
Direct：Main Agent 基础执行
└── Team：Direct + 动态 Agent 调用
    ├── Workflow：Team + 固定 DAG、依赖、验收门和 checkpoint
    └── Community：Team + Issue/Claim、讨论和任务驱动协作
```

Workflow 与 Community 平级。前者在执行前明确工作图，后者允许工作图随着 Issue、讨论和 Claim 形成。`agent_decides` 只是把选择权交给 Main Agent，不是独立工作方式，也不代表另一个自动路由服务。

| 工作方式 | 谁决定工作图 | Agent 行为 | 适用场景 |
|---|---|---|---|
| Direct | 无工作图 | Main 独立完成 | 简单任务、探索、最低协调成本 |
| Team | Main 动态决定 | 按需创建/调用 Agent，可并行，Main 整合 | 范围会变化、需要研究/实现/review 配合 |
| Workflow | DAG 明确决定 | 按依赖执行节点、质量门与重试 | 稳定流水线、批处理、可审计流程 |
| Community | Issue 讨论与 Claim 逐步形成 | 参与者评论、认领、提交，Main 主持关闭 | 职责无法预先固定、需要讨论形成分工 |

Community 与 Team 的差异不在 Agent 数量：Team 的调度权集中于 Main；Community 的职责通过可见 Issue/Claim 协议形成。Community 也不是无约束群聊，执行必须有 claim，active claim 未收敛时不能 resolve。

目标能力矩阵如下。高级工作方式使用低层能力时，仍归属于当前顶层 task，并记录成子操作，不能静默改写顶层工作方式。

| 选择的工作方式 | Main 直接执行 | Agent/Team | 固定 DAG | Issue/Claim |
|---|---:|---:|---:|---:|
| Direct | 是 | 否 | 否 | 否 |
| Team | 是 | 是 | 否 | 否 |
| Workflow | 是 | 是 | 是 | 否 |
| Community | 是 | 是 | 否 | 是 |

截至 2026-07-23，此矩阵已由 `core/workstyle-policy.ts` 统一实现，并接入 `flux_agent`、`flux_team`、`flux_workflow`、`flux_issue`、`flux_message` 和 `flux_task` 的切换检查。只读 list/show/inspect 不激活协作能力；创建、执行、通信和状态写入会 fail-closed。TUI 的显式 Agent/Issue 管理命令属于用户控制面，不受模型 task 门禁误伤。

## 选择、切换与自动判断

- 工作方式的作用域是 task。新 task 可以选择不同工作方式；已运行 task 不在中途切换。
- TUI `/flux work` 创建一个固定工作方式的新 task。`reuse/resume/continue` 继承来源 task 的工作方式并建立父子关系。
- PiDeck 的选择器是下一条空闲时发送任务的偏好。运行中的 steer/follow-up 不携带新的工作方式，继续现有 task；空闲后发送会创建新 task，需要继承历史语义时显式使用 reuse/resume/continue。
- `agent_decides` 时只注入稳定通用协议。Main Agent依据任务自行决定是否调用调度工具：不调用则在 settled 时记为 Direct；首次调用 Team、Workflow 或 Community 能力时建立对应执行计划。
- 自动选择目前是 LLM 基于语义和工具说明做出的决定，没有隐藏分类器、成本路由器或 fallback 模式。它已经通过四种自然任务 smoke，但在统一硬门禁完成前，工具误选仍可能造成越界。

## System prompt 与缓存

固定工作方式使用：

```text
Pi 基础 system prompt
+ AgentFlux 稳定通用协议
+ 当前工作方式的常量指令
```

`agent_decides` 只使用前两部分。taskId、任务正文、预算和 Desktop 信封不进入 system prompt；信封在 `input` hook 被剥离。由此得到以下缓存边界：

1. 相同模型、工具、Skills 和工作方式下，不同 task 的稳定前缀保持一致。
2. 工作方式切换只改变末尾常量指令，因此共享前缀仍稳定，但不能宣称整个 system prompt 跨工作方式相同。
3. 切回旧工作方式是否复用对应缓存，由 provider 的缓存键和保留时间决定。
4. Main 的六个 AgentFlux 工具始终注册，切换不会改变工具 schema。统一能力门禁在执行入口判断，不按模式动态注册/注销工具。
5. Persistent Agent 的缓存收益主要来自稳定子会话、角色 prompt、tools/skills/model；顶层工作方式切换不应修改其已注册模板。实际权限收窄会提升 capability generation，并按现有成本阈值提示缓存影响。
6. 递进协议文本发生版本升级时，升级后首个请求可能无法复用旧版本完整前缀；版本内保持稳定。

## 上下文、缓存与回收

- Ephemeral 的任务内容处于动态后缀；不为了跨任务 cache 命中限制短任务能力，进程结束后只留下结果、usage、lineage 和 telemetry。
- Persistent 固定 system/tool/skill/model prefix。cache-breaking 变化产生新 generation 并提示；成本倾向接近 0 时提示静默。
- fork snapshot 之前是只读共享历史，之后各分支独立；父子只通过显式结果、消息或 artifact 汇合。
- GC 只回收终态或协议明确完成的数据；运行中的 task 会阻止正式回收。

## 代码边界

```text
agents/agent-runner.ts      一次 Agent 运行与并行 Team
agents/persistent-agent.ts Persistent registry/session
agents/session-fork.ts     pi 原生会话 fork
agents/templates.ts        角色模板
workflows/dag-executor.ts  固定 DAG
workflows/workflow-registry.ts Workflow 定义与版本
core/community.ts          Issue/Claim 状态机
core/message-bus.ts        Message V2
core/lifecycle-gc.ts       生命周期回收
entry.ts                   pi tools、事件和 TUI 适配
```

生产代码不再包含旧 mode manifest、模式 fallback、自动任务分类器、experience router 或 Python sidecar。历史文档保留用于解释设计来源，但不得被 UI 或新代码消费。

## 未过度实现的边界

- 不自行序列化 pi 内部上下文来伪造并行 fork；等待稳定 snapshot/runtime API 或在 Desktop runtime 层实现可验证的进程派生。
- 不建立抽象 Executor/AgentFactory 类层级；当前函数模块已经覆盖实际复用点，等第二种实现出现再抽象。
- 不让 Community 后台无限自治；先完成显式操作、预算与状态可观察性。
- 不为已删除的 M 编号保留 adapter、配置迁移和双写 telemetry。
- 不为了隐藏不可用工具而按 task 动态重建 Main 工具表；用小型明确的能力矩阵做运行时拒绝。

## 2026-07-30 运行事实与持久化补充

Task 与 Execution 不再是同一个可变对象：Task 表示用户可见的谱系节点，Execution 表示一次不可变尝试。Reuse、Resume、Continue、Retry 必须创建新 Task/Execution，并分别记录 `parentTaskId` 与 `parentExecutionId`。Workflow Resume 读取父 execution checkpoint，但只向子 execution 目录写入。

`runtime/runs.json` 是子进程运行状态的权威来源。Lifecycle telemetry 只用于审计和时间线，不再决定 Stop/Retry/can*。Run Registry 记录 `starting → running → stop_requested → terminal`、PID、心跳、成本和 task/execution provenance；过期心跳由 Host/GC 收敛为失败。

PiDeck 已在 2026-07-30 接入这组事实：当前会话的任务列表来自 Task Registry 分页，选中任务的 Execution/Run/消息/Workflow 数据来自精确 detail；Participants 与管理按钮依据 Run Registry 和 Persistent record 映射。这里的“依据 Core capability”目前表示以 Host Registry 事实为输入做确定性映射，并不表示 Host 已直接返回一组统一 `can*` 布尔字段。

Desktop 的 Continue、Reuse、Retry 与 Workflow Resume 复用现有 Pi 主会话，通过确定性 `/flux task` 命令进入 Core；用户时间线只显示可读操作文本。每次写操作都创建新的 Task/Execution 并记录父 task/execution，Open 只改变 Inspector 选择，不修改历史。

Team 的 `max_cost_per_task` 是父任务总上限，不是每个 child 各自拥有的上限。并行 child 按成员数分配预算；混合 Persistent/Ephemeral Team 同样共享该上限。Provider 请求边界仍可能产生单次小额越界。

持久化状态采用短事务锁、同目录临时文件、fsync、原子替换和前一版本备份。解析或 schema 损坏必须 fail-closed，不能用空对象覆盖证据。Message V2 的 envelope 仍是提交标记，但 delivery/envelope/dedupe 与 GC 共享消息总线互斥边界。
