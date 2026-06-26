# 17 - 模型能力层

> 解决"谁做规划谁做执行"的问题。不硬编码角色-模型绑定,而是用能力向量 × 角色需求 = 亲和度自动推导。

## 问题

M6 异构团队的核心问题是角色-模型分配:

- gpt-5.5 做规划,deepseek-v4-flash 做开发 —— 这是直觉,但凭什么?
- 如果用户加了 claude opus,分配要自动调整吗?
- 如果用户只有 deepseek-flash 一个模型,所有角色都该用它吗?

硬编码 "opus→planner, flash→implementer" 不可持续:模型在迭代,用户配置千差万别。需要一个**数据驱动的匹配机制**。

## 设计:能力向量 × 角色需求 = 亲和度

### 模型能力向量

每个模型在 5 个维度上有标准化分数 (0-1):

| 维度 | 含义 | 数据来源 |
|---|---|---|
| `coding` | 编码能力 | SWE-bench / LiveCodeBench / HumanEval |
| `reasoning` | 推理能力 | GPQA / MMLU-Pro / 数学竞赛 |
| `speed` | 速度 (tokens/sec) | Artificial Analysis |
| `context` | 上下文窗口 | log scale normalized: `log(ctx) / log(1M)` |
| `cost_eff` | 性价比 | `1 / (input_price + output_price)`, normalized |

### 角色需求向量

每个角色对 5 个维度的需求权重不同 (0-1, 不要求归一化):

```json
{
  "planner":     { "coding": 0.3, "reasoning": 0.9, "speed": 0.2, "context": 0.7, "cost_eff": 0.3 },
  "implementer": { "coding": 0.8, "reasoning": 0.5, "speed": 0.6, "context": 0.5, "cost_eff": 0.7 },
  "reviewer":    { "coding": 0.7, "reasoning": 0.8, "speed": 0.3, "context": 0.6, "cost_eff": 0.4 },
  "tester":      { "coding": 0.7, "reasoning": 0.5, "speed": 0.5, "context": 0.4, "cost_eff": 0.6 }
}
```

内置默认,用户可在角色 JSON 中覆盖。

### 亲和度 = 加权点积

```
affinity(model, role) = Σ_k (requirement[role][k] × capability[model][k])
```

### 分配规则

```
assign(role) = argmax_model ( affinity(model, role) )
```

- 多个模型亲和度接近 (差值 < 0.05) 时,用 `cost_eff` 破平局 —— 选"最划算的够用"
- 只有一个可用模型时,所有角色都分给它 (退化为同构)

### 示例

```
gpt-5.5:         { coding: 0.85, reasoning: 0.95, speed: 0.40, context: 0.70, cost_eff: 0.15 }
deepseek-flash:  { coding: 0.78, reasoning: 0.70, speed: 0.85, context: 0.60, cost_eff: 0.90 }

planner 需求:     { coding: 0.3, reasoning: 0.9, speed: 0.2, context: 0.7, cost_eff: 0.3 }
  gpt-5.5:         0.3×0.85 + 0.9×0.95 + 0.2×0.40 + 0.7×0.70 + 0.3×0.15 = 1.69
  deepseek-flash:  0.3×0.78 + 0.9×0.70 + 0.2×0.85 + 0.7×0.60 + 0.3×0.90 = 1.44
  → planner = gpt-5.5 ✓ (reasoning 权重高)

implementer 需求: { coding: 0.8, reasoning: 0.5, speed: 0.6, context: 0.5, cost_eff: 0.7 }
  gpt-5.5:         0.8×0.85 + 0.5×0.95 + 0.6×0.40 + 0.5×0.70 + 0.7×0.15 = 1.63
  deepseek-flash:  0.8×0.78 + 0.5×0.70 + 0.6×0.85 + 0.5×0.60 + 0.7×0.90 = 2.20
  → implementer = deepseek-flash ✓ (speed + cost_eff 权重高)
```

## 数据来源 (四层降级)

与价格层 (docs/16) 共用相同的降级架构:

| 层 | 来源 | 可信度 | 阶段 |
|---|---|---|---|
| 1. 用户手动 | `.agentflux/models.json` 里 `capability` 字段 | 最高 | 现阶段 |
| 2. 远程 benchmark | Artificial Analysis API / GitHub Action price file | 高 | 后续 |
| 3. 模型家族启发式 | GPT→reasoning强, DeepSeek→coding/cost强, Gemini→context大 | 中 | 兜底 |
| 4. 均值兜底 | 所有已知模型各维度均值 | 低 | 最后手段 |

### 现阶段:用户手动填

`models.json` 里 `capability` 是可选字段。不填时走启发式:

```
GPT 家族:     coding=0.85, reasoning=0.90, speed=0.40, cost_eff=0.20
Claude 家族:  coding=0.88, reasoning=0.92, speed=0.45, cost_eff=0.25
DeepSeek 家族: coding=0.78, reasoning=0.70, speed=0.80, cost_eff=0.85
Gemini 家族:  coding=0.80, reasoning=0.82, speed=0.70, cost_eff=0.50
Qwen 家族:    coding=0.75, reasoning=0.75, speed=0.75, cost_eff=0.60
未知:         所有维度=0.50 (均值)
```

`context` 维度始终从 `contextWindow` 字段自动计算,不需要手填。
`cost_eff` 维度始终从 pricing 层 (docs/16) 的 per-token 价格自动计算,不需要手填。

### 后续:API 接入

做了 UI 后,通过 `/models` 命令获取所有可用模型,从 Artificial Analysis 或类似聚合站拉取 benchmark 数据,自动填充 `capability` 字段。结构不变,只是数据来源从手动变自动。

## models.json 完整结构

```json
{
  "models": {
    "gpt-5.5": {
      "provider": "octopus-anthropic",
      "contextWindow": 900000,
      "pricing": {
        "input": 5e-6,
        "output": 3e-5,
        "cacheRead": 5e-7,
        "cacheWrite": 6.25e-6
      },
      "capability": {
        "coding": 0.85,
        "reasoning": 0.95,
        "speed": 0.40
      }
    },
    "deepseek-v4-flash": {
      "provider": "octopus-anthropic",
      "contextWindow": 1000000,
      "pricing": {
        "input": 9e-8,
        "output": 1.8e-7,
        "cacheRead": 2e-8
      },
      "capability": {
        "coding": 0.78,
        "reasoning": 0.70,
        "speed": 0.85
      }
    }
  },
  "roles": {
    "planner": {
      "requirement": { "coding": 0.3, "reasoning": 0.9, "speed": 0.2, "context": 0.7, "cost_eff": 0.3 },
      "tools": ["read", "grep", "find", "ls", "bash"],
      "skills": ["planning"],
      "systemPrompt": "You are a senior planner..."
    },
    "implementer": {
      "model": "deepseek-v4-flash",
      "tools": ["read", "write", "edit", "bash", "grep", "find"],
      "systemPrompt": "You are a senior developer..."
    },
    "reviewer": {
      "requirement": { "coding": 0.7, "reasoning": 0.8, "cost_eff": 0.4 },
      "tools": ["read", "grep", "bash"],
      "skills": ["code-review"],
      "systemPrompt": "You are a code reviewer..."
    }
  },
  "sharedSkills": ["project-context", "git-workflow"]
}
```

### 字段说明

**models.{name}**:
- `provider` (必填): pi provider 名称
- `contextWindow` (必填): 上下文窗口大小 (tokens)
- `pricing` (可选): per-token 单价,不填走价格层降级
- `capability` (可选): 手动填 coding/reasoning/speed,不填走启发式; context 和 cost_eff 始终自动计算

**roles.{name}**:
- `requirement` (与 `model` 二选一): 能力需求向量,运行时亲和度匹配选模型
- `model` (与 `requirement` 二选一): 直接指定模型名
- 两者都有时: `model` 首选,不可用则 fallback 到 `requirement` 匹配
- 两者都没有: 报错 "角色必须指定 model 或 requirement"
- `tools` (可选): 角色可用工具列表,不填则继承全部内置工具
- `skills` (可选): 角色特有 skills,加载 sharedSkills + skills
- `systemPrompt` (可选): 角色 system prompt,不填用 agent .md 文件的 body

## 运行时检查逻辑

```
角色启动时:
1. 如果 role 有 model 字段:
   a. 检查 model 是否在 models.json 里存在
   b. 检查 model 的 provider 是否在 pi 当前环境中可用
   c. 存在且可用 → 用它
   d. 不存在 → 如果有 requirement, 走亲和度匹配; 否则报错
2. 如果 role 只有 requirement:
   a. 遍历 models.json 里所有模型, 算亲和度
   b. 取最高者 (差值 < 0.05 时用 cost_eff 破平局)
   c. 只有一个模型 → 直接用它 (退化为同构)
3. 都没有 → 报错
```

## 与 Phase 3 ILP 的关系

亲和度点积是 Phase 2 的 O(N×M) 方案,几行代码,纯 TS。

Phase 3 的 ILP (BAMAS) 在此基础上加 budget 约束优化:
- 点积给出"谁最适合",ILP 给出"在预算约束下谁最优"
- ILP 不推倒点积,而是在点积结果上加约束求解
- 冷启动期用点积,数据足够后升级 ILP

## 命令

| 命令 | 功能 |
|---|---|
| `/flux models` | 列出所有可用模型 + 能力向量 + 当前分配 |
| `/flux models <name>` | 查看单个模型详情 (能力/价格/context) |
| `/flux affinity` | 显示每个角色的亲和度排名 (所有候选模型得分) |

## 交叉引用

- 价格层: [16](16-pricing-layer.md) — pricing 字段的数据来源和降级
- 角色定义: [18](18-agent-roles.md) — 角色完整定义和实例化
- 多 agent 架构: [19](19-multi-agent-architecture.md) — 共享层和沟通机制
- 路由: [05](05-routing.md) — 模型策略维度 (D) 如何影响模式选择
- 配置: [04](04-config-schema.md) — models.json 在配置体系中的位置
