# 29 - Desktop 多 Agent 工作台重构规划

更新日期：2026-07-19。本文件是 Desktop 重构的当前规划与进度记录。

当前进度：D0 主任务契约已完成；D1 的导航、任务创建、失败进入/Retry 和三栏调整已完成，运行时拆分与任务内参与者视图仍在开发。

## 产品目标

Desktop 从“多页面数据看板”改为“可直接与多个 Agent 沟通和分发任务的工作台”。用户最常做的动作应在一个主界面完成：描述任务、选择工作方式、选择/创建 Agent、观察执行、发送 follow-up/steer、处理阻塞、验收结果。

主导航只保留：

1. **Workbench**：Direct/Team/Workflow 的任务创建与执行控制。
2. **Agents**：角色模板和 Persistent Agents。
3. **Issues**：Community 列表与 Issue Room。
4. **Activity**：跨任务运行、消息、成本和 artifacts。
5. **Configuration**：模型、角色模板、预算和运行环境。

删除或合并 Overview、Chat、独立 DAG、Routing、Groups、重复 Settings 等入口。Ephemeral/forked Agents 只出现在所属任务时间线，不进入长期 roster。

## Workbench

采用可调三栏布局：

- 左栏：任务列表、筛选、状态、工作方式。
- 中栏：用户与 Main/child Agents 的统一时间线；消息必须显示发送者、目标、所属 claim/node 和 delivery 状态。
- 右栏：当前参与者、任务/claim、预算、文件范围、验收与运行控制。

Composer 提供工作方式选择：Direct、Team、Workflow、Community。Team 可预选 Persistent Agent 或交给 Main 动态组队；Workflow 选择模板或输入目标生成 DAG；Community 跳转/创建 Issue。Advanced 参数折叠，不在首屏堆放模型和拓扑指标。

失败任务仍可进入 Inspector，并提供 Retry；Retry 创建新 execution，保留 parentExecutionId。栏宽可拖动、键盘调整和重置，窄屏改为主内容 + drawer。

## Agents 与 Issues

Agents 页面只管理两类对象：

- Templates：角色、model、thinking、tools、skills、communication、workspace 上界。
- Persistent Agents：状态、当前任务、session/cache generation、最近消息和持久收窄权限。

Issue Room 三栏：左侧 Issue 状态与筛选，中间 comment/claim/submit/review/decision 时间线，右侧 participants、claims、文件范围、预算和 acceptance criteria。自由文本消息不能直接改变 claim/issue 状态。

## Communication Graph

不再用“所有 Agent 连到中心”的全局图作为默认视图。默认展示与当前任务有关的两种关系：

- **职责图**：Agent → Claim/Workflow node。
- **消息 lanes**：A→B 与 B→A 分开聚合，按当前 execution/issue scope 过滤。

只有诊断页才提供全局拓扑，并默认聚类、限制 Top N、支持折叠与缩放。没有真实 message/claim/dependency 证据时不绘制边。

## 实现顺序

### D0：共享契约

- [完成] Renderer 与 Electron 共享 `runtime-contract.ts` 的 WorkStyle/StartOptions。
- [完成] 删除主任务链路的 `modePolicy` 与 M fallback；固定工作方式进入 Core task contract。
- [完成] runtime history 升级为 schema v2，旧数据不迁移。
- [待开发] AgentRecord、Issue、Claim 与 TaskExecutionPlan 的共享读取契约。

### D1：运行时与 Workbench 骨架

- [部分完成] Direct/Team/Workflow/Community 选择、spawn/readiness、follow-up/steer/abort/stop、失败进入和 Retry lineage。
- [完成] 三栏拖动、键盘调整、重置与窄屏单栏布局。
- [完成] 主导航收敛为五个产品入口，不再展示 Chat/Sessions/DAG/Routing 等重复页面。
- [待开发] Electron main 拆分 runtime manager、protocol adapter、history store；任务内参与者与真实消息 lanes。

### D2：Agents

- Template/Persistent roster、创建/归档/运行、effective policy 与 cache-impact。
- Ephemeral 生命周期在 execution 中实时收敛，完成后不进入 roster。

### D3：Workflow 与 Issues

- DAG 以 node/dependency/claim 展示在右栏或 Inspector，不再有重复主页面。
- Issue Room 接 Core Community 操作；先显式人工动作，再考虑 Agent 主动循环。

### D4：Activity 与视觉收口

- 统一 taskId/executionId/agentId/messageId/artifact provenance。
- 统一 Card、Button、Input、Tabs、Table、Badge、empty/error/loading 状态和键盘焦点。
- 删除无 provenance 的估算指标和无法驱动决策的图表。

## 风险与隔离

- Core 本轮已断开旧 schema，Desktop 在 D0 完成前会编译或运行失败，这是预期的直接迁移成本，不加兼容层。
- 运行时协议与 React UI 分阶段切换；每阶段用独立 fixture，避免 UI 状态掩盖进程失败。
- Community 主动调度不能只靠 prompt 保证；后续由 runtime 在 Issue 状态变化时注入结构化待办，并用 claim/completion gate 验证行为。
- 视觉重构最后统一，但布局 primitives 在 D1 先确定，避免每个页面各写一套栏位和响应式规则。

## 测试门

- 每阶段：TypeScript、Vitest、Vite build、Electron compile。
- 运行时：启动失败、早退、无协议、follow-up、steer、abort、crash/redelivery、Retry。
- 工作方式：Direct、Team、Workflow、Community 各一条 DeepSeek Pro/Flash 隔离链路。
- 状态：Main/child 的 idle/running/blocked/done/failed/cancelled/archived 与 task 状态一致。
- UI：1280×800、1024×720、800×600；栏宽拖动/键盘/reset；失败任务进入和 Retry。
- Communication：0、少量、64 Agents；只绘制当前 scope 的真实边，检查无全连中心和标签重叠。
- 进程：测试后 fixture 与测试 PID 为 0；不干涉用户正在运行的 Desktop 实例。
