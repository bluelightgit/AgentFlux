# 26 - 实现状态与测试事实

更新日期：2026-07-18。本文件是当前能力状态的事实源。

状态定义：`wired` 表示生产入口可达，`offline verified` 表示确定性回归通过，`live verified` 表示真实 provider 链路通过，`limited` 表示能力可用但边界必须显式说明。

## 本轮结论

旧 M1–M6、自动路由、experience/sidecar 和重复 Team/Pipeline executor 已从生产 Core 删除，不提供兼容 adapter。生产 API 与 TUI 只接受 Direct、Team、Workflow、Community。

| 能力 | 状态 | 当前契约与证据 |
|---|---|---|
| Direct | wired / offline + live verified | Main Agent 直接执行；DeepSeek V4 Pro smoke 通过。 |
| Team | wired / offline + live verified | Main Agent 可并行运行最多 5 个 Ephemeral/Persistent Agent 并整合；DeepSeek V4 Flash 调用真实 child Agent 通过。 |
| Workflow | wired / offline + live verified | planner 生成 DAG，校验依赖/环，独立节点并行，带文件锁、质量门、重试、预算和取消；DeepSeek V4 Pro planner + 角色 Agent 得到 `DAG Execution: PASSED`。 |
| Community | wired / offline + live verified / limited | Issue、comment、claim、submit、resolve 已接线；active claim 阻止关闭；DeepSeek V4 Pro 全动作 smoke 通过。Proposal/Review 独立实体和自治参与者循环后置。 |
| Ephemeral Agent | wired / offline + live verified | 单次任务结束即进入 done/failed/cancelled，不可再次调用；Team child smoke 通过。 |
| Persistent Agent | wired / offline verified | 模板注册、稳定身份/session、重复调用、idle 恢复、archive 与 GC 已接线。尚未做长期 cache 收益 soak。 |
| pi session fork | wired / offline verified / limited | `/flux fork` 使用 pi `ctx.fork` 创建真实单分支，并保留原生会话树。一次从 snapshot 并行派生 N 个独立进程尚未实现，不能用 fresh Agent 冒充 fork。 |
| Agent policy | wired / offline verified | 模板→注册实例→单次运行只能收窄；tools/skills/communication/workspace、revision、effective snapshot、telemetry 与 cache generation 26/26。MCP 非空 allowlist 因 pi 缺少门禁 hook 而 fail-closed。 |
| Agent 消息 | wired / offline verified / persistent RPC limited | Message V2 支持 direct/group、priority、dedupe、delivery/ACK、cursor、lease redelivery、expiry/backpressure；24/24。RPC inbox pump 15/15，但普通 Ephemeral Agent 不是常驻进程，只能在本次执行中主动使用消息工具。 |
| 缓存影响 | wired / offline verified | tool/skill/MCP/system/model/session generation 变化提示；成本倾向 `<=0.01` 时静默；动态消息后缀不误报 prefix miss。 |
| 回收 | wired / offline verified | `/flux gc [dry-run]`；运行中 task 阻止正式 GC；终态 Persistent/shared Agent、已读消息、完成的 V2 delivery 和孤儿 session 可归档。归档容量上限后置。 |
| 进程安全 | wired / offline verified | 超时、取消、provider 失败归一化、文件锁冲突、Windows 进程树终止与 active registry 清理 18/18。它是宿主门禁，不是 OS 沙箱。 |
| TUI | wired / offline verified | `/flux` 为完整分层 Workbench 菜单；Work、Agents、Issues、Fork、Runtime、Maintenance 的子操作均可继续选择。`/flux agent` 统一展示 Main、Persistent 和 SharedBoard execution Agents；Persistent 可续接 session，在线 Ephemeral/RPC 可发送 Message V2，终态 Ephemeral 只读。参数补全和旧 M 编号拒绝仍保留。 |

## 本轮测试

`npm run verify` 包含类型检查以及以下确定性测试：

- 工作方式与 Community 状态机：8/8。
- Agent lifecycle：6/6。
- Main Agent 自然任务调度协议与 telemetry：4/4。
- TUI Core：18/18。
- Lifecycle GC：4/4。
- Capability policy：26/26。
- Message V2 与 cache impact：24/24。
- Agent 子进程安全生命周期：18/18。
- DAG contracts：12/12。
- Persistent RPC inbox pump：15/15。

`npm run test:live` 在隔离 fixture 中依次验证。四个用户 prompt 只描述任务特征与目标，不包含 AgentFlux、工作方式名称、工具名或调用指令：

- `deepseek-v4-pro`：Direct 精确完成。
- `deepseek-v4-flash`：Main 调用 `flux_team`，真实 child 返回验收标记。
- `deepseek-v4-pro`：Main 调用 `flux_workflow`，DAG 通过。
- `deepseek-v4-pro`：Main 调用 `flux_issue` 完成创建、评论、认领、提交与关闭。

2026-07-18 最终组合结果：Direct 4.7s、Team 186.1s、Workflow 89.9s、Community 119.2s，全部 exit 0；Workflow 额外要求 `[DAG Execution: PASSED]`，Community 额外要求 `resolved`。每条链路使用独立 pi 进程、0.25 美元任务预算、240 秒 Core 墙钟和 300 秒测试进程硬超时；任何非零退出、超时或缺少工具/结果标记都会失败。持久证据写入 `.agentflux/test-results/core-deepseek-latest.json`，fixture 与测试进程均已清理。

## 明确限制与后置范围

- 不再提供 M1–M6 配置读取、映射或 deprecated telemetry。
- `default_work_style=agent_decides` 只允许 Main Agent在明确的四种工作方式中决定，不包含自动分类器。
- Community 当前是可操作的 MVP 状态机，不是后台常驻自治社区；Main Agent仍是 moderator。
- fork 当前是 pi 原生交互式单分支，不支持一次派生 N 个继承同一 snapshot 的并行运行时。
- Persistent Agent 的稳定 session 已实现，但缓存收益需真实长任务 soak 后才可量化。
- 预算在 provider 请求边界生效，单次请求可能造成小额越界。
- 自动路由、模型/拓扑成本优化、OS 沙箱、MCP server 级门禁与 archive 容量治理后置。
- Desktop 尚未迁移到本轮 Core contract；旧 Desktop 仅视为待重构代码，不代表当前产品入口。

## 下一发布门

1. 按 [29 - Desktop 工作台规划](29-desktop-workbench-plan.md) 先建立 Core/Desktop 共享 contract，再重构 UI。
2. 为 Persistent Agent 做多轮真实调用、cache generation 变化和长时间回收 soak。
3. 在 pi 提供可导出的 context snapshot/runtime API 后，实现真实并行 fork；此前保持限制说明。
4. 完善 Community proposal/review/decision 与 participant 主动循环，并加入预算和消息轮次门。
