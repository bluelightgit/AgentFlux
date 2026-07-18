# 27 - Desktop 多 Agent 工作台

> 此版设计已由 [29 - Desktop 多 Agent 工作台重构规划](29-desktop-workbench-plan.md) 取代。

更新日期：2026-07-18。

## 产品定位

Desktop 的第一职责是操作 AgentFlux，而不是重复展示 telemetry 图表。用户应能在一个工作区中启动多个独立 agent runtime、分发任务、继续对话、在运行中纠偏、排队后续任务和取消执行。数据图表保留为观察与复盘能力，但不再是默认入口。

视觉方向采用克制的工业任务控制台：明确的运行状态、紧凑但可扫描的信息密度、强操作层级、少装饰。任何状态与数值都必须有真实来源，不显示 sample agent、假进度或伪实时标签。

2026-07-16 产品优先级调整：近期不以自动模式路由、预测评分或 OS 沙箱作为 Desktop 主线。执行模式由用户固定，或由当前主 Agent 根据项目和任务判断；Desktop 负责把选择、执行、阻塞、人工介入和结果做成可靠的操作闭环。自动路由保留为 Advanced/后续能力，不占默认工作台的信息层级。

界面参考 [Paperclip](https://github.com/paperclipai/paperclip) 的 operator control plane 思路，但不复制其 company/CEO/雇员隐喻。借鉴点是任务中心、Agent roster、threaded activity、属性检查器、待处理事项和随时介入；AgentFlux 保留 workspace、execution mode、主/子 Agent 和 DAG 的自身语义。每个默认页面必须依次回答：正在发生什么、是否需要用户、用户现在能做什么。

### 下一版信息架构决策

[28 - Agent 生命周期与工作方式重构](./28-agent-workstyle-redesign.md) 是下一版 Desktop 的目标语义，当前页面和 schema 尚未完成迁移。目标导航精简为：

1. **Workbench**：创建并操作 Direct、Team、Workflow 任务。
2. **Agents**：只管理角色模板和 Persistent Specialists。
3. **Issues**：创建 Community Issue，并在 Issue Room 中讨论、认领、执行和审查。
4. **Activity**：查看 execution、消息、artifact、成本与 lineage。
5. **Configuration**：配置模型、模板、预算和运行环境。

Ephemeral Subagent 和 forked Agent 是 execution participant，不是长期 roster 条目。New Task 不再要求用户理解 M 编号；旧 M1–M6 只在历史记录和兼容诊断中显示 deprecated 映射。Communication Graph 保留为按需诊断，不再承担默认协作入口；日常工作优先呈现 claim、依赖、阻塞、待审查结果和可执行操作。

迁移顺序必须是 core 兼容字段与 adapter → Desktop 读取新旧 schema → New Task 写入新 schema → 停止创建旧模式配置。当前实现仍以下述“一期对象模型”为准。

### Control Room 一期对象模型

- `taskId`：用户提交的工作目标；包含 title、prompt、priority 和 mode policy。
- `executionId`：一次任务执行；负责状态、成本和重试归因。
- `runId`：具体 pi runtime；一期至少表示 lead/main runtime，不能把尚未关联的 nested subagent 伪装成已聚合。
- `modePolicy`：`agent_decides` 或用户固定 `M1`/`M2`/`M5`。固定模式按任务/进程传入，不能用全局 override 文件影响其他并发任务。

目标 schema 会增加 `workStyle`、participant 的 `agentKind`/`agentOrigin` 以及 `parentAgentId`、`forkPoint`、`contextSnapshotId` lineage。切换前不得只在 renderer 内重命名 `modePolicy`，否则 Retry、history、telemetry 和 core executor 会出现语义分叉。

Control Room 使用三栏：左侧 runtime/Agent roster，中间 task activity/thread，右侧 execution inspector。顶部只有一个主操作 `New Task`；Routing、Telemetry、DAG 配置和低频设置降为 Observe/Advanced。窗口和 Control Room 容器同时满足宽度门槛时，左右栏可通过两个 `separator` 拖拽或键盘 Arrow/Home/End 调宽；宽度使用 versioned localStorage 持久化并可 Reset。左右栏联合 clamp，必须保留中心栏最小宽度；窄屏降级为纵向且不显示无效手柄。

## MVP 运行时契约

每个 Workbench runtime 对应一个独立的 `pi --mode rpc` 子进程；不能在单一进程内用虚拟 `runId` 冒充多个 agent。

启动参数由 Electron main 固定构造：

```text
<electron-node> <projectRoot>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc --approve -e <projectRoot>/src/entry.ts --name <unique-name>
```

- `cwd` 必须是经过验证的绝对 `projectRoot`。
- renderer 只能传 `projectRoot`、显示名称和任务文本，不能传 executable、shell 或任意 CLI 参数。
- `projectRoot/src/entry.ts` 必须存在。
- 默认只使用项目固定位置的 pi JS CLI；受信 operator 可用绝对路径 `AGENTFLUX_PI_CLI` 覆盖。项目 CLI 缺失时 fail-closed，不静默回退 PATH 中可能漂移的全局 `pi`。
- JS CLI 必须由真实 Node runtime 启动，而不是 Electron 内置 Node。解析顺序为受信绝对路径 `AGENTFLUX_NODE_EXECUTABLE`、npm/current 真实 Node、PATH `node`，并在 spawn 前验证 Node `>=22.19.0`；显式 override 无效时 hard fail。Electron 31 内置 Node 20.18 与当前 pi 0.80.6/undici 不兼容，禁止作为正常 fallback。
- Node child 必须清除从 Electron parent 继承的 `ELECTRON_RUN_AS_NODE`。renderer 不能传 CLI、Node executable、env 或任意 args；所有解析仍只发生在 Electron main。
- Desktop 注入 `AGENTFLUX_RPC_INBOX_PUMP=1`、唯一 agent name 和 runtime instance ID；模型环境覆盖必须使用 pi 可解析的 provider-qualified ID。
- 新建空闲 runtime 时 `initialTask` 可省略或为空；实际发送的 Prompt/Steer/Follow-up 必须非空。名称/文本长度上限与控制字符过滤仍是发布前待补安全门。
- Electron main 维护 `Map<runId, RuntimeRecord>`，每条记录持有独立进程、PID、状态、最后活动、有限事件缓冲、stderr 摘要，以及 CLI source/path、Node runtime source/path/version。非零 `process_exit` 必须在 Execution Inspector 暴露这些诊断，不能只显示“进程退出”。

pi RPC 使用 LF 分隔 JSONL；不得使用会把 Unicode 行分隔符当换行的通用 `readline`。协议命令为：

```json
{"id":"request-id","type":"prompt","message":"..."}
{"id":"request-id","type":"steer","message":"..."}
{"id":"request-id","type":"follow_up","message":"..."}
{"id":"request-id","type":"abort"}
```

RPC 不承诺发送独立 `ready` 事件。Desktop readiness 顺序为：子进程已创建并注册 handlers、initial prompt 只发送一次、随后等待首个合法 RPC frame；空 initial prompt 的 idle runtime 以 spawn 成功作为 readiness。非法 JSON、数组、空对象或无有效 `type` 的帧不能计入 readiness。等待前和订阅后都要复查终态以封闭 exit race；timeout、exit-before-ready、spawn error 与 exit 0/no-protocol 都产生稳定 error code，timer/listener 必须清理。

公开操作：

- `list()`：返回所有 runtime 的只读快照。
- `start({ projectRoot, name, initialTask? })`：创建新进程；只有非空 `initialTask` 才发送一次初始任务。
- `prompt(runId, message)`：空闲时继续对话。
- `steer(runId, message)`：运行中纠偏。
- `followUp(runId, message)`：排队后续任务。
- `abort(runId)`：通过 RPC 中止当前 operation，不影响其他 runtime。
- `stop(runId)`：终止指定进程树。
- `shutdownAll()`：窗口/应用退出时清理所有进程。
- `retry(runId)`：只允许 main 根据已知 failed/aborted live 或 historical record 创建全新的 task/execution/run；保留 `retryOfRunId`、`rootRunId`、`retryAttempt`，旧记录不可变且绝不复用旧 PID。通用 start contract 拒绝 renderer 伪造 retry provenance。

Stop 先关闭 RPC stdin，让 pi 执行 `session_shutdown` 并把 SharedBoard 状态落为 done；1.5 秒 grace 超时后才使用 Windows `taskkill /PID <pid> /T /F` 或 POSIX process-group 强杀兜底。关闭一个 runtime 不得影响其他 runtime。

Electron main 将只用于 roster 的 snapshot 与真实 RPC conversation event 分信道推送给 renderer，事件缓冲有大小限制。preload 额外暴露显式、类型安全的 Workbench API，同时保留既有文件/目录/窗口 API；不为工作台新增任意 IPC invoke 通道。

## MVP 信息架构

Workbench 是默认页和侧栏第一项。

1. Runtime roster
   - 名称、状态、PID、模型（有真实事件时）、最后活动。
   - 新建、选择和停止 runtime。
2. Conversation / event stream
   - 区分 user、assistant、tool、system 与错误事件。
   - 自动跟随最新事件，但允许用户回看。
   - 无事件时显示诚实空状态。
3. Task composer
   - 新 runtime：名称 + Initial task。
   - 已选 runtime：Prompt / Steer / Follow-up 三种发送方式。
   - 运行中可 Abort；终态可 Stop/移除。

### Communication Graph 语义

Communication Graph 展示已经发生的通信，而不是把注册目录或群组成员关系伪装成通信拓扑。默认采用可扫描的方向性 Communication Lanes，而不是高数量时必然产生交叉的全局 node-link canvas。

- 每条 lane 明确显示 Sender → Recipient、方向、消息数和双方 role/status；A→B 与 B→A 分开聚合，方向与状态同时进入可见文本和 ARIA，不能只靠颜色或 hover。
- `All Agents` 是系统目录，不是中心节点，也不产生 lane；普通 group membership 只作为 scope filter，不从成员关系推断通信。
- 默认按 observed traffic 展示 Top 12；任何 Agent/group scope 都必须先过滤再限流。展开采用每次最多增加 50 条并可折叠，避免高数量场景一次渲染全部关系。
- 右侧目录必须按当前 scope 计算：group scope 只列组内未发生组内 direct traffic 的成员；Agent scope 只包含当前 Agent 与实际 peers；scope 外 Agent 不得混入。
- 群组消息当前只显示群组消息计数，不推导成员两两通信。只有后续 Delivery 事件能够证明 sender→recipient 时，才可增加可切换的 delivery traffic 图层。
- 当前 direct-message 数据集缺少完整 taskId/executionId/time-window 维度，因此 UI 明示 observed dataset，不伪造任务或时间筛选；后续应从 Message V2/task correlation 补齐。

视觉系统第一阶段已统一全局工业 token、App Shell、共享 Card/Badge/DataTable/Input/Button primitives，并迁移 Control Room 与 Agents 主操作面。历史 Observe/Advanced 页面仍有旧 palette、圆角和间距语法，属于后续迁移范围，不能表述为全 Desktop 已完成统一。

没有 Electron bridge 或没有有效 workspace 时展示 onboarding 并禁用执行控件，不注入演示数据。1024px 使用纵向布局；窗口达到 1280px 且扣除 App Shell 后 Control Room 容器足够宽才进入三栏，均不得产生页面级横向滚动。failed/aborted/historical 记录必须可进入 Inspector；已退出记录禁用 Prompt/Steer/Follow-up/Abort/Stop，只保留安全的 Retry 与 Copy diagnostics。历史 snapshot events 只回灌一次，不得和实时事件重复。

## MVP 测试门

Runtime 单元测试至少验证：

1. spawn 参数准确且 renderer 无法注入 executable/args。
2. 两次 `start` 创建两个独立进程。
3. LF 碎片与多行 JSONL 正确分帧。
4. `prompt`、`steer`、`follow_up` 和 `abort` 字段符合 pi RPC。
5. Abort/Stop 选中 runtime 不影响另一个 runtime。
6. 进程退出后状态与事件可观察。

组件测试至少验证：

1. 无 bridge/无 workspace onboarding。
2. 新建 runtime。
3. Prompt、Steer、Follow-up 和 Abort 操作。
4. roster 选择与真实事件渲染。

发布前必须通过 Desktop 的 Vitest、Vite build、Electron compile，以及 1280/1024/800 布局验收。2026-07-18 本轮复跑为 13 files / 164 tests、production build 与 Electron compile 全通过；根工程另有 Desktop→core 六模式闭集矩阵 13/13。零成本 runtime 测试已证明 AUTO/M1/M2/M5 与 M1–M6 fallback 契约。真实 provider 测试 `test:desktop-deepseek-live` 使用隔离 fixture：DeepSeek Pro 完成 M1，DeepSeek Flash 完成 M2+真实 flash 子 Agent，M5 完成 Pro planner/lead + Flash 节点 DAG 并返回 PASSED，三个独立 Desktop PID 均 exit 0。Communication Lanes 另以 64 Agent、55 条方向关系验证 Top 12、scope-first、增量展开、collapse、零边、group directory、可见方向与 ARIA。

2026-07-16 live smoke 已通过：独立 runtime 唯一名称/PID、Stop Selected、graceful done、normal V2 follow-up、critical steer、abort→cancelled、crash 后同名租约冲突，以及租约到期后的 idle prompt redelivery→acknowledged（attempts=2）。控制恢复 smoke 总耗时 73.082 秒、成本 $0.002016、extension error 0、残留 PID 0。

Extension UI 已实现 confirm/select/input 的 pending request、Workbench 交互卡和原生 response 回写，超时/取消/abort/stop/exit 均会清理。2026-07-16 受控真实 pi RPC smoke 使用项目 CLI + `D:\Nodejs\node.exe` v24.11.1，验证 3 次响应 `true`/`beta`/`smoke-value`、7 个有效 RPC，状态完整经历 blocked/running 并最终 done，exitCode 0、3.105 秒，stderr 无 `markAsUncloneable`；该 smoke 不发送模型 prompt，token/cost 为 0，残留进程为 0。Runtime history 使用 schema v1 原子持久化，最多保留 100 个 runtime、每条 1000 events；恢复记录强制 pid=null、pending 清空、旧在线状态降为 aborted，并标记 historical 只读。missing/ready/corrupt/unsupported 现在均可诊断，损坏或未来 schema 会安全忽略并显示非阻塞提示；跨 schema 迁移仍待完成，DeepSeek M5 DAG live 已补齐。

失败恢复专项 smoke 于 2026-07-18 重新验证：core 已增加 instanceId 绑定与异常进程退出 presence 收敛；`sendJson` 现异步等待 write callback，永久监听 stdin error，并把 EPIPE 归一化为 `RPC_STDIN_WRITE_FAILED`/`rpc_stdin_error`。失败写入不移除 pending、不伪造 response；stop/abort/shutdown 仍执行 best-effort cleanup。runtime 单测 53/53，`test:desktop-retry-zero-cost` 完成 exit23→新 PID Retry→confirm→done，lineage 正确、cost 0、无 EPIPE。Retry 仍需长时间 soak 后再从 experimental 提升。

Workbench 已通过专用只读 IPC 接入 core capability schema v1：选中 Agent 可查看 effective tools/skills/MCP、communication、workspace enforcement、provenance/source layer 和 narrowed。覆盖编辑区只生成绑定 agent/role/expectedRevision 的 `flux_capability_policy set` JSON 草稿并支持复制，不直接改写 override；因此不会绕过 core 的逐层收窄、revision、cache-impact 和 MCP fail-closed。当前尚无受控 set IPC，外部策略变化后需要重新选择或刷新 runtime 才会重读。

2026-07-18 已完成 Desktop telemetry parser 的 `taskId`/扩展 outcome schema与严格 taskId Execution family 聚合器，并接入 Execution Inspector。界面展示 nested/DAG runs、success/failed/cancelled/timeout、成本与最近活动；缺失/空 taskId 时 fail-closed。Workbench/helper 定向测试 42/42。Message V2 与 artifact provenance 尚未并入 family。provider error 即使底层 CLI 退出 0 也会在 core 归一化为失败。

## 后续阶段

### 2026-07-18 真实渲染审计与 UI 收敛门

本轮使用真实 Electron renderer + CDP 布局探针检查 1280×800、1024×720 和 800×600，覆盖 Control Room、Agents Roster/Activity/Capabilities、Sessions 共 15 个状态，均满足 `document.scrollWidth === clientWidth`。已完成：

1. **单一 onboarding**：Control Room 使用紧凑的 workspace-required 面板，明确指向顶部项目选择；已移出主导航的旧页面不再争夺 onboarding 入口。
2. **Sidebar 响应式收敛**：常规宽度约 208px，800px 窗口约 168px并隐藏 note；主标签不再被右侧说明挤压。
3. **Agents 任务化**：主面拆分为 Roster、Activity、Capabilities 三视图，不再一次铺开全部分析组件；Registered Agents 的共享宽表格在窄屏内局部滚动。
4. **通信入口单一语义**：`Agent Channels` 当前顶部标记 `READ-ONLY / EXPERIMENTAL`，同页底部却存在 `Send Message` 表单。未接类型化 operator/Message V2 mutation 前必须删除或明确禁用发送区；接入后则移除 read-only 声明，并把 task-scoped communication composer 放入 Control Room，观察页只保留 traffic/history。
5. **入口精简**：主导航与 Command Palette 统一为 8 个入口；Overview、Issue drafts、Settings 从主信息架构移除，Configuration 成为项目配置入口；顶部只保留一个命令搜索入口。
6. **状态视觉可信**：disabled `New Task`/Send/Export 不得继续使用可执行主按钮的高强调色；read-only、experimental、diagnostics、draft 使用同一 Badge 体系，不能依靠 8–9px 低对比 note 表达关键状态。
7. **空态尺寸合理**：Control Room 无 workspace 时不使用接近整页的空白画布；空态保持紧凑并让 workspace 操作位于首屏。三栏只在有 workspace/bridge 和任务数据时出现。

验收必须包含 DOM 尺寸证据、1280/1024/800 截图、键盘导航、控制台日志以及 no-workspace/empty-data/live-runtime 三种状态；单纯 `scrollWidth` 无溢出不能关闭 UI 任务。

- 在已完成的 taskId→nested/DAG run 与 cost family 上继续聚合消息 delivery/ACK 和 artifact provenance；关联前不得在 UI 伪装成完整团队拓扑。
- 用类型化 operator IPC 替换 legacy Messages 和 Issue draft mutation，Message V2 保留 commit/delivery/ACK；补固定 M2/M5 的 Desktop live。
- 为 capability policy 增加受控 set IPC 和变更订阅；保持 core 为唯一写入/校验入口。
- 支持任务模板、批量分发、agent group 和共享上下文。
- 将 cost、quality gate、artifact 与每个 runtime/task 建立 provenance 链。
- 为 runtime history 增加跨 schema 迁移，并补长时 crash/recovery soak。
- 为名称和消息增加长度上限、控制字符过滤与超大 RPC frame 防护。
- 为 readiness、retry 和 layout 增加更长时间 soak，并继续观察 provider 首帧超过当前 timeout 的真实分布；若需要调整阈值必须保留稳定错误语义。
- 对 RPC stdin `EPIPE` 与 Retry 做更长时间 soak，并采集首帧/退出 race 分布；功能修复与单次 live 已完成。
- 修正 Dashboard store 的静态/动态混合导入，使 production build 真正拆分工作台与观察型图表；当前主业务包约 555 kB、图表包约 569 kB，此项在信息架构和组件收敛后执行，避免提前优化随后被删除的重复页面。
- 为 packaged Desktop 随附受支持的 Node runtime，避免最终用户必须依赖 PATH 或 operator override；明确 Windows `.cmd`/`.bat` native override 语义。
