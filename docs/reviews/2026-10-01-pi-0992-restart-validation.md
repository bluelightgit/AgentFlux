# 用户重启后 Pi 0.99.2 版本漂移修复与验证

日期：2026-10-01 UTC。原 [0.99.1 验证报告](2026-10-01-pi-migration-validation.md) 保留为上一个候选，不改写其成功或失败。本次当前规划见 [04](../development-plan/04-pi-compatibility.md)。

## 发现与修复

用户重启后，真实 Agent 一次只读调用成功，返回 `PI099_POST_RESTART_OK`，费用估计$0.00089332、Run completed、同代completed receipt、子PID退出。**这仅是功能通过**：原SDK来源和子CLI均0.99.1，进一步读取Main OS命令及对应manifest发现全局Pi已在09:40升级为0.99.2。严格版本对账失败，不将首次SDK-only通过冒称完整Host验收。

根因是bundled Pi的production ESM扩展可走native import，公共SDK从项目node_modules解析；仅getPackageDir/VERSION不能证明实际Main CLI。已修 `src/core/pi-runtime.ts`：

- Node argv只在同名Pi manifest与bin精确realpath吻合时证明实际Pi入口，选择该Host根启动child；普通SDK caller不能冒充Pi入口。
- 公共SDK版本必须与确认的Main CLI相同，错版在spawn/Run登记前拒绝；bin的realpath越出package也拒绝。
- Run provenance区分selectionSource、SDK目录/版本、真实process entry；Core校验新增字段。四Pi开发依赖对齐0.99.2，SDK仍external；不复制SDK实现、不猜SDK caller PID/入口。
- live fixture新增test-only `AGENTFLUX_LIVE_PI_PACKAGE_DIR`，仍校验SDK VERSION/manifest/bin，以真实**全局0.99.2 bundled CLI**作为本次Main，并验证child确实来自同一全局根。

0.99.2新增契约已复核：MCP的稳定description/system section、namespace normalization/search、OAuth clientName/provider bearer及连接等待变化、reload启用新增defaultTools；native provider初始化、strict schema、retry、model lookup等修复。受限child仍no-extensions且拒绝非空MCP，未新增授权能力；Main自行启用的MCP/codemode不属于本次完整认证。

## 验证与持久事实

证据根：`.agentflux/test-results/pi-migration-2026-10-01/pi-0992/`。

- runtime最小测试、完整`npm run verify`、独立`npm run typecheck`和`npm run build`全部exit0。
- built Main/子入口真实SDK确定性探针、CLI本地HTTP mock均exit0；mock不是付费Provider或实际cache warming认证。
- 全局0.99.2、production入口、显式Luna/off的八类fresh真实Provider复测全部通过：外部dogfood多角色、Core direct/agents/Workflow/Community、Task history continue/reuse/retry、peer ACK、native fork、业务Workflow resume、online telemetry及模型拒绝、busy followUp。监督器未传old-pid，没有停止当前Main。
- `summary.json`重新读取八份报告与原始Task/Execution/Run：27实际Runs均终态；每个Run Host/SDK/CLI=0.99.2、selectionSource=validated-cli-entry、实际入口等于child CLI、Host根为全局安装；三dist与fixture哈希相同。Main/唯一invocation小计、Core child一次计费与费用完整性通过；51记录原PID按birth核验退出。
- 八fixture唯一Execution费用估计合计$0.04649400000000001；不是账单，不含全部开发Main费用，不提高当前父$2预算。
- `npm pack --pack-destination .../pi-0992`、production syntax/import和`git diff --check`通过；打包与解包资产进一步核验见final-assets日志。不是跨OS/独立安装器/全面发布认证。

最新entry SHA256：`a44099e5e9172f6f1ebfc1f6dffaaaa6cb4648892aea898914a9461329eeae16`；subentry/preload与原候选一致。源码/工作树保留、未提交。

## 失败保留与下一步

`post-restart-check-attempt2.log`的0.99.2/0.99.1失败、原只读Agent记录及SDK-only摘要保留；首次collector bootstrap regex失败和修正后的成功也保留，不放宽同版或金额断言。

**当前交互Main仍缓存上一候选和0.99.1 SDK；build/npm install不能替换已加载模块，须用户再次重启。** 已通过的是外部fresh全局0.99.2进程，不冒称当前会话已热更新。重启后再做短调用核对本轮入口/provenance。

人工TUI/IME/theme/闪窗、跨OS/SEA/Bun/最低Node/source checkout、soak、真实warming、完整MCP/OAuth/codemode/router授权、旧PID握手/owner强杀仍不在此次认证范围。
