# 21 - 模型路由: Reasoning Effort 维度

> 本文档记录 reasoning effort 作为模型路由的新维度, 作为后续开发规划。
> 当前模型能力层 (docs/17, src/core/model-capability.ts) 只考虑 5 维能力向量,
> 缺少 reasoning effort 控制 (pi 的 `--thinking` 参数: off/low/medium/high)。

## 问题

当前 AgentFlux 的模型路由只决定"用哪个模型", 不决定"模型思考多深"。

但 reasoning effort 是一个独立于模型选择的成本-准确性杠杆:

| Effort | 机制 | 成本 | 准确性 | 适用 |
|---|---|---|---|---|
| off | 不触发 thinking | 最低 | 基础 | 简单执行、格式化、读取 |
| low | 短 thinking | 低 | 中 | 常规编码、小 bugfix |
| medium | 中等 thinking | 中 | 高 | 复杂逻辑、跨文件修改 |
| high | 长 thinking | 高 | 最高 | 架构决策、疑难 bug、规划 |

## 与六模式的关系

reasoning effort 应该和模式联动:

| 模式 | 典型 effort | 理由 |
|---|---|---|
| M1 单 agent | 跟随用户设置 | M1 是默认, 不额外干预 |
| M2 主+subagent | child 可低于 parent | subagent 做执行类任务时 effort 可降 |
| M3 对话树 fork | 各分支可不同 | A/B 探索: 一个 high 仔细想, 一个 low 快速试 |
| M4 持久 multi-agent | 按角色分 | planner high, implementer medium, reviewer high |
| M5 管道 handoff | 按阶段分 | plan high, impl medium, test low, review high |
| M6 异构团队 | model × effort 双维度 | opus+high 决策, flash+low 执行 |

## 设计方案

### 扩展能力向量

在 `ModelCapability` 增加 `reasoning_effort_default` 字段:

```typescript
export interface ModelCapability {
  coding: number;
  reasoning: number;
  speed: number;
  context: number;
  cost_eff: number;
  // 新增: 该模型推荐的基础 effort (0=off, 1=low, 2=medium, 3=high)
  reasoning_effort_default: number;
}
```

不同模型在不同 effort 下的收益不同:
- GPT-5.5 / Claude Opus: high effort 收益大 (reasoning 能力强, thinking 质量高)
- DeepSeek-Flash / Haiku: low effort 已够 (速度快, high effort 边际收益小)

### 扩展角色需求

在 `RoleRequirement` 增加 `reasoning_effort` 字段:

```typescript
export interface RoleRequirement {
  coding?: number;
  reasoning?: number;
  speed?: number;
  context?: number;
  cost_eff?: number;
  // 新增: 角色期望的 effort (0-3)
  reasoning_effort?: number;
}
```

角色定义示例:

```json
{
  "planner":     { "requirement": { "reasoning": 0.9, "reasoning_effort": 3 } },  // high
  "implementer": { "requirement": { "coding": 0.8, "reasoning_effort": 2 } },     // medium
  "tester":      { "requirement": { "coding": 0.7, "reasoning_effort": 1 } },     // low
  "reviewer":    { "requirement": { "reasoning": 0.8, "reasoning_effort": 3 } }   // high
}
```

### 扩展亲和度计算

`calcAffinity()` 增加 effort 维度匹配:

```typescript
if (requirement.reasoning_effort !== undefined) {
  // 模型的 reasoning 能力 × 期望 effort 的收益系数
  // effort 3 在 reasoning 0.9 的模型上收益大, 在 reasoning 0.6 的模型上收益小
  const effortGain = capability.reasoning * (requirement.reasoning_effort / 3);
  sum += 0.15 * effortGain;  // effort 维度权重 0.15
}
```

### 扩展 subagent 调用

`runSubagent()` 增加 `thinking` 参数, 传递给 pi 子进程:

```typescript
export async function runSubagent(opts: {
  // ... 现有参数
  thinking?: "off" | "low" | "medium" | "high";  // 新增
}): Promise<SubagentRunResult> {
  // ...
  args.push("--thinking", opts.thinking ?? "off");  // 默认 off, 角色可覆盖
  // ...
}
```

### 扩展路由器

路由器在选择模式时, 同时输出推荐的 effort:

```typescript
export interface RoutingDecision {
  // ... 现有字段
  recommendedEffort: "off" | "low" | "medium" | "high";
}
```

路由规则:
- taskType=explore → low (快速浏览不需要深思)
- taskType=bugfix → medium (需要理解因果链)
- taskType=refactor (complex) → high (需要全局视角)
- taskType=review → high (需要发现隐藏问题)

## 与 step-level routing 的关系

reasoning effort 是 step-level model routing 的一个子维度。完整的 step-level routing (docs/20 改进 4) 包含:

1. **model 选择**: 哪个模型 (affinity 匹配)
2. **effort 选择**: 思考多深 (reasoning_effort)
3. **budget 分配**: 这一步花多少预算 (ILP 约束)

reasoning effort 是最容易先落地的: 不需要历史数据, 不需要 ILP, 只需要角色定义 + 传参。

## 实现优先级

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 阶段 1 | 角色定义加 reasoning_effort 字段 + subagent 传参 | 无 |
| 阶段 2 | 亲和度计算纳入 effort 维度 | 阶段 1 |
| 阶段 3 | 路由器输出 recommendedEffort | 阶段 2 + 任务级路由 |
| 阶段 4 | 运行时动态调整 effort (基于执行反馈) | 阶段 3 + 反馈闭环 |

## 与 pi 的集成

pi 支持 `--thinking` 参数:
- `--thinking off`: 不触发 extended thinking
- `--thinking low/medium/high`: 对应不同 thinking budget

子进程已在 `subagent.ts` 中用 `--thinking off` 固定关闭。改为按角色配置后:

```typescript
// subagent.ts
const thinking = opts.thinking ?? agent.thinking ?? "off";
args.push("--thinking", thinking);
```

## 交叉引用

- 模型能力: [17](17-model-capability.md) — 能力向量 + 亲和度
- 角色设计: [18](18-agent-roles.md) — 角色定义格式
- 路由: [05](05-routing.md) — 三层路由
- subagent: `src/extension/subagent.ts` — 子进程 --thinking 参数
- 实证数据: [20](20-empirical-findings.md) — 成本实验基准
