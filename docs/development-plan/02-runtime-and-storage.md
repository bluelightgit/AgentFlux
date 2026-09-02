# 当前规划：执行语义与数据可靠性

更新日期：2026-09-01。

本文件处理正式执行语义和持久化边界。任务按各自依赖推进，不再以“全部 P0 完成”作为统一前置条件。

## P1-01 Main 正式 Workflow 节点

- **状态**：待开发
- **目标**：Main 作为 planner 或其他正式节点时拥有节点级 Run、handoff、lease 和 settled 等待。
- **依赖**：P0-02；现有 `agent_settled` 生命周期。
- **验收**：后续依赖在 Main settled 前不启动；失败、取消、重试和恢复状态一致。
- **验证**：Main planner→后续节点真实 Workflow。

## P1-03 Task 与 invocation 谱系

- **状态**：部分完成
- **目标**：显式 task 优先、普通对话不产生无意义持久记录、invocation 成功/失败/取消后正确清理。
- **验收**：continue/reuse/resume/retry 创建新 Task/Execution 并保留父关系；历史不可修改；selector 规则一致。
- **验证**：Task Registry 回归和真实历史操作。

## P1-04 checkpoint 与 resume

- **状态**：部分完成
- **目标**：checkpoint 具备 schema、原子性、节点集合校验和连续成本。
- **验收**：损坏数据 fail-closed 且不覆盖证据；恢复只跳过已完成节点；成本不归零。
- **验证**：中断/损坏/并发测试；真实 Workflow resume。

## P1-05 数据和输出边界

- **状态**：待开发
- **目标**：tasks、runs、events、delivery、dedupe、控制文件、stdout、stderr 和 assistant 消息都有容量与保留策略。
- **验收**：长运行内存和磁盘有界；GC 不删除运行中/被引用对象；截断仍保留可追溯证据。
- **验证**：大输出、长时运行、GC、归档和并发写入 soak。

## P1-06 session Agent 隔离

- **状态**：部分完成
- **目标**：所有 session Agent 的 list/find/mutate/GC 都尊重 ownerSessionId。
- **验收**：跨会话不可见、不可运行、不可删除或回收；旧格式安全迁移。
- **验证**：多 session 确定性测试和真实会话清理。

## P1-07 并行写隔离

- **状态**：待开发
- **目标**：为写密集型并行 Run 提供可选的 Git worktree/独立 checkout 绑定；继续使用同一 Agent、Task、Execution、Run 和执行器，不创建平行身份或状态机。
- **依赖**：P0-02、P1-03；现有 workspace/lockFiles 能力。
- **验收**：Core 记录每个 Run 的 workspace 绑定、基线 commit、分支和 merge/apply 结果；同文件并行修改不会静默覆盖；取消、失败和清理只处理对应 Run 的 checkout；用户原工作树及既有未提交修改不被移动或清理；界面明确说明这是工作区隔离而非 OS sandbox。
- **验证**：同文件冲突、非冲突合并、脏工作树、取消/崩溃清理和 Windows 路径测试；production dist 两个写 Agent 的隔离与合并验证。

## 完成前置条件

P1 任务不得改变产品目标或架构事实源；若发现现有架构无法满足验收，先修订 [项目架构](../01-architecture.md) 和本规划，再实现。原 P1-02 busy Agent 队列已提升并合并到 P0-07，避免把基础 steer/queue UX 推迟到数据治理之后。
