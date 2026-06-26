# 20 - 实证数据与工程发现

> 本文档汇总 AgentFlux 在 pi 0.80.2 + octopus-anthropic (deepseek-v4-flash) 环境下的全部实验结论。
> 原 `experiments/v0-probe/` 目录中的 CACHE-FINDINGS.md 和 COST-CONCLUSIONS.md 内容已合并到本文档, 实验脚本已移除。
> 所有数据可复现 (复现脚本见 git 历史 commit 120b402, 2b0176a)。

---

## 一、缓存机制实证 (5 个实验)

### 实验 1: 短 prompt 多轮 — L2 不命中

| 轮 | 累计 input | 累计 cacheRead | 单次 read 增量 | hit rate |
|---|---|---|---|---|
| 1 | 1562 | 0 | 0 | 0% |
| 2 | 1607 | 1536 | 1536 | 49% |
| 3 | 1677 | 3072 | 1536 | 65% |

**结论**: 每轮 read 增量恒为 1536 (=system 块), 对话历史未命中。根因: 历史太短, 不满足 Anthropic 隐式缓存 ≥1024 token 阈值。

### 实验 2: payload 结构 dump — pi 的 cache_control 标记

`before_provider_request` 拦截 anthropic messages payload:

```
system: [{ type:"text", text:(2601 chars), cache_control:true }]   ← 唯一稳定缓存块
messages:
  [0] user    content[{ text:(19 chars),  cache_control:true  }]    ← 最后user, 太小不缓存
  [1] assistant content[{ text:(2 chars),  cache_control:false }]   ← 历史不打标记
  [2] user    content[{ text:(12 chars), cache_control:true  }]    ← 当前轮user
```

**结论**: pi 默认只给 system + 最后一条 user 消息打 cache_control, 历史消息不打。历史命中完全依赖 provider 侧隐式缓存 (automatic caching), 而隐式缓存要求前缀 ≥1024 token。AgentFlux 可通过 `before_provider_request` 主动给历史注入 cache_control 控制断点。

### 实验 3: compact 阈值 — 低占用不可用

`compact` 命令在 session < 20000 token 时返回 "Nothing to compact (session too small)"。

**根因** (源码 compaction.js): `keepRecentTokens` 默认 20000, `findCutPoint` 只在 turn 边界切, 单条消息过大时也找不到切点。中文文本因 2-3 token/char 比率更容易超限。

**影响**: docs/05 的 "compact vs new-session" 决策在低占用时 compact 不可用。

### 实验 4: cache-inject 对照 — 隐式缓存已覆盖长历史

长 prompt (≥1024 token) 建立长历史, 对照 "不注入" vs "注入 cache_control":

| 组 | 轮2 单次 read 增量 | 轮2 单次 input 增量 |
|---|---|---|
| 对照 (不注入) | 2900 (含历史) | 100 |
| 注入 (cache_control) | 3000 | 4 |

**结论**: 长历史在对照组也命中了 — Anthropic 隐式缓存自动覆盖 ≥1024 token 的稳定前缀。显式注入的边际收益在隐式缓存已覆盖时长效有限, 但显式注入能控制缓存断点位置。

### 实验 5: compaction 摧毁缓存 (决定性)

英文小 prompt (~2900 token/轮) 发 8 轮, ctx 累积到 25182, 触发真正的 compaction。

**L2 累积命中曲线 (compact 前):**

| 轮 | ctx | 累计 cacheRead | 单次 read 增量 |
|---|---|---|---|
| 1 | 4497 | 3200 | 3200 |
| 4 | 13362 | 25472 | 10368 |
| 8 | 25182 | 96384 | 22144 |

每轮 read 增量递增 ~1664 (≈一轮历史进隐式缓存), L2 完美累积。

**compaction 后:**

| | ctx | 累计 cacheRead | 单次 read 增量 | 单次 input 增量 |
|---|---|---|---|---|
| compact 前 (轮8) | 25182 | 96384 | 22144 | ~2000 |
| compact 后轮 | 19550 | 90240 | **1536** | **17985** |

- read 增量 22144→1536, **暴跌 93%** (只剩 system 命中)
- input 增量 ~2000→17985, **暴涨** (历史被摘要替换, 新前缀全部重传)
- 机制: compaction 在 system 之后插入摘要 (新生成内容), 改变前缀, 从摘要起的整个后续前缀失效

---

## 二、成本实验 (A/B/C)

> 基准模型: deepseek-v4-flash, 价格 (OpenRouter, $/token): input=9e-8, output=1.8e-7, cacheRead=2e-8
> 即缓存读 = input 的 22.2% (命中比全价便宜 77.8%)

### 实验 A: compaction 的美元代价

| 阶段 | input | cacheRead | 单轮成本 |
|---|---|---|---|
| compaction 前最后轮 | 25 | 28672 | $0.000576 |
| compaction 后第1轮 | 16519 | 1664 | $0.001525 |
| compaction 后第2轮 | 44 | 18176 | $0.000372 |

- compaction 后首轮成本 **2.65x**
- cacheRead 从 28672 暴跌到 1664 (**-94.2%**)
- input 从 25 暴涨到 16519 (**+65976%**)
- 第2轮起 cacheRead 恢复, 新前缀重建缓存后成本回落

### 实验 B: mask vs compact

| 路径 | 总成本 | 末轮成本 | compaction |
|---|---|---|---|
| compact | $0.004826 | $0.001530 (post-compact, 1.92x) | 触发 (39508→21304) |
| mask | $0.004101 | $0.000805 (正常命中) | 未触发 |

- mask 路径总成本比 compact **省 15.0%**
- mask 在本实验未真正触发 (纯文本 prompt 不产生 toolResult, mask 只对 toolResult 生效)
- mask 路径省的 15% 完全来自 "避免了 compaction", 而非 mask 本身

### 实验 C: prefix layout 长历史收益

**主进程单 agent 对照 (5 轮读文件):**

| 路径 | 累积 input | 累积 cacheRead | hit rate | 总成本 |
|---|---|---|---|---|
| naive (none) | 16449 | 11392 | 40.9% | $0.001765 |
| flux (static_first) | 15618 | 12288 | 44.0% | $0.001718 |

- flux 总成本比 naive **仅省 2.6%**
- 边际收益很小: 隐式缓存已覆盖长历史, 显式 cache_control 只是锦上添花
- 第4-5轮 cacheRead 都掉到 1664: 读文件产生的 toolResult 让 prefix 变化, 隐式缓存失效

**公平对照 (subagent 6 轮, 行为隔离):**

使用 `subagent-entry.ts` (只加载 prefix-layout, 不注册 flux_subagent tool), naive 和 agentflux subagent 均做 6 轮 (相同工作负载, 相同工具列表):

| 路径 | turns | input | cacheRead | hit rate | cost |
|---|---|---|---|---|---|
| naive (无前缀布局) | 6 | 10190 | — | 68.5% | $0.001467 |
| agentflux (有前缀布局) | 6 | 4454 | — | 81.7% | $0.000913 |

- agentflux prefix layout 在多轮 subagent 场景 **省 37.8%**
- input 减少 56% (10190→4454), hit rate 提升 13.2% (68.5%→81.7%)
- **prefix layout 的真实价值在 subagent 多轮 tool-call 场景, 不是单进程**

### 成本结论汇总

| 方向 | 价值 | 数据 |
|---|---|---|
| 避免 compaction | **最大** | 实验 A: 2.65x 成本炸弹; 实验 B: 避免省 15% |
| toolResult 管理 | **次大** | 实验 C: toolResult 是 prefix 破坏源 |
| prefix_layout (subagent) | **显著** | 公平对照: subagent 6轮省 37.8% |
| prefix_layout (主进程) | **边际** | 单进程 5轮仅省 2.6%, 隐式缓存已覆盖 |

---

## 三、工程发现与修复

### 1. contextPercent 刻度 Bug (已修复)

**现象**: mask 在 0.6% context 占用时就触发 (应为 60%); footer 显示 395% 而非 4%; 反推 contextWindow=10000 而非 1M。

**根因**: pi `getContextUsage().percent` 返回 0-100 刻度 (如 0.7079 = 0.7079%), 但 AgentFlux 代码当 0-1 fraction 用 (0.7079 = 70.79%)。导致:
- mask `shouldMask` 比较 `0.7079 >= 0.70` 为 true (在 0.7% 时触发)
- `pct()` helper 二次乘 100, 显示 395%
- 反推 7078/0.7079=9999 看起来像 contextWindow=10000

**修复**: `cache-monitor.ts` 中 `percent / 100` 归一化为 0-1。contextWindow 实际一直是 1M。

### 2. subagent entry.ts 行为差异 (已修复)

**现象**: 加载完整 entry.ts 的 subagent 完成任务只需 1-2 轮, naive subagent 需 5-6 轮, 导致成本对比不公平。

**根因**: entry.ts 通过 `pi.registerTool` 注册 flux_subagent 工具, 其 tool description 出现在 system prompt 中, 影响 LLM 行为 (更倾向于使用工具, 更快完成任务)。

**修复**: 创建 `src/subagent-entry.ts`, 只加载 prefix-layout + 轻量 telemetry, 不注册 flux_subagent tool 和 /flux 命令。naive 和 agentflux subagent 现在拥有相同的工具列表, 可公平对比。

### 3. mask 策略三个问题 (需重设计)

1. **mask 只对 toolResult 生效**: 纯 prompt 会话无 tool 调用, mask 从不激活, mask-vs-compact 对比无法进行
2. **单次 prefix 破坏代价不免费**: 在 deepseek-v4-flash (cacheRead = 22.2% input price) 上, mask 一次破坏 prefix 的代价超过减少 context 的节省
3. **1M 窗口下几乎不触发**: 85% 阈值需 ~850K token, 现实会话达不到

**重设计方向**: event-driven (按 toolResult 模式触发而非 context fill), batch-applied (一次性应用后让 cache 重建), model-aware (仅 cacheRead 折扣很低的模型值得用)

### 4. pi compaction 累计 token 机制

pi 的 per-message usage tokens 是累计 session 总量, 不是单轮值。compaction 后删除旧消息并重置 baseline, 导致累计差分法出现负 delta。

**修复**: `get_last_assistant_usage()` 直接读取最后一条 assistant 消息的单轮 usage (非累计), 用于跨 compaction 边界的 telemetry。

### 5. RPC stale ctx

RPC 模式 `new_session` 后, 旧 ExtensionRunner 被 invalidate, 旧 extension 的 context/before_provider_request handler 可能仍触发, 抛出 "ctx is stale" 错误。

**解决方案**: pi 提供 `withSession` API, `ctx.newSession/fork/switchSession` 接受回调, 在旧 session 完全关闭、新 session rebind 后才执行。AgentFlux entry.ts 需用 withSession 模式。临时 workaround: 用 `--session-id` 独立进程而非 new_session RPC 命令。

### 6. Windows 子进程 spawn

- 子进程必须用 `process.execPath` (node.exe) + `createRequire.resolve(cli.js)`, `shell:false`
- `shell:true` 导致 cmd.exe 分词非 ASCII 参数 (如中文任务文本)
- 子进程需要 `--approve` flag 才能执行工具 (否则 hang 在 toolcall_delta)
- `--session-id` 和 `--no-session` 互斥

---

## 四、对设计文档的修正索引

| 原文档 | 原论点 | 修正 |
|---|---|---|
| docs/06 | L2 "默认命中" | 需 ≥1024 token 阈值, 短对话不缓存 |
| docs/06 | 前缀布局是核心卖点 | 主进程边际 2.6%, subagent 多轮 37.8%, 价值在 subagent |
| docs/06 | mask 替代 compact | mask 需重设计 (见三.3), 当前只在推迟 compact 时有价值 |
| docs/07 | "成本 −60%" | 已移除, 改为实测降幅 (基准 deepseek-v4-flash, 价格层 docs/16) |
| docs/05 | override_mode suggest = 弹窗确认 | 已改为非侵入式 footer hint, 不打断交互 |
| docs/12 | SettingsList submenu | 改用 flat SelectList (Container 无 handleInput, submenu 委托失效) |

---

## 五、V0 Probe 历史

V0 probe (experiments/v0-probe/agentflux-probe.ts) 是 Phase 1 之前的单文件验证扩展, 验证了 4 个核心假设:

| # | 假设 | 结果 |
|---|---|---|
| 1 | cache stats 能实时拿到 | ✅ cacheRead=4096, cacheHitRate=97.7% |
| 2 | telemetry 能沉淀 | ✅ events.jsonl (routing.decision + cache.sample) |
| 3 | TUI 能承载状态 | ✅ setFooter API 正确 |
| 4 | event schema 稳定 | ✅ 字段完整, 后续 Web 可直接消费 |

V0 probe 已被模块化 src/entry.ts 完全取代, 实验脚本和结论已合并到本文档。原 experiments/v0-probe/ 目录已移除。
