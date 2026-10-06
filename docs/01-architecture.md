# AgentFlux 项目架构

更新日期：2026-10-02。

## 总体结构

```text
pi Main session
  └─ src/entry.ts
       ├─ flux_task      → Task/Execution Registry
       ├─ flux_agent     → Core Runner → process / in-process SDK driver
       ├─ flux_workflow  → planner → DAG nodes → quality gate
       ├─ flux_issue     → Issue/Claim state machine
       └─ flux_message   → Message V2

Core Registry / atomic JSON stores
  ├─ agents / sessions / capability snapshots
  ├─ tasks / executions / runs / telemetry
  ├─ workflows / checkpoints / artifacts
  ├─ issues / proposals / claims / reviews
  ├─ messages / deliveries / groups
  └─ active-context / locks / control files

pi TUI
  └─ 只呈现 Core 事实并发起命令
```

## 核心原则

1. **Core 是事实源**：Task、Agent、Workflow、Issue、Message、状态和权限都由 Core 返回；TUI 不自己推断。
2. **统一 Agent 身份**：一个 Agent 通过 `roles[]` 承担多个职责，每次 Run 选择一个 role；不为不同职责复制身份。
3. **历史不可变**：继续、复用、恢复和重试创建新的 Task/Execution/Run，并保存父谱系。
4. **稳定协议**：system prompt 和工具 schema 保持稳定；动态任务正文、ID、预算和名册不写入稳定 prompt。
5. **失败关闭**：未知 role、模型、能力、selector、checkpoint、权限或关键 verdict 必须拒绝，不把不确定状态当成功。
6. **预算向下聚合**：并行 Agent/Workflow 节点共享父 Task 的成本、轮次和并发上限；子 Run 可以继续收窄，但不能各自重新获得完整父预算。
7. **时限与健康分离**：模型执行的 wall-clock deadline 是可选的显式约束，不使用固定默认值推导失败；liveness、progress 和疑似停滞/循环属于可观察健康事实，不能自行改写运行终态。

## Agent 与会话

- 作用域：global、project、session；session Agent 按 ownerSessionId 隔离。
- 创建：默认、角色模板、真实 pi 会话 fork。
- 会话：`shared` 复用会话，`fresh` 使用新会话键，`fork` 使用 pi 原生真实分支。fork 先定位可证明的物理源文件，以 SessionManager.forkFrom 创建独立种子，再按 role/capability generation 派生和复用独立分支；不能按 mtime 猜测歧义源，显式 lastSessionId 缺失不得回退旧源，源字节不变。
- 模型解析：单次覆盖 → role/Agent 配置 → Main 当前 model/provider → capability affinity。
- 能力层级：角色模板上界 → 注册实例收窄 → 单次运行继续收窄。
- capability generation 包含 role、prompt、model、provider、thinking、tools、Skills 和 MCP，防止复用不兼容上下文。
- 写密集型并行 Run 可绑定独立 Git worktree/checkout；workspace 绑定、基线、分支和 merge/apply 结果属于 Core Run 事实，不能产生第二套 Agent 身份或执行器。

## Task 请求与收敛

- 普通对话尚未物化时，Workflow 的显式正文成为 Task 正文；已存在父 Task 时，冻结 `workflowRequest` 保存本次正文/action/selector，不覆盖父 Task 身份/需求/谱系，也不重新分配预算。
- Task 准备与执行 invocation 分开：被拒绝的准备不得创建所请求的子谱系或覆盖活动计划；既有任务仍按自身 Main/执行调用收敛。continue/reuse/retry 省略正文时使用选定源 Task，resume 显式正文只允许等值重放。
- Workflow 保存定义与单次输入分离：运行 DAG 的 `invocationTask` 冻结本次正文并传给固定节点，参与 checkpoint fingerprint；resume 使用原执行快照，拒绝输入不一致。定义创建/修订不得持久化此动态字段，改变节点结构仍须 modify。
- 工具调用终态回执按调用 ID 存在同一 TaskExecution 的 `invocationOutcomes`，相同回执幂等、差异重放拒绝。父结果由 Core 规则归并；成功不能覆盖失败。Main 自动 retry 的中间 agent_end 不是终态，最终 agent_settled 后仍须等后台 Agent 收敛。子进程内 Pi 自动重试的后续成功 assistant 可替换此前 assistant 错误，但不能清除 Host 预算、取消、deadline、spawn 或存储错误。
- Main 与子 Run 共用计价来源选择：有效显式 user override 按 token 重算；否则优先保留有限非负的 Pi `usage.cost.total`（含请求级 tier、1h、Fast 等语义），缺失时再用 remote/simple quote 估计，两者都缺失视为未知费用。聚合 tool usage 不套 Main 单价；cacheWrite1h 是 cacheWrite 子集，reasoning 已包含在 output。只有身份/上下文元数据不构成用户零价，显式零价仍有效。Core 的 DAG 返回值、checkpoint 和父回执保留原精度，只在展示层舍入；所有费用均为估计，非供应商账单。
- 唯一 Core usage adapter 以 session/request/entry/toolCall 标识收集 assistant、父 toolResult（已含所有 nested usage）、usage entry、compaction 与 branch summary；重复 source/event 幂等，stream 累计快照为 provisional，完整 message/entry 为结算，不把两个来源相加。baseline 排除 fork/resume 继承的旧 entries；raw 历史已发生费用不因 context omission 消失。未知 usage kind 正常计费。显式关联 invocation 的费用只计一次，不将已有子 Run 回执再当 Main 费用。
- `usage` 保持 Main 口径，`costAccounting` 分开 Main 与 invocation 已知费用并保存来源/归属覆盖。`complete=false` 表示费用事件、价格或回执不完整；已知聚合金额可完整但模型归属不完整，nested trace 截断不等于总额丢失。complete=true 也不证明估计等于账单。终态不回写；没有合法活动归属的 cache warming 必须停止，不能回写已终态 Task；历史补账和 session overhead 另定追加式契约。
- Workflow 定义的活动引用绑定与删除共用 Workflow store fence，锁序为 Workflow→Task；绑定后在 Task 终态前不可改指其他资源，版本保留不得淘汰活动引用。
- quality-gate judge 与 worker/planner 共用 Agent runner、父 Task/Execution、Run Registry 预算与取消机制；每次 judge attempt 是独立 Run，gate 回执关联该 Run，只有明确 pass 才释放节点。模型进程成功与质量 verdict 是不同事实；回执不重复记账，不能把未知/零定价当真实账单。
- checkpoint 采用版本化 schema、规范化 DAG 指纹和产物 hash/结果证明。每个物理执行有独立写 fence；resume 只能读取父 checkpoint 并派生新执行，不原地覆盖。累计恢复成本由 inheritedCostUsd + attemptCostUsd 构成，持久化失败不得伪装成功。

## 子代理执行后端

- `.agentflux/agentflux.json` 的 `subagent_runtime` 是技术后端配置：`process`（兼容默认）与 `sdk`（Main进程内独立AgentSession）。新Run读取并冻结；未知值拒绝，不在运行中切换/默默fallback，不新增工具动作或用户工作模式。
- 两种driver只承担启动/事件/输入/abort/关闭。Task/Execution/Agent/Run、权限、父预算、Message V2、usage/baseline、settled、checkpoint与定向finally仍由同一Core Runner负责。持久/临时会话与backend正交，切换backend不改变capability generation或重收旧费用。
- SDK必须使用可证明属于当前Host的公共facade（SessionManager/ModelRegistry构造身份），通过显式factory注入Run身份、权限、消息和目录，不修改共享process.env/cwd。每会话独立resourceLoader、settings、SessionManager和extension runtime；不加载Main控制入口、发现资源、builtin MCP/codemode或未授权工具/skills。认证/模型服务来自同一Host模块的受控ModelRuntime，不访问私有字段，不把child配置/注册写回Main。
- Run保存backend与SDK逻辑owner（Main PID/birth、Host代、handle/session/attempt），SDK不设置独立child pid；process仍保存真实child PID/birth。owner存活不证明逻辑session可用；仅缺handle/心跳不授权回收。Host死亡可收敛SDK孤儿，未知身份保守保留。旧process记录缺backend按读取默认理解，不回写终态历史。
- SDK成功仍需安全factory追加的同代boundary receipt与agent_settled、队列截止/drain证明；prompt返回不代替Core完成，delivery只有真实消费且成功settled才ACK。先关闭该Run的输入接受，再等待已接收队列/idle，释放timer/subscription和session；新消息保留给合法后续Run，不跨RunACK。
- SDK取消为协作式abort并等待idle/实际结束；dispose返回不证明已结束，不杀Main、不超时伪造终态，也不在旧工作未退出时启动另一backend重复执行。无默认模型deadline，不扩预算；不合作工具可保持stopping及锁/lease。Main崩溃使SDK任务失去内存handle，恢复必须派生新谱系；需独立生存/强制进程终止的场景使用process。
- 生产 Pi package 声明 `dist/extension/host-entry.ts`：保留 TypeScript 经 Pi 公共 loader 的 Host virtual-module 映射取得 SDK facade，再调用唯一业务 bundle `dist/extension/entry.js`；直接 native ESM import 不证明宿主 SDK 身份。业务 SDK 依赖保持 external，包不携带 dev node_modules。本地插件部署按package/资产指纹与实际Host对账，避免仓库dev SDK遮蔽。生效要求fresh Pi或用户重启，不主动结束承载Host。

## Pi Host 适配契约

- Host 公共 `getPackageDir()/VERSION`、package bin 和可验证的 invocation descriptor 是启动依据；不用扩展旁 dev Pi、旧 dist/cli.js 或 SDK caller argv 猜测。若 Node process entry 可由同名package manifest与bin的精确realpath证明为真正Pi入口，则以它的package根核验Main/child，并要求公共SDK模块版本一致；普通SDK caller不能据argv绑定Host。未匹配的入口保留SDK路径，不把本地module VERSION假称为实际CLI版本；错版fail-closed。Node/npm/bundled/SDK使用同版能力，无法证明的standalone/override在spawn/Run登记前拒绝。descriptor/provenance保存实际入口及SDK来源，不持久化凭据或完整环境。
- ModelRuntime 的 typed chat snapshot 是原生模型/认证元数据来源，Core 保留权限、affinity 与 user quote；provider/model/operation 消歧，未知 limits 不伪造。虚拟选择与实际 responseModel/thinking 分开；child 未受控加载 router/provider 实现时准确拒绝，不能把上一物理响应当隐式继承。
- Main Core 控制工具和 Agent Message V2 工具采用固定 model-only exposure，共享当前计划/session 的工具 sequential；DAG/独立 child 的并发仍由 Core 控制。能力检查覆盖实际 nested callable 集，不仅 active declaration；未支持 PowerShell/MCP/typed operation 准确拒绝，不扩大能力。
- 子代理安全入口、消息和 workspace 门禁独立于 cache layout；始终关闭 skills 自动发现后显式加载有效白名单。使用 native normalized prompt 与缓存断点，实验布局不覆盖原生 TTL；不实现第二套 compactor、warmer 或 provider。原生 warming 未有可闭合费用事件归属的路径先安全停止，而不轮询另造账本。
- Extension hook 与 JSON/RPC 事件形态分别适配。stdout 用增量 UTF-8 与严格 LF frame；完整 message_end/entry 是权威，坏帧/残片/缺关键 boundary 保留失败和不完整费用事实。agent_before_settle 记录本代 outcome，agent_settled 仅收敛通知；后续注入可产生独立新代，ACK 不提前。

## 执行空间

- Main 直接执行或协调 Agent。
- Workflow 是固定 DAG 空间，节点支持依赖、并行、文件声明、质量门、重试、预算和 checkpoint。
- Community 是 Issue/Proposal/Claim/Submit/Review/Resolve 状态机。
- `active-context.json` 管理项目级空间互斥；空间内可并行。Main 作为正式 Workflow 节点时必须拥有节点级状态和 lease。

## 消息与运行事实

Message V2 是 Agent 间消息基础设施，提供 direct/group、独立 recipient delivery、priority、dedupe、ACK、reject、expire、lease redelivery 和 backpressure。发送方 Run 用 `senderRunId` 记录；`correlationId` 是目标物理 Run 的投递 fence，不可同时解释为发送方。对 busy Agent 的 steer/follow-up 也必须进入同一路径和有界 pending 队列；Rpc pump 以唯一注入批次的实际 user message 消费为依据，在对应 assistant 成功且 `agent_settled` 后 ACK，不以 agent_start 或 assistant 响应次数猜测消费。失败、崩溃和未消费握手 watchdog 超时保留 delivery 重投；已消费后的模型工作不能被握手 watchdog 补造硬时限。Host 已注入启动正文的消息由原 Host ACK 路径负责，本 Run 的 RPC 不重复接管；新的 Run 没有旧排除表，仍按同一配置 lease 重投。轮询存储失败必须可见、保留 delivery 并可恢复，不以定时器未处理拒绝终止模型；审计异常不能撤销已接受队列。

每个 Run 至少记录 `runId`、`taskId`、`executionId`、`sessionId`、Agent、role、status、phase、health、attempt、model/provider、turns/tokens/costUsd、backend及其物理PID或SDK owner/session、liveness heartbeat、最近语义进展、重复动作证据、有限 `recentEvents`、可选 deadline 和终态时间。运行中事实持续写入 Core，终态汇总不得是第一次出现 usage；最终收敛以 `agent_settled` 为准。

`status` 与 `health` 是两个维度：`status=running` 时可同时标记 healthy、waiting_provider、waiting_tool、waiting_user、quiet、suspected_stall、suspected_loop 或 context_pressure。健康状态只产生持久事实、限频提示和 inspect/steer/stop 入口；新进展必须能够清除告警。heartbeat 只能证明进程存活，不能冒充语义进展；循环判断必须保留规范化动作签名、重复次数和时间窗口，不得仅凭总耗时自动终止。

父 Task 未设置 deadline 时，Agent、planner、Workflow 节点和 judge 不得补造固定硬时限；父级显式 deadline 必须向下继承，子级只能进一步收窄。成本、轮次、并发上限、显式取消和真实进程/provider 失败仍可结束 Run。启动握手、锁等待、消息 lease、网络元数据读取和停止后的进程树清理等基础设施操作继续使用各自有界超时。

## 存储与安全

- JSON/JSONL 写入使用文件锁、临时文件、原子替换和损坏 fail-closed。
- Agent 引用 writer 与删除/GC/session 归档使用 host-wide 同步短临界区 F，先 F 后 store，保留 Workflow→Task 锁序；不跨 await/Provider 等待持锁。Run 注册/终止/reconciliation 参与 F；不改变身份/活动集合的 heartbeat、usage、health 快照只取 Run store 锁。注册引用显式保存稳定 agentId，写入前核对存在性/owner；kind=persistent 和逻辑队员/Claim 署名不构成注册身份。Core Claim name-only 仍为逻辑 actor，工具/CLI 在同一 F 内将可见注册 selector 绑定为 ID；旧 name-only/空 ID 记录作保守引用保护而不回写历史。没有跨项目引用清单时拒绝 global 删除。
- Native fork 在 F 与已验证的 Agent store 锁内创建/登记；普通登记失败仅在证实未提交且目标身份不变时定向删除新分支，不能证实则保留并暴露错误。session 创建/变更/删除须匹配 owner，已知私有 session 的显式文件路径不能绕过 owner。共同 fence 不覆盖旧二进制、外部直接文件写入，也不提供多文件断电原子性。
- 新 Task owner、Run 物理 attempt、active-context 和锁记录保存 Core 出生身份（Windows 创建时间；Linux boot ID/starttime）。仅明确消失或出生身份不同证明原实例退出；权限/查询错误、不支持平台、坏身份和 legacy 活 PID 一律 unknown 并保守保留。出生证据不猜测补写旧历史。Run 的外部出生采集异步进行，在线输出/绝对 deadline 不等待同步系统查询；迟到绑定须匹配仍活跃的 Run/attempt/PID，停止前重新核验本地 ChildProcess 的捕获身份。
- 启动登记失败与正常运行共用监听、usage 和实际退出收敛，不提前释放活 Run/文件保护；启动基础设施错误不可被重试或产物证明转换为成功。发出信号/命令返回成功或宽限期到期都不单独构成退出证明；未知/失败保持 pending，不宣称可用性或全部后代已退出。
- 未发布 PID 的 starting Run、缺失 Task owner 均不能凭心跳超时推导无人存活。出生校验本身不提供重启后跨进程强制停止、完整启动握手或锁抢占 generation-CAS 保证；查询与信号之间不是内核级原子操作。
- Dead-PID orphan recovery 只有在同一 Task/Execution 没有 active sibling Run、且持久化的 Main/Workflow owner 已确认退出后，才可通过 Task Registry 同步 terminalize Run、TaskExecution、Task 和 Agent；Run Registry fence 只覆盖已确认需要父级收敛到 Task-store 写入完成的窗口，因 owner/active-context 存活而 defer 时必须释放，尚未收敛的 fence 不得因容量截断被静默淘汰。
- Run、Task、事件、delivery、dedupe、控制文件和子进程输出必须有容量/保留边界。
- workspace、lockFiles、Git worktree/独立 checkout 和 bash 门禁是 Host 策略，不是操作系统级沙箱。
- Windows 非交互子 Pi 由 package-owned `background-preload.mjs` 在 CLI 前默认隐藏 Node 子进程窗口，尊重显式交互选项，不修改 Main 或全局环境；保留 detached 与定向进程树清理。该兼容层不是窗口隔离，不能保证任意程序/原生孙进程不创建 GUI。
- production 入口是 `dist/extension/entry.js`，子代理入口是 `dist/extension/subagent-entry.js`。

## 模块边界

- `src/entry.ts`：pi 生命周期、工具、命令和 Main 状态。
- `src/agents/`：Agent、角色、会话、运行和子进程。
- `src/workflows/`：DAG、planner、checkpoint 和质量门。
- `src/core/`：Task、Community、Message V2、权限、成本、锁和回收。
- `src/extension/`：TUI、补全、通知和 RPC pump。

任何新功能必须先说明属于哪个模块、使用哪个事实源、如何保持谱系和权限边界，再进入当前开发规划。
