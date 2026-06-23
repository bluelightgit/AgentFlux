# 05 - 自动路由层

路由层是 AgentFlux 的核心差异化。当用户选 `override_mode: auto` 或 `suggest` 时,路由器决定用哪种模式。三层依据,从便宜到贵,逐层叠加。

## 三层路由依据

```
任务输入
   │
   ▼
┌─────────────────────────────────────────┐
│ 层1:任务结构信号(静态分析,零 LLM 成本) │  → 候选模式集
└─────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────┐
│ 层2:预算约束(ILP,零 LLM 成本)          │  → 预算内最优组合
└─────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────┐
│ 层3:历史经验(RL,需历史数据)            │  → 精细化微调
└─────────────────────────────────────────┘
   │
   ▼
最终模式 + 参数
```

---

## 层 1:任务结构信号(静态分析)

**零 LLM 成本**,从代码/任务索引提取复杂度向量,硬编码规则起步。

依据:**RGAO**(arXiv 2605.05657)从代码索引提取结构性复杂度向量,把 misrouting 从 30.1% 降到 8.2%。

### 信号向量

| 信号 | 来源 | 含义 |
|---|---|---|
| `dependency_depth` | 静态分析 | 依赖深度,跨模块调用链长度 |
| `cross_module_coupling` | 依赖图 | 跨模块耦合度 |
| `symbol_density` | AST | 单位体积符号密度 |
| `file_count` | diff/任务范围 | 涉及文件数 |
| `task_type` | 用户意图分类 | bugfix / feature / refactor / review / explore |

### 决策规则(可硬编码起步)

```
单文件 + 低耦合 + bugfix/explore     → M1 单 agent
多文件 + 低耦合 + feature            → M2 主+subagent(C2 stage 并行)
高耦合 + 需并行验证 + refactor       → M3 对话树 fork
跨域 + 需长期记忆 + 多 PR            → M4 持久 multi-agent
固定流程(明确 plan→impl→test→review)→ M5 管道 handoff
成本敏感 + 高质量要求                → M6 异构团队
```

冷启动阶段只跑这一层,已能覆盖大多数场景。

---

## 层 2:预算约束(ILP)

**零 LLM 成本**,在用户 `max_cost_per_task` 约束下,用整数线性规划选 model 组合 + 拓扑。

依据:**BAMAS**(EuroSys'26)用 ILP 选 model + RL 选拓扑,cost −86% 性能持平。

### ILP 建模(草案)

- **决策变量**:每个执行单元选哪个 model、用哪种拓扑
- **目标**:最大化预期 accuracy(或满足 accuracy 下限)
- **约束**:
  - `Σ (model_cost_i × expected_tokens_i) ≤ max_cost_per_task`
  - 拓扑可行性约束(如 `heterogeneous` 需 `star`/`peers`)
  - 依赖约束(有依赖的单元不能 `task` 并行)

### 简化版:分层 model 分配

不一定要完整 ILP,Phase 2 可用启发式:
```
决策点(规划/审查)  → opus + high reasoning
执行点(实现)      → sonnet + max output
验证点(测试)      → sonnet/haiku
```
这就是 AWS sample-claude-code-agent-team 的做法。

---

## 层 3:历史经验(RL)

**需历史数据积累**,维护"任务特征 → 模式 → 实际 cost/latency/accuracy"知识库,RL 策略持续优化。

依据:**EvoRoute**(ACL'26)经验驱动自路由,cost −80%, latency −70%,性能不降。

### 反馈闭环

```
任务执行 → 记录(特征向量, 所选模式, 实际 cost/latency/accuracy)
         → 更新知识库
         → 下次相似特征的任务,策略给出更优模式
```

Phase 3 才启用,依赖 Phase 1/2 积累的执行数据。

---

## 运行时自适应:compact vs 新 session

这是维度 B 的运行时决策,也是用户特别关心的"频繁循环"场景。**关键洞察**:是否 compact 不该看填充率阈值,而该看 **剩余工作值不值得为它重建 cache**(因为 compaction 摧毁 prefix,见 [06](06-cache-strategy.md))。

### 决策树

```
context 填充率 < 70%
  └─► 继续,B2 mask 隐藏旧 tool result(无损,保留 prefix)

70% ≤ 填充率 < 90%
  └─► 评估:剩余预计 token vs compaction 重读成本
        ├─ 剩余工作多(预计还要多轮) → B4 fork-prune(主分支裁剪,内容进分支保留)
        └─ 剩余工作少(快收尾)       → B1 compact(接受一次 cache 重建)

填充率 ≥ 90%
  └─► B3 handoff 新 session(传结构化摘要),context 彻底干净
```

### 为什么不看阈值看剩余工作

Zylos 研究:"every compaction event destroys the cached prefix and triggers a full-price re-read"。如果剩余工作很少,compact 后重读 L1(40K tokens × cache write 1.25×)的成本可能高于直接在稍满的 context 里做完。反之剩余工作多,早 compact 早止血。

---

## 路由流程(完整)

```
1. 接收任务 + 用户配置
2. 层1 静态分析 → 候选模式集 [M1..M6]
3. 层2 预算 ILP → 预算内最优组合
4. 层3 经验 RL(若启用)→ 微调
5. override_mode 判定:
     - auto:   直接执行
     - suggest: 给用户建议,确认后执行
     - manual:  只展示分析,用户自选
6. 执行中持续监控:
     - context 填充率 → 触发 B 维度自适应
     - cache hit rate < target → 告警 + 建议调整前缀布局
     - 实际 cost 接近预算上限 → 降级(如 M2→M1 或切便宜 model)
7. 执行结束 → 记录反馈到层3 知识库
```

## 冷启动策略

- Phase 1:只跑层 1(硬编码规则)+ 用户手动选档位
- Phase 2:层 1 + 层 2(启发式 model 分配)
- Phase 3:三层全开 + RL 自演化

冷启动时 `override_mode` 默认 `suggest`,让用户保持控制权,积累信任后再切 `auto`。
