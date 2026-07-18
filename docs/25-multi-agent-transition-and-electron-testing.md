# 多 Agent 执行转型与 Electron 测试规划

> 历史迁移与测试记录。当前 Core 测试事实见 [26](26-implementation-status.md)，Desktop 测试门见 [29](29-desktop-workbench-plan.md)。

> 2026-06-29 · 从"主 agent 直接编码"转型到"主 agent 编排 + subagent 执行"

## 一、现状诊断

### 1.1 当前工作模式

| 维度 | 现状 | 问题 |
|------|------|------|
| **代码编写** | 主 agent (oa/glm-5.2) 直接在 pi TUI 中编码 | 上下文持续膨胀，无法并行 |
| **子 agent 使用** | 仅用于测试和 scaffold 生成 | 未用于真实功能开发 |
| **上下文积累** | 子 agent 默认 ephemeral (no-session) | 无法跨调用保留对话历史 |
| **任务分解** | 主 agent 人工分解，人工调度 | 无自动 DAG 分解 |
| **质量保证** | 主 agent 自测 + 用户 review | 无自动化质量门 |
| **Electron 测试** | 仅数据管线单元测试 (8 tests) | 无集成/E2E/性能测试 |

### 1.2 核心差距

1. **子 agent 上下文断裂**：DAG/M6 的 `persistent` 参数默认 false，每次调用都是全新 session
2. **无任务到 agent 的映射机制**：用户任务 → DAG 分解 → agent 分配 → 执行 → 验收，这条链不完整
3. **Electron 从未完整启动验证**：只验证了 Vite build 和 tsc compile，未验证 IPC + React + 数据管线全链路
4. **无性能基线**：chart 渲染时间、内存占用、事件监听延迟均未测量

## 二、多 Agent 执行架构设计

### 2.1 目标工作流

```
用户下达任务
    ↓
主 Agent (orchestrator): classifyTask → 生成 TaskRoutingSignal
    ↓
DAG Planner: 分解为 TaskNode[] (id/role/dependsOn/acceptanceCriteria)
    ↓
DAG Executor: 拓扑排序 + 并行执行
    ├── persistent agent A (planner, 高 reasoning)
    ├── persistent agent B (implementer, 中 reasoning)  ← 可并行
    ├── persistent agent C (implementer, 中 reasoning)  ← 可并行
    └── persistent agent D (reviewer, 高 reasoning)     ← 等 B/C 完成
    ↓
Quality Gate: 每个 node 完成后验收
    ├── PASS → 标记完成, 解锁下游
    ├── FAIL → 反馈注入 → 重试 (maxRetries)
    └── FAIL after retry → 条件分支 (重运行依赖)
    ↓
全部完成 → 汇总结果 → 主 agent 交付给用户
```

### 2.2 持久 Agent 池设计

```
.agentflux/runtime/
├── persistent-agents.json      # agent 注册表 (name/role/model/sessionFile/status)
├── sessions/                   # 持久 session 文件 (*.jsonl)
│   ├── 2026-06-29T..._flux-planner.jsonl
│   ├── 2026-06-29T..._flux-impl-1.jsonl
│   └── 2026-06-29T..._flux-reviewer.jsonl
├── blackboard.json             # SharedBoard (agents/tasks/messages)
├── dag-state.json              # DAG 执行进度
└── dag-state-backup.json       # DAG 检查点
```

**关键设计决策**：
- **persistent: true** 作为默认值用于生产开发任务
- 每个 agent 角色对应一个固定 session：planner / implementer-N / reviewer
- session 文件名含 agent name，可通过 `readdirSync + includes(agentName)` 找到
- agent 间通信通过 SharedBoard `messages/` 目录（非 IPC）

### 2.3 角色定义与模型分配

| 角色 | 职责 | 模型策略 | reasoning | tools |
|------|------|----------|-----------|-------|
| **planner** | 任务分解、架构设计 | 强模型 (gpt-5.5) | high | read, grep, find, ls |
| **implementer** | 代码编写 | 成本效率模型 (deepseek-v4-flash 或 glm-5.2) | medium | read, write, edit, bash, grep, find |
| **reviewer** | 代码审查、质量验收 | 强模型 (gpt-5.5) | high | read, grep, find, ls |
| **tester** | 测试编写与执行 | 成本效率模型 | medium | read, write, edit, bash |

### 2.4 任务分配机制

**方案：基于 DAG 的文件级分区**

```
DAG Planner 分解策略:
1. 按文件/目录分区：不同 implementer 负责不同文件集，无冲突
2. 依赖关系：planner → implementers (并行) → reviewer → (条件) implementers
3. 验收标准：每个 node 明确 acceptanceCriteria (文件存在/编译通过/测试通过)
4. 上下文传递：通过 task description + handoff 文件，非 session 共享
```

**防冲突机制**：
- DAG Planner 在分解时明确分配 files[] 给每个 node
- 两个 node 不应写同一个文件（DAG Planner 的约束）
- 如果必须改同一文件，设为串行依赖

## 三、Electron 测试规划

### 3.1 测试层次

```
Layer 1: 单元测试 (已有, 8 tests)
  └── 数据管线: events-parser, data-aggregator, event-watcher
Layer 2: 集成测试 (新增)
  ├── IPC 桥测试: read-file/write-file/file-size/read-file-incremental/path-exists
  ├── Store 状态: init → recompute → setTimeRange → setAutoRefresh
  └── 组件渲染: 每个 React 组件 mount + props 验证
Layer 3: E2E 测试 (新增)
  ├── Electron 启动 → 窗口创建 → 页面加载
  ├── 数据流: events.jsonl → parser → aggregator → chart render
  ├── 控制面板: override.json 写入 → pi turn_end 读取 → 路由变更
  └── Agent 状态: persistent-agents.json → AgentStatusPanel 显示
Layer 4: 性能测试 (新增)
  ├── Chart 渲染: 100/500/1000 数据点 → 渲染时间 < 2s
  ├── 事件监听: 500ms 轮询延迟 → UI 更新延迟 < 1s
  ├── 内存: Electron 进程内存 < 200MB (空闲) / < 400MB (全图表)
  └── 冷启动: app launch → dashboard visible < 3s
```

### 3.2 具体测试用例

#### 集成测试 (Layer 2)

| ID | 测试名 | 验证点 | 工具 |
|----|--------|--------|------|
| IT-1 | IPC read-file | Electron main→renderer 文件读取正确 | vitest + electron mock |
| IT-2 | IPC write-file | override.json 写入 + 读取回环 | vitest + electron mock |
| IT-3 | Store init | Zustand init() 加载事件 + 启动 watcher | vitest + mock events |
| IT-4 | Store recompute | setTimeRange 触发重新聚合 | vitest |
| IT-5 | RouteMap render | ScatterChart 验收数据点数量 | @testing-library/react |
| IT-6 | CacheChart render | LineChart + PieChart 双图渲染 | @testing-library/react |
| IT-7 | AgentStatusPanel | 模拟 agent 状态 → 表格显示 | @testing-library/react |
| IT-8 | ControlPanel | 点击 preset → override.json 写入 | @testing-library/react + mock IPC |

#### E2E 测试 (Layer 3)

| ID | 测试名 | 步骤 | 期望 |
|----|--------|------|------|
| E2E-1 | Electron 启动 | `electron .` → 等待 5s | 窗口 1200x800, 加载 dist/index.html |
| E2E-2 | Dashboard 数据流 | 写入测试 events.jsonl → 启动 → 检查 SummaryCards | 显示正确事件数和成本 |
| E2E-3 | 实时更新 | 追加事件到 events.jsonl → 等 1s → 检查 UI | SummaryCards 数字更新 |
| E2E-4 | 控制面板 | 点击 "accurate" preset → 检查 override.json | 文件存在, preset=accurate |
| E2E-5 | Agent 状态 | 写入 persistent-agents.json → 切换到 Agents 页 | 显示 agent 表格 |
| E2E-6 | 页面导航 | 点击 sidebar 各页面 | main content 切换正确 |

#### 性能测试 (Layer 4)

| ID | 指标 | 基准 | 目标 | 测量方法 |
|----|------|------|------|----------|
| P-1 | Chart 渲染 (100点) | - | < 500ms | performance.now() 围绕 render |
| P-2 | Chart 渲染 (1000点) | - | < 2s | 同上 |
| P-3 | 事件监听延迟 | - | < 1s | 写入 events.jsonl → UI 更新 |
| P-4 | 冷启动时间 | - | < 3s | app ready → first paint |
| P-5 | 内存 (空闲) | - | < 200MB | process.memoryUsage() |
| P-6 | 内存 (全图表) | - | < 400MB | 所有图表渲染后 |
| P-7 | Vite HMR | - | < 500ms | 修改文件 → 浏览器更新 |

### 3.3 测试基础设施

```
desktop/tests/
├── unit/
│   └── data-pipeline.ts          # 已有 (8 tests)
├── integration/
│   ├── ipc-bridge.ts             # IPC mock + 回环测试
│   ├── store-state.ts            # Zustand store 状态转换
│   └── component-render.ts       # React 组件挂载测试
├── e2e/
│   ├── electron-launch.ts        # Electron 启动验证
│   ├── dashboard-data.ts         # 全链路数据流
│   └── control-panel.ts          # override.json 写入验证
└── performance/
    ├── chart-render.ts           # 图表渲染基准
    ├── memory-usage.ts           # 内存基线
    └── cold-start.ts             # 冷启动计时
```

**测试框架选择**：
- 单元/集成: vitest (Vite 原生, 零配置)
- 组件: @testing-library/react + jsdom
- E2E: Playwright with Electron (playwright-electron)
- 性能: performance.now() + process.memoryUsage()

## 四、实施路线图

### Phase 4.1.5: 多 Agent 执行基础设施 (3-5 天)

> 目标: 让 DAG executor + persistent agents 可用于真实开发任务

| 任务 | 内容 | 交付物 |
|------|------|--------|
| **MA-1** | DAG executor `persistent: true` 设为默认 | dag-executor.ts 修改 |
| **MA-2** | M6 heterogeneous team `persistent: true` 设为默认 | heterogeneous-team.ts 修改 |
| **MA-3** | models.json 添加 oa/glm-5.2 (用户实际模型) | models.json 更新 |
| **MA-4** | 角色 agent 定义文件 (.agentflux/agents/) | planner.md, implementer.md, reviewer.md, tester.md |
| **MA-5** | 任务→DAG→执行→验收 完整 CLI 入口 | /flux work <task> 命令 |
| **MA-6** | 执行进度实时可见 | /flux agents + footer 更新 |

### Phase 4.1.6: Electron 集成测试 (2-3 天)

| 任务 | 内容 | 交付物 |
|------|------|--------|
| **ET-1** | 安装 vitest + @testing-library/react + jsdom | devDependencies |
| **ET-2** | IPC 桥集成测试 (IT-1 ~ IT-2) | tests/integration/ipc-bridge.ts |
| **ET-3** | Store 状态集成测试 (IT-3 ~ IT-4) | tests/integration/store-state.ts |
| **ET-4** | 组件渲染测试 (IT-5 ~ IT-8) | tests/integration/component-render.ts |
| **ET-5** | E2E: Electron 启动验证 (E2E-1) | tests/e2e/electron-launch.ts |
| **ET-6** | E2E: Dashboard 数据流 (E2E-2, E2E-3) | tests/e2e/dashboard-data.ts |

### Phase 4.1.7: Electron 性能测试 (1-2 天)

| 任务 | 内容 | 交付物 |
|------|------|--------|
| **PT-1** | Chart 渲染基准 (P-1, P-2) | tests/performance/chart-render.ts |
| **PT-2** | 内存基线 (P-5, P-6) | tests/performance/memory-usage.ts |
| **PT-3** | 冷启动计时 (P-4) | tests/performance/cold-start.ts |
| **PT-4** | 性能报告生成 | docs/25-electron-perf-baseline.md |

### Phase 4.2: Desktop 控制面板完善 (用多 Agent 执行)

> 目标: 用多 agent 模式开发 Phase 4.2, 同时验证多 agent 能力

| 任务 | 内容 | 执行模式 |
|------|------|----------|
| **D2-1** | 偏好雷达图 (5维向量可视化) | DAG: planner → impl → reviewer |
| **D2-2** | 路由决策链可视化 | DAG: planner → impl → reviewer |
| **D2-3** | A/B 测试面板 | DAG: planner → impl → reviewer |
| **D2-4** | 预算设置面板 | DAG: planner → impl → reviewer |
| **D2-5** | Agent 管理增强 (启动/停止/消息) | DAG: planner → impl → reviewer |
| **D2-6** | 实时事件流 (terminal-style) | DAG: planner → impl → reviewer |

## 五、多 Agent 执行的约束与缓解

### 5.1 已知约束

| 约束 | 影响 | 缓解方案 |
|------|------|----------|
| 180s 超时 | 复杂任务可能超时 | 质量门反馈重试 + 任务分解到更小粒度 |
| 上下文不共享 | agent 间无法直接看到对方的对话 | 通过 task description + handoff 文件传递 |
| 文件冲突 | 并行 agent 写同一文件 | DAG Planner 强制 files[] 互斥分配 |
| 模型成本 | 多 agent 调用增加成本 | implementer 用成本效率模型, 质量门限制重试 |
| 非确定性 | LLM 输出不稳定 | 质量门 + retry + ExperienceStore 反馈 |

### 5.2 首次执行策略

1. **先用简单任务验证**: 选择一个独立模块 (如 D2-1 偏好雷达图) 作为首次多 agent 真实任务
2. **DAG 粒度保守**: 初始分解为 3-4 个 node (planner → 1-2 impl → reviewer), 不追求深度并行
3. **persistent: true**: 所有 agent 使用持久 session, 累积上下文
4. **质量门启用**: 每个 node 必须有 acceptanceCriteria
5. **人工检查点**: DAG 完成后主 agent 汇总结果, 用户 review 后再继续

## 六、验收标准

### 多 Agent 执行

- [ ] DAG executor persistent=true 为默认
- [ ] /flux work 命令可一键启动多 agent 任务
- [ ] /flux agents 实时显示执行中的 agent 状态
- [ ] 质量门对每个 node 自动验收
- [ ] 失败 node 自动重试 + 条件分支
- [ ] agent session 文件可跨调用复用

### Electron 测试

- [ ] 集成测试 ≥ 8 个, 全部通过
- [ ] E2E 测试 ≥ 3 个, 全部通过
- [ ] 性能基线 7 个指标全部测量
- [ ] Chart 渲染 1000 点 < 2s
- [ ] 冷启动 < 3s
- [ ] 内存空闲 < 200MB

## 七、风险与回退

| 风险 | 概率 | 回退方案 |
|------|------|----------|
| 多 agent 执行质量不如单 agent | 中 | 保留主 agent 直接编码模式作为 fallback |
| Electron E2E 环境搭建困难 | 中 | 降级为手动测试 + 截图验证 |
| persistent session 文件膨胀 | 低 | 定期清理 + session 文件压缩 |
| 模型成本超出预期 | 低 | budget-router 限制 + 成本效率模型 |
