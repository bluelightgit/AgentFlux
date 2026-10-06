# AgentFlux 功能状态（2026-09-07 历史阶段）

本文保留当时状态；最新逐功能实现/测试/真实使用情况见 [2026-09-08 报告](2026-09-08-function-validation.md)。

## 结论

**尚未全部完成。当前是核心流程可用、可靠性与验收仍在收口的开发版，不能描述为已稳定交付。**

不提供没有统一权重和验收分母的“整体完成百分比”。原审查 17 组问题中，15 组已有至少部分代码修复；R14 默认 smoke、R17 Agent 原生 fork 尚未实施。这个计数不是 15 组已结项，更不是产品完成度 88%。详细任务与验收唯一见 [当前规划](../development-plan/00-index.md)。

## 功能与验证边界

| 能力 | 当前可用部分 | 尚不能承诺的部分 |
|---|---|---|
| Main 与 Agent 调度 | 创建/运行/观察/停止/steer、多角色与 shared/fresh；Luna/max 多角色真实通过，当前子代理也确认了模型/推理配置 | 新实现的全面异常交错覆盖、权威费用对账仍不齐全 |
| Workflow | planner→DAG 节点→质量门、依赖/并行、定义版本、显式 deadline 有真实通过记录 | judge 统一 Run 的成功/父 deadline 继承已通过新真实验证，预算耗尽/主动取消仍以定向回归为证据；Main 正式 DAG 节点尚未实现 |
| Task/历史/恢复 | Task/Execution/Run 事实、continue 谱系、错误收敛、历史同终态保护；新 checkpoint 校验/原子写/新执行恢复已有回归 | 新 checkpoint schema 的真实中断/resume、完整后台/异常费用补齐仍待验收 |
| Community | Issue/Claim/提交/评审/关闭入口已存在；缺失 verdict 与物理删除已修复并有本地测试 | 真实完整 review/resolve 流程尚未收口；空间冲突通过不等于该流程通过 |
| 消息协作 | Message V2 direct/group/broadcast、sender/target Run 区分、实际消费后 settled ACK 已有代码与回归 | 旧 V1 路径仍共存；新 peer/ACK/崩溃重投的双 Pi 验收未闭合 |
| 权限与持久化 | capability 损坏 fail-closed、PID-aware 锁、session 所有者与引用保护、新名称生成已有修复 | GC 跨存储并发 fence、旧名称迁移、所有 session/fork 边界仍有缺口；不是 OS 沙箱 |
| TUI | Tasks/Agents/Workflows/Community/Messages 等入口已存在，Main Talk 与新建 Workflow 路由已修复 | 新菜单的完整交互式 Pi/TUI 验收尚不齐全 |
| Fork 与并行写隔离 | Main `/flux fork` 已使用 Pi 分支入口；现有 workspace/文件门禁可用 | Agent `forkFrom` 仍非原生独立分支；自动 worktree/checkout 创建、合并与清理闭环未完成 |
| 长时与发布 | 已有专项 no-deadline 长运行、fan-out、package/soak 历史证据 | 数据全量增长/GC/并行写等更广 soak 未完成；默认 `npm run test:live` 仍过时，不能当作当前完整验收 |

## 本轮实际完成与失败

- **R16 核心代码**：删除 quality-gate 私有进程执行器，复用统一 runner，继承父任务成本/轮次/token/并发与 deadline；judge attempt 有独立 Core Run、在线 usage 和 gate 关联，预算/取消/timeout 不再当解析错误重试。新定向测试 6 组通过。
- **本地门禁**：完整 `npm run verify`（29 个测试脚本）、独立 `npm run typecheck`、`npm run build`、dist syntax/import、`git diff --check` 通过。证据入口 `.agentflux/test-results/continue3-validation-summary.json`。
- **委派未完成**：P0-02 独立 reviewer 和 R14 implementer 均实际运行 Luna/max，但达到同一父 600 秒 deadline 后 `timed_out`；最后会话仍为 toolUse，无最终交付，R14 未写入代码。没有增预算或重派。证据 `continue3-delegation-failure.json`。
- **真实验证范围**：此前 `luna-validation-summary.json` 的多角色、P0-02 空间隔离、Workflow/deadline 三项真实通过仍有效，但只针对上一构建，不能覆盖本轮新的 judge runner。新 fixture 已增强 judge Run 关联、精确最终 marker、完整输出与现场保留，尚未实跑。
- **验收门禁**：P0-02 仍保留独立验收 rework，不能仅凭执行者的成功报告解除；金额为零或测试固定价格不证明真实账单准确。

## 最新补充：移除项目固定时限后的真实验证

用户再次确认重启并授权取消固定 600 秒项目限制。配置仅将 max_wall_clock_seconds 改为 null，其他预算不变；Core 默认原本就是无 deadline。完整确定性门禁及 fresh Luna/max dogfood 多角色、Workflow/deadline 两项通过：Task/Execution/两个多角色 Run 无 deadline，两个新 judge 的 Run/父谱系/usage/费用精确一致，显式 deadline 仍正常收敛。证据 `.agentflux/test-results/no-default-deadline/summary.json`；原现场和完整输出保留。此证据取代上文“新 judge 尚未实跑”的阶段状态，但不证明权威定价或关闭其余审查项。

当前工作树未提交；本轮未改 production 源码，dist 与上一轮 R16 一致。当前 Main 已缓存的 600 秒配置不会热改，下一次新 Pi 读取 null；未再做 >600 秒 soak。剩余工作以三个主题规划为准，本报告只呈现事实，不另建任务清单。
