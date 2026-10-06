# P0-02 项目空间互斥与实例 lease

最新状态：Main 失败 sibling 覆盖返工已在指定生产快照取得独立 PASS（2026-09-08 整合）。旧第四次验收仍保持原 rework，以下历史不改写；后续构建、账务与其他未完成验证见当前规划。

## 目标摘要

让 Workflow、Main persistent Agent 派发和 Community Claim 使用同一个项目级 `active-context.json` 事实源，并以具体 lease/进程实例作为生命周期边界：跨 `main`、`workflow`、`community` 空间的并发启动必须失败；同一空间的并发运行必须允许；成功、失败、取消、显式 deadline 超时和进程退出只能清理自己的实例。

## 实现摘要

- `ActiveContextEntry` 持久化唯一 `leaseId`；注册在文件锁内清理 dead-PID 并执行跨空间互斥，同空间追加实例；释放优先按 lease，name/scope 歧义时 fail-closed。
- `runAgentRecord` 在 `space: "main"` 时为 Main 派发持有独立 lease，`runWorkflow` 通过统一 wrapper 持有 workflow lease，并在 `finally` 定向释放。
- Community Claim 创建独立 `claimId`/lease 绑定；单 Claim review 通过只释放自身 lease，Issue resolve/delete 才按明确谓词清理该 Issue 的全部 Claim leases，兼容旧记录。
- 新增独立进程 helper、确定性空间隔离套件和 production-dist 多 Pi fixture；模型/provider/thinking 从 `tests/live/live-test-config.json` 解析，不在 fixture 中写死。

## 确定性验证

- `D:/Nodejs/npm.cmd exec tsx tests/test-active-context.ts`：25 项通过，覆盖跨空间拒绝、同空间并行、lease 歧义 fail-closed、精确释放、stale PID 和 Community Claim 生命周期。
- `D:/Nodejs/npm.cmd exec tsx tests/test-p0-02-space-isolation.ts`：37 项通过，覆盖 Main lease、独立进程原子注册/冲突/并行、正常完成、deadline/取消/业务失败与并行 sibling 不误删，以及真实子进程 crash、stale lease 过滤、replacement 注册、精确 marker、终态 artifact、Core 快照反例和普通冲突终态分类。
- `D:/Nodejs/npm.cmd run verify`：通过；其中 Main routing 36、Agent lifecycle 107、Community 41/22、P0-02 space isolation 37、DAG contracts 36 和其余 unit/typecheck 套件均通过。
- `D:/Nodejs/npm.cmd run build`：通过，生成 production `dist/extension/entry.js` 与 `dist/extension/subagent-entry.js`；`git diff --check` 通过。

## production-dist 实现阶段证据

运行：

```text
AGENTFLUX_LIVE_BUILT=1 D:/Nodejs/npm.cmd run test:live:p0-02-space-isolation
```

报告：`.agentflux/test-results/p0-02-space-isolation-latest.json`。

报告由 11 个全新 Pi 进程加载当前 production dist 生成，使用配置 profile 解析出的 provider/model/thinking，并从 active-context、toolResult、Task/Execution/Agent/Run/Issue、真实 tool_execution_start 和进程退出事实核对：

- Main 阶段观测两个 `main` lease 并行；冲突 Main 的 Workflow/Community 调用均收到持久化跨空间拒绝，两个 sibling lease 保持；待 holders 结束后，独立缺失 Issue 的 Main 失败场景产生真实 `failed/failure` Task/Execution，未设置 deadline。
- Community 阶段观测两个 Claim lease 并行；重复 scope 的失败 Claim 只清理自身临时 lease，两个 sibling Claim 仍存在；真实 Workflow 工具调用在两个 Community lease 存活时收到 `community` 空间拒绝；Pi 退出后 stale lease 被 PID 存活过滤清理。
- Workflow 阶段观测真实 Workflow lease；无效 selector 的失败 Workflow 释放自身 lease 而保留正常 Workflow lease；真实 Community Claim 工具调用在 Workflow lease 存活时收到 `workflow` 空间拒绝；正常 Workflow 节点完成并释放 lease。
- 最终 `active-context` 无活跃条目，所有 Pi 进程 exit code 为 0，报告 `passed=true`，并记录每个冲突/失败工具调用与结果、PID、lease、模型配置和失败原因。
- 报告在 workspace cleanup 前保存有界 Core 快照：11 个 Task/Execution、2 个 Agent、3 个 Run、3 个 Issue、1 个 Workflow，包含状态、usage/cost、Task/Execution/Run 父谱系和一致性检查；执行 usage 成本为非零，`costUsdTotal` 与观察值一致，所有 Task/Execution/Run 均终态且无 active Run。
- 每个进程保存完整 stdout/stderr artifact、SHA-256、最终 assistant 文本和结构化 tool events；11/11 assistant 终态可解析且 marker 均为 trim 后精确相等，artifact、Core 快照和 cleanup 结果均通过独立一致性检查。workspace 已删除但 artifact 与报告仍保留可复核终态证据。

实现阶段报告、独立验收失败报告和本次重验前的失败尝试均作为历史证据保留；其中一次 environment profile 的 deepseek/off 运行因 provider 月度额度返回 429。实现阶段报告使用配置驱动的 local profile（`openai-codex/gpt-5.6-luna`、`thinking=max`）；其通过声明不替代后续独立验收。

## 实现方重验结论

2026-09-05 在 clean HEAD 上重新 build，并以 `local` profile 解析出的 `openai-codex/gpt-5.6-luna`、`thinking=max` 启动 11 个全新 production Pi。Main/Community sibling 分别保持 120/180 秒，Workflow 保持 180 秒；三阶段冲突均在真实 `tool_execution_start` 时核验目标 lease 仍活跃，显式 toolResult、进程退出和空 active-context 均一致，普通冲突与真实失败均记录为 `failed/failure`，运行耗时与完整配置见当前报告。

本轮修复并验证了四项独立验收阻断：最终 marker 使用 trim 后精确相等而非 substring；cleanup 前保存包含 Task/Execution/Agent/Run/Issue/Workflow、usage/cost、失败原因和父谱系的 Core 快照；完整输出保存为带哈希 artifact，并在报告中保留可解析的最终 assistant 与结构化事件证据；普通冲突不再受错误正文中的 `setTimeout`/`deadline` 关键词污染。报告 `p0-02-space-isolation-latest.json` 记录 `passed=true`、`builtExtension=true`、验证时 `sourceCommit=HEAD`、`changedFiles=[]`、`outputEvidenceConsistency.passed=true`、`coreFactConsistency.passed=true`、`cleanup.workspaceRemoved=true` 和 `finalActiveEntries=[]`。

## 第三次独立验收与终态分类返工

2026-09-05 在 clean HEAD `ea0451a` 上独立复跑标准门禁和 562.625 秒 Luna/max production-dist，确认上轮三个证据阻断均已关闭：11 个 marker 精确相等、33 个 artifact 哈希/大小正确、Core 快照与谱系可复核，三阶段空间行为和清理通过。

第三次验收发现 `main-conflict` 明确因空间冲突被拒且无 deadline，却因 holder 任务文本中的 `setTimeout`/`deadline` 被写成 `timed_out/timeout`；fixture 原先只检查终态集合。当前返工已改为 typed `WorkflowDeadlineExceededError`、runner 的显式 `timedOut` 运行事实和逐场景 Task/Execution 终态契约，并加入自然 exit 124 的 failure 对照；确定性与本轮 clean production fresh 重验均已通过。

## 第四次独立验收（2026-09-07）

clean 候选 `35f4edb060970d5c2ef9105147ac61c962399556` 的定向测试、完整 verify、typecheck/build/diff 和独立 fresh production 均通过。空间场景耗时 571.291 秒，补充 Workflow/deadline 286.035 秒；environment profile 显式选择 Luna/max（judge 内部仍固定 off）。11 个精确 marker、artifact 哈希、进程/session/Task/Execution 关联、普通冲突 failure、真实 deadline timeout、最终空 context 和退出 PID 均已核对，前次终态分类及断言阻断关闭。

结论仍为 **rework**：fixture 将原来 live Main siblings 期间的 `flux_agent` 无效模型失败换成 holders 全部结束后的缺失 Issue 错误，失败后 sibling 断言从至少两个改成零。现有 production pass 没有覆盖原 Main lease failure/finally 边界；未复现 Core sibling 误删，不能把覆盖缺失表述为运行缺陷。当前返工要求仅维护在开发规划。

当前独立报告为 `.agentflux/test-results/p0-02-independent-fourth-audit-latest.json`；完整核对见 `p0-02-fourth-audit-report-check.json`，覆盖差异见 `p0-02-fourth-audit-coverage-diff.patch`。上一轮 provider usage limit、无退出回执的未完成尝试及原 workspace 均保留。成本通道仍存在历史不一致，观察合计不等于权威计费；两个 active Claim 也不等于 review/resolve 验收。

此前独立审计、实现方 passing 报告和所有带时间戳失败报告均保留用于追溯。当时 P0-02 下游依赖未满足；最新返工结论如下。

## Main failure sibling 返工独立接受（2026-09-08 整合）

恢复真实 `flux_agent run` 无效模型失败：两个 holders 等 supervisor release 文件；在工具开始和失败后逐一核对原 leaseId/PID，并保留单独的 missing-Issue 场景。没有用等待 siblings 退出或其他工具错误替代该边界。

独立 Luna/max reviewer 对 `function-closure/live-1788795202094-5680` 给出 PASS：重算 36/36 artifact SHA、核对 12/12 精确 marker/退出、12 Task/12 Execution/3 Agent/3 Run/3 Issue/1 Workflow 与零 active context，且 fixture/receipt/当时 dist 哈希一致。真实 invalid-model 父 Task/Execution 为 failed/failure；失败前后 PID 31268、32684 及其原 lease 均保留。

独立原文、Run 及来源 hash 保存于 `.agentflux/test-results/function-closure/p002-current-independent-verdict.json`。该结果解除原 Main 失败覆盖缺口，不回写 `.agentflux/test-results/p0-02-independent-fourth-audit-latest.json`，也不外推到账单、全部孙进程或之后名称/计价构建。Community submit/review/resolve 的补充 smoke 证据独立保存，不把本空间夹具尚 executing 的 Claim 当作已 review/resolve。
