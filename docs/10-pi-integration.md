# 10 - pi 集成可行性分析

## 结论先行

**可行性:高。** pi 的能力边界覆盖 AgentFlux Phase 1–2 的全部需求,Phase 3 的 ILP/RL 由 Python sidecar 补充。最大风险在 M4 持久 multi-agent 的共享状态(pi 无原生支持,需自建),但 M4 是 Phase 3 才做,且有缓解方案。

决定性证据:**pi 的 `examples/extensions/` 已有 `subagent`、`handoff`、`custom-compaction`、`plan-mode`、`trigger-compact` 等示例**——AgentFlux 的核心原语大半已有参考实现,不是从零造。

---

## 一、能力映射总表

| AgentFlux 概念 | pi 对应能力 | 成熟度 | 风险 |
|---|---|---|---|
| **维度 A1 single** | pi 默认单 session | ✅ 原生 | 无 |
| **维度 A2 star(subagent)** | `examples/extensions/subagent`(独立 pi 子进程 + delegated system prompt + 并行流式 + usage tracking + abort) | ✅ 现成示例 | 无 |
| **维度 A3 fork(对话树)** | pi 原生 session tree:`ctx.fork(entryId)`、`/tree`、`SessionManager.branch/createBranchedSession`、branch summaries | ✅ 原生 + 文档全 | merge 逻辑需自定义 |
| **维度 A4 peers(持久 multi-agent)** | 多 session + `createEventBus` 跨 extension 通信 + SessionManager 多文件 | ⚠️ 需自建共享 task list | **M4 主要风险** |
| **维度 B1 compact** | `ctx.compact()` + `session_before_compact` hook(可 cancel / 自定义摘要) | ✅ 原生 | 无 |
| **维度 B2 mask** | `context` 事件(`event.messages` 是 deep copy,可 filter 旧 tool result) | ✅ 原生 hook | 误删信息需谨慎 |
| **维度 B3 handoff** | `examples/extensions/handoff.ts`(注释明言 "Instead of compacting which is lossy") | ✅ 现成示例 | 无 |
| **维度 B4 fork-prune** | pi branch summaries("summarize abandoned branch, attach at new position")= volatile nodes | ✅ 原生 | 无 |
| **维度 C1 sequential** | 默认 | ✅ | 无 |
| **维度 C2/C3 并行** | subagent 示例"parallel streaming: all parallel tasks stream simultaneously" | ✅ 现成 | 无 |
| **维度 D1 homogeneous** | 默认 | ✅ | 无 |
| **维度 D2 heterogeneous** | `set_model`/`cycle_model` + subagent delegated model config(scout/worker/reviewer 各配 model) | ✅ 示例有 | 无 |
| **前缀布局** | `before_agent_start` 改 system prompt(static 在前)+ `before_provider_request` 检查 payload | ✅ 原生 hook | 需按 provider 验证 |
| **cache 监控** | `get_session_stats` 暴露 `tokens.cacheRead/cacheWrite` + `contextUsage.percent` | ✅ 原生 | 无 |
| **路由层1 静态** | `input` + `before_agent_start` + bash/ls 收集代码信号 | ✅ 可实现 | 无 |
| **路由层2 预算** | `get_session_stats` 的 `cost` + `contextUsage` | ✅ 可实现 | ILP 需 Python |
| **路由层3 经验** | `pi.appendEntry()`(session persistence)记录反馈 | ✅ 可实现 | RL 需 Python |
| **TUI 模式选择器** | `ctx.ui.custom` + SelectList overlay | ✅ 原生组件 | 无 |
| **TUI cache footer** | `setFooter` + get_session_stats | ✅ 原生 | 无 |
| **TUI 模式指示** | `setStatus` | ✅ 原生 | 无 |
| **TUI 决策确认** | `ctx.ui.confirm`/`select`(对应 override_mode: suggest) | ✅ 原生 | 无 |

---

## 二、六模式在 pi 上的落地路径

### M1 单 agent
**pi 配置**:默认 + extension 监听 `context` 事件做 B2 mask。
**关键 hook**:
```typescript
pi.on("context", async (event, ctx) => {
  // event.messages 是 deep copy,安全修改
  const masked = maskOldToolResults(event.messages, { keepLastN: 3 });
  return { messages: masked };
});
```
**结论**:零风险,Phase 1 即可。

### M2 主 + subagent(Phase 1 重点)
**pi 配置**:基于 `examples/extensions/subagent` 改造。
**关键改动**:
- subagent 调用时,`before_agent_start` 强制前缀布局(role 描述最前 → CLAUDE.md → 文件 → diff)
- subagent 返回前,`context` 事件做 mask
- `get_session_stats` 读 cacheRead/cacheWrite,算 hit rate,`setFooter` 显示
**结论**:subagent 示例已解决隔离/并行/usage/abort,AgentFlux 只需加"前缀布局 + mask + 监控"三件事。

### M3 对话树 fork(Phase 2 重点)
**pi 配置**:原生 fork + tree。
**关键能力**:
- `ctx.fork(entryId)` 从某点分叉(对应 A3)
- `/tree` 浏览导航(用户可视化)
- branch summary = B4 fork-prune(volatile nodes)
- `session_before_fork` hook 可拦截/定制
**结论**:pi 的 session tree 是 M3 的天然底座,比 agor/PraisonAI 的 fork 实现更原生。merge 赢家需自写(读两个 session 的 leaf,合并消息)。

### M4 持久 multi-agent(Phase 3)
**pi 配置**:多 session 文件 + eventBus + 自建共享 task list。
**缺口**:pi 无原生"多个持久 agent 共享 task list"(Claude Agent Teams 的核心)。需自建:
- 共享状态存 SQLite/JSON(AgentFlux 自己管)
- 每个 agent 一个 pi RPC 进程,通过 eventBus + 共享文件通信
- mailbox 用文件队列或轻量 HTTP
**结论**:可行但工作量大,放 Phase 3。缓解:先做"单 parent + 持久 reviewer subagent"(subagent 复用同一 session 文件而非每次新建),覆盖 80% 甜区。

### M5 管道 handoff
**pi 配置**:`examples/extensions/handoff.ts` 串联。
**关键**:handoff.ts 已实现"extract what matters → generate prompt → newSession → 注入"。AgentFlux 串成 plan→impl→test→review 链,每段 fresh session。
**结论**:现成,Phase 2 可做。

### M6 异构团队
**pi 配置**:subagent + delegated model config。
**关键**:subagent 示例的 `agents/*.md` 已支持 per-agent model 配置。AgentFlux 加路由:决策点用 opus,执行用 sonnet。
**结论**:Phase 3,依赖 subagent + 路由层。

---

## 三、cache 监控的落地(关键发现)

`get_session_stats`(RPC)和 `ctx.sessionManager`(extension)都暴露了 cache 数据:

```json
{
  "tokens": { "input": 50000, "cacheRead": 40000, "cacheWrite": 5000 },
  "cost": 0.45,
  "contextUsage": { "tokens": 60000, "contextWindow": 200000, "percent": 30 }
}
```

**这意味着 AgentFlux 的 cache hit rate 监控零成本可用**:
- hit rate = `cacheRead / (cacheRead + input)`(近似)
- context 填充率 = `contextUsage.percent`
- 两者都能 `setFooter` 实时显示,低于阈值 `setStatus` 告警

这是 Phase 1 "缓存优先"的观测基础,文档 [06](06-cache-strategy.md) 的 `target_hit_rate` 配置有真实数据支撑。

---

## 四、运行时自适应(B 维度)的落地

文档 [05](05-routing.md) 的"compact vs 新 session"决策树,映射到 pi:

```
context 事件触发时读 contextUsage.percent
  │
  ├─ < 70%  → 不动(B2 mask 在 context 事件里常态做)
  │
  ├─ 70-90% → 评估剩余工作:
  │     ├─ 剩余多 → ctx.fork()(B4 fork-prune,内容进分支保留)
  │     └─ 剩余少 → ctx.compact()(B1,接受一次 cache 重建)
  │
  └─ ≥ 90% → handoff.ts 逻辑(B3 新 session + 结构化摘要)
```

`session_before_compact` hook 让 AgentFlux 能**拦截自动 compaction**,改用 mask 或 fork——这是"compaction 摧毁 cache"问题的直接控制点。

---

## 五、TUI 可视化方案

复用 pi 原生 TUI,不重写。映射:

| AgentFlux 需求 | pi TUI 实现 | 组件 |
|---|---|---|
| 当前工作模式指示 | `setStatus("flux", "M2 · cache 87%")` | footer 状态 |
| cache hit rate / context% | `setFooter` 读 get_session_stats | custom footer |
| 模式选择器(override_mode: suggest) | `ctx.ui.custom` overlay + SelectList | SelectList + DynamicBorder |
| 路由决策确认 | `ctx.ui.confirm` / `select` | 原生 dialog |
| 任务进度/todo | `setWidget` | widget above editor |
| 并行 subagent 进度 | `setWidget` 多行 + subagent 流式 | widget |

pi TUI 已有 SelectList/SettingsList/BorderedLoader/overlay(9 种 anchor),覆盖 AgentFlux 全部可视化需求。**不需要 Electron,不需要 Python TUI,不需要重写。**

---

## 六、风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| M4 持久 multi-agent 共享状态需自建 | 中 | Phase 3 才做;先做"持久 reviewer subagent"覆盖甜区 |
| 前缀布局需按 provider 验证(Claude/OpenAI cache 行为不同) | 中 | Phase 1 针对 Claude 先验证,OpenAI 后补;`before_provider_request` 可观测 |
| fork merge 逻辑需自定义 | 低 | Phase 2 做;参考 grit 的 AST 级锁思路 |
| Python sidecar 跨语言复杂度 | 低 | Phase 3 才引入;Phase 1/2 纯 TS |
| pi 版本升级破坏 extension API | 低 | extension API 稳定;锁定 pi 版本 |
| subagent 示例是独立 pi 子进程,Windows 路径/spawn 需验证 | 低 | Phase 1 在 Windows 实测 |

---

## 七、可行性总评

| 维度 | 评估 |
|---|---|
| **技术可行** | ✅ pi 能力覆盖 Phase 1–2 全部,Phase 3 由 Python 补 |
| **工作量可控** | ✅ 核心原语有示例,不是从零;Phase 1 仅"前缀布局+mask+监控"三件事 |
| **风险可控** | ✅ 主要风险(M4)在远期,且有缓解 |
| **与 pi 哲学契合** | ✅ pi 故意留 extension 缝隙,AgentFlux 正好填入 |
| **不重复造轮子** | ✅ subagent/handoff/compaction/tree 全复用 pi 原生或示例 |
| **可渐进交付** | ✅ Phase 1 纯 TS 独立见效,不依赖后续 |

**结论:方案成立,进入 Phase 1 实现拆解。**
