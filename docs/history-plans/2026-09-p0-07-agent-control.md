# P0-07 Agent 运行控制、健康监控与聚合预算

状态：核心实现归档；2026-09-02 独立验收未通过，返工见当前 `docs/development-plan/03-real-validation.md`

## 目标摘要

接通 Agent 运行中的 inspect/steer/stop 与有界 busy 指令队列；将 Agent、planner、Workflow 节点和 judge 的固定 wall-clock 默认硬限制改为可选显式 deadline；实现 Core health 的 liveness/progress 分离、阶段化健康状态与限频提示；实现并行 Agent 的父 Task 聚合成本/轮次/并发预算；补齐确定性、production dist 和真实 Pi/provider 验证。

## 实现摘要

- `src/core/deadline.ts` 统一 `undefined/null` 无硬 deadline 与正数显式 deadline；Task/Execution/Run 保存可选绝对 deadline，Runner、DAG、planner 和 quality gate 只在显式 deadline 下启动 wall-clock watchdog，父 deadline 向下按剩余时间收窄。
- Run Registry 分离 heartbeat 与 semantic progress，保存 health、等待原因、重复动作、warning 计数和有界 recent events；health 提示只诊断，不自动终止健康子进程。
- `flux_agent inspect|steer|stop` 已接通；stop 使用按 runId 定向的持久 control request，steer 只进入 Message V2 pending queue；busy Agent 指令顺序、背压、停止拒绝和 RPC ACK/watchdog 均有契约覆盖。
- BudgetConfig/Task plan、Runner、DAG 和 `runAgentsParallel` 支持父 Task cost、turn/input token、active parallel 聚合限制；并发注册在 Run Registry 文件锁内原子检查，预算预检和运行中超限都 fail-closed 并保留终态事实。
- TUI/inspect 展示 phase、health、liveness/progress freshness、deadline、usage/cost、recent events 和错误；Workflow reuse/generated paths 统一传递配置的 maxParallel。
- 质量门对 indeterminate judge 结果保持失败关闭；显式 deadline 终止保留明确的 `explicit deadline` 错误，不把 stderr 尾部覆盖成普通成功/失败描述。

## 验证证据

- `D:/Nodejs/npm.cmd run verify`：typecheck 与完整 unit 链通过；最终 Agent lifecycle 98、TUI 49、DAG 31、RPC inbox 21、config 18、task execution 18、run health 7、active-context 21、FS lock 12 等套件通过。此前 Windows 并发 Community writer 偶发出现 `EPERM`，`src/core/json-store.ts` 增加了对短暂 lock/atomic-replace 错误的有界重试；修复后连续 3 次完整 `verify` 均通过。
- `D:/Nodejs/npm.cmd run build`：production dist 构建通过，`dist/extension/entry.js` 与 `dist/extension/subagent-entry.js` 存在；`git diff --check` 仅有 Windows LF/CRLF 转换警告。
- `AGENTFLUX_LIVE_BUILT=1 D:/Nodejs/npm.cmd run test:live:run-telemetry`：`.agentflux/test-results/run-telemetry-latest.json` `passed=true`，验证 production-dist 在线 usage/cost、heartbeat、health/tool phase、终态一致性和 unavailable model recovery。
- `AGENTFLUX_LIVE_BUILT=1 D:/Nodejs/npm.cmd run test:live:p0-07-controls`：`.agentflux/test-results/p0-07-controls-latest.json` `passed=true`，全新 production-dist Pi 完成 inspect → Message V2 steer → delivery ACK/目标响应 `STEER_SEEN`，随后对第二个无 deadline Run 执行定向 stop；第一 Run 为 completed，第二 Run 为 cancelled，均保留 stop/tool/recentEvents/health 事实。
- `AGENTFLUX_LIVE_BUILT=1 D:/Nodejs/npm.cmd run test:live:p0-07-fanout`：`.agentflux/test-results/p0-07-fanout-latest.json` `passed=true`，`maxActive=4`，四个 child 均成功完成并有非零 usage/cost，聚合 turns/input/cost 均在配置的父预算内，所有 Run 无 deadline 并保留 task/execution lineage；父预算耗尽/拒绝由 Agent lifecycle 确定性套件覆盖。
- `AGENTFLUX_LIVE_BUILT=1 D:/Nodejs/npm.cmd run test:live:p0-07-long`：`.agentflux/test-results/p0-07-long-latest.json` `passed=true`，Run 无 `deadlineAt`，实际 `runDurationMs=641630`（超过旧 600 秒），期间 `healthWarningCount=122`，未被告警误杀并最终 completed。
- `AGENTFLUX_LIVE_BUILT=1 AGENTFLUX_LIVE_PROFILE=local D:/Nodejs/npm.cmd run test:live:p0-07-workflow-deadline`：`.agentflux/test-results/p0-07-workflow-deadline-latest.json` `passed=true`，全新 production-dist Pi 真实完成 Main→planner→implementer→quality-gate；judge 返回明确 `status=passed` 和逐项 criteria，另一个全新 Pi 以显式 deadline 运行长 bash，Run 记录 timeout event、explicit deadline、`timed_out` 和 PID 清理。报告中的 provider/model/thinking 来自 profile 解析结果，而非测试代码常量。

## 独立验收结论

2026-09-02 首次独立验收确认三项未闭合契约：generated Workflow 会在 planner 后重置父 deadline；`stop_requested` Run 仍可接收 steer 且消息可能进入后续 Run；restart recovery 报告中的 orphan Run 已 failed，但父 Task 仍为 running。

提交 `9f41788` 的第二次独立验收确认 deadline 时间戳传播与 stop/steer Core fence 已修复；但 Workflow 子 Run 因父 deadline `timed_out` 时父 Task/Execution 仍误写 `failed`，且单个 stale child 可在同一执行仍有 active Run 时提前把父级写成不可变 failed。独立 restart production 复跑也因未稳定终止 Pi A 而保存 `passed=false`。

提交 `33773c0` 的第三次独立验收确认上述 timeout 映射、active sibling 防护、process-tree kill 证据和 post-stop steer 因果均已闭合，三个 fresh production-dist 场景也独立复跑通过；但 live Main/Workflow owner defer 路径在 claim recovery fence 后直接 return，遗留 fence 并拒绝同父执行的合法 replacement/retry child。

后续返工修复了 owner/active-context defer 的 fence 释放，并将 recovery fence 容量改为 fail-closed；确定性 Agent lifecycle 回归和 fresh production owner-fence 场景均证明 parent 状态安全、fence 清空且 replacement child 能完成。该历史阻断已关闭，后续更广的 Workflow/Community/Message V2 验证仍按当前规划推进。
