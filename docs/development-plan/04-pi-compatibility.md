# 当前规划：Pi 宿主统一绑定与迁移剩余验收

更新：2026-10-06（UTC）。Pi 0.99.2 必需的升级适配已实施，限定确定性/production fresh 验证通过，已完成内容移至 [阶段摘要](../history-plans/2026-10-01-pi-099-migration.md)；源码、测试、真实状态和失败证据见 [实施报告](../reviews/2026-10-01-pi-migration-validation.md)。本文件只保留未完成或补充待验收范围。原始方案/依赖见 [29 组迁移矩阵](../reviews/2026-09-30-pi-migration-matrix.md)、[363 条发布索引](../reviews/2026-09-30-pi-release-coverage.md)，不重复已完成任务。

## COMPAT-23 / P1：Pi 1.0.0 剩余交互与原生能力边界（待补充验收）

同版升级与双后端初阶段已经完成，移至 [历史摘要](../history-plans/2026-10-02-dual-runtime.md)，源码/命令/限定真实证据见 [实施报告](../reviews/2026-10-02-dual-runtime-validation.md)。本节只保留人工交互与原生可选能力的未验收内容；[1.0审查](../reviews/2026-10-02-pi-1.0-sdk-impact.md)属于实施前基线，不能把旧未实施事实当现状。

- **P1 交互边界**：新Host入口与两后端已于[10月6日重启短验收](../reviews/2026-10-06-dual-runtime-post-restart.md)通过；剩余regular/fullscreen/IME/focus/resize/overlay/theme及TUI后台控制用真实终端验收。不以 settings mock、JSON/print或上游UI修复代替人工认证。
- **P1/P2 operation**：不自动启用 image/codemode/MCP；COMPAT-20 的 models:false 同时限制新增 generateImages。COMPAT-21 启用须检查 operation/provider/model 权限、父预算、stopReason/errorMessage、图像体积与费用；直接 ModelRuntime 请求不能只靠 tool_call gate。MCP 按 name+URL/OAuth scope/iss/恢复能力交集由 COMPAT-19 维护。
- **后续兼容规则**：保留 Host facade/公共类identity及manifest/bin/realpath guard；不在活Main自动更新安装，未知API准确拒绝。低层pi-agent-core旧harness/telemetry/search重导出不能作为新实现依赖。

## COMPAT-22 / P1：双后端剩余故障、Host 形态与长期组合（待补充验收）

实现与两模式各10类fresh验证/本地安装已经归档。本节不重复实施清单，后续必须保留同一Core、冻结backend、逻辑owner及已证明idle/settled的门禁。

- **Host扩大矩阵**：故意制造global/local不同patch与不同解析树；证明公共SDK/SessionManager/ModelRegistry/TUI/TypeBox及provider不重复。增加source/npm隔离/最低Node形态；活Main安装更新可见拒绝或要求重启。不能靠删除identity/version guard宣称自动兼容所有未来版本。
- **故障生命周期**：reload/switch/shutdown与多个SDK Run、Main hard-kill/断电、缺logical handle、跨fresh恢复及定向锁/GC；旧SDK确实结束前不得用process重做同一工作。Main死亡后外部shell/MCP后代的残留与锁/副作用须额外核验，不把session死亡当OS隔离。
- **不合作工具**：Provider/tool不响应abort、阻塞JS、cleanup异常、错误迟到/queued输入；SDK保留stopping与锁/lease且不可杀Main。需要强杀或独立生存选择process，不添加默认硬时限。
- **扩展与长期组合**：真实OAuth刷新/custom provider closure、资源污染/skill/nested、retry/异常费用/父预算、长soak；注册实现缺失或权限未闭合准确拒绝。现有Luna正常/并发/协作取消不认证全部Provider或故障组合。
- **平台与UI**：03 PLATFORM-01及本文件交互/发布行统一维护，不创建平行OS或TUI清单。所有新增验收保留成功/失败，历史对象不改写。

## 当前边界与顺序

- 正式开发/限定真实候选 Pi1.0.0，TypeBox ^1.3.27（开发1.3.34/Host1.3.27）、Node>=22.19.0；10月6日重启后Main运行期Pi1.0.4及两后端短调用通过，无需再次重启；这不替代完整1.0.4发布审查。不主动结束Pi或猜PID。旧0.99候选不覆盖本轮事实。
- 当前 supported Node package bin → 同版 child 路径已验证；non-Node standalone/Bun 明确拒绝，不默默调用任意旧 Pi。virtual/仅内存 provider/router 不能导入时准确拒绝，显式 physical override 可用。
- Core facts/权限/预算/Message V2/历史谱系/checkpoint/跨进程锁/PID birth 保留，Host 策略不是 OS 沙箱。
- 首先补下表的实际启动资源/UI/故障矩阵，再按确有需求启用 P2；不用接入所有 Pi 新增功能来“完成迁移”。原运行/存储和真实验证主题继续维护 PID/恢复/消息等既有任务，本文件不另建平行清单。

## P0/P1：补充验证或进一步闭合

| 编号 / 依赖 | 剩余范围 / 状态 | 验收 |
|---|---|---|
| **COMPAT-01/18** 安装形态 | 已验证 Windows Node SDK/npm/bundled production；实际 source checkout/最低 Node 22.19、全局隔离安装、独立 installer/SEA/Bun 的明确支持/拒绝与跨 OS 待验收。npm pack 不是广泛发布认证。 | 同一候选的 module identity、Host/bin 版本/路径/拒绝原因、包内资产、真实子进程/provenance 对账；未认证形态不能宣称支持，不复制 Host SDK 解决定位。 |
| **COMPAT-02/11** warming 与长期归属 | 当前每次 native decision 安全 stop；手动 usage、nested/summary/baseline/失败和在线账务通过，但实际缓存刷新未开启/未认证。 | 先设计活动 Task/Run 所有权与预算 gate；终态不回写，若要 idle session overhead 先定义追加式契约。使用 native CacheWarmer/usage，覆盖真实 streaming/idle refresh、失败/未知账、tier/Fast/1h/returned model、重启/晚到费用，保持金额和归属覆盖分开；不得请求内绝不超支或账单保证。 |
| **COMPAT-03/08/09/15/17** 启动与 Host 安全扩大矩阵 | 当前 PowerShell 准确拒绝，SDK 实际 nested/path/poison pill 和真实 child 安全入口通过；skills 及 discovery/配置/环境的完整真实污染负例待补。 | 恶意 global/project/.agents skills、显式有效交集、trust 资源例外、shell session 环境/cwd/alias、同批控制调用/cancel/锁组合；未授权资源零连接/零副作用。若以后支持 PowerShell，动态/编码/不可解析命令 fail-closed，不能回退到更宽 Bash。保留 Native file queue 之外的跨进程锁。 |
| **COMPAT-10/12/13/14** lifecycle 组合 | 已有结构化协议、同代 receipt/settled、native fork/active projection、真实 busy/peer ACK、Task history/业务 resume；全部 native recovery/context-edit/system-replace/分支/消息组合待补。 | overflow/length→compaction成功/失败、oversized tool、deferred、input handled、queue clear、retry/abort、retain-none/unknown role/kind、reload/fork/恢复费用不重收，旧 ctx 不跨 session；Main menu 普通消息不展开，ACK基于实际消费且同代成功 settled。owner hard-kill/断电恢复及 PID 原子性只引用运行/存储主题。 |
| **COMPAT-16/18** 交互/发布 | 新 mode gate/command expansion/duration/waiting_user 已有自动测试；人工 TUI/IME/theme/fullscreen、Windows/WSL快捷键、窄屏/resize/overlay、跨 OS、长 soak 仍待验证。 | 用户重启本轮 dist 后记录实际 Core 命令派发、焦点/IME/callback退出/主题invalidate、后台无闪窗、未知/失败状态不冒充成功。发布候选各资产/报告必须同构建，不将旧功能认证外推。 |

当前字段 `complete` 是已收到来源的金额覆盖；原生/用户/远程值都是估计，native 零价不承诺真实免费。Execution usage 保留 Main 小计，唯一 child invocation 回执单列，不再次纳入父预算基数。旧终态补账另定契约。

## P2：有需求时复用原生实现（尚未接入）

| 编号 / 依赖 | 方案 | 启用验收 |
|---|---|---|
| **COMPAT-19** MCP（02/03/07/08/15/17） | 三层权限相交后交 native createMcpExtension({loadConfig})，连接前过滤 server/config/注册项与 autoEnableCodemode；复用 stdio/streamable HTTP/OAuth/resources/进程清理。不补 legacy SSE，不自动重试副作用。当前受限 child 对非空 MCP fail-closed。 | 未授权 global/project/注册项零连接/零进程；授权/必需失效、OAuth刷新/关闭/重启、nested gate、usage、残留进程真实验证。 |
| **COMPAT-20** codemode/search（02/03/07/08/09/13/15/17） | 按需 native factory，先 `createCodemodeExtension({models:false})`；不重写 QuickJS/BM25。Core 控制工具保持 model-only/sequential，脚本 wrapper 复用同一工具/Core。受限 child 不默认加载 builtin。 | callable/exposure/nested hooks、structured/isError、脚本失败保留副作用/费用、branch store/load、cancel/输出上限；未授权 model helper 不出现。用户自行配置的 Main builtin 不等于 AgentFlux 已认证。 |
| **COMPAT-21** typed operations/router/provider 导入（02/04/05/08/13，必要时20） | 复用 native image/classifier/virtual；ModelRuntime 直呼须单独 operation/费用 gate，可用固定 wrapper 先检查再返回 usage。普通仅内存 custom provider 与 router 的执行代码也须受控导入，不能靠 snapshot 复制实现。当前否则准确拒绝、不隐式选最后物理响应。 | mixed operation、未知/无usage、真实 responseModel、失败/cancel、每请求目标、state retry/fork/恢复均对账；classifier质量单独验，不替代默认 reviewer/judge。未闭合前不打开受限 child models helpers。 |

## 验证与证据规则

- 最小相关测试 → verify → 独立 typecheck/build → diff/dist/package → 外部 fresh Pi/Provider；默认低成本、短提示、thinking=off、受限轮次/token/无关重试关闭。必要时按实际目录显式换可靠通道并说明，不提高原预算。
- local profile 的 Luna/max 默认不跟随 Main PI_MODEL；只有 AGENTFLUX_LIVE_* 显式覆盖优先。已有最新 Luna/off 是显式 fixture 选择，不把专用夹具和通用默认混淆。
- 原 360s隔离超时、runtime implementer预算失败/usage取消、各失败 gates、DeepSeek Provider watchdog 都保留，不改写历史 Task/Run 或用自然语言覆盖状态。后续修复必须重新验收并记录同候选范围。
