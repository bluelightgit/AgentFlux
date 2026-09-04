# P0-02 项目空间互斥与实例 lease

状态：核心实现与真实行为重验通过；2026-09-04 第二次独立验收未通过，当前返工见开发规划

## 目标摘要

让 Workflow、Main persistent Agent 派发和 Community Claim 使用同一个项目级 `active-context.json` 事实源，并以具体 lease/进程实例作为生命周期边界：跨 `main`、`workflow`、`community` 空间的并发启动必须失败；同一空间的并发运行必须允许；成功、失败、取消、显式 deadline 超时和进程退出只能清理自己的实例。

## 实现摘要

- `ActiveContextEntry` 持久化唯一 `leaseId`；注册在文件锁内清理 dead-PID 并执行跨空间互斥，同空间追加实例；释放优先按 lease，name/scope 歧义时 fail-closed。
- `runAgentRecord` 在 `space: "main"` 时为 Main 派发持有独立 lease，`runWorkflow` 通过统一 wrapper 持有 workflow lease，并在 `finally` 定向释放。
- Community Claim 创建独立 `claimId`/lease 绑定；单 Claim review 通过只释放自身 lease，Issue resolve/delete 才按明确谓词清理该 Issue 的全部 Claim leases，兼容旧记录。
- 新增独立进程 helper、确定性空间隔离套件和 production-dist 多 Pi fixture；模型/provider/thinking 从 `tests/live/live-test-config.json` 解析，不在 fixture 中写死。

## 确定性验证

- `D:/Nodejs/npm.cmd exec tsx tests/test-active-context.ts`：25 项通过，覆盖跨空间拒绝、同空间并行、lease 歧义 fail-closed、精确释放、stale PID 和 Community Claim 生命周期。
- `D:/Nodejs/npm.cmd exec tsx tests/test-p0-02-space-isolation.ts`：28 项通过，覆盖 Main lease、独立进程原子注册/冲突/并行、正常完成、deadline/取消/业务失败与并行 sibling 不误删，以及真实子进程 crash、stale lease 过滤、replacement 注册和 marker/tool-start 解析反例。
- `D:/Nodejs/npm.cmd run verify`：通过；其中 Main routing 36、Agent lifecycle 107、Community 41/22、P0-02 space isolation 28 和其余 unit/typecheck 套件均通过。
- `D:/Nodejs/npm.cmd run build`：通过，生成 production `dist/extension/entry.js` 与 `dist/extension/subagent-entry.js`；`git diff --check` 通过。

## production-dist 实现阶段证据

运行：

```text
AGENTFLUX_LIVE_BUILT=1 D:/Nodejs/npm.cmd run test:live:p0-02-space-isolation
```

报告：`.agentflux/test-results/p0-02-space-isolation-latest.json`。

报告由多个全新 Pi 进程加载当前 production dist 生成，使用配置 profile 解析出的 provider/model/thinking，并从 active-context、toolResult、Task/Run、真实 tool_execution_start 和进程退出事实核对：

- Main 阶段观测两个 `main` lease 并行；一个无效模型覆盖的 Main 派发返回显式失败 toolResult 时，两个 sibling lease 仍存在且失败实例没有残留；Workflow 与 Community 真实工具调用均收到持久化 tool error 的跨空间拒绝。
- Community 阶段观测两个 Claim lease 并行；重复 scope 的失败 Claim 只清理自身临时 lease，两个 sibling Claim 仍存在；真实 Workflow 工具调用在两个 Community lease 存活时收到 `community` 空间拒绝；Pi 退出后 stale lease 被 PID 存活过滤清理。
- Workflow 阶段观测真实 Workflow lease；无效 selector 的失败 Workflow 释放自身 lease 而保留正常 Workflow lease；真实 Community Claim 工具调用在 Workflow lease 存活时收到 `workflow` 空间拒绝；正常 Workflow 节点完成并释放 lease。
- 最终 `active-context` 无活跃条目，所有 Pi 进程 exit code 为 0，报告 `passed=true`，并记录每个冲突/失败工具调用与结果、PID、lease、模型配置和失败原因。

实现阶段报告 `p0-02-space-isolation-pre-independent-audit.json` 和后续失败报告均作为历史证据保留；失败尝试未被删除，其中一次 environment profile 的 deepseek/off 运行因 provider 月度额度返回 429。

## 重验与第二次独立验收结论

2026-09-04 修复 fixture 后，在 clean current HEAD 上重新 build，并以 `openai-codex/gpt-5.6-luna`、`thinking=max` 启动多个全新 production Pi。Main/Community sibling 分别保持 120/180 秒，Workflow 保持 180 秒；三阶段冲突均在真实 `tool_execution_start` 时核验目标 lease 仍活跃，显式 toolResult、进程退出和空 active-context 均一致。实现方报告与随后独立复跑都在 clean HEAD `293d1b9` 上返回 `passed=true`；独立运行耗时 570.155 秒。

第二次独立验收仍判 `rework`：最终 assistant marker 只做 substring 匹配，否定句会假阳性；passing 报告没有保存 Task/Execution/Run/Issue、usage/cost 和父谱系；11 个 5 KB stdout tail 均因超长 JSONL 截断而解析不到 assistant 终态。Core 行为通过不替代可审计结项证据。当前要求和结论只看 `docs/development-plan/01-entry-and-safety.md`、`03-real-validation.md` 与 `.agentflux/test-results/p0-02-independent-second-audit-latest.json`。

此前独立审计、实现方 passing 报告和所有带时间戳失败报告均保留用于追溯。P0-03 Community fail-closed 工具契约、P0-06 Message V2 group 单一路径、Workflow/Community 更广真实流程、资源容量和 P1-07 并行写隔离仍按当前开发规划推进。
