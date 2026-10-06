# Pi 1.0 与 process / SDK 双后端实施验证

日期：2026-10-02（UTC）；分支 `feat/dual-agent-runtime-2026-10-02`，HEAD `35f4edb060970d5c2ef9105147ac61c962399556`。保留全部既有未提交修改；本报告不是全产品/跨平台认证。

> 后续：[2026-10-06重启验收](2026-10-06-dual-runtime-post-restart.md)已确认当前Main加载新入口，两模式短调用跟随全局Pi1.0.4；无需再次重启。下文保留10月2日完整限定候选的版本/资产/范围。

## 交付与配置

在项目 `.agentflux/agentflux.json` 合并一个字段（保留其他预算/策略）：

```json
{ "subagent_runtime": "sdk" }
```

- `process`：兼容默认；每 Run 独立 Pi 子进程，沿用真实 Host package/bin 定位、身份与停止门禁。
- `sdk`：Main 进程内独立 Pi AgentSession；独立对话、cwd、资源、ModelRuntime/认证、权限和持久会话。没有额外 Pi worker 进程；bash 等工具仍可能启动系统进程。
- 配置在每个新 Run 开始冻结；修改只影响后续 Run，未知值拒绝。Agent、planner、DAG node、judge 使用同一 Core Runner，不新增工具动作、任务状态机或消息协议，不静默跨后端 fallback。
- SDK 共享 Main 故障域，只提供协作取消，不能强杀不合作/阻塞 JS 工具；此类任务选择 process。两个后端都不是 OS 沙箱，SDK 不自动降低 Token 费用。

四 Pi 开发依赖已精确对齐 **1.0.0**，coding-agent peer 最低 **1.0.0**，Node **>=22.19.0**。本机验证 Node24.11.1/Windows；TypeBox 开发实装1.3.34，真实全局 Host1.3.27。

## 实际修改与事实来源

| 入口 / 模块 | 实施内容 |
|---|---|
| `src/core/config.ts` / `types.ts` | 严格 `subagent_runtime` 解析；坏 JSON/未知值拒绝，默认 process |
| `src/extension/host-entry.ts` / `scripts/build.mjs` / manifest | Pi package 主入口 `dist/extension/host-entry.ts` 经公共 loader 取得 Host SDK facade，传给唯一业务 bundle `dist/extension/entry.js`；SDK 依赖仍 external |
| `src/core/pi-sdk.ts` / `src/entry.ts` | 用真实 Main SessionManager/ModelRegistry 公共类 identity 验证 facade，冻结 descriptor/设置/provider registry；按 token 定向释放，活安装漂移仍拒绝 |
| `src/agents/sdk-run-driver.ts` | 独立 SDK runtime/resources/session；原生事件送入现有消费器；先关闭输入，再 abort/idle/shutdown/unsubscribe/dispose；失败不能伪造退出或通过未处理 Promise 杀 Main |
| `src/agents/agent-runner.ts` | process 和 SDK 共用费用、预算、健康、同代 receipt/settled、retry、Message V2 与终态；配置冻结；SDK 拒绝 env/invocationOverride；费用及初始化 signal 接线 |
| `src/subagent-entry.ts` | 安全/消息 factory 显式注入 Run/Agent/task/cwd/策略，CLI default 仅解码 env；SDK 不临时修改全局 env/cwd、不载 Main 控制扩展 |
| `src/core/runtime-owner.ts` / `run-registry.ts` | SDK Run 保存 Main birth + Run generation + SDK session，不伪造 child PID；drained 同 fence 或 Host 确认死亡才授权回收，缺 handle/心跳超时不当死亡证据 |
| `src/core/active-context.ts` / `shared-board.ts` | lease/presence/文件锁按 SDK logical owner/generation 定向；同 PID 或同名不能释放别的 Run |
| inspect / live fixtures | 显示 backend，SDK host/session/generation 与 process child PID 区分；真实 fixture 使用 Host wrapper 并记录四资产，支持两模式 |

Task/Execution/Agent/Run Registry、Message V2 delivery/ACK、Workflow checkpoint 与 session JSONL 是验收数据来源；自然语言 marker 只作附加条件。历史 Task/Run 不回写；持久化/临时、技术 backend 是不同维度。

## 确定性验证

最小 `test-subagent-runtime` 与完整 `npm run verify`、独立 typecheck/build 通过；最终同候选日志在 `dual-runtime-2026-10-02/`。专项目标包括：

- .03 assistant + .40 模拟 tool usage + .30 手动 usage = **.73**，幂等结算及完整性；不代表实际缓存刷新。
- 同 PID 并发但独立 cwd/session/history；子会话 dispose/取消后 Main 能再次请求。
- 无共享 env/cwd 修改；非法模式/未绑定/不支持的 env 准确拒绝。
- 持久会话继续只计本次 .03，旧 Run 不变；活动 Run 不因配置切换变 backend；.01 预算遇 .03 已花费用失败，不扩大预算。
- 逻辑 owner 的同 PID 锁隔离、缺 handle 保护、同 fence drain 后回收；cleanup 失败不生成 close。
- 既有 process、权限/嵌套 pipeline、.73 Main 账务、native fork、Task/Workflow/消息回归仍进入 verify。

最终 syntax/native imports、Host loader、pack 解包资产及 diff 门禁见同目录 `final-validation.json`；打包通过不等于全部发布形态认证。

## 真实 Provider 与本地安装

全部角色显式 **openai-codex/gpt-5.6-luna、thinking=off**，built=1，未提高每个 fixture 的预算，默认 execution deadline=null；外层 watchdog 仅限制测试夹具。DeepSeek 前期曾有 Provider/watchdog负例，本轮选择已验证可靠的低成本 Luna 做兼容与生命周期验证，不测推理质量。

每个后端各 **10 类**最新候选通过：

| 场景 | process | sdk | 持久验收 |
|---|---|---|---|
| 外部 dogfood/multirole | PASS | PASS | Main birth、两角色 Run、原生 find/grep、预算/无默认 deadline；不传 old-pid |
| Core direct/Agent/Workflow/Community | PASS | PASS | Task/Execution 状态与费用、worker/planner/judge、ACK/checkpoint、resolve |
| Task history | PASS | PASS | 实际 continue/reuse/retry/负例及父谱系，旧历史不变 |
| peer/group 消息 | PASS | PASS | 实际消费、delivery/ACK 与持久 session |
| native fork | PASS | PASS | 新 session/父谱系、source hash 不变 |
| Workflow resume | PASS | PASS | 业务失败/输入冲突拒绝/跨 fresh Pi 新谱系/仅失败节点重跑；非 hard-kill |
| telemetry/模型错误 | PASS | PASS | 在线金额/状态、明确不存在模型拒绝，无静默替换 |
| busy followUp | PASS | PASS | native bash 超过60s握手阈值，accepted 消息只注入一次且消费后 ACK |
| runtime lifecycle | PASS | PASS | 同 Provider 两独立节点屏障并发、外部 stop；取消后 Main 新请求成功，shell任务退出 |
| 实际已安装插件自动发现 | PASS | PASS | 不用 -e/不禁扩展，从用户 global packages 加载本地插件，真实子调用与账务成功 |

证据 `.agentflux/test-results/dual-runtime-2026-10-02/summary.json` 指向20份唯一报告，收集 **64 Run（每模式32）、54 Execution**。限定 fixture Execution 估计费用 **$0.09401536**，不是账单或全部历史/失败尝试总费用。

执行了 `pi install E:/agent-projects/AgentFlux`（全局1.0 CLI），本地包安装成功。原用户 packages/模型/thinking/retry/主题等配置保留，仅 Pi 将该既有本地路径从 `/` 正规化为 Windows `\`，备份与精确对账保留。项目生产四资产：

| 资产 | SHA256 |
|---|---|
| entry.js | `b24b0762c4984bf909054220c765190c8f949bab798f563964526407a9a45e7b` |
| host-entry.ts | `b088b928209f37b6c679c6adb8a9105324b7ad103f86ff779f1f5805b60db729` |
| subagent-entry.js | `88d3ccc524173594d27e137b2067df607196e507b83827ad206c0cd535816432` |
| background-preload.mjs | `a7efe6d0e326ea052abac3d7e8347f7badd8593048f40abfc294060a38a1b85e` |

## 保留失败与限制

- 首轮 SDK dogfood 拒绝：compiled ESM native import 绕过 Host 映射，两公共类 identity 都 false；门禁没有放宽。离线 `.mjs`/`.ts`探针证明 TS public loader 映射为实际 global Host且两类 true；随后改 Host wrapper，重新构建/全候选真实测试。
- 编译/并发创建顺序夹具、SDK public helper不存在、collector路径转义/安装正规化失败均保留，不修改旧失败报告或历史状态。
- 当前交互 Main **没有热更新、没有被停止**。已安装插件的 fresh Pi 验证完成；用户仍需重启一次加载新 Host 入口。重启后配置切换本身无需再次重启，旧活动 Run 保持原 backend。
- 人工 TUI 后台/focus/fullscreen/IME/resize、Main hard-kill/断电及外部工具后代、阻塞工具、长期 soak、所有 custom/virtual provider、实际 warming/image/MCP/OAuth、Linux/macOS、installer/SEA/Bun 不在本轮认证内。macOS关键 birth 身份仍缺失；SDK不会自动补齐。

完整剩余验收仅维护于 [当前兼容规划](../development-plan/04-pi-compatibility.md)；完成批次见 [历史摘要](../history-plans/2026-10-02-dual-runtime.md)。
