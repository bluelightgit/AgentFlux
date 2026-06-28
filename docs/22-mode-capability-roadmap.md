# 22 - 模式能力优先路线图

> 战略调整 (2026-07): 先把各种 agent 模式的执行能力做扎实, 再做智能路由。
> 理由: 路由器选了模式但模式本身执行能力不够 = 选了也白选。

## 调整背景

### 当前问题

路由器在 `session_start` 时基于仓库级信号 + 偏好向量算出一个 `state.mode`，但:

| 模式 | 路由器能选 | 实际执行能力 | 差距 |
|---|---|---|---|
| M1 单 agent | ✅ | ✅ pi 原生 | 无 |
| M2 主+subagent | ✅ | ⚠️ 基础 | 串行、不持久、无并行、无质量门 |
| M3 对话树 fork | ✅ | ⚠️ 基础 | merge 手动、无 A/B 自动比较 |
| M4 持久 multi-agent | ✅ | ❌ 几乎没有 | team 命令只是串行临时 subagent |
| M5 管道 handoff | ✅ | ⚠️ 刚性 | 硬编码三步、无条件分支/并行/重试 |
| M6 异构团队 | ✅ | ❌ 空白 | 代码不存在 |

**核心矛盾**: 路由选了 M4，但 M4 没有持久 session、没有 agent 间直接通信、没有任务队列消费——执行层面和 M2 一样都是串行跑 subagent。

### 调整原则

1. **先有可用的工具，再做选择工具的智能**
2. **每个模式做到"真正能发挥其设计价值"**，而非"能跑就行"
3. **模式能力是路由的基础**：路由器推荐的 M4 必须真的有持久 multi-agent 能力
4. **路由优化后置**：任务级路由、反馈闭环、step-level routing 在模式能力到位后再做

---

## 新的 Phase 划分

### Phase 2.5: 模式执行能力补全 (当前重点)

**目标**: 让 M2-M5 每种模式都能真正发挥其设计价值。M6 留到 Phase 3。

**原则**: 不动路由器代码，专注执行层。

#### M2 增强: subagent 能力补全

| 任务 | 内容 | 价值 |
|---|---|---|
| M2-1 并行 subagent | `Promise.all` 调用多个 subagent | 解锁 C2 stage 并行，wall-clock 减半 |
| M2-2 subagent 持久化 | 可选保留 session 文件 (去掉 `--no-session`) | 为 M4 持久 agent 打基础 |
| M2-3 工具白名单执行 | 验证 `--tools` 参数实际限制子进程工具 | 角色隔离落地 (planner 只读) |
| M2-4 reasoning effort 传递 | subagent 按角色传 `--thinking` 参数 | planner high / tester low |
| M2-5 subagent 结果质量检查 | 轻量级 LLM 调用验证产出 | subagent 产出可靠性 |

#### M3 增强: 对话树 fork 工作流

| 任务 | 内容 | 价值 |
|---|---|---|
| M3-1 fork 工作流封装 | `/flux fork explore <task>` 一键 fork 两个分支做 A/B | 用户不需要手动 fork+输入两次任务 |
| M3-2 fork 结果比较 | LLM 对比两分支输出，推荐胜者 | 自动 A/B 决策，不用人工看 |
| M3-3 fork merge 自动化 | 读取两分支 last assistant message，LLM 合并注入主分支 | Phase 3 的自动 merge 提前部分能力 |
| M3-4 fork prune | 一键丢弃失败分支 + 记录原因 | 清理对话树，保留决策审计 |

#### M4 实现: 持久 multi-agent (从零搭建)

| 任务 | 内容 | 价值 |
|---|---|---|
| M4-1 持久 session subagent | subagent 保留 session 文件，可被再次调用续接 | L2 cache 跨调用复用，持久记忆 |
| M4-2 agent 间消息传递 | 共享黑板新增 `messages/` 目录，agent 可发消息给指定 peer | 突破 star 拓扑限制 (parent 中转) |
| M4-3 任务队列消费 | agent 主动从 `tasks/` 认领任务，不只是被动接收 | leader-worker 模式落地 |
| M4-4 agent 状态同步 | agent 完成任务后更新黑板 + 通知依赖者 | DAG 依赖推进 |
| M4-5 持久 reviewer 甜区 | 同一 reviewer agent 跨多次调用保留 session | 验证 L2 长期收益 > compaction 代价 |

#### M5 增强: 管道柔性化

| 任务 | 内容 | 价值 |
|---|---|---|
| M5-1 动态任务分解 | planner 输出结构化任务 DAG (JSON)，不是纯文本 handoff | 从"三步固定"到"N 步动态" |
| M5-2 DAG 执行器 | 按拓扑序执行，独立节点并行 | 真正的管道编排 |
| M5-3 条件分支 | review 失败 → 回 implementer 修复 → 重新 review | 闭环验证 |
| M5-4 质量门 | acceptance criteria 检查，不通过自动重试 (≤2 次) | 产出质量保障 |
| M5-5 管道中断/恢复 | 保存执行状态到黑板，中断后可从断点续跑 | 长任务健壮性 |

### Phase 3: 异构 + 智能路由 (模式能力到位后)

前置条件: Phase 2.5 的 M2-M5 能力补全完成。

| 任务 | 内容 | 依赖 |
|---|---|---|
| F3-1 M6 异构团队 | per-agent model config + reasoning effort | M2-4, model-capability |
| F3-2 任务级路由 | input 事件做任务分类, 基于 git diff 而非全仓库 | Phase 2.5 完成 |
| F3-3 反馈闭环 | ExperienceStore 消费 telemetry, 统计最优模式 | Phase 2.5 完成 |
| F3-4 step-level model routing | 每步按任务复杂度选 model + effort | F3-1, F3-3 |
| F3-5 ILP 预算路由 | Python sidecar, ortools 选 model 组合 | F3-4 |
| F3-6 RL 经验路由 | stable-baselines 策略优化 | F3-3, F3-5 |
| F3-7 override_mode: auto | 路由器全自动 | F3-2 ~ F3-6 |

### Phase 4: 产品化

| 任务 | 内容 |
|---|---|
| F4-1 Web read-only dashboard | 路由历史 / cache 趋势 / 成本分析 |
| F4-2 Web control plane | 偏好调整 / 模式覆盖 / agent 管理 |
| F4-3 Electron/Tauri shell | 托盘 / 通知 / 后台 daemon / 多项目 |

---

## Phase 2.5 详细设计

### M2-1 并行 subagent

当前 `runSubagent` 是单次调用。新增并行封装:

```typescript
// src/extension/subagent.ts 新增
export async function runSubagentsParallel(
  opts: Array<{ agent: SubagentDef; task: string }>,
  common: { cwd: string; sessionId: string; telemetry?: TelemetryWriter; prefixLayout: boolean; pricing?: PricingTable },
): Promise<SubagentRunResult[]> {
  return Promise.all(
    opts.map(o => runSubagent({ ...common, agent: o.agent, task: o.task }))
  );
}
```

使用场景:
- C2 stage 并行: 测试 ‖ review 同时跑
- 多文件审查: 5 个 reviewer 各审一个文件

### M3-1 fork 工作流封装

```
/flux fork explore <task>
  → 自动 fork 两个分支
  → 分支 A: 用 effort=high 仔细做
  → 分支 B: 用 effort=low 快速试
  → 完成后 LLM 对比两分支输出
  → 推荐胜者, prune 败者
```

这比让用户手动 `/flux fork` + 输入两次任务 + 自己看哪个好，体验好得多。

### M4-1 持久 session subagent

当前 subagent 用 `--no-session`，每次都是 fresh context。改为可选保留:

```typescript
// subagent.ts 修改
if (opts.persistent) {
  // 不加 --no-session, 用 --session-id 指定持久 session 文件
  const sessionFile = join(fluxDir, "runtime", "sessions", `${agent.name}.session`);
  args.push("--session-id", sessionFile);
} else {
  args.push("--no-session");  // 保持当前行为
}
```

持久 reviewer 甜区验证: 同一 reviewer 跨多次调用，L2 cache 累积项目知识，收益是否 > compaction 代价。

### M4-2 agent 间消息传递

共享黑板新增 `messages/` 目录:

```
.agentflux/shared/
  ├── messages/
  │   ├── planner-1→implementer-1.json    # 定向消息
  │   ├── implementer-1→reviewer-1.json
  │   └── broadcast-001.json              # 广播消息
```

消息格式:
```json
{
  "from": "planner-1",
  "to": "implementer-1",
  "type": "task_update",
  "content": "schema 改了, user 表加了 deleted_at 字段",
  "timestamp": "2026-07-01T12:00:00Z"
}
```

agent 启动时检查自己的收件箱 (`messages/*→{self}.json`)。

### M5-1 动态任务分解

planner 的 system prompt 要求输出 JSON DAG:

```markdown
You are a planner. Analyze the task and output a JSON task graph.

Output format:
```json
{
  "tasks": [
    {
      "id": "t1",
      "title": "实现 User model",
      "role": "implementer",
      "dependsOn": [],
      "parallelizable": true,
      "files": ["src/models/user.ts"],
      "acceptanceCriteria": ["model 文件存在", "TypeScript 编译通过"]
    },
    {
      "id": "t2",
      "title": "实现 auth API",
      "role": "implementer",
      "dependsOn": ["t1"],
      "parallelizable": false,
      "files": ["src/api/auth.ts"],
      "acceptanceCriteria": ["API 路由存在", "登录/注册端点工作"]
    }
  ]
}
```
```

### M5-2 DAG 执行器

```typescript
// src/extension/dag-executor.ts (新增)
export async function executeDAG(
  dag: TaskDAG,
  ctx: any,
  teamCtx: TeamContext,
): Promise<void> {
  const completed = new Set<string>();
  const failed = new Set<string>();

  while (completed.size + failed.size < dag.nodes.length) {
    // 找出所有依赖已完成的就绪任务
    const ready = dag.nodes.filter(n =>
      !completed.has(n.id) &&
      !failed.has(n.id) &&
      n.dependsOn.every(d => completed.has(d))
    );

    if (ready.length === 0) {
      // 死锁检测
      throw new Error("DAG deadlock: no ready tasks but not all completed");
    }

    // 并行执行就绪任务
    const results = await Promise.all(
      ready.map(node => runTaskWithGate(node, ctx, teamCtx))
    );

    for (const { node, passed } of results) {
      if (passed) completed.add(node.id);
      else failed.add(node.id);
    }
  }
}
```

---

## 与原 roadmap 的关系

原 docs/07 的 Phase 3 内容拆分:
- **Phase 2.5** (新增): M2-M5 执行能力补全 — 原来散落在各处的"模式实现"
- **Phase 3** (调整): 异构 + 智能路由 — 原来的 F3-1~F3-7, 前置条件改为 Phase 2.5 完成
- **Phase 4** (新增): 产品化 — 原来的 UI-B/C/D

原 Phase 1/2 已完成的内容不变, 只调整后续优先级。

## 交叉引用

- 六模式定义: [03](03-modes.md)
- 多 agent 架构: [19](19-multi-agent-architecture.md)
- 路由: [05](05-routing.md) — 路由优化后置到此阶段之后
- reasoning effort: [21](21-reasoning-effort.md) — 模型路由新维度
- 原路线图: [07](07-roadmap.md) — 已按此文档调整
- 实证数据: [20](20-empirical-findings.md) — mask 重设计需求
