# 当前规划：执行语义与数据可靠性

更新日期：2026-09-08。

本文件处理正式执行语义和持久化边界。任务按各自依赖推进，不再以“全部 P0 完成”作为统一前置条件。

## UX-02 Windows 后台进程闪窗（2026-09-08 新增）

- **状态**：兼容层及同构建真实测试完成；用户在 `window-check-luna` 实际执行 find/grep/bash 后确认“没有观察到终端出现”，本次 Windows 桌面复验通过（`english-background/manual-window-check.json`）。跨平台/其他启动路径仍待验证，不外推为任意 GUI 隔离。已完成阶段和失败证据见 [英文/后台摘要](../history-plans/2026-09-08-english-background-validation.md)。
- **分工/方案**：核对主启动、npm/cmd 包装、Pi 子工具、metadata 探测和 taskkill。当前 Windows/Node 24.11.1 的受控 Win32 API 采样中，detached+windowsHide 无记录窗口且父退出后子进程存活；改 detached=false 则子进程随父退出，因此保留现有 detached/进程树控制。Pi grep/find 的子 spawn 遗漏 windowsHide，属于可修正的已知窗口路径，但尚未证明它就是用户所见瞬时闪窗的唯一来源。
- **实施前契约**：仅由 AgentFlux 启动的非交互 Windows 子 Pi 在 CLI 加载前引入 package-owned preload，为 node:child_process 的 spawn/spawnSync/exec/execSync/execFile/execFileSync/fork 默认设置 windowsHide=true（尊重调用者显式 windowsHide=false 的交互意图）；同步 ESM 导出并覆盖 promisify 路径，保留参数校验、回调/Promise/ChildProcess、stdio、env、detached、超时、信号、失败和清理语义。不得修改安装的 Pi/node_modules、当前 Main、全局 NODE_OPTIONS 或另建执行器；POSIX 不加载。该 Host 选项不约束任意程序自行创建 GUI，不是沙箱。生产包必须包含 preload，缺失应可见失败。需受控跨进程、原生工具和 fresh 正常/停止验收；源问题及未覆盖短暂窗口保留限制。
- **已发现的集成失败**：首轮 fresh dogfood（两 role 实际 find/grep）与 controls 通过，但 smoke 仍仅复制两个入口，缺 preload，触发真实 `background preload not found`；原调用在登记 Run 后解析启动参数，留下无 PID 的 starting/stop_requested 记录。失败轮 `live-1788846561896-21280` 保留，不能声称 Workflow/Community 执行过。已将默认启动解析前移至 Run/lease 登记前、零 usage 返回可见失败，并补 missing-package 零 Run 回归；smoke 复制/验收第三个资产，提示禁止错误后自发诊断，未增预算或放宽事实断言。
- **验收**：平台选项定向回归、生产启动边界与停止清理回归、fresh Luna/max 正常/取消链路；Windows 可见窗口采样或用户复验单列。新的受控 Win32 API 对照中，无 preload 的默认 spawn 有可见 PseudoConsoleWindow，preload 默认 spawn 无采样窗口，detached 子进程仍在父退出后存活；显式 false 保留。该结果不是人工桌面目测。最终构建与 fresh dogfood/find/grep、四场景、controls 均已通过，后续剩余人工 TUI 与跨平台实际启动复验；本次用户确认只覆盖观察到的单次 Windows 子代理及其工具调用，不能外推为全部启动路径或任意 GUI 隔离。

## P1-01 Main 正式 Workflow 节点

- **状态**：待开发
- **目标**：Main 作为 planner 或其他正式节点时拥有节点级 Run、handoff、lease 和 settled 等待。
- **依赖**：P0-02；现有 `agent_settled` 生命周期。
- **验收**：后续依赖在 Main settled 前不启动；失败、取消、重试和恢复状态一致。
- **验证**：Main planner→后续节点真实 Workflow。

## P1-03 Task 与 invocation 谱系

- **状态**：部分完成
- **目标**：显式 task 优先、普通对话不产生无意义持久记录、invocation 成功/失败/取消后正确清理。
- **验收**：continue/reuse/resume/retry 创建新 Task/Execution 并保留父关系；历史不可修改；selector 规则一致。
- **验证**：Task Registry 回归和真实历史操作。

### 审查 R04 父任务终态和成本采用最后一次局部结果（高，部分完成）

- **本轮信号退出补充**：Message 崩溃夹具审查发现 runner 将任何无 exit code 的 signal 退出映射为 130/cancelled；POSIX 外部 SIGKILL 不等于用户取消。改为无 Host 显式终止码的 signal 退出失败并保留 signal 原因；显式取消/deadline 的 forcedExitCode 继续优先。真实 Node 信号定向及 production 接收 Run 强杀已通过，显式 controls 仍正确取消；不通过同时接受 cancelled 遮蔽分类错误。

- **2026-09-08 恢复费用实测**：第二轮真实恢复已仅运行剩余节点并完成新 Task，但严格对账失败：checkpoint attempt=0.0009326，而 DAG 返回值先四舍五入成 0.000933 后写入父回执。现已保留 Core 完整精度、只在展示层格式化；小数精度回归及最终 fresh 恢复对账通过，原 `1e-9` 容差和旧终态不变。详见 [恢复阶段摘要](../history-plans/2026-09-08-recovery-entry-validation.md)。
- **2026-09-08 新实测分支**：history fixture 子代理已交付后仍以历史 `WebSocket error` 失败；runner 将任意 assistant.errorMessage 永久留在 result，未清除 Pi 自动重试的瞬态失败。修复契约：仅后续明确成功的 assistant stop/toolUse 可以清除该 assistant 错误；不得清除预算、取消、deadline、spawn/registry 错误，最后一次 assistant error/aborted 即使无 errorMessage 也须失败。已实现并通过四项新增 Node 流回归；旧 Run/父回执不回写。fresh 普通成功路径通过，但未强制制造真实 Provider 自动重试进行该分支验收。

- **本轮新增实证与修复契约**：native-fork 会话存在 `usage.cost.total=0.0002758`，对应 Run 仍为零；`normalizePriceFile` 将仅 provider/contextWindow 的模型元数据转换成 source=user 零价，runner 优先用该假报价覆盖 Pi 成本。必须过滤没有有效显式价格字段的条目，保留真正显式的零价；Main/runner 采用同一顺序：有效 user/remote 价重算 → 有限非负 Pi usage.cost.total → 现有 fallback。补元数据/显式零/原生/远程优先级和在线预算回归，再以 fresh native 会话对齐 Run、调用回执与父 Execution。该值仍是 SDK 估计，不是供应商账单；旧终态金额不回写，历史差异的追加式对账仍待设计。

- **真实自动重试补充**：`gc-reference-closure/provider-retry-facts.json` 证明子 Pi 同一次 Run 出现带部分正文的 WebSocket error，随后成功 stop，Run 与父 Task completed；原消息夹具因统计错误的 failed verdict 保留。这不等于所有重试/降级或未知失败费用已覆盖。
- **本轮实施**：Core TaskExecution 保存按调用 ID 幂等的终态回执，归并结果不依赖结束顺序；Main 最终 error/abort 不被子成功覆盖，自动 retry 的中间 agent_end 不算最终失败。Main 已 settled 但后台 Agent 尚活跃时继续保持 running，最后的后台回执才收敛；shutdown 等待定向取消后的后台回执。costAccounting 分开 Main usage/已返回 invocation 成本并标记回执是否齐全，不取最后值/Math.max。当前 12 组 review 回归覆盖这些分支；真实 multirole 第二轮两个子 Run completed 后 Main 收到 401，Task/Execution 正确 failed/failure（整轮仍 failed），见 `review-continue-r04-provider-failure.json`。异常中断费用补齐、judge Run 级对账与真实多轮/后台验证仍未完成，不能将已知费用总和宣称完整账单。

- **定位**：`src/entry.ts:676-681` 用 executionOutcome 优先于 Main 最终失败；`884-891,939-944` 每次子调用直接覆盖这一变量。成本只取该局部 result，不是完整聚合。
- **复现**：空 DAG reuse 成功后，Main 最终 assistant 为 stopReason=error；agent_settled 仍把 Task/Execution 写成 completed/success。另从代码可见多个同步子任务结束时后成功覆盖前失败、后台子任务仅通知不更新父 outcome；这些并发变体尚待专项实测。
- **方案**：在 Core 按 invocation/Run 聚合状态与 usage，Main 最终 error/aborted 不能被子成功覆盖；定义后台任务的父执行 settled 条件并等其收敛。分别保存 main usage、child/judge usage 与总额，不能用最后一个子成本或 Math.max 掩盖口径差异。
- **验收**：成功子任务后 Main error/abort、并行一成功一失败的两种结束顺序、Main 先 settled 后后台失败均保持一致；成本逐项核对 Registry 与 TaskExecution，不重复计入；真实 Pi 验证。既有普通错误文本与显式 deadline 分类回归必须保留。

### 审查 R05 显式新任务复用活动 Task/Execution（高，主路径已验证，入口边界待补）

- **本轮实施**：已物化的 active invocation 一律拒绝被新准备操作替换；不再复用 preparedTaskId。工具/CLI 均加活动检查，retry 仅允许 failed/cancelled/timed_out。review 回归确认 active new 拒绝且文件字节不变、settled 后新 Task/Execution 不同、completed 不可 retry；production history 九阶段通过（默认源正文、new/continue/reuse/retry、活动非 new 准备拒绝等）；重复 active new、CLI 与带活跃子 Run 的切换仍需全部 fresh 覆盖。

- **定位**：`src/entry.ts:726-740` 将 activePlan.taskId 作为新 plan.taskId；`src/core/task-execution.ts:45` 默认 executionId=taskId。
- **复现**：连续 `flux_task new`（first、second）只得到一个 Task/Execution，正文 first 被 second 覆盖。不是一次未落盘 implicit intent 的无副作用准备；两次显式调用均已 startPlan/register。
- **方案**：区分尚未执行的 intent 与已经开始的 invocation；new/continue/reuse/resume/retry 对已物化执行必须新建谱系或在活动执行不允许切换时显式拒绝。不得重标已有子 Run 的父 Task；统一工具、CLI 的 retry/resume selector/status 校验并清理上一 invocation 的 outcome/usage。
- **验收**：同一轮多次 new/history 操作、已启动子 Run 后切换意图、异常/取消后重试均不覆盖旧 ID/正文/子引用；真正准备型调用的幂等条件需明文限定。

### 审查 R12 同终态写入仍能篡改历史事实（中，待真实验证）

- **本轮实施**：同终态仅允许相同事实幂等重放，异值 cost/usage/outcome 拒绝且不改文件，相同重放不刷新 updatedAt/finishedAt。Task Registry 12 项通过，既有 orphan recovery/space 回归保留通过；真实 history 与业务失败恢复已核对源 Task/Execution 不变；故障 reconciliation 仍需继续验证。

- **定位/复现**：`src/core/task-registry.ts:244-265` 仅拒绝不同 terminal status。completed(cost=1, success) 再写 completed(cost=99, failure) 被接受，finishedAt/updatedAt 也可重写。
- **方案**：终态后只允许内容相同的幂等重放；差异化 outcome/usage/cost 拒绝，合法补账如确有需求以不可变关联事件记录并制定契约，不能静默修改历史。
- **验收**：同状态异值拒绝且文件字节不变；相同事实重放不刷新终态时间；恢复 reconciliation 的幂等性仍通过。

## P1-04 checkpoint 与 resume

- **状态**：R08 核心、确定性回归及新 schema 真实业务失败恢复通过；hard-kill/断电恢复待验
- **续接实现**：新增 `dag-checkpoint.ts` 校验版本/身份、规范化 DAG 指纹、节点与结果集合、成功/依赖/usage/gate、产物归属/hash/输出一致性。旧无版本快照拒绝；执行 fence 跨异步周期持有，既有目标 checkpoint 和原地 resume 拒绝；原子 checkpoint/latest 保存、产物写失败不吞错。resume 复制已完成产物并区分 inherited/attempt/cumulative cost，预算包含 inherited，新 Task 回执只计 attempt。DAG 37/37、review 坏快照/伪输出/越界/超额/同 ID 并发/保存失败测试通过；新 schema Provider resume 已通过，只运行未完成节点并核对原历史/产物 hash、继承费用及当前 attempt 回执；断电/hard-kill 故障仍未覆盖，本项不整体归档。
- **目标**：checkpoint 具备 schema、原子性、节点集合校验和连续成本。
- **验收**：损坏数据 fail-closed 且不覆盖证据；恢复只跳过已完成节点；成本不归零。
- **验证**：中断/损坏/并发测试；真实 Workflow resume。
- **2026-09-07 审查 R08（高，已知缺口的可复现实证）**：`src/workflows/dag-executor.ts:523-540` 仅比较 nodeIds 集合，信任 completed/taskResults/artifactPaths 并把 totalCost 置零。隔离父 checkpoint 声称 n1 completed 但 taskResults=[]、无产物、历史成本 $1.25；resume 返回 passed、0 个结果、cost=0，未执行节点。`500-520` 的 checkpoint/最新指针直接 writeFileSync 且吞异常，保存失败不会阻止成功返回（静态确认，未做磁盘断电实验）。
- **修复方案**：版本化完整 schema + DAG 内容指纹（不只是节点名），completed 必须是合法节点且有匹配 passed result/产物证据及完成依赖；校验路径归属、数值与状态。明确 inheritedCost、attemptCost、累计成本及预算口径，不靠归零实现新尝试。用统一原子 JSON store 写 checkpoint，失败需可见并保留旧快照；resume 始终派生新执行，不原地覆写父 checkpoint。
- **实施约定**：checkpoint 新 schema 使用版本、规范化 DAG 指纹和 artifact SHA-256；旧无证据 schema 明确拒绝，不自动猜测升级。恢复必须指定独立目标 execution，父 checkpoint/产物只读，已完成产物复制至新执行目录。`totalCost = inheritedCostUsd + attemptCostUsd` 用于恢复累计预算，当前 Task 只记 attemptCostUsd，避免历史费用二次入账。持有 PID-aware 执行 fence，原子保存失败向调用方暴露，不继续返回成功。
- **验收补充**：伪 completed、越界节点、同 ID 改 DAG、缺/坏产物、写失败、进程中断、成本超限均 fail-closed；真实 resume 核对父文件哈希、跳过节点依据、新谱系与连续成本。

### PID 出生身份与编号复用（局部实现，恢复前门禁未关闭）

- **已完成部分**：出生字段、异步观察/迟到绑定、未知保留、启动异常/实际退出收敛、14+13 项身份回归和 4 组清理故障、完整门禁及两轮五类 fresh 验证见 [局部阶段摘要](../history-plans/2026-09-08-pid-identity-validation.md)。真正 OS 编号复用来自旧 GC 核验器，Core 尚未复现实际误杀；不能以合成出生不符测试冒充真实复用压力验收。
- **首次捕获与启动握手**：独立 reviewer 仍质疑首次观察到本地 exit 事件之间的窗口，见 `pid-identity-closure/reviewer-final-facts.json` / `review-disposition.md`。设计 child 自报/父授权及物理实例句柄，证明登记失败时不提前执行模型；不能仅把同步查询前移就声称原子性，也不能恢复阻塞 stdout/deadline 的旧实现。
- **2026-10-06 Windows cold-CIM事实**：v0.1.3/tag四CI与真实包调用通过后，main仅文档追加的Windows Node22正向SDK单测首次2秒CIM探针超时，按设计exit72/零Run拒绝，其他三job成功。不能放宽unknown门禁或扩大产品探针/模型deadline；正向test-subagent-runtime先最多三次异步真实OS观察并断言alive，再测试SDK，身份/权限/失败断言保持。完整产品cold-start预热/可见重试与启动握手仍在本节未完成范围，不以单测准备关闭它。
- **未知与恢复控制**：缺 PID/owner 的 starting 记录目前只是保守推迟。完善有界的 cleanup-pending 呈现与后台收敛，在不伪造终态或释放保护的前提下处理长期拒绝；重启后仅写 stop 文件可能没有消费者，需核验真正的控制接管。不增加不安全 Registry-PID 强杀入口，不猜补 legacy 身份。
- **锁与性能**：stale-lock token/generation 的原子 claim/CAS、外部观察在短 F 临界区外批量完成仍待实现。当前 positive-only 缓存只能推迟回收，强杀始终新鲜核对；单纯 rename/unlink 和出生字段不提供多文件或内核原子性。
- **剩余验收**：Linux/其他平台及 PID namespace 边界、真实编号复用/句柄控制、父 owner hard-kill→接管→resume/retry、更广进程树与权限/探测超时压力。此门禁优先于扩大 owner 强杀恢复。
- **已验证边界**：消息夹具的出生/Run/attempt/信号检查与两类故障再投已复验，最终同候选五类脚本、6 fixture/59 PID 汇总通过，详见局部阶段摘要。这不完成上列首次捕获、接管和原子性门禁。

## P1-05 数据和输出边界

- **状态**：待开发
- **目标**：tasks、runs、events、delivery、dedupe、控制文件、stdout、stderr 和 assistant 消息都有容量与保留策略。
- **验收**：长运行内存和磁盘有界；GC 不删除运行中/被引用对象；截断仍保留可追溯证据。
- **验证**：大输出、长时运行、GC、归档和并发写入 soak。
- **R09 当前事实**：错误旧前缀/idle 归档问题已修复；共同 F 覆盖引用判断、删除、session 归档和 native fork 创建/登记。93 项跨进程竞争、边界回归及同构建 production GC 引用链/native fork 通过，详见 [阶段摘要](../history-plans/2026-09-08-gc-message-validation.md)。
- **R09 剩余验收**：历史 fork/超长 fresh key、完整多角色/代际与祖先会话的保留策略、真实崩溃迁移窗口；禁止按 name 猜文件。外部直接 session writer 和多文件断电原子性不在 F 保证内。
- **额外资源边界确认**：`src/entry.ts:354-361` 每次 Spaces 全量读取 events.jsonl；`src/telemetry/events.ts:49-51` 持续追加且写失败静默；`src/core/task-registry.ts` / `run-registry.ts` 全量 JSON 读改写、无终态总量回收。现有单条 recentEvents/消息字节上限不等于全仓有界。按本项增加增量/尾读、索引、分页和保留策略；未运行新的长时 soak，不宣称发生 OOM。

## P1-06 session Agent 隔离

- **状态**：部分完成
- **目标**：所有 session Agent 的 list/find/mutate/GC 都尊重 ownerSessionId。
- **验收**：跨会话不可见、不可运行、不可删除或回收；旧格式安全迁移。
- **验证**：多 session 确定性测试和真实会话清理。
- **R10 当前事实**：owner 隔离、稳定 ID、Run/Task team/Claim/DAG writer、各删除入口和 native fork 共用 F 已实现，93 项多 Node 竞争、边界测试、限定复审及实际 Claim 生命周期/GC 通过；实现和失败归入 [阶段摘要](../history-plans/2026-09-08-gc-message-validation.md)。
- **R10 剩余**：全部公开菜单/CLI/多会话故障路径、旧格式/历史引用释放策略及 global 跨项目索引。没有完整索引时 global 删除保持拒绝，不以授权参数替代引用证据；终态 Task team、未删除 Claim、保存 Workflow 版本的保守引用可能长期保留 Agent，应明确后续 retention 而非直接删历史。
- **边界**：F 不覆盖旧二进制/外部文件访问/跨 VM realm；普通 fork 回滚不是断电事务，仍需故障与归档验收。

## P1-07 并行写隔离

- **状态**：待开发
- **目标**：为写密集型并行 Run 提供可选的 Git worktree/独立 checkout 绑定；继续使用同一 Agent、Task、Execution、Run 和执行器，不创建平行身份或状态机。
- **依赖**：P0-02、P1-03；现有 workspace/lockFiles 能力。
- **验收**：Core 记录每个 Run 的 workspace 绑定、基线 commit、分支和 merge/apply 结果；同文件并行修改不会静默覆盖；取消、失败和清理只处理对应 Run 的 checkout；用户原工作树及既有未提交修改不被移动或清理；界面明确说明这是工作区隔离而非 OS sandbox。
- **验证**：同文件冲突、非冲突合并、脏工作树、取消/崩溃清理和 Windows 路径测试；production dist 两个写 Agent 的隔离与合并验证。

## 2026-09-07 全仓审查补充运行项

### R16 quality-gate judge 未纳入统一 Run/预算链路（高，核心及成功/继承真实链路通过，边界待收口）

- **最新真实证据**：用户授权取消项目残留 600 秒覆盖后，用相同 R16 production dist 与 fresh Luna/max Pi 复跑 Workflow/deadline。两次真实 judge 均 Core role=judge、gate.runId 对应同父 Task/Execution、input/output/cost 原精度一致；显式父 deadline 继承通过。完整 stdout/stderr 和工作区保留，证据 `no-default-deadline/judge-deadline-production.json`、`no-default-deadline/summary.json`，取代下文“尚未跑”的阶段状态。预算耗尽/并发/取消由 7 组确定性测试覆盖，本次未增加真实预算耗尽/主动取消 judge 场景，不声称权威 Provider 计费通过。

- **本轮实施结果**：私有 spawn/计费/清理器已删除，checkQualityGate 复用 runAgent；新增 gate.runId 与 typed budgetExceeded/cancelled/timedOut，未注册拒绝不返回悬空 Run 引用。每次 attempt 重新计算剩余节点费用，统一父 Run 预算与在线快照；费用保留 Core 原精度，显示时才格式化。`tests/test-quality-gate-runner.ts` 7 组通过，含真实 Node 子进程在线 PID/usage、父成本/轮次/token 耗尽零 spawn、共享并发/成本、取消/窄 deadline、两次不确定 verdict 与一次计费。完整 verify（29 脚本）/typecheck/build 通过。该阶段后的 fresh 成功/deadline 证据已补齐；最新计价轮同样通过。真实预算耗尽及主动取消 judge 尚未全面覆盖。

- **本轮实施约定**：删除 judge 私有 spawn/计费/进程清理器，直接复用 runAgent（只读、关闭消息能力、无持久会话、无隐式重试/模型降级）。每次 judge attempt 独立 Run，role=judge，回执关联 runId；传递同一父 task/execution、绝对 deadline、成本/轮次/token/并发限制，并在每次 attempt 重新计算节点剩余费用。预算拒绝/取消/真实 timeout 不再重试 judge；不可验证 JSON 仍最多两次，不将 worker exit=0 当成 gate 成功。以独立 Node helper 验证预算耗尽零 spawn、并发共享预算、在线 PID/usage、取消/timeout 及一次计费，再 fresh Pi 验证。本轮不借此声称修好了未知 Provider 定价。

- **证据级别**：原始审查为静态控制流；修复已有确定性与 fresh 成功/deadline，仍未通过新的 Provider 调用测量预算超支幅度。
- **定位**：`src/workflows/quality-gate.ts:154-170,229-235,269-272` 自行 spawn Pi，`--no-extensions`，不使用 runAgent/Run Registry；opts 无 taskId/executionId/父成本与轮次预算。`src/workflows/dag-executor.ts:969-984` 每次 judge 后才累计 gateCost，indeterminate 可再调用一次，期间未重新检查 remainingNodeCost/父预算。
- **影响**：即便 worker 已耗尽父轮次/成本，也可能继续开启 judge；无显式 deadline 的 judge 不受父成本/轮次停止控制，在线 Task 成本与 Run 汇总缺这部分 PID/usage 事实。现有三态 verdict fail-closed 和 deadline 继承正确，不等于预算/可观测性闭合。
- **方案**：judge 复用统一执行器与 Core Run 身份，继承父 task/execution、可选绝对 deadline、聚合成本/轮次/token/并发；每次 judge retry 重新预检并在线回写 usage，最终只聚合一次。保留 judge 独立模型和三态 verdict，不增加第二套账本。
- **验收**：worker 恰好耗尽预算时无新 judge provider request；多节点同时 judge 不各获完整预算；Run Registry 能查 judge PID、role、usage、状态、失败原因；取消与 deadline 实测。

### R17 Agent 原生 fork（高，核心及真实成功通过，故障边界待补）

- **最新状态**：SessionManager.forkFrom 创建独立物理文件/UUID/parentSession，按真实 lastSessionId/文件选择源并拒绝歧义；按当前角色/能力代际加载分支，不把历史会话当作当前权限授予。native fork 和旧 lifecycle 回归通过；fresh 源→原生 fork→两次只凭继承记忆回答、源 hash 不变、独立会话及非零 SDK/Run/父费用对账均真实通过。
- **剩余**：完整非法 session entry schema、外部源同时开始运行/写入、跨进程并发及写入失败等边界补验；JSONL 可解析不等于完整 Pi entry schema 有效。旧的相同 session key 断言已替换，不能再把 origin 标签当分支证据。

- **定位/证据**：`src/agents/agent-store.ts:261-268` 将源 Agent.sessionId（或传入的文件路径）直接作为新 Agent.sessionId；`413-415,447-449` 继续当 persistentSessionId 传 runner，后者 `1262-1266` 拼 capability 后缀并作为 `--session-id`。隔离 create 已确认两个不同 Agent、origin=fork，却拥有同一个 sessionId；无原生 session fork 调用。
- **影响**：同角色/模型/工具时生成同一 session key，有共写同会话风险；源最近一次为 fresh 或多角色 Run 时只复制基础 key 也未必继承实际最近上下文。文件路径被当 ID 清洗而非加载分支。当前测试 `tests/test-agent-lifecycle-new.ts:584-585` 只检查相同 key，不能证明 native fork；未做本轮真实并发共写验证。
- **方案**：解析源真实 session 文件与 fork point，用 Pi 原生 session branching 创建独立目标文件/ID，持久化 parentSession/forkPoint；无法解析时明确拒绝。继续使用统一 Agent，不能将 origin 标签当分支证据。与已有正常 `/flux fork`（`session-fork.ts`）区分，后者确实调用 ctx.fork。
- **验收**：同角色与跨角色 fork、源 fresh session、文件路径 fork 均有不同目标 session；继承指定分支上下文，源文件哈希不变，并行运行无会话交叉；按真实 Pi/Provider 链路收口。

## 完成前置条件

P1 任务不得改变产品目标或架构事实源；若发现现有架构无法满足验收，先修订 [项目架构](../01-architecture.md) 和本规划，再实现。原 P1-02 busy Agent 队列已提升并合并到 P0-07，避免把基础 steer/queue UX 推迟到数据治理之后。
