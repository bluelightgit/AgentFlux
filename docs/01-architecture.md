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

## Agent 与会话

- 作用域：global、project、session；session Agent 按 ownerSessionId 隔离。
- 创建：默认、角色模板、真实 pi 会话 fork。
- 会话：`shared` 复用会话，`fresh` 使用新会话键，`fork` 使用 pi 原生真实分支。
- 模型解析：单次覆盖 → role/Agent 配置 → Main 当前 model/provider → capability affinity。
- 能力层级：角色模板上界 → 注册实例收窄 → 单次运行继续收窄。
- capability generation 包含 role、prompt、model、provider、thinking、tools、Skills 和 MCP，防止复用不兼容上下文。

## 执行空间

- Main 直接执行或协调 Agent。
- Workflow 是固定 DAG 空间，节点支持依赖、并行、文件声明、质量门、重试、预算和 checkpoint。
- Community 是 Issue/Proposal/Claim/Submit/Review/Resolve 状态机。
- `active-context.json` 管理项目级空间互斥；空间内可并行。Main 作为正式 Workflow 节点时必须拥有节点级状态和 lease。

## 消息与运行事实

Message V2 是 Agent 间消息基础设施，提供 direct/group、独立 recipient delivery、priority、dedupe、ACK、reject、expire、lease redelivery 和 backpressure。

每个物理 Run 至少记录 `runId`、`taskId`、`executionId`、`sessionId`、Agent、role、status、attempt、model/provider、costUsd、PID、heartbeat 和终态时间。最终收敛以 `agent_settled` 为准。

## 存储与安全

- JSON/JSONL 写入使用文件锁、临时文件、原子替换和损坏 fail-closed。
- Run、Task、事件、delivery、dedupe、控制文件和子进程输出必须有容量/保留边界。
- workspace、lockFiles 和 bash 门禁是 Host 策略，不是操作系统级沙箱。
- production 入口是 `dist/extension/entry.js`，子代理入口是 `dist/extension/subagent-entry.js`。

## 模块边界

- `src/entry.ts`：pi 生命周期、工具、命令和 Main 状态。
- `src/agents/`：Agent、角色、会话、运行和子进程。
- `src/workflows/`：DAG、planner、checkpoint 和质量门。
- `src/core/`：Task、Community、Message V2、权限、成本、锁和回收。
- `src/extension/`：TUI、补全、通知和 RPC pump。

任何新功能必须先说明属于哪个模块、使用哪个事实源、如何保持谱系和权限边界，再进入当前开发规划。
