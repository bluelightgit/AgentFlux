# 双后端重启验收

日期：2026-10-06。分支 `feat/dual-agent-runtime-2026-10-02`，HEAD `35f4edb`，保留既有dirty工作树。实施内容与此前Pi1.0完整限定验收见 [实施报告](2026-10-02-dual-runtime-validation.md)。本轮没有修改业务/依赖/生产资产或重新执行整套测试。

## 本次实际验证

用户确认重启后，在当前交互Main直接调用两次 `flux_agent run`，tester/fresh/同步/只read一次package.json。使用角色显式 `openai-codex/gpt-5.6-luna`、max，没有覆盖Main或角色模型/thinking，没有扩大原$2父预算或增加默认deadline。

| 后端 | Core Run | 终态 / 费用估计 | 身份 / 清理 |
|---|---|---|---|
| process | `subagent-d0edab10-13fa-48e5-a4d9-3458a8d06b49` | completed、2turn、$0.0011368 | 独立child PID11856，出生身份对应进程已dead |
| sdk | `subagent-9a2f0149-a1e8-4ed4-8f32-3fc4c548b404` | completed、2turn、$0.00086492 | 与Main PID12828/同birth，独立session/generation，无child PID；sdk_closed记drained/disposed |

- OS Main实际是全局bundled CLI，Host manifest/运行期SDK/选定子CLI均 **1.0.4**，sameVersion=true，SDK来自同一全局包。项目dev Pi仍1.0.0；此次没有手动对齐开发依赖或重建，证明这一patch组合的Host facade跟随有效，不代表任意未来版本自动兼容。
- 两session均恰好一次read，精确marker正确，generation1 receipt outcome=completed、terminalFailure=false、continueRequested=false；金额/归属complete=true、provisional=false。父Execution两个invocation回执标记保留、金额和Main+child对账一致；快照时父仍running，不能提前宣称最终settled。
- SDK测试仅临时添加subagent_runtime=sdk，完成后原配置逐字节恢复（仍默认process），用户Pi settings未变；174产品文件与四生产资产hash仍匹配10月2日最终候选。Main同birth仍alive，未停止Host。无需再次重启。
- 两次子Run估计合计$0.00200172，不是账单、全部Main分析费用或全部历史费用。

证据 `.agentflux/test-results/dual-runtime-2026-10-02/post-restart-2026-10-06/`：`summary.json`、`core-raw.json`、原配置/settings备份及`check-attempt3.log`（exit0）。check前两次因证据脚本误读Task数组、误以terminalFailure应缺省而失败，已依真实schema修正并保留日志；未放宽业务断言或修改历史。

**范围**：新入口/Host绑定与两种后端短真实调用验证完成；不替代Pi1.0.4完整发布审查、人工TUI/跨OS、hard-kill、不合作工具或soak认证。剩余范围仍在 [当前兼容规划](../development-plan/04-pi-compatibility.md)。
