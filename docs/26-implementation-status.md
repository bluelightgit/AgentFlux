# 26 - 实现状态与发布门

更新日期：2026-07-18。

本文件是当前能力状态的唯一事实源。每次功能接入生产入口或验证级别变化时必须同步本文件。状态含义：

- `designed`：只有设计或接口草案。
- `implemented`：已有代码，但未接生产入口。
- `wired`：生产入口可到达，失败/取消/数据语义已经接线。
- `verified`：有可重复测试证据；注明 offline 或 live。
- `released`：经过真实任务灰度并进入默认产品承诺。

`implemented/wired` 描述代码接线情况，`offline/live verified` 描述证据等级，`experimental/released` 描述产品成熟度；三者不能相互替代。例如“wired / offline verified / experimental”表示入口可达且自动化测试通过，但尚未完成真实 provider 灰度。

## 状态速览

### 已完成并接入

- M1、M2、M5 的生产执行入口与失败语义。
- SharedBoard 原子任务/文件锁、Message/Delivery V2 可靠文件协议、子 Agent 身份绑定消息工具和可选 communication completion gate。
- V1/V2 消息、终态 Agent 和孤儿 session 的安全 GC；缓存影响提示；类型检查和单元/集成回归门。

### 已开发但仍为实验性

- M3 fork、M4 persistent multi-agent、M6 heterogeneous team。
- 子 Agent 主动通信和 required handoff/显式 ACK：offline verified；Persistent/RPC prompt/follow-up/steer、abort 和 crash redelivery 已完成真实 provider live smoke，仍为 opt-in experimental。
- 分层能力策略与 Desktop 权限观察面：角色模板→注册实例→单次运行只能收窄，真实 provider 工具门禁已验证；仍属于宿主门禁，不是 OS 沙箱。
- Desktop 多 runtime 工作台：通信恢复与 Extension UI 均有 live 证据，整体仍未达到 released 灰度门。

### 尚未开发或尚未接入

- Desktop 受控 capability-policy set IPC；当前 UI 刻意只生成带 expectedRevision 的 `flux_capability_policy set` 请求草稿，避免绕过 core 校验。跨 schema history 迁移也尚未实现。
- MCP server 级实际隔离；当前 pi 没有对应 hook，非空 MCP allowlist 明确 fail-closed。OS 容器/系统级文件与进程沙箱也不在当前实现内。
- lifecycle archive 自身的磁盘 TTL/总容量回收；预算约束下的模型/拓扑优化器；路由 regret/calibration 闭环。

## 模式能力

| 模式 | 当前状态 | 生产执行器 | 说明 |
|---|---|---|---|
| M1 | wired / offline verified | main | 主 agent 直接执行和验收。 |
| M2 | wired / offline + live smoke verified | main_with_subagent | 主 agent 持有实现权，可委派独立研究、测试或 review；重叠写文件会 fail-closed。已验证 provider 406 后跨 provider fallback、文件锁和失败状态可观察。 |
| M3 | implemented / experimental | fallback M2 | fork/compare/prune 有工具能力，自动 A/B 执行与可靠 merge 尚未 release。 |
| M4 | implemented / experimental | fallback M5 | session、队列和消息存在；尚未证明常驻 worker 与长期记忆收益。 |
| M5 | wired / offline verified / live smoke verified | DAG | 有依赖 artifact、并发冲突控制、质量门、review-fix-review、checkpoint、预算/取消边界；已完成一次 2-node Desktop 修复任务烟测。 |
| M6 | implemented / experimental | fallback M5 | 异构执行器尚未纳入统一生产预算和评估门。 |

`src/core/execution-plan.ts` 的 capability manifest 是运行时对应事实；文档与 UI 应消费它，而不是复制一套可用性规则。

## 核心闭环

| 能力 | 状态 | 验证证据 |
|---|---|---|
| 中文/英文任务分类与场景偏好 | wired / offline verified | `test-routing-execution-plan.ts` |
| Agent/共享 Skill/通信模板契约 | wired / offline verified | Agent Markdown `skills` 与 communication frontmatter 已载入；`models.json.sharedSkills` 为规范来源、旧 `agentflux.json` 为兼容回退；直接/并行/team/DAG 一致透传；`test-r0-contracts.ts` 13/13 |
| 路由控制可观测性 | wired with limitation / offline verified | `static_signals` 已真实控制任务信号输入；`budget_aware` 明确显示 `limits_only`，模型/拓扑预算优化器尚未接入；`test-r0-contracts.ts` |
| 显式任务模式 | wired / offline verified | `/flux work --mode M1|M2|M5`、受控宿主 `AGENTFLUX_EXECUTION_MODE` 与 TaskRoutePlan `selectionSource=explicit`；显式选择无需自动路由确认且保留审计 reason。M1–M6 逐项 manifest/执行器/回退契约与 TUI fallback 展示已验证，路由计划 31/31 |
| Task/Run/Decision/Step/Attempt ID | wired / offline verified | `test-telemetry-experience-import.ts` |
| 扁平 telemetry → ExperienceStore | wired / offline verified | no-run guard、旧 schema 兼容、cost/latency/evidence 导入 |
| Quality gate 三态 | wired / offline verified | 11/11；空输出、超时、模型错误、解析错误均为 indeterminate |
| Team review-feedback | wired / offline verified | 12/12；严格 label/schema、实现失败不可被覆盖 |
| SharedBoard 原子认领与文件锁 | wired / offline verified | 31/31；UUID、`wx`、canonical path、owner 隔离、4 进程并发 registry/group/blackboard 无丢更新；runtime 退出收敛为原子 instance-fenced 操作，已有 failed/cancelled 不会被后续 exit 0 覆盖 |
| Message/Delivery V2 | wired / offline verified / experimental live path | 逐成员 Delivery/ack、dedupe、cursor、priority、expiry、lease redelivery、背压；4 进程 40 条并发投递无丢失；身份绑定工具固定 sender/instance/run correlation，且已验证进入 pi `--tools` 白名单；`test-message-v2-cache-impact.ts` 24/24 |
| Persistent RPC inbox pump | wired / offline + live verified / experimental | idle→prompt，busy high/critical/steer→steer，busy normal→follow-up；成功 assistant 边界 ACK；失败/桥断保留 Delivery。name+instanceId 租约、heartbeat、fencing、同名接管与可配置 30s redelivery；`test-rpc-inbox-pump.ts` 15/15。Desktop live 已验证 follow-up/steer ACK、abort cancelled、crash→租约冲突→同名 idle 重投→acknowledged attempts=2 |
| Communication policy/completion gate | wired / offline verified / experimental | 角色模板 actions/targets/消息上限、required handoff、显式 inbox ACK；注册实例持久覆盖与单次运行收窄；缺失契约 exit 76 fail-closed；`message.protocol` 审计。RPC prompt/follow-up/steer/ACK 已 live 验证，required-handoff completion gate 的真实 provider 专项 smoke 尚未执行 |
| 分层 capability policy | wired / offline + live verified / experimental | 角色模板→注册实例 revision 持久覆盖→单次运行只能收窄；tools/skills/通信/workspace、provenance/effective snapshot、`capability.policy` 审计、session capability hash 与 cache-impact 已接线。结构化工具调用产生的空/default shell 现在按“省略”处理，显式 deny-all/disable 才会破坏性收窄；26/26。真实 provider denied-path 工具调用返回 `CAPABILITY_BLOCKED_OK`，扩权在 provider 前 exit 77，2 turns、cost 0。MCP 非空时 fail-closed |
| Cache-impact 提示 | wired / offline verified | tools/skills/MCP/system prompt/model/session 变化统一评估；`/flux restart` 重载角色配置时提示；subagent 会将本次 effective capability 与该 Agent 上次快照比较，角色模板 skill/tool 变化也可观察；`cost_sensitivity<=0.01` 静默；动态消息后缀不误报 cache miss |
| 取消与子进程生命周期 | wired / offline + Windows live smoke verified | 18/18；Windows 取消会同步等待 `taskkill /T` 完成和短暂 handle reap，避免父进程先 close 后后代仍占用 workspace；exit 130、active registry 与 telemetry 可观察。Windows/Linux 长时 soak 仍待完成 |
| Agent/消息/session 回收 | wired / offline + project-state verified | 启动自动 GC、`/flux gc dry-run`/`/flux gc`、TTL/数量上限、活跃运行 fail-closed；除终态外，只自动归档超过独立 TTL 且具备 rpc-runtime role、instanceId、heartbeat 的失联 runtime。无身份 legacy 记录须显式点名，且仍受 TTL、无 PID、活跃 run 阻断与 manifest 审计约束；生命周期测试 21/21。V2 仅归档全接收者终态消息并保留 pending/delivered。2026-07-18 首次正式 GC 归档 16 条失联 runtime；随后显式 legacy dry-run 命中 2 条，正式 GC 归档这 2 条及同时到期的 1 条 fenced runtime，当前 shared registry 非终态为 0 |
| Provider fallback、角色解析与 DAG 熔断 | wired / offline + live verified | `test-dag-contracts.ts` 12/12；DAG planner 不再硬编码 `oa/glm-5.2`，统一遵循 MD→models.json→builtin 角色优先级并解析 provider/thinking。真实 Desktop DeepSeek M5 已验证 Pro planner + Flash 执行路径；熔断后续节点与同节点重试不再回撞失败模型 |
| Provider 额度失败与 M2 收敛 | wired / offline + live failure verified / experimental | 402、余额不足、月额度/usage limit 与普通瞬时 429 分离；额度错误只允许跨 provider 降级，无健康通道立即失败。即使 pi CLI 进程退出 0，只要 assistant event 携带 provider error，run 也会归一化为非零失败，生命周期测试 18/18。2026-07-18 Qwen 月额度 live 返回已验证此缺陷修复前根因；修复后的 provider 专项复测待通道恢复。单次 `flux_subagent` 默认总时限收敛为 180s，失败后禁止无计划重复委派 |
| M1/M2 main-turn 预算 | wired / offline + live verified / experimental | `max_iterations` 与任务墙钟已接到 `turn_start`，允许配置内 provider turns，第一个超额 turn 在请求继续前 abort；主任务排队的二次 user turn 不会提前清空预算。M5 继续使用 DAG 节点/attempt 独立预算。路由计划 31/31；live 已分别观察到 max 5 iterations 和 600s wall-clock 后的 `BLOCKED`/Request aborted |
| Desktop→core 六模式契约 | wired / offline + zero-cost live verified | 独立矩阵 13/13：Desktop 接受 `agent_decides` 与固定 M1/M2/M5，拒绝直接固定实验模式 M3/M4/M6；core 精确解析 M1→main、M2→main_with_subagent、M3→M2、M4→M5、M5→dag、M6→M5。真实 AgentRuntime + pi RPC + Node 24 零成本链路按 AUTO/M1/M2/M5 累计完成 4 轮、16 个独立进程和 48 次 Extension UI response；新增 `test:all-modes-zero-cost` 又以 6 个独立 Desktop runtime 验证 M1/M2/M3/M4/M5/M6 分别进入 M1/M2/M2/M5/M5/M5，共 18 次 response。全部 exit 0、cost 0，并修复固定模式首条通知误显示路由建议模式的问题。M3/M4/M6 的真实 provider 工作负载仍是实验性待验收 |
| Task→child/DAG telemetry 关联 | core + Desktop execution family wired / offline verified | `flux_subagent`、parallel children、DAG planner 与 DAG nodes 把父 `taskId` 写入 `subagent.run`；Desktop Execution Inspector 已按严格 taskId 展示 nested/DAG run、outcome 与 cost，缺失 taskId 时 fail-closed，helper/Workbench 定向 42/42。消息与 artifact 的同族关联仍待完成 |
| Planner JSON 与总时限 | wired / offline verified | Windows 路径/尾逗号保守修复、无 JSON fail-closed；节点时限受 DAG 总 deadline 约束，配置 600s 不再被静默截为 300s |
| 预算 | wired with limitation | attempt/step 间停止；单次 provider 请求可能小额超限 |
| 根工程门 | wired / verified | `npm run typecheck`、`npm run test:unit`、`npm run verify` |

## Desktop 工作台

| 能力 | 状态 | 验证证据 |
|---|---|---|
| 多 runtime 进程与精确 RPC | wired / offline + live verified | 每个 runtime 独立 `pi --mode rpc`；项目 JS CLI 使用真实 Node并预检 `>=22.19.0`，不再由 Electron Node20 启动，也不回退全局 pi。spawn→单次 initial prompt→首个合法 RPC readiness 已接线；race/timeout/早退/invalid JSON/error+exit 去重/exit0无协议均有稳定失败语义。Node24 零成本 live 7 个有效 RPC、exit 0 |
| Control Room 操作面 | wired / offline + live verified | taskId→executionId→lead runId；New Task、`agent_decides`/固定 M1/M2/M5、priority、roster、task thread、attention、Execution Inspector、Steer/Follow-up/Abort/Stop；固定模式只由 main 注入 child env，renderer 无 env/args 通道。当前 nested subagent 尚未完整 task-correlated |
| Electron 双桥兼容 | wired / offline verified | preload 同时保留 21 项 legacy `window.api` 能力和 9 项 `window.agentRuntime` 能力，契约测试 13/13 |
| Extension UI response | wired / offline + live verified / experimental | pi 原生 confirm/select/input request→pending blocked→Workbench response→`extension_ui_response`；类型/选项校验，取消、超时、abort/stop/exit 清理。受控真实 pi RPC smoke 3 次响应 true/beta/smoke-value，blocked↔running 后 done，exit 0、3.547s、未调用模型、cost/token 0 |
| Runtime history 与 Retry | wired / offline + live verified / experimental | schema v1 原子写，最多100 runtime/每条1000 events；failed/aborted/historical 可进入 Inspector，Retry 使用新 ID/PID 并保留 lineage。`sendJson` 已异步等待 write callback，永久监听 stdin stream error，统一产生 `RPC_STDIN_WRITE_FAILED`/`rpc_stdin_error`，失败不伪造 response 且保留 pending。runtime 单测 53/53；事件驱动 live 连续完成 exit23→Retry→confirm→done、cost 0、无 EPIPE。尚缺长时间 soak，故产品成熟度仍为 experimental |
| Capability 权限观察面 | wired / offline verified / experimental | 专用只读 IPC 消费 effective/registered schema v1；展示 tools/skills/MCP/communication/workspace、provenance/narrowed；覆盖区只生成绑定 agent/role/expectedRevision 的 core 命令草稿，不直接写策略 |
| Communication Lanes | wired / offline verified | 无全局 SVG 拓扑和交叉线；同向消息聚合，A→B/B→A 保持方向；Sender/Recipient、可见箭头、count、role/status 和 ARIA 完整。默认 Top 12，任意 scope 先过滤、每次最多 +50、可折叠；group 只作 scope，目录按 scope 计算。64 Agent/55 条方向边与零边均有回归 |
| Desktop 视觉系统第一阶段 | wired / offline + browser verified | 工业 control-plane token、App Shell、共享 Card/Badge/DataTable/Input/Button 已迁移；主导航精简为 8 个工作台入口，移除 Overview/Issue drafts/Settings 重复入口与第二搜索框。Agents 拆成 Roster/Activity/Capabilities，Sessions/共享 DataTable/侧栏完成窄屏收敛；Observe/Advanced 历史页面仍待逐步统一 |
| Control Room 可调布局 | wired / offline verified | window+container双门槛；两条可访问separator支持pointer与Arrow/Home/End；左右联合clamp确保中心最小宽，versioned localStorage持久化与Reset；窄屏纵向且无handle |
| Desktop 自动化门 | verified | 2026-07-18 本轮复跑：Vitest 13 files / 164 tests、Vite production build、Electron compile 全通过；production build 仍提示 dashboard store 静态/动态混用，约 557 kB 主业务包与 569 kB 图表包尚未有效拆分，列为后续性能项 |
| 响应式布局 | browser verified | 自动布局 smoke 覆盖 Control Room、Agents 三视图、Sessions 共 15 个状态；1280×800、1024×720、800×600 均 `scrollWidth=clientWidth`。sidebar 分别约 208/208/168px；共享 DataTable 为窄屏宽表提供局部横向滚动，Agents 不再一次铺开 3212px 分析长页 |
| DeepSeek Desktop provider smoke | live verified / bounded | 隔离 fixture 中 `deepseek-v4-pro` 完成 M1；`deepseek-v4-flash` 完成 M2 并真实调用 flash 子 Agent；M5 由 Pro 主 Agent 调用 `flux_execute_plan`，角色解析后完成 Pro/Flash DAG 且出现 `[DAG Execution: PASSED]`。三个独立 PID 均 exit 0；命令为 `npm run test:desktop-deepseek-live` |
| 真实多 runtime 对话 | live verified / experimental | 项目 pi 0.80.6 + DeepSeek Pro/Flash：唯一名称/PID、Stop、follow-up、steer、abort、crash lease fencing、同名 redelivery/ACK 已有 live 证据；新增隔离 Desktop smoke 验证 M1、M2 子 Agent、M5 PASSED DAG。仍缺长时 soak，不标记 released |
| Desktop CLI/Node 启动诊断 | wired / offline + live verified | 根因修复：Electron Node20 + pi/undici 曾触发 `markAsUncloneable`。现在 main-only 解析 project CLI 与 operator/npm/process/PATH Node，版本低于22.19或缺失时启动前给出稳定错误；snapshot/process_exit/Inspector 展示 CLI/Node source/path/version、readiness/errorCode与stderr。Copy diagnostics白名单并脱敏常见凭据。项目CLI + Node24.11 live exit0、无旧错误 |

## 当前不作出的产品承诺

- 不宣称“六模式都能自动执行”；生产集合是 M1/M2/M5。
- 不把 LLM judge 等同于代码正确；质量必须结合 build/typecheck/test/review/artifact 证据。
- 不把 `withinBudget=false` 的方案称为满足硬预算。
- 不把 `routing.budget_aware=true` 称为模型/拓扑成本最优；当前生产能力只是 attempt/step 间硬边界。
- 不把没有 run/outcome 的路由决策导入为成功经验。
- 不把 Desktop 的静态/估算/部分成本字段称为实时完整事实。
- 不把 Workbench 的 mock/协议测试称为真实 provider 联调；在 live smoke 前只承诺 offline verified。
- 不把 Persistent/RPC inbox pump 扩大表述为所有 subagent 的实时通信；普通一次性 `flux_subagent` 没有常驻 RPC 控制通道，运行中仍依赖主动 poll。
- 不把身份绑定消息工具或 capability tool hook 称为 OS 安全沙箱；前者约束消息身份/动作/目标/数量，后者是 AgentFlux/pi 宿主门禁，均不能替代进程级隔离。

## Release 门

进入 `released` 前至少满足：

1. 30–50 个带 acceptance criteria 的真实任务集，中文/英文均覆盖。
2. M1/M2/M5 在相同约束下各重复至少 3 次，报告均值、方差和失败分布。
3. 实际总成本包含 planner、所有 attempt、fallback、gate、reviewer 和取消前用量。
4. 用户取消后无残留子进程、无继续写文件；Windows/Linux 均做 soak。
5. 路由先以 shadow/suggest 运行，按 constraint violation 与 regret 评估；校准合格后才扩大 auto。
6. Desktop 只展示有 provenance 的真实值，并直接复用 core route/capability contract。

## 下一阶段优先级

1. 在已完成的 nested/DAG run 与 cost Execution family 基础上，继续关联 Message V2 delivery/ACK 与 artifact provenance；关联前不把目录/group membership 伪装成通信或团队执行拓扑。
2. 将 Desktop 假派发与 legacy 消息写入替换为类型化 core operator contract；Message V2 发送必须保留 envelope/delivery/ACK，M5 必须有真实 DAG 启动与状态归因。
3. 增加 multi-select、批量 fan-out、Agent group、任务模板、消息编排和结果汇总；Communication Lanes 增加 task/execution/time-window scope，后续 delivery traffic 图层只能消费真实逐接收者投递事件，极端数量再引入虚拟列表。
4. 继续把 Observe/Advanced 历史页面迁移到统一 token/primitives，补 `prefers-reduced-motion`、窄屏和真实窗口视觉回归。
5. 对 Desktop runtime readiness、Retry、可调布局做长时间 soak；根据真实 provider 首帧分布校准 timeout。packaged app 随附兼容 Node，避免 PATH 依赖。
6. 为 lifecycle archive 增加磁盘 TTL/总容量上限和独立 dry-run；增加 runtime history 跨 schema 迁移与 Windows/Linux 长时 soak。
7. 自动路由 regret/calibration、模型/拓扑优化、OS 沙箱与 MCP server 级隔离后置；当前由用户或主 Agent 选择模式，MCP 非空策略继续 fail-closed。
