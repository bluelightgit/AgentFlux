# 历史开发规划

本目录只保存已经完成、被替代或不再作为当前依据的规划摘要。历史内容用于追溯，不得直接作为新任务依据。

当前任务只看 `docs/development-plan/`。新规划建立或主题重排时，先归档已经完成的当前规划文件，再创建新的当前规划文件，并同步更新产品、架构或续接文档中的链接。

| 文件 | 状态 | 内容 |
|---|---|---|
| [2026-08-foundation.md](2026-08-foundation.md) | 已完成 | 统一 Agent、模型继承、角色能力和基础 Registry |
| [2026-09-multirole-dogfood.md](2026-09-multirole-dogfood.md) | 已完成 | 多角色 Workflow 绑定和 production dogfood |
| [2026-09-p0-01-p0-04-workflow-core.md](2026-09-p0-01-p0-04-workflow-core.md) | 已完成 | Workflow planner、DAG 节点、质量门和显式 deadline 真实闭环 |
| [2026-09-p0-02-space-isolation.md](2026-09-p0-02-space-isolation.md) | 返工限定快照独立 PASS | Main 失败 sibling 覆盖已恢复；保留旧第四次 rework，不外推新构建/账单 |
| [2026-09-p0-05-run-telemetry.md](2026-09-p0-05-run-telemetry.md) | 已完成 | Core Run 在线遥测、错误分类和 production model recovery |
| [2026-09-p0-07-agent-control.md](2026-09-p0-07-agent-control.md) | 已完成 | Agent inspect/steer/stop、nullable deadline、health 和父 Task 聚合预算 |
| [2026-09-08-review-validation-progress.md](2026-09-08-review-validation-progress.md) | 阶段归并 | 已完成/被替代审查与验证批次；未完成范围仍在当前规划 |
| [2026-09-08-recovery-entry-validation.md](2026-09-08-recovery-entry-validation.md) | 阶段完成 | 业务失败恢复、Task history、runner 重试错误与费用精度；保留失败证据 |
| [2026-09-08-english-background-validation.md](2026-09-08-english-background-validation.md) | 阶段完成 | 英文无 emoji、Windows 子 Pi 后台兼容层、同构建验证与失败保留；人工复验仍开放 |
| [2026-09-08-gc-message-validation.md](2026-09-08-gc-message-validation.md) | 阶段完成 | GC 共同引用 fence、消息强杀/ACK 丢失重投、同构建八类 live 最新通过；保留失败与 PID 复用证据 |
| [2026-09-08-pid-identity-validation.md](2026-09-08-pid-identity-validation.md) | 局部阶段完成 | 出生字段/异步核验、启动异常与实际退出、Luna/max 验证；首次握手/接管/原子性仍开放 |
| [2026-10-01-pi-099-migration.md](2026-10-01-pi-099-migration.md) | 必需迁移阶段完成 | Pi 0.99.1、原生账务/权限/协议/模型/session 适配、同候选八类 fresh 调用；可选接入/人工/跨 OS 等仍开放 |
| [2026-10-06-v0.1.3-release.md](2026-10-06-v0.1.3-release.md) | 发布/拉取限定完成 | main/tag/四CI/Publish/Release/npm真实拉取及下载包双backend；远程Live外部Provider配置仍失败 |
| [2026-10-02-dual-runtime.md](2026-10-02-dual-runtime.md) | 初阶段完成 | Pi1.0、Host SDK facade、配置驱动process/SDK、两模式各10类真实验证/本地安装；UI/故障/平台/长期组合仍开放 |
| [2026-09-plan-v1.md](2026-09-plan-v1.md) | 已替代 | 旧版集中任务规划迁移到主题化当前规划 |
