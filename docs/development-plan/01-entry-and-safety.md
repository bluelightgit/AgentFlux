# 当前规划：可用入口与安全边界

更新日期：2026-09-04。

本文件只保留尚未闭合的 P0 任务；P0-01/P0-04/P0-02 已归档。P0-02 实现和重验摘要保存在 `docs/history-plans/2026-09-p0-02-space-isolation.md`。

## P0-02 项目空间互斥重验

- **状态**：重验通过（2026-09-04）。
- **实现**：Main、Workflow、Community 共用项目级 active-context；实例用 leaseId/Claim ID 定向释放，跨空间 fail-closed、同空间允许并行。fixture 的冲突 Pi 在真实 `tool_execution_start` 时核验目标 lease 仍活跃，marker 只解析最终 assistant message。
- **确定性证据**：active-context 25、P0-02 space isolation 28、Main routing 36、Community 41/22，完整 `verify`、typecheck、production build 和 diff check 通过；覆盖 prompt marker 假阳性反例及真实工具开始事件。
- **production-dist 证据**：`.agentflux/test-results/p0-02-space-isolation-latest.json` 为 clean current-HEAD 报告，`passed=true`、`builtExtension=true`、`changedFiles=[]`、sourceCommit 匹配 HEAD；Main、Community、Workflow 三阶段均通过，记录显式冲突 toolResult、lease/PID 和最终空 active-context。当前通过运行使用配置 `local` profile 的 openai-codex/gpt-5.6-luna、thinking=max；一次 environment profile 的 deepseek/off 运行因 provider 月度 429 失败，报告已保留且不覆盖通过证据。

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

P0-01/P0-04、P0-05、P0-07、P0-02 已归档；P0-06 group 单一路径和 P0-03 仍是独立入口与安全边界任务。stop 后消息不得污染后续 Run，必须与 P0-06 的 Message V2 单一路径保持同一事实源。P0-03 Community 契约必须在 Community 真实验证前完成。每项任务完成后必须同步证据，并按规划规则归档已完成内容。
