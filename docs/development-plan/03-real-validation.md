# 当前规划：真实链路与长期验证

更新日期：2026-09-04。

本文件只记录需要 production dist、全新 Pi/Provider 或长时运行才能完成的验证任务。P2 不是实现完成后的末尾阶段：除 P2-05 长时 soak 外，各场景在对应 P0/P1 实现具备条件后立即执行，真实失败直接阻止该任务结项。

## P0-02 项目空间互斥第二次独立验收返工

- **状态**：独立验收未通过（2026-09-04）；Core 行为与 production 冲突同步通过，判定和持久证据仍不满足结项要求。
- **行为证据**：clean HEAD `293d1b9` 上完整 `verify`、独立 typecheck/build、dist/diff 门禁通过。独立全新 production Pi 使用 `openai-codex/gpt-5.6-luna`、`thinking=max` 运行 570.155 秒，Main、Community、Workflow 三阶段均通过；4 个冲突工具开始事件均在目标 lease 存活时捕获，显式 toolResult 拒绝、失败 sibling 保留、11 个进程正常退出和最终空 active-context 均成立。默认 deepseek 先前明确返回月度额度 429，故本轮使用可用模型完成多步工具链验证。
- **判定缺陷**：`hasAssistantFinalMarker()` 仍用 substring 匹配；final assistant 的否定句只要含 marker 就会通过。必须改为 trim 后精确相等或结构化 receipt，并覆盖 final assistant 自身否定提及 marker 的反例。
- **持久证据缺陷**：当前 passing 报告没有 `tasks`、`executions`、`runs`、`issues`、`usage`、`costUsd`、`parentTaskId` 或 `parentExecutionId`；workspace 清理后不可恢复，和本文件统一要求冲突。必须在 cleanup 前保存并断言 Core Registry、谱系、模型、usage/cost 与失败原因。
- **截断缺陷**：`compactResult` 只保存最后 5 KB，Codex 加密 reasoning 使每个 JSONL 事件可能超过 5 KB；本轮 11 个 stdout tail 的结构化 assistant 消息解析数全部为 0。必须从完整输出预提取 final assistant/精确 marker 结果，并保留完整输出 artifact 指针；报告级测试要证明保存后的终态证据可复核。
- **当前报告**：`.agentflux/test-results/p0-02-space-isolation-latest.json` 是行为通过证据，`.agentflux/test-results/p0-02-independent-second-audit-latest.json` 是结论 `rework` 的当前审计依据；此前实现方 passing 报告保存为 `p0-02-space-isolation-pre-second-independent-audit.json`。

## P2-01 Production Workflow

- **状态**：部分完成（P0-01/P0-04 核心链路已验证）
- **范围**：动态角色、绑定 Agent、同一 Agent 多角色、`shared/fresh`、依赖/并行、planner 在线阶段/健康、显式 deadline、质量门、重试、取消和 checkpoint resume。
- **已验证**：`.agentflux/test-results/p0-07-workflow-deadline-latest.json` 覆盖本轮 dist 的 Main→真实 planner→DAG implementer→真实 quality gate→Task/Execution/checkpoint terminal，以及独立 Pi 的显式 deadline timeout；P0-07 controls/fan-out/long reports 另覆盖 control、parallel 和 no-deadline 长运行。
- **剩余**：P0-07 已完成第四次独立验收并归档；并行写隔离和 Community/Message V2 真实流程仍按 P2-02/P2-05 独立推进。
- **验收**：全新 Pi 加载本轮 `dist/extension/entry.js` 与 `dist/extension/subagent-entry.js`；运行中可读到 planner/节点的非零进度、成本、liveness/progress 与 health；无显式 deadline 不会被固定时长终止，显式 deadline 精确收敛；Task、Execution、Run、Workflow、成本和失败原因一致。

## P2-02 Community 与 Message V2

- **状态**：待真实验证
- **范围**：Issue → Claim → Submit → Review → Resolve，预算/轮次/停滞门禁，direct/group delivery、ACK、重投和 Main inbox。
- **验收**：状态转换、delivery 和失败原因均可从持久事实核对。

## P2-03 进程失败与恢复

- **状态**：部分完成（P0-05/P0-07 核心链路已验证）
- **范围**：在已归档的 P0-05 在线遥测与显式 model failure 恢复基线上，继续验证真实 provider overload、无进展和疑似循环提示、部分成功、stop/steer/retry、显式 deadline、进程树清理、Pi 重启和孤儿回收。2026-09-02 的 production-dist telemetry/recovery 已覆盖非零在线 usage/cost、health/tool phase、heartbeat、终态一致性和 unavailable model recovery；P0-07 的双 Pi 控制、四 Agent fan-out、超过旧 600 秒的无 deadline 长时，以及 `p0-07-workflow-deadline-latest.json` 的显式 deadline timeout 已分别由对应报告覆盖。
- **剩余**：P0-07 已归档，真实 provider overload/retry、dead-owner restart 收敛、active-parent 保护和 owner-fence replacement/retry 场景均已覆盖；更广的资源容量、进程树和并行写隔离仍按 P1/P2 规划推进。
- **验收**：真实 overload、长等待、取消和恢复期间持续看到 liveness、progress、health、成本与具体 provider 错误；告警不误写终态，部分结果、新 Run 谱系和进程终止证据完整。

## P2-04 真实 Task continue/retry

- **状态**：已验证
- **范围**：外部 dogfood 监督器和 live fixture 实际调用 `flux_task` continue/retry，而不是只写 operation 字段。
- **验收**：新 Task/Execution 的 parentTaskId/parentExecutionId 正确；请求 operation 与实际一致；历史不变。

## P2-05 长时运行与发布包

- **状态**：部分完成（P0-07 长时、fan-out、显式 deadline、package 和三轮 soak 已覆盖）
- **范围**：多轮会话、超过旧 600 秒限制的无 deadline Run、并行 fan-out 聚合预算、健康告警、cache、在线/终态成本一致性、GC、registry 增长、Windows 进程树、并行写隔离、无源码 npm 包和明确 PID 停止。当前证据见 `.agentflux/test-results/p0-07-long-latest.json`、`p0-07-fanout-latest.json`、`p0-07-workflow-deadline-latest.json`、`p0-07-package-boundary-latest.json` 和 `p0-07-soak-latest.json`；本项仍需 P1-07 并行写隔离及更广资源容量验收。
- **验收**：至少一个全新 production Pi Run 在无显式 deadline 下持续超过旧 600 秒并正常完成，期间 waiting/stall/context 等 health 只提示不终止；另以显式短 deadline 验证 `timed_out`；父 Task 聚合预算可强制停止新模型调用且保留部分结果；资源增长受边界约束；新 Pi 加载正确 dist；报告含 iteration、commit、模型、thinking、成本、PID、status/health、关键进展和失败原因。

## 真实验证统一要求

- 每个 P0/P1 任务在自身结项前执行对应场景；不得用“之后统一做 P2”代替当轮 production 证据。
- 默认使用 `tests/live/live-test-config.json` 的 `local` profile（当前 Pi 的 `PI_PROVIDER`/`PI_MODEL`/`PI_THINKING`，无环境值时使用配置文件的 local fallback）；短提示、受限轮数和输入 Token。真实验证报告必须记录实际 provider/model/thinking，测试代码不得绑定具体模型名称。
- 每轮保存 source commit、changed files、Task/Execution/parent lineage、build、PID、exit code、模型/provider、usage、成本、关键事件和失败原因。
- 只看最终自然语言不能结项，必须读取 Task、Execution、Agent、Run、delivery、Workflow/Issue 和 checkpoint。
- 验证失败保留报告，修复后重新运行；不得删除证据后宣称通过。
