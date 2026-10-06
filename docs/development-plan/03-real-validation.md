# 当前规划：真实验证与发布边界

更新：2026-10-06。只维护未完成或待重验范围；已完成/被替代批次见 [阶段摘要](../history-plans/2026-09-08-review-validation-progress.md)。当前逐功能事实见 [功能与测试报告](../reviews/2026-09-08-function-validation.md)。

## RELEASE-01 / P0：v0.1.3 发布门禁与远程验收（进行中）

用户授权在各场景确认无误后合入main、打tag，并检查GitHub Actions及npm更新。当前npm/latest与远程tag均0.1.2；候选0.1.3，证据 `.agentflux/test-results/release-0.1.3-2026-10-06/`。保存现有工作树/分支/HEAD，不覆盖既有改动或重写历史。

- 同候选重跑最小/verify/独立typecheck/build/pack，核对依赖锁、Host wrapper/两个业务入口/preload、无敏感或本机runtime文件；两后端production真实Core/Agent/planner/node/judge/Community、history、fork、消息、resume、telemetry、并发/取消及自动安装范围。人工UI/未支持平台/不合作工具/长soak不伪造PASS，发行说明列边界。
- 修复已知Node20工作流基线，CI最低22.19及24/Linux与Windows；发布检查tag=manifest、构建/测试/包布局通过才publish。Live区分配置缺失失败与真实Provider失败，不用skipped代替通过；不暴露API key。
- 确认origin/main关系、无版本/tag冲突，提交审核过的源/测试/文档/manifest；不提交本机证据、token/凭据、node_modules/dist。只允许正常合并/fast-forward与非force推送，不移动既有tag。
- 按用户原文“各场景测试无误后推main/tag，完了看Actions/npm”的顺序：本地同候选两模式各12类fresh及包/安全门禁、main四CI成功后可推v0.1.3，观察Publish/GitHub Release与Live结果分别汇报，不能声称所有Actions通过。2026-10-06远程Live的仓库Provider旧模型404、当前alias不支持、目录返回空；这是外部配置阻碍，保留失败，不自动换模型、不复制本机凭据或放宽断言。发布身份先以dry-run npm whoami实际验证，失败暂停真正publish、告知用户更新NPM_TOKEN。npm必须实际查询新版本/latest并下载包检查integrity/版本/资产与隔离安装/Host加载，不以Publish job名或本地npm pack证明远程可拉取。
- 完成报告保存commit/tag/Actions URL及结论/npm dist/完整性/关键证据与未认证范围；完成后归档该任务，不扩展为所有产品场景认证。

## PLATFORM-01 / P1：Linux 原生验收与 macOS 生命周期缺口（待实施 / 验证）

2026-10-01源码调查：Windows当前候选有真实证据；Linux已有/proc boot_id+starttime和POSIX process group逻辑，但缺本候选原生全链路认证。macOS/darwin在process-identity中明确unsupported，停止/锁/GC/orphan路径只能保守unknown，不是仅缺一次测试。证据见[Host与平台报告](../reviews/2026-10-01-host-binding-platform.md)。

- CI基线已修：Linux/Windows的Node22.19与24四job于2026-10-06真实verify/build/pack/offline Host全部成功；job事实见v0.1.3发布报告。仅确定性/模拟认证，远程Live因外部Provider配置失败，不能扩展为Linux全业务实测。macOS仍须出生身份闭合后纳入完整支持。
- Linux：独立Linux node_modules、真实/proc与PID namespace/权限/zombie、取消进程组/锁释放、fork/恢复/Message V2与费用；production dist的fresh Provider证明。不能用WindowsNode/共享Windows依赖/模拟platform代替Linux执行。本机WSL Ubuntu22.04可读/proc，但未找到原生Linuxnode，本次未安装系统运行时或认证Linux。
- macOS：先设计并实现精确OS出生身份（原生进程信息与boot identity），不得只凭PID或秒级ps lstart，也不将unsupported改成已退出。同步schema/validator/旧历史兼容、权限失败unknown、停止前重核验、锁/GC/recovery；再运行macOS真实正常/取消/崩溃/编号复用及production业务链路。
- 分工：Core/process-identity与OS适配提供事实；runner继续定向停止并等待实际退出；TUI只显示，Host策略不等于OS沙箱。与02已有PID首次握手/原子性/owner强杀任务共享契约，不另造执行器。
- 未闭合前：Linux标实现基础/待原生验收，macOS不宣称完整多Agent支持；发行说明明确平台/Node/安装形态和证据范围。

## UX-01 / UX-02 英文与后台启动专项

- 已完成实现、完整门禁、同构建 Luna/max dogfood（两个 role 实际 find/grep）、四场景 smoke 和 controls；阶段归档见 [英文/后台摘要](../history-plans/2026-09-08-english-background-validation.md)，`english-background/summary.json` 核对 18 个资产、31 个已记录 PID 退出及未变父预算。首轮漏资产和汇总误判的失败均保留。
- 剩余：人工 TUI/键盘全路径、跨平台实际启动/安装。用户已在 `window-check-luna` 执行 find/grep/bash 后确认没有终端出现；本次 Windows 桌面复验通过，证据 `english-background/manual-window-check.json`，不外推全部启动路径。AST/API 采样与该次人工观察分别记录，不作任意 GUI/全部孙进程隔离承诺。
- 用户再次重启后的后台/文案与 Luna/max dogfood 复验已通过，证据 `english-background/post-restart/summary.json`；同构建两 role 的 find/grep、Task/Run completed、max 会话及记录 Main PID 退出均核对。该次未重跑完整套件；后续单次人工桌面确认单列，不混同该 dogfood 证据。
- 后续生产验收必须核对两个入口及 `background-preload.mjs`。其他 live 夹具已同步复制/指纹/英文错误期望，但本轮没有全部重跑，不得外推旧 P0-02 或恢复验收。

## GC/消息故障已完成阶段

同构建八类 live 脚本的最新结果、93 项引用竞争、独立限定复审及完整门禁已通过，归档到 [GC/消息阶段摘要](../history-plans/2026-09-08-gc-message-validation.md)。`gc-reference-closure/summary.json` 核对 25 个保留 fixture 和 165 个记录 PID 的原进程退出；编号复用按出生时间区分，不等于所有整数 PID 不存在。全部失败保留。Core 出生记录/异步核验与异常清理现已局部实现并验证，见 [PID 局部摘要](../history-plans/2026-09-08-pid-identity-validation.md)；不是首次启动/控制接管/内核原子性全闭环。

## 上轮候选与失败证据

- 本地定向、完整 verify、独立 typecheck/build、两个 dist 语法/导入和 diff 门禁已通过；日志位于 `.agentflux/test-results/function-closure/*-final.log`。
- 第二轮 `live-1788795202094-5680` 的 dogfood、Workflow 四阶段、默认四场景、P0-02、Workflow/deadline 已通过。独立 P0-02 PASS 只绑定该快照，不自动外推至后续名称/计价构建。
- native 新名称负例/重复名和原生 fork 通过；`pricing-live-1788799562174-19676` 进一步提供非零 SDK→Run→父 Execution 对账、Workflow/deadline 通过。真实费用来源仍是配置/SDK 估计，不是供应商账单。
- 同轮 smoke 被 supervisor watchdog 中断，报告仍 running，Workflow/judge 保留未收敛的 Core 现场；从前一晚到结束存在长时间间隔，是否系统休眠/时钟变化未确认。原目录不删除、不改成 passed，不擅自补写历史终态。
- 最后按原预算、原断言复验的 dogfood/四场景已通过，见 `final-live-current.json`；`summary.json` 核对 9 个不同脚本最新场景、25 组 fixture/dist、97 个记录 PID 当前均不存在，不只看最后一句话。不同构建的场景不合并宣称为单一候选全部验收。

## 恢复专项的剩余边界

已完成的入口、九阶段 history、真实业务失败恢复及未舍入费用对账，连同两轮失败证据，已归档到 [恢复阶段摘要](../history-plans/2026-09-08-recovery-entry-validation.md)。`recovery-closure/summary.json` 核对最终同构建三脚本通过、八组 fixture/dist 与 64 个记录 PID 退出；不代表本页余项关闭。

剩余：真实 Workflow owner hard-kill/断电与中断费用补齐、全部恢复参数负例的 fresh 入口、所有自动重试分支。子 Run 的一次真实 WebSocket error→成功 stop 及父成功已由 `gc-reference-closure/provider-retry-facts.json` 补证，不代表全部恢复故障闭环。

## P0-02 当前候选范围

Main 失败 sibling 返工已取得独立 PASS（36 artifact、12 marker、Core/lease/PID/dist），旧第四次失败报告保持不变。新的计价等补丁必须按受影响范围继续重验，不把旧快照 PASS 当成本、全部孙进程或最新候选全功能认证。

## P2-01 Production Workflow

- `test-workflow-resume.ts` 的可控业务失败恢复已通过；源历史/产物不变、独立谱系、零重复首节点、继承费用与本次 attempt 回执均核对。不是 hard-kill/断电恢复。

- 已真实覆盖 run→显式 B reuse→modify 增加 reviewer→旧版 A reuse，核对正文/冻结请求/执行输入/节点/gate/保存版本和旧终态不变。
- 剩余：恢复时 action/selector/version/name 等全部 fresh 负例；完整中断恢复/重试、真实 Pi 活动引用删除竞态、Main 正式 DAG 节点及更大 DAG 容量。
- 验收必须核对 Task、Execution、definition/version、DAG、Run、checkpoint 和费用，而不是仅看到模型说完成。

## P2-02 Community 与 Message V2

- 已真实覆盖 create→claim→submit→review pass→resolve；peer direct/group/broadcast 到目标收件人 ACK；busy 70006ms 后仅一次注入/投递/ACK；steer/stop 正向与停止后拒绝。
- 已新增真实 uncorrelated 消息的接收 Run 强杀及 Host ACK 丢失重投，恰两次投递/两个会话各一次注入、最终 ACK 与四个父 Task 结局均通过；不是仅复用 busy 成功。
- 剩余：缺/非法 verdict、物理删除等全部入口的 fresh 负例；预算/轮次/停滞门禁；所有 group 收件人、Main 未读 TUI；全部旧 Run fenced 消息负例、compaction/重试/背压组合及显式旧消息迁移。
- 不猜测 V1/correlation-only 消息来源，不放宽物理 Run fence 或把限定故障成功扩展到所有消息场景。

## P2-03 进程失败与恢复

- P0-05/P0-07 原模型错误/overload、owner-fence、dead-owner、controls/deadline 基线保留，见历史摘要。本轮统一 judge 的成功/父 deadline/超时已通过。
- 出生字段/在线观察、未知保留、启动失败及实际退出门禁已有确定性与 fresh 证据；详细范围见 PID 局部摘要。剩余：首次启动握手、未知长期 pending 的控制接管、原子终止/锁 claim、Linux 与真实复用压力；这些门禁完成后再扩大新 checkpoint/计价逻辑下 Workflow owner kill→重启→resume/retry。异常中断费用补齐、真实 judge 预算耗尽/运行中取消、更广进程树/资源容量/并行写隔离仍开放。
- 验收持续核对 liveness、progress、health、费用与真实失败原因；只确认记录过的自有 PID，不凭 Main 退出推断全部孙进程已退出。

## P2-04 新版 Task history 复验

- 早期实际 continue/retry 基线及本轮 Main continue 父谱系事实有效；不是从未使用过。
- `tests/live/test-task-history.ts` 已重写为 production dist、精确 marker/JSON 参数、失败证据保留及新谱系断言，helper 加入 unit 门禁；fresh new/continue/reuse/retry、活动准备拒绝、completed retry 拒绝、resume 正文/无 checkpoint 拒绝九阶段已通过。剩余不同入口、重复 active new 与真实中断重试等边界。单纯准备谱系通过不代表失败 Agent 或任意业务自动重跑；真正部分 Workflow 恢复由 P2-01 专项覆盖。
- 每次操作真实调用对应 `flux_task`；历史身份/正文/费用不覆盖，准备型幂等与已物化执行严格区分。

## P2-05 长时运行、TUI 与发布包

- 无默认 deadline、实际超过 600 秒的子代理与旧 long/fan-out/package/soak 基线保留；不等于当前版本完整 soak。
- 剩余：所有菜单/键盘路径人工验收，跨 OS、无源码安装、规模并发、registry/event 增长、GC 历史 key/跨项目索引、长期 retention 和进程树压力。
- 发布必须保留构建/版本/模型/thinking/费用来源/PID/终态/关键事件/失败原因。Host 策略不是 OS 沙箱，SDK 费用不是供应商账单。

## 统一执行规则

- 使用 `tests/live/live-test-config.json` 的 local profile，实际 Main/planner/worker/judge 为 `openai-codex/gpt-5.6-luna`、max；仅明确的 `AGENTFLUX_LIVE_*` 覆盖优先，不能因当前 Main 的 PI_MODEL 换回其他模型。
- 项目无默认执行 deadline；成本/轮次/token/并发不擅自扩大。夹具 watchdog、网络/锁/启动握手超时与产品执行 deadline 分开记录。
- 全新 Pi 加载本轮指定构建的两个 dist 入口与 background preload；外部监督器负责，不结束承载对话的 Pi。停止旧进程仅接受明确 `--old-pid`。
- 先最小测试，再 verify/typecheck/build、dist 与 diff 检查。真实链路保存完整 stdout/stderr、唯一报告、Core/session/checkpoint、构建 hash 和工作区；成功、失败、中断都保留。
