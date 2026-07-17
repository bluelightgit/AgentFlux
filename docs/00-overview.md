# 00 - 项目概览

## 一句话定位

AgentFlux 是一个 **多 Agent 工作台与执行运行时**：把 LLM agent 的执行拓扑做成可操作、可观察、可恢复的能力，让用户或主 Agent 针对任务选择 M1–M6 工作模式，并在准确性 / 成本 / 效率之间取舍。自动路由是可选的后续优化层，不是使用主体功能的前置条件。

## 问题背景

当前 LLM agent 工具(单 agent CLI、subagent 编排、multi-agent 框架)大多锁定一种工作模式。但实际开发中,任务特性差异巨大:

- 改一个 typo:单 agent 足够,启动 multi-agent 是浪费
- 跨模块重构:需要并行 + 独立验证,multi-agent 有价值
- 长期项目的代码审查:需要持久记忆的专家 agent

锁定单一模式意味着:简单任务多花钱,复杂任务做不到位,中等任务缓存全失效。

学术界已将这个矛盾形式化为 **Agent System Trilemma**(EvoRoute, ACL 2026):performance / cost / latency 三者不可兼得,需要动态路由而非静态选择。

## 核心思路

AgentFlux 不发明新的 agent,而是做一层 **工作模式的路由与编排层**:

1. **拆维度**:把"工作模式"拆成三个正交维度(Context 拓扑 × 生命周期 × 并行度),不再把单/sub/multi-agent 当并列选项
2. **可配置**:用户从预设档位到细粒度参数,三档自由选择组合
3. **可路由**:路由器根据任务复杂度、预算、历史经验,自动选择最优模式
4. **缓存优先**:所有决策优先保 prompt cache 命中,因为 cache 是成本主杠杆

## 核心概念

| 概念 | 定义 | 详见 |
|---|---|---|
| **Trilemma** | 准确性 / 成本 / 效率三难 | [01](01-trilemma.md) |
| **三维度** | Context 拓扑(A)、生命周期(B)、并行度(C) | [02](02-dimensions.md) |
| **六模式** | 维度组合出的六种典型工作模式 M1–M6 | [03](03-modes.md) |
| **配置层** | 预设 / 开关 / 参数三档 | [04](04-config-schema.md) |
| **路由层** | 静态信号 / 预算 / 经验三层依据 | [05](05-routing.md) |
| **缓存策略** | 前缀布局 + mask + 实测数据 | [06](06-cache-strategy.md) |
| **价格层** | OpenRouter 远程 + 用户覆盖 + 兜底均值 | [16](16-pricing-layer.md) |
| **模型能力** | 能力向量 × 角色需求 = 亲和度 | [17](17-model-capability.md) |
| **角色设计** | 模板定义 + 实例化 + 自定义 | [18](18-agent-roles.md) |
| **多 agent 架构** | 共享黑板 + 角色信箱 + 文件沟通 | [19](19-multi-agent-architecture.md) |
| **实证数据** | 缓存实验 + 成本实验 + 工程发现 | [20](20-empirical-findings.md) |
| **Reasoning effort** | 模型路由新维度: 思考深度 × 角色需求 | [21](21-reasoning-effort.md) |
| **模式能力路线图** | 先做模式执行能力, 再做智能路由 | [22](22-mode-capability-roadmap.md) |

## 命名说明

**AgentFlux** = Agent + Flux(流变)。

- Flux 意为"不断变化的状态 / 流动",体现工作模式可路由、可切换
- 暗示多 agent 如流般协作
- 精简,两词合成

> 名称暂定。候选:AgentTopo(强调拓扑)、AgentWeave(强调编织协作)、Arbiter(强调决策)。后续可改。

## 设计原则

1. **不锁定模式**:任何模式都是可选项,不是默认
2. **缓存为王**:成本优化的第一杠杆是 prompt cache,不是减 agent
3. **显式可控**:用户或主 Agent 可按任务固定生产模式；自动路由只在未显式选择时提供建议或执行
4. **有据可依**:每个决策点引用学术/工业证据,不拍脑袋
5. **先验证后扩展**:Phase 1 只做能立刻让成本可观测并优化的部分 (价格层 docs/16, 不套用第三方 60% 锚点)。实测数据见 [docs/20](20-empirical-findings.md)
6. **多模式路由是核心**: 成本优化是次要, 智能路由决策 (何时用哪种模式) 才是护城河
7. **模式能力优先于路由智能**: 先把 M2-M5 执行能力做扎实, 再做任务级路由/反馈闭环 (见 [docs/22](22-mode-capability-roadmap.md))

## 项目状态

截至 2026-07-13，核心纵向链路已经接通 `Task → RoutePlan → M1/M2/M5 → Outcome`，并完成三态质量门、统一 telemetry/ExperienceStore、取消传播、原子任务认领/文件锁和离线回归入口。

当前生产能力仅声明 M1/M2/M5；M3/M4/M6 仍为 `experimental`，路由命中时会明确回落到 M2/M5。预算可在 attempt/step 之间硬停止，但 provider 单次请求结束前拿不到实际费用，因此仍可能发生单请求小额超限。

不要再用单一“Phase 完成”判断可用性。以 [26-implementation-status](26-implementation-status.md) 的 `designed / implemented / wired / verified / released` 五级状态为准。
