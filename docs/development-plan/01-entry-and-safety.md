# 当前规划：可用入口与安全边界

更新日期：2026-09-04。

本文件只保留尚未闭合的 P0 任务；P0-01/P0-04 已归档。P0-02 的核心实现摘要保存在 `docs/history-plans/2026-09-p0-02-space-isolation.md`，但独立验收返工仍以本文件为当前依据。

## P0-02 项目空间互斥独立验收返工

- **状态**：独立验收未通过（2026-09-04）。
- **已通过**：active-context 25、P0-02 space isolation 25、Main routing 36、Community 41/22，完整 `verify`、独立 typecheck 和 production build 均通过；未复现 Core 跨空间 fail-open 或 sibling 误删。
- **阻断**：production fixture 只让 Workflow 节点保持 15 秒，冲突 Pi 仅在启动时观测 lease，没有保证真正 `flux_issue claim` 时 lease 仍存活；默认 `deepseek-v4-flash/off` 复跑中 claim 在 Workflow 结束后成功，`workflowPhase.passed=false`。此外 `marker()` 搜索整段 JSONL stdout，会命中回显的用户提示，即使最终 assistant 明确未输出 marker 也返回 true。
- **验收**：冲突工具调用与 live Workflow lease 建立因果同步并适配 provider 延迟；marker 只读取最终 assistant 响应并有提示含 marker/最终不含 marker 的反例回归；修复后重新 build，由全新 production Pi 使用默认低成本配置复跑并保存 Task/Execution/Run/Issue、PID、lease、toolResult 和最终无活跃条目证据。
- **证据**：`.agentflux/test-results/p0-02-independent-audit-latest.json` 与 `p0-02-space-isolation-failed-1788522468872-13308.json`。

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

P0-01/P0-04、P0-05、P0-07 已归档；P0-02 必须先闭合独立 production 验收返工，P0-06 group 单一路径和 P0-03 仍是独立入口与安全边界任务。stop 后消息不得污染后续 Run，必须与 P0-06 的 Message V2 单一路径保持同一事实源。P0-03 Community 契约必须在 Community 真实验证前完成；依赖 P0-02 的 P1 任务仍受阻。每项任务完成后必须同步证据，并按规划规则归档已完成内容。
