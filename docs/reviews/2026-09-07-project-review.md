# AgentFlux 全仓 Code Review — 2026-09-07

> 后续实施说明：本报告保留审查时的缺陷证据，不代表当前修复状态。2026-09-07 已开始首批代码修复；进度、剩余问题与测试要求以 [当前规划](../development-plan/00-index.md#2026-09-07-审查修复执行批次) 为准，尚未全部修复或真实验收。

## 结论与范围

审查基线为分支 `feat/agent-multirole-dogfood`、HEAD `35f4edb060970d5c2ef9105147ac61c962399556`。开始时已有 6 个未提交文档修改，全部保留；本轮不修改生产代码及既有测试，不改变 P0-02 第四次独立验收的 **rework** 结论。

**现有确定性门禁全绿，但仍确认 17 组待处理问题：12 组高风险、5 组中风险。** 其中 15 组通过 17 条隔离观察复现，2 组为静态调用链确认。高风险主要涉及消息不可达、提前 ACK、权限损坏后扩大、错误成功状态、恢复证据不足、GC 会话误归档和谱系错误；不是代码风格建议。

审查覆盖 Main 工具/CLI/TUI、Agent store/runner/会话、Workflow/质量门/checkpoint、Community、Message V2/RPC pump、权限、Task/Run Registry、JSON/锁/GC、配置/定价/telemetry 与构建及测试入口。采用关键调用链和跨模块契约检查，不是逐行形式化证明，也不表示未列模块已无缺陷。产品/架构要求本轮未更改。

## 问题导航

详细触发条件、源码位置、解决方案、依赖和验收用例只维护在当前规划，避免第二份任务清单。

| 编号 | 风险 | 问题 | 证据 | 唯一处理依据 |
|---|---|---|---|---|
| R01 | 中 | TUI 新建 Workflow / Main Talk 返回值无法正确分派 | 菜单函数→命令解析复现 | [入口与安全](../development-plan/01-entry-and-safety.md#r01-tui-新建-workflow-与-main-talk-断路中) |
| R02 | 高 | Issue 缺 verdict 默认通过；delete 实际 resolve | 实际工具 handler 复现，属已有 P0-03 | [P0-03](../development-plan/01-entry-and-safety.md#p0-03-community-工具契约) |
| R03 | 高 | flux_workflow 显式 task 被原始 prompt 覆盖 | handler reuse 复现；run/modify 同一数据流 | [R03](../development-plan/01-entry-and-safety.md#r03-flux_workflow-忽略显式-task高) |
| R04 | 高 | 局部执行成功覆盖 Main 最终失败，成本取局部结果 | handler + agent_settled 复现 | [P1-03](../development-plan/02-runtime-and-storage.md#p1-03-task-与-invocation-谱系) |
| R05 | 高 | 连续显式 new 覆盖活动 Task/Execution | 实际工具 handler 复现 | [P1-03](../development-plan/02-runtime-and-storage.md#p1-03-task-与-invocation-谱系) |
| R06 | 高 | sender Run 与 recipient Run 混用，peer direct/group 不可达 | runtime、bus、RPC pump 复现 | [P0-06](../development-plan/01-entry-and-safety.md#p0-06-message-v2-单一路径) |
| R07 | 高 | 损坏 capability override 被当不存在，恢复更宽模板权限 | 保存→损坏→解析 effective policy 复现 | [R07](../development-plan/01-entry-and-safety.md#r07-持久-capability-override-损坏会扩大权限高) |
| R08 | 高 | checkpoint 无结果也能 passed，resume 成本归零 | executeDAG 复现；写失败吞错静态确认 | [P1-04](../development-plan/02-runtime-and-storage.md#p1-04-checkpoint-与-resume) |
| R09 | 高 | GC 不识别当前 session 命名，误归档仍被引用的文件 | 实际隔离 GC 复现，有 archive | [P1-05](../development-plan/02-runtime-and-storage.md#p1-05-数据和输出边界) |
| R10 | 高 | Agent GC 越过 session 可见性，引用保护不完整 | 隔离 global/home 的 GC 复现 | [P1-06](../development-plan/02-runtime-and-storage.md#p1-06-session-agent-隔离) |
| R11 | 中 | 自动去重名称含括号，create 成功但 capability 拒绝运行 | create→policy 复现 | [R11](../development-plan/01-entry-and-safety.md#r11-自动去重名称无法运行中) |
| R12 | 中 | 同 terminal status 更新仍可改历史成本/outcome | Task Registry 复现 | [P1-03](../development-plan/02-runtime-and-storage.md#p1-03-task-与-invocation-谱系) |
| R13 | 高 | 以 assistant 响应次数猜消费，followUp 被提前 ACK | pump 当前任务多轮响应序列复现 | [P0-06](../development-plan/01-entry-and-safety.md#p0-06-message-v2-单一路径) |
| R14 | 中 | 默认 live smoke 使用已移除 flux_team 和源码入口 | package script→fixture 静态确认 | [R14](../development-plan/03-real-validation.md#r14-默认-live-smoke-仍依赖已移除入口中待修复) |
| R15 | 中 | 活跃 Workflow 的删除门禁比较了两类不同 ID | 活 lease + 关联 Task + 实际 handler 复现 | [R15](../development-plan/01-entry-and-safety.md#r15-正在使用的-workflow-定义仍可删除中) |
| R16 | 高 | judge 独立 spawn，缺统一 Run/聚合预算链路 | DAG→judge 实际代码静态确认 | [运行补充项](../development-plan/02-runtime-and-storage.md#2026-09-07-全仓审查补充运行项) |
| R17 | 高 | Agent fork 复制 session key，不是真实 Pi 分支 | create 复现 + runner 参数链检查 | [运行补充项](../development-plan/02-runtime-and-storage.md#2026-09-07-全仓审查补充运行项) |

R02、R08、R10 已有相应规划，本次补足根因和反例，不重复立项。R06/R13 是现有消息主题中的新增具体缺陷；其他 R 项在对应主题新增。原 P0-02 覆盖退化、成本账务限制和 P1 数据容量缺口继续保留，不因本轮通过测试被关闭。

## 验证证据

### 确定性门禁

以下均 exit 0：

```bash
npm run verify
npm run typecheck
npm run build
node --check dist/extension/entry.js
node --check dist/extension/subagent-entry.js
npm pack --dry-run --ignore-scripts --json
npx tsx .agentflux/test-results/project-review-repro.ts
```

最后一项是**确认当前缺陷存在**的审查探针，不是期待正确行为的 regression suite。它直接调用真实源码函数/注册的 handler，FakePi 只捕获注册并模拟事件，不调用 Provider；复现依赖 OS 临时目录。GC 测试还隔离 HOME/USERPROFILE 并核对 homedir，因此没有回收用户的 global Agent 或项目已有会话。

本地证据位于 `.agentflux/test-results/`（按项目惯例不纳入 Git）：

- `project-review-verify.log`、`project-review-typecheck.log`、`project-review-build.log`：完整门禁输出；verify 包含既有 27 个测试脚本。
- `project-review-repro.ts`、`project-review-repro.log`、`project-review-repro.json`：可重跑探针、观察结果和 fixture 路径。
- `project-review-package.json`：dry-run 包清单；只是检查打包边界，不是无源码安装运行验收。
- `project-review-dist.json`：本轮 build 的 production 入口大小和 SHA-256。
- `project-review-live-observation.json`：实际派发子代理的 Run/Task/Execution 快照与失败事实。
- `project-review-diff-check.log`：最终 whitespace 检查；只有既有 CRLF 提示不构成失败。

探针的最终 fixture：`C:/Users/y1582/AppData/Local/Temp/agentflux-project-review-sbKhnz`；上一轮探针 fixture 也保留。文件归档反例只发生于其中的测试项目。

Production 入口 SHA-256：

| 入口 | SHA-256 |
|---|---|
| `dist/extension/entry.js` | `baa28e1595bf2d98247553fbd6512625ded7bbfa73265e029e95f79056ddf34f` |
| `dist/extension/subagent-entry.js` | `3ae5f54e6c3087806bed85aa013356c1286fc4ffa1d879563614bdaca02a5f41` |

### 当前环境真实功能调用

本轮实际通过 `flux_agent run` 派发 `review-storage`、`review-workflows`、`review-runner`，并通过 list/inspect 核对 Core。它们继承 Main 的 `openai-codex/gpt-6-astra`，未显式覆写模型/thinking，均在父 Task `$2` 成本上限触发后失败，未产出完整独立评审报告。child Run 记录成本分别为 `$0.743068`、`$0.899506`、`$0.594638`，合计 `$2.237212`。并行在途调用可造成超额，这次不能仅凭超额判断预算门禁失效。

未提高预算、未用新 Task 重试绕过限制。后续结论由主代理自行核验，不冒充“三方独立 review 通过”。使用的是原 Main 已加载的扩展；build 在本轮稍后生成，因此这段真实调用**不是 fresh production build 验收**。终态 Run 清空了 PID，未捕获独立退出回执，不能声称完整进程树清理已核实。

## 限制与交付

- 这是问题分析及修复规划交付，**不是修复发布**；确定性测试全绿不代表上述缺陷已关闭。
- 本轮没有重新调用付费 planner/judge 做专项复现，没有新的 resume/长期 soak/跨平台原生 TUI/安装包运行报告；R13/R17 的完整 Pi 消息/分支场景也尚待真实验证。
- 现有 P0-02 rework 和依赖顺序不变。后续修复须遵循对应规划的 Core/入口/持久化一致性与 fresh Pi 验收，不用放宽断言或删除失败报告来结项。
- 只更新当前主题规划、审查导航及续接事实；原用户文档改动保留，未提交 Git、未清理历史任务和证据、未聚焦或修改已有 persistent goal。
