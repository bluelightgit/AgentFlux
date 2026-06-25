# 08 - 参考文献与前例

按主题分类。每条标注来源与对本项目的启发点。

## 一、Trilemma 与路由

| 文献 | 来源 | 启发 |
|---|---|---|
| EvoRoute: Experience-Driven Self-Routing LLM Agent Systems | ACL 2026, NUS + 通义 | Trilemma 正式命名;经验驱动自路由 cost −80%, latency −70% |
| BAMAS: Structuring Budget-Aware Multi-Agent Systems | EuroSys'26, arXiv 2511.21572 | ILP 选 model + RL 选拓扑,cost −86% 性能持平 |
| AdaptOrch: Task-Adaptive Multi-Agent Orchestration | arXiv 2602.16873 | 任务自适应拓扑路由,+12–23% over 静态拓扑 |
| Retrieval-Conditioned Topology Selection (RGAO) | arXiv 2605.05657 | 代码结构复杂度向量路由,misrouting 30.1%→8.2% |
| Budget-Aware Agentic Routing via Boundary-Guided Training | ICML, arXiv 2602.21227 | 逐步 model 选择,预算约束下的路径依赖决策 |

## 二、多 agent 价值反思(反面证据)

| 文献 | 来源 | 启发 |
|---|---|---|
| When Do Multi-Agent LLM Systems Outperform(Stanford) | arXiv 2604.02460 | 等预算下单 agent 多跳推理胜 MAS;MAS 收益多来自未计入算力 |
| The Illusion of Multi-Agent Advantage(Salesforce) | arXiv 2606.13003 | 自动生成 MAS 一致劣于 CoT-SC 单 agent,且贵 10× |
| Rethinking the Value of Multi-Agent Workflow(Amazon/UT Austin) | arXiv 2601.12307 | 同构 MAS 可被单 agent 多轮模拟;OneFlow 算法 |
| Do More Agents Help? | arXiv 2606.05670 | 6 个 MAS 中仅 1 个超单 agent 锚点 |
| When Do Multi-Agent LLM Systems Outperform(ECER 2026) | 会议论文 | 单 agent 在所有任务族胜过测试的 multi-agent pipeline |

## 三、缓存与成本

| 文献 | 来源 | 启发 |
|---|---|---|
| Don't Break the Cache | arXiv 2601.06007, PwC | cache 降成本 41–80%、TTFT 13–31%;动态内容放后部 |
| Tokenomics of Multi-Agent SDLC | arXiv 2601.14470, MSR'26 | Code Review 占 59.4% token,input 占 53.9% |
| librarian-demo | AndreaGriffiths11, 2026-05 | 5 reviewer 实测:naive $1.316 / cache $0.453 / librarian $0.486 (第三方锚点, 非本项目基准; 本项目用 deepseek-v4-flash + 价格层 docs/16 实测) |
| Context window degradation | JetBrains Research 等 | 0–60% 填充性能稳,90% 恶化;observation masking −52% cost +2.6% solve |

## 四、Context 生命周期与对话树

| 文献/项目 | 来源 | 启发 |
|---|---|---|
| Conversation Tree Architecture (CTA) | arXiv 2603.21278 | 对话组织成树,节点独立 context;解决 logical context poisoning;volatile nodes |
| Claude Code context management | Anthropic 官方 | 三层 cascade 精确遗忘,保 cache 前缀 |
| Codex CLI handoff memo | OpenAI | all-or-nothing 历史替换 |
| OpenCode stepped governance | OpenCode | 非破坏性 hiding 后再 summarization |

## 五、Fork / 多 agent 编排实现

| 项目 | 来源 | 启发 |
|---|---|---|
| agor | Maxime Beauchemin | fork(复制 context)/ spawn(fresh)/ btw(临时)三原语,跨 Claude/Codex/Gemini |
| PraisonAI Hierarchical Sessions | docs.praison.ai | parent-child session,fork + merge,context 继承与隔离 |
| AWS AgentCore Memory Branching | awslabs/agentcore-samples | 单 memory session 内多分支,并行执行 + context 隔离 |
| Claude Agent Teams | Anthropic, 2026-02 | 共享 task list,leader-worker,Opus lead + Sonnet subagents +90.2% |
| AWS sample-claude-code-agent-team | aws-samples | 异构分层:opus 规划/审查 + sonnet 实现 + devops |
| Microsoft Conductor | opensource.microsoft.com, 2026-05 | YAML 确定性编排,编排层零 token |
| agent-teams-rs | internet-dot | Rust 复刻 Agent Teams,pluggable backend(Claude/Codex/Gemini) |
| Ouroboros | Tanush1912 | 六专家 agent 流水线:planner/implementer/validator/reviewer/cleaner/post-mortem |
| grit (rtk-ai) | github | AST 函数级锁,解决多 agent 并行 merge 冲突 |

## 六、自改进与可观测

| 项目 | 来源 | 启发 |
|---|---|---|
| selftune | selftune-dev/selftune | skill 级可观测 + 自动改写 skill 描述,支持 pi |
| Hermes Agent | NousResearch/hermes-agent | 自改进学习环,自动创建/改进 skill |
| Hermes self-evolution | NousResearch/hermes-agent-self-evolution | DSPy + GEPA 进化 skill/prompt/code |

## 七、编排模式分类

| 来源 | 启发 |
|---|---|
| Microsoft Azure / Atlan / Inventiple | 五种编排模式:orchestrator-worker / swarm / mesh / hierarchical / pipeline |
| A2A Protocol(Linux Foundation) | 跨厂商 agent 通信开放标准 |
| MCP(Anthropic) | 推理时受治理的 context 交付 |

## 八、研究综述类

| 文献 | 来源 | 启发 |
|---|---|---|
| Co-Coder | arXiv 2606.00953, UT Austin/Oxford | 图分区建模 MAS,+14% pass,2.10× 加速,−35% cost |
| The Code Agent Orchestra | Addy Osmani, 2026-03 | AI 编码 8 级模型,orchestrator vs conductor 心智模型 |

---

## 引用规范

文档内引用格式:`(来源, 年份)` 或 `(arXiv 编号)`。具体数据点尽量回链到本文件对应条目,便于溯源与更新。
