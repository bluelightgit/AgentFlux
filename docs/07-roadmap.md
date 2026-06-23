# 07 - 落地路线

分四个阶段,按 ROI 排序。每阶段都有可验证的交付物和量化指标,前一阶段不达标不进入下一阶段。

## 阶段总览

| 阶段 | 周期 | 内容 | 预期收益 |
|---|---|---|---|
| Phase 0 | 当前 | 文档与设计 | 立论成立 |
| Phase 1 | ~2 周 | M1/M2 + 前缀布局 + mask | 成本 −60% |
| Phase 2 | ~1 月 | M3 fork + 静态路由 | 准确性×成本折中点 |
| Phase 3 | ~2 月+ | M6 异构 + ILP/RL 路由 | 护城河 |

---

## Phase 0:设计阶段(当前)

**目标**:立论成立,设计文档完整,可指导实现。

**交付物**:
- [x] docs/00–08 全套设计文档
- [x] 三维度 + 六模式 + 三档配置 + 三层路由的完整定义
- [ ] 技术栈选型(下一轮讨论)
- [ ] 最小可行架构图

**完成标准**:文档能回答"做什么、为什么、怎么做、何时做"四问。

---

## Phase 1:缓存优先(2 周,立刻见效)

**目标**:在现有 subagent 流程上,用前缀布局 + mask 把成本砍 60%+,不动架构。

**交付物**:
- M1 单 agent 执行器
- M2 主+subagent 执行器(带前缀布局优化)
- B2 mask 策略(隐藏旧 tool result)
- 前缀布局强制器(`prefix_layout: static_first`)
- cache hit rate 监控
- Level 1 预设档位(eco/balanced)
- 配置加载与校验

**验证指标**:
- 对比 naive subagent,成本下降 ≥ 60%(锚点:librarian-demo $1.32→$0.45)
- cache hit rate ≥ 85%
- mask 策略下 solve rate 不下降(对照 JetBrains +2.6%)

**风险**:
- 前缀布局依赖 provider 的 cache 行为,需针对 Claude/OpenAI 分别验证
- mask 策略可能误隐藏关键信息,需保留最近 N 个 tool result

**为什么先做这步**:这是 Trilemma 三角上"成本"边最便宜的优化,几乎不动架构,ROI 最高。单 session 内闭环迭代(用户当前主流程)在此阶段就够用。

---

## Phase 2:对话树 + 静态路由(1 月)

**目标**:补上 Trilemma"准确性×成本"的最佳折中点(M3 fork),并启用层 1 静态路由。

**交付物**:
- M3 对话树 fork 执行器(基于 Claude conversation copy 或 PraisonAI/agor 实现)
- B4 fork-prune 生命周期
- merge 逻辑(赢家分支合回主分支)
- 层 1 静态路由(任务结构信号 → 候选模式)
- M5 管道 handoff 执行器
- Level 2 维度开关
- `override_mode: suggest`

**验证指标**:
- 多方案探索场景,wall-clock 比串行快 ≥ 40%
- 静态路由 misrouting ≤ 15%(对照 RGAO 8.2%)
- fork 分支 cache 命中 L1 + 部分 L2

**风险**:
- fork 仅 Claude 支持,Codex/Gemini 需 spawn 降级
- merge 冲突需自定义解决策略(参考 grit 的 AST 级锁)

---

## Phase 3:异构 + 自适应路由(2 月+)

**目标**:补上 multi-agent 的真价值(M6 异构),并启用层 2/3 自适应路由,形成护城河。

**交付物**:
- M4 持久 multi-agent 执行器(共享 task list + mailbox)
- M6 异构团队执行器(分层 model 分配)
- 层 2 预算路由(ILP 或启发式)
- 层 3 经验路由(RL 反馈闭环)
- `override_mode: auto`
- 运行时 B 维度自适应(compact vs new session 决策)
- 执行反馈知识库

**验证指标**:
- 异构团队成本 ≤ 同构 M4 的 70%,accuracy 不降(对照 BAMAS −86%)
- 经验路由迭代 N 轮后,cost 比 Phase 2 再降 ≥ 20%(对照 EvoRoute −80%)
- 运行时自适应在迭代 5+ 轮场景成本优于固定 compact

**风险**:
- ILP/RL 实现复杂,可能先用启发式替代
- 持久 multi-agent 的 compaction 侵蚀需实测验证甜区边界
- RL 需足够历史数据,冷启动期可能劣于静态路由

---

## 跨阶段原则

1. **每阶段可独立交付价值**:Phase 1 不依赖 Phase 2,用户随时可用
2. **数据驱动升级**:Phase 3 的 RL 依赖 Phase 1/2 积累的执行数据
3. **不提前优化**:异构和 RL 放最后,先把单 session 内闭环做扎实
4. **可回退**:每个执行器都是可选的,路由失败回退到 M1

## 下一步(离开 Phase 0 前)

- [ ] 确定技术栈(语言、运行时、目标 agent 平台)
- [ ] 确定首个集成目标(pi? Claude Code? 独立?)
- [ ] 画最小可行架构图
- [ ] 拆 Phase 1 的任务清单
