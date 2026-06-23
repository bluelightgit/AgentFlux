# 01 - Agent System Trilemma

## 定义

Agent System Trilemma:在 LLM agent 系统中,**准确性(accuracy)、成本(cost)、效率(latency / wall-clock)** 三者构成不可兼得的三难。

```
              准确性
                ▲
                │  ← 独立 context、异构强模型、多轮验证
                │     但:破坏缓存、串行、成本↑
                │
                │
   成本 ◄───────┼───────► 效率
   (缓存命中↑)    (并行↑)
   ← 单 session     ← 多 agent 并行
     持续命中          但:重复加载 context
```

这个三难由 **EvoRoute**(ACL 2026,NUS + 通义实验室)正式命名并形式化。其核心论断:现有 agent 系统最多兼顾三角形的两边,无一能同时满足三点。

## 为什么不可兼得

三个目标在机制层面直接对冲:

### 准确性 ↔ 成本
- 提高准确性需要:独立 context(避免确认偏误)、更强模型、多轮交叉验证
- 但独立 context 破坏 prompt cache 前缀共享,强模型更贵,多轮验证重复加载 context
- **冲突点**:独立性越强,前缀越难一致,cache 命中越低,成本越高

### 准确性 ↔ 效率
- 提高准确性需要:串行依赖的验证链(review → 修改 → 重测)
- 提高效率需要:并行执行
- **冲突点**:有依赖的步骤无法并行;并行验证需各自加载 context

### 成本 ↔ 效率
- 降低成本需要:单 session 持续命中 cache(L1+L2)
- 提高效率需要:多 agent 并行,每个独立 context
- **冲突点**:并行 = N 个 context 各自加载 L1,cache 红利被稀释

## 学术证据

### Trilemma 的形式化:EvoRoute
- 来源:EvoRoute, ACL 2026, NUS + 通义实验室
- 贡献:正式命名 Agent System Trilemma,提出自演化路由器,每步动态选 Pareto-optimal LLM backbone
- 结果:GAIA / BrowseComp+ 上 **cost −80%, latency −70%, 性能不降**

### 三难可被路由破解:EvoRoute / BAMAS / AdaptOrch
| 工作 | 方法 | 结果 |
|---|---|---|
| EvoRoute (ACL'26) | 经验驱动的自路由 | cost −80%, latency −70% |
| BAMAS (EuroSys'26) | ILP 选 model + RL 选拓扑 | cost −86%, 性能持平 |
| AdaptOrch (arXiv 2602.16873) | 任务自适应拓扑路由 | +12–23% over 静态拓扑 |

这三者共同证明:**三难不是不可破,而是需要动态路由 + 维度拆解**,这正是 AgentFlux 的立论基础。

### 反面证据:多 agent 不是万能药
| 工作 | 发现 |
|---|---|
| Stanford (arXiv 2604.02460) | 等思考预算下,单 agent 多跳推理胜过 MAS;很多 MAS 收益来自未计入的算力 |
| Salesforce (arXiv 2606.13003) | 自动生成的 MAS 一致劣于 CoT-SC 单 agent,且贵 10× |
| Amazon/UT Austin (arXiv 2601.12307) | 同构 MAS 可被单 agent 多轮模拟,单 agent 还享 KV cache 复用 |
| ECER 2026 | 单 agent 在所有测试任务族胜过 multi-agent pipeline,且更便宜更快 |

**结论**:multi-agent 只在三个条件同时满足时有真价值(详见 [03-modes](03-modes.md)):
1. 任务真正需要分解 / 角色专业化 / 显式交叉检查
2. 异构 model 组合(KV cache 跨 model 不共享,单 agent 做不到)
3. 工作跨 session 持久,需要持久记忆

## AgentFlux 的应对

不试图"解决"三难(不可能),而是:
1. **让三难显式化**:用三维度把取舍摆到台面,见 [02](02-dimensions.md)
2. **让取舍可配置**:用户/路由器按任务选三角形上的点,见 [04](04-config-schema.md)
3. **让取舍有依据**:三层路由依据,见 [05](05-routing.md)
4. **守住成本底线**:缓存优先,见 [06](06-cache-strategy.md)

## 关键数据参考

| 数据点 | 来源 | 含义 |
|---|---|---|
| Code Review 阶段占 59.4% token | Tokenomics, MSR'26 (arXiv 2601.14470) | 迭代验证才是成本大头,非首次生成 |
| 输入 token 占 53.9% | 同上 | context 加载是主成本 |
| Prompt cache 降成本 41–80% | Don't Break the Cache (arXiv 2601.06007) | cache 是成本第一杠杆 |
| Naive 多 reviewer $1.316 / PR | librarian-demo (2026-05) | 不做前缀布局的 multi-agent 默认价 |
| Cache 优化后 $0.453 / PR | 同上 | 前缀布局一致可省 66% |
| 100 轮 Opus 无 cache $50–100,90% 命中 $10–19 | Anthropic 官方 | cache 命中率是生产级指标 |
