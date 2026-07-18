# 04 - 配置层设计

> 历史配置设计。当前配置与命令以 [README](../README.md) 和 [26](26-implementation-status.md) 为准。

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
  max_cost_per_task: 2.00         # 美元,当前作为任务硬停止边界
  max_iterations: 5               # 迭代轮数上限
  max_wall_clock_seconds: 600

routing:
  static_signals: true            # 启用任务结构信号路由
  budget_aware: true              # 当前启用成本/次数/墙钟限制；模型/拓扑优化器待接入
  experience_aware: false         # 启用历史经验 RL 路由(Phase 3)
  override_mode: auto             # auto | manual | suggest

communication:
  rpc_inbox_pump: false           # Persistent/RPC runtime 自动消费 Message V2；目前为实验性 opt-in
  poll_interval_ms: 1000          # 轮询间隔，100..60000
  batch_size: 5                   # 单批注入数，1..20
  heartbeat_interval_ms: 10000    # 实例 heartbeat，1..60 秒
  runtime_lease_ms: 30000         # 同名实例租约，5..300 秒，建议至少 2× heartbeat
  redelivery_after_ms: 30000      # 未 ACK delivery 重投等待，5 秒..1 小时

retention:
  enabled: true                   # session_start 自动清理；也可用 /flux gc
  stale_runtime_ttl_hours: 1      # 有 instanceId+heartbeat 的失联 RPC runtime 1 小时后归档
  terminal_agent_ttl_hours: 168   # 终态 Agent 活跃记录保留 7 天
  max_terminal_agents: 100        # 每类 registry 最多保留的终态记录
  read_message_ttl_hours: 72      # 已读点对点消息活跃保留时间
  max_read_messages: 500          # 活跃目录最多保留的 V1 已读点对点 / 全接收者终态 V2 消息
  orphan_session_ttl_hours: 168   # 无活跃 Agent 引用的 session 保留时间
```

当前实现状态（2026-07-15）：`static_signals` 已接入统一 RoutePlan，关闭后任务分类/复杂度信号不会参与模式决策；`budget_aware` 只代表生产执行器执行任务成本、迭代次数和墙钟硬边界，并会在 RoutePlan 中显示为 `limits_only`。预算约束下的模型/拓扑联合优化（设计中的 ILP/近似优化器）尚未接入生产入口，不能把该开关理解为已实现最优成本路由。

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

communication:
  rpc_inbox_pump: false
  poll_interval_ms: 1000
  batch_size: 5
  heartbeat_interval_ms: 10000
  runtime_lease_ms: 30000
  redelivery_after_ms: 30000

retention:
  enabled: true
  stale_runtime_ttl_hours: 1
  terminal_agent_ttl_hours: 168
  max_terminal_agents: 100
  read_message_ttl_hours: 72
  max_read_messages: 500
  orphan_session_ttl_hours: 168
```

生命周期清理处理 `done`、`failed`、`cancelled` 等终态，也会归档超过 `stale_runtime_ttl_hours`、同时具备 `role=rpc-runtime`、`instanceId` 与有效 `heartbeatAt` 的失联 runtime。普通运行中/阻塞/等待重试 Agent、没有实例身份的 legacy 记录、未读消息、广播消息、群组历史和被活跃 Agent 引用的 session 不会自动清理。旧版 legacy 记录只能用 `/flux gc legacy dry-run <agent-name...>` 预览，再以 `/flux gc legacy <agent-name...>` 显式清理；仍要求超过同一 TTL、无 instanceId、无 runtimePid，且有活跃 AgentFlux run 时 fail-closed。被处理的消息、session 与 Agent 元数据会写入 `.agentflux/archive/lifecycle/<run-id>/` 的审计 manifest；dry-run 不创建目录、不修改文件。

`communication.rpc_inbox_pump` 默认关闭，避免普通 TUI 会话在未声明稳定身份时意外消费信箱。Desktop/Persistent RPC runtime 可通过配置开启，或由受控启动器设置 `AGENTFLUX_RPC_INBOX_PUMP=1`、`AGENTFLUX_AGENT_NAME` 与 `AGENTFLUX_RUNTIME_INSTANCE_ID`。首轮 poll 会等待 `session_start` 返回，避免初始化重入。空闲消息转换为 `prompt`；忙碌时 high/critical 或 `steer` 消息转换为 `steer`，普通消息转换为 `follow_up`。Delivery 只有在对应注入轮次产生成功 assistant 结果后才 ACK；pi 会在同一 lifecycle 内 drain follow-up，因此 ACK 绑定下一次 assistant 结果而不等待第二个 `agent_start`。

每个 runtime 用 `instanceId` 注册并续 heartbeat；租约有效时，同名第二实例 fail-closed，所有 presence 更新也按实例 fencing，避免旧进程覆盖接管者。崩溃后 Delivery 保持 delivered，待 runtime lease 和 redelivery lease 到期后可由同名新实例重投；默认均为 30 秒。Abort 在 SharedBoard 中记录为 `cancelled`，graceful shutdown 最终记录为 `done`。

## 配置优先级

```
用户运行时覆盖 > 场景偏好覆盖 > 全局偏好 > Level 3 参数 > Level 2 开关 > Level 1 档位 > 默认(balanced)
```

偏好层(场景覆盖 + 全局偏好)见 [13](13-routing-preference.md),项目成熟度基线见 [14](14-project-evolution.md)。

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
