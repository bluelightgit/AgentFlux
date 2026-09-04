# 当前规划：可用入口与安全边界

更新日期：2026-09-04。

本文件只保留尚未闭合的 P0 任务；P0-01/P0-04 已归档。P0-02 的核心实现与行为重验摘要保存在 `docs/history-plans/2026-09-p0-02-space-isolation.md`，第二次独立验收返工仍以本文件为当前依据。

## P0-02 项目空间互斥第二次独立验收返工

- **状态**：独立验收未通过（2026-09-04）。
- **已确认**：Main、Workflow、Community 共用项目级 active-context；实例按 leaseId/Claim ID 定向释放，跨空间 fail-closed、同空间允许并行。active-context 25、P0-02 28、Main routing 36、Community 41/22、完整 `verify`、独立 typecheck、production build 和 diff check 均通过。独立 Luna/max production-dist 复跑 570.155 秒，三阶段真实 `tool_execution_start` 均与存活 lease 同时观测并返回显式冲突，最终 active-context 为空。
- **阻断一**：`hasAssistantFinalMarker()` 对最终 assistant 文本仍使用 `includes`；独立反例“条件未满足，因此不会输出 P0_02_NEGATED_MARKER”被判 `true`，上一轮真实失败也使用过同类否定表述。marker 必须对 trim 后最终文本做精确相等匹配或使用等价结构化 receipt，并增加 final assistant 自身否定提及 marker 的反例。
- **阻断二**：passing 报告未保存 Task/Execution/Run/Issue、usage/cost、parent lineage；fixture 在 `finally` 删除 workspace 后无法恢复这些 Core 事实。必须在清理前保存有界快照并将一致性纳入 `passed`。
- **阻断三**：`compactResult` 的 5 KB `stdoutTail` 会截断 Codex 超长 JSONL；本次 11 个进程的 tail 均解析不到任何 assistant message，报告无法复核 marker。必须在截断前保存 `finalAssistantText`/精确匹配结果，并为完整输出提供 artifact 指针和报告级回归。
- **证据**：`.agentflux/test-results/p0-02-independent-second-audit-latest.json`；行为通过报告 `.agentflux/test-results/p0-02-space-isolation-latest.json` 不能单独构成结项证据。

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

P0-01/P0-04、P0-05、P0-07 已归档；P0-02 必须先闭合第二次独立验收返工，P0-06 group 单一路径和 P0-03 仍是独立入口与安全边界任务。stop 后消息不得污染后续 Run，必须与 P0-06 的 Message V2 单一路径保持同一事实源。P0-03 Community 契约必须在 Community 真实验证前完成。每项任务完成后必须同步证据，并按规划规则归档已完成内容。
