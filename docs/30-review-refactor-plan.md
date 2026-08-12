# 30 · 代码评审与改造计划（2026-08-11）

本文件记录 2026-08-11 对 AgentFlux 的全面代码评审结论与后续改造计划。评审由主 Agent 亲读核心文件（json-store、task-registry、capability-policy、communication-policy、lifecycle-gc、mask、compaction-advisor、workflow-registry、community、quality-gate、dag-executor、persistent-agent、agent-runner、task-envelope 等），并与三个并行子代理对 agents / workflows / extension / desktop 模块的深挖结果交叉验证。

**执行状态标记**：`[待实施]` = 已确认改造项，尚未开始；`[已决策·暂缓]` = 方向已定，明确暂不实施；`[待拍板]` = 需要用户确认处置方式。每个功能实施时必须按 AGENTS.md 固定流程闭环（确定性测试 → 真实链路 → 证据文档）。

---

## 一、已确认改造项

### 1. GC 会话匹配修复（lifecycle-gc.ts）`[已实施 2026-08-12]` — 高优先级

**问题**（评审确认，比子串匹配更隐蔽）：

- `includesAgentSession` 只匹配 `flux-<name>` 前缀；而 Persistent Agent 的会话文件名是 `persistent-<name>-cap-<hash>`（persistent-agent.ts 的 `sessionId: "persistent-<name>"` → agent-runner.ts 拼接 `-cap-<generation>`），**永远匹配不上归属**。
- 后果：活跃但超过 `orphan_session_ttl_hours`（默认 168h）未调用的 persistent 会话，既进不了 protectedNames 也进不了 belongsToRemoved，只能靠孤儿 TTL 兜底 → **静默归档、会话历史丢失**。
- 次生问题：`belongsToRemoved` 分支无条件归档（不看 TTL），依赖 protectedNames 兜底，缺少主动活跃度筛选。

**决策方案**（与用户确认，保留模糊删除风格）：

1. 保留按 name 的模糊批量删除（一个 name 一次匹配该 agent 全部 generation 会话，不枚举文件）。
2. 匹配规则改为**段边界**：同时认 `flux-<name>-cap-` 与 `persistent-<name>-cap-` 两种前缀；name 后必须紧跟 `-cap-`，避免 `dev` 误匹配 `dev-frontend` 的会话。
3. `belongsToRemoved` 分支增加非活跃筛选：与孤儿分支同门槛（mtime 超过 `orphan_session_ttl_hours`）才归档；活跃会话双保险。

**回归测试**：`dev` 不匹配 `dev-frontend` 会话；`persistent-` 前缀会话被 protectedNames 保护；被移除 agent 的会话需 TTL 过期才归档；dry-run 无副作用。

**实施（2026-08-12）**：`includesAgentSession` 改为段边界匹配（`flux-<name>-cap-` 与 `persistent-<name>-cap-` 双前缀，name 后必须紧跟 `-cap-`）；会话归档统一 TTL 门槛（`expired` 才入候选，removed 分支不再无条件，removedNames 计算随之移除）；active-reviewer 双会话、dev/dev-frontend 不误伤、removed agent 新鲜/过期会话、flux- 孤儿归档共 6 条新回归，tests/test-lifecycle-gc-new.ts 11/11 通过。

### 2. Community 终态保护（community.ts）`[已实施 2026-08-12]` — 高优先级（用户已确认添加）

**问题**：`claimIssue` / `submitClaim` / `commentOnIssue` 对已 `resolved` 的 issue 无终态守卫——claim 会把终态改回 `executing`，与 Task Registry 的不可变终态（`Historical task is immutable`）不一致。2026-08-12 真实链路测试完整复现（issue-49461c72：resolved 后 comment 无拒绝、claim 将状态打回 executing），证据见 docs/31 问题 1。

**方案**：与 Task Registry 同款终态守卫：resolved 后 claim / submit / comment 一律抛错，状态不回滚。补终态回归测试。

**实施（2026-08-12）**：新增 `assertMutable(issue)` 终态守卫，`claimIssue` / `submitClaim` / `commentOnIssue` / `resolveIssue` 在变更前校验，resolved 后一律抛 `Issue is already resolved and immutable: <id>`；新增 4 条终态回归测试（claim/comment/submit/resolve 后操作均拒绝），tests/test-community.ts 34/34 通过。

### 3. mask 策略处置（mask.ts / entry.ts / docs/06）`[已移除 2026-08-11]`

**现状事实**（评审确认）：

- entry.ts:361 在 `context` 事件中调用 `applyMask(event.messages, config, null)`，contextPercent 恒为 `null` → `shouldMask(null)` 恒 false → **永不触发**（接线但被短路）。
- docs/06 已实证三个问题：① 只对 toolResult 生效，纯 prompt 会话从不激活；② 单次 prefix 破坏代价不免费——cacheRead 折扣高的模型（deepseek-v4-flash 22.2%）上破坏代价超过节省；③ 1M 窗口下 85% 阈值需 ~850K token，几乎不触发。

**决策（用户 2026-08-11 确认）**：**直接移除**。已删除 `src/extension/mask.ts`、`tests/test-mask.ts`、entry.ts 的 import/context handler、types.ts 的 `mask_strategy`/`mask_keep_last_n` 字段、compaction-advisor 的 suggest_mask 分支；docs/06/07/10 相关条目已改写为移除记录（实证教训保留在 docs/06）。若未来出现 cacheRead 折扣低的模型，按 event-driven + batch-applied + model-aware 重新设计，不恢复旧实现。

### 4. 小项修复清单 `[待实施/待排期]`

| 项 | 位置 | 说明 | 优先级 |
|---|---|---|---|
| envelope 解析防御 | task-envelope.ts / entry.ts:366,374 | `parseAgentFluxTaskEnvelope` 无 try/catch；用户消息以 `agentflux-task-v1:` 开头但格式无效会抛异常，捕获后降级为普通消息。**`已实施 2026-08-12`**：entry.ts 新增 safeParseEnvelope 防御包装（parse 保持 fail-closed 语义），input/before_agent_start 畸形信封降级为普通消息；新增回归测试 | 中 |
| GC dry-run 副作用 | lifecycle-gc.ts | `reconcileStaleAgentRuns` 在 dryRun 下也执行（有写副作用），改为仅正式运行。**`已实施 2026-08-12`**：dry-run 跳过 reconcile（只读预览），新增 runs.json 不被修改的回归测试 | 中 |
| quality-gate 超时传递 | dag-executor.ts:756 | `checkQualityGate` 未传 `timeoutMs`（固定 30s），按节点剩余时间传递；`已实锤 2026-08-12`（judge 超时→indeterminate→节点重试 2 次→DAG 失败，任务本体实际成功），且需独立 judge 配置 + indeterminate 不触发节点重试，见 docs/31 问题 2。**`已实施 2026-08-12`**：DAGExecutorOptions 新增 `qualityGate` 配置（model/provider/timeoutMs），FluxConfig 新增 `quality_gate` 字段；judge 超时按节点剩余时间（15-90s 区间）传递；新增 `judgeAction` 纯函数决策（indeterminate→重试 judge 最多 2 次，仍失败则降级放行并显式标注；仅 criteria 明确不满足才重试节点）；tests/test-dag-contracts.ts 新增 3 条决策测试，23/23 通过 | 高 |
| requiredSendTo 语义统一 | communication-policy.ts vs capability-policy.ts | `resolveCommunicationPolicy`（整体替换）与 `narrowCommunication`（并集）语义不一致。**`已实施 2026-08-12`**：resolve 改为 union 合并（要求只增不减，下层不得移除上层要求，与 narrow 一致），新增 union 回归测试 | 低 |
| workflow-registry 版本累积 | workflow-registry.ts | 修订无限追加无清理策略 | 低 |
| TUI 无效补丁清理 | extension/tui-autocomplete-bridge.ts | 原型补丁对两个独立 pi-tui Editor 类实例无效，仅留返回 null 规避 | 低 |
| 内置角色模板中文化 | agents/templates.ts | planner/developer/reviewer/tester 的 systemPrompt 为英文，与中文协作约定不一致 | 低 |
| 仓库杂物清理 | 根目录 | stderr.log、188 字节 nul 文件、tmp/、workflow-output/、已提交 dist/ 的保留策略 | 低 |

### 5. TUI 通知改造（entry.ts notify）`[已实施 2026-08-12]` — 中优先级

**现状事实**（源码定位 + pi 源码确认）：

- pi 的 `ctx.ui.notify` 实现（interactive-mode.js showExtensionNotify）：info→showStatus / warning→showWarning / error→showError，三种都向 chatContainer（聊天流末尾，紧贴输入区上方）追加一行 Text；**多行文本折行成一大块堆在输入区上方**，视觉上覆盖输入区。
- AgentFlux 的 notify 把多行长文本直接塞入：`formatDAGResult`（多行，entry.ts:749/757）、`formatTaskExecutionPlan` 全文（755/938/939）、`Workflow failed: <error>`（758）、以及查询输出（status/tasks/inbox/gc/issues 等）。
- 参照物：pi examples/extensions 全部 10+ 处 notify 均为单行短消息（"Selected: x"、"Cancelled"）。

**方案**：
1. notify() 封装增加通用保护：默认单行（超长截断 + 换行合并），查询类输出支持 `{ maxLines }` 选项（如 8 行封顶 + 尾部提示）；
2. 任务结束类通知（DAG 结果、Team 结果、Dispatched/Applied、失败原因）改为**一行摘要**：状态 + 耗时 + 成本 + 详情路径（checkpoint/artifact）；
3. 查询类输出保持可读（行数封顶），不再推送超长文本；
4. 记录通知准则（一行内短消息）到 docs，后续新通知一律遵循。

**实施（2026-08-12）**：notify 新增 maxLines 参数 + `cleanNotifyText` 清洗（默认单行、每行 200 字符截断、折叠提示）；DAG 结果通知改为 `dagResultSummary` 一行摘要（状态/节点数/耗时/成本/run id）；任务注册通知保留 `work style` 信息的一行摘要；查询类（status/task/workflow/message/gc/agent/issue）统一 maxLines=12；tests/test-tui-core.ts 全过。

**第二阶段（2026-08-12，用户反馈仍存在）**：一行 notify 仍追加在输入区上方。新增 `taskNotify`：任务生命周期事件（Workflow dispatched / DAG 结果 / task registered / failed）改写入 **footer 状态行**（`ctx.ui.setStatus("agentflux-task", ...)`，15s 自动清除），完全不占聊天流；错误带 ⚠ 前缀；print/无 UI 回退 console。查询类通知保留 notify（maxLines=12）。测试 mock 增加 setStatus 并断言 footer 文本。

**第三阶段（2026-08-12，用户重启后发现 `[flux pricing]` 仍挡输入框）**：根因是**诊断日志直写 stderr**（pi 不捕获扩展 console 输出，TUI 模式下 stderr 直接显示在输入框位置），与 notify 无关。修复：① entry.ts 的 `loadPricing` 调用改为 `ctx.hasUI ? undefined : ctx.model?.id`——TUI 静默、print/json（ctx.mode 为 "print"/"json"）保留诊断；② host/index.ts 不再传 model（无头服务不打印）；③ compaction-advisor 删除 console.error（telemetry 已记录）；④ dag-executor 17 处 `[flux dag]` 日志改为可配置 `dagLog` sink，entry.ts 在 `ctx.hasUI` 时置空。测试：TUI 39/39（新增"启动不输出诊断日志"断言）、DAG 24/24（sink 测试）。print 模式已验证恢复输出 `[flux pricing] model=oa/deepseek-v4-flash ... remote=true (410 entries)`。

**第四阶段（2026-08-12，用户确认样式方案）**：用户反馈 footer setStatus 彻底不显示，且要求所有提示改为"对话最底部浅灰色小字"（其他插件的做法）。确认 pi 的 `ctx.ui.notify(text, "info")` → `showStatus` → `theme.fg("dim", ...)` 浅灰小字追加对话底部，且连续通知原地更新不堆积——正是目标样式。修改：`notify()` 在 TUI 下统一调用 `ctx.ui.notify(cleaned, "info")`（level 不再透传，warning/error 用 △/⚠ 前缀区分，不用彩色大字）；`taskNotify` 移除 setStatus/footer 与 15s 定时器，改回单行 notify；print/无 UI 仍按 level 分流 console。测试：TUI 40/40（新增"所有通知统一 info 级"断言，19 条通知全部验证）。

---

## 二、工具门禁改造（方向已定，暂不实施）`[已决策·暂缓]`

**现状**（评审确认）：

- 子代理门禁已存在：subagent-entry.ts 注册 `tool_call` handler，经 capability-policy 三层窄化（template → registered → run）+ lockFiles + 通信契约，fail-closed（策略解析失败 block 全部工具）。
- 主进程（Main Agent 对话）无任何路径/命令级门禁。
- 已知弱点：① `evaluateLockFileToolCall` 只拦 edit/write，bash 可绕过（echo >、cp、tee 等写入原语正则列不完）；② bash 的 workspace 检查只匹配 Windows 盘符路径，POSIX 下形同虚设；③ 门禁裁决跑在子代理自己的进程内（架构上可被绕开）。
- pi 官方生态盘点（已核实）：`tool_call` 事件是官方门禁点（`{ block: true, reason, terminate }`、handler 抛错 fail-safe、handler 间可见 input mutation）；examples 含 permission-gate / protected-paths / confirm-destructive / bash-spawn-hook / tool-override / sandbox（`@anthropic-ai/sandbox-runtime`，OS 级，**仅 macOS/Linux**）；用户本地已装 subagent 扩展为裸 pi 子进程无门禁。

**后续开发方向**（参考 Claude Code 三层模型 + pi 官方模式，暂不实施）：

1. 主进程 tool_call 门禁：复用 capability-policy 的 `evaluateCapabilityToolCall`，按官方 permission-gate 模式加 `ctx.hasUI` 分支（有 UI 交互确认 / 无 UI 默认 block）。
2. bash 检查从正则黑名单改为 **input mutation 包装**（sandbox 示例模式：改写 cwd、注入包装），根治写入原语漏网。
3. 补齐 pi 工具全集（grep/find/ls/glob/delete_file 等）的 path 校验、POSIX 路径支持、大小写策略（Windows 忽略 / POSIX 敏感）。
4. OS 沙箱：Linux/macOS 部署时复用官方 sandbox-runtime，Windows 不做承诺，继续诚实声明"规则层门禁不是 OS 沙箱"。
5. 长期架构：关键裁决从子进程内上移到宿主进程（Host/PiDeck 侧）。

**明确**：本计划发布时门禁不做开发，保持现状。

---

## 三、子代理运行方式对比（事实记录）

| 维度 | 本地 subagent 扩展（~/.pi/agent/extensions/subagent） | AgentFlux agent-runner |
|---|---|---|
| 进程参数 | `--mode json -p --no-session` + model/thinking/tools/prompt | 同 + `--no-prompt-templates --no-context-files --approve`（显式隔离项目模板/上下文并信任项目资源） |
| 扩展加载 | 无（裸 pi） | `--no-extensions -e subagent-entry.ts`（prefixLayout 时）：门禁、RPC 消息泵、flux_agent_message、遥测、前缀布局 |
| 会话 | 永远无状态 | ephemeral 无状态；persistent `--session-id/--session-dir` 持久会话（按能力哈希分代） |
| skills | 不显式控制（受信任默认影响） | 显式 `--skill` 白名单或 `--no-skills` |
| 门禁/锁/预算 | 无（仅 pi 默认非交互 block） | 三层能力窄化 + 文件锁 + 预算（75）/超时（124）/中断（130） |
| 重试/降级 | 智能重试（崩溃可重试、软失败不重试） | 重试循环 + 模型降级 fallback（防循环） |
| 身份/协作/遥测 | 无 | AGENTFLUX_* 身份、Agent 消息、心跳状态、TelemetryWriter、Task Registry 谱系 |

两套互不干扰：AgentFlux 子进程 `--no-extensions` 禁用全部外部扩展，只加载自己的 subagent-entry。

---

## 四、完整测试计划（每个功能实施时执行）

### A. 确定性测试（Vitest + 全量回归）

- 修复项单测：GC 会话匹配矩阵（前缀/段边界/persistent/TTL/dry-run）、Community 终态守卫、envelope 解析降级、quality-gate 超时传递、requiredSendTo 语义。
- 全量回归：`npm run verify`（基线 323 项）、typecheck、production build 全绿；PiDeck 改动另跑 Vitest 208 项 + Vite build + Electron compile。

### B. 真实链路回归（默认 deepseek-v4-flash、thinking off、简短提示、受限轮数与输入 Token、零重试，控制成本）

1. 四种工作方式最小链路：Direct 单任务、Team 2-3 并行 + lockFiles 拒绝路径、Workflow 3 节点 + 质量门失败重试 + checkpoint/resume、Community issue→claim→submit→resolve + 终态拒绝。
2. GC 专项：构造 terminal agent + 会话 → dry-run 核对保留/归档清单 → 正式归档 → 验证 archive 目录与 manifest、persistent 会话保留、`dev`/`dev-frontend` 不误伤。
3. Persistent 专项：连续两次调用验证会话延续；capability override 变更验证会话分代重置行为。
4. 消息/状态一致性：Main、Ephemeral、Persistent、Workflow node 的父任务、消息投递、检查点、失败原因一致。
5. Desktop（PiDeck 真实编译应用）：~~历史任务打开、页签去重、工作方式选择器；真实截图 + 执行报告~~。**2026-08-12 用户决策：PiDeck 桌面端已放弃，本项不再执行；开发方向聚焦 Core + TUI（见 .codex/CONTINUATION.md 七）。**

### C. 证据与文档

- 真实截图与执行报告入 `docs/test-evidence/`；功能状态在 docs/26 明确标记"已实现/部分实现/未实现"。
- 更新 `.codex/CONTINUATION.md` 供下一位 Agent 直接续接。
