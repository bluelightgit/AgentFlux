# AgentFlux 逐功能实现与使用报告

更新：2026-09-08。分支 `fix/project-review-2026-09-07`，基线 `35f4edb`，工作树未提交。

## 结论

**核心流程已经可以真实使用，但不是全部功能完成，也不是全部入口都真实操作过。** 17 组审查问题均已有至少部分实现；这不是 17 组关闭，更不能换算成完成百分比。当前仍是开发级版本。

本轮子代理与隔离的生产验证使用 `openai-codex/gpt-5.6-luna`、`thinking=max`。真实运行加载对应快照的两个 production dist 入口，不以源码测试或最终自然语言代替 Core 事实。当前承载对话的 Pi 不会因磁盘重建自动热加载；未主动关闭它。

最新 GC/消息故障阶段见 [阶段摘要](../history-plans/2026-09-08-gc-message-validation.md)：共同 F 和 93 项竞争、同构建八类 live 脚本最新结果通过；真实强杀/ACK 丢失重投补齐。25 个 fixture 三资产、165 个记录 PID 的原进程核验通过；已识别编号复用，不声称所有 PID 数字不存在。其后的 Core 出生记录/异步观察与异常清理已局部实现，见 [PID 阶段摘要](../history-plans/2026-09-08-pid-identity-validation.md)。第二构建五类 fresh 脚本通过，不代表首次捕获、控制接管或原子性全部完成。

此前英文文案/Windows 后台专项见 [阶段摘要](../history-plans/2026-09-08-english-background-validation.md)：同构建 dogfood/find/grep、四场景 smoke、controls 通过，Windows 包另含 preload；API 窗口采样不是人工目测；后续 `window-check-luna` 实际 find/grep/bash 完成，用户确认没有终端出现，本次 Windows 桌面复验通过（`english-background/manual-window-check.json`）。用户已重启，当前交互 Main 模块加载仍未独立证明。

## 产品功能矩阵

| 功能 | 实现/确定性测试 | 真实使用情况 | 仍未完成或未验证 |
|---|---|---|---|
| Main 直接任务/对话 | 已实现，routing 回归通过 | 默认 smoke 的 direct 场景通过 | TUI Main Talk 按钮未逐项人工操作 |
| Task 与谱系 | 新任务防覆盖、终态不可改、结果聚合已修 | 九阶段 production history 已覆盖 new/continue/reuse/retry、活动准备及错误恢复拒绝；多种终态实测 | 不是失败 Agent 自动重跑或全部入口；hard-kill 恢复仍缺 |
| Agent 创建、多角色、模型选择 | 创建/并发去重/权限/生命周期回归通过 | 多角色 dogfood、实际实现/独立审查子代理、重复名 `-2` 与非法名拒绝均使用过 | 旧括号名称显式迁移、部分跨作用域竞态 |
| Agent 持久会话与 fork | 原生 SessionManager 分支、物理会话及代际隔离回归通过 | fresh 源会话、原生 fork、两次仅凭继承记忆回答；源 hash 不变 | 完整非法 session entry schema、外部源并发写等故障边界未穷尽 |
| Workflow 规划与执行 | planner、固定 DAG、依赖、质量门、输入绑定回归通过 | run → 显式 B reuse → modify 加 reviewer → 旧版 A reuse 四阶段通过 | Main 成为正式 DAG 节点尚未完成；恢复的全部参数负例尚未 fresh 穷尽 |
| Workflow 删除与引用 | Core 共用引用 fence；两 Node 进程 bind/delete 竞态通过 | Workflow 保存、修订与旧版执行使用过 | 持有真实 Pi lease 时删除的专项场景尚未覆盖 |
| Checkpoint 恢复 | schema/指纹/产物 hash/结果/费用继承、独立执行及原子写故障回归通过 | 真实业务失败后新 Pi resume，只重跑剩余节点；输入冲突零 child、源 hash/谱系/继承与本次费用均核对 | hard-kill/断电及异常中断费用恢复仍未完成 |
| Community | review 必填、真正 delete、同一 Core 状态机回归通过 | create→claim→submit→review pass→resolve 完整流程通过；空间冲突也实测 | 缺 verdict/delete 负例的全部真实入口、协作规模压力未覆盖 |
| Message V2 | 仅 V2；启动 ID 排除、轮询错误恢复、实际消费/settled ACK 回归通过 | peer 三通道、70 秒 busy；强杀和 Host ACK 丢失后新 Run 两次投递、各一次注入、最终 ACK 通过 | 所有 group 收件人、旧 Run fence 全部负例、迁移/compaction/背压组合与 Main 未读 TUI 仍未全验 |
| steer、stop、取消与 deadline | 定向控制/健康分离、出生重核验及实际退出门禁通过 | steer 消费/ACK、stop 后拒绝旧 steer、父取消和显式 deadline 均实测；本轮 controls 再通过 | 未知身份/信号失败可能长期 pending；接管、原子性及未观测孙进程不作保证 |
| PID 出生身份与启动异常 | Task/Run/lease/锁出生字段；14+13 身份检查和 4 组清理故障通过 | Main/两 role 出生值与在线系统查询一致；五类 fresh 通过 | 首次捕获缺原子握手，独立复审仍有未关闭项；Linux/真实复用压力/重启控制未完成 |
| 无默认执行 deadline | 项目覆盖改为 null，其他预算未提高 | fresh 无 deadline dogfood；实际子代理运行超过 600 秒后完成 | 不是长时 soak/断网恢复认证；夹具仍有独立 watchdog |
| 费用与预算 | Main/调用回执聚合、judge 统一 Run、共享预算回归通过 | Main 最终 401 不被两个成功子 Run 掩盖；非零 SDK→Run→父 Execution，以及恢复 attempt→父回执完整精度对账通过 | 供应商账单、异常中断费用补齐、历史差异追加式对账仍未完成；不能承诺绝不超支 |
| Capability 与文件门禁 | 损坏 narrowing fail-closed、锁与权限回归通过 | 受限角色成功路径实际运行 | 坏 ACL/损坏策略的全部 fresh 故障注入未完成；这是 Host 策略，不是 OS 沙箱 |
| GC、存储、归档 | host-wide F、稳定引用、owner/空 ID/Claim 拒绝及 fork 回滚；93 项多 Node 竞争和限定复审通过 | production Run→Claim 引用保护→释放后 GC、原生 fork 已通过 | 非参与 writer、全局跨项目索引、历史 session key/完整崩溃原子性仍不覆盖 |
| 英文、无 emoji 文案 | 自带 TS/JS 文案、角色资产与 formatter 门禁通过；用户原文保留 | 同构建 Agent/Workflow/Community 工具链通过 | 未逐个手工操作所有 TUI 菜单 |
| Windows 后台启动 | 子 Pi preload、缺资产零 Run、签名/Promise/取消回归通过 | 原生 find/grep、stop 通过；Win32 默认 spawn 无采样窗口、detached 仍存活 | 用户已确认一次实际子代理/工具调用无终端出现；跨平台仍待验，不是任意 GUI/孙进程隔离 |
| TUI、发布与长时运行 | TUI/命令回归、build、dist 导入通过 | 当前实际使用了调度工具与通知；不是所有菜单/键盘路径的手工验收 | 跨 OS、无源码安装、规模压力、长期 retention/soak 未完成 |

## 17 组问题逐项状态

| 编号 | 本轮结果 | 测试与限制 |
|---|---|---|
| R01 | typed TUI intent 接通 Main Talk / New Workflow | 正向 handler 回归；完整手工 TUI 未测 |
| R02 | review 缺 verdict 拒绝，delete 物理删除 | 单测负例 + Community 真实正向链；不是全部入口负例实测 |
| R03 | 冻结请求/节点输入；恢复 task/action/version/name 前置校验 | 四阶段对照、恢复输入冲突与省略正文的 production 路径通过；全部 fresh 参数负例未穷尽 |
| R04 | 结果/费用回执、假零价、重试旧错残留及 DAG 提前舍入已修 | 最终 401、非零费用、恢复精度对账通过；真实子 Run WebSocket error→成功 stop/父成功已补证；中断/历史账务仍开放 |
| R05 | active 防覆盖、新谱系、默认源正文 | review 与九阶段 fresh history 通过；并非全部入口/业务重跑验收 |
| R06 | senderRunId 与目标 Run fence 分离，V1 writer/注入退役 | peer 三通道与 uncorrelated 故障重投/ACK 通过；旧数据不猜测迁移 |
| R07 | narrowing 损坏拒绝，原子写与 PID-aware fence | capability 回归通过；未进行全部真实故障注入 |
| R08 | 证据型 checkpoint、独立恢复与完整费用精度 | 本地故障回归及真实业务失败恢复通过；hard-kill/断电仍未验收 |
| R09 | GC/session 归档与 native fork 窗口使用共同 F | 93 项竞争及写失败回归；真实引用保护和 fork 通过，非多文件断电原子性 |
| R10 | owner 隔离、稳定 ID、四类引用 writer 与删除入口共用 F | 双 Node writer-first/GC-first 通过；真实 Claim 生命周期与 GC 通过 |
| R11 | 合法 ASCII 身份、80 字符、安全后缀及锁内去重 | 并发 Node 回归及真实非法名拒绝/重复名运行通过；旧名迁移未做 |
| R12 | 同终态变价/改 outcome 拒绝，幂等不刷新时间戳 | registry 字节不变回归通过 |
| R13 | 消费 token/settled ACK、busy/启动消息所有权、poll 错误与审计隔离 | 长忙、mutex 恢复回归；真实强杀/ACK 丢失重投通过，不覆盖全部 compaction/背压组合 |
| R14 | 默认 smoke 换成当前入口、production dist 与完整证据 | 第二轮及最后重验四场景通过；中间预算失败/watchdog 中断均保留 |
| R15 | 活动 Workflow 引用的绑定/删除共用 Core fence | 两进程竞争通过；真实 Pi 删除竞态未测 |
| R16 | judge 使用统一 runAgent、父预算/取消/deadline | 七组 runner 回归及真实成功/deadline 通过；真实预算耗尽/运行中取消未全面覆盖 |
| R17 | 真正独立原生 fork，不复用源物理会话 | native fork production 多轮通过；源 hash、两次继承回答、费用未重复计入均核对 |

## 证据入口与失败保留

最新局部目录：`.agentflux/test-results/pid-identity-closure/`。最终 `summary.json` 已核对同候选五类 live 最新结果、6 fixture/59 记录 PID；出生字段及追加启动故障验证见阶段摘要，完整门禁为 `verify-8.log` 等。更严格的消息夹具也记录新鲜出生、二次 Run/attempt 和实际信号回执，两类重投再次通过；费用合计 $0.05649964 不是账单。独立复审不是所有 PID 风险的批准。

此前目录：`.agentflux/test-results/gc-reference-closure/`；`summary.json` 保存同构建八类脚本与全部历史失败，`provider-retry-facts.json`、`startup-inbox-live-failure.json`、`ack-loss-poll-failure.json`、`peer-selector-failure.json` 保存原因。执行记录成本约 $0.15407948，失败中断部分可能不完整，不是供应商账单。

以下旧阶段主要目录：`.agentflux/test-results/function-closure/`。

- `live-1788793699270-29556/receipt.json`：native-fork、peer、controls 通过；默认 smoke 首次因父输入预算 `62057 >= 60000` 失败。保留失败，收窄节点提示而未提高预算后另轮通过。
- `live-1788795202094-5680/receipt.json`：dogfood、四阶段 Workflow、四场景 smoke、P0-02、Workflow/deadline 通过。该构建是 `9be050fc…` / `24a789ed…`，不覆盖后续名称/计价代码。
- `busy-live-1788795844632-6036/receipt.json`：等待 70006ms，投递 attempts=1，真实消费/ACK 一次。
- `p002-current-independent-verdict.json`：独立 Luna reviewer 对第二轮 P0-02 的限定 PASS；36/36 artifact、12/12 精确 marker、Core/lease/PID/dist 交叉核对。旧第四次 rework 报告不改写，结论不外推到账单或新构建。
- `names-live-1788797478798-3704/receipt.json`：错误使用 run.name 导致严格调用计数失败；未放宽断言，提示明确 JSON 参数后 `names-live-1788797940783-27200` 通过。
- `pricing-zero-repro.json`：旧 Run 成本 0、原生会话费用非零的实证，旧事实没有回写。
- `pricing-live-1788799562174-19676/receipt.json`：非零 native 对账、Workflow/deadline 通过；smoke 被 watchdog 中断，保留 running Core 现场，不视为完成。
- `final-live-current.json` / `summary.json`：最后 dogfood 与四场景重验均通过；9 个不同 live 脚本的最新场景结果通过，核对 25 组 fixture/dist、97 个已记录 PID 当前均不存在。不同脚本横跨明确哈希构建，不代表所有功能或所有历史现场都终态。该阶段入口 hash 为 `cc710016…` / `24a789ed…`，不是之后恢复补丁的最新候选。

新增恢复阶段：`.agentflux/test-results/recovery-closure/summary.json` 核对同一最终构建的 dogfood、Workflow resume、九阶段 history 全通过；八组保留 fixture/dist、64 个记录 PID 复查退出。两轮恢复失败、旧委派的 WebSocket 错误及首次 PID 检查失败均保留，见 [阶段摘要](../history-plans/2026-09-08-recovery-entry-validation.md)。该恢复阶段当时仅有 GC 调查；共同 F 已由后续 GC 批次实现和验证，不再列为未开发。

非零对账样本：源 Run `0.0002878`、目标两个 Run 合计 `0.0006462000000000001`，均等于各自 SDK usage；父 Execution 分别等于 Main usage 加子 Run 一次费用。这证明该夹具中的本地记账一致，**不证明供应商账单权威性**。

确定性命令：`npx tsx tests/test-pricing.ts`、`tests/test-quality-gate-runner.ts`、相关 fork/message/routing/review 回归，随后 `npm run verify`、独立 `npm run typecheck`、`npm run build`、两个 dist 语法/动态导入、`git diff --check`。最终日志使用 `*-final.log`；较早 120 秒工具 watchdog 中断和所有失败 live 回执均保留。

## 后续工作

详细未完成任务只维护在 `docs/development-plan/`：继续处理 GC 历史/跨项目边界、显式旧名称迁移、历史/异常费用对账；先收口 PID 首次握手/控制接管/原子性余项，再补 Workflow hard-kill 恢复/业务重试、消息剩余组合、TUI 与发布/soak 验收。不能回答“全部功能已经真实用过”。
