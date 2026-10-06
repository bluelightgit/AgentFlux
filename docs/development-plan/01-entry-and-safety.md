# 当前规划：可用入口与安全边界

更新：2026-09-08。只保留未闭合范围。原始问题、定位和复现见 [全仓审查](../reviews/2026-09-07-project-review.md)，逐功能事实见 [验证报告](../reviews/2026-09-08-function-validation.md)。已完成批次见历史摘要。

P0-01/P0-04/P0-05/P0-07 已归档；P0-02 Main 失败 sibling 返工已在指定快照独立 PASS，见 [P0-02 历史](../history-plans/2026-09-p0-02-space-isolation.md)。旧第四次报告不改写，后续构建仍按 03 的范围验证。

## P0-03 Community 工具契约（R02）

- **现状**：Core/tool 穷尽分派，缺失/非法 verdict 拒绝；delete 物理删除。单测验证拒绝前后 Issue/lease 不变、active claim 保护及合法删除；真实 create→claim→submit→review pass→resolve 已通过。
- **剩余**：缺 verdict/非法 verdict/物理删除等负例的完整工具/CLI/TUI 同参对照与 fresh 入口验证，预算/轮次/停滞边界。
- **验收**：复用同一 Core 状态机；拒绝不得改变 Issue/lease；终态不误改；删除后 get/list 不再存在。空间夹具的 executing Claims 不替代 review/resolve 验收。

## P0-06 Message V2 单一路径（R06/R13）

- **现状**：senderRunId 与目标物理 Run fence 分离；runner 只注入 V2，V1 writer 拒绝并保留历史只读/group 注册表。实际消费批次 token 后成功 settled 才 ACK；busy 已接受队列不因握手 watchdog 或旧任务 settled 丢失 fence。
- **已覆盖**：跨 Run runtime/RPC、旧 steer 不进入 replacement、配额/完成契约、未消费/错误/取消/迟到批次回归；peer direct/group/broadcast 到目标收件人 ACK；双 Pi controls；真实 normal 消息忙 70006ms 后一次注入/投递/ACK。
- **剩余**：全部自动 retry/compaction 组合、所有 group 收件人及 Main unread TUI；旧 Run fenced 消息的全部 fresh 负例、真实容量/背压与显式旧消息迁移。
- **验收**：delivery、ACK、重投/背压只使用 V2；不重复消费、不提前 ACK、不把旧 steer 投入新 Run。旧 V1/correlation-only 消息不猜测 sender/target，不放宽 fence 或自动重写历史。
- **本轮完成**：启动消息由 Host 持有，RPC 排除本 Run 已注入 ID；poll mutex 失败可见并恢复，审计异常不重排已接受队列。真实强杀与 Host ACK 丢失均经过新 Run，恰两次投递/两份会话各一次注入，最终 ACK；四个 Main 阶段的精确调用、成功终态及 Core 父状态通过。`gc-reference-closure/summary.json` 与 [阶段摘要](../history-plans/2026-09-08-gc-message-validation.md) 保存同构建验证及全部失败，不扩张为所有消息边界关闭。
- **失败证据**：旧 watchdog 重复、启动消息再次排队、未处理 mutex 拒绝、Provider error 帧误计成功及 peer 参数错误均保留；不是仅用 busy 成功替代故障验收。

## UX-01 英文产品文案与无 emoji（2026-09-08 新增）

- **状态**：源码及本地角色覆盖已实施，AST/formatter/用户原文门禁、完整 verify 和同构建 fresh 工具链通过；[阶段摘要](../history-plans/2026-09-08-english-background-validation.md) 保存证据，剩余人工 TUI/键盘全路径复验。覆盖 src 内菜单、状态、通知、工具说明/结果、错误/日志、生成报告/产物、运行时 prompt，以及自带角色模板和本地覆盖；未增加最终输出过滤器。
- **边界**：中文开发注释/文档可保留；自然语言识别用中文正则与用户/外部原始数据不是产品文案，不删除支持，不翻译历史 Task/Run/session，也不剥除用户 emoji。保持状态枚举、协议 token、键盘操作、权限及 prompt 分层。
- **验收**：TypeScript/JavaScript AST 字符串/模板扫描（当前无需文案白名单），覆盖内置角色资产；实际 formatter/TUI/通知快照不含自带中文或 emoji，用户文本原样保留。更新仅依赖旧文案的断言但保留业务断言；最终 verify/typecheck/build 与 fresh dogfood/Workflow 验证。

## UX-03 终态运行时长（新增，待修复/核对）

- `src/entry.ts:131` 和 `src/agents/agent-store.ts:712` 的 elapsed 仍按当前时间减 createdAt，已 completed 的显示继续增长。PID 复审 Run 的持久区间是 207893ms，后一次 inspect 却显示 29m45s；原事实保存在 `pid-identity-closure/delegation-runs.json`，不能把显示值当作运行时长。
- 明确并统一运行 duration 与事件 freshness 的语义：终态 duration 取 finishedAt，活动中才持续增长；若保留创建后 age 必须换明确标签。补 formatter/tool/TUI 回归，历史 timestamp 不改写。

## R01 TUI Main Talk / New Workflow

- **现状**：typed intent 已接通现有 Core dispatch/sendUserMessage，普通/多行/控制形似正文不走 slash parser；busy 使用 followUp，回归通过。
- **剩余/验收**：人工操作实际菜单及键盘路径，核对 Main Talk 原文和 New Workflow 的 Task/Execution/definition/planner/DAG 事实；不能只检查 intent 字符串或用 headless 对话替代按钮验收。

## R03 Workflow 请求与恢复特例

- **现状**：无实体父任务时采用显式正文；已有父任务保留身份/正文/谱系，冻结 workflowRequest 并共享父预算；执行专用 invocationTask 进入节点、纳入 checkpoint 指纹，不保存进定义。四阶段 run/reuse B/modify/旧版 A 已真实对照通过。
- **恢复进展/剩余**：完整 handler 回归与真实冲突正文拒绝、省略正文恢复已通过，见 [恢复阶段摘要](../history-plans/2026-09-08-recovery-entry-validation.md)。剩余 action/selector/version/name 等全部 fresh 负例；不以输入指纹单测代替入口验证。
- **Task 默认正文/拒绝语义补充（2026-09-08）**：continue/reuse/retry 省略正文时使用选定源 Task，而不是含工具 JSON 的当前会话提示；显式正文仍可覆盖，resume 只允许等值。Task preparation 拒绝不创建所请求的子 Execution，也不是一次已执行 invocation；active plan 按自身 Main/已执行调用结局收敛。历史夹具核对零替换、零子谱系和原事实不变，不能凭 marker 宣称准备成功，也不要求凭空生成 invocation 回执。
- **已实现、继续验证的契约（2026-09-08）**：`flux_task resume` 不允许 task 参数替换源 Task 正文（等值重放可接受）；进入 Workflow 时，省略正文读取保存 DAG 的 invocationTask，旧快照依次回退源 workflowRequest/task。显式 Workflow task 必须与该输入一致；resume 只接受 action=run，不得夹带 modify/reuse/改名，显式 selector 须解析为同一源 ID/version。拒绝发生在新 DAG/产物目录、planner/worker 和资源改绑之前；成功冻结恢复的 workflowRequest 并保留源文件字节。工具与 slash 共用正文判定，完整 handler 回归已通过，不修改保存定义。
- **契约/验收**：new run/modify 缺正文在模型前拒绝，合法 prepared recovery 例外；每个父 Task 一次 Workflow invocation。恢复沿用原执行证据，不得静默忽略冲突的新正文或把新正文当旧结果；结构修改走 modify/new。核对原 prompt、显式正文、变更要求、planner/node 输入、Task/request/definition/version 及预算。

## R07 Capability fail-closed

- **现状**：仅 ENOENT 视为无 override；坏 JSON/schema/身份/角色/revision 拒绝并保留文件。原子写、PID-aware base fence、runner 启动前拒绝及 capability 回归通过。
- **剩余/验收**：受限真实 Agent 的损坏 policy/错误角色文件/真实 ACL 故障注入，拒绝前不得 spawn 或扩大工具；活 PID 老锁不得被窃取。成功只读运行不替代失败注入，也不是 OS 沙箱。

## R11 Agent 名称与旧记录迁移

- **现状**：新身份使用共同 ASCII/80 字符规则；锁内预留后缀分配 -2，session key 同步。六独立 Node 进程去重、非法名不落盘、真实括号名拒绝及重复名运行/fork 通过。
- **剩余**：显式旧括号名迁移/兼容，跨 registry/capability/reference 的一致性设计与竞争验证。
- **方案边界**：保留 Agent ID、历史 Run/Task、session、能力上界与引用；scoped old→ID alias 仍需设计复核。不静默替换或删除历史，不迁移 active Run/含糊身份/坏 policy；global 变更需明确授权。
- **验收**：迁移后 run/inspect/steer/消息一致，旧入口不误绑定；并发 create/迁移/运行没有半迁移或权限扩大。

## R15 活动 Workflow 引用保护

- **现状**：Core Workflow→Task 锁序，绑定/删除共用引用 fence，稳定 ID/version，拒绝活动改绑与删除，保留被引用版本。实际 handler 和两 Node 进程 bind/delete 竞争通过。
- **剩余/验收**：持有真实 Pi lease 时按 id/name/version 删除拒绝且文件不变，结束后合法删除；检查真正启动/删除窗口，不只构造静态 Set。

## 门禁

P0-02 旧 Main failure 覆盖缺口不再重复阻断；P0-03/P0-06 及后续新候选验证仍独立成立。stop、清理、文件门禁和消息 fence 按具体运行实例处理。完成项及时归档，详细待办不复制到 README/续接文件。
