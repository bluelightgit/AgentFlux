# 2026-10-02 Pi 1.0 / 双执行后端阶段摘要

原规划 COMPAT-23 同版候选、COMPAT-22 初阶段配置/driver/Host绑定已实施并取得限定验证；不替代人工UI、故障、平台、soak及可选接入验收。

- 分支 `feat/dual-agent-runtime-2026-10-02`，HEAD `35f4edb`，保留用户与前序 dirty 工作树，未提交。
- 四 Pi 开发包1.0.0，peer>=1.0.0，Node>=22.19.0；TypeBox开发1.3.34/Host1.3.27。
- `subagent_runtime=process|sdk` 默认process，按新Run冻结，未知值拒绝；SDK Main内独立session，与现有Core共享权限、费用、Message V2、谱系、checkpoint及终态，不静默fallback。
- `dist/extension/host-entry.ts` 公共loader SDK facade +唯一 `entry.js` bundle，验证Main公共类identity；避免native ESM遮蔽。SDK逻辑owner有Host birth/Run generation/session；不能杀Main、按共享PID误释放锁或以dispose代替idle。
- 专项mock .73账务、同PID隔离、cancel/Main续请求、baseline/配置冻结/预算/锁与失败cleanup进入完整verify。两模式各10类production fresh Provider验收，64 Runs/54 Executions，限定估计费用$0.09401536；Luna/off、预算原值、无默认deadline。
- 本地 `pi install` 与两个模式自动加载插件真实调用通过；用户其他Pi配置保留，安装器仅正规化该已有本地路径的斜杠。当前Main未热更新，需要用户重启，未停止承载Host。
- 首SDK真实拒绝、wrong public helper、夹具/编译/collector失败全部保留；最终资产fingerprint/pack/diff见证据，不改历史制造成功。

实现、命令、数据来源、失败、SHA256与未认证范围见 [完整实施报告](../reviews/2026-10-02-dual-runtime-validation.md)，原始依据 [Pi1.0审查/SDK影响](../reviews/2026-10-02-pi-1.0-sdk-impact.md)。证据 `.agentflux/test-results/dual-runtime-2026-10-02/`。后续未完成内容仅在 [当前兼容规划](../development-plan/04-pi-compatibility.md) 与 [真实验证主题](../development-plan/03-real-validation.md)。
