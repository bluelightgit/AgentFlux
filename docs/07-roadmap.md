# 07 - 落地路线

分五个阶段,按 ROI 排序。每阶段都有可验证的交付物和量化指标,前一阶段不达标不进入下一阶段。

## 阶段总览

> 本文后续阶段清单保留设计与历史背景；当前实现事实以 [26-implementation-status](26-implementation-status.md) 为唯一状态源。旧的“✅ 完成”不自动等价于已经接入生产入口并通过离线/在线验证。

| 阶段 | 周期 | 内容 | 预期收益 |
|---|---|---|---|
| Phase 0 | ✅ 完成 | 文档、架构、UI 方向 | 立论成立 |
| Phase 1 | ✅ 完成 | M1/M2 + 前缀布局 + mask + cache 监控 + 价格层 + TUI 菜单 | 成本可观测, prefix layout subagent 省 37.8% |
| Phase 2 | implemented / 部分 wired | M3 fork + 静态路由 + 多 agent 基础 | M3/M4 仍 experimental |
| **Phase 2.5** | **M1/M2/M5 wired，验证继续** | **执行闭环、质量门、取消、锁、checkpoint** | **生产纵向链路** |
| Phase 3 | implemented / 部分 wired | 任务级路由、经验导入、step routing；M6 experimental | 先 shadow evaluation，再开放 auto |
| Phase 4 | Desktop implemented / 部分 verified | Electron dashboard/control shell | 真实数据契约仍需收敛 |

> 2026-07-16 优先级说明：近期主线是完成 M1/M2/M5 主体执行能力与 task-driven Desktop Control Room。模式由用户或主 Agent 显式选择；自动路由校准、模型/拓扑优化和 OS sandbox 后置，不阻塞工作台交付。

> **战略调整 (2026-07)**: 先把 M2-M5 各种 agent 模式的执行能力做扎实, 再做智能路由。
> 理由: 路由器选了模式但模式本身执行能力不够 = 选了也白选。详见 [docs/22](22-mode-capability-roadmap.md)。

## 用户端路线总览

| 阶段 | 用户端形态 | 目标 |
|---|---|---|
| UI-A | pi TUI | 验证策略是否真的有效:footer/route inspector/cache ledger/subagent lane |
| UI-B | Web read-only dashboard | 看长期趋势:route map/cache ledger/context studio/decision replay |
| UI-C | Web control plane | 从 Web 调整策略:mode override/budget/agent pause/resume |
| UI-D | Electron/Tauri shell | 产品化:托盘、通知、后台 daemon、内嵌终端、多项目管理 |

原则:先用 pi TUI 验证核心价值,但从 Phase 1 开始写统一 telemetry,为 Web/Electron 留接口。

## 战略转向历史

### 2026-06: 从成本优化到多模式路由

用户反馈: 当前方向过于聚焦省钱, 但单 agent 理论上最省 token。**多模式系统和智能路由才是核心价值**, 不是成本优化。

- 成本优化 (compaction 避免、mask、prefix layout) 是次要价值: 实测 compaction 避免 15%, prefix layout 主进程 2.6% / subagent 37.8%
- **核心护城河是路由决策**: 何时用哪种模式、如何分解任务、何时异构多 agent (M6) 有不可替代价值
- 实证依据: OneFlow 论文 (arxiv 2601.12307) 证明同构多 agent 可被单 agent 模拟, 异构才是多 agent 的唯一不可替代价值

### 2026-07: 从路由优先到模式能力优先

用户反馈: 应先把 subagent、会话树分叉、multi-agent 等功能做好, 再做分配/路由。

- 当前路由器能选 M1-M6, 但 M4/M6 执行能力几乎为空, 选了和没选一样
- **先有可用的工具, 再做选择工具的智能**
- Phase 2.5 (新增): M2-M5 执行能力补全, 不动路由器, 专注执行层
- Phase 3 (调整): 智能路由后置, 前置条件改为 Phase 2.5 完成

> 详见 [docs/22 模式能力优先路线图](22-mode-capability-roadmap.md) 和 [docs/21 reasoning effort](21-reasoning-effort.md)。

---

## Phase 0:设计阶段 (✅ 完成)

**目标**:立论成立,设计文档完整,技术栈与集成路径明确。

**交付物**:
- [x] docs/00–12 全套设计文档
- [x] 三维度 + 六模式 + 三档配置 + 三层路由的完整定义
- [x] 技术栈选型(TS + Python sidecar)与 pi 集成可行性分析
- [x] 最小可行架构图与分层设计(见 [11](11-system-architecture.md))
- [x] TUI/Web/Electron 用户端方向(见 [12](12-ui-direction.md))
- [ ] Phase 1 任务拆解(见下)

**完成标准**:文档能回答"做什么、为什么、怎么做、何时做、用什么技术、用户端怎么呈现"六问。

---

## Phase 1:缓存优先(2 周,纯 TS,立刻见效)

**目标**:在 pi 上,用前缀布局 + mask + cache 监控 + 价格层把 subagent 流程成本可观测并优化,不动架构。

**技术栈**:纯 TypeScript(pi extension),不引入 Python。

**状态**: ✅ 14/14 任务完成 (含 F1-14 价格层)。详见 [docs/15](15-phase1-progress.md)。

**交付物(按 pi 能力映射)**:

| 任务 | pi 实现 | 文档依据 |
|---|---|---|
| F1-1 配置加载器 | extension 读 `.pi/agent/agentflux.yaml` + Level 1/2/3 schema | [04](04-config-schema.md) |
| F1-2 前缀布局强制器 | `before_agent_start` hook 改 system prompt(static 在前,diff 在后) | [06](06-cache-strategy.md) |
| F1-3 mask 策略 | `context` 事件 filter 旧 tool result(keep last N) | [06](06-cache-strategy.md) |
| F1-4 cache hit rate 监控 | `get_session_stats`/`ctx.sessionManager` 读 cacheRead/cacheWrite | [10](10-pi-integration.md) §3 |
| F1-5 TUI footer | `setFooter` 显示 mode + cache% + context% | [10](10-pi-integration.md) §5 / [12](12-ui-direction.md) |
| F1-6 模式选择器 | `ctx.ui.custom` overlay + SelectList(eco/balanced) | [04](04-config-schema.md) Level 1 / [12](12-ui-direction.md) |
| F1-7 subagent 适配 | 基于 `examples/extensions/subagent` 改造,加前缀布局 | [10](10-pi-integration.md) §2 M2 |
| F1-8 telemetry JSONL | 统一写 `routing.decision`/`cache.sample`/`context.event` | [11](11-system-architecture.md) |
| F1-9 route inspector | `/flux why` overlay 展示模式、理由、fallback、成本预估 | [12](12-ui-direction.md) |
| F1-10 偏好加载 + footer 落点 | 读 `preference.profile`,footer 显示当前倾向会落到哪个模式 | [13](13-routing-preference.md) |
| F1-11 `/flux preference` 调音台 | `SettingsList` 五维度调音 + 场景覆盖 | [13](13-routing-preference.md) |
| F1-12 project-profile 采集 | git 取 LOC/file/commit,footer 显示 stage + role | [14](14-project-evolution.md) |
| F1-13 `/flux project` 面板 | 成熟度信号面板 + 跃迁建议(suggest) | [14](14-project-evolution.md) |

**验证指标**:
- 对比 naive subagent,实测成本降幅 (基准 deepseek-v4-flash, 价格层 docs/16 提供 token×单价)
  - 实测: prefix layout 在 subagent 多轮场景省 37.8%, 主进程单 agent 仅省 2.6% (见 [docs/20](20-empirical-findings.md))
- cache hit rate ≥ 85%,footer 实时显示 ✅
- mask 策略下 solve rate 不下降 — ⚠️ mask 需重设计 (见 [docs/06](06-cache-strategy.md) mask 策略重设计需求)
- Windows 下 subagent 子进程 spawn 正常 ✅

**风险与对冲**:
- 前缀布局依赖 provider cache 行为 → 先验 Claude,`before_provider_request` 观测 payload
- mask 误删关键信息 → keep last N 可配,默认 N=3
- subagent 子进程 Windows 路径 → Phase 1 实测,必要时走 SDK 同进程

**为什么先做这步**:成本可观测是基础, 但不是核心卖点 (见战略转向)。核心价值在 Phase 2 的多模式和路由。

---

## Phase 2:对话树 + 静态路由 + 多 agent 基础 (✅ 完成)

**目标**:补上 Trilemma"准确性×成本"的最佳折中点(M3 fork),启用层 1 静态路由,并建立多 agent 基础 (模型能力层 + 角色定义 + 共享黑板)。

**技术栈**:纯 TypeScript。

**状态**: ✅ 12/12 任务完成。详见 [docs/15](15-phase1-progress.md)。

**交付物**:

| 任务 | pi 实现 | 文档依据 |
|---|---|---|
| F2-1 M3 对话树 fork | pi 原生 `ctx.fork` + `/tree` + branch summary(B4) | [10](10-pi-integration.md) §2 M3 |
| F2-2 fork merge 逻辑 | 信息性指导 (手动/git/Phase 3 自动), 自动 merge 延至 Phase 3 | [03](03-modes.md) |
| F2-3 层1 静态路由 | `input`+`before_agent_start` + bash/ls 收集代码信号 → 候选模式 | [05](05-routing.md) §层1 |
| F2-4 模型能力层 | models.json 结构 + 能力向量 + 亲和度匹配 + 启发式兑底 | [17](17-model-capability.md) |
| F2-5 角色定义层 | JSON/MD 角色定义 + 基础模板 + 实例注册表 | [18](18-agent-roles.md) |
| F2-6 共享黑板 | blackboard.json + tasks/ + handoffs/ + decisions/ | [19](19-multi-agent-architecture.md) |
| F2-7 /flux team 命令 | team plan/build/review/status/abort | [19](19-multi-agent-architecture.md) |
| F2-8 M5 管道 handoff | 基于 `examples/extensions/handoff.ts` 串联 | [10](10-pi-integration.md) §2 M5 |
| F2-9 Level 2 维度开关 | 配置层 + 校验(软约束 warning) | [04](04-config-schema.md) |
| F2-10 override_mode: suggest | 非侵入式 footer hint (非弹窗), 路由建议显示在 footer 小字 | [05](05-routing.md) |
| F2-11 运行时 B 维度自适应 | `session_before_compact` hook 拦截,按剩余工作选 mask/fork/compact/handoff | [10](10-pi-integration.md) §4 |
| F2-12 git 统计信号扩展 | 变更频率/活跃度/文件大小/测试覆盖率/TODO密度 | 本文档 |

**验证指标**:
- 多方案探索场景,wall-clock 比串行快 ≥ 40%
- 静态路由 misrouting ≤ 15%(对照 RGAO 8.2%)
- fork 分支 cache 命中 L1 + 部分 L2
- 运行时自适应在迭代 5+ 轮场景成本优于固定 compact
- 模型亲和度分配与用户直觉一致 (gpt 做规划, flash 做执行)
- 多 agent 管道 (plan→build→review) 端到端跑通

**风险与对冲**:
- fork merge 冲突 → 参考 grit AST 级锁;先支持简单合并,复杂场景人工介入
- 静态路由规则粗糙 → 硬编码起步,Phase 3 升级为学习型
- 亲和度启发式不准 → 用户可手动覆盖,后续接 benchmark API
- 多 agent 文件竞争 → handoff 文件名包含实例名,避免覆写

---

## Phase 2.5: 模式执行能力补全 (进行中)

**目标**: 让 M2-M5 每种模式真正能发挥其设计价值。M6 留到 Phase 3。不动路由器, 专注执行层。

**技术栈**: 纯 TypeScript。

**详细设计**: 见 [docs/22](22-mode-capability-roadmap.md)。

**交付物**:

#### M2 增强: subagent 能力补全

| 任务 | 内容 | 价值 |
|---|---|---|
| M2-1 并行 subagent | `Promise.all` 调用多个 subagent | 解锁 C2 stage 并行, wall-clock 减半 |
| M2-2 subagent 持久化 | 可选保留 session 文件 (去掉 `--no-session`) | 为 M4 持久 agent 打基础 |
| M2-3 工具白名单执行 | 验证 `--tools` 参数实际限制子进程工具 | 角色隔离落地 (planner 只读) |
| M2-4 reasoning effort 传递 | subagent 按角色传 `--thinking` 参数 | planner high / tester low, 见 [21](21-reasoning-effort.md) |
| M2-5 subagent 结果质量检查 | 轻量级 LLM 调用验证产出 | subagent 产出可靠性 |

#### M3 增强: 对话树 fork 工作流

| 任务 | 内容 | 价值 |
|---|---|---|
| M3-1 fork 工作流封装 | `/flux fork explore <task>` 一键 fork A/B | 用户不需要手动 fork + 输入两次任务 |
| M3-2 fork 结果比较 | LLM 对比两分支输出, 推荐胜者 | 自动 A/B 决策 |
| M3-3 fork merge 自动化 | 读取两分支 last assistant message, LLM 合并注入主分支 | 自动 merge 能力 |
| M3-4 fork prune | 一键丢弃失败分支 + 记录原因 | 清理对话树, 保留决策审计 |

#### M4 实现: 持久 multi-agent (从零搭建)

| 任务 | 内容 | 价值 |
|---|---|---|
| M4-1 持久 session subagent | subagent 保留 session 文件, 可被再次调用续接 | L2 cache 跨调用复用, 持久记忆 |
| M4-2 agent 间消息传递 | 共享黑板新增 `messages/` 目录, agent 可发消息给指定 peer | 突破 star 拓扑限制 |
| M4-3 任务队列消费 | agent 主动从 `tasks/` 认领任务, 不只是被动接收 | leader-worker 模式落地 |
| M4-4 agent 状态同步 | agent 完成任务后更新黑板 + 通知依赖者 | DAG 依赖推进 |
| M4-5 持久 reviewer 甜区 | 同一 reviewer agent 跨多次调用保留 session | 验证 L2 长期收益 > compaction 代价 |

#### M5 增强: 管道柔性化

| 任务 | 内容 | 价值 |
|---|---|---|
| M5-1 动态任务分解 | planner 输出结构化任务 DAG (JSON), 不是纯文本 handoff | 从"三步固定"到"N 步动态" |
| M5-2 DAG 执行器 | 按拓扑序执行, 独立节点并行 | 真正的管道编排 |
| M5-3 条件分支 | review 失败 → 回 implementer 修复 → 重新 review | 闭环验证 |
| M5-4 质量门 | acceptance criteria 检查, 不通过自动重试 (≤2 次) | 产出质量保障 |
| M5-5 管道中断/恢复 | 保存执行状态到黑板, 中断后可从断点续跑 | 长任务健壮性 |

**验证指标**:
- M2 并行: 两个独立 subagent wall-clock ≤ 串行的 60%
- M3 fork explore: A/B 比较自动推荐胜者, 用户确认率 > 70%
- M4 持久 reviewer: 跨 3 次调用 L2 cache 命中率 > 50%, 成本低于 3 次 fresh subagent
- M5 DAG: 4 节点 DAG (2 并行 + 2 串行) 正确执行, 并行节点 wall-clock < 串行节点之和
- M5 质量门: acceptance criteria 不通过时自动重试, 重试后通过率 > 80%

**风险与对冲**:
- 持久 session 的 compaction 侵蚀 → 先验证短周期 (3-5 次调用) 甜区, 长期场景后置
- DAG 执行器复杂度 → 先支持线性 + 单层并行, 复杂 DAG 后续迭代
- agent 间消息传递的时序问题 → 文件锁 + 简单轮询, 不做复杂 IPC
- 质量门 LLM 调用增加成本 → 用便宜模型 (flash/haiku) 做门检查

**为什么先做这步**: 路由器选了模式但模式执行能力不够 = 选了也白选。先有可用的工具, 再做选择工具的智能。

---

## Phase 3: 异构 + 智能路由 (规划中, TS + Python sidecar)

**前置条件**: Phase 2.5 的 M2-M5 能力补全完成。

**目标**: 补上 multi-agent 的真价值 (M6 异构), 并启用任务级路由 + 反馈闭环 + step-level routing, 形成护城河。

**技术栈**: TypeScript (pi extension) + Python sidecar (ILP/RL)。

**交付物**:

| 任务 | 实现 | 文档依据 |
|---|---|---|
| F3-1 M6 异构团队 | per-agent model config + reasoning effort (opus 决策 / flash 执行) | [03](03-modes.md) M6, [21](21-reasoning-effort.md) |
| F3-2 任务级路由 | `input` 事件做任务分类, 基于 git diff 而非全仓库 | [05](05-routing.md) §层1 |
| F3-3 反馈闭环 | ExperienceStore 消费 telemetry, 统计最优模式 | [05](05-routing.md) §层3 |
| F3-4 step-level model routing | 每步按任务复杂度选 model + effort | [21](21-reasoning-effort.md) |
| F3-5 Python sidecar | stdio JSON 通信, ortools (ILP) / stable-baselines (RL) | [09](09-tech-stack.md) |
| F3-6 层2 预算路由 (ILP) | Python ILP 选 model 组合 + effort | [05](05-routing.md) §层2 |
| F3-7 层3 经验路由 (RL) | Python RL 策略优化 | [05](05-routing.md) §层3 |
| F3-8 override_mode: auto | 路由器全自动, 用户配置仅作约束 | [04](04-config-schema.md) |

**验证指标**:
- 异构团队成本 ≤ 同构 M4 的 70%, accuracy 不降 (对照 BAMAS −86%)
- 任务级路由 misrouting ≤ 10% (对照 RGAO 8.2%)
- 经验路由迭代 N 轮后, cost 比 Phase 2.5 再降 ≥ 20% (对照 EvoRoute −80%)
- step-level routing: 72% 成本降幅, 质量降幅 < 3% (对照 AgentRouter)

**风险与对冲**:
- ILP/RL 实现复杂 → 先用启发式 model 分配替代 ILP, 反馈闭环用统计替代 RL
- RL 冷启动可能劣于静态路由 → 冷启动期 `override_mode: suggest`, 数据足够再切 auto
- M6 异构 cache 跨 model 失效 → 用 model 差价补偿, 异构摊薄成本

---

## Phase 4: 产品化 (规划中)

**目标**: 从 pi TUI 扩展到 Web/Electron, 支撑多项目管理和长期趋势分析。

**交付物**:

| 任务 | 实现 | 文档依据 |
|---|---|---|
| F4-1 Web read-only dashboard | 路由历史 / cache 趋势 / 成本分析, 消费 events.jsonl | [12](12-ui-direction.md) UI-B |
| F4-2 Web control plane | 偏好调整 / 模式覆盖 / agent pause/resume | [12](12-ui-direction.md) UI-C |
| F4-3 Electron/Tauri shell | 托盘 / 通知 / 后台 daemon / 多项目管理 | [12](12-ui-direction.md) UI-D |

---

## 跨阶段原则

1. **每阶段可独立交付价值**: Phase 1 不依赖 Phase 2, 用户随时可用
2. **模式能力先于路由智能**: Phase 2.5 补全执行能力, Phase 3 才做智能路由
3. **数据驱动升级**: Phase 3 的 RL 依赖 Phase 1/2/2.5 积累的执行数据
4. **可回退**: 每个执行器都是可选的, 路由失败回退到 M1
5. **纯 TS 先行, Python 后置**: Phase 1/2/2.5 纯 TS 快速验证, Phase 3 才引入 sidecar

## 下一步(离开 Phase 0 前)

- [x] 确定技术栈:TS(pi extension)+ Python sidecar(Phase 3)
- [x] 确定集成目标:内置 pi
- [x] pi 集成可行性分析(见 [10](10-pi-integration.md))
- [x] 画最小可行架构图(extension ↔ core ↔ telemetry ↔ UI ↔ Python sidecar,见 [11](11-system-architecture.md))
- [x] 给出 TUI/Web/Electron 用户端方向(见 [12](12-ui-direction.md))
- [x] 路由偏好可配置 + 可视化方向(见 [13](13-routing-preference.md))
- [x] 项目演进 + 角色演进规划(见 [14](14-project-evolution.md))
- [x] 拆 Phase 1 的具体任务(F1-1 ~ F1-13)成 issue 清单
- [x] 做 V0 probe:cache footer + events.jsonl + context% 显示 (结论见 [docs/20](20-empirical-findings.md))
- [x] 在真实 pi 环境跑通 `examples/extensions/subagent`,验证 Windows 子进程
