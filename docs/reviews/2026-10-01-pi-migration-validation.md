# Pi 0.99.1 迁移实施与限定验收

日期：2026-10-01（UTC）。承接 [29 组迁移决策](2026-09-30-pi-migration-matrix.md) 和 [11 发布/363 条覆盖索引](2026-09-30-pi-release-coverage.md)。用户确认开发及自测后，必需的升级适配已实施，确定性及下列 production fresh 链路通过；**不是把所有 Pi 新功能、全部旧待办或所有安装形态宣称完成**。

## 基线与边界

- 分支 `fix/pi-099-migration-2026-10-01`，HEAD `35f4edb060970d5c2ef9105147ac61c962399556`，工作树仍未提交；既有修改未覆盖/还原/清理。开始前的 HEAD、worktree、patch、dist 指纹在 [实施证据目录](../../.agentflux/test-results/pi-migration-2026-10-01/)。
- 四个 Pi 开发包从 0.84.1 对齐至 **0.99.1**，TypeBox 声明 **^1.3.27**、本轮 npm 实装 **1.3.34**；coding-agent peer 要求 `>=0.99.1`，Node 声明 `>=22.19.0`。SDK/TypeBox 保持 external，未复制 Host 或改全局安装。实际验证为 Windows、Node **v24.11.1**；最低 Node 要求是既有 Pi 事实，不是本次上游新增。
- 当前交互 Main 未热更新、未被监督器停止。真实验证使用独立新 Pi 进程加载本轮 production 两入口；使用当前会话的新控制逻辑仍需用户重启 Pi。
- Core Task/Execution/Run、Message V2、DAG/checkpoint/质量门、权限、跨进程锁、预算及 PID birth 保留；Host 门禁不是 OS 沙箱。

## 实施入口与行为

| 范围 | 已开发内容 / 主要源码 |
|---|---|
| Host/CLI | `core/pi-runtime.ts` 从 Host `getPackageDir()/VERSION`、manifest `bin` 定位同版 CLI，保存 Host/CLI 来源；拒绝旧 Host、版本错配、越界/缺失 bin、非 Node 脚本/不支持的独立二进制。override 是明确未验证测试缝。runner、23 个 TS live 脚本和 custom-provider 夹具共用 resolver。 |
| 字节/协议 | `core/jsonl-stream.ts` 增量 UTF-8、严格 LF-only JSONL；完整 `message_end` 权威，delta-only `message_update.usage` 仅 provisional。坏 JSON/UTF-8/空帧/EOF 残片与缺 settled/同代收据均留下错误和 incomplete，不用重试或产物证明洗掉。 |
| 费用 | `core/usage-accounting.ts` 唯一 adapter 接入 assistant、聚合 parent toolResult、usage/unknown kind、compaction/branch-summary、失败请求；entry/request/source/toolCall/invocation alias 幂等，不同明确 entry 不因内容相同而合并。Main、runner、cache-monitor 接同一实现；Core 在线快照保留 provisional/complete/attributionComplete。 |
| 计价/归属 | `pricing.ts` 显式 user override → 有限非负 Pi 原生 total → 可用 remote 估计 → unknown；provider 同名用户价格不串用，异模型工具不套 Main 单价。reasoning/cacheWrite1h 不重复加量；实际 provider/responseModel/thinking 保存到 Run。继承 session entry IDs 是新 Run baseline，终态历史不补改。 |
| 父账务 | Execution `usage` 是 Main 小计，`costUsd` 是 Main + 唯一 invocation receipts，不把已汇总 child 再加预算基数。Workflow 的金额完整性从本次实际 Run 校验，异常返回前已发生 Run 费用保留；known amount 与 attribution 分开。 |
| 工具控制 | Main 五个工具和 child `flux_agent_message` 为 `model-only` / `sequential`。`core/tool-result.ts` 拒绝 Map/循环/非 JSON 值，Workflow Map 显式投影数组；失败/cancel/timeout/budget 具有 `isError`，accepted/background 不冒充终态。 |
| 安全启动 | 始终 `--no-skills` 后仅显式加载有效 skills；no-context-files/no-prompt-templates/no-extensions 保留；package-owned child safety/message 入口与 prefixLayout 解耦。PowerShell 在不能可靠 gate 时准确拒绝；nested leaf/direct path 使用同一 Host tool_call gate。 |
| 模型目录 | `core/model-catalog.ts` 使用 Host typed chat/available/registered provider 快照，保留 Core overlay/affinity；provider/id 消歧，旧无 type chat 兼容，非 chat/不可用/virtual/仅内存注册实现不会进入受限 child。未知 limits 不补 200000。显式 role/Main 不自动降级；显式 physical override 可覆盖 virtual Main，否则准确拒绝。 |
| prompt/cache | 稳定 protocol 原位写 native `systemPromptOptions.sections.agentflux`，不是返回不存在的 options 契约或强制本轮 leading prompt。默认 prefix_layout=none，显式实验也不覆盖 native cache_control/1h TTL。warming 暂按每次 decision stop，不改全局设置、不新造 timer；已有常规 provider cache 不因此关闭。 |
| 收敛/消息 | `agent_before_settle` 读取本代 outcome 并追加 JSON 可见 `agentflux.boundary.receipt`；`agent_settled` 才收敛/ACK。receipt 的 generation、实际 user 消费匹配、最终 success/error/abort 均检查；void sendUserMessage 不假造 queued/handled 回执。 |
| session/UI | last-message 读取 native active projection，保留 raw 历史；before_fork 仅 attempt telemetry、不生成假 Agent，tree 读 preparation.targetId；活动父任务/child 在会话替换前拒绝跨 context。可信 message 菜单显式 expandPromptTemplates，普通消息不展开；终端组件只在 mode=tui，终态 duration 冻结于 finishedAt。native user prompt wait 记 waiting_user 而非 provider stall。 |
| recovery | advisor 只观察 native compaction/retry reason、willRetry、failed；不复写压缩/重试器。保留 Core 真实业务恢复与新 Task/Execution 谱系、旧 checkpoint/source hash 不变。 |

金额是 **Pi/Core 估计**，不是供应商账单。`complete` 指收到来源的金额覆盖，不等于异模型逐项归属、绝对请求内不超支或实际收费保证。DeepSeek 自定义通道报告 native 零价仍附未知报价提醒，不能称真实免费。

## 确定性 / SDK / 包门禁

证据见实施目录的 `*-final4.log` / `*-built-final.log`、`summary.json` 及具体 attempt 日志：

- `npm run verify`、独立 `npm run typecheck`、`npm run build` 全过；`git diff --check` 全过（Git LF/CRLF warnings 不视作 diff 失败）。
- 新 runtime/bin/旧版本拒绝，UTF-8/LF/残片/坏帧/同代 settled 收据，usage 幂等/相同内容双 entry/provider 价格/baseline/未知金额/摘要费用，typed catalog/virtual/DTO/duration，child safety/compaction 等加入 `test:unit`。
- 真实 Pi 0.99.1 SDK、确定性模拟响应（无 Provider 请求）：三次 assistant **$0.03** + native 聚合 nested tool **$0.40** + 手动 append cache_warm **$0.30**，Pi 与 completed Execution/cache stats 均 **$0.73**。金额 complete=true、异模型 attribution=false；不是实际后台 warming。
- Source 与 production Main/child SDK 探针均过：model-only Core 拒绝脚本调用；inactive codemode leaf、denied read、PowerShell 经实际 nested pipeline，带 parentToolCallId 且 poison-pill execute=0；真实 native boundary receipt 持久化。
- 本地 HTTP mock custom provider 的实际 CLI/网络链路通过；不是付费 Provider 或未知凭据认证。
- production entry/subentry/preload `node --check`、两入口动态 import、`npm pack` 与包内资产核验通过。未发布 npm；不等于安装器/跨 OS/广泛 release certification。

本轮通过的 production 指纹：

```text
entry.js                 c4e24962866b68815acbdb8c001175760f382ff4ea69e8bd8dc101d337e373a5
subagent-entry.js        5883e92b799a03de24c20c96f45d4fea3cf142e19c62a01d7be95075283a3980
background-preload.mjs   a7efe6d0e326ea052abac3d7e8347f7badd8593048f40abfc294060a38a1b85e
```

## 真实调用：同候选、逐项事实

最新八类脚本的保留 fixture 三资产均匹配上述指纹；每个物理 Run 的 provenance 均证明 Host/CLI **0.99.1**。监督器默认未传 old-pid，未停止当前 Pi。

| 调用 / 事实 | 最新唯一报告（`.agentflux/test-results/` 下） |
|---|---|
| 外部 dogfood：fresh Main、同 Agent 两 role、completed Task/Run | `dogfood/iteration-mup9d3y0-553cf464.json` |
| Core 四场景：direct Main；两 Agent；Message ACK；planner + 3 DAG 节点 + 3 judge/checkpoint；Community create/claim/submit/review/resolve | `core-smoke-pi-099-migration-final4-1790842210509-164-4f940777-f1af-4ad6-a53e-a80ad09a659c.json` |
| 九阶段 Task history：实际 new/continue/reuse/retry；active/已完成 retry/resume 冲突及无 checkpoint 拒绝；旧 Task/Execution 不变 | `task-history-1790842498867-13852.json` |
| 三通道 peer：真正 child tool send direct/group/broadcast，逐收件人 ACK、不同 Run sender 身份 | `message-peers-1790842613849-36952.json` |
| 原生 fork：源会话/身份/父谱系、多个目标 Run、源 hash/费用 baseline | `native-fork-1790842671097-25580.json` |
| 真实 Workflow 业务失败→输入冲突拒绝→flux_task resume 成功；只重跑未完成节点，继承/本次成本与源 checkpoint/hash 不变 | `workflow-resume-1790842736550-40748.json` |
| 在线 Run 非零 usage/cost/heartbeat/tool phase/终态；显式未知模型准确拒绝、零错误模型 Run、父失败不被自然语言覆盖 | `run-telemetry-1790842839523-30360.json` |
| 忙碌 followUp：实际消费、一次注入/ACK、无模型硬 deadline | `busy-followup-1790842876153-36772.json` |

调用使用 `AGENTFLUX_LIVE_BUILT=1`、显式 `openai-codex/gpt-5.6-luna`、thinking=off（不改 local profile 的 Luna/max 默认）。最初按默认低成本方向核验实际目录，旧 deepseek-v4-flash 不在可用目录，显式 `octopus-completions/deepseek-flash` dogfood 成功；Core 轮的 Community 等待 Provider 被 fixture watchdog 终止，原报告保留。更换 Luna 是通道可靠性复测，不是提高推理档位或扩大任务预算。

[summary.json](../../.agentflux/test-results/pi-migration-2026-10-01/summary.json) 校验 8 个 fixture、27 个物理 Run、51 个记录的原进程退出（若 PID 复用按 birth 区分，不杀后生进程），Execution 估计合计 **$0.03931893000000001**。该数只汇总这八个最新 fixture 的唯一 Executions，不包含历史复测/开发委派/未观测进程/权威账单。

## 失败、限制与下一步

- runtime implementer 因父预算 `$2.007733 >= $2` 失败，usage implementer 被 Main 取消，safety implementer 完成。已有改动由 Main 接管整合；没有抬高原预算、将失败 Run 改成功或依靠子代理自然语言当验收。独立状态/成本在 summary delegation。
- 收口 summary 的严格完整性检查发现 invocation normalization 曾丢 coverage 字段；已持久化/校验布尔，缺标记按 unknown 而非 true，并新增 mixed/legacy/invalid flags 回归。Core smoke 进一步强制完整金额与唯一 receipts 对账；其首次 helper 投影遗漏 raw coverage 的失败也保留，补字段而不放宽断言。修正后完整门禁及八类同候选真实验证重新通过。
- 早期 typecheck 的 hook 名/语法/类型及旧 FakePi 断言错误、各 verify attempts、DeepSeek Provider 超时均保留；修复后重新跑，不放宽关键拒绝、费用或状态断言。旧 telemetry 场景“显式未知模型静默降级成功”的断言按新架构改为准确拒绝；业务失败 DTO 也必须 isError=true。
- 当前交互 Main 需用户重启才能使用新入口；fresh 验证已完成，不需要监督器猜 PID 或杀当前 Pi。
- MCP/OAuth、受控 codemode/search、typed image/classifier、virtual/custom provider/router 实现导入不在本轮产品扩展范围；受限 child 仍关闭/准确拒绝。不声称禁用了用户自行配置的 Main 原生扩展。
- warming 在可归属预算/追加式 session-overhead 契约闭合前维持 stop；人工 TUI/IME/theme/fullscreen、跨 OS/独立安装器/SEA/Bun、实际 warming、完整消息故障组合及长 soak 待验证。启动握手/重启 PID 控制接管/锁 generation-CAS、owner hard-kill 恢复等旧 backlog 没有被此次迁移自动解决。
- 剩余验收/可选接入仅维护在 [当前 04 规划](../development-plan/04-pi-compatibility.md)；已完成批次见 [历史摘要](../history-plans/2026-10-01-pi-099-migration.md)。
