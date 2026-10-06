# Pi 0.99.1 / AgentFlux 兼容性审查

审查日期：2026-09-30（UTC）。范围：Pi 0.84.1 → 0.99.1；先检查，不修改业务代码、项目依赖或现有 production dist。

用户追加的完整范围见 [29 组迁移矩阵](2026-09-30-pi-migration-matrix.md) 与 [11 个发布 / 363 条覆盖索引](2026-09-30-pi-release-coverage.md)。本文件保留首次四处复现和静态风险的原证据范围；后续探针、原生复用与全部接口决策见扩展报告。

后续必需迁移已开发并取得限定验收，见 [2026-10-01 实施报告](2026-10-01-pi-migration-validation.md)。以下版本/缺口描述是保留的原审查基线，不是最新实现状态。

## 结论

**不是整体 API 不兼容，但有四处已复现的适配缺口，另有一处新版功能的静态风险。** 最大的问题是 Main/子进程版本分裂，以及新版费用来源未进入 Core 账务。现有测试全部通过不能排除这些缺口，因为多数生命周期测试使用 fake ExtensionAPI，runner 测试大量使用 invocationOverride。

- 全局 Pi：0.99.1；npm latest：0.99.1，发布时间 `2026-09-29T18:23:26.245Z`。
- 项目本地 Pi coding-agent/agent-core/ai/tui：0.84.1；`package.json` 的开发依赖仍为 `^0.84.1`。
- 分支 `fix/project-review-2026-09-07`，HEAD `35f4edb060970d5c2ef9105147ac61c962399556`；保留全部既有未提交修改。
- 原始证据：`.agentflux/test-results/pi-compatibility-2026-09-30/`。
- 待调整契约与验收见 [当前兼容规划](../development-plan/04-pi-compatibility.md)。本报告不宣称这些问题已修复。

## 已复现的适配缺口

### C01 高：Main 更新后，默认子 Agent 仍选择本地旧 Pi

位置：`src/agents/agent-runner.ts:476-508`，`package.json`，`tests/live/` 内的 CLI 定位。

`getPiInvocation()` 从 AgentFlux 自身文件执行 `createRequire()`，优先寻找附近的 `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`，只有找不到才使用 `process.argv[1]`。本仓库存在旧依赖，因此全局 Main 为 0.99.1 时，默认 runner 仍进入 0.84.1。planner、worker、judge 共用该 runner；多数 live 脚本也硬编码本地 CLI，容易重复验证旧版。

证据：`host-probe-attempt2.json` 的 `checks.childVersion`。真实 runner 在隔离空配置、offline、零重试下启动，stderr 的文档路径指向本地 0.84.1。对 `gpt-6.1-sol` 报 `Model ... not found ... Using custom model id`；随后因夹具刻意没有凭据退出，未调用 Provider。

**不能把这次无凭据退出误称为新版模型必然无法运行**：旧 Pi 会尝试 custom model ID，真实全局配置还可能有缓存/远程目录。已确定的是版本分裂、旧目录元数据和验证盲区。

Pi 0.84.3 后推荐 CLI 已改为 `dist/bundle/cli.js`，但 0.99.1 的 `dist/cli.js` 仍存在，不是“旧路径已删除”。适配应从 Host 提供的 `getPackageDir()` / `VERSION` 和 package `bin` 定位匹配运行时，而不是只把硬编码路径换成 bundle 路径。SDK Host 不能盲用 `process.argv[1]`。

### C02 高：嵌套工具与 usage entry 的费用漏计

位置：`src/entry.ts:711-722`，`src/agents/agent-runner.ts:1488-1610`，`src/extension/cache-monitor.ts:14-38`。

Main 只累加 `turn_end.message.usage`；runner 只累加 assistant `message_end`；cache monitor 只读取 assistant entry。新版 Pi 的嵌套工具费用会聚合到 tool-result `usage`，缓存预热费用通过 `usage` entry / `entry_appended` 进入 Pi 会话统计。这些费用未进入上述 AgentFlux 路径。compaction/branch summary 费用同样需要对齐；这是旧账务缺口在新功能下扩大的表现，不是所有差异都由 0.99.1 首次引入。

真实 Pi 0.99.1 SDK 加载**现有 production `entry.js`**，使用确定性自定义 stream 和 `ctx.executeTool()`：

| 项目 | 夹具费用 |
|---|---:|
| 三次 assistant | $0.03 |
| 嵌套工具 | $0.40 |
| `appendUsage("cache_warm", ...)` | $0.30 |
| Pi `getSessionStats().cost` | **$0.73** |
| AgentFlux TaskExecution `costUsd` | **$0.03** |

Core 仍显示 `costAccounting.complete=true`。Task/Execution 为 completed，确有 nested parentToolCallId 和最终 agent_settled，不是根据模型最后一句话推测。

证据：`host-probe-attempt2.json`、`cost-session-entries-attempt2.json` 和隔离 `tasks.json`。**费用均为测试注入值，没有真实收费，也未实际触发缓存预热网络请求。** 实际预热的事件契约来自 Pi 源码/文档；不能把该夹具当作供应商账单或真实缓存收益测量。

### C03 高（条件性）：允许 PowerShell 后，现有 shell 门禁不覆盖它

位置：`src/core/capability-policy.ts:414-468`。

Pi 0.84.3 新增原生 `powershell` 工具。AgentFlux 先检查工具 allowlist，随后只对 `toolName === "bash"` 检查危险命令和 shell 路径。若角色显式允许 PowerShell，相同命令会跳过这部分 Host 策略：

- `bash: git reset --hard` → `Dangerous command blocked ...`；
- `powershell: git reset --hard` → `null`（放行）；
- `read: denied.txt` → 拒绝；
- `powershell: Get-Content denied.txt` → `null`。

证据：`host-probe-attempt2.json` 的 `checks.powershell`。只运行纯判定函数，**未执行危险命令或实际读取禁用文件**。

默认角色不因此自动获得 PowerShell，未知/不允许的工具仍被拒绝。需补同等级检查或在未支持时明确拒绝；不能把补丁描述成 OS 沙箱。

### C04 中（混合目录配置时）：模型发现未区分 chat/image/classifier

位置：`src/core/model-capability.ts:60-115`。

Pi 0.99.0 的模型目录/配置支持混合 operation type。`discoverPiModels()` 直接遍历 `providers[].models`，只按 ID 去重，没有过滤 `type`；最小输入包含 chat/image/classifier，输出也包含三者。非 chat 模型因而可能进入 Agent 角色选择/affinity 候选。按裸 ID 去重也不能表示跨 provider/operation 的同名模型。

证据：`mixed-models.json`、`host-probe-attempt2.json` 的 `checks.modelTypes`。这是模型发现函数的确定性复现，**不是已发生的真实 Provider 错选**；夹具仅包含用于此函数的最小字段，不冒称经过完整 Pi 配置 schema 验证。

此外，该函数仍固定读 `~/.pi/agent/models.json`，不是当前 Host 的完整模型目录，也不尊重 `PI_CODING_AGENT_DIR`；这是既有来源限制，需要随新版目录一起核对。

## 静态风险 / 尚未复现

### C05 中：virtual model 不能直接按普通物理模型继承给子 Pi

位置：`src/entry.ts:386-400`，`src/agents/agent-store.ts:445-452`，`src/agents/agent-runner.ts:1290-1340`。

新版 `ctx.model` 表示用户选择的 virtual model；assistant message 才记录实际 physical model。当前调度继承 `ctx.model.id/provider`，子进程又使用 `--no-extensions`，只加载 AgentFlux subagent 入口，没有 Main 的 virtual-model 注册代码。仅传虚拟 selector 并不能在子进程中恢复 router。

该判断基于控制流及 Pi virtual-model 契约，**本轮未执行真实 router→Agent 链路**。需要明确可支持的继承策略或在启动前给出准确拒绝，不能默默改成任意物理模型/降级通道。

## 当前未发现需要重写的部分

- 0.99.1 类型检查没有新增 TypeScript 错误。
- 两个现有 production 入口在 **fresh 0.99.1 bundled CLI** 的隔离 RPC Host 中加载成功，get_state/get_commands 成功、无 extension_error、正常退出；没有发送模型 prompt。
- `SessionManager.forkFrom()` / `getBranch()` 等现用 SDK 契约仍可用；新版 native fork 回归通过。
- before_provider_request、before_agent_start、tool_call、最终 agent_settled 注册有效。真实 Host 探针经过新嵌套调用与最终 settled。
- 已有 Message V2/ACK、startup inbox ownership 和 prefix-layout 回归通过。但这些多数是确定性测试，不代表全部新版 retry/compaction/follow-up 真实组合已认证。
- TUI 核心回归通过，菜单已有 `ctx.mode === "tui"` 保护；不等于人工键盘/鼠标/主题验收。
- host-provided 模块保持 external，未发现应把 Pi SDK 打进 bundle 的理由。manifest 可补齐缺失的 `@earendil-works/pi-coding-agent: "*"` peer 声明；不要通过内联/安装重复 Host 实例解决 CLI 定位。
- 当前 MCP capability 非空仍显式拒绝；子 Pi 的 `--no-extensions` 也关闭新版 built-in MCP/codemode。不能宣称已支持原生 MCP，也不应为接通功能直接放宽权限。
- AgentFlux 没有依赖本轮移除的 shouldStopAfterTurn，亦没有直接实现旧 Context 形状的 provider stream；这些 breaking changes 未发现直接受影响代码。

## 验证及限制

在 `.agentflux/test-results/pi-compatibility-2026-09-30/fixture-latest/` 复制源码/测试，通过 junction 使用已安装 0.99.1 的 coding-agent/agent-core/ai/tui。原项目 node_modules/dist 未改，构建只发生在隔离副本。

| 检查 | 结果 / 日志 |
|---|---|
| 原项目 `npm run typecheck`（0.84.1） | 通过；`typecheck-local-0.84.1.log` |
| 隔离 0.99.1 `npm run typecheck` / `npm run build` | 通过；`typecheck-latest-0.99.1.log`、`build-latest-0.99.1.log` |
| TUI、native fork、RPC pump、startup inbox、Main routing、prefix-layout | 六个脚本通过；`targeted-latest-0.99.1.log` |
| 隔离 0.99.1 `npm run verify`，项目 TypeBox 1.3.7 | 完整通过；`verify-latest-0.99.1.log` |
| 再对齐 Host TypeBox 1.3.27 后组合完整门禁 | 外部 bash 工具 360 秒超时；`verify-typecheck-build-latest-final.log`，93 项 reference fence 已输出通过，末两个脚本及后续 typecheck/build 尚未执行完，不记整轮 PASS |
| TypeBox 1.3.27 剩余两脚本、独立 typecheck/build | 随后通过；`remaining-typecheck-build-latest.log`。不把拆分结果改写成超时命令成功 |
| 真实 0.99.1 SDK / 当前 production entry | 探针通过并复现费用差异；`host-probe-attempt2.json` |
| 真实 0.99.1 bundled CLI / 两 production 入口 | 加载/查询/退出通过；`bundled-cli-probe.json` |

首次 Host 探针误读了不存在的 `task-executions.json`（实际 executions 在同一 tasks.json），夹具修正后重跑。`host-probe-attempt1.log`、原脚本和原工作区均保留；不是 AgentFlux 新版故障。TypeBox 复验超时日志同样保留；未发现末尾业务断言失败，不能推断为 TypeBox 不兼容。

本轮未运行真实 Provider smoke、完整 DAG/Community/message 故障重投、虚拟 router、实际 cache warming、人工 TUI 或跨平台验证。所有模型输出/费用探针是确定性测试值。没有停止当前 Pi，也没有修改任务历史、用户模型设置、现有依赖或 production dist。

production 指纹保持审查前不变：

- entry：`de03f591ba69127f470a05f23db95202e531b5166f68663514d408469fe5afec`
- subagent：`e8a3cce432a8e82c3d33b9e71dad37eb00eaee4d86eb72e074a6c9cfecea49df`
- preload：`a7efe6d0e326ea052abac3d7e8347f7badd8593048f40abfc294060a38a1b85e`

## 上游依据

本机 0.99.1 包内 README、CHANGELOG 的 0.84.1 之后 release 区间，以及完整 `docs/extensions.md`、`sdk.md`、`tui.md`、`cli.md`、`json.md`、`rpc.md`、`session-format.md`、`message-types.md`、`settings.md`、`models.md`、`custom-provider.md`、`mcp.md`、`packages.md`、`virtual-models.md` 等相关专题文档、检查过的 SDK/extension 示例和实际导出声明。上游仓库为 [earendil-works/pi](https://github.com/earendil-works/pi)；本轮以安装版本为依据，不把 GitHub main 当作已发布契约。
