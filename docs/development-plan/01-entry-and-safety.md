# 当前规划：入口与安全边界

更新日期：2026-09-01。

本文件只保留尚未闭合的 P0 任务。

## P0-01 Workflow 入口

- **状态**：部分完成
- **目标**：补齐 `/flux workflow run`、TUI 新建和运行入口，确保显式 task 正确进入 planner。
- **验收**：工具、命令、TUI 的新建/运行/复用/修改/删除契约一致；Task、Execution、Workflow 版本和节点状态可核对。
- **验证**：命令/TUI 测试；production dist 新建并运行 Workflow。

## P0-02 项目空间互斥

- **状态**：部分完成
- **目标**：Workflow、Main 派发和 Community Claim 使用统一 active-context、lease 和实例身份。
- **验收**：跨空间拒绝、同空间并行；成功、失败、取消、超时和崩溃清理只释放自己的实例；并行 Claim 不互相误删。
- **验证**：并发/故障确定性测试；多进程真实冲突测试。

## P0-03 Community 工具契约

- **状态**：部分完成
- **目标**：review 缺 verdict 时拒绝，delete 真正物理删除，工具/CLI/TUI 使用同一状态机。
- **验收**：缺少或非法 verdict 不会通过；终态 Issue 不可误修改；删除结果和历史证据符合规范。
- **验证**：核心、工具、CLI、TUI 回归；真实 Issue 流程。

## P0-04 Workflow 质量门

- **状态**：部分完成
- **目标**：judge 不可用、超时或 indeterminate 时 fail-closed。
- **验收**：只有明确 pass 才释放后续节点；retry_judge、retry_node、失败原因和次数可追踪。
- **验证**：确定性 judge 异常测试；真实 Workflow 质量门。

## P0-05 Run Registry 与模型错误

- **状态**：部分完成
- **目标**：heartbeat 写入失败不误杀健康子进程；模型降级只响应明确的 provider/model 错误。
- **验收**：健康子进程仍能完成并写终态；普通业务/文件错误不触发模型降级。
- **验证**：模拟 Registry 写失败；错误分类和真实 provider 失败恢复。

## P0-06 Message V2 单一路径

- **状态**：部分完成
- **目标**：生产 runner 只通过 Message V2 通信，并让 Main 看到未读消息。
- **验收**：direct/group、delivery、ACK、失败重投都来自同一消息路径；不重复消费、不错误标记已读；Main 有未读提示。
- **验证**：Message V2/RPC 测试；两个真实 Pi 进程的 delivery/ACK/redelivery。

## 完成前置条件

P0 全部完成前，不进入 P1 的正式队列和长期数据治理任务。每项任务完成后必须在本文件填写完成证据，并按规划规则归档已完成的主题规划。
