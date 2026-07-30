# 29 - Desktop 多 Agent 工作台重构规划

更新日期：2026-07-30。本文件是 Desktop 重构的当前规划与进度记录。

当前进度：D0 主任务契约已完成；D1 的导航、任务创建、失败进入/Retry、三栏调整和应用工具栏已完成。Workflow Inspector 与历史任务分页/详情、Open/Continue/Reuse/Retry/Resume 已接线；Participants 的状态和主要操作资格来自 Host Registry 事实。Persistent 生命周期、消息、群组、Community 基础状态机与 GC 已通过 2026-07-30 真实 Electron 主链路。运行时拆分、统一 forked roster、Community 完整 Issue Room 与右侧多页签仍在开发。

## 产品目标

Desktop 从“多页面数据看板”改为“可直接与多个 Agent 沟通和分发任务的工作台”。用户最常做的动作应在一个主界面完成：描述任务、选择工作方式、选择/创建 Agent、观察执行、发送 follow-up/steer、处理阻塞、验收结果。

主导航只保留：

1. **Workbench**：Direct/Team/Workflow 的任务创建与执行控制。
2. **Agents**：角色模板和 Persistent Agents。
3. **Issues**：Community 列表与 Issue Room。
4. **Activity**：跨任务运行、消息、成本和 artifacts。
5. **Configuration**：模型、角色模板、预算和运行环境。

删除或合并 Overview、Chat、独立 DAG、Routing、Groups、重复 Settings 等入口。右侧只保留一个 AgentFlux 工作台入口，内部用 Tasks 与 Agents 两个视图承载历史任务、参与者、直接沟通和管理，不再为相同对象增加独立页面。

所有尚未回收且仍具备交互能力的 Main、Ephemeral、Persistent 与 forked Agent 都进入统一 live roster。短任务 Ephemeral 完成后立即结束可交互身份，但其记录、消息和产物继续保留在所属任务历史中；不得把已经退出的进程显示成仍可对话。Persistent 与仍存活的 forked Agent 可跨任务继续沟通。

## Workbench

采用可调三栏布局：

- 左栏：任务列表、筛选、状态、工作方式。
- 中栏：用户与 Main/child Agents 的统一时间线；消息必须显示发送者、目标、所属 claim/node 和 delivery 状态。
- 右栏：当前参与者、任务/claim、预算、文件范围、验收与运行控制。

Composer 的 Auto、Direct、Team、Workflow、Community 选择器保持当前平级呈现，不再安排层级式 UI 改造。递进能力属于运行时语义，不要求用户先理解继承图。Team 可预选 Persistent Agent 或交给 Main 动态组队；Workflow 选择已有定义、修改新版本或输入目标生成 DAG；Community 跳转/创建 Issue。Advanced 参数折叠，不在首屏堆放模型和拓扑指标。

选择器只影响下一条空闲时发送的 task，并在发送消息的 execution 卡片上冻结显示。Agent 运行期间选择器禁用或标注“下一任务”，steer/follow-up 不改变当前 task；空闲后发送创建新 task，重试默认复用原工作方式，显式 reuse/resume/continue 从任务历史进入。切换提示说明“公共 prompt 前缀保持稳定，工作方式后缀会变化”，不宣称跨方式完整缓存命中。

失败任务仍可进入 Inspector，并提供 Retry；Retry 创建新 execution，保留 parentExecutionId。栏宽可拖动、键盘调整和重置，窄屏改为主内容 + drawer。

同一 Main 会话的所有 AgentFlux task 都从 Task Registry 按 `sessionId` 精确关联并按更新时间倒序显示，而不是只解析最新一条消息。任务列表显示工作方式、状态、时间、真实参与者数量和失败原因；点击后在同一个 Inspector 中查看 Execution、Agents、Messages 与 Artifacts。`Open` 只读查看原任务，`Continue` 继续任务谱系，`Retry` 创建失败执行的后继，`Reuse` 以相同工作方式和资源创建新任务，Workflow 的 `Resume` 从 checkpoint 继续。手动选择历史任务优先于默认最新任务，但不会改变当前 Main 会话或系统提示词。

## Agents 与 Issues

Agents 视图管理三类对象：

- Templates：角色、model、thinking、tools、skills、communication、workspace 上界。
- Persistent Agents：状态、当前任务、session/cache generation、最近消息和持久收窄权限。
- Live Agents：当前项目内尚未回收的 Ephemeral、Persistent 与 forked 实例；按“当前任务 / 当前会话 / 当前项目”切换作用域，显示状态、来源、所属任务、模型、最后活动和是否可对话。

点击 live Agent 在同一右侧工作台中打开对话详情。运行中的 Agent 通过 Message V2 inbox 接收用户或 Main 的 direct message，并显示 pending/delivered/acknowledged；空闲 Persistent Agent 通过稳定 session 被唤醒后继续对话。可用管理动作由 Core 返回的 capability 决定：运行中可 Stop，空闲 Persistent 可 Run/Archive，短任务 Agent 完成后只允许查看历史或基于其上下文 Fork，不提供假的发送入口。Renderer 不根据状态猜测权限。

Main Agent 通过 `flux_agent list/inspect` 获取同一份 live roster，通过 `flux_message` 发送 direct/group message；运行时 inbox pump 注入未读消息，任务完成门检查必要 ACK。Agent 列表和 task id 不写入动态 system prompt，避免模式切换或 roster 变化破坏公共 prompt 缓存。

Issue Room 三栏：左侧 Issue 状态与筛选，中间 comment/claim/submit/review/decision 时间线，右侧 participants、claims、文件范围、预算和 acceptance criteria。自由文本消息不能直接改变 claim/issue 状态。

## Communication Graph

不再用“所有 Agent 连到中心”的全局图作为默认视图。默认展示与当前任务有关的两种关系：

- **职责图**：Agent → Claim/Workflow node。
- **消息 lanes**：A→B 与 B→A 分开聚合，按当前 execution/issue scope 过滤。

只有诊断页才提供全局拓扑，并默认聚类、限制 Top N、支持折叠与缩放。没有真实 message/claim/dependency 证据时不绘制边。

## 实现顺序

### D0：共享契约

- [完成] Renderer 与 Electron 共享 `runtime-contract.ts` 的 WorkStyle/StartOptions。
- [完成] 删除主任务链路的 `modePolicy` 与 M fallback；固定工作方式进入 Core task contract。
- [完成] runtime history 升级为 schema v2，旧数据不迁移。
- [待开发] AgentRecord、Issue、Claim 与 TaskExecutionPlan 的共享读取契约。

### D1：运行时与 Workbench 骨架

- [完成] Direct/Team/Workflow/Community 选择、spawn/readiness、follow-up/steer/abort/stop、失败进入和 Retry lineage；Persistent Agent 支持独立 Stop/Retry。
- [产品决策] 模式选择器保持当前平级形式；只补充“仅下一任务生效”和必要的缓存后缀影响，不改控件结构。
- [完成] 三栏拖动、键盘调整、重置与窄屏单栏布局。
- [完成] 主导航收敛为五个产品入口，不再展示 Chat/Sessions/DAG/Routing 等重复页面。
- [完成] 顶栏搜索/命令面板共享状态，刷新同时更新事件与 runtime；Windows 窗口按钮使用 sender-bound IPC 并同步最大化状态。
- [完成] 通知首次轮询只建立历史基线；相同 Agent、exit code 和 error 的新失败折叠计数，右下角最多同时展示 3 条。
- [部分完成] 任务内参与者与真实消息 lanes 已接入；Electron main 拆分 runtime manager、protocol adapter、history store 尚未收口。

### D2：Agents

- 将 AgentRecord、runtime presence 与 lifecycle event 汇总为一个 canonical live roster，替换仅有 Persistent Agents 的快照字段。
- 统一 AgentFlux 工作台入口：Tasks 与 Agents 两个列表/详情视图；不再保留重复的 Participants、Agent Dashboard 或独立 Chat 入口。
- [部分完成] Persistent roster、运行/唤醒/停止/重试/归档、effective policy、稳定 session、cache generation 与 cache-impact 已完成；模板创建 UI 与动态收窄编辑未完成。
- [完成] 用户和 Main 可列出群组并发送真实 group message，显示 delivery；PiDeck 已提供 Main inbox poll/ACK；运行中的 Persistent Agent 已接生产 RPC inbox pump，成功响应后显式 ACK。
- [部分完成] Ephemeral 生命周期在 execution 中实时收敛；运行中 child 可按 runId 独立停止，Team 失败/取消 child 可单体重试。PiDeck 已从 Run Registry/Persistent record 映射消息与控制资格，不再读取 lifecycle 日志猜测；forked runtime 的 canonical roster 尚未完成。
- 管理动作以 Host Registry 为事实源。当前 Host 未直接返回统一 `canMessage/canStop/canRun/canArchive/canFork` 布尔字段，Renderer 只做集中、确定性的状态映射；后续只有出现第二个消费者或复杂策略时才上收 capability 投影。

### D2.5：会话任务历史

- [完成] 直接使用 Task Registry，以原生 `sessionId` 分页过滤当前 Main 会话，不增加新的历史数据库。
- [完成] 默认选择最新任务；用户选择历史任务后，Inspector、参与者、消息、Workflow 版本和产物全部按该 taskId 精确过滤。
- [完成] 提供只读 Open，以及 Continue、Reuse、Retry 和 Workflow Resume；所有写操作创建明确 lineage，不修改历史任务。
- [完成] 会话重开后无需依赖消息 envelope；没有匹配 task 时保持真实空态，不回退到同项目其他会话的最新任务。

### D3：Workflow 与 Issues

- 读取 Core Host snapshot 的 Workflow 定义、版本和 execution 关联；DAG 以 node/dependency/quality gate/checkpoint 展示在右栏或 Inspector，不再有重复主页面。
- 读取 Host snapshot 的消息群组；在当前 task 的 Team Board 中显示群组成员、消息 lanes 与 pending/delivered/acknowledged，不创建独立全局聊天产品页。
- [部分完成] Community 已接 create/comment/claim/submit/resolve 确定性操作；完整 Issue Room 时间线、review/decision 与 Agent 主动循环未完成。

### D3.5：右侧多页签工作区与子 Agent 对话

本阶段固定排在 Community Issue Room（D3）完成之后、统一视觉与全链路测试之前，不提前穿插开发。

- 修复当前抽屉状态耦合：`panel`、`active`、`collapsed` 和 `visible` 必须分离。“参与者”按钮只负责打开或聚焦对应页签；折叠不再保留错误的激活态，重新打开只需一次点击。
- 将右栏改为可多开的工作区页签。Participants、Files、Browser、Task History、Workflow Inspector、Issue Room 与每个子 Agent 对话均使用稳定 tab id；同一对象重复打开时聚焦已有页签，不重复创建，不同子 Agent 可保留多个对话页签。
- 子 Agent 对话不再替换中央 Main 对话或通过收起右栏完成跳转。抽取并复用 Main 对话的 `ConversationSurface`、消息时间线、输入框和发送状态，不实现第二套聊天页面；中央区域始终保留 Main 对话。
- 子 Agent 是否可输入由 canonical live roster 的 Host capability（如 `canMessage` 与不可用原因）决定，Renderer 不再凭本地 task 状态猜测。运行中或可唤醒的 Agent 可发送；已结束且不可恢复的 Ephemeral Agent 保持只读并显示简短原因。
- 右侧页签栏与 Main 会话页签使用同一高度和基线；消息区顶部、滚动区与底部 Composer 分别对齐。栏宽继续支持拖动、键盘调整和会话级恢复，窄屏使用同一页签模型切换为覆盖层。

完成标准：

1. 从 Participants 打开子 Agent 后，“参与者”按钮状态正确；折叠、展开、关闭均只需一次操作。
2. 运行中的可通信子 Agent 可以输入、发送并看到 delivery/ACK；终态不可通信 Agent 明确只读。
3. 同一子 Agent 重开不会产生重复页签，多个不同子 Agent 对话可以同时保留并切换。
4. Main 与子 Agent 使用同一对话组件和消息渲染规则，视觉和交互不存在两套实现。
5. 切换会话、重开应用和 roster 刷新后，页签不会指向错误 task/agent；失效页签显示真实空态并可关闭。

### D4：Activity 与视觉收口

- 统一 taskId/executionId/agentId/messageId/artifact provenance。
- [部分完成] AgentFlux 工作台已统一 Card、Button、Input、Textarea、Tabs、Badge 和操作区，默认抽屉宽度调整为 360px；1024×720 使用覆盖式抽屉并通过真实截图验证。全应用深色主题、键盘焦点和其他页面组件仍待收口。
- 删除无 provenance 的估算指标和无法驱动决策的图表。

## 代码审查结论与性能风险

2026-07-30 全量测试后没有遗留已知 P0 逻辑错误；本轮已修复 Workflow 重跑复用物理 runId、Desktop delivery 状态硬编码、task detail 登记时序、Community 多 claim 判断和已解决问题仍显示写操作等问题。继续开发应优先处理以下结构性风险：

1. **Desktop Renderer 单体过大**：PiDeck `App.tsx` 约 8.4k 行、`AppParts.tsx` 约 7k 行、全局样式约 19k 行。当前功能可用，但状态、副作用、布局和业务视图集中，增加页签或 Issue Room 时容易出现轮询竞态和重复入口。下一次右侧工作区重构应抽出一个 AgentFlux project controller，以及 Task Inspector、Messages、Workflow、Issue、Agent conversation 各自的视图模块；不得创建第二份 Registry 状态或第二套聊天组件。
2. **Core 复杂度集中**：`entry.ts`、`host/index.ts`、`shared-board.ts`、`dag-executor.ts` 均接近或超过 900 行。现阶段不为拆文件而拆文件；在 canonical roster、Issue Room contract 或新的 snapshot API 进入时，按“事实读取 / 命令写入 / 运行协调”边界拆分，并保持现有导出契约。
3. **快照轮询可能随历史退化**：PiDeck 当前每 750ms 请求事件并刷新 project snapshot。Host 虽把返回历史限制为 200，但任务 JSON 和 Message V2 envelope 仍先完整读取/枚举再截断，且发生在 Electron 主进程。小型项目实测正常；大量历史消息、run 或 task 时可能造成主进程抖动。后续应提供轻量 live snapshot/delta、在存储读取边界执行 limit，并把完整历史改为显式分页，不能只增加 Renderer debounce 掩盖 I/O。
4. **Workflow 可观察性不足**：真实 Workflow 本轮耗时约 301 秒，功能终态正确但接近 360 秒门限。用户在长时间等待时只看到 node 状态，无法区分 provider 等待、工具执行、质量门重试或进程收尾。优先补节点阶段、最近活动、剩余 wall-clock 和具体超时来源，再考虑并发/模型成本优化。
5. **UI 继续采用渐进披露**：中央区域只保留 Main 对话，右侧承载任务、Agent、Workflow、Issue 等次要工作对象；首屏只展示状态、当前工作和主要操作，模型/工具/成本等诊断信息按需展开。消息全局记录和 Community 表单在数据增多后仍会过长，应在页签阶段改为摘要列表与对象详情，而不是增加 Dashboard 或更多平级按钮。

## 风险与隔离

- Core 本轮已断开旧 schema，Desktop 在 D0 完成前会编译或运行失败，这是预期的直接迁移成本，不加兼容层。
- 运行时协议与 React UI 分阶段切换；每阶段用独立 fixture，避免 UI 状态掩盖进程失败。
- Community 主动调度不能只靠 prompt 保证；后续由 runtime 在 Issue 状态变化时注入结构化待办，并用 claim/completion gate 验证行为。
- 视觉重构最后统一，但布局 primitives 在 D1 先确定，避免每个页面各写一套栏位和响应式规则。

## 测试门

- 每阶段：TypeScript、Vitest、Vite build、Electron compile。
- 运行时：启动失败、早退、无协议、follow-up、steer、abort、crash/redelivery、Retry。
- 工作方式：Direct、Team、Workflow、Community 各一条 DeepSeek Pro/Flash 隔离链路。
- 工作方式切换：空闲时切换只影响下一 task；运行中 steer/follow-up 不切换；重试继承原方式；Auto 由 Main Agent 自主选择；每个 execution 显示实际选择者和最终工作方式。
- 能力矩阵：Direct 拒绝 Agent/DAG/Issue，Team 拒绝 DAG/Issue，Workflow 允许 Team+DAG 并拒绝 Issue，Community 允许 Team+Issue 并拒绝 DAG。
- 缓存：相同工作方式的 AgentFlux prompt 保持一致；切换工作方式只改变常量后缀；工具 schema 不随选择器变化。
- 状态：Main/child 的 idle/running/blocked/done/failed/cancelled/archived 与 task 状态一致。
- 历史任务：同一会话 0/1/多任务、跨会话隔离、重开恢复、默认最新、手动查看旧任务、Continue/Reuse/Retry/Resume lineage。
- Agent roster：0/1/64 live Agents、Ephemeral 完成后退出 roster但仍留在历史任务、Persistent 重启后仍可见、fork lineage、GC 后不再出现在 live roster。
- 直接沟通：用户与 Main 分别向 running/blocked/idle Persistent Agent 发消息；验证 pending/delivered/acknowledged、离线唤醒、无效目标拒绝和完成门未读消息处理。
- 右侧工作区：参与者单击开合、折叠与激活态分离、同页签去重、多个子 Agent 对话多开、独立关闭、会话切换与重开恢复。
- 子 Agent 对话：running/blocked/persistent 可通信路径、terminal Ephemeral 只读路径、stale snapshot、发送失败、delivery/redelivery/ACK；输入权限必须与 Host capability 一致。
- 对齐与响应式：1440×900、1280×800、1024×720、800×600 下检查 Main/右侧页签、时间线和 Composer 基线，覆盖浅色/深色、可调栏宽、窄屏覆盖层与键盘焦点。
- UI：1280×800、1024×720、800×600；栏宽拖动/键盘/reset；失败任务进入和 Retry。
- 应用工具栏：搜索打开/聚焦、刷新真实重载、最小化/最大化/关闭 IPC、历史失败不回放与同类折叠。
- Desktop 自我迭代：从 `New Task` 分发受控 workspace 修改，校验文件结果、runtime `done` 和固定工作方式 telemetry。
- Communication：0、少量、64 Agents；只绘制当前 scope 的真实边，检查无全连中心和标签重叠。
- 进程：测试后 fixture 与测试 PID 为 0；不干涉用户正在运行的 Desktop 实例。
- 第九步统一回归使用 `deepseek-v4-flash`、最低思考档和简短测试提示；必须保存真实应用截图、RPC/事件摘要、时间/模型/成本和失败原因，不得用 mock 页面代替真实执行证据。

## 2026-07-30 Host 前置能力

AgentFlux Core/Host 已提供底层事实，PiDeck Renderer 已完成本阶段接线：

- snapshot 新增 Execution、Run 与历史截断元数据；
- task history 支持 offset/limit 分页，单 task detail 精确返回 executions、runs、messages 与 workflow run；
- Run Registry 返回 child 的 pid/心跳/task/execution/attempt/cost/terminal status，可作为 canStop/canRetry/canMessage 的输入；
- event page 保持现有行号 cursor 兼容，Core 内部改为流式有界读取。

PiDeck 已按 Task/Execution/Run Registry 驱动历史、详情、参与者状态和主要操作资格；lifecycle 事件只保留时间线用途。事件轮询会按 `hasMore` 连续取页并把内存上限限制为 10,000 条，实时 project snapshot 对同 ID 对象优先于可能稍旧的 detail。

2026-07-30 的 AgentFlux 323/323、PiDeck 208/208、类型检查与 production build 已通过。编译 Electron 主工作台通过 53 项断言、7 张截图、0 错误；专用 Ephemeral Stop/Retry 通过 25 项断言和 3 张截图；Workflow Inspector 通过 12 项断言。Direct/Team/Workflow 的真实桌面主链路也全部通过。当前主要性能风险不是 Renderer，而是 Workflow 真实执行耗时波动（本轮约 301 秒，接近 360 秒测试上限）；后续应增加节点级阶段进度和超时归因，不用放宽终态断言。
