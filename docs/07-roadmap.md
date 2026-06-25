# 07 - 落地路线

分四个阶段,按 ROI 排序。每阶段都有可验证的交付物和量化指标,前一阶段不达标不进入下一阶段。

## 阶段总览

| 阶段 | 周期 | 内容 | 预期收益 |
|---|---|---|---|
| Phase 0 | 当前 | 文档、架构、UI 方向 | 立论成立 |
| Phase 1 | ~2 周 | M1/M2 + 前缀布局 + mask + pi TUI 验证 | 成本 −60% |
| Phase 2 | ~1 月 | M3 fork + 静态路由 + Web read-only dashboard | 准确性×成本折中点 |
| Phase 3 | ~2 月+ | M6 异构 + ILP/RL 路由 + Web control plane/Electron | 护城河 |

## 用户端路线总览

| 阶段 | 用户端形态 | 目标 |
|---|---|---|
| UI-A | pi TUI | 验证策略是否真的有效:footer/route inspector/cache ledger/subagent lane |
| UI-B | Web read-only dashboard | 看长期趋势:route map/cache ledger/context studio/decision replay |
| UI-C | Web control plane | 从 Web 调整策略:mode override/budget/agent pause/resume |
| UI-D | Electron/Tauri shell | 产品化:托盘、通知、后台 daemon、内嵌终端、多项目管理 |

原则:先用 pi TUI 验证核心价值,但从 Phase 1 开始写统一 telemetry,为 Web/Electron 留接口。

---

## Phase 0:设计阶段(当前)

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
- 对比 naive subagent,实测成本降幅 (基准 deepseek-v4-flash, 价格层 docs/16 提供 token×单价, 不再套用第三方 60% 锚点)
- cache hit rate ≥ 85%,footer 实时显示
- mask 策略下 solve rate 不下降(对照 JetBrains +2.6%)
- Windows 下 subagent 子进程 spawn 正常

**风险与对冲**:
- 前缀布局依赖 provider cache 行为 → 先验 Claude,`before_provider_request` 观测 payload
- mask 误删关键信息 → keep last N 可配,默认 N=3
- subagent 子进程 Windows 路径 → Phase 1 实测,必要时走 SDK 同进程

**为什么先做这步**:Trilemma 三角上"成本"边最便宜的优化,几乎不动架构,ROI 最高。单 session 内闭环迭代(用户当前主流程)在此阶段就够用。

---

## Phase 2:对话树 + 静态路由(1 月,纯 TS)

**目标**:补上 Trilemma"准确性×成本"的最佳折中点(M3 fork),并启用层 1 静态路由。

**技术栈**:纯 TypeScript。

**交付物**:

| 任务 | pi 实现 | 文档依据 |
|---|---|---|
| F2-1 M3 对话树 fork | pi 原生 `ctx.fork` + `/tree` + branch summary(B4) | [10](10-pi-integration.md) §2 M3 |
| F2-2 fork merge 逻辑 | 读两 session leaf,合并消息;参考 grit AST 锁 | [03](03-modes.md) |
| F2-3 层1 静态路由 | `input`+`before_agent_start` + bash/ls 收集代码信号 → 候选模式 | [05](05-routing.md) §层1 |
| F2-4 M5 管道 handoff | 基于 `examples/extensions/handoff.ts` 串联 | [10](10-pi-integration.md) §2 M5 |
| F2-5 Level 2 维度开关 | 配置层 + 校验(软约束 warning) | [04](04-config-schema.md) |
| F2-6 override_mode: suggest | `ctx.ui.confirm`/`select` 路由决策确认 | [05](05-routing.md) |
| F2-7 运行时 B 维度自适应 | `session_before_compact` hook 拦截,按剩余工作选 mask/fork/compact/handoff | [10](10-pi-integration.md) §4 |

**验证指标**:
- 多方案探索场景,wall-clock 比串行快 ≥ 40%
- 静态路由 misrouting ≤ 15%(对照 RGAO 8.2%)
- fork 分支 cache 命中 L1 + 部分 L2
- 运行时自适应在迭代 5+ 轮场景成本优于固定 compact

**风险与对冲**:
- fork merge 冲突 → 参考 grit AST 级锁;先支持简单合并,复杂场景人工介入
- 静态路由规则粗糙 → 硬编码起步,Phase 3 升级为学习型

---

## Phase 3:异构 + 自适应路由(2 月+,TS + Python sidecar)

**目标**:补上 multi-agent 的真价值(M6 异构),并启用层 2/3 自适应路由,形成护城河。

**技术栈**:TypeScript(pi extension)+ Python sidecar(ILP/RL)。

**交付物**:

| 任务 | 实现 | 文档依据 |
|---|---|---|
| F3-1 M4 持久 multi-agent | 多 pi RPC 进程 + eventBus + 自建共享 task list(SQLite) | [10](10-pi-integration.md) §2 M4 |
| F3-2 M6 异构团队 | subagent + per-agent model config(opus 决策 / sonnet 执行) | [03](03-modes.md) M6 |
| F3-3 Python sidecar | stdio JSON 通信,ortools(ILP)/stable-baselines(RL) | [09](09-tech-stack.md) |
| F3-4 层2 预算路由(ILP) | `get_session_stats` cost + Python ILP 选 model 组合 | [05](05-routing.md) §层2 |
| F3-5 层3 经验路由(RL) | `pi.appendEntry` 记录反馈 → Python RL 更新策略 | [05](05-routing.md) §层3 |
| F3-6 override_mode: auto | 路由器全自动,用户配置仅作约束 | [04](04-config-schema.md) |
| F3-7 持久 reviewer 甜区 | subagent 复用同一 session 文件,跨 PR 记忆项目约定 | [10](10-pi-integration.md) §6 |

**验证指标**:
- 异构团队成本 ≤ 同构 M4 的 70%,accuracy 不降(对照 BAMAS −86%)
- 经验路由迭代 N 轮后,cost 比 Phase 2 再降 ≥ 20%(对照 EvoRoute −80%)
- 持久 reviewer 跨 PR 场景 L2 收益超 compaction 代价

**风险与对冲**:
- M4 共享状态自建工作量大 → 先做"持久 reviewer subagent"覆盖 80% 甜区
- ILP/RL 实现复杂 → 先用启发式 model 分配替代 ILP
- RL 冷启动可能劣于静态路由 → 冷启动期 `override_mode: suggest`,数据足够再切 auto

---

## 跨阶段原则

1. **每阶段可独立交付价值**:Phase 1 不依赖 Phase 2,用户随时可用
2. **数据驱动升级**:Phase 3 的 RL 依赖 Phase 1/2 积累的执行数据
3. **不提前优化**:异构和 RL 放最后,先把单 session 内闭环做扎实
4. **可回退**:每个执行器都是可选的,路由失败回退到 M1
5. **纯 TS 先行,Python 后置**:Phase 1/2 纯 TS 快速验证,Phase 3 才引入 sidecar

## 下一步(离开 Phase 0 前)

- [x] 确定技术栈:TS(pi extension)+ Python sidecar(Phase 3)
- [x] 确定集成目标:内置 pi
- [x] pi 集成可行性分析(见 [10](10-pi-integration.md))
- [x] 画最小可行架构图(extension ↔ core ↔ telemetry ↔ UI ↔ Python sidecar,见 [11](11-system-architecture.md))
- [x] 给出 TUI/Web/Electron 用户端方向(见 [12](12-ui-direction.md))
- [x] 路由偏好可配置 + 可视化方向(见 [13](13-routing-preference.md))
- [x] 项目演进 + 角色演进规划(见 [14](14-project-evolution.md))
- [ ] 拆 Phase 1 的具体任务(F1-1 ~ F1-13)成 issue 清单
- [ ] 做 V0 probe:cache footer + events.jsonl + context% 显示
- [ ] 在真实 pi 环境跑通 `examples/extensions/subagent`,验证 Windows 子进程
