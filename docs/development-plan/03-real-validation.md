# 当前规划：真实链路与长期验证

更新日期：2026-09-05。

本文件只记录需要 production dist、全新 Pi/Provider 或长时运行才能完成的验证任务。P2 不是实现完成后的末尾阶段：除 P2-05 长时 soak 外，各场景在对应 P0/P1 实现具备条件后立即执行，真实失败直接阻止该任务结项。

## P0-02 第三次独立验收返工

- **状态**：实现、确定性返工和本轮 clean production-dist fresh Pi 重验已通过，待独立复核；返工实现与验收要求见 `01-entry-and-safety.md`。
- **已通过证据**：当前工作树上的 `npm run verify`、typecheck、production build、diff check；P0-02 space isolation 37、DAG contracts 36。确定性对照证明未设置 deadline 的普通冲突（包括 holder 文本中的 `setTimeout`/`deadline`）为 `failed/failure`，自然 exit 124 也不因退出码单独成为 timeout。
- **实现边界**：显式 deadline watchdog 才产生 `timedOut` 运行事实；typed `WorkflowDeadlineExceededError` 和 `QualityGateResult.timedOut` 用于 Workflow/DAG/quality-gate 映射，任意错误正文不再参与 timeout 判断。
- **已完成门禁**：`AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-02-space-isolation` 已用本轮 dist fresh Pi 通过；报告逐场景核对 Task/Execution status、outcome 和 deadline，保存 sourceCommit/changedFiles、Core/输出证据、artifact 与失败报告。
- **当前证据**：`.agentflux/test-results/p0-02-space-isolation-latest.json` 的 `passed=true`、`builtExtension=true`、`changedFiles=[]`，11 个 Task/Execution、3 个 Run、2 个 Agent、3 个 Issue、1 个 Workflow 均可核对；普通无 deadline 冲突为 `failed/failure`，输出/Core 一致性和 cleanup 通过，观察成本 `$0.01224412`、耗时 588.723 秒。`.agentflux/test-results/p0-02-independent-third-audit-latest.json` 等历史报告保留用于追溯。

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
