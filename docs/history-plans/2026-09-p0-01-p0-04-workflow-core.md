# P0-01/P0-04 Workflow 核心闭环

状态：已完成（2026-09-02）

## 目标摘要

闭合 Workflow 的 Main 入口、真实 planner、DAG 节点和质量门链路；质量门保持严格三态，judge 不可判定时失败关闭；显式 deadline 只在配置后生效，无 deadline 不因固定 wall-clock 误杀。

## 实现摘要

- `flux_workflow action=run` 通过 Core Task/Execution 计划调用真实 planner，保存 Workflow 版本、DAG、节点 Run、checkpoint、artifact 和成本；TUI/命令继续读取同一事实源。
- planner、节点和 judge 的 timeout 统一使用可选 deadline；父级 deadline 向下收窄，健康告警只产生诊断事实。
- quality gate 的 `passed` 只能来自明确、结构合法且逐项满足的 judge verdict。judge 超时、进程错误、空响应、解析错误或冲突结果在重试一次后保持 `indeterminate` 并使节点失败关闭，不再把不确定改写成成功。
- Agent runner 在显式 deadline 终止时保留明确的 `explicit deadline` 错误，同时保留 timeout/recentEvents/PID 清理事实。

## 确定性验证

- `D:/Nodejs/npm.cmd run verify`：typecheck 与完整 unit 链通过；DAG 31 项、Agent lifecycle 98 项、quality-gate parser/judge contract 均通过。
- `D:/Nodejs/npm.cmd run typecheck`：通过。
- `D:/Nodejs/npm.cmd run build`：通过，生成 `dist/extension/entry.js` 与 `dist/extension/subagent-entry.js`。
- Windows 并发 Community writer 曾出现短暂 `EPERM`；`src/core/json-store.ts` 增加 lock acquire/release 与 atomic replace 的有界重试，修复后连续三次 `verify` 通过。

## production-dist 真实证据

`AGENTFLUX_LIVE_BUILT=1 AGENTFLUX_LIVE_PROFILE=local D:/Nodejs/npm.cmd run test:live:p0-07-workflow-deadline` 通过，报告：`.agentflux/test-results/p0-07-workflow-deadline-latest.json`；实际 provider/model/thinking 由 `tests/live/live-test-config.json` 解析并写入报告。

报告由全新 Pi 加载本轮 production dist 入口生成，并同时核对：

- `flux_workflow action=run` 的真实 Main → planner → DAG implementer → quality-gate → terminal 链路；planner Run 有非零 turns/cost，DAG 恰好一个 implementer，节点读取 README 后输出 `BUILT_WORKFLOW_NODE_OK`，judge 返回 `status=passed`、逐项 `criteriaResults` 和 gate model/cost，Task/Execution/checkpoint 均为 completed/passed。
- 独立全新 Pi 的显式 `max_wall_clock_seconds=45` 运行真实 60 秒 bash/node 命令；Run 记录绝对 `deadlineAt`、tool phase、timeout event、`explicit deadline` 错误、终态 `timed_out` 和清理后的 PID，告警保持 warning-only。

该报告使用配置 profile 解析出的真实 provider/model，并非 mock 或 invocation override；旧报告保留作历史证据，但当前 live 测试不再绑定特定 provider/model。

## 后续边界

P0-01/P0-04 的核心入口与质量门闭环已完成；动态角色绑定、真实 resume/continue/retry、资源容量、并行写隔离、Community 和 Message V2 group 单一路径仍按 `docs/development-plan/` 中的 P1/P2 任务推进，不作为本规划的完成依据。
