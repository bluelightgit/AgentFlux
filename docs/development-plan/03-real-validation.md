# 当前规划：真实链路与长期验证

更新日期：2026-09-01。

本文件只记录需要 production dist、全新 Pi/Provider 或长时运行才能完成的验证任务。

## P2-01 Production Workflow

- **状态**：待真实验证
- **范围**：动态角色、绑定 Agent、同一 Agent 多角色、`shared/fresh`、依赖/并行、质量门、重试、取消和 checkpoint resume。
- **验收**：全新 Pi 加载本轮 `dist/extension/entry.js` 与 `dist/extension/subagent-entry.js`；Task、Execution、Run、Workflow、成本和失败原因一致。

## P2-02 Community 与 Message V2

- **状态**：待真实验证
- **范围**：Issue → Claim → Submit → Review → Resolve，预算/轮次/停滞门禁，direct/group delivery、ACK、重投和 Main inbox。
- **验收**：状态转换、delivery 和失败原因均可从持久事实核对。

## P2-03 进程失败与恢复

- **状态**：待真实验证
- **范围**：provider failure、heartbeat 写入故障、stop/retry、超时、进程树清理、Pi 重启和孤儿回收。
- **验收**：健康进程不被基础设施写失败误杀；取消、失败和新 Run 谱系完整。

## P2-04 真实 Task continue/retry

- **状态**：部分完成
- **范围**：外部 dogfood 监督器和 live fixture 实际调用 `flux_task` continue/retry，而不是只写 operation 字段。
- **验收**：新 Task/Execution 的 parentTaskId/parentExecutionId 正确；请求 operation 与实际一致；历史不变。

## P2-05 长时运行与发布包

- **状态**：待真实验证
- **范围**：多轮会话、cache、成本累计、GC、registry 增长、Windows 进程树、无源码 npm 包和明确 PID 停止。
- **验收**：资源增长受边界约束；新 Pi 加载正确 dist；报告含 iteration、commit、模型、成本、PID、状态和失败原因。

## 真实验证统一要求

- 默认 `octopus-completions/deepseek-v4-flash`、`thinking=off`、短提示、受限轮数和输入 Token。
- 每轮保存 source commit、changed files、Task/Execution/parent lineage、build、PID、exit code、模型/provider、usage、成本、关键事件和失败原因。
- 只看最终自然语言不能结项，必须读取 Task、Execution、Agent、Run、delivery、Workflow/Issue 和 checkpoint。
- 验证失败保留报告，修复后重新运行；不得删除证据后宣称通过。
