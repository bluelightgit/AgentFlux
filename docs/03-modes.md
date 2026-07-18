# 03 - 六种工作模式

> **历史设计 / 已冻结。** 2026-07-18 起，AgentFlux 不再继续扩展用户可见的 M1–M6。新的规范见 [28 - Agent 生命周期与工作方式重构](28-agent-workstyle-redesign.md)：M1/M2/M5 迁移为 Direct/Team/Workflow；M3 fork 改为 Agent 创建来源；M4 改为 Persistent Specialist 生命周期；M6 改为通用异构模型策略。本文保留用于解释旧配置和实验来源。

把 [02](02-dimensions.md) 的维度组合收敛成用户能直接理解的六种典型模式。每种模式在 Trilemma 三角上有一个落点。

## 三角落点图

```
                    准确性
                      ▲
                      │
        M6 异构团队 ●  │
                      │
        M3 对话树 ●   │
                      │
   M1 单agent ●───────┼──────── ● M4 持久multi-agent
                      │
                      │  ● M2 主+subagent
                      │
            ● M5 管道 │
                      └────────────────────► 成本
             (省)        (贵)
   快 ◄────────────────────────────► 慢 (并行反向)
```

## 模式总览

| # | 模式 | 维度组合 | 准确性 | 效率 | 成本 | 何时用 |
|---|---|---|---|---|---|---|
| **M1** | 单 agent | A1+B1/B2+C1+D1 | 中 | 慢 | **最低** | 简单任务、探索对话、最大化 cache |
| **M2** | 主+subagent | A2+B1+C1/C2+D1 | 中高 | 中 | 中 | 单 session 闭环迭代(当前主流) |
| **M3** | 对话树 fork | A3+B4+C2/C3+D1 | 高 | 快 | 中高 | 多方案探索、A/B、并行验证 |
| **M4** | 持久 multi-agent | A4+B3+C3+D1 | **最高** | 最快 | **最高** | 长期项目、跨 PR 专家 agent、需持久记忆 |
| **M5** | 管道 handoff | A2/A4+B3+C1+D1/D2 | 中 | 中 | 中低 | plan→impl→test→review→merge 流水线 |
| **M6** | 异构团队 | A4/A2+C2/3+D2 | **最高** | 快 | 中(异构摊薄) | opus 规划审查 + sonnet 实现,成本敏感高质量 |

---

## M1 单 agent

**组合**:A1 single + B1/B2 + C1 sequential + D1 homogeneous

- ✅ cache 最优(L1+L2 持续命中),成本最低
- ✅ 无协调开销,实现最简
- ❌ context rot(长对话质量下降)
- ❌ 无法并行
- ❌ self-confirmation(自己写自己审,确认偏误)
- **依据**:Amazon/UT Austin 证明同构 workflow 单 agent 多轮即可模拟,应作为默认起点

## M2 主 + subagent

**组合**:A2 star + B1 + C1/C2 + D1

- ✅ child 隔离不污染 parent,灵活
- ✅ child 独立 context 可做独立审查(避免 self-confirmation)
- ❌ child 不持久(L2 不延续),每次重载
- ❌ parent 是瓶颈,naive 调用 cache 全 miss
- **关键修复**:前缀布局一致(diff 放后部、role 放前部),naive $1.32 → 优化 $0.45(见 [06](06-cache-strategy.md))
- **定位**:单 session 闭环迭代的主流程,Phase 1 优化重点

## M3 对话树 fork

**组合**:A3 fork + B4 fork-prune + C2/C3 + D1

- ✅ 从同一前缀分叉,**共享 L1+部分 L2 cache**,分支独立又不丢前序知识
- ✅ 可 merge 赢家回主分支
- ✅ 解决 "logical context poisoning"(多主题串味,arXiv 2603.21278)
- ❌ Claude 才支持 conversation copy fork,Codex/Gemini 只能 spawn
- ❌ merge 逻辑需自定义
- **定位**:Trilemma 上 **准确性×成本的最佳折中点**,比 M4 便宜比 M1 准
- **实现参考**:agor(fork/spawn/btw)、PraisonAI(fork+merge)、AWS AgentCore Memory Branching

## M4 持久 multi-agent

**组合**:A4 peers + B3 + C3 + D1

- ✅ 持久记忆(L2 长期命中),真并行,专业化
- ❌ 协调开销大
- ❌ compaction 会摧毁 L2 收益(长期被侵蚀)
- ❌ 最贵
- **甜区**:同一 reviewer agent 跨多个 PR 记住项目约定,L2 = 几十 K 项目知识,收益超 compaction 代价
- **依据**:Claude Agent Teams(2026-02),leader-worker + 共享 task list

## M5 管道 handoff

**组合**:A2/A4 + B3 handoff + C1 + D1/D2

- ✅ 每段 fresh context 不累积,结构清晰
- ✅ 可异构(每段用不同 model)
- ❌ 每段重新加载 L1
- ❌ handoff 摘要损失信息
- **定位**:固定流水线,如 Ouroboros 的 plan→impl→validate→review→cleaner→post-mortem

## M6 异构团队

**组合**:A4/A2 + C2/C3 + D2 heterogeneous

- ✅ **multi-agent 唯一不可被单 agent 模拟的真价值**(KV cache 跨 model 不共享)
- ✅ 贵模型只用在关键决策点,便宜模型干重活,成本被摊薄
- ❌ 架构复杂,需懂每个 model 强弱
- **依据**:BAMAS(EuroSys'26)ILP 选 model 组合 + RL 选拓扑,cost −86% 性能持平;AWS agent-team 的 opus/sonnet 分工
- **定位**:成本敏感但要求高质量的场景,Phase 3 护城河

---

## 何时该上 multi-agent(M4/M6):三个信号

来自 subagent vs team 的本质区别,任一命中才值得从 M1/M2 升级:

1. **任务跨 session 持久** —— 工作要在 parent session 之外留存,需要持久记忆
2. **subagent 之间需要直接通信** —— star 拓扑(parent 中转)不够,需要 mesh(peer 直连)
3. **parent context rot** —— parent 被一堆 subagent summary 塞满,自己工作都做不好

**三个信号都没命中时,保持 M1/M2,把精力投在缓存布局上,ROI 比上 multi-agent 高一个数量级。**

---

## 模式选择决策树

```
任务来了
  │
  ├─ 单文件 / 低耦合 / 简单? ──yes──► M1 单 agent
  │
  ├─ 单 session 内闭环迭代(开发+测试+review)?
  │     ├─ 预算敏感 ──────────────► M2 + 缓存优化(前缀布局 + mask)
  │     └─ 需多方案并行探索 ──────► M3 对话树 fork
  │
  ├─ 固定流水线(plan→impl→test→review→merge)? ──► M5 管道 handoff
  │
  ├─ 跨 PR / 长期项目 / 需持久专家记忆?
  │     ├─ 同构 model 够用 ──────► M4 持久 multi-agent
  │     └─ 需异构(opus 决策 + sonnet 执行)──► M6 异构团队
  │
  └─ 不同 feature 批量处理 ─────────► M3 fork 或 M4,C3 task 并行
```

这个决策树在 [05-routing](05-routing.md) 会被自动化成三层路由依据。
