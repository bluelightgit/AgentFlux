# 26 - 实现状态与发布门

更新日期：2026-07-16。

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
| 显式任务模式 | wired / offline verified | `/flux work --mode M1|M2|M5`、受控宿主 `AGENTFLUX_EXECUTION_MODE` 与 TaskRoutePlan `selectionSource=explicit`；显式选择无需自动路由确认且保留审计 reason。路由计划 17/17 |
| Task/Run/Decision/Step/Attempt ID | wired / offline verified | `test-telemetry-experience-import.ts` |
| 扁平 telemetry → ExperienceStore | wired / offline verified | no-run guard、旧 schema 兼容、cost/latency/evidence 导入 |
| Quality gate 三态 | wired / offline verified | 11/11；空输出、超时、模型错误、解析错误均为 indeterminate |
| Team review-feedback | wired / offline verified | 12/12；严格 label/schema、实现失败不可被覆盖 |
| SharedBoard 原子认领与文件锁 | wired / offline verified | 27/27，连续重复 3 次；UUID、`wx`、canonical path、owner 隔离、4 进程并发 registry/group/blackboard 无丢更新 |
| Message/Delivery V2 | wired / offline verified / experimental live path | 逐成员 Delivery/ack、dedupe、cursor、priority、expiry、lease redelivery、背压；4 进程 40 条并发投递无丢失；身份绑定工具固定 sender/instance/run correlation，且已验证进入 pi `--tools` 白名单；`test-message-v2-cache-impact.ts` 24/24 |
| Persistent RPC inbox pump | wired / offline + live verified / experimental | idle→prompt，busy high/critical/steer→steer，busy normal→follow-up；成功 assistant 边界 ACK；失败/桥断保留 Delivery。name+instanceId 租约、heartbeat、fencing、同名接管与可配置 30s redelivery；`test-rpc-inbox-pump.ts` 15/15。Desktop live 已验证 follow-up/steer ACK、abort cancelled、crash→租约冲突→同名 idle 重投→acknowledged attempts=2 |
| Communication policy/completion gate | wired / offline verified / experimental | 角色模板 actions/targets/消息上限、required handoff、显式 inbox ACK；注册实例持久覆盖与单次运行收窄；缺失契约 exit 76 fail-closed；`message.protocol` 审计。RPC prompt/follow-up/steer/ACK 已 live 验证，required-handoff completion gate 的真实 provider 专项 smoke 尚未执行 |
| 分层 capability policy | wired / offline + live verified / experimental | 角色模板→注册实例 revision 持久覆盖→单次运行只能收窄；tools/skills/通信/workspace、provenance/effective snapshot、`capability.policy` 审计、session capability hash 与 cache-impact 已接线。21/21；真实 provider denied-path 工具调用返回 `CAPABILITY_BLOCKED_OK`，扩权在 provider 前 exit 77，2 turns、cost 0。MCP 非空时 fail-closed |
| Cache-impact 提示 | wired / offline verified | tools/skills/MCP/system prompt/model/session 变化统一评估；`/flux restart` 重载角色配置时提示；`cost_sensitivity<=0.01` 静默；动态消息后缀不误报 cache miss |
| 取消与子进程生命周期 | wired / offline + Windows live smoke verified | 13/13；真实本地父子进程树取消、exit 130、active registry 与 telemetry 可观察；Windows/Linux 长时 soak 仍待完成 |
| 终态 Agent/消息/session 回收 | wired / offline verified | 启动自动 GC、`/flux gc dry-run`/`/flux gc`、TTL/数量上限、活跃运行 fail-closed；V2 仅归档全接收者终态消息，保留 pending/delivered；Retention health 报告 V2 数量/字节；`test-lifecycle-gc.ts` 17/17 |
| Provider fallback 与 DAG 熔断 | wired / offline + live smoke verified | `test-dag-contracts.ts` 11/11；一次真实 OA/GLM 406 已自动降级 DeepSeek，后续节点与同节点重试不再回撞熔断模型 |
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
| Runtime history 与 Retry | wired / offline + live verified / experimental | schema v1 原子写，最多100 runtime/每条1000 events；恢复 pid=null、pending清空、旧在线状态降为aborted。failed/aborted/historical可进入Inspector，main-only Retry创建全新ID/PID并保留lineage；legacy history可从固定CLI祖先安全推断workspace或明确不可重试。历史events只回灌一次。失败→exit23→Retry→4 RPC→done零成本 smoke通过 |
| Capability 权限观察面 | wired / offline verified / experimental | 专用只读 IPC 消费 effective/registered schema v1；展示 tools/skills/MCP/communication/workspace、provenance/narrowed；覆盖区只生成绑定 agent/role/expectedRevision 的 core 命令草稿，不直接写策略 |
| Communication Lanes | wired / offline verified | 无全局 SVG 拓扑和交叉线；同向消息聚合，A→B/B→A 保持方向；Sender/Recipient、可见箭头、count、role/status 和 ARIA 完整。默认 Top 12，任意 scope 先过滤、每次最多 +50、可折叠；group 只作 scope，目录按 scope 计算。64 Agent/55 条方向边与零边均有回归 |
| Desktop 视觉系统第一阶段 | wired / offline + browser verified | 工业 control-plane token、App Shell、共享 Card/Badge/DataTable/Input/Button，以及 Control Room/Agents 主操作面已迁移；Observe/Advanced 历史页面仍待逐步统一，不标记全量完成 |
| Control Room 可调布局 | wired / offline verified | window+container双门槛；两条可访问separator支持pointer与Arrow/Home/End；左右联合clamp确保中心最小宽，versioned localStorage持久化与Reset；窄屏纵向且无handle |
| Desktop 自动化门 | verified | Vitest 13 files / 157 tests、Vite build、Electron compile、diff-check 全通过；runtime/start/preload/Control Room 定向 103/103；既有1024×720、1280×800无横向溢出和控制台错误，新增layout专项覆盖容器门槛/联合clamp/持久化/Reset；临时live文件与残留进程为0 |
| 响应式布局 | browser verified | 1024×768 与 1280×800 无页面级横向/纵向溢出，控制台 0 error / 0 warning |
| 真实多 runtime 对话 | live verified / experimental | 项目 pi 0.80.6 + `octopus-anthropic/deepseek-v4-flash`：唯一名称/PID、Stop Selected、graceful done、normal follow-up、critical steer、abort cancelled、crash lease fencing、同名 idle redelivery/ACK 均通过；控制恢复 smoke 73.082s，input 13789/output 174/cacheRead 13184、$0.002016、extension error 0、残留 PID 0。Extension UI 已独立 live 验证，新 DAG live 尚未验证，不标记 released |
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

1. 将 M2 nested subagent、M5 DAG node、消息、成本与 artifact 关联到既有 taskId→executionId→lead runId 契约；关联前不把目录/group membership 伪装成通信或团队执行拓扑。
2. 将 Desktop 假派发与 legacy 消息写入替换为类型化 core operator contract；Message V2 发送必须保留 envelope/delivery/ACK，M5 必须有真实 DAG 启动与状态归因。
3. 增加 multi-select、批量 fan-out、Agent group、任务模板、消息编排、结果汇总和新 DAG live 执行；Communication Lanes 增加 task/execution/time-window scope，后续 delivery traffic 图层只能消费真实逐接收者投递事件，极端数量再引入虚拟列表。
4. 继续把 Observe/Advanced 历史页面迁移到统一 token/primitives，补 `prefers-reduced-motion`、窄屏和真实窗口视觉回归。
5. 对 Desktop runtime readiness、Retry、可调布局做长时间 soak；根据真实 provider 首帧分布校准 timeout。packaged app 随附兼容 Node，避免 PATH 依赖。
6. 为 lifecycle archive 增加磁盘 TTL/总容量上限和独立 dry-run；增加 runtime history 跨 schema 迁移与 Windows/Linux 长时 soak。
7. 自动路由 regret/calibration、模型/拓扑优化、OS 沙箱与 MCP server 级隔离后置；当前由用户或主 Agent 选择模式，MCP 非空策略继续 fail-closed。
