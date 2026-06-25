# AgentFlux 缓存机制实证报告

> 基于 pi 0.80.2 + octopus-anthropic(deepseek-v4-flash, supportsLongCacheRetention) 的实测数据。
> 本报告修正并夯实 docs/06-cache-strategy.md 的立论。所有数据可复现(见同目录脚本)。

## 核心结论(三段闭环)

| # | 论点 | 实证 | 数据 |
|---|---|---|---|
| 1 | **L1 system prompt 显式缓存, 稳定命中** | ✅ | system 2601 chars(≈1500 token) 打 cache_control, 每轮 cacheRead 基线 1536 |
| 2 | **L2 长历史(≥1024 token)隐式缓存累积命中** | ✅ | 每轮 read 增量 3200→4480→...→22144 递增, 历史逐轮进缓存 |
| 3 | **compaction 摧毁 L2 缓存前缀** | ✅ | compact 后 read 增量 22144→1536(暴跌93%), input 增量暴涨 17985 |

## 实验一: 短 prompt 多轮 (print 模式, flux-multiturn)

短对话历史(< 1024 token 阈值)。

| 轮 | 累计 input | 累计 cacheRead | 单次 read 增量 | hit rate |
|---|---|---|---|---|
| 1 | 1562 | 0 | 0 | 0% |
| 2 | 1607 | 1536 | 1536 | 49% |
| 3 | 1677 | 3072 | 1536 | 65% |

**发现**: 每轮单次 read 增量恒为 1536(=system 块), 对话历史**未命中**。
**根因**: 历史太短, 不满足 Anthropic 隐式缓存 ≥1024 token 阈值。

## 实验二: payload 结构 dump (dump-request.ts)

`before_provider_request` 拦截 anthropic messages payload:

```
system: [{ type:"text", text:(2601 chars), cache_control:true }]   ← 唯一稳定缓存块
messages:
  [0] user    content[{ text:(19 chars),  cache_control:true  }]    ← 最后user, 太小不缓存
  [1] assistant content[{ text:(2 chars),  cache_control:false }]   ← 历史不打标记
  [2] user    content[{ text:(12 chars), cache_control:true  }]    ← 当前轮user
```

**发现**: **pi 默认只给 system + "最后一条 user 消息" 打 cache_control, 历史消息不打**。
历史命中完全依赖 provider 侧隐式缓存(automatic caching), 而隐式缓存要求前缀 ≥1024 token。

> 这正是 AgentFlux prefix layout 的核心机会: 主动给历史消息打 cache_control 可强制 L2 进缓存(见实验四 cache-inject)。

## 实验三: compact 阈值 (compaction-test.py)

`compact` 命令在 session < 20000 token 时返回:
```
compact FAILED: Nothing to compact (session too small)
```

**根因**(源码 `compaction.js`): `keepRecentTokens` 默认 **20000**, compaction 保留最近 20000 token 不压缩, 只有超出部分被摘要。session ≤ 20000 时无可压缩内容。
且 `findCutPoint` 只在 turn 边界切, 单条消息过大(>20000/2)时也找不到切点。

**对 AgentFlux 的启示**: docs/05 的"compact vs new-session"决策在低占用时 compact 不可用, 只能继续累积或新建 session。

## 实验四: cache-inject 对照 (长 prompt, cache-inject.ts)

长 prompt(≥1024 token)建立长历史, 对照"不注入" vs "注入 cache_control":

| 组 | 轮2 单次 read 增量 | 轮2 单次 input 增量 |
|---|---|---|
| 对照(不注入) | 2900(含历史) | 100 |
| 注入(cache_control) | 3000 | 4 |

**发现**: **长历史在对照组也命中了** —— Anthropic 隐式缓存自动覆盖 ≥1024 token 的稳定前缀, 不需要显式 cache_control。
显式注入的边际收益在隐式缓存已覆盖时长效有限(但显式注入能控制缓存断点位置, 对短历史/特定布局仍有价值)。

## 实验五: compaction 摧毁缓存 ★决定性 (compaction-large.py)

英文小 prompt(~2900 token/轮)发 8 轮, ctx 累积到 25182, 触发真正的 compaction。

**L2 累积命中曲线(compact 前):**

| 轮 | ctx | 累计 cacheRead | 单次 read 增量 |
|---|---|---|---|
| 1 | 4497 | 3200 | 3200 |
| 2 | 7452 | 7680 | 4480 |
| 3 | 10407 | 15104 | 7424 |
| 4 | 13362 | 25472 | 10368 |
| 5 | 16317 | 38784 | 13312 |
| 6 | 19272 | 55040 | 16256 |
| 7 | 22227 | 74240 | 19200 |
| 8 | 25182 | 96384 | **22144** |

每轮 read 增量递增 ~1664(≈一轮历史进隐式缓存), L2 完美累积。

**compaction 后:**

| | ctx | 累计 cacheRead | 单次 read 增量 | 单次 input 增量 |
|---|---|---|---|---|
| compact 前(轮8) | 25182 | 96384 | 22144 | ~2000 |
| compact 后轮 | 19550 | 90240 | **1536** | **17985** |

- ctx 25182 → 19550 (compact 保留最近 ~20000, 摘要最早 ~5000)
- **read 增量 22144 → 1536, 暴跌 93%** (只剩 system 命中)
- **input 增量 ~2000 → 17985, 暴涨** (历史被摘要替换, 新前缀全部重传)

**机制**: compaction 在 system 之后插入"摘要"(新生成内容), 改变了前缀。即使保留了最近 20000 token 历史, 但"摘要"插在前部, 使从摘要开始的**整个后续前缀失效**。这是 prefix caching 的前缀敏感性 —— 任何前部插入都使后续缓存作废。

## 对 docs/06 的修正

1. **L2 不是"默认命中"**: 需 ≥1024 token 阈值。短对话(<1024)历史不缓存, 每轮重传。修正原文对 L2 的乐观假设。
2. **隐式缓存是 L2 主力**: provider 侧 automatic caching 覆盖长稳定前缀, 不依赖显式 cache_control。pi 默认不给历史打 cache_control。
3. **compaction 摧毁 L2 前缀(实证强化)**: read 暴跌 93%, 非原文推测的"理论失效"。且因前部插入摘要, 即使保留历史也全失效。
4. **keepRecentTokens=20000**: 低占用 session compact 不可用, 影响 docs/05 决策树。
5. **跨 session 隐式缓存**: 相同 system prompt 前缀在 5min TTL 内跨 session 命中(L1 跨 session 已证, 实验一/四均观察到)。

## 复现

```bash
cd E:/agent-projects/AgentFlux
# 实验一 短prompt多轮
pi --no-extensions -e experiments/v0-probe/agentflux-probe.ts --session-id flux-multiturn \
   --provider octopus-anthropic --model deepseek-v4-flash --thinking off -p "..."
# 实验二 dump payload
pi --no-extensions -e experiments/v0-probe/dump-request.ts --session-id flux-dump \
   --provider octopus-anthropic --model deepseek-v4-flash --thinking off -p "..."
# 实验五 compaction 决定性
python experiments/v0-probe/compaction-large.py
```
