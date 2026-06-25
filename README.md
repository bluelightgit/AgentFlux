# AgentFlux

> Agent 工作模式路由器:把 LLM agent 的执行拓扑做成可配置、可自动路由的维度,在 **准确性 / 成本 / 效率** 三难中按任务特性取舍。

**AgentFlux** = Agent + Flux(流变)。寓意 agent 的工作模式如流变般可路由、可切换,多 agent 流动协作。

> 名称暂定,后续可改。

## 为什么做这个

LLM agent 部署面临一个根本性三难(**Agent System Trilemma**,EvoRoute, ACL 2026):准确性、成本、效率三者不可兼得。现有工具大多锁定单一工作模式(单 agent / subagent / multi-agent),用户无法按任务特性取舍——简单任务多花钱,复杂任务做不到位,中等任务缓存全失效。

AgentFlux 的核心思路:把工作模式拆成三个正交维度(Context 拓扑 × 生命周期 × 并行度),让用户显式选择组合,或由路由器根据 **任务复杂度 / 预算 / 历史** 自动选择。

## 核心特性(规划中)

- **三维度拆解**:Context 拓扑、Context 生命周期、并行度,正交可组合
- **六种工作模式**:单 agent、主+subagent、对话树 fork、持久 multi-agent、管道 handoff、异构团队
- **三档配置**:预设档位 / 维度开关 / 细粒度参数
- **三层自动路由**:任务结构信号(静态)→ 预算约束(ILP)→ 历史经验(RL)
- **路由偏好可配置**:五维偏好画像 + 按场景覆盖,TUI 调音台 / Web Preference Studio 可视化调整
- **项目演进驱动角色演进**:项目从 Seed 到 Mature,agent 从 doer 演进为 planner/orchestrator/reviewer
- **缓存优先**:前缀布局优化 + mask 策略,优先保 prompt cache 命中
- **用户端渐进路线**:先 pi TUI 验证,再 Web read-only dashboard,最后 Electron/Tauri 产品化

## 文档导航

| 文档 | 内容 |
|---|---|
| [00-overview](docs/00-overview.md) | 项目概览、愿景、核心概念 |
| [01-trilemma](docs/01-trilemma.md) | 三难问题形式化与学术依据 |
| [02-dimensions](docs/02-dimensions.md) | 三维度拆解 |
| [03-modes](docs/03-modes.md) | 六种工作模式详解 |
| [04-config-schema](docs/04-config-schema.md) | 配置层设计 |
| [05-routing](docs/05-routing.md) | 自动路由层 |
| [06-cache-strategy](docs/06-cache-strategy.md) | 缓存策略 |
| [07-roadmap](docs/07-roadmap.md) | 落地路线 |
| [08-references](docs/08-references.md) | 参考文献与前例 |
| [09-tech-stack](docs/09-tech-stack.md) | 技术栈选型与主流框架调研 |
| [10-pi-integration](docs/10-pi-integration.md) | pi 集成可行性分析 |
| [11-system-architecture](docs/11-system-architecture.md) | 系统架构规划与数据流 |
| [12-ui-direction](docs/12-ui-direction.md) | TUI/Web/Electron 用户界面方向 |
| [13-routing-preference](docs/13-routing-preference.md) | 路由偏好与可视化配置 |
| [14-project-evolution](docs/14-project-evolution.md) | 项目演进与角色演进 |

## 状态

🚧 Phase 0:设计阶段。文档先行,代码待实现。技术栈已定(TypeScript + Python sidecar),集成目标已定(内置 pi),用户端路线已定(pi TUI → Web → Electron/Tauri)。见 [roadmap](docs/07-roadmap.md)。

## License

TBD
