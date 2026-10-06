# AgentFlux 当前开发规划

更新：2026-10-06（UTC）。当前目录仅保存未完成或待验证任务；完成/被替代阶段见 [历史规划](../history-plans/README.md)。

## 当前主题

| 文件 | 范围 |
|---|---|
| [01-entry-and-safety.md](01-entry-and-safety.md) | 入口、Community、Message V2、权限、名称及 Workflow 引用 |
| [02-runtime-and-storage.md](02-runtime-and-storage.md) | Task/Run/费用、checkpoint、session、GC 和并行写 |
| [03-real-validation.md](03-real-validation.md) | 新候选真实 Pi/Provider、恢复、TUI、发布和 soak |
| [04-pi-compatibility.md](04-pi-compatibility.md) | Pi1.0双后端的剩余Host形态/UI/故障/长期组合及原生可选接入 |

原始 17 组问题见 [全仓审查](../reviews/2026-09-07-project-review.md)；当前实现/单测/真实使用范围见 [逐功能报告](../reviews/2026-09-08-function-validation.md)。R 编号只是证据索引，不是平行任务系统。

## 当前事实

- 用户已授权v0.1.3合入main/tag及Actions/npm核验。候选本地verify/typecheck/build/包与两模式各12类fresh通过，92 Runs/70 Executions；远程发布尚待证明，见[发布报告](../reviews/2026-10-06-v0.1.3-release.md)。具体任务只在03 RELEASE-01，不提前称发布成功。
- Pi1.0/双后端初阶段已实施：新分支 `feat/dual-agent-runtime-2026-10-02`，`subagent_runtime=process|sdk`（默认process），同一Core+Host公共loader facade/逻辑owner；两模式各10类fresh Provider/本地安装验证通过，64 Runs/54 Executions，限定估计$0.09401536。见[实施报告](../reviews/2026-10-02-dual-runtime-validation.md)与[历史摘要](../history-plans/2026-10-02-dual-runtime.md)。用户10月6日重启后两模式短验收通过，运行期跟随全局Pi1.0.4（dev1.0.0不变），见[重启报告](../reviews/2026-10-06-dual-runtime-post-restart.md)，不再需要重启；旧工作树不清理，未冒称TUI/故障/平台/全部Provider认证；剩余只看04。
- [子代理生态调研](../reviews/2026-10-01-pi-subagent-survey.md)已核验六个社区执行链：三个同进程SDK、一个混合、两个独立Pi进程；官方0.99.2示例仍spawn。较热门实现支持SDK候选方向，但不能据非随机样本宣称全生态多数；生态调研不代表运行认证；AgentFlux自己的SDK实现及限定实测已由上述实施替代，剩余验收只在04。
- 用户重启后发现全局0.99.2与项目SDK/child0.99.1漂移，已修真实入口manifest/bin/realpath验证及SDK版本拒绝，开发包对齐0.99.2。完整门禁与八类fresh全局0.99.2生产调用/费用/27 Runs/51记录PID对账通过，见[补丁报告](../reviews/2026-10-01-pi-0992-restart-validation.md)。10月1日再次重启后当时Main/child同一全局0.99.2 CLI短调用通过，该候选无需再重启的结论不适用于10月2日全局1.0.0漂移；当时SDK统一宿主绑定尚未实现，已由本轮Host wrapper阶段替代。Linux实现基础/原生验收、macOS明确缺出生身份及旧Node20 CI待修，见[最新Host与平台报告](../reviews/2026-10-01-host-binding-platform.md)；首次失败与旧候选保留，不冒称自动patch兼容或跨OS认证。
- Pi 0.99.1 必需迁移已实施，verify/独立 typecheck/build、SDK/包门禁与同候选八类 fresh 调用通过，见 [实施报告](../reviews/2026-10-01-pi-migration-validation.md) 和 [阶段摘要](../history-plans/2026-10-01-pi-099-migration.md)。27 个实际 Run、51 个记录原 PID 退出，Core 状态/费用/ACK/checkpoint/谱系有持久证据；不是全部安装/UI/原生可选能力认证。当前 Main 未热更新，重启后才使用新入口。
- 审查的 [29 组矩阵](../reviews/2026-09-30-pi-migration-matrix.md)/[363 条索引](../reviews/2026-09-30-pi-release-coverage.md) 仍是方案来源；原审查未实施状态已被上述实施替代。runtime 子任务预算失败、usage取消、DeepSeek Provider watchdog、各失败 gate/汇总均保留，不回写历史或扩大预算。
- 用户要求修复全部 R01–R17 并测试；当前分支 `feat/dual-agent-runtime-2026-10-02`，基线 `35f4edb`，保留既有工作树，未提交。旧 17 组待办不因 Pi 升级自动结项。
- 17 组均已有至少部分实现，但未全部结项；不能按问题数量推导完成百分比。R14 默认 production smoke 与 R17 native fork 已实现且取得真实成功证据，不再列为“尚未实现”。
- P0-02 Main 失败 sibling 覆盖返工已在指定生产快照取得独立 Luna PASS，旧第四次 rework 报告不改写；不能扩大为新构建、权威账单或全部孙进程认证。
- 本地子代理和 live local profile 使用 `openai-codex/gpt-5.6-luna`/max；早期 Unknown model 与旧 deadline 失败不代表现在仍无法委派。项目取消默认 600 秒执行限制，其他预算不扩大；当前 Main 不因重建而热加载。
- 本轮定向、verify、独立 typecheck/build、dist 语法/导入与 diff 门禁通过；真实通过/失败/中断按构建分别保存于 `function-closure/`。最新结果以 finishedAt、各 step、具体 Core 证据为准。
- 恢复入口/runner 瞬态错误/费用精度补丁与九阶段 history 已完成本轮验证，见 [恢复阶段摘要](../history-plans/2026-09-08-recovery-entry-validation.md) 和 `recovery-closure/summary.json`；Workflow owner hard-kill 等仍未完成。GC writer fence 已由后续阶段实现，不再列为未开发。

- 英文文案与 Windows 后台兼容层已实现，完整门禁和同构建 dogfood/find/grep、四场景 smoke、controls 通过；[阶段摘要](../history-plans/2026-09-08-english-background-validation.md) 保留首轮资产遗漏失败和 Win32 API 对照。人工 TUI/跨平台仍待完成；单次实际 Windows 子代理已由用户确认无闪窗。

- 最新 GC/消息批次：共同 F、93 项竞争及同构建八类 live 脚本最新结果通过；强杀/ACK 丢失重投补齐，全部失败保留，见 [阶段摘要](../history-plans/2026-09-08-gc-message-validation.md)。核验发现真实 PID 编号复用，后续 Core 出生记录/异步核验与启动异常清理已局部实现和验证，见 [PID 局部阶段](../history-plans/2026-09-08-pid-identity-validation.md)；首次捕获/控制接管/锁原子性仍有门禁，不等于全部 PID 风险关闭。

## 状态与规划规则

- **待开发**：没有完整实现；**部分完成**：已有代码但契约未闭合；**待真实验证**：确定性通过、fresh 链路未覆盖；**完成**：实现、必要测试/真实验证与证据均满足。
- 开始前核对 [产品](../00-product.md)、[架构](../01-architecture.md)、续接事实和 Git 状态；没有匹配任务先改规划。
- 不为通过测试改变产品目标、事实源、权限上界、预算或历史谱系；不得覆盖其他工作树。
- 新规划/主题重排先归并已完成或被替代的历史摘要；当前文件只留待办/待验收。AGENTS、README、续接和聊天不维护第二份详细清单。
- 独立任务可交 Luna/max 子代理，共享文件由 Main 整合；不绕过父预算。重启须通知用户，不主动结束当前承载 Pi。

## 当前顺序与依赖

1. P0-01/P0-04/P0-05/P0-07 已归档，P0-02 旧 Main failure 覆盖缺口已独立接受；后续候选按受影响范围重验。
2. P0-06 的迁移/剩余消息组合/Main unread 与 P0-03 的剩余入口验证独立收口；基础崩溃/ACK 丢失重投已完成。
3. 扩大 owner 强杀/恢复前先补 PID 首次启动握手、控制接管与原子性剩余门禁。Community 不阻塞与其无关的 P1-03/P1-04/P1-05/P1-06；P1 按显式依赖推进，P1-07 依赖稳定谱系/lease，不跳过跨 store writer 保护。
4. 每项模型/进程/消息/恢复修改在自身结项前完成真实验证；P2-05 广泛 soak 与发布最后收口。

## 完成门禁

最小测试 → `npm run verify` → 独立 `npm run typecheck` / `npm run build` → dist 语法/导入与 `git diff --check`。涉及真实链路时由外部监督器启动新 Pi，核对 Task/Execution/Agent/Run、delivery/checkpoint、成本来源和 PID；成功与失败都保存证据，列明未验证范围。Host 策略不是 OS 沙箱。
