# AgentFlux 产品目标

更新日期：2026-09-01。

## 产品定位

AgentFlux 是基于 pi 的 Agent 调度扩展，提供 Core + pi TUI。用户只需描述目标，由 Main Agent 直接完成，或按任务需要派发 Agent、运行固定 Workflow、推进 Community 协作。

产品重点不是增加入口数量，而是让多 Agent 工作具备清晰的身份、独立上下文、角色职责、可控成本、可恢复执行和可审计结果。

## 用户得到什么

- **直接执行**：简单任务由 Main 快速完成。
- **Agent 协作**：复杂任务可派发独立 Agent，并按 role 选择规划、实现、审查或测试职责；运行中可观察、inspect、steer 和定向停止，成本受父 Task 聚合预算约束；没有显式 deadline 时不因固定总时长误杀仍在推进的 Agent。
- **Workflow**：依赖稳定的多步骤任务可保存为版本化 DAG，支持并行、质量门、重试和 checkpoint。
- **Community**：需要提案、认领、提交和评审的工作使用 Issue/Claim 流程。
- **消息协作**：Agent 通过 Message V2 传递 direct/group 消息并追踪 delivery、ACK 和重投。
- **历史与恢复**：Task、Execution、Run、成本、失败原因和谱系可查询，继续、复用、恢复和重试不会改写历史。

## 产品范围

### 当前范围

- Core：Agent、Task、Execution、Workflow、Community、Message V2、权限、成本、缓存影响、生命周期和持久化。
- TUI：Tasks、Workflows、Agents、Community、Messages、Fork、Spaces、Runtime 和 Maintenance。
- 真实 pi 子进程、模型/provider 继承、角色级能力收窄、在线进度/成本、运行 steer/取消/重试、写密集型 Run 的可选独立 checkout 和外部 dogfood 验证。

### 明确边界

- 没有独立的执行方式选择器；Main 根据目标决定直接执行或调用可选协作能力。
- 当前 Host 文件/进程门禁以及 Git worktree/独立 checkout 都不等于操作系统隔离；需要强隔离时使用外部受控运行环境。
- Workflow 和 Community 是可选执行方法，不替代 Main 的判断，也不创建第二套 Agent 身份系统。
- 运行时事实必须来自 Core Registry，TUI 不能依据零散事件推测状态。
- Agent、planner、Workflow 节点和 judge 的模型执行默认没有硬 wall-clock deadline；项目、父 Task 或单次 Run 可显式设置，成本、轮次、并发预算和用户取消仍然有效。

## 成功标准

1. 用户能从 Main 或 TUI 找到正确入口，且工具、命令和界面契约一致。
2. 每个运行在执行中和终态都能核对 Agent、role、model/provider、Task/Execution、Run、阶段、活动、成本、消息和失败原因。
3. 失败、取消、显式 deadline 超时、重试、恢复和空间冲突不会被错误显示为成功；长时间等待或疑似循环会提示但不会被误写为终态。
4. 权限、会话、文件锁、资源边界和历史谱系满足架构规范。
5. 关键能力经过确定性测试、production build 和必要的真实 Pi/Provider 链路验证。

## 开发依据

具体开发任务只看 [当前开发规划](development-plan/00-index.md)。架构约束只看 [项目架构](01-architecture.md)。已完成或被替代的规划只放在 [历史规划](history-plans/)。
