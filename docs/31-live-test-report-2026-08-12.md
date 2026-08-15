# 31 - 2026-08-12 真实链路测试报告（重启 pi 后首轮）

更新日期：2026-08-12。本文件记录重启 pi 后对 AgentFlux 各功能的首轮真实链路测试：测试环境、逐项结果、实测数据、发现的问题与解决方案。状态定义沿用 docs/26：`live verified` = 真实 provider 链路通过；`limited` = 能力可用但边界必须显式说明。

## 测试环境

- pi 全新启动（重启后首个会话），Provider `octopus-completions`，模型 **`oa/deepseek-v4-flash`**，思考等级 **xhigh（max 档）**，会话模型与测试模型一致。
- Workflow 角色临时配置：`.agentflux/models.json` roles 四项全部改为 `oa/deepseek-v4-flash + xhigh`（原配置 oa/glm-5.2 备份为 `models.json.bak-before-workflow-test`，测试后需还原）。
- 任务均为短小真实任务，未修改任何被测代码。

## 逐项结果

| 测试 | 工作方式 | 结果 | 实测数据 |
|---|---|---|---|
| T1 Direct | direct | ✅ live verified | 任务注册 workStyle=direct / selectedBy=main_agent；跨任务门禁 fail-closed 正确（direct 任务内调用 Team 被拒） |
| T2 Team | team | ✅ live verified | 2 并行 implementer：wall 12.1s / sum 23.8s / **speedup 1.97x** / turns 3 / in ~3.1-3.3K / cache hit 66% / **$0.0009**；结果与本地复核一致（23 个 test-*.ts） |
| T3 Community | community | ⚠️ live verified + **bug 实锤** | create→comment→claim→submit→resolve 全链路通过，Task↔Issue 关联正确；但 resolved 终态无保护（见问题 1） |
| T4 Workflow | workflow | ⚠️ 部分通过 + **bug 实锤** | planner 生成 3 节点 DAG（t1/t2 并行→t3 依赖）；t1 执行+质量门通过；t2 任务本体成功但质量门 judge 超时判失败（见问题 2）；t3 级联失败；总 $0.011178 / wall 100.9s；checkpoint/artifact 持久化完整 |
| T5 Persistent | team | ✅ live verified | 创建 stat-agent（implementer 模板，model=deepseek-v4-flash，provider octopus-anthropic）；两次运行均成功（in 267→231 递减，同一 sessionId `persistent-stat-agent`，callCount 2，总 $0.00029，status 回 idle）——会话延续生效 |
| T5 Message V2 | team | ✅ live verified | send（envelope+delivery pending，携带 taskId）→ poll（pending→delivered, attempts 1）→ ack（acknowledged，三时间戳齐全）完整状态机 |

## 问题清单与解决方案

### 问题 1（高）Community resolved 终态无保护 — docs/30 已列修复项，本轮实锤

**证据**：issue resolved 后仍可 `comment`（comments 1→2 无拒绝）；再次 `claim` 成功创建新 claim 并把 issue 状态从 `resolved` 倒退为 `executing`。需手动 submit+resolve 恢复现场。

**解决方案**（docs/30 第 2 项）：
- `claimIssue` / `submitClaim` / `commentOnIssue` 对 `resolved`（及未来 `cancelled`）终态直接拒绝，返回明确错误。
- 回归测试：resolved 后 claim / submit / comment 均抛错；状态保持 resolved；历史 claim 与评论只读。

### 问题 2（高）质量门 judge 超时把成功节点拖死 — docs/30 小项，本轮实锤

**证据**：t2 节点 artifact 完整产出（cache 40 处/36 行），但 `gateResult: {status: "indeterminate", feedback: "Quality gate judge timed out", gateModel: "deepseek-v4-flash", gateCost: $0.000138}`；节点重试 2 次（iterationCount=3）仍超时，最终判节点失败、t3 级联失败。根因：`checkQualityGate` 未传 timeoutMs（默认 30s），且 judge 使用节点同模型（xhigh 思考档下单次判断 > 30s）。

**解决方案**：
1. 质量门增加独立 judge 配置（模型/思考档/超时可配），默认使用轻量模型 + 低思考档；节点模型不兼任 judge。
2. `indeterminate`（judge 超时/解析失败）与真实失败（criteria 不满足）区分语义：
   - judge 超时 → 不触发节点重试（当前重试无意义地重复执行实现+judge，成本翻倍）；可重试 judge 本身或降级放行并记录告警。
   - 仅 criteria 明确不满足才判 gate 失败。
3. `executeNodeWithGate` 显式传入 timeoutMs（与 nodeDeadline 关联）。

## 产品侧观察（供开发方向参考）

1. **Task 级工作方式固定语义的交互代价**：一个任务 = 一个工作方式 = 一轮对话。连续测试不同功能需要逐轮切换任务，TUI/PiDeck 若不能在一个会话内预览多任务，用户切换成本偏高（产品层面可考虑"任务清单/队列"视图）。
2. **速度与成本**：flash + xhigh 下 Team 3 轮任务 $0.0009、12s 完成，链路质量高；成本监控与 cache hit 展示正常。
3. **失败原因透明度**：本轮 DAG FAILED 的直接原因是基础设施（gate 超时）而非任务本体失败，但用户只看到"t2 失败"。失败原因需要穿透展示（区分"任务失败/判定超时/依赖级联"）。

## 测试产物

- T2 子代理输出：tests 23 个 test-*.ts；docs 含 roadmap/status 文档 4 份。
- T3 issue：`issue-49461c72-c137-4bcd-a1bb-91669d14056b`（resolved，2 claims / 2 comments），结果文件 `.agentflux/runtime/issue-stats-result.txt`。
- T4 execution：`.agentflux/runtime/runs/task-09ef3712-b0bf-420f-9e6b-6277e8d26e9e/`（dag.json / checkpoint.json / artifacts/t1.md、t2.md），保存的 workflow 定义 `workflow-7282437b`（3 节点）。

## 后续

- T5 已测：Persistent Agent（stat-agent：创建/两次运行/会话延续/callCount/成本累积/idle 恢复）+ Message V2（send/poll/ack）均通过，证据见上表与 `.agentflux/runtime/agents.json`、`.agentflux/shared/messages-v2/`。
- `.agentflux/models.json` roles 已还原（planner/reviewer/tester=oa/glm-5.2，implementer=oa/deepseek-v4-flash）。
- 依据本报告安排开发：问题 1（Community 终态保护）、问题 2（质量门超时）优先，均有实锤证据与回归测试方案。

## 2026-08-12 晚间复测（扩展加载源修复后）

**环境根因修复**：pi 实际加载 ~/.pi/agent/npm/node_modules/agentflux（8-10 旧快照）而非项目 dist；settings.json packages 改为 local 路径 E:/agent-projects/AgentFlux 后重启生效（print 模式验证 AgentFlux ready）。

**T6 Community 终态保护复测 ✅**：issue-4d3ed65b 走完 create→claim→submit→resolve 后，claim 与 comment 均被拒（'Issue is already resolved and immutable: <id>'），与首轮（claim 打回 executing）形成对照。

**T7 Workflow 质量门复测 ✅**：roles 临时全改 oa/deepseek-v4-flash+xhigh（备份 models.json.bak-gate-retest，测后已还原），reuse docs-cache-analysis（workflow-7282437b）。结果：DAG PASSED，wall 397.4s，/usr/bin/bash.1007；t1/t2/t3 全部完成，gate 均 passed（gateModel deepseek-v4-flash，t3 为 deepseek-v4-pro），retryCount 0，iterationCount 5。对照 T4：同环境修复前 judge 30s 超时→重试 2 次→DAG failed；修复后 timeoutMs 按节点剩余时间（15-90s）放宽，正常路径不再误杀。'judge 超时→重试 judge→降级放行'分支由确定性测试（test-dag-contracts judgeAction 3 例）覆盖。

**遗留观察**：task-7b1f6ec8（纯工具轮次复测任务）被标记 failed，原因待查（疑似完成判定/重启中断），列入后续排查。

## T8：Community 评审闭环与 Issue Room 时间线（2026-08-13 凌晨，阶段 3a 实链复测）

环境：pi 重启后加载最新 dist（本地路径），模型 oa/deepseek-v4-flash。工具级全生命周期 + print 模式命令链路，无子代理 spawn，成本可忽略。

| 步骤 | 结果 | 证据 |
|---|---|---|
| create → claim → submit | ✅ | issue-d2d059a2：open → executing → reviewing，next 每步正确推导（claim scope → submit claim → review claim） |
| 收敛校验：submitted 未评审时 resolve | ✅ | `Issue has active or submitted claims` 拒绝 |
| review pass | ✅ | claim → reviewed，next 变 resolve issue |
| resolve | ✅ | status=resolved |
| 时间线 | ✅ | 5 事件完整：created → claimed → submitted → reviewed（含反馈"验证通过"）→ resolved |
| rework 退回 | ✅ | issue-9a6c3d81：submit → review rework（反馈"缺少测试用例，请补充"）→ 状态回 executing、claim 回 active、next 回 submit |
| 第二轮闭环 | ✅ | 再 submit → review pass → resolve；时间线 7 事件含 reworked |
| 终态保护 | ✅ | resolved 后 review 拒绝：`Issue is already resolved and immutable` |
| /flux issue review 命令链路 | ✅ | print 模式 `pi -p` 下对 resolved issue 正确报 immutable（同时证明最新 dist 生效） |

结论：阶段 3a（reviewClaim 评审闭环、resolve 收敛校验、Issue Room 时间线、next-actions 确定性推导）真实链路全部通过。遗留：阶段 3b（Proposal/Decision 实体、运行时待办注入、停止条件 gates、多 Agent 循环）待设计。

## T9：Persistent Agent soak 首轮（2026-08-13，第四阶段）

环境：pi 重启后加载最新 dist；oa/deepseek-v4-flash（AgentFlux models.json 无 oa/ 键，实际路由 deepseek-v4-flash octopus-anthropic，thinking 继承 implementer=off）。

| 验证点 | 结果 | 证据 |
|---|---|---|
| create_persistent | ✅ | soak-worker（role=implementer）创建成功 |
| run×2 session 连续性 | ✅ | 第 1 次 in 136 / hit 95% / $0.0001；第 2 次 in 100 / hit 97% / $0.0001，回答正确接续上轮主题（"接着上一个回答"） |
| 会话文件延续 | ✅ | 同一文件 `..._persistent-soak-worker-cap-92dba8d87c8a.jsonl`（7 行，两次运行历史在同一 session） |
| list 累计 | ✅ | soak-worker calls=2 cost=$0.000160；stat-agent 保留原记录 |
| archive → 拒绝运行 | ✅ | archive-test archive 后 run_persistent 报 `Persistent Agent not found` |
| GC 混合保护 | ✅ | `/flux gc dry-run`：persistent=0，protected-sessions=2（stat-agent + soak-worker 的活跃会话受保护） |
| 重启恢复路径 | ✅ **实链验证通过（pi 重启后）** | 重启后第三次 run：正确回忆起前两个历史问题（"列出 3 个 Python 常用数据结构"/"再列出 2 个并说明元组列表区别"）；in 128 / hit 96% / $0.0001；同一会话文件（7→9 行追加）；calls=3 cost=$0.000253 正确累计。agents.json 持久化 sessionId + capabilityGeneration 运行时派生 cap 后缀，policy 不变则命中同一文件——设计成立 |
| Stop/Retry 入口 | ❌ **缺口** | flux_agent 与 /flux agent 只有 list/create/run/archive，无 stop/retry（原 host API 有 stop/retry/wake，随 PiDeck 删除后 Main 层无替代） |

其他：thinking 枚举新增 `max` 档位（agent-runner/templates/entry schema，用户反馈 oa/deepseek-v4-flash 支持 max，xhigh 实际路由 high）；verify 367 全绿。

## T10：Persistent Stop/Retry 入口实链验证（2026-08-13）

重启加载新 dist（commit 86d8fb2）后验证：

| 验证点 | 结果 | 证据 |
|---|---|---|
| flux_agent retry | ✅ | `retry soak-worker` 复用 lastTask 重跑成功（agent 自知重复："我已经在上一轮回答了这个问题"）；in 311 / hit 90% / $0.0001；session 延续 |
| flux_agent stop 错误路径 | ✅ | 空闲 agent 报 `Persistent Agent is not running` |
| 状态累计 | ✅ | soak-worker calls=4（3 run + 1 retry）cost=$0.000358 |

真实 abort 停止（运行中中止进程）因工具串行无法在同会话模拟，孤儿恢复/错误路径由单元测试覆盖（TUI core 44/44）。verify 22 组 534 断言全绿。

## T11：社区协作 3b 实链验证（2026-08-15）

临时目录 print 模式（C:\Users\y1582\AppData\Local\Temp\flux-3b-test），真实 pi 进程 + 真实 provider（oa/deepseek-v4-flash）。提交 d3f5d34 + 684a71b。

### 全链路（提案→多提案绑定→真实子代理→提交→评审→解决）

| 步骤 | 结果 | 证据 |
|---|---|---|
| 创建 issue（新头部格式） | ✅ | `issue-143c17a4 · open · 3b实链验证`，`rounds 0 · cost $0.0000 · claims 0 · comments 0 · proposals 0` |
| 双提案 propose | ✅ | proposal-cfc1a2cd（方案甲）、proposal-08bdcadd（方案乙） |
| support / oppose | ✅ | 方案甲 support 1、方案乙 oppose 1（时间线 supported/opposed 事件） |
| claim 多提案绑定 + 方案 | ✅ | `/flux issue claim ... --props <p1>,<p2> --plan 综合甲乙两案`（命令层 --props 本次补齐），claim 记录 proposalIds×2 + plan，时间线 claimed 事件含绑定 |
| 真实子代理执行 | ✅ | `/flux agent run worker 总结方案甲与方案乙的要点`（run 命令拉起语义本次补齐）：SUCCESS exit=0，turns 6 · in 8591 · read 24704 · hit 74% · $0.0010，workers.json calls=1 |
| submit 细化方案 | ✅ | `--plan 综合结论：采用方案甲前缀布局并保留方案乙阈值开关` 写入 claim 并落时间线 submitted 事件 |
| review pass | ✅ | claim → reviewed，issue 回 reviewing |
| resolve 带理由 | ✅ | `resolvedReason` 落档 + 时间线 resolved 事件含理由，终态不可变 |

### 无进展门禁 + 人工兜底

| 验证点 | 结果 | 证据 |
|---|---|---|
| 3 次空反馈退回 | ✅ | stallStreak 0→3（允许落盘到阈值） |
| 第 4 次 submit 拒绝 | ✅ | `stall guard: 已连续 3 次退回且无新反馈（阈值 3），无进展；请人工介入评估，或 /flux issue resolve 直接解决` |
| 新认领拒绝 | ✅ | 同样错误 |
| 人工 resolve 兜底 | ✅ **实链发现死锁并修复** | 门禁后 claim 卡 active，原 resolve 被 `Issue has active or submitted claims` 挡住 → 死锁；修复：停摆状态（stallStreak ≥ 阈值）resolve/delete 放行（684a71b）；复测 resolved + resolvedReason 落档 |

### 实链发现并修复

1. **停摆死锁**（community.ts）：门禁触发后 claim 卡 active，人工无出路 → resolveIssue/deleteIssue 停摆放行（普通状态校验不变）。
2. **/flux agent run 无拉起语义**（entry.ts）：对不存在 Agent 报 `Agent not found`，与 flux_agent 工具不一致 → 命令层自动 createAgent 补齐。

verify 24 组 551 断言全绿（community-3b 20/20）；build OK。临时目录已清理。
