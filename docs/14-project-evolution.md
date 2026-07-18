# 14 - 项目演进与角色演进

> 历史设计记录。当前实现状态见 [26](26-implementation-status.md)。

## 要解决的问题

同一个项目,在不同成长阶段,最适合的 agent 工作方式不同:

- **从零起步**:代码少、依赖浅,单 agent(M1)直接干,又快又省。
- **增长期**:文件变多、模块出现,单 agent context 开始吃力,需要主+subagent(M2)做 review。
- **成熟期**:跨模块、多 PR、长期协作,主 agent 不该再亲自写代码,而应变成**规划/调度/审查**角色,把实现交给 subagent 或持久团队(M4/M6)。

文档 [05](05-routing.md) 层1 的信号是**单任务**的(本次 diff 的文件数/耦合度),没有**项目级、跨 session 累积**的成熟度概念。本章补上这个维度:把"项目成熟度"作为路由输入,驱动 agent 角色随项目成长而演进。

---

## 一、项目成熟度(Project Maturity)

### 成熟度信号(跨 session 累积)

区别于 [05](05-routing.md) 的单任务信号,这些信号是**项目级、长期累积**的,缓存在 `.agentflux/project-profile.json`:

| 信号 | 来源 | 含义 |
|---|---|---|
| `codebase_loc` | git/cloc | 代码总量 |
| `file_count` | git | 跟踪文件数 |
| `module_count` | 依赖图 | 顶层模块数 |
| `dependency_depth` | 静态分析 | 依赖链最大深度 |
| `cross_module_coupling` | 依赖图 | 跨模块引用密度 |
| `test_coverage` | coverage 工具 | 测试覆盖(可选) |
| `commit_history` | git log | 提交数量/跨度 |
| `pr_count` | git/平台 | 累计 PR 数 |
| `session_history` | telemetry | 累计会话数/turn 数 |

### 生命周期阶段(呼应 GitSwarm 的 repo lifecycle)

```
Seed ──► Growth ──► Established ──► Mature
  M1        M2         M2/M5/M4       M4/M6
```

| 阶段 | 信号特征 | 推荐默认模式 | agent 角色 |
|---|---|---|---|
| **Seed** | LOC<5k, 文件<50, 单模块, 无跨模块耦合 | M1 | **doer**:单 agent 全干 |
| **Growth** | LOC 5k–30k, 多模块, 轻度耦合 | M2 | **doer+reviewer**:主 agent 干活 + subagent 审查 |
| **Established** | LOC 30k–100k, 深依赖, 跨模块耦合明显 | M2/M5 | **planner+orchestrator+reviewer**:主 agent 规划调度审查,实现交 subagent |
| **Mature** | LOC>100k, 多 PR 并行, 长期协作 | M4/M6 | **coordinator**:持久专家团队,主 agent 只做协调 |

### 角色演进的核心转变

最关键的是 **Established 阶段的角色翻转**:

> 项目小,agent 是"做的人";项目大,agent 应变成"管的人"——规划、调度、审查,把实现下放。

这正是用户描述的"让这个 agent 变为一个主 agent 去做规划/调度/审查的角色"。它不是换模式,而是**同一主 agent 的职责重心迁移**:

| 阶段 | 主 agent 干什么 | 实现谁干 | 审查谁干 |
|---|---|---|---|
| Seed | 规划+实现+自查 | 自己 | 自己(有 self-confirmation 风险,但项目小可接受) |
| Growth | 规划+实现 | 自己 + subagent 分担 | subagent(M2) |
| Established | **规划+调度+审查** | **subagent** | **subagent / 独立 review** |
| Mature | **协调** | 持久专家 agent | 持久 reviewer |

---

## 二、阈值触发的模式跃迁

### 跃迁规则(可硬编码起步)

```
Seed → Growth:
  codebase_loc > 5000  OR  file_count > 50  OR  module_count > 1

Growth → Established:
  cross_module_coupling > 阈值  OR  dependency_depth > 4
  OR  最近 N 个 session 平均 context% 频繁 > 70%(单 agent 吃力)
  OR  pr_count > 20

Established → Mature:
  多 PR 并发  OR  需跨 PR 持久记忆  OR  pr_count > 50
  OR  持久 reviewer 甜区成立(见 [03](03-modes.md) M4 甜区)
```

### 触发不是自动切换,是"建议升级"

成熟度跃迁是**低频、重大**的决策,不该静默执行。结合 [13](13-routing-preference.md) 的 `escalate_hint`:

- `suggest`(默认):达到阈值时,在 route inspector 提示"项目已进入 Established,建议主 agent 转为规划/调度/审查角色",用户确认后写入 project-profile 并调整默认模式
- `auto`:信任阈值,自动升级(适合老用户)
- `silent`:不提示

跃迁一旦确认,会**改变该项目的默认模式基线**,后续所有任务的路由都从这个新基线出发。

---

## 三、与三层路由的集成

项目成熟度是**层1 的项目级信号**,优先级高于单任务信号:

```
路由输入
  │
  ├─ 项目成熟度(跨 session, 缓存) → 决定默认模式基线 + 角色重心
  │     └─ Seed=M1 / Growth=M2 / Established=M2·planner / Mature=M4
  │
  ├─ 层1 单任务信号(本次 diff) → 在基线上微调(如本次是 bugfix 仍可降级 M1)
  │
  ├─ 层2 预算约束 → 在候选集内选最优
  │
  └─ 层3 经验 RL → 微调
```

**关键**:成熟度定基线,单任务信号定本次偏离。例如 Mature 项目遇到一个一行 typo,层1 单任务信号仍可把它降级到 M1 快速修——成熟度不锁死模式,只抬高默认起点。

### 角色注入

Established/Mature 阶段,路由器在 `before_agent_start` 注入角色提示,把主 agent 从"doer"改成"planner/orchestrator/reviewer":

```
[Established] 主 agent system prompt 追加:
  你是本项目的规划与调度者。优先:
  1. 拆解任务并委派给 subagent 实现
  2. 审查 subagent 产出
  3. 仅在 subagent 无法完成时亲自实现
  不要亲自写大段实现代码,除非任务极小。
```

这呼应 [10](10-pi-integration.md) M2 的 subagent 适配——成熟度高时,主 agent 的 system prompt 从"全能执行者"切到"调度者"。

---

## 四、project-profile 持久化

```yaml
# .agentflux/project-profile.json
version: 1
project:
  name: AgentFlux
  root: <project-root-path>

maturity:
  stage: Growth          # Seed|Growth|Established|Mature
  stage_since: 2026-06-24
  signals:
    codebase_loc: 12000
    file_count: 18
    module_count: 1
    dependency_depth: 2
    cross_module_coupling: 0.3
    commit_history: 3
    session_history: 12

role:
  primary: doer+reviewer # doer | doer+reviewer | planner+orchestrator+reviewer | coordinator
  delegate_impl: false   # Established+ 才 true

baseline_mode: M2        # 该项目默认起点
baseline_since: 2026-06-24

history:                 # 跃迁记录
  - { ts, from: Seed, to: Growth, reason, confirmed_by: user }
```

每次 session 结束(或定期)增量更新 signals;信号跨阈值时触发跃迁评估。

### 更新时机

- `session_start`:加载 project-profile,设当前 baseline_mode 和 role
- `session_shutdown`:增量更新 signals(LOC/file/commit 可从 git 廉价取;session_history +1)
- 跃迁评估:signals 更新后检查阈值,`suggest` 时弹 inspector

---

## 五、TUI 可视化

### 1. `/flux project` —— 项目成熟度面板

```
┌─ AgentFlux · Project ───────────────────────────┐
│  AgentFlux  ·  stage: Growth                     │
│                                                  │
│  Maturity Signals                                │
│  codebase_loc        12k    ▍ Seed ─ Growth      │
│  file_count           18    ▏ Seed               │
│  module_count          1    ▏ Seed               │
│  dependency_depth      2    ▏ Seed               │
│  cross_module_coupling 0.3  ▏ Seed ─ Growth      │
│  commit_history        3    ▏ Seed               │
│  session_history      12    ▏ Seed ─ Growth      │
│                                                  │
│  Stage: Growth (since 2026-06-24)                │
│  Baseline mode: M2                               │
│  Role: doer + reviewer                           │
│                                                  │
│  ⚠ 1 signal approaching Established threshold    │
│    cross_module_coupling → 0.6 (current 0.3)     │
└──────────────────────────────────────────────────┘
```

- 每个信号标注当前落在哪个阶段区间
- 逼近下一阶段阈值的信号高亮预警
- 跃迁触发时,这里变成确认入口

### 2. footer 体现角色

```
flux · M2 · role: doer+reviewer · stage: Growth · cache 87% · $0.18
```

Established 之后 footer 的 `role` 变 `planner`,用户一眼知道主 agent 现在主要在"管"而不是"写"。

### 3. `/flux why` 体现成熟度影响

```
Project maturity impact
  stage: Growth → baseline M2 (doer+reviewer)
  this task: bugfix, single file → 层1 单任务信号降级到 M1
  final: M1 (偏离基线,因任务小)
```

---

## 六、Web 可视化(后续)

### Project Maturity 页面

- **成长曲线**:LOC/file/commit/session 随时间变化,标注阶段跃迁点
- **信号仪表盘**:每个信号当前值 + 所处阶段区间 + 距下一阈值距离
- **角色演进时间线**:doer → doer+reviewer → planner → coordinator 的迁移历史
- **跃迁回顾**:每次模式跃迁的触发原因、确认人、前后成本/准确性对比

这部分天然是 Web 强项(长时间轴、多维曲线),TUI 只做概要。

---

## 七、与偏好([13](13-routing-preference.md))的协作

成熟度和偏好是两个正交的偏置源:

| | 成熟度 | 偏好 |
|---|---|---|
| 维度 | 项目客观状态 | 用户主观取舍 |
| 时效 | 低频累积,跨 session | 可随时调 |
| 作用 | 定默认模式基线 + 角色 | 在基线上偏置候选集 |

协作规则:
- 成熟度定基线(如 Mature → 基线 M4)
- 偏好在基线上偏置(如用户 `multi_agent_willingness` 低 → 倾向往 M2 降级,但 Mature 基线抬高下限)
- 单任务信号做本次微调
- 三者冲突时,`escalate_hint` 决定是否提示

例:Mature 项目,用户偏好 eco(想省钱),遇到大重构:
- 成熟度基线 M4,偏好想 M1,单任务信号要 M3
- 路由器:`suggest` 提示"项目成熟建议 M4,但您偏好省钱,折中 M3 fork 探索",用户确认

---

## 八、阶段化实现

| 阶段 | 实现内容 |
|---|---|
| V0 / Phase 1 | project-profile 加载 + 信号采集(LOC/file/commit 从 git)+ footer 显示 stage/role |
| Phase 1 | Seed/Growth 两阶段 + 阈值建议(suggest) |
| Phase 2 | Established 角色注入(planner/orchestrator)+ Mature 阈值 |
| Phase 3 | 跨 PR 持久 reviewer 甜区(M4)+ RL 用成熟度做状态 |

冷启动:新项目默认 Seed + M1 + doer,信号积累后自然演进。

---

## 九、完成标准

- [x] 项目成熟度信号定义(跨 session 累积)
- [x] 四阶段生命周期 + 角色演进(doer→reviewer→planner→coordinator)
- [x] 阈值触发 + escalate_hint 交互
- [x] project-profile 持久化 schema
- [x] 与三层路由 + 偏好的集成
- [x] TUI/Web 可视化方向
- [ ] V0 至少采集 LOC/file/commit + 显示 stage + role
