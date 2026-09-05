# 当前规划：可用入口与安全边界

更新日期：2026-09-05。

本文件只保留尚未闭合的 P0 任务；P0-01/P0-04/P0-05/P0-07 已归档。P0-02 的实现与前序验证摘要保存在 `docs/history-plans/2026-09-p0-02-space-isolation.md`，第三次独立验收返工以本文件为当前依据。

## P0-02 空间冲突终态分类返工

- **状态**：实现与确定性返工已通过，待以本轮 production dist fresh Pi 重验（2026-09-05）。上轮 marker 否定句、Core 快照缺失、截断输出不可复核三个阻断均已关闭。
- **已验证**：active-context 25、P0-02 space isolation 37、DAG contracts 36、完整 `verify`、独立 typecheck/build 与 diff 检查通过；确定性对照覆盖普通文本、`setTimeout`、`deadline` 持有者和自然 exit 124。
- **实现**：`src/entry.ts` 只接受 typed `WorkflowDeadlineExceededError`；Agent runner 以仅由显式 deadline watchdog/绝对时限产生的 `result.timedOut` 作为可信运行事实，DAG、quality gate、Telemetry 和 Task/Execution 终态均消费该事实；任意任务、持有者或 provider 错误正文关键词不再改变分类。
- **验收要求**：普通文本、`setTimeout`、`deadline` 持有者任务的空间冲突全部为 `failed/failure` 且 sibling lease 保留；自然 exit 124 无 deadline 仍为 failure；真实 deadline 正例为 `timed_out/timeout`。production fixture 按进程/marker 关联 Task/Execution，逐场景断言 status/outcome/deadline，并保留结构化错误与运行事实；fresh production 重验通过后再独立验收。
- **证据**：此前独立审计与失败报告仍保留；本轮 fresh report 待生成。

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

P0-01/P0-04/P0-05/P0-07 已归档；P0-02 第三次独立验收返工闭合前，其下游依赖不得视为满足；P0-06 group 单一路径和 P0-03 仍是独立入口与安全边界任务。stop 后消息不得污染后续 Run，必须与 P0-06 的 Message V2 单一路径保持同一事实源。P0-03 Community 契约必须在 Community 真实验证前完成。每项任务完成后必须同步证据，并按规划规则归档已完成内容。
