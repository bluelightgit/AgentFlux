# 当前规划：可用入口与安全边界

更新日期：2026-09-02。

本文件只保留尚未闭合的 P0 任务；P0-01/P0-04 已归档，核心闭环证据见 `docs/history-plans/2026-09-p0-01-p0-04-workflow-core.md`。

## P0-02 项目空间互斥

- **状态**：部分完成
- **目标**：Workflow、Main 派发和 Community Claim 使用统一 active-context、lease 和实例身份。
- **验收**：跨空间拒绝、同空间并行；成功、失败、取消、显式 deadline 超时和崩溃清理只释放自己的实例；并行 Claim 不互相误删。
- **验证**：并发/故障确定性测试；多进程真实冲突测试。

## P0-03 Community 工具契约

- **状态**：部分完成
- **目标**：review 缺 verdict 时拒绝，delete 真正物理删除，工具/CLI/TUI 使用同一状态机。
- **验收**：缺少或非法 verdict 不会通过；终态 Issue 不可误修改；删除结果和历史证据符合规范。
- **验证**：核心、工具、CLI、TUI 回归；真实 Issue 流程。

## P0-06 Message V2 单一路径

- **状态**：部分完成
- **目标**：生产 runner 只通过 Message V2 通信，并让 Main 看到未读消息。
- **验收**：direct/group、delivery、ACK、失败重投都来自同一消息路径；不重复消费、不错误标记已读；Main 有未读提示。
- **验证**：Message V2/RPC 测试；两个真实 Pi 进程的 delivery/ACK/redelivery。

## 完成前置条件

P0-01/P0-04、P0-05 的核心实现已归档；P0-07 父绝对 deadline、stop/steer 竞态和 orphan 父 Task/Execution 收敛已返工，并由当前提交的 production-dist controls/Workflow/deadline/restart 报告覆盖，仍需独立审计复核后归档。P0-06 group 单一路径、P0-02/P0-03 仍是独立入口与安全边界任务；其中 stop 后消息不得污染后续 Run 必须与 P0-06 的 Message V2 单一路径保持同一事实源。P0-03 Community 契约必须在 Community 真实验证前完成，但不阻塞与 Community 无关且依赖已满足的 P1 数据可靠性任务。每项任务完成后必须同步证据，并按规划规则归档已完成内容。
