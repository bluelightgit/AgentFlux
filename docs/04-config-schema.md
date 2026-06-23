# 04 - 配置层设计

配置分三档,从粗到细。用户可以只选第一档(预设),也可以一路下钻到参数级。路由器([05](05-routing.md))在用户未显式指定时按档位默认行为执行。

## Level 1:预设档位(一键选)

```yaml
mode: balanced   # eco | fast | accurate | balanced | custom
```

| 档位 | 等价组合 | 面向场景 |
|---|---|---|
| `eco` | M1 + B2 mask | 省钱,简单任务 |
| `fast` | M3 fork + C3 task 并行 | wall-clock 优先 |
| `accurate` | M6 异构 + 独立 review | 质量优先 |
| `balanced` | M2 + 缓存优化 + C2 stage 并行 | **默认**,迭代开发主流程 |
| `custom` | 解锁 Level 2/3 | 高级用户 |

档位是 Level 2 维度的预设组合,选 `custom` 后由 Level 2/3 接管。

## Level 2:维度开关(进阶)

```yaml
context_topology: star        # single | star | fork | peers   (维度 A)
lifecycle: mask               # compact | mask | handoff | fork-prune  (维度 B)
parallelism: stage            # sequential | stage | task      (维度 C)
model_strategy: homogeneous   # homogeneous | heterogeneous    (维度 D)
```

含义见 [02-dimensions](02-dimensions.md)。维度间有软约束(如 `peers` 倾向 `handoff`/`fork-prune`),配置校验器会给出 warning 而非硬报错。

## Level 3:细粒度参数(专家)

```yaml
cache:
  prefix_layout: static_first     # 强制 diff/动态内容放后部
  cache_breaker_actions:          # 禁止这些 cache 杀手
    - timestamp_in_system_prompt
    - tool_reorder
    - mid_session_model_switch
  target_hit_rate: 0.85           # 低于此触发告警

context:
  compaction_threshold: 0.70      # 70% 触发评估(别等 90%)
  mask_strategy: hide_tool_results
  mask_keep_last_n: 3             # 保留最近 N 个 tool result

budget:
  max_cost_per_task: 2.00         # 美元,触发 ILP 路由
  max_iterations: 5               # 迭代轮数上限
  max_wall_clock_seconds: 600

routing:
  static_signals: true            # 启用任务结构信号路由
  budget_aware: true              # 启用预算 ILP 路由
  experience_aware: false         # 启用历史经验 RL 路由(Phase 3)
  override_mode: auto             # auto | manual | suggest
```

## 完整 Schema 示例

```yaml
# AgentFlux 配置示例:成本敏感的迭代开发
mode: custom

context_topology: star
lifecycle: mask
parallelism: stage
model_strategy: homogeneous

cache:
  prefix_layout: static_first
  target_hit_rate: 0.85

context:
  compaction_threshold: 0.70
  mask_strategy: hide_tool_results
  mask_keep_last_n: 3

budget:
  max_cost_per_task: 1.50
  max_iterations: 4

routing:
  static_signals: true
  budget_aware: true
  experience_aware: false
  override_mode: suggest   # 路由器建议,用户确认
```

## 配置优先级

```
用户运行时覆盖 > Level 3 参数 > Level 2 开关 > Level 1 档位 > 默认(balanced)
```

- `override_mode: auto` —— 路由器全自动选模式,用户配置仅作约束
- `override_mode: suggest` —— 路由器给出建议,用户确认后执行(默认)
- `override_mode: manual` —— 路由器只分析不执行,完全由用户选

## 配置校验规则(软约束示例)

| 组合 | 状态 | 处理 |
|---|---|---|
| `peers` + `compact` | warning | 持久 session 用 compact 会频繁摧毁 cache,建议 `handoff`/`fork-prune` |
| `fork` + `handoff` | warning | fork 本身就是生命周期管理,建议 `fork-prune` |
| `heterogeneous` + `single` | error | 单 context 无法放多 model,改 `star`/`peers` |
| `task` 并行 + `max_cost_per_task` 低 | warning | 并行多 context,可能超预算,建议 `stage` |
