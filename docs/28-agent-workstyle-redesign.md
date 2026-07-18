# 28 - Agent 生命周期与工作方式重构

更新日期：2026-07-18。

## 决策摘要

AgentFlux 不再继续扩展用户可见的 M1–M6 模式。旧模式把执行拓扑、Agent 生命周期、模型分配和会话分支混在同一层，导致能力边界、路由语义和 Desktop 入口重复。

新产品模型拆成三个正交维度：

1. **Agent 类型**：Main、Ephemeral Subagent、Persistent Specialist。
2. **Agent 创建来源**：fresh、template、fork。
3. **工作方式**：Direct、Team、Workflow、Community。

模型/provider/thinking、工具、Skill、通信和 workspace 权限属于 Agent policy，不再构成独立工作模式。自动路由只允许在这些明确能力上给出建议；近期仍由用户或主 Agent 选择工作方式。

## 为什么重构

旧六模式不在同一抽象层：

| 旧概念 | 实际描述的维度 | 新归属 |
|---|---|---|
| M1 | 单 Agent 执行拓扑 | Direct |
| M2 | 主 Agent 调度子 Agent | Team |
| M3 | 会话分支能力 | `AgentFactory.fork` |
| M4 | Agent 生命周期 | Persistent Specialist |
| M5 | 固定依赖工作流 | Workflow |
| M6 | 异构模型分配 | 通用 model policy |

继续增加模式会迫使每个模式重复实现预算、取消、消息、权限、缓存、artifact 和 telemetry。重构目标不是删除已完成能力，而是把能力放回正确层级并复用统一运行时。

## Agent 类型

### Main Agent

- 用户的主要对话和任务入口。
- 负责澄清目标、选择工作方式、介入调度和最终结果。
- 可以直接执行，也可以创建、邀请、暂停或回收其他 Agent。
- 一个 workspace 可以存在多个独立 main runtime，但每个任务只有一个明确 lead。

### Ephemeral Subagent

- 为一个短小、边界明确的任务创建。
- 默认 fresh，也可以从已有 Agent 上下文 fork。
- 任务完成、失败或取消后进入终态，不再被后续任务调用。
- 不进入全局 Persistent Specialist roster，只出现在所属 execution family。
- 不强制保持跨任务 cache shape；短任务能力变更只记录成本影响，默认不弹高优先级缓存警告。
- 仍受工具、Skill、通信、workspace、预算和进程回收约束。

### Persistent Specialist

- 由完整模板创建，具有稳定身份、角色、模型、thinking、工具、Skill、通信和 workspace policy。
- session、统计、消息 cursor、能力 revision 和上下文维护策略持久化。
- 强调稳定 prefix/cache generation；会破坏缓存形状的模板、模型、工具、Skill 或 MCP 变化必须提示。
- 支持暂停、恢复、归档、重新绑定任务和受控更新能力。
- 适合 reviewer、tester、designer、领域专家和长期项目成员。

## Agent 创建来源

创建来源与 Agent 类型分离：

### Fresh

从最小运行时和任务说明创建，适合一次性 Ephemeral Subagent。

### Template

从角色模板创建。模板提供能力上界和稳定 system prefix，通常用于 Persistent Specialist，也可创建模板化的一次性 Agent。

### Fork

从已有 Agent 的确定上下文快照派生一个或多个子实例：

```text
agent A @ context snapshot S
  ├─ fork A/1 → task X
  ├─ fork A/2 → task Y
  └─ fork A/3 → alternative Z
```

适用场景：已有 Agent 的上下文、决策历史或领域知识适合一组相关任务，需要避免每个子 Agent 从头读取和理解。

fork 可以来源于 Main、Ephemeral 或 Persistent Agent；“从谁创建”不改变子实例的生命周期类型。默认创建 Ephemeral，只有显式注册并生成新模板 revision 后才成为 Persistent Specialist。

Fork 契约：

- fork 必须记录 `parentAgentId`、`forkPoint`、`contextSnapshotId` 和 lineage。
- 子实例继承快照、模板和权限上界，但具有独立 `agentId`、`runId`、任务状态和消息 cursor。
- fork 后父子上下文不再隐式同步；共享事实通过 Message V2、artifact 或显式 merge 传递。
- 多个 fork 默认可以并行，但写入范围必须通过 claim/file lock 防冲突。
- fork 默认产生任务级 Ephemeral Subagent；用户可显式从 fork 创建 Persistent Specialist，但必须生成新的稳定模板 revision/cache generation。
- fork 继承稳定 prefix 时可利用 provider prefix cache；Ephemeral fork 不因任务后缀变化显示高优先级 cache-impact 警告。
- fork 失败、取消和完成均按普通 Agent 生命周期回收，不能继续占用父 Agent 上下文。

旧 M3 的 fork/compare/prune 能力保留为 Agent 创建与结果汇合工具，不再作为独立工作方式。第一阶段不承诺自动 merge；merge 必须基于 artifact/结果 provenance，并允许主 Agent或用户确认。

## 四种工作方式

### Direct

主 Agent 直接完成任务，不预先创建其他 Agent。适合简单任务、探索和低协调成本场景。

### Team

主 Agent 负责动态组队和调度，不要求预先形成完整 DAG：

- 用户可预选 Persistent Specialists。
- 主 Agent 可按需创建 fresh/template/fork Ephemeral Subagent。
- 可以并行委派独立任务、追加 reviewer/tester，或让已有 Agent fork 多个相关执行分支。
- 主 Agent 持有最终整合和验收责任。

这是默认多 Agent 工作方式，吸收旧 M2；旧 M4 的持久身份和旧 M6 的异构模型只是 Team 可选能力。

### Workflow

通过显式 DAG 或模板执行可预测的依赖流程：

- 节点、依赖、并行、质量门、重试和恢复可审计。
- 节点可以使用 Ephemeral、Persistent 或 forked Agent。
- 每个节点仍可选择不同模型，因此不需要独立的 M6。
- 适合标准开发流水线、批量任务、CI 和合规流程。

### Community

用户发布 Issue，参与 Agent 通过讨论、提案、认领、执行和审查动态形成工作图，而不是由 planner 一次性固定 DAG。

Issue 状态机：

```text
Open → Triage → Forming → Executing → Reviewing → Resolved
                                  └──────────────→ Blocked
```

结构化动作：

- `propose`：提出方案或拆分建议。
- `comment`：补充事实、风险或反对意见。
- `claim`：认领职责、文件或 artifact 范围。
- `invite`：请求加入 Persistent Specialist 或创建 Ephemeral/forked Agent。
- `submit`：提交带 provenance 的结果或 artifact。
- `review`：审查某个 claim/result。
- `request_decision`：请求主 Agent或用户裁决。
- `resolve`：在完成门满足后提议关闭 Issue。

Community 不是无约束群聊。MVP 必须限制参与者、并发、消息数、讨论轮次、成本和墙钟；修改前必须 claim/lock，关闭前必须收敛所有 required claim、review 和 acceptance criteria。主 Agent 是 moderator，保留预算、权限和最终关闭权。

## 统一领域模型

建议新增或迁移为以下稳定字段：

```ts
type AgentKind = "main" | "ephemeral" | "persistent";
type AgentOrigin = "fresh" | "template" | "fork";
type WorkStyle = "direct" | "team" | "workflow" | "community";

interface AgentLineage {
  origin: AgentOrigin;
  parentAgentId?: string;
  templateId?: string;
  templateRevision?: number;
  forkPoint?: string;
  contextSnapshotId?: string;
}
```

`AgentKind × AgentOrigin` 是组合关系而不是枚举爆炸：Main 通常为 fresh 或 workspace restore；Ephemeral 可为 fresh/template/fork；Persistent 通常为 template，也可由显式确认的 fork promotion 产生。运行时和 Desktop 必须分别展示“它是什么”与“它从哪里来”。

所有工作方式共用：Task/Issue、Execution、AgentInstance、Claim、Message/Delivery、Artifact、Decision、Review 和 Budget。执行差异只存在于调度器：

- `DirectExecutor`
- `TeamExecutor`
- `WorkflowExecutor`
- `CommunityExecutor`

Agent 创建统一通过 `AgentFactory`：

- `createFresh()`
- `createFromTemplate()`
- `forkFromSnapshot()`
- `promoteToPersistent()`（后置能力，必须显式确认并创建稳定 revision）

## 缓存与上下文策略

### Ephemeral

- 优先任务完成时间和最小协调成本。
- 不为每次工具/Skill差异阻止执行。
- 动态任务和消息保持在 prefix 后缀。
- 完成后归档最小摘要、usage、artifact 和 lineage，不保留可继续调用的 session。

### Persistent

- 稳定 system prompt、工具 schema、Skill、MCP 和 model位于 cache prefix。
- 每次 cache-breaking 变化产生新 `capabilityGeneration`。
- Desktop 显示 cache health、最近 generation 变化及预计影响。
- 需要 compaction、上下文上限和长期记忆治理，不能把无限 session 当作持久化。

### Fork

- snapshot 之前的上下文视为只读共享前缀。
- snapshot 之后每个分支独立增长。
- merge 不拼接完整会话，只合并结构化结果、决策和 artifacts。

## Desktop 信息架构

主导航目标：

1. **Workbench**：Direct/Team/Workflow 新建与运行任务。
2. **Agents**：Templates 和 Persistent Specialists；Ephemeral/forked Agent 只在 execution 中出现。
3. **Issues**：Community issue 列表与 Issue Room。
4. **Activity**：运行、成本、消息和 artifact provenance。
5. **Configuration**：模型、模板、预算和运行环境。

New Task 不再显示 M 编号，只显示工作方式。Team 允许选择“主 Agent 自行组队”或预选 Agent；Workflow 选择 DAG 模板；Community 创建 Issue 并配置参与者/预算/关闭条件。

Issue Room 建议三栏：

- 左：Issue 状态、列表和过滤。
- 中：讨论、提案、提交、审查和决策时间线。
- 右：参与者、claims、文件范围、预算和验收条件。

全局 Communication Graph 降为诊断视图。默认工作界面优先展示“谁认领什么、谁依赖谁、什么阻塞、哪些结果待审查”。

## 兼容迁移

旧配置和 telemetry 在至少一个迁移周期内保留：

| 旧模式 | 兼容解释 |
|---|---|
| M1 | `workStyle=direct` |
| M2 | `workStyle=team` |
| M3 | `workStyle=team` + `agentOrigin=fork` 建议；不再是独立 executor |
| M4 | `workStyle=team` + persistent participant policy |
| M5 | `workStyle=workflow` |
| M6 | `workStyle=team/workflow` + heterogeneous model policy |

兼容层继续记录 `requestedMode`，同时写入新的 `workStyle`、`agentKind`、`agentOrigin` 和 `modelPolicy`。Desktop 不再创建新的 M3/M4/M6 配置；读取旧记录时显示迁移后的语义和 deprecated badge。

## 实施阶段

### R0：文档与契约

- 冻结新增 M 模式。
- 建立新类型、兼容映射和事件 schema 设计。
- 明确 fork snapshot/lineage、Ephemeral 回收和 Persistent cache generation 契约。

### R1：Core 兼容层

- 引入 `WorkStyle`、`AgentKind`、`AgentOrigin`。
- 将现有 M1/M2/M5 executor 映射为 Direct/Team/Workflow。
- 建立统一 AgentFactory 和 execution participant registry。
- M3/M4/M6 保留 deprecated adapter，不删除底层能力。

### R2：Desktop 精简

- New Task 改为 Direct/Team/Workflow/Community。
- Agents 只展示模板和 Persistent Specialists。
- Ephemeral/fork lineage 进入 Execution Inspector。
- 删除模式雷达、重复模式入口和无法形成用户决策的模式指标。

### R3：Fork 创建

- 实现不可变 context snapshot 和 lineage。
- 支持从 main、Ephemeral 或 Persistent Agent 一次 fork N 个任务实例。
- 接入文件 claim/lock、取消、回收和结果汇总。

### R4：Community MVP

- Issue/Claim/Proposal/Review 状态机与类型化工具。
- Message V2 delivery/ACK、预算、backpressure 和 completion gate。
- Desktop Issue Room 与主 Agent moderator 操作。

### R5：移除旧产品语义

- 完成配置/telemetry 迁移后，停止向用户展示 M1–M6。
- 评估删除重复的 persistent/M6 executor，或让其成为 Team/Workflow 的内部策略实现。

## 验收标准

- 用户无需理解 M 编号即可选择正确工作方式。
- 同一个 Persistent Specialist 可以参与 Team、Workflow 和 Community。
- Ephemeral Agent 完成后不可被再次调度，且无残留进程/活跃租约。
- 一个 Agent 可从确定 snapshot fork 多个并行子实例，lineage 和写入范围可追踪。
- fork 子实例失败不污染父 Agent session；父子只通过显式结果/消息同步。
- Persistent 能力变化产生 cache-impact 和 generation；Ephemeral 任务差异不产生高优先级缓存噪声。
- Community 中所有执行工作都有 claim、结果、review 和预算 provenance，不以自由文本群聊冒充执行状态。
- 旧模式配置可读取、可解释、可迁移，但 Desktop 不再创建新的旧模式配置。

## 非目标

- 本轮不恢复自动模式路由为主入口。
- Community MVP 不实现无限自治、开放网络社区或无预算 Agent 自繁殖。
- fork 不等于共享可变内存，也不自动合并完整会话。
- Persistent 不等于永不回收；暂停、归档、TTL 和容量上限仍然必须存在。
