# 2026-09-08 GC 引用与消息故障验证阶段

本文件保存已实现、已验证或被替代的阶段记录。后续事项仅在当前规划维护；不代表 R01–R17 全部关闭。

## 已完成实现

- Core 新增 host-wide 同步引用 fence F，跨同 realm 模块副本重入，不跨 await；顺序 F→既有 store，保留 Workflow→Task、active-context→Issue 顺序。
- Run/Task team/Claim 使用显式稳定 agentId，Workflow DAG selector 在 F 内重新解析。GC-first 后缺失/歧义/不可访问身份在写入前拒绝；旧 name-only 引用保守兼容，逻辑 Claim 不伪装成注册 Agent，persistent Run 不等于注册 Agent。
- Agent 删除、session 清理、维护 GC 与 native fork 创建/登记参与 F；候选按稳定 ID 匹配。session owner、空 ID、Claim 前置拒绝与 lease 回滚可见性、fork 普通登记失败的未提交目标回滚均补齐。无跨项目索引时拒绝 global 删除。legacy Issue 迁移在 F→Issue 锁内重新读取。
- Host 启动正文中的消息 ID 传给子 Pi，RPC 在本次 Run 内不重复接管；新 Run 仍可重投未确认消息。启动 poll 与 RPC 使用配置的同一 lease，初始正文保留可显式 ACK 的消息 ID。
- RPC poll 的 mutex 错误不再形成未处理 Promise 拒绝而退出 Pi；记录可见错误及审计，保留 delivery 后续恢复。审计回调异常不能撤销已接受队列或重排消息。
- 外部 signal 无显式 Host 终止码时记失败，不冒充用户取消；显式取消/deadline 仍保留优先级。

## 确定性与独立审查

- `test-agent-reference-fence.ts`：93 项；Run/Task.team/Claim/Workflow × writer-first/GC-first × 三种删除入口的真实双 Node 竞争，并覆盖损坏、锁序、fork/session 归档窗口及同名不同 TTL。
- `test-agent-reference-boundaries.ts`：owner、逻辑 Claim、空 ID、拒绝无新 lease、fork 写失败回滚和真实 Node signal 退出。
- `test-startup-inbox-ownership.ts`：同 Run 启动排除、虚拟长忙、普通 follow-up、新 Run 重投/ACK、真实 mutex 超时后恢复及审计异常。
- 消息 helper 保留原始文本匹配，并另计无 error/工具调用且 stopReason=stop 的成功终态；error-only 不通过，两次成功不去重。注入仍要求每个物理 session 恰一次、delivery attempts 恰 1→2。
- Luna/max 委派交付及两次限定 code review 完成；第二次结论 APPROVED，非全项目独立验收。原文位于 `gc-reference-closure/independent-review*.md`。
- 最终 `npm run verify`、独立 `npm run typecheck` / `npm run build`、三 dist 语法、两入口动态导入、`git diff --check`、package dry-run 通过。日志在 `.agentflux/test-results/gc-reference-closure/`。

## 同一候选的真实验证

`gc-reference-closure/summary.json` 核对同一三资产构建下八个脚本的最新结果：

| 脚本 | 核对范围 |
| --- | --- |
| dogfood:restart | fresh Main、多角色子 Pi 与 Core 终态 |
| test:live:gc-references | 实际 Run→稳定 Claim 引用保留 Agent/session→提交/审核/解决/删除后 GC |
| test:live:native-fork | 原生独立会话、继承记忆、名称负例、SDK/Run/父回执费用 |
| test:live:p0-07-controls | steer/ACK、显式停止及父取消 |
| test:live:message-busy | 真实长忙时 normal follow-up 只投递/注入/ACK 一次 |
| test:live:message-peers | sender Pi 实际 direct/group/broadcast；peer 收件人 ACK |
| test:live:message-redelivery | 自有接收 Run 强杀、Host ACK mutex 丢失；新 Run 重投及 ACK |
| test:live | direct、agents、Workflow、Community 四场景 |

- 第五轮目录：`live-1788865636983-16696`；同候选四阶段基础验证目录：`live-1788864269200-22916`。不是把不同构建合并为一次候选验收，也不删除先前失败。
- 最终消息四阶段均通过：crash 首 Task/Execution failed，随后恢复及 ACK-loss 两阶段 completed；两条消息均 attempts=2、acknowledged，每个物理会话一次注入，成功终态一次。Host ACK 失败日志与锁持有进程证据保留。只覆盖 uncorrelated 消息，不扩张为全部旧 Run fence 负例。
- Main 独立核查 25 个保留 fixture 的三资产及 Core/会话证据；165 个已记录 PID 的原测试进程退出检查通过。部分整数 PID 已被新进程复用，以 Win32 CreationDate 区分，没有停止新进程。不是“所有 PID 数字不存在”，也不是未观测孙进程退出证明。
- 实际路由 `openai-codex/gpt-5.6-luna`、max；父预算仍 $2/8 iterations/4 parallel，没有默认执行 deadline，测试 watchdog 独立。持久 Execution 记录成本合计约 $0.15407948，包含旧失败轮的不完整记录，不代表完整 Provider 账单。

## 必须保留的失败

1. 启动消息被同 Run RPC 再排入 followUp，attempts=2，协调条件失败：`startup-inbox-live-failure.json`。没有声称该排队副本在清理前已被消费。
2. ACK-loss 触发 mutex timeout，未处理 tick 拒绝导致子 Pi failed：`ack-loss-poll-failure.json`。
3. 后续 ACK 链已完成，但 helper 把带 marker 的 WebSocket error 帧算作成功，2≠1：`provider-retry-facts.json` 保留原失败。另证明该子 Run 在真实 Provider 自动重试后 completed、父 Task completed，不回写旧终态。
4. peer Main 用 name 代替 agent 多调用一次，4≠3：`peer-selector-failure.json`。提示改为精确参数，原三 run 断言保留，并加强为两 create/一 group_create/零 read。
5. 两次汇总先因 PID 存活失败；32336 随后不存在，其当时身份未记录；32856 由 CreationDate 证明是后生进程。失败日志、失败 summary、重查记录都保留；最终核验增加出生时间，不猜测或杀掉同编号进程。

## 保证边界

F 不是多文件崩溃事务，不覆盖旧二进制、外部直接写 session、跨 VM realm 重入或未知 global 跨项目引用。历史 key/retention、Core 出生身份、Workflow hard-kill、旧名称/消息迁移、完整故障账务、TUI/跨 OS/发布 soak 等仍按当前规划推进。当前交互 Main 不因 build 热加载，需用户重启才使用新增逻辑。
