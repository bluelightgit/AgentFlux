# 02 - 三维度拆解

## 核心洞察

"单 agent / subagent / multi-agent"不是并列选项,而是混了三个独立的轴。把它们拆成正交维度,用户才能自由组合,路由器才有据可依。

AgentFlux 拆出 **三个主维度(A/B/C)+ 一个附加维度(D)**:

| 维度 | 名称 | 回答的问题 | 取值 |
|---|---|---|---|
| **A** | Context 拓扑 | 谁和谁共享上下文? | single / star / fork / peers |
| **B** | Context 生命周期 | context 满了怎么办? | compact / mask / handoff / fork-prune |
| **C** | 并行度 | 任务怎么排? | sequential / stage / task |
| **D** | Model 策略(附加) | 用同构还是异构模型? | homogeneous / heterogeneous |

---

## 维度 A:Context 拓扑

决定 context 在多个执行单元之间如何分布与共享。

| 取值 | 机制 | cache 命中 | 隔离性 | 典型实现 |
|---|---|---|---|---|
| **A1 single** | 一个 session 贯穿全程 | L1+L2 全命中(最优) | 无 | 普通 CLI agent |
| **A2 star** | parent 持有 context,child 临时委派只回 summary | parent L1+L2 命中;child L1 可命中(前缀一致时) | child 间隔离 | Claude Code subagent、pi subagent |
| **A3 fork** | 从某点复制 context 成兄弟分支,各自延续,可 merge | L1+部分 L2 命中(共享前缀) | 分支间隔离 | agor fork、PraisonAI fork、Conversation Tree |
| **A4 peers** | 各自独立持久 session,通过消息/共享状态通信 | 各自 L1+L2 命中 | 完全隔离 | Claude Agent Teams、OpenClaw |

**关键澄清**:subagent(A2)和 multi-agent(A4)的区别不在"是否多个 agent",而在 **context 是否持久 + 是否能直接互通**:
- A2 child 是临时的、只通过 parent 中转(star 拓扑)
- A4 peer 是持久的、可直接通信(mesh/star 皆可)

---

## 维度 B:Context 生命周期

context 接近窗口上限时的处理策略。这是成本与准确性的关键交叉点,因为 **每次 compaction 都会摧毁 prefix cache**(见 [06](06-cache-strategy.md))。

| 取值 | 机制 | cache 影响 | 信息损失 | 依据 |
|---|---|---|---|---|
| **B1 compact** | LLM 摘要历史 | 摧毁整个 prefix,全 miss | 有损,可能模糊停止信号 | Claude Code 默认 |
| **B2 mask** | 隐藏旧 tool result,不摘要 | 保留部分 prefix | 无损(可恢复) | JetBrains Research:-52% cost, +2.6% solve |
| **B3 handoff** | 新 session,传结构化摘要 | 新 prefix,旧全 miss | 有损,但 context 干净 | Codex CLI handoff memo |
| **B4 fork-prune** | 满了 fork 出去保留,主分支裁剪 | 主分支 prefix 保留 | 无损(进分支) | Conversation Tree volatile nodes |

**反直觉但正确的判断**:"是否 compact"不该只看填充率阈值,而该看 **剩余工作值不值得为它重建 cache**(见 [05](05-routing.md) 运行时自适应)。

---

## 维度 C:并行度

任务在时间轴上如何排列。

| 取值 | 机制 | wall-clock | 成本 | 适用 |
|---|---|---|---|---|
| **C1 sequential** | 一个接一个 | 最慢 | 最省 | 有依赖的迭代链 |
| **C2 stage** | 同阶段并行(测试 ‖ review) | 省一半 | 2 个 context 的 L1 | 阶段内独立、阶段间依赖 |
| **C3 task** | 不同 feature 完全并行 | 最快 | N 个 context | 独立任务批量处理 |

**依赖关系决定可并行性**:
```
设计 → 开发 → ┬─ 测试 ─┐     # C2:测试 ‖ review 可并行
               └─ review ┘ → 合并/修改

feature-A ─────────────┐
feature-B ─────────────┼─→ 集成   # C3:不同 feature 可并行
feature-C ─────────────┘
```
并行总是以"多 context 各自加载 L1"为成本代价,**效率↑与成本↑绑定**,不可分离。

---

## 维度 D:Model 策略(附加)

| 取值 | 机制 | 成本 | 准确性 | 关键约束 |
|---|---|---|---|---|
| **D1 homogeneous** | 所有单元同一 base model | 中 | 中 | 单 agent 多轮可模拟,KV cache 可复用 |
| **D2 heterogeneous** | 不同单元用不同 model(贵模型决策,便宜模型执行) | 中(异构摊薄) | 高 | **KV cache 跨 model 不共享,这是 multi-agent 唯一不可被单 agent 模拟的真价值** |

异构是 multi-agent 区别于 subagent 的核心增量。AWS sample-claude-code-agent-team 就是 lead/review 用 opus+xhigh,实现用 sonnet+max。

---

## 正交性

四个维度理论上可自由组合(4×4×3×2 = 96 种),但实际有约束:

- **A4 peers** 通常需要 **B3 handoff 或 B4 fork-prune**(持久 session 必然要管理生命周期)
- **A3 fork** 天然搭配 **B4 fork-prune**(fork 出去就是为了裁剪主分支)
- **D2 heterogeneous** 强烈倾向 **A2/A4**(需要多 context 才能放不同 model)
- **C3 task** 搭配 **A3 fork 或 A4 peers**(并行需要独立 context)

AgentFlux 在 [03-modes](03-modes.md) 把常见且有用的组合收敛成 **六种工作模式**,在 [04-config-schema](04-config-schema.md) 提供三档配置让用户选择或自动路由。

---

## 澄清:旧分类 → 新维度映射

| 旧说法 | 实际是 | 维度组合 |
|---|---|---|
| 单 agent | A1 + B1/B2 + C1 + D1 | M1 |
| 主 agent + subagent | A2 + B1 + C1/C2 + D1 | M2 |
| multi-agent(持久团队) | A4 + B3 + C3 + D1/D2 | M4/M6 |
| 流水线 | A2/A4 + B3 + C1 + D1/D2 | M5 |
| 对话树分叉 | A3 + B4 + C2/C3 + D1 | M3 |

拆开维度后,用户能选"A3 fork + B2 mask + C2 阶段并行"这种旧分类无法表达的组合。
