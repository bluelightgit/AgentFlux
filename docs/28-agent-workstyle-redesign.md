# 28 - Agent 生命周期与工作方式

更新日期：2026-07-18。此设计已在 Core/TUI 落地，不是兼容迁移草案。

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

## 四种工作方式

| 工作方式 | 谁决定工作图 | Agent 行为 | 适用场景 |
|---|---|---|---|
| Direct | 无工作图 | Main 独立完成 | 简单任务、探索、最低协调成本 |
| Team | Main 动态决定 | 按需创建/调用 Agent，可并行，Main 整合 | 范围会变化、需要研究/实现/review 配合 |
| Workflow | DAG 明确决定 | 按依赖执行节点、质量门与重试 | 稳定流水线、批处理、可审计流程 |
| Community | Issue 讨论与 Claim 逐步形成 | 参与者评论、认领、提交，Main 主持关闭 | 职责无法预先固定、需要讨论形成分工 |

Community 与 Team 的差异不在 Agent 数量：Team 的调度权集中于 Main；Community 的职责通过可见 Issue/Claim 协议形成。Community 也不是无约束群聊，执行必须有 claim，active claim 未收敛时不能 resolve。

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
