# 26 - 实现状态与测试事实

更新日期：2026-07-30。本文件是当前能力状态的事实源。

> **2026-08-12 决策：Desktop/PiDeck/Electron 已放弃**（host/contracts 层与 desktop/ 载体已移除）。本文中 PiDeck/Electron 的历史记录与测试基线仅作时间线存档，不再代表当前交付物；当前产品面为 Core + TUI。

状态定义：`wired` 表示生产入口可达，`offline verified` 表示确定性回归通过，`live verified` 表示真实 provider 链路通过，`limited` 表示能力可用但边界必须显式说明。

## 本轮结论

2026-08-15 起执行 docs/33 重设计（阶段一至五已完成并提交）：不再有工作方式模式（WorkStyle 体系、flux_team、agent_decides、模式门禁与固定工作方式模板已删除）。执行在 Main Agent 中直接进行或按需派发子代理；workflow 与 community 是可选执行方法。旧 M1–M6、自动路由、experience/sidecar 和重复 Team/Pipeline executor 已从生产 Core 删除，不提供兼容 adapter。

| 能力 | 状态 | 当前契约与证据 |
|---|---|---|
| 无模式执行 | wired / offline + live verified | 普通对话直接执行（隐式计划）；operatingProtocol 无模式文本；工具 schema 不随运行状态增删。 |
| 空间互斥 | wired / offline + live verified | active-context.json 权威互斥；flux_agent run（main/community）、executeDAG（workflow）、claimIssue（community）统一注册；任何非目标空间活跃 Agent 拒绝新空间启动，空间内并行允许；崩溃残留由 pid 存活探测 + 1h TTL 清理；/flux space 展示活跃上下文、workflow/community 列表与最近 Agent 活动时间线。 |
| Workflow | wired / offline + live verified | planner 生成 DAG，校验依赖/环，独立节点并行，带文件锁、质量门、重试、预算和取消；定义保存到 `runtime/workflows.json`，支持 list/show、精确 reuse、modify 新版本、delete 和 Task Registry 关联。 |
| Task history | wired / offline verified | Pi 原生 UUIDv7 作为 sessionId；`.agentflux/runtime/tasks.json` 保存 Task/Execution、operation 与完整父子谱系。Main/TUI 可精确读取历史；continue/reuse/retry/Workflow resume 均创建新的 Task/Execution，父历史保持只读。 |
| Community | wired / offline + live verified / 部分 | Issue、comment、claim、submit、review（pass/rework）、resolve、delete 已接线；resolve 需全部 claim 收敛（reviewed）；Issue Room 时间线（13 类事件）与 next-actions 确定性推导；active claim 阻止关闭；claim 注册/释放 community 空间。提案实体（propose/support/oppose，轻量无状态机）与认领多提案绑定 + 方案总结（plan 可在 submit 细化）；决策理由落档（resolvedReason + 时间线）；停止条件门禁在核心层（连续退回无新反馈达 community_stall_threshold 默认 3 / 预算超支复用 max_cost_per_task / 轮次超限复用 max_iterations），停摆状态人工 resolve/delete 兜底；实链 T11 全链路 + 门禁 + 兜底通过。Proposal/Review/Decision 独立实体与全自动执行器后置。 |
| 统一 Agent | wired / offline + live verified | 单一 Agent 实体取代 ephemeral/persistent 双轨：唯一 id + 可重名 name（重名自动 xxx(1) 后缀）、三种创建路径（默认 assistant 模板 / 角色模板 / 会话树分叉继承源会话记忆）、三层作用域（global/project/session，会话结束清理 session 作用域）、run=指令+超时+last(k)（AgentRunResult.assistantMessages）、stop/retry/delete/gc（保留最新 k 个，默认 10）；busy 拒绝，对话排队由 Message V2 承载。 |
| pi session fork | wired / offline verified / limited | `/flux fork` 使用 pi `ctx.fork` 创建真实单分支，并保留原生会话树；Agent fork 继承源会话文件。一次从 snapshot 并行派生 N 个独立进程尚未实现，不能用 fresh Agent 冒充 fork。 |
| Agent policy | wired / offline verified | 模板→注册实例→单次运行只能收窄；tools/skills/communication/workspace、revision、effective snapshot、telemetry 与 cache generation。MCP 非空 allowlist 因 pi 缺少门禁 hook 而 fail-closed。 |
| Agent 消息 | wired / offline + live verified | Message V2 支持 direct/group、priority、dedupe、delivery/ACK、cursor、lease redelivery、expiry/backpressure。Main 工具与 TUI 均可查看 Main inbox、Poll 与显式 ACK。 |
| 缓存影响 | wired / offline verified | tool/skill/MCP/system/model/session generation 变化提示；成本倾向 `<=0.01` 时静默。任务信封在 input hook 被消费，不进入 session/provider；system prompt 只使用稳定通用协议，不包含 taskId、任务正文或动态预算。 |
| 回收 | wired / offline verified | `/flux gc [dry-run]`（dry-run 只读）；运行中 task 阻止正式 GC；终态 Agent、已读消息、完成的 V2 delivery 和孤儿 session 可归档；Agent 自动 GC 保留最新 k 个（默认 10）。归档容量上限后置。 |
| 进程安全 | wired / offline + live verified | 临时目录隔离、provider 失败归一等失败分类，文件锁冲突、Windows 进程树终止、active registry 条目收敛。锁过期判定带持有者进程存活保护（fs-lock.ts，长写不误偷）、孤儿回收带 pid 存活保护、RpcInboxPump 注入批次 watchdog。不做承诺 OS 沙箱。 |
| TUI | wired / offline + interactive verified | `/flux` 为完整分层 Workbench 菜单：任务、Workflows、Agents、Community、Spaces（空间与时间线）、Messages、Fork、Runtime、Maintenance；打字中会提示 slash 参数候选；尾随空格（空参数）不弹出候选列表（pi 0.84.1 双实例限制，getArgumentCompletions 空参数返回 null）。Enter 仍可提交裸命令进入菜单。`/flux agent` 统一展示 Main、subagent 与执行 Agents。 |

## 本轮测试

`npm run verify` 包含类型检查以及以下确定性测试（23 个测试文件全部纳入 test:unit，2026-08-15 为 548 断言）：

- 无模式执行协议、Task envelope（含畸形输入防御）：12 + 6/6。
- Task Registry：11/11。
- Workflow Registry（含 delete 全版本与运行中拒绝）：10/10。
- Community 状态机（含终态保护与 deleteIssue）：41/41。
- Main Agent 自然任务调度协议、Workflow 版本链、消息群组、稳定提示词、历史任务与重试终态：33/33。
- 统一 Agent 生命周期（三创建路径、重名后缀、GC k 规则、session 清理）：42/42。
- 空间互斥 active-context（跨空间拒绝/同空间并行/崩溃残留清理/claim-resolve 注册释放）：20/20。
- TUI Core（含 footer 通知、信封防御与空间总览菜单）：44/44。
- Lifecycle GC（含 dry-run 无副作用与会话段边界匹配）：11/11。
- Capability policy：29/29。
- Message V2 与 cache impact：32/32。
- Cache impact（成本敏感度抑制）：23/23。
- Agent 子进程安全生命周期：21/21。
- DAG contracts（含质量门 judge 决策与 dagLog sink）：24/24。
- Persistent RPC inbox pump：15/15。
- Pricing：26/26。
- /flux 命令解析与补全（当前契约：message 子命令化、空参数静默、space 命令）：36/36。
- Config 合并：24/24。
- Prefix layout：11/11。
- Workflow summary 渲染：24/24。
- String utils：46/46。
- Task execution 计划：16/16。

当前 `npm run verify` 合计 548/548（2026-08-15），通过后生产构建成功。

`npm run test:live` 在隔离 fixture 中依次验证。四个用户 prompt 只描述任务特征与目标，不包含 AgentFlux、工作方式名称、工具名或调用指令：

- `deepseek-v4-pro`：Direct 精确完成。
- `deepseek-v4-flash`：Main 调用 `flux_team`，真实 child 返回验收标记。
- `deepseek-v4-pro`：Main 调用 `flux_workflow`，DAG 通过。
- `deepseek-v4-pro`：Main 调用 `flux_issue` 完成创建、评论、认领、提交与关闭。

2026-07-18 最终组合结果：Direct 4.7s、Team 186.1s、Workflow 89.9s、Community 119.2s，全部 exit 0；Workflow 额外要求 `[DAG Execution: PASSED]`，Community 额外要求 `resolved`。每条链路使用独立 pi 进程、0.25 美元任务预算、240 秒 Core 墙钟和 300 秒测试进程硬超时；任何非零退出、超时或缺少工具/结果标记都会失败。持久证据写入 `.agentflux/test-results/core-deepseek-latest.json`，fixture 与测试进程均已清理。

Desktop 迁移回归：Vitest 15 files、168/168；Vite production build 与 Electron compile 通过。实际 Electron 窗口在 1280×800、1024×720、800×600 下完成 Workbench、Agents 三视图和 Activity 导航/横向溢出检查；搜索打开并聚焦、刷新完成、最大化/还原同步、历史失败 Toast 为 0。通过 Desktop `New Task` 选择 Direct，使用 `deepseek-v4-flash` 修改并回读受控 workspace fixture，Renderer 状态最终为 `done`，`task.execution` 记录为 `selectedBy=user/workStyle=direct`，证明主链路可从 Desktop 完成一次 AgentFlux 自我迭代。

PiDeck 新工作台回归：AgentFlux 集成测试 14/14、typecheck 与 production build 通过；实际界面验证 Participant 消息 composer、发送反馈与 800×600 无横向溢出。Desktop E2E 使用 `deepseek-v4-pro` 完成 Direct（4.171s），使用 `deepseek-v4-flash` 完成 Team（16.094s）；reviewer/tester 的 started/terminal 状态均收敛，运行中 operator 消息由 reviewer 实际 poll 并 ACK。

2026-07-27 子代理对话入口收口：Participant 详情中的独立 textarea 已删除，改为在当前 Main 会话的中央聊天区打开 child 对话目标。Message V2 历史按 taskId + participant 过滤后适配为现有 ChatMessage，继续复用 `groupToolMessages`、`UserBubble`、`TurnRow` 和 `RichInput`；退出的临时 child 只读，Main 正在运行时不阻断仍存活 child 的独立投递。该切片完成时 PiDeck 全仓确定性测试 189/189、typecheck 与 production build 通过。

同日补充低成本测试档和 Persistent roster：结构化 Team 的 `executionProfile: "low_cost_test"` 会覆盖调用方的高成本模型/思考设置，固定为 `deepseek-v4-flash`、`octopus-completions`、`thinking=off`、最多 6 轮和 12000 input token，并保留更严格的调用方上限；该档强制 `maxRetries=0`。PiDeck Participants 顶部读取 Host snapshot 的 Persistent Agent 注册表，排除 archived，显示真实状态、角色和调用次数，并把有 execution 历史的实例连接到现有统一对话界面。AgentFlux `verify` 与 PiDeck 190/190、typecheck、production build 均通过。

2026-07-22 Workflow/Desktop 故障回归：修复 Desktop 固定 Workflow 创建第二个内部 taskId、planner/node 生命周期未进入同一 execution、`agent_end` 在 provider 自动重试前提前结束任务，以及 Workflow timeout/failed 被 Main 总结覆盖为 success。历史会话加载、会话列表预览/标题和 HTML 导出均会解码 `agentflux-task-v1` 内部任务信封。AgentFlux 全量单元回归通过；PiDeck 目标集成测试 9/9、typecheck 与 production build 通过。

同日真实 Desktop RPC 复测通过：Direct/`deepseek-v4-pro` 4.308 秒，Team/`deepseek-v4-flash` 16.964 秒，Workflow/`deepseek-v4-pro` 247.189 秒。Workflow 得到 `DAG Execution: PASSED`，`dag-planner` 与三个 DAG node 均以外层 Desktop taskId 产生 started/completed lifecycle，且不存在第二个 Workflow execution。

同日 Task history/cache contract 重构：AgentFlux 改用 Pi session header 的 UUIDv7，不再用 session 文件路径作为主标识；Desktop 兼容 envelope 在 `input` 阶段转换成纯用户任务，因此新会话不会落盘协议头。Direct/Team/Workflow/Community 共享 Task Registry 与 new/reuse/resume/continue 语义，但保持模式差异：Direct 使用 Main 上下文，Team 保存成员结构，Workflow 保存 DAG/checkpoint，Community 保存 Issue 关联。相同工作方式、不同 taskId/任务正文的 system prompt 已验证完全一致。

重构后的真实自然任务复测：Direct/Pro 4.861 秒、Team/Flash 29.461 秒、Workflow/Pro 56.898 秒、Community/Pro 129.218 秒，四条链路均 exit 0，Workflow 为 PASSED、Community 为 resolved。额外使用同一个持久 Pi session 连续提交“初始任务”和“继续刚才任务”，Main 第二轮主动以 `action=continue` 调用 `flux_task`，Task Registry 得到两个 task 和有效 parentTaskId；首次仅 list 未激活 continuation 的提示词缺口已在测试中发现并修复。

Desktop envelope 重构后 RPC E2E 再次通过：Direct/Pro 3.474 秒、Team/Flash 17.319 秒、Workflow/Pro 112.275 秒；Team 的 reviewer/tester 和 Workflow 的 planner/三个 node 均保持外层 Desktop taskId，最终任务全部 completed。证明 input hook 剥离协议头没有破坏工作方式选择、工具调用或 Desktop execution 聚合。

2026-07-23 先重新执行 Main 路由 16/16 与 PiDeck 目标测试 10/10，随后完成统一能力门禁并将 Main 路由扩展到 26/26：Direct 拒绝 Agent/Issue/Workflow/Message，Team 拒绝 Workflow/Issue，Workflow 与 Community 互斥，Team 消息能力保留，固定 task 不能通过 `flux_task` 切换工作方式。Core work-style 状态与矩阵测试扩展为 13/13。

同日递进协议与硬门禁完成后再次执行完整 `npm run verify` 和生产构建，全部通过。随后用不包含 AgentFlux、工作方式或工具名的自然任务重新跑 DeepSeek：Direct/Pro 5.553 秒；Team/Flash 104.467 秒并调用 `flux_team`；Workflow/Pro 59.302 秒并得到 `DAG Execution: PASSED`；Community/Pro 285.438 秒并完成 `resolved`。四条链路均 exit 0，证明 Main 仍可在 `agent_decides` 下根据任务理解选择工作方式。

随后完成 Workflow Definition P1：新规划会创建稳定 Workflow ID 和 v1；modify 保留 ID 并递增版本；`id@version` 可读取历史版本；reuse 删除旧 planning cost、跳过 planner 并创建独立 execution；`flux_task reuse` 会从父 task 的 resource 自动解析定义。Core contracts 和 Host snapshot 已暴露最新 Workflow 列表，供 PiDeck 后续 DAG Inspector 使用。

Workflow Definition 的离线回归覆盖定义创建、同 ID 修订、历史版本选择、精确复用跳过 planner、Task Registry 资源关联，以及 Main/TUI 的 list/show/reuse/modify 入口。真实模型复用测试使用同一持久 Pi session：第一轮由 DeepSeek V4 Pro 自然创建并执行 Workflow，第二轮只要求“复用刚才保存的固定流程”，再检查 `workflows.json` 仍只有同一 ID 的 v1，且新 execution 以 `operation=reuse` 关联该定义。Windows 下 Pi CLI 偶尔会在 DAG 已全部通过后未及时退出，测试会把“执行已完成但进程收尾超时”单独记录为 `timedOutAfterExecution`，不会把它混同为 DAG 功能失败。

2026-07-23 最终真实复用结果：同一 session 产生 2 个 Workflow task，第二个 task 成功关联第一个定义的稳定 ID，定义保持 v1，`reusedWithoutRevision=true`，`timedOutAfterExecution=false`。测试期间还修复了两项由严格断言暴露的问题：Pi JSON 流超过 Node 默认缓冲区会导致 `ENOBUFS`；Main 直接调用 `flux_workflow reuse` 而未先调用 `flux_task` 时，Task Registry 需要由运行时补正为 `operation=reuse` 和源任务 lineage。

同日 Workflow modify 真实版本链最终通过：预置 v1 为 1 个读取节点，DeepSeek V4 Pro 根据自然语言选择 `action=modify`，planner 生成 2 节点 v2 并执行通过；第二轮精确复用 v2，磁盘最终只保留同一 Workflow ID 的 v1/v2。严格测试先后发现并修复：planner 把“修改定义”误建模成编辑 `.agentflux` 的业务节点；Main 首次误用 `run` 后重复调用 `modify`；失败补救时 active task 可能把自身写成 parent。现在 modify planner 明确只输出替换后的业务 DAG，每个 task 只允许一次 Workflow execution，active task 不能作为自己的历史来源。

Message V2 控制面同步完成：`flux_message` 增加 `group_create/group_list/group_send`，TUI 增加唯一 Messages 入口管理群组和 Main inbox；一对一消息仍从 Agent 详情进入，避免重复入口。新增非消费式 `peek` 供 UI 展示，真正打开 inbox 才进入 delivered，处理完成后显式 ACK。PiDeck 尚未渲染群组视图，但 Host snapshot 与 group send 契约已经可用。

2026-07-27 PiDeck 五目标闭环完成：Host 增加 Persistent run/wake/retry/stop/archive、群组创建/发送、Community 确定性动作和 GC 命令；snapshot 暴露 Persistent effective capability、稳定 session、cache generation 与缓存影响。Electron 内运行子进程时显式设置 `ELECTRON_RUN_AS_NODE=1`，修复 Desktop 使用 `electron.exe` 启动 Pi CLI 后悬挂；built Host 同时修正 subagent entry 到 `dist/extension/subagent-entry.js`。Workbench 将 Agents、Messages、Community 收敛到 Participants 的三个页签，Stop 在请求未返回时仍可点击，cancelled 可 Retry，新群组会稳定选中，消息在没有选中 task 时使用控制面 task provenance。

最终验证按依赖顺序执行：AgentFlux `npm run verify` 与 production build 通过；PiDeck 194/194、typecheck 与 production build 通过；真实编译版 Electron 使用 `deepseek-v4-flash`、`thinking=off` 完成 37 个断言并保存 5 张真实截图。覆盖立即取消、同一 Persistent session 重试完成、归档移出活跃 roster、真实群组消息持久化、Community issue 从创建到 resolved、GC dry-run/confirm。报告位于 `E:\agent-projects\PiDeck\docs\test-evidence\agentflux-workbench-real-2026-07-27\workbench-real-report.md`。

同日下一阶段运行控制与消息闭环完成：Ephemeral child lifecycle 增加稳定 runId，Host 通过 `.agentflux/runtime/control` 的 run-scoped request 实现跨 Electron/Agent 子进程停止；Team 失败或取消 child 可按角色模板单体重试。PiDeck 增加 Main inbox Poll/ACK、Ephemeral Stop/Retry 项目级 IPC，并把生产 `RpcInboxPump` 接入 Persistent 子进程。真实 Electron 使用 `deepseek-v4-flash`、`thinking=off` 验证 Persistent 实时消息从 pending→delivered→acknowledged、Main inbox 显式 ACK、Persistent 停止/重试/归档、群组、Community 与 GC；54 个断言、7 张真实截图、0 错误。工作台同时完成 360px 默认可调宽度、统一表单/卡片/按钮和 1024×720 覆盖式抽屉。证据位于 `E:\agent-projects\PiDeck\docs\test-evidence\agentflux-runtime-real-2026-07-27\`。

2026-07-29 精确 Team 失败传播完成：Host 直接登记结构化 Team 的父 task 与成员，成功、参数/角色校验异常、普通失败、全部 timeout 和全部 cancellation 均写入 Task Registry 与 `task.execution` 终态。自然 Team 的 child 失败不再被 Main 最终文字覆盖为成功；Pi 会话在 settled 前关闭时，未完成 task 收敛为 cancelled。新增 Host 失败/timeout/cancellation 与 session shutdown 回归后，`npm run verify`、类型检查和 production build 通过。

2026-07-30 Team Ephemeral 独立 Stop/Retry 真实 Electron 回归完成：使用编译后的 PiDeck、真实 `deepseek-v4-flash`、`thinking=off` 和真实 bash 工具调用，从参与者详情点击停止，验证旧 run 与父 task 均从 running 收敛为 cancelled；随后点击重新执行，创建不同 runId，新 run 完成且同名参与者详情自动跟随新实例。修复了 Retry 后详情仍绑定旧 agentId，以及 cancelled 状态误显示启动警告为“失败原因”的问题。目标测试 6/6、typecheck、production build 和真实 Electron 21/21 断言通过，保存 3 张 1440×960 真实截图且无残留 Electron/子代理进程。报告与状态证据位于 `E:\agent-projects\PiDeck\docs\test-evidence\agentflux-ephemeral-control-real-2026-07-29\`。

同日 Workflow Inspector 完成：Host snapshot 新增只读 `workflowRuns`，按 task 精确关联 checkpoint/execution，只暴露 completed/failed、迭代、成本、重试、质量门、criteria 与 artifact 路径，不把完整子代理输出塞进 Desktop。PiDeck 在现有 Execution Inspector 内展示固定 Workflow 版本、DAG 依赖、checkpoint 进度、节点终态、重试次数和质量门反馈，并以稳定 taskId/executionId 支持真实 UI 定位；终态缺失耗时时显示 `0 ms`，不再错误显示“进行中”。AgentFlux `verify` 241/241、PiDeck 全仓 200/200、typecheck 与 production build 通过；真实 Electron 使用 `deepseek-v4-flash`、`thinking=off` 完成 12/12 断言并保存 1 张 1440×960 真实截图。证据位于 `E:\agent-projects\PiDeck\docs\test-evidence\agentflux-workflow-inspector-real-2026-07-30\`。

2026-07-30 全功能审查与回归再次完成。首次 Workflow modify 真实链路暴露质量门重跑沿用同一个 `runId`：不可变 Run Registry 正确拒绝重复登记，随后 DAG 等待循环无法收敛。`dag-executor` 现为每次物理尝试生成唯一 runId，同时保留稳定 node/Agent 身份和 persistent session；modify/reuse 真实版本链复测通过。AgentFlux `npm run verify` 最终为 323/323，production build 通过；Direct/Team/Workflow/Community 真实链路分别约 5.7s、88.7s、61.6s、240.7s，历史 Continue、Workflow reuse 和 modify 均通过。

同轮 PiDeck 全仓 208/208、typecheck 与 production build 通过。真实编译 Electron 的 Direct/Team/Workflow 分别约 12.0s、27.7s、301.4s并全部通过；Team 检查同时发现任务消息页把权威 snapshot delivery 硬编码为 `delivered`，现已按收件人显示 pending/delivered/acknowledged/rejected/expired、尝试次数与时间，并按 envelope ID 去重。工作台将 Persistent 的 Run/Wake 合并为“有任务运行、空输入检查收件箱”，低频模型/工具/技能折叠为配置详情；已解决 Issue 隐藏无效 Claim/Resolve，GC 显示 dry-run 数量。工作台 53/53、Ephemeral Stop/Retry 25/25、Workflow Inspector 12/12 均通过真实 Electron 验证。

## 明确限制与后置范围

- 不再提供 M1–M6 配置读取、映射或 deprecated telemetry。
- `default_work_style=agent_decides` 只允许 Main Agent在明确的四种工作方式中决定，不包含自动分类器。
- Community 当前是可操作的 MVP 状态机，不是后台常驻自治社区；Main Agent仍是 moderator。
- fork 当前是 pi 原生交互式单分支，不支持一次派生 N 个继承同一 snapshot 的并行运行时。
- Persistent Agent 的稳定 session 已实现，但缓存收益需真实长任务 soak 后才可量化。
- Team 的 `resume` 会重新调度 Main 判定仍需要的职责，不会恢复已退出的 Ephemeral 进程；要保留子 Agent 上下文需使用 Persistent Agent。
- `maxTurns` / `maxInputTokens` 能限制失控读取并避免自动重试。结构化 Host 调度可声明基于 workspace 文件与必需文本的完成凭证：正常退出但凭证不满足时以 exit 75 拒绝假成功；工具已完成但模型在最终收尾阶段触发 exit 74，或已经产生非空结果后遇到瞬时 provider 错误时，只有凭证通过才恢复为成功。无输出 provider 失败与普通业务失败不会恢复。凭证目前只覆盖文件事实，不是任意命令或测试结果证明。
- `lockFiles` 对 `edit`/`write` 是运行时硬门禁；`bash` 仍不是文件级沙箱。需要执行审查过的补丁时使用窄角色与 `git apply --check`，不要把它当作通用不可信代码沙箱。
- Community 的 `resume/continue` 恢复 Issue 关联与确定性状态，不启动后台常驻自治循环。
- 预算在 provider 请求边界生效，单次请求可能造成小额越界。
- 自动路由、模型/拓扑成本优化、OS 沙箱、MCP server 级门禁与 archive 容量治理后置。
- Desktop 的主任务链路、Workflow DAG/quality-gate Inspector、历史 task 完整动作与本轮 Agents/Messages/Community 操作已迁移；右侧多页签工作区、可靠的子 Agent 对话和全局视觉收口仍在进行。

## 下一发布门

1. [完成] 修复结构化精确调度命令的失败传播，确保 Host、task、execution 和 UI 不会把失败或超时留成长期 running。
2. [完成] 在真实 Electron 中完成 Team Ephemeral 的独立 Stop/Retry 与状态收敛回归；同名逻辑参与者在 Retry 后跟随最新 run，取消态不显示失败原因。
3. [完成] PiDeck 模式选择器保持现状；Workflow Inspector 已展示 DAG、版本、checkpoint、重试、artifact 与 quality gate。
4. [完成] 历史 task 的 Open、Continue、Reuse、Retry、Workflow Resume 与 lineage 展示。
5. [部分完成] PiDeck 已用 Host 的 Run Registry/Persistent record 驱动运行状态、Stop/Retry/Message 与 Persistent 管理动作，不再从 lifecycle 日志猜测；forked runtime 的统一 roster 和 Host 直接返回统一 `can*` 投影尚未完成。
6. 为 Persistent Agent 补角色模板创建、实例级动态收窄 UI，并执行多轮真实调用、cache generation、Desktop 重启恢复和回收 soak。
7. 将 Community MVP 扩展为 Issue Room 时间线，补 review/decision 与 participant 主动循环，但仍由确定性状态门验证。
8. 重构右侧为可多开的页签工作区：修复 Participants 折叠/激活/二次点击问题，复用 Main `ConversationSurface` 打开多个子 Agent 对话，并以 Host `canMessage` 控制输入能力；页签、时间线和 Composer 与主对话对齐。
9. 统一回归 Direct、Team、Workflow 与 Community 基础能力，并完成深色主题、键盘焦点、1440/1280/1024/800 宽度、安装包实机和无源码仓库验证。真实模型测试默认使用 `deepseek-v4-flash`、最低思考档和简短提示，保存真实截图与事件证据。

## 2026-07-30 Core P0 可靠性闭环

- [已实现] Task/Execution 双层 Registry、不可变终态、continue/resume/retry 父子谱系，以及 Workflow 父 checkpoint 只读派生。
- [已实现] 跨进程事务 JSON 存储、备份与损坏 fail-closed；覆盖 Task、Workflow、Community、Persistent 与 Message V2 关键写路径。
- [已实现] 权威 Run Registry。真实子进程记录 pid、心跳、task/execution、attempt、成本与终态；Stop/Retry、GC 和 Host snapshot 以此为事实源。
- [已实现] Team 父任务总成本预算分配、混合分支异常收敛、单 Agent/Team/Workflow 成本和失败终态写回。
- [已实现] Host 有界快照、任务历史分页、单任务详情，以及保持 v1 行号 cursor 兼容的流式事件分页。
- [已实现] 正式嵌套 `models.json` 定价解析。此前已配置的 `models.<id>.pricing` 被错误忽略，导致真实运行成本显示为 0。
- [已接入 Desktop] PiDeck 已消费 Execution/Run、任务分页和单任务详情；按钮能力由 Renderer 根据 Host Registry 事实做确定性映射，Host 尚未直接返回统一 `can*` 布尔投影。

确定性验证最终为 323 项、production build 与声明生成通过；10,000 条事件分页压力回归通过。真实 Team 使用 `deepseek-v4-flash`、`thinking=off`，48.384 秒、exit 0；父 task/execution 与两个 Ephemeral child 均 completed，父 execution 成本 `$0.004962`。证据位于 `.agentflux/test-results/core-deepseek-latest.json`。

PiDeck 接线后的编译 Electron 主工作台证据位于 `E:\agent-projects\PiDeck\docs\test-evidence\agentflux-runtime-real-2026-07-30\`。该链路覆盖 Persistent 完成、Run Registry 状态、消息 ACK、群组、Community 和 GC；专用 Ephemeral Stop/Retry 也已在 `agentflux-ephemeral-control-real-2026-07-30` 独立通过。

PiDeck 最终确定性回归为 208/208，TypeScript 检查、Electron main/preload compile 与 Vite Renderer production build 均通过。

## 2026-08-08 pi 0.84 兼容修复

pi 0.84.0/0.84.1 更新后 AgentFlux 暴露两个可复现故障，均已修复并验证（本轮未动 PiDeck）：

- [已实现] Community `issues.json` 旧数组格式自动迁移：早期版本顶层数组（仅 id/title/status/priority/created/updated/tags）会触发 `readJsonStore` fail-closed 抛错，阻塞 `/flux` Workbench 菜单。现 `community.ts` 读取时检测旧格式，迁移为 `{ issues: [...] }` 结构（`closed`→`resolved`、priority/tags 拼入 description、时间戳转 ISO），原子写回并保留 `.bak`，与 task-registry v1→v2 兼容一致。真实 TUI 复测菜单正常打开。
- [已实现] pi-tui 双实例修复（外部化）：`build.mjs` 将 `@earendil-works/*` 设为 external，不再内联本地 Editor 类。但 2026-08-08 真实 TUI 行为实验证明：扩展 bundle 的 `import { Editor }` 仍解析到项目 node_modules 副本，与主进程渲染类不同（双实例），bridge 的 prototype patch 不生效。slash 参数补全改为“不打扰”策略：空参数（尾随空格）不返回候选（列表不自动弹出/不长时间挂起），打字中提示保留（`/flux work d` 显示 direct 等候选）；Tab 在参数位置回落到原生文件补全。
- [确认兼容] CLI 参数、扩展事件、`ctx.sessionManager`/`ctx.fork` 在 0.84.1 全部保留；`message_update` delta-only 不影响 AgentFlux（agent-runner 解析 `message_end`）。PiDeck 的 `message_update` 流式修复留待后续任务。

验证：`npm run verify` 全部通过（Community 30/30 含 3 个新迁移测试）、production build 通过、JSON 模式真实链路（扩展加载 + 模型回复）通过。验证脚本：`scripts/verify-flux-menu.mjs`、`scripts/verify-flux-tab-completion.mjs [native]`。
