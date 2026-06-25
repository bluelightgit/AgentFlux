# AgentFlux 成本实验结论 (A/B/C)

> 基准模型: deepseek-v4-flash (octopus-anthropic)
> 价格 (OpenRouter, $/token): input=9e-8, output=1.8e-7, cacheRead=2e-8, cacheWrite=0
> 即缓存读 = input 的 22.2% (命中比全价便宜 77.8%)
> 日期: 2026-06-25

## 总览

| 实验 | 核心问题 | 关键结论 |
|---|---|---|
| A | compaction 的美元代价 | compaction 后单轮成本 **2.65x**, cacheRead 暴跌 94%, input 暴涨 |
| B | mask vs compact 谁省 | 避免一次 compaction 省 **15%**; mask 在大窗口下难触发 |
| C | prefix layout 长历史收益 | 显式前缀布局边际收益 **仅 2.6%**, 隐式缓存已覆盖 |

## 实验 A: compaction 成本惩罚

**方法**: 塞满 session > 24000 token 触发 compaction, 对比 compaction 前后单轮成本.

| 阶段 | input | cacheRead | 单轮成本 |
|---|---|---|---|
| compaction 前最后轮 | 25 | 28672 | $0.000576 |
| compaction 后第1轮 | 16519 | 1664 | $0.001525 |
| compaction 后第2轮 | 44 | 18176 | $0.000372 |

**关键发现**:
- compaction 后首轮成本 **2.65x** ($0.000576 → $0.001525)
- cacheRead 从 28672 暴跌到 1664 (**-94.2%**), 只剩 system 块缓存
- input 从 25 暴涨到 16519 (**+65976%**), 整个新前缀 (system+summary+recent) 全价重传
- 缓存丧失代价: 27008 token 从缓存价→全价, 每轮多付 $0.001891
- **第2轮起 cacheRead 恢复到 18176**, 说明新前缀重建缓存后成本回落

**结论**: compaction 是"一次性大破坏", 首轮惩罚严重但后续恢复. 这是 AgentFlux mask/handoff 策略的核心价值锚点——**避免 compaction 就能避免这个 2.65x 炸弹**.

## 实验 B: mask vs compact

**方法**: 两条路径各 8 轮长 prompt, compact 路径第7轮后触发 compaction, mask 路径不 compact.

| 路径 | 总成本 | 末轮成本 | compaction |
|---|---|---|---|
| compact | $0.004826 | $0.001530 (post-compact, 1.92x) | 触发 (39508→21304) |
| mask | $0.004101 | $0.000805 (正常命中) | 未触发 |

**关键发现**:
- mask 路径总成本比 compact **省 15.0%** ($0.004101 vs $0.004826)
- compact 路径的惩罚全来自 compaction 那一轮 (1.92x), 其余 7 轮两路径完全相同
- **mask 在本实验未真正触发** (纯文本 prompt 不产生 toolResult, mask 只对 toolResult 生效)
- mask 路径省的 15% 完全来自"避免了 compaction", 而非 mask 本身

**重要工程发现**:
1. **contextWindow 实际 1M** (模型注册表), 但 pi RPC `get_session_stats` 的 `contextUsage.percent` 在 new_session 后读取异常 (脚本读到 0.7079, 实际应 0.007)
2. **mask 在 1M 大窗口下极难自然触发** (需 ~800K token 才到 85% 阈值)
3. **pi RPC `new_session` 后 context 事件有 stale ctx 竞态**: `extension_error: ctx is stale after session replacement`. 不发 new_session (用 `--session-id` 独立进程) 可规避
4. **mask 的单次破坏代价不免费**: 早先实验 (低阈值强制触发) 显示 mask 破坏 prefix 后单轮成本反超 compact, 说明 mask 只在"推迟 compaction"时才划算

**结论**: mask 的真正价值是**推迟 compaction**, 而非替代. 在 compaction 即将发生时用 mask 压缩旧 toolResult, 用一次小破坏换避免一次 2.65x 大破坏. 但 mask 触发条件 (基于 contextPercent) 在大窗口下需重新校准——当前 `compaction_threshold - 0.10` 在 1M 窗口下几乎不会触发.

## 实验 C: prefix layout 长历史收益

**方法**: 两条独立进程, 相同 5 轮读文件 task, 对比有/无 `prefix_layout=static_first`.

| 路径 | 累积 input | 累积 cacheRead | hit rate | 总成本 |
|---|---|---|---|---|
| naive (none) | 16449 | 11392 | 40.9% | $0.001765 |
| flux (static_first) | 15618 | 12288 | 44.0% | $0.001718 |

**关键发现**:
- flux 总成本比 naive **省 2.6%** ($0.001718 vs $0.001765)
- flux cacheRead 多命中 896 token (12288 vs 11392)
- **边际收益很小**: 与之前短历史实验 (2 轮, hit 95% vs 95%, 无差异) 一致
- **第4-5轮 cacheRead 都掉到 1664**: 读文件产生的 toolResult 让 prefix 变化, 隐式缓存失效. 两路径都受影响, 显式 prefix_layout 无法挽回

**结论**: 显式 prefix_layout (注入 cache_control) 在 deepseek-v4-flash + octopus-anthropic 下边际收益 <3%. 原因: **隐式缓存已覆盖长历史** (≥1024 token 自动缓存), 显式 cache_control 只是锦上添花. 这与 CACHE-FINDINGS 实验四一致.

## 核心结论: AgentFlux 的成本价值在哪里?

### ✅ 有显著价值的方向

1. **避免 compaction (最大价值)**
   - 实验 A: compaction 首轮 2.65x 成本炸弹
   - 实验 B: 避免 compaction 省 15%
   - **AgentFlux 应优先用 handoff (B3) 或 fork-prune (B4) 替代 compact (B1)**
   - 这是 AgentFlux 不可替代的成本杠杆

2. **toolResult 管理 (次大价值)**
   - 实验 C: toolResult 是 prefix 破坏源 (第4-5轮 cacheRead 掉到 1664)
   - mask 策略对 toolResult 有效, 但触发条件需优化
   - **AgentFlux 应改进 mask: 不依赖 contextPercent, 而是按 toolResult 数量/年龄主动管理**

### ⚠️ 边际价值的方向

3. **prefix_layout (显式 cache_control)**
   - 实验 C: 仅省 2.6%, 隐式缓存已覆盖
   - **保留但不是核心卖点**, 在某些 provider (不给隐式缓存) 下可能更有价值

### ❌ 已排除的方向

4. **"naive vs agentflux subagent 成本对比"**
   - subagent 加载 entry.ts 会改变 LLM 行为 (task 完成轮次不同), 无法公平对比
   - subagent 的增量价值在 telemetry 可观测, 不在成本

## 对 Phase 1 指标的修正

原 docs/07: "成本 -60%" (第三方锚点, 不可复现)
实测结论: **AgentFlux 的真实降本点是避免 compaction (单次 2.65x) 和管理 toolResult, 而非 prefix_layout 的边际优化**.

建议指标:
- compaction 发生率: AgentFlux 会话 < naive (目标: 长会话 compaction 次数减半)
- toolResult mask 后 cacheRead 保持率: > 60% (避免掉到 system-only 的 1664)
- prefix_layout 边际收益: 2-3% (已验证, 保留但不作为核心 KPI)

## 待解决的工程问题

1. **pi RPC `new_session` 后 context 事件 stale ctx**: entry.ts 需修复, 或文档说明 RPC 模式用 `--session-id` 独立进程而非 new_session
2. **mask 触发条件在 1M 窗口失效**: `compaction_threshold - 0.10` 需改为基于 token 绝对值或 toolResult 数量
3. **contextPercent 读取异常**: stats 的 percent 在 RPC new_session 后不准, 需用 ctx tokens / contextWindow 自算
4. **subagent entry.ts 副作用**: 加载 entry.ts 改变 system prompt 影响 LLM 行为, 需隔离 AgentFlux 逻辑与 task 执行
