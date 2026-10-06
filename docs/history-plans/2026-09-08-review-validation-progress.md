# 2026-09-08 审查修复与验证阶段摘要

本文件归并已完成阶段和被替代的验证记录；未完成任务以 `../development-plan/` 为准，不代表全部 R01–R17 结项。

- 第一批完成 R01/R02/R05/R06/R07/R09/R10/R11/R12/R13 的核心修复与回归；之后加入 R03/R04/R08/R15。批次证据分别为 `review-fix-batch1.json`、`review-continue-batch2.json`。GC 并发、迁移及真实恢复没有因本地通过而关闭。
- DeepSeek 真实续接遇到 Provider 401/余额不足并停止后续付费验证；失败 Task、两个成功子 Run、被中断进程与工作区均保留。不得将中断称作通过。
- 用户随后指定 Luna/max；本地角色和非归档 Agent 完成带备份迁移，历史 Task/Run 不改写。`luna-validation-summary.json` 记录早期三项 live 通过，但旧 deadline fixture 的现场只留非原子采样，不冒充完整最终快照。
- 用户取消固定 600 秒限制；项目覆盖设为 null，Core 原默认不变。`no-default-deadline/summary.json` 记录 fresh 无默认 deadline、统一 judge Run 成功与显式 deadline 测试；未提高成本预算。早前两次委派触及旧 deadline 的失败记录保留，之后在新无 deadline Task 上重新实施。
- R14 的默认 smoke 改为当前 direct/agents/workflow/community 四场景、production dist、精确 marker/Core/输出证据和保留工作区。第一轮因输入预算耗尽失败；收窄节点要求而不提高 60000 输入预算后，`function-closure/live-1788795202094-5680` 四场景通过。
- R03 四阶段真实 Workflow 请求/修订/旧版本对照、R17 原生 fork 两次继承记忆、peer 三通道、双 Pi controls、70 秒 busy followUp 均取得限定构建的真实通过证据。不同构建不可混作一次最终候选全量验收。
- R13 真实重复 followUp 原因是 busy 期间丢失已接受队列 fence；修复后单次 busy 投递/消费通过，原 91-turn 现场保留，不扩大为崩溃重投验收。
- P0-02 第四次 Main failure sibling 覆盖返工取得独立 Luna PASS，绑定 `live-1788795202094-5680`；详见同目录 P0-02 历史摘要及 `function-closure/p002-current-independent-verdict.json`。旧第四次报告保持 rework，不回写。
- 费用新增实证：模型身份元数据被误当作 user 零价，遮蔽 SDK 非零费用。过滤假报价并统一 Main/Run 来源选择后，`function-closure/pricing-live-1788799562174-19676` 的非零 native 对账与 Workflow/deadline 通过；同轮 smoke 被 watchdog 中断，保留 running Core 现场。这不是供应商账单或历史账务修复完成。

## 保留的更早 P2 基线

P0-05/P0-07 已验证在线遥测、模型不可用/overload/retry、dead-owner restart、active-parent/owner-fence replacement、双 Pi controls、fan-out、长时与显式 deadline 等基线。P2-04 早期实际 `flux_task continue/retry` 已验证，不能误记为从未执行；但新改动后的完整 history fixture 仍需升级验证。

更早 package/soak 等证据路径：`.agentflux/test-results/p0-07-{long,fanout,workflow-deadline,package-boundary,soak}-latest.json`。它们不替代当前候选的跨 store writer fence、规模容量和无源码发布复验。
