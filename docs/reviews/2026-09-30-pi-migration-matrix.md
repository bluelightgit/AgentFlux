# Pi 0.84.1 → 0.99.1：完整迁移决策矩阵

审查开始：2026-09-30（UTC）；终轮门禁与摘要：2026-10-01（UTC）。这是 [初步兼容报告](2026-09-30-pi-compatibility.md) 的扩展，不是已实施修复声明。具体任务、优先级、依赖和验收只维护在 [当前兼容规划](../development-plan/04-pi-compatibility.md)。

后续实施状态（不改写本审查基线）：必需迁移现已开发并取得限定验收，见 [2026-10-01 实施报告](2026-10-01-pi-migration-validation.md)。本文的现状/未实施用语均指审查时的 0.84.1 工作树。

## 结论与范围

**不需要重写 AgentFlux；需要更新 Host 接入适配，并关闭费用、权限和会话语义上的缺口。** 不应因为 Pi 新增能力就为 AgentFlux 再写一套 MCP、codemode、cache warmer、compactor、provider 或 session executor。

本轮覆盖已安装上游的 **11 个发布、363 个 release bullets、29 组迁移决策**。363 包含 `New Features` 与 `Added` 等重复介绍，不是 363 项独立新能力。逐条原文、上游行号和决策映射见 [发布覆盖索引](2026-09-30-pi-release-coverage.md)。这份 changelog 从 0.87.1 跳到 0.99.0，没有 0.88–0.98 的发布标题；不能编造中间版本清单。

| 发布 | 本次覆盖条目数 |
|---|---:|
| 0.84.2 | 45 |
| 0.84.3 | 64 |
| 0.84.4 | 34 |
| 0.85.0 | 35 |
| 0.85.1 | 7 |
| 0.86.0 | 67 |
| 0.86.1 | 8 |
| 0.87.0 | 24 |
| 0.87.1 | 10 |
| 0.99.0 | 65 |
| 0.99.1 | 4 |
| **合计** | **363** |

已核对的现场是 Main/global Pi 0.99.1、项目本地 Pi 0.84.1。隔离新版 typecheck/build/verify、重点回归及无 Provider Host/CLI 探针通过，不等于各项功能已经在新版真实 Provider/交互 TUI 中完成认证。业务源码、依赖/lockfile 和现有 production dist 本轮未改。

## 一、新增能力：复用什么，保留什么

| Pi 原生能力 | 决策 | AgentFlux 不再需要自己实现 | 仍必须由 AgentFlux Core 保留 |
|---|---|---|---|
| MCP stdio/streamable HTTP、OAuth、资源与进程清理 | **按需接入原生，当前保持 fail-closed** | transport、协议客户端、OAuth 刷新、服务器生命周期执行器 | server allowlist、连接前权限、角色/Run 收窄、预算、结果归属和审计 |
| codemode、tool-search、nested `ctx.executeTool()` | **按需接入原生，不另写脚本引擎** | JS 工具编排、BM25 搜索、nested 调度、结构化工具加载 | 哪些工具可调用、Main 控制工具边界、文件锁、Run/Task 费用与失败事实 |
| cost-aware cache warming | **复用原生** | 第二套保活 timer、缓存过期推断与保活请求 | warming 费用归属、预算 gate、无活动 Task 时的策略 |
| structured prompt/tool transcript、append-only context edits | **迁移适配层到原生** | 手写历史替换、prompt/tool 状态重放 | 稳定 AgentFlux protocol、动态任务 suffix、身份及 capability generation |
| compaction、per-model budgets、overflow/length recovery | **继续使用原生** | 自有压缩执行器、阈值触发器、摘要请求及恢复循环 | 只读健康/telemetry、全部尝试费用、最终结果、DAG checkpoint |
| session、tree、fork、in-memory restoration | **继续使用原生** | JSONL 会话执行器、分支投影和会话格式迁移器 | Agent 身份、owner、角色分支、Run、GC fence、Task/Execution 谱系 |
| virtual model routing/state | **路由本身复用原生，继承先明确拒绝或受控加载** | 第二套路由状态机 | 选择模型/实际物理模型 provenance、物理模型权限和父预算 |
| image/classifier operations、原生 auth/model runtime | **可选，不自动变成 Agent 模型** | 图像/分类 transport、凭据刷新、重复 provider registry | operation 权限、实际费用、Task 调用归属；质量门禁仍有自己的评审契约 |
| 同一 Run 的 parallel tool execution、file mutation queue | **使用原生进程内能力** | 同一 Pi 内第二套工具线程池/文件队列 | 跨进程 child 并发、Core 原子状态、文件锁、父预算和 Run Registry |
| TUI 主题、IME、overlay、autocomplete、terminal capability 检测 | **使用公共 UI API** | Editor 原型补丁、终端 renderer、宽度/键码/颜色探测器 | Core 数据到视图的投影、明确命令/intent、AgentFlux 产品文案 |
| provider hooks、原生 `/bug`、安装更新 | **原生用于诊断/安装** | SSE/provider parser、登录器、通用 Pi updater | AgentFlux 构建指纹、Core 故障证据、外部 fresh Pi 监督与发布报告 |

Pi queue 不提供跨 Agent 的 durable delivery/ACK/lease/backpressure；Pi session 不提供 Workflow checkpoint；codemode 并行也不是跨 Agent DAG。这些不能成为删除 Message V2、Task/Execution/Run、Workflow、Issue、权限、预算、锁或 PID 出生保护的理由。QuickJS 脚本机制也不把整个 Host 变成 OS 沙箱。

## 二、逐项迁移矩阵

下列上游路径相对已安装 `@earendil-works/pi-coding-agent`；本地路径相对 AgentFlux。`UP-*` 的完整原文与行号在覆盖索引中。决策是明确实施方向，尚未改代码。

| 编号 | 上游能力/变化与依据 | AgentFlux 当前使用及影响 | 明确解决方案 |
|---|---|---|---|
| **M01 Host/CLI 身份** | 0.84.3 bundled CLI；0.99.0 Host peer 管理。UP-277/042；`package.json`、`dist/config.js`、`dist/core/extensions/loader.js` | `src/agents/agent-runner.ts:476-500` 从自身包解析旧 `dist/cli.js`，还兜底 `argv[1]`；live 脚本硬编码旧入口。**已复现 Main/child 分裂** | 用 Host `getPackageDir()/VERSION`、package `bin` 统一定位；显式 override 也校验 provenance。更新 dev 基线/lockfile，补 coding-agent Host peer，保留 external。不只把一个字符串改成 bundle 路径，不复制第二份 SDK。 |
| **M02 JSON/RPC 事件与字节流** | delta-only `message_update`，顶层累计 `usage`，`toolcall_start.id/toolName`，严格 LF；UP-282/346；`docs/json.md`、`rpc.md`、`dist/modes/json-event.js` | runner 已 LF split、已用 `message_end.message`，**不是旧 cumulative-message 使用者**；但忽略 update usage、EOF 时信任未终止残片、每个 Buffer 单独 `toString()` | 保留 LF 分帧，用 UTF-8 增量 decoder（现有 per-Buffer 模式的 CJK 损坏已纯逻辑复现，非新版才引入）；stream usage 做暂存/预算快照，完整 end 做幂等结算；U+2028/2029 不能当分隔符。未完整 LF frame、坏 JSON/关键事件缺失须留下协议错误/不完整费用证据，不把残片当完整成功。 |
| **M03 全来源费用与计价** | UsageEntry、toolResult/nested、摘要费用、cacheWrite1h、request-wide tiers/Fast/responseModel；UP-029/055/061/064/118/146/290；session/message types、`pi-ai/dist/api/anthropic-messages.js` | Main `entry.ts:710-720`、runner `:1509-1523` 仅计 assistant；`pricing.ts` 已知报价优先按 token 重算。**Pi $0.73 / Core $0.03 且 complete=true 已复现** | 唯一 Core charge adapter 接入原生 entry/message/usage 语义，来源与 request/entry/toolCall/invocation 关联、一次计费；实际 provider/responseModel 归属。区分 Pi 原生估计与用户 override；不能用简单价表覆盖原生 1h/tier/Fast 语义。未知必须不完整；旧终态不回写。 |
| **M04 权限与可调用集合** | PowerShell、exposure、nested pipeline、active ≠ callable；UP-011/255/259；`extensions/types.d.ts`、`dist/core/nested-tool-calls.js` | `capability-policy.ts:431-464` 仅 Bash 危险命令检查；subagent `tool_call` 已执行 allowlist。**PowerShell 条件性绕过已纯函数复现** | 不能安全实施 PowerShell 策略时，在 Provider/命令前拒绝该能力；再补保守检查，不自动授权。Main 五个控制工具与 Agent 消息工具先采用 model-only；nested 仍经过同一 capability/workspace/lock gate，不仅依赖 active tools。 |
| **M05 工具 JSON/结果契约** | JSON-compatible arguments/details，readonly arrays；outputSchema/structuredContent/isError；strict-prefer 默认；UP-011/118/137/169 | `flux_workflow` 的 details 展开 `DAGExecutionResult.taskResults: Map`（`dag-executor.ts:95`、`entry.ts:1008`）；`flux_agent` 失败只返回 `details.ok=false`。前者是**确定的静态契约问题** | 对外投影为稳定 JSON-safe DTO，Map 转 records/arrays；保留 Core 内部 Map。失败/cancel/budget 等结果显式 `isError`，已接受/queued/background 不误标失败。选择接入 codemode 的数据工具才增加 outputSchema/structuredContent；脱敏同步处理两种内容。不全局禁用 strict sampling；terminate 只影响同批后续请求，不代表 Core Task 完成。 |
| **M06 chat 目录与身份** | ModelRuntime 多类型，chat-facing reads 保持 chat；UP-021/022/023；`dist/core/model-runtime.d.ts`、`docs/models.md` | `model-capability.ts:60-115` 固定读 `~/.pi/agent/models.json`、按裸 id 去重、未知 window=200000。**image/classifier 混入已复现** | Host runtime/catalog 提供模型事实；AgentFlux 保留 affinity/capability 与用户价格 overlay。只接受 chat，旧无 type 记录仍按 chat；provider/model/operation 消歧、尊重 agentDir/PI_CODING_AGENT_DIR，不伪造未知 limits。 |
| **M07 virtual 继承** | 原生 per-request router、branch state、physical context/usage；UP-008/013；`docs/virtual-models.md`、`dist/core/virtual-models.d.ts` | Main context 从 `ctx.model` 继承 selector；child `--no-extensions` 不包含 Main 注册的 router，尚未实测完整继承 | 首阶段：显式 Agent/role physical override 优先；否则没有可导入的受控 router 就准确拒绝。后续仅复用原生注册/state，并检查每次路由物理目标的权限/预算。不得静默使用“最后回答模型”或自行复制 router 状态机。 |
| **M08 prompt/context** | structured `systemPromptOptions`、system sections/tools patches、`context_with_system`、canonical SessionManager；UP-080/081/085/091/097/114/170 | `entry.ts:686-708` 每轮返回完整 systemPrompt；prefix-layout 直接改 payload；routing 夹具主要是 FakePi | protocol 只作为结构化稳定 append/section 注入一次；不要每轮强制 leading prompt。动态任务正文/ID/预算留 user suffix/工具事实。普通 context 不承担 prompt/tools；没有需要不接管 context_with_system。恢复/分支用原生会话 API，不赋值 messages 重写历史。 |
| **M09 cache 与 warming** | 原生 cache breakpoints/retention、cost-aware streaming/idle warming、每次 refresh decision；UP-099/112/130/185；`dist/core/cache-warmer.js`、`docs/settings.md` | `prefix-layout.ts:38-65` 删除原有 cache_control 再插一标记；**1h TTL 被替换为无 TTL 已探针复现**。prefixLayout 开关还耦合 child 安全入口/消息/workspace enforcement（runner `:906/1219/1326`） | 先让 subagent-entry/capability/Message V2 的加载独立于缓存开关，再以 native cache 策略为默认；手写 layout 仅显式 provider A/B 策略。复用 warmer，账务/归属未闭合时用 decision stop，不改全局 settings。cache-impact 保留；无调用的 cache-monitor 不应新接成第二账本。 |
| **M10 compaction 与 retry** | per-model reserve/recent、compact_failed、append-only omissions、自动 overflow/length 恢复、60s retry backoff cap；UP-076/096/116/125/162/165/172/243/263 | `compaction-advisor.ts` 只 telemetry，不是压缩器；Core runner 还有进程级重试/fallback | 保留原生 compaction/recovery，advisor 消费 reason/willRetry/failed 事实，不拦截和二次执行。明确 request retry、Pi agent retry、Core 新进程 retry 的不同谱系及计费；不把 backoff/缓存安全窗当执行 deadline，不叠加无界重试。 |
| **M11 settle 与输入 disposition** | `agent_before_settle` 可操作；settled 只有通知、无 outcome，发送新 run 延后；RPC handled 无 run；UP-020/086/087/089 | Main/subentry 依赖 agent_end/settled；RpcInboxPump 的 `pi.sendUserMessage` 接口仍 void。现 runner 是 JSON/print，不是 RpcClient | before_settle 观察本代最新 outcome，settled 才提交 Core/ACK；JSON child 经原生 entry 输出关联本 Run 的收据，缺失不伪造成功。pump 保留实际 user 消费匹配，适配 deferred next run。只有未来 RPC adapter 才消费 disposition；不能给 void API 填假返回值。 |
| **M12 session/tree/fork** | 新 system/context_edit/usage/custom entry、retain-none、替换 session 生命周期；UP-084/088/090/188/207/208/240/316；session-format/sdk | `agent-session-fork.ts` 已原生 fork；`session-fork.ts:42` 取错误 tree 字段，before_fork 还写未登记随机 Agent identity；`agent-store.ts` last-message 扫原始整文件 | 保留 native fork/source hash/owner/generation/fence。tree 使用 preparation.targetId（**旧版已如此**）；最近结果从 active branch 投影，不混废弃分支。取消 before_fork 虚假 Agent lifecycle：只记 context attempt，成功后按正式 Core 身份契约记录；换 session/reload 重绑订阅、丢弃旧 ctx。 |
| **M13 skills/resources 启动** | explicit resource flags、project trust、skill discovery；UP-028/038/056/102/174/204/284/337；`docs/cli.md`、security、skills | runner `:1319-1339` 已禁默认 extensions/context/templates；非空 skill 列表仅 `--skill`，没有 `--no-skills`；`--approve` 还允许项目 Pi settings。不是全部新增问题 | 始终先 no-skills，再只加载有效 allowlist 的 skill；区分 discovery 与 explicit flags。默认继续 no-extensions，只显式加载本包安全入口及已验证原生适配。新版还禁 builtin llama.cpp，继承该 provider 时须受控显式加载，否则准确拒绝，不静默改模型。Main 仅内存注册的普通 custom provider 也需受控加载其实现，目录 snapshot 不会复制执行代码。启动前处理 trust/config 来源，不靠事后的 tool hook 阻止未授权连接。 |
| **M14 原生 MCP 接入** | createMcpExtension/loadConfig、registerMcpServer、OAuth、资源、无 legacy SSE、不自动重试副作用；UP-005/010/027 | `capability-policy.ts:273-275` 目前非空 MCP 直接拒绝，已有 fail-closed 测试 | 当前拒绝保留。若启用：将三层权限相交后的 server/config 交给 createMcpExtension 的 loadConfig，过滤发生在连接前；autoEnableCodemode 明确控制，注册 server 也不能逃过滤波。不写自己的 transport/auth；必需 server 失效准确报错。 |
| **M15 codemode/search** | QuickJS、BM25、store/load custom entries、nested aggregation、prepareLoadout；UP-005/010/011/029/055 | AgentFlux 没有自己的 codemode 引擎。Core Task/DAG/message 不等同于脚本编排 | 可选原生 factory 接入，初阶段明确 `createCodemodeExtension({models:false})`，避免默认 models helpers 绕开 operation 边界；按 capability 固定允许 callable 集，不让隐藏/未 active 工具扩大权限。Core 控制工具初期 model-only；业务数据工具可 structured output。store/load 随 native branch，不用于 Core checkpoint。 |
| **M16 image/classifier** | ModelRuntime typed operations/auth；llama classifier、Jev、image limits；UP-009/017/018/021/022/082/092 | 当前 Agent 都是 chat；没有 image/classifier provider。质量评审由 Core gate/Run 负责 | 不把非 chat 加入角色候选；有明确产品需要再走原生 typed operation，结果 usage 入同一账本。classifier 是标签概率，不自动取代 reviewer/judge 或提出另一任务状态机；直接 helper 调用也必须有费用归属。 |
| **M17 provider instrumentation** | before headers/after response/provider_stream_event、runtime.stream/streamSimple；UP-024/124/296 | 当前没有生产 custom provider/自有 SSE parser；Core health/error classifier 属进程调度层 | 调试复用公共 hooks，记录不含 secret 的关联事实，不自己解析 HTTP/SSE。hooks 不等于新增可收费请求的授权；扩展直接模型调用须上报 usage，不能由 UI 做事实源。 |
| **M18 并发** | executionMode、native file queue、nested siblings。**parallel 默认在 0.84.1 已存在，不是此次改默认** | Main 五个控制工具没有声明 sequential；会读写 currentPlan/session 共用状态；runAgentsParallel 与 DAG 是跨进程并发 | 共用 Core/session 控制工具 sequential；纯读可继续 parallel，文件变更用 native queue 加既有 Core lock。保留 child/DAG maxParallel 和父预算；不重写进程内 executor，也不删跨进程控制。 |
| **M19 shell/file 工具行为** | PowerShell、ctx.cwd 修复、structured shell 1MiB/model-facing 50KB、single edit、signal failure；UP-040/163/212/218/286/338 | Core path/root/lock 策略依赖工具 args/cwd；runner 有 stdout/output 上限及进程树控制 | 执行器复用 Pi；门禁与真实工具必须同一个 cwd、Windows 路径语义及参数归一。结构化大输出只传稳定摘要/文件引用，不扩大 transcript/预算上限；signal 失败保留。Pi shell abort 修复不替代 Core PID birth/child tree 清理。 |
| **M20 TUI/UI 与命令展开** | 公共组件/主题/IME/overlay；mode/hasUI；ui_prompt events；sendUserMessage.expandPromptTemplates；UP-006/015/016/222/228/272/328 | TUI 主要已有 mode guard。autocomplete-bridge 已无原型补丁；`entry.ts:1282` Message 菜单生成 `/flux ...` 却按 literal 发出 | 复用 native UI，不重做编辑器/键码/renderer。仅可信菜单生成的命令显式 expansion 或直接共享 typed Core handler；普通用户正文/Message V2 保持不展开，slash-like 内容不误执行。UI wait 记为等待用户，不加模型硬超时。 |
| **M21 model/thinking 选择行为** | 会话选择不再隐式保存 global；per-turn thinking/physical footer；UP-257/260/281/150 | Main persistentContext 每次读取当前 ctx.model/thinking；角色模板七项显式 Luna，live local profile 单独固定 | 保留 explicit Agent/role 优先，其次本次 Main runtime；不为普通切换写全局 defaults。实际 responseModel/thinking 单独记 provenance。live profile 不随 PI_MODEL 改变；Windows 快捷键文案不硬编码旧 Alt+Enter。 |
| **M22 trust/environment/后台进程** | 项目 .pi trust、资源特例、AI_AGENT/PI_CODING_AGENT、shell session 元数据；UP-027/038/299/334；configuration/security/environment/windows | 子 Pi 当前显式 approve、no-context；env 有 Core 启动策略；Windows package-owned preload 仍有用途 | 核对并收窄配置来源；CLI 与 SDK 标记行为不同，按真实 child session 注入元数据，不泄漏 Main 身份。保留局部 windowsHide preload/detached/birth 检查；不用全局 NODE_OPTIONS，不主动结束 Main，不宣称 OS 隔离。 |
| **M23 auth/catalog/模型默认值** | ChatGPT login 取代 Codex 主推荐、Codex 仅 legacy；新模型/DeepSeek retired aliases；UP-001–004/007/014/035/153/178/197 | 默认真实验证文案仍有 deepseek-v4-flash；角色 explicit gpt-5.6-luna/openai-codex；固定 JSON 发现不是完整目录 | 登录/刷新/凭据优先级交给 native ModelRuntime；auth.json key command 按进程缓存，models.json key command 每请求执行，不混成一个 Core cache。移除 AgentFlux 重复目录/别名猜测；旧 DeepSeek 别名仅经实际目录核验再迁移到 provider-qualified deepseek-flash。Codex 未删除，不能强迁现有角色或会话；新默认模型不推翻显式配置。 |
| **M24 移除/改名 API** | shouldStopAfterTurn→finishTurn；Context→TranscriptContext；GoogleThinkingLevel 改名；experimental/client source-only；UP-083/117/183/199/258 | 生产源码没有旧 options、custom provider 或 client subpath；fork 已用 native API。compiled client import 在 0.99.1 已探针返回 ERR_PACKAGE_PATH_NOT_EXPORTED | 不补不存在的旧执行器。未来 provider 用 TranscriptContext/current prompt/tools；停止决策用 finishTurn 返回 action=end，正常响应谓词遇 error/aborted 保持 undefined；构造 turn_end 用 emitBoundary。保留 root SDK/stdio RPC，禁止新增 compiled experimental client 依赖。usesCallbackServer 仅 deprecated，不当作已移除。user_bash 目前没有自有 handler；无需迁移不存在的 hook，未来仅 return undefined 或合法 operations/result，错误原生 fail-closed。 |
| **M25 queue 与 Message V2** | steer/followUp/clear_queue/input/disposition；UP-020/166/223/232/241/347 | RpcInboxPump 名称不表示它在用 RpcClient；已有 durable Message V2、消费/settled ACK、背压、lease/re投与 stop fence | Pi 负责一 session 的排队/输入顺序，Core 负责跨 Agent delivery。clear_queue 返回移除消息不代表消费成功，不能 ACK；RPC handled 也不是模型完成。继续使用同一 Message V2，不新增消息协议。 |
| **M26 Core/Workflow/Community 职责** | native session、codemode、parallel、bug report 并未提供跨 Run 产品状态机 | Task/Execution/Run、Agent owner、DAG/checkpoint、Issue/Claim、父预算、fence 都已在 Core | 全部保留。原生事件作为 Core 输入证据；恢复/继续/复用/retry 仍新建谱系，不让 native resume 重写历史。原生 `/bug` 不替代构建绑定的故障报告，也不自动上传 Core 私有事实。 |
| **M27 build/release/runtime 要求** | TS7/ES2024/type stripping、bundled/SEA、Host peers；UP-030/042/106/139/277/283 | AgentFlux 自己用 TS5.9/tsx/esbuild，Host external；旧/新 Pi engines **都已是 >=22.19.0** | 不盲从上游改全部开发工具；保留可工作的 toolchain，CI/manifest 说明既有 Node 要求。验证 root SDK/TypeBox/virtual modules Host 身份及 npm package dist 资产；Pi update 仅更新宿主，AgentFlux 重建/fresh 验证仍由外部监督器负责。 |
| **M28 测试与迁移门禁** | 新 Host loader、typed entries、JSON/native lifecycle 不能仅靠旧 FakePi | 六个重点回归和隔离 verify 已过；一些 mocks 未含新 boundary/system/usage；live 默认仍旧 CLI | 更新事件夹具但不放宽断言；同一 resolver 贯穿 live/supervisor。最小→verify→typecheck/build→dist/diff→fresh Provider，再验证费用/ACK/checkpoint/PID/失败。发布索引与版本快照作为升级差异证据，不当作运行认证。 |
| **M29 其他上游修复** | clipboard/IME/Markdown/LaTeX/terminal/rendering/provider transport/安装/catalog 小修复；逐项见索引 | 无对应自有实现，或本来就交给 Pi；没有理由为每个 bullet 增加 AgentFlux 功能 | 直接受益于新版；涉及本产品操作路径的纳入矩阵对应回归，其余无需业务改动。不复制上游 parser/renderer/installer，也不把上游“Fixed”自动记作 AgentFlux 真实验收通过。 |

## 三、需要替换/减少的自有逻辑

这些是迁移方向，不表示本轮已经删除：

1. **替换**包旁旧 CLI/argv 猜测 → Host provenance resolver；全部 live 启动共享入口。
2. **替换** assistant-only 成本、简单计价覆盖 → 原生全来源费用适配与 Core 唯一账本。`cache-monitor.ts` 没有发现调用点；不要为修复而接上线制造第二套统计。
3. **替换**固定 `~/.pi/agent/models.json` 发现 → Host chat runtime/catalog；保留 AgentFlux 的 capability/affinity/显式用户定价 overlay。
4. **替换**每轮 force 整块 systemPrompt → 原生结构化稳定 section；动态任务不进入 system。
5. **解耦后减少** provider payload cache-control 重写 → 原生默认缓存策略；保留可审计、显式 opt-in 的实验策略和 cache-impact 分析。
6. **修正而非重写** compaction advisor → 原生 lifecycle telemetry。它现在只建议，没有自有 compactor 可删除。
7. **修正** telemetry-only fork Agent identity、原文件全分支 last-message 扫描、tree 字段；保留 native fork 与 Core ownership adapter。
8. **不再规划重做** MCP transport/auth、codemode/search engine、cache warmer、session parser/executor、provider/auth/terminal renderer。

不存在的 Editor.prototype patch 不列“删除任务”；默认 parallel 和 tree preparation 字段在 0.84.1 已存在；Node >=22.19.0 也不是此次新增要求。这些是既有边界/缺口，不应伪装成 0.99 引入的 breaking changes。

## 四、几个必须精确处理的契约

### 费用不是简单多加几项

- nested usage 原生自动聚合到父 toolResult；父工具只报告自己的额外用量。不能把每个 nested event 与父 usage 再累计一次。
- AgentFlux tool invocation 已汇总 child Run 成本，不能再包装同额 tool usage 造成父任务二次收费。来源别名/关联须明确，不以金额相同去重。
- raw history 保存所有尝试费用；active context 可以排除失败尝试。**费用读完整账本，展示读当前分支/投影**，不能互相替代。
- fork/resume 携带的旧 entries 是 baseline，不能把 inherited session totals 再收成新 Run 的费用；新增请求与历史费用分开。
- `cacheWrite1h` 是 `cacheWrite` 子集；reasoning 已包含在 output。不能分别相加。
- 异模型 aggregated tool usage 没有可靠每模型分解时，保留原生聚合估计及“不完整归属”，不能套 Main 单价。金额覆盖和模型归属覆盖分开；known aggregate 可以是完整估计，bounded nestedCalls.complete=false 仅表明 trace 截断，不能据此重复计费或丢弃总额。request-wide tiers/Fast/fallback returned model 同理。
- 未知 UsageEntry.kind 仍按普通 usage 处理；未知 currency/price/source 不伪装为已知零价。
- idle warming 在终态 Task 之后发生，不得回写旧终态；先拒绝无合法归属的刷新，后续需要 session overhead 时定义追加式契约。
- 流中使用当前累计 usage 维护 provisional snapshot，end/entry 做一次结算。门禁只能尽早阻止后续动作，不能宣称请求内绝对不会超支。

### settled 不带 outcome，也不是继续边界

`agent_before_settle` 可观察 `outcome: completed|aborted|error` 并返回边界 entries；后续 handler 仍可能要求继续。只在真正 settled 后将本代最近观测与 Core Host 错误合并。`agent_end` 可能出现在重试/恢复之前；exit 0 也可能有 Provider error、未恢复 length 或不完整流。

`terminate:true` 只有同批已完成工具均要求终止时才跳过后续模型请求；不把结果对象本身当成功、不用它提前 ACK/关闭 Core Task。RPC stdin EOF 是 orderly shutdown，不代表任务完成；现有 JSON/print 启动按自身模式验证，不能套 RPC 的输入/退出语义。

新 Host 探针已证明：settled handler 调用 sendUserMessage 时，同步 `agent_start` 增量为 0，通知结束后会有独立新 run。现 pump 不应依赖通知中重入。其 void 注入 API 不能读取 RPC disposition；只有 RPC 命令返回 handled 时，RPC adapter 才应停止等待不存在的 run。

### 控制工具不要因为 codemode 自动变成可编程控制面

真实 0.99.1 SDK 探针列出的现有五个 flux 工具 exposure 均为 direct；native wrapper 的 callable 集合包含它们。原生 model-only 确实从 nested callable 集合移除；inactive codemode 工具仍 callable，但进入 tool_call，包含 parentToolCallId，能在执行前被 hook block。

另一个静态边界是 `createCodemodeExtension` 的 models 默认 true（`dist/extensions/codemode/index.d.ts`）：`models.classify()` 直呼 runtime，不是普通工具 wrapper。初阶段显式 models=false；以后需要分类时，以获授权的固定 wrapper 先做 operation/预算 gate，再调用原生并返回 usage。不声称普通 tool_call allowlist 已约束所有模型 helper。

因此默认先 model-only 保护控制面；未来明确需要脚本调度时，必须复用这些同一工具、同一 Core 权限/谱系，而不是做 codemode 专用调度器。相同 Core 控制状态工具 sequential 是对既有并发问题的收窄，不是指上游这次才开启 parallel。

### MCP 在连接前过滤，不是调用后补救

可使用 `createMcpExtension({ loadConfig })` 提供受控 `LoadedMcpConfig`，不用重写 transport/auth。新探针放置未授权全局 stdio 配置，再以空受控配置加载：loadConfig=1、transport=0，没有执行该命令。但完整真实 MCP/OAuth 尚未验证；该探针也不证明任意第三方注册 server 已经被 Core 过滤。

受控 extension 列表、注册 server 与 autoEnableCodemode 必须共同约束。保留 `--no-extensions` 默认；显式 `-e builtin:*`/factory 按需求和上界装载，不能把全部 Main extensions 随 child 复制。MCP legacy SSE 不支持；接入用 streamable HTTP 或 stdio，不补第二套旧协议。

### 菜单 command 与用户正文不能共用展开策略

原生探针已证明 `sendUserMessage('/compat_cmd')` 默认 literal 会请求模型；加 `expandPromptTemplates:true` 才直接执行命令而不请求模型。`entry.ts:1282` 的 Message 菜单是可信生成命令，应该显式 dispatch。Main Talk、Message V2 和普通正文仍按 literal；不能让消息内容 `/flux ...`、`/skill ...` 意外执行管理动作。

## 五、现有测试映射

| 领域 | 可继续复用的现有测试 | 不能据此外推 |
|---|---|---|
| runner/版本/进程 | `test-agent-lifecycle-new.ts`、`test-process-identity*.ts`、`test-process-start-cleanup.ts`、`test-background-preload.ts` | invocationOverride 成功不证明默认新 CLI 正确；native shell abort 不证明全部孙进程/跨 OS |
| 费用/目录 | `test-pricing.ts`、`test-task-execution.ts`、`test-run-health.ts`、`test-config.ts` | 原 assistant 夹具不覆盖 cache_warm、nested、摘要、tiers、responseModel 或 mixed operation |
| 权限/资源 | `test-capability-policy.ts`、`test-subagent-safety-lifecycle.ts`、`test-cache-impact.ts` | 纯函数 deny 不证明新 Host 的 MCP 启动与完整 codemode 集合安全 |
| session/fork | `test-agent-native-fork.ts`、`test-agent-reference-boundaries.ts`、`test-agent-reference-fence.ts` | 三个 native fork 分支不代表每种新 entry/virtual/recovery 都真实验证 |
| ACK/queue | `test-rpc-inbox-pump.ts`、`test-startup-inbox-ownership.ts`、`test-message-redelivery-evidence.ts` | FakePi settled 测试不等于新 Host 全 recovery/input handled/clear_queue 组合 |
| prompt/cache/TUI | `test-main-agent-routing.ts`、`test-prefix-layout.ts`、`test-tui-core.ts`、`test-commands.ts` | 单纯字符串/layout 通过不证明 native structured prompt/TTL/fork/IME/主题切换 |
| Workflow/Community | `test-dag-contracts.ts`、`test-quality-gate-runner.ts`、`tests/live/test-workflow-requests.ts`、`test-community*.ts` | 原生 codemode/session 不替代 Core checkpoint、Claim 或恢复谱系验收 |
| fresh 发布 | `tests/live/`、外部 dogfood supervisor | 当前旧 CLI 路径与旧 production hash 不构成本轮候选 0.99.1 全功能认证 |

## 六、证据、失败及未验证范围

证据根目录：`.agentflux/test-results/pi-compatibility-2026-09-30/`。

- 最终隔离 Pi 0.99.1 / Host TypeBox 1.3.27 的 verify、独立 typecheck/build 均 exit=0，见 `full-inventory/isolated-gates-current.json` 及三份 current 日志。此前 360s 组合超时仍单独保留，不能改写为成功；本轮 production dist 未重建。
- 初次审查：`host-probe-attempt2.json`、`cost-session-entries-attempt2.json`、`bundled-cli-probe.json`、隔离 build/typecheck/verify/targeted 日志。初次 Host 存储路径错误、360s 组合超时及 summary 初次断言错误保留；后续通过不回写原命令。
- 完整索引：`full-inventory/upstream-release-ledger.json`、`source-before.json`、`package-comparison.json.txt`。原始 changelog SHA256 为 `aed34261920a6d991dcb4b883a640f7dfa61fa7ac0d4d4d026941777b642db98`。
- 新探针：`full-inventory/native-contract-probes.mjs` / `.json` / `native-contract-probes-attempt{1,2}.log`，真实 Pi 0.99.1 SDK 与现有 production Main，确定性 mock response；prefix TTL、compiled client（ESM）、exposure/nested hook、MCP loadConfig、settled defer、command expansion 均通过；per-Buffer UTF-8 损坏另有纯模式复现，不是 spawned runner 证明，**该探针零真实 Provider 请求**。
- 两名只读 reviewer 的原始 finalized responses 与 Core Agent/Run/session 指纹存于 `full-inventory/pi-*-audit.md`、`delegation-evidence.json`；两个 Run completed，配置角色使用 `openai-codex/gpt-5.6-luna/max`，Core 费用合计 `$1.57844428`（估计非账单）。这是有真实 Provider 的审查委派，**不是新版 fresh dist Provider 兼容认证**；本轮不能笼统称所有活动零 Provider 请求。
- Main 已核对 reviewer 的表述：MCP 修订为受控原生接入；warming decision 覆盖两种模式每次刷新；parallel/Node/tree 字段是旧事实；prefix 开关不能直接关掉安全入口；runner 已用完整 message_end，不能误称依赖 cumulative message。

仍未认证：本轮候选依赖升级和实现后的 fresh Main/Agent/planner/worker/judge；真实 nested/compaction/warming 费用；virtual router→child、MCP/OAuth/codemode完整组合；retry/recovery/Message V2 故障组合；人工交互 TUI/IME/主题/Windows闪窗、跨 OS、长时 soak。现有成功证据不覆盖这些范围。

## 上游出处

发布覆盖索引给每条 `UP-*` 的原文、版本、分类与 `CHANGELOG.md` 行号。专题契约对应已安装包的 `docs/{cli,extensions,sdk,session-format,message-types,json,rpc,rpc-commands,models,virtual-models,compaction,settings,mcp,configuration,security,environment-variables,windows,tui,themes,keybindings,packages,custom-provider}.md` 与上述 `dist` 导出/实现。上游源码入口为 [Pi 仓库](https://github.com/earendil-works/pi)；本报告依据现场 0.99.1 指纹，不把网页 main 当相同构建。
