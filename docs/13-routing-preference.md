# 13 - 路由偏好与可视化配置

> 后置研究。当前生产入口不使用自动路由或路由偏好向量。

## 要解决的问题

用户对"准确性 / 成本 / 效率"三难的取舍因人、因场景而异。文档 [04](04-config-schema.md) 的预设档位(eco/fast/accurate/balanced)是离散的"一键选",但用户真正想要的是:

- **连续的倾向**,不是非此即彼。比如"成本不太敏感、偏准确性,但别一上来就上 multi-agent"。
- **按场景分倾向**。比如 bugfix 倾向 M1 快速修,feature 倾向 M2 走 review,大重构倾向 M3 fork 探索。
- **在 TUI 和 Web 里方便地可视化调整**,而不是手写 YAML。

本章把"路由偏好"提升为一等可配置、可可视化的概念,覆盖 [04](04-config-schema.md) 预设档位之上的一层。

---

## 一、偏好画像(Preference Profile)

预设档位是"样板间",偏好画像是"自己装修"。在预设之上,用户调一组权重,路由器据此偏置候选模式集。

### 偏好维度

| 维度 | 取值 | 含义 | 对路由的影响 |
|---|---|---|---|
| `cost_sensitivity` | 0.0–1.0 | 对成本的在意程度 | 高 → 偏 M1/M2 + 强缓存优化;低 → 放行 M3/M4/M6 |
| `accuracy_priority` | 0.0–1.0 | 对准确性的优先级 | 高 → 偏 M3/M4/M6 + 独立 review;低 → 接受 M1 |
| `latency_priority` | 0.0–1.0 | 对 wall-clock 的在意 | 高 → 偏并行(C2/C3);低 → 接受 C1 串行省钱 |
| `parallelism_willingness` | 0.0–1.0 | 愿意为并行付出多少多 context 成本 | 高 → 放行 C2/C3;低 → 偏 C1 |
| `multi_agent_willingness` | 0.0–1.0 | 对持久 multi-agent / 异构团队的接受度 | 高 → 放行 M4/M6;低 → 限制在 M1/M2/M3 |

### 预设档位 = 偏好向量的样板

预设档位本质是预设的偏好向量,用户可在此基础上微调:

| 档位 | cost | accuracy | latency | parallel | multi_agent |
|---|---|---|---|---|---|
| `eco` | 1.0 | 0.3 | 0.2 | 0.1 | 0.0 |
| `fast` | 0.3 | 0.5 | 1.0 | 0.8 | 0.3 |
| `accurate` | 0.2 | 1.0 | 0.4 | 0.6 | 0.9 |
| `balanced` | 0.6 | 0.6 | 0.5 | 0.5 | 0.4 |

> "成本不敏感且准确性优先 → 多用 multi-agent" = `accurate` 档位(multi_agent=0.9),或自定义把 `multi_agent_willingness` 拉到 0.8+。

### 偏好如何影响路由

路由器([05](05-routing.md))在层 1 产出候选模式集后,用偏好向量对候选打分:

```
score(mode) = w_accuracy × accuracy(mode)
            + (1 - w_cost) × cost_efficiency(mode)
            + w_latency × speed(mode)
            - gate_penalty(mode, preference)   // 越界模式扣分
```

其中 `gate_penalty` 处理"用户明确不愿"的情况:
- `multi_agent_willingness < 0.3` 且无强信号 → M4/M6 直接出局
- `cost_sensitivity > 0.8` 且预算紧 → M4 出局

**偏好是"倾向"不是"硬锁"**:强任务信号(如跨 PR 持久、高耦合需并行验证)仍能突破低偏好,但会在 `override_mode: suggest` 下提示用户"建议破例升级"。

---

## 二、按场景的偏好(Scenario Overrides)

用户可对不同任务类型设不同倾向,覆盖全局偏好:

```yaml
preference:
  profile: accurate            # 全局基线
  cost_sensitivity: 0.2
  accuracy_priority: 1.0
  multi_agent_willingness: 0.9

  scenarios:                   # 场景级覆盖,优先于全局
    bugfix:
      profile: eco             # 小修小补别上重武器
      latency_priority: 0.8
    explore:
      profile: balanced
      multi_agent_willingness: 0.1
    refactor:
      profile: fast            # 多方案并行探索
      parallelism_willingness: 0.9
    feature:
      profile: accurate        # 走 review
      accuracy_priority: 0.9
```

场景由层 1 的 `task_type` 信号(bugfix/feature/refactor/review/explore)判定。场景匹配优先于全局,全局优先于档位默认。

### 场景匹配规则

```
1. 层1 识别 task_type
2. 查 scenarios[task_type],有则用其 profile + 覆盖项
3. 否则用全局 preference
4. 偏好向量 + 层1/2/3 信号 → 最终模式
```

---

## 三、配置 Schema 扩展(接 [04](04-config-schema.md))

在 Level 2/3 之间插入"偏好层",作为 Level 2 之上的可选精细化:

```yaml
preference:
  profile: balanced              # eco|fast|accurate|balanced|custom
  cost_sensitivity: 0.6          # 0.0-1.0, 仅 custom 模式生效
  accuracy_priority: 0.6
  latency_priority: 0.5
  parallelism_willingness: 0.5
  multi_agent_willingness: 0.4

  scenarios:
    bugfix:    { profile: eco, latency_priority: 0.8 }
    refactor:  { profile: fast, parallelism_willingness: 0.9 }
    feature:   { profile: accurate, accuracy_priority: 0.9 }
    explore:   { profile: balanced, multi_agent_willingness: 0.1 }
    review:    { profile: accurate, multi_agent_willingness: 0.6 }

  escalate_hint: suggest         # 偏好与强信号冲突时: suggest|auto|silent
```

`escalate_hint` 控制"破例升级"的交互:
- `suggest`(默认):冲突时弹 route inspector 让用户确认
- `auto`:信任信号,直接升级,事后可在 history 看
- `silent`:不提示,静默按信号走(适合高级用户)

### 优先级链(更新)

```
场景覆盖 > 全局偏好 > Level 3 参数 > Level 2 开关 > Level 1 档位 > 默认
```

---

## 四、TUI 可视化

目标:用户在 terminal 里调偏好,像调音台一样直观。复用 pi TUI 组件([10](10-pi-integration.md) §5、[12](12-ui-direction.md))。

### 1. `/flux preference` —— 偏好调音台

用 `SettingsList` 做带数值档位的调音台:

```
┌─ AgentFlux · Preference ─────────────────────────┐
│  ↑↓ 移动  ←→ 调整  enter 场景  esc 返回            │
│                                                  │
│  Profile          [balanced]  ▶ eco fast accurate│
│  Cost             [██████░░░░] 0.6               │
│  Accuracy         [██████░░░░] 0.6               │
│  Latency          [█████░░░░░] 0.5               │
│  Parallelism      [█████░░░░░] 0.5               │
│  Multi-agent      [████░░░░░░] 0.4               │
│                                                  │
│  Scenarios ▸                                      │
│    bugfix    eco   · latency 0.8                 │
│    refactor  fast  · parallel 0.9                │
│    feature   accurate · accuracy 0.9            │
└──────────────────────────────────────────────────┘
```

- 数值用 `SettingsList` 的 values 档位(0.0/0.1/.../1.0)
- 调整实时反映到 footer 的"预估落点"(M1–M6 哪一档)
- 场景项 `enter` 进入子调音台

### 2. footer 实时反馈

调偏好时,footer 显示当前倾向会落到哪个模式:

```
flux · pref: accurate(±) · → M6 likely · cache 风险 high · $预估 0.6
```

### 3. `/flux why` 体现偏好

route inspector 里单独一栏展示"本次决策受偏好影响多少":

```
Preference impact
  profile: accurate (multi_agent=0.9) → 候选提升 M4/M6 +0.3
  scenario: feature → accuracy=0.9 → 强化独立 review
  escalate: 无冲突,偏好与信号一致
```

---

## 五、Web 可视化(后续)

Web 是偏好编辑的主战场,因为可以画连续滑块、雷达图、对比预览。接 [12](12-ui-direction.md)。

### 1. Preference Studio 页面

- **雷达图**:五个偏好维度一图呈现,拖动顶点即调
- **滑块组**:每个维度带实时落点指示(M1–M6 哪一档会被选中)
- **场景表**:每行一个 task_type,点开调其覆盖
- **预览面板**:给定一组示例任务,实时显示当前偏好下各会路由到哪,方便"调一调看效果"
- **冲突提示**:偏好与强信号冲突时高亮,说明破例规则

### 2. 偏好版本与对比

- 偏好改动存版本(写入 telemetry),可回滚
- A/B 对比两个偏好画像在同一批历史任务上的路由差异、成本差异
- 这是 Phase 3 RL 经验路由的训练数据来源

---

## 六、与三层路由的集成

偏好不取代三层路由,而是作为**贯穿三层的偏置项**:

| 路由层 | 偏好的作用 |
|---|---|
| 层1 静态信号 | 候选模式集生成后,用偏好打分排序 + gate 出局 |
| 层2 预算 ILP | `cost_sensitivity` 调整 ILP 目标函数权重;`max_cost_per_task` 是硬约束 |
| 层3 经验 RL | 偏好向量作为 RL 状态的一部分,策略学习"在该偏好下哪种模式历史更优" |

冷启动(Phase 1)只实现:偏好向量 + 层1 gate + 简单打分,无需 ILP/RL。

---

## 七、完成标准

- [x] 偏好画像五维度 + 预设映射
- [x] 按场景覆盖机制
- [x] 配置 schema 扩展(接 04)
- [x] TUI 调音台 + footer 反馈 + why 体现
- [x] Web Preference Studio 方向
- [x] 与三层路由的集成方式
- [ ] V0 至少读取 `profile` 并在 footer 显示当前倾向落点
