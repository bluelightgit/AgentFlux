# docs/33 工作方式重构设计（2026-08-13 用户决策）

> 状态：**开发完成（2026-08-15，阶段一至七全部落地）**。本文是 docs/28 的继任设计；docs/28 已标注历史存档。实现细节见 .codex/CONTINUATION.md 七.5（提交 80a1e14/6a91419/0c546b5/9b17d7b/b561234/9416fdc）与 docs/26 当前状态表。

## 一、背景与目标

现有 four-work-style 体系（direct/team/workflow/community + agent_decides 模式选择）经用户重新审视后取消。
目标：

1. 不再区分模式——普通对话驱动一切，主 Agent 自行决定直接执行、拉子代理、按 workflow（DAG）执行或按 community（Issue/Claim）协作。
2. 子代理统一为单一 Agent 实体（无 ephemeral/persistent 之分），保留三种创建路径（默认 / 角色模板 / 会话树分叉）。
3. workflow 与 community 降级为可选工作方式（空间），项目级互斥运行，避免项目变更冲突不可控。
4. 工具极简：移除 flux_team，flux_agent 成为唯一子代理入口（创建/沟通/管理）。
5. 不做上一版兼容：新代码不保留旧枚举、旧字段、旧迁移逻辑；旧运行时数据文件备份后重建。

## 二、新模型

### 2.1 取消模式体系

- 删除 WorkStyle 枚举（direct/team/workflow/community/agent_decides 全部移除）。
- 任务记录不再有 workStyle 字段；任务注册表保留（id/谱系/状态/成本），作为历史与谱系事实源。
- 删除：requireWorkStyleCapability、implicit plan 模式锁定、同回合工作方式锁定、AGENTFLUX_WORK_STYLE 环境变量、任务信封的 workStyle 字段。
- 普通对话中任意时刻可发起：子代理运行、workflow run、community 操作。

### 2.2 空间（workflow / community）

- **workflow 空间**：保存多个 DAG 定义（多定义 OK，现有版本累积机制保留），运行唯一。
- **community 空间**：项目级一个空间（issues.json），内部多 issue 可并行，冲突靠 agent 间沟通（Message V2）协调。
- **运行互斥（核心约束）**：agent 运行带空间归属 `context: "main" | "workflow" | "community"`。
  - 启动 workflow run 或 community 的 agent 运行前：若项目存在活跃（running）agent 且不属于目标空间 → 拒绝并提示。
  - 空间内并行允许（DAG 并行节点、community 多 issue 多 agent）。
  - main 直接调用的子代理归属 main 上下文；其活跃时同样阻止启动空间运行。
- **可见性**：session 中可见项目所有 workflow/community 空间列表；进入后展示详细信息（定义/成员/状态，后续可视化）与执行记录时间线（哪个 agent 何时做了什么——事件来源：telemetry events + run registry + 空间专属事件）。

### 2.3 Agent 统一模型

- 唯一 `id`（uuidv7）；`name` 由主 Agent 自定义（可短于 id）。
- **创建三路径**（flux_agent create）：
  1. 默认：无特别入参，默认角色/工具集。
  2. 角色模板：全局或项目级存在对应模板（name/role 指定）。
  3. 会话树分叉（fork）：指定 session id（本项目其他 session 的对话，或其他子代理的对话），利用 pi 对话树从指定节点分出新对话；保留原 agent 记忆，可分配不同后续任务。
- 创建可指定名称；**重名自动后缀** `xxx(1)`、`xxx(2)`……保证 name 唯一。
- 按 name 查询/拉起：若存在多个匹配（防御性，如历史数据）返回 list 由调用方选定；按 id 精确拉起。
- 生命周期：idle 保留（长期存在）→ 手动删除（agent 或用户）或自动 GC。
- **自动 GC**：删除"无工作引用 且 创建时间早于最新第 k 个（默认 k=10，可配置）创建"的 Agent；有工作引用的永不自动删。

### 2.4 三层作用域

| 层 | 存储 | 状态保留范围 |
|---|---|---|
| global | `~/.agentflux/`（用户主目录） | 跨项目共享：Agent 定义、workflow 定义、模板 |
| project | `<cwd>/.agentflux/` | 同项目共享：Agent 注册、workflow 定义、community 空间、执行记录 |
| session | 项目级基础上按 sessionId 命名空间隔离 | 仅当前对话可见；会话结束可清理 |

- 实体（子代理 / workflow / community）均可声明层级；同层级内部名唯一。
- **清理（GC/删除）必须避开运行中的 session**（running agent 的 session 文件与命名空间不可清理）。

### 2.5 run 语义（与子代理沟通）

- `flux_agent run {agent: name|id, task, timeout?, last?: k}`：向子代理发出指令，等待其完成（超时可配），返回子代理最后一条消息（last 默认 1，可 last(k) 查看最近 k 条执行消息）。
- 子代理 busy 时新指令**排队**（agent 任务队列），当前任务完成后自动执行队列；也支持中断（stop）。
- 输出携带执行信息：模型、turns、token、缓存命中、成本（复用现有 usage 结构）。

### 2.6 Main 的参与方式

- **执行者**：main-agent 可作为一个执行者参与 workflow 节点或 community claim；其任务未完成时对话需等待（排队）或直接中断。
- **调度/规划者**：仅调度与规划（不执行节点）时，无活动任务即可随时对话。
- 实现：Agent 状态 busy 时消息进入队列（2.5 排队机制同一实现）。

## 三、数据格式（新，不兼容旧版）

- Agent 注册：`.agentflux/runtime/agents.json`（新 schema：id/name/role/scope(global|project|session)/sessionId/status/lineage/callCount/totalCostUsd/lastTask/createdAt/updatedAt，无 kind ephemeral/persistent）。
- 任务注册表：`.agentflux/runtime/tasks.json`（去 workStyle 字段，保留 executions/usage）。
- workflow 定义：`.agentflux/runtime/workflows.json`（保留多定义+版本）。
- community：`.agentflux/issues.json`（保留多 issue+claims+timeline）。
- 空间运行状态：`.agentflux/runtime/active-context.json`（当前活跃空间归属与活跃 agent 集合，互斥判定的权威来源）。
- **迁移**：开发切换时旧 `runtime/` 数据文件备份为 `.bak-<date>` 并重建；不做代码级兼容。

## 四、工具接口（Agent 侧）

| 工具 | 动作 | 说明 |
|---|---|---|
| flux_agent | create / run / stop / retry / list / delete / gc | create 三路径（默认/role/fork-session）；run 指令+超时+last(k)；stop 中断；retry 重跑 lastTask；delete 手动删除；gc 手动触发自动 GC 规则 |
| flux_workflow | run / list / show / reuse / modify / delete | DAG 空间；运行互斥检查 |
| flux_issue | create / list / show / comment / claim / submit / review / resolve / delete | community 空间；运行互斥检查（claim 执行时） |
| flux_message | send / poll / ack / group_create / group_list / group_send | 保留（agent 沟通、busy 排队的基础） |
| flux_task | list / inspect / new / reuse / resume / continue / retry | 保留（去 workStyle），任务历史/谱系 |
| ~~flux_team~~ | — | 移除；拉子代理由主 Agent 逐个决定 |

TUI `/flux`：移除 work 模式选择；新增空间查看（workflow/community 列表与时间线）、Agent 管理（create/run/stop/retry/delete/gc）。

## 五、分阶段开发计划

1. **类型层**：移除 WorkStyle 体系与门禁（requireWorkStyleCapability/agent_decides/env/信封字段）；AgentRecord 新 schema（id+name 唯一后缀）；作用域类型。
2. **Agent 层**：统一 Agent 注册/运行（三种创建路径、按 name list 防御、busy 队列、run 返回 last(k) 消息）；删除 ephemeral/persistent 分支代码。
3. **空间与互斥**：active-context 状态文件；workflow/community 运行互斥检查；空间可见性与时间线（复用 telemetry）。
4. **工具与 TUI**：flux_agent 新接口；flux_workflow/flux_issue 接入互斥；移除 flux_team 注册与分发；/flux 菜单改造。
5. **GC 与清理**：自动 GC（k=10，无引用+非最新 k 个）；手动 delete；清理避开运行中 session。
6. **测试**：重写 workstyle/agent 测试（互斥、重名后缀、按名 list、三层作用域、GC 规则、busy 排队、fork 创建）；verify 全绿。
7. **文档**：AGENTS.md 产品约束段、docs/26、docs/28 存档标注、CONTINUATION 更新。

## 六、测试计划

- 互斥：main 活跃 agent 阻止 workflow run / community 活动；community 内部多 issue 并行允许；DAG 并行节点允许。
- Agent：create 三路径、重名 `xxx(1)` 后缀、按 name 多匹配返回 list、run last(1)/last(k)、busy 排队、stop/retry/delete、GC k 规则（无引用且非最新 k 个删除，有引用保留）。
- 作用域：global/project/session 三层存储隔离；session 清理避开运行中。
- 回归：现有 22 组测试按新模型更新（移除 workstyle 相关断言）。
