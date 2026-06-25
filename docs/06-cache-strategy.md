# 06 - 缓存策略

**缓存是成本的第一杠杆,不是减 agent。** Don't Break the Cache(arXiv 2601.06007)实测 prompt cache 降成本 41–80%、TTFT 13–31%。Anthropic 把 cache hit rate 掉低当生产事故(SEV)处理。本章是 AgentFlux 所有成本优化的基础。

## Prompt Cache 机制(硬事实)

1. **prefix exact match**:cache 按 API 请求前缀精确匹配,前缀任何一处改动,其后全部重算。**没有 per-file / per-segment 缓存。**
2. **provider 级、跨 session 共享**:只要前缀一致,不同 session/调用也能命中(5 min TTL)。**subagent 跨调用可命中,前提是前缀布局一致。**
3. **定价**:cache read ≈ 10% input 价,cache write ≈ 125% input 价。命中省 90%,写入多花 25%。
4. **model 绑定**:中途换 model → 全 miss。这是异构(D2)的代价来源。

> 关键澄清:"subagent 没有 session" ≠ "subagent 不能命中 cache"。这是常见误解。subagent 临时调用也能命中 L1,只要前缀一致。

## 三层 cache 收益模型

> ⚠️ 以下经 V0 实测修正(详见 `experiments/v0-probe/CACHE-FINDINGS.md`)。
> 实测环境: pi 0.80.2 + octopus-anthropic(deepseek-v4-flash, supportsLongCacheRetention)。

| 层次 | 内容 | 大小 | subagent(临时) | 持久 session |
|---|---|---|---|---|
| **L1 稳定前缀** | system + CLAUDE.md + 相关文件 | ~1.5K–40K | 前缀一致就命中(显式 cache_control) | 命中 |
| **L2 历史对话** | 上轮 review 意见等累积历史 | 1–几十 K | **不命中**(每次 fresh) | **≥1024 token 才命中**(隐式缓存) |
| **L3 当轮新增** | 新 diff、新输出 | 变化 | 不命中 | 不命中 |

**实测修正点**:
1. **L1**: pi 默认给 system prompt 打 `cache_control`, 稳定命中(实测 1536 token system 块)。跨 session 5min TTL 内共享(实测同中转不同 session 命中)。
2. **L2 不是默认命中**: 需 ≥1024 token 阈值(Anthropic 隐式缓存要求)。短对话历史不缓存、每轮重传; 长历史(≥1024)隐式缓存自动覆盖、逐轮累积命中(实测 read 增量 3200→22144 递增)。
3. **pi 默认不给历史打 cache_control**: 只给 system + 最后一条 user 打标记。L2 命中完全靠 provider 隐式缓存。AgentFlux 可通过 `before_provider_request` 主动给历史注入 cache_control 控制断点(实测可行)。

- **naive subagent**(前缀不一致):L1+L2+L3 全 miss → 最贵
- **优化 subagent**(前缀一致):L1 命中,L2/L3 miss → 省大部分
- **持久 session**:L1+L2(≥1024)命中,L3 miss → 再省 L2

L2 是持久 session 比 subagent 多省的部分,但被 compaction 限制(见下)。

## 前缀布局原则

核心:**静态在前,动态在后**,最大化 prefix 共享。

```
┌─────────────────────────────────────┐
│ system prompt + tools(全局静态)    │ ← 全局 cache,所有 session 命中
├─────────────────────────────────────┤
│ CLAUDE.md / 项目 context(项目静态) │ ← 项目内 cache
├─────────────────────────────────────┤
│ 相关文件内容(任务静态)             │ ← 任务内 cache
├─────────────────────────────────────┤
│ 对话历史(累积,半静态)             │ ← session cache(L2)
├─────────────────────────────────────┤
│ 当轮 diff / user message(动态)     │ ← 不缓存(L3)
└─────────────────────────────────────┘
```

调用 subagent 做测试/review 时,**把共享内容(diff、相关文件)放 system message 前部,role 描述放最前**,保证每次调用前缀一致。

## Cache 杀手清单

| 杀手 | 后果 | 对策 |
|---|---|---|
| system prompt 放时间戳/随机数 | 前缀每次变,全 miss | 移除动态内容 |
| tool 顺序随机化 | 前缀变,全 miss | 固定 tool 顺序 |
| 中途换 model | 跨 model 不共享 | 整个 session 锁定 model |
| diff 放 user message 前部 | 每轮前缀变 | diff 放后部 |
| subagent 各自带不同前缀 | 跨调用全 miss | 统一前缀布局 |
| **历史消息未打 cache_control** | **L2 靠隐式缓存, 短历史(<1024)不命中** | **AgentFlux 主动注入 cache_control 断点(before_provider_request)** |
| 频繁 compaction | 摧毁 prefix,全 miss | 见下 |

## Compaction 与 Cache

**每次 compaction 摧毁整个 cached prefix,触发全价重读。** 这是持久 session L2 收益的侵蚀源:

> ✅ 已实测(compaction-large.py): compact 成功后, 下一轮 cacheRead 增量从 22144 **暴跌到 1536(只剩 system)**, input 增量从 ~2000 **暴涨到 17985**。机制: compaction 在 system 后插入摘要(新内容), 使从摘要起的整个后续前缀失效 —— 即使保留了最近 20000 token 历史, 也因前部插入而全失效。

> ⚠️ 实测补充: pi 的 `keepRecentTokens` 默认 **20000**, session ≤ 20000 token 时 compact 报 "Nothing to compact" 拒绝执行。低占用 session compact 不可用, 只能继续累积或新建 session(影响 docs/05 决策树)。

- 迭代 2–3 轮:持久 session 净省(L2 命中 > 协调开销)
- 迭代 5+ 轮:compaction 来,L2 收益一次性吐回,可能反更贵
- 跨多 PR 长期 reviewer:L2 = 几十 K 项目知识,收益超 compaction 代价 → 真省

**对策**:用 B2 mask(隐藏旧 tool result,不摘要)替代 B1 compact,保留 prefix。JetBrains Research 实测 mask 比 compact 省 52% cost 且 +2.6% solve rate(compact 反而模糊停止信号)。

## 各模式 Cache 表现

| 模式 | L1 | L2 | 典型成本(相对) | 备注 |
|---|---|---|---|---|
| M1 单 agent | ✓ | ✓ | 1.0× | 基准,最优 |
| M2 naive subagent | ✗ | ✗ | ~3× | 前缀不一致,$1.32/PR |
| M2 优化 subagent | ✓ | ✗ | ~1.1× | 前缀一致,$0.45/PR |
| M3 fork | ✓ | 部分 | ~1.3× | 共享前缀,分支独立 |
| M4 持久 multi-agent | ✓ | ✓(短期) | ~2–4× | 长期被 compaction 侵蚀 |
| M5 管道 handoff | ✗(每段重载) | ✗ | ~2× | 每段 fresh |
| M6 异构 | ✗(跨 model) | ✗ | ~1.5–3× | 异构摊薄,但 cache 跨 model 失效 |

## 实测数据锚点(librarian-demo, 2026-05, Claude Opus 4.6)

5 reviewer agent 审同一 16K-token PR:

| 模式 | 成本/PR | 说明 |
|---|---|---|
| Naive(各带 full diff,前缀不同) | $1.316 | cache 全失效 |
| Cache(diff 放 system message,共享前缀) | $0.453 | 4/5 命中,省 66% |
| Librarian(先摘要 diff) | $0.486 | cold 场景下赢 |

- **warm 系列(背靠背调用)**:cache 模式赢
- **cold-every-call(跨多 dev/repo)**:librarian 模式赢
- 启示:AgentFlux 路由器应检测调用模式,warm 用 cache 优化,cold 用 librarian 摘要

## AgentFlux 的缓存守则

1. 默认 `prefix_layout: static_first`,强制静态在前
2. 禁止 cache 杀手(见清单)进入 system prompt
3. context 满了优先 B2 mask,慎用 B1 compact
4. 监控 `target_hit_rate`,低于阈值告警
5. subagent 调用统一前缀布局,跨调用复用 L1
6. 异构(D2)场景接受 cache 失效,用 model 差价补偿
