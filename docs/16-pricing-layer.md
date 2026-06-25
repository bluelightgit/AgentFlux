# 16 · 价格层 (F1-14)

> 成本是 Trilemma 三角的一角, 但之前 docs/07 的"成本−60%"借了第三方锚点 (librarian-demo, 别人的模型价格), 在用户的 relay 下不可复现. 价格层让成本可观测、可验证、可路由.

## 1. 问题: cost.total 不可靠

pi 的 per-message `usage.cost.total` 由上游 provider 返回. 实测用户的 octopus relay 返回 `cost.total = 0` (relay 不计费或不下发成本). 导致:

- `events.jsonl` 的 `costUsd` 恒为 0
- 降幅无从计算 (分子分母都是 0)
- Phase 3 ILP 目标函数 `min Σ cost` 无系数

**结论**: 不能依赖上游 cost, 必须 token 本地算.

## 2. 成本公式

```
单轮成本 = input × p_in + output × p_out + cacheRead × p_cacheRead + cacheWrite × p_cacheWrite
```

- `input/output/cacheRead/cacheWrite` 来自 pi `usage` (token 计数, 本地可得)
- `p_*` 是模型单价 ($/token), 来自价格层

**降幅** (naive vs flux):
```
reduction = (cost_naive − cost_flux) / cost_naive
```

### 官方价格比率一致假设

用户 relay (octopus) 是二次分发, 实际价格可能 ≠ 官方价. 但关键洞察: 降幅是**比值**, 若 relay 对所有单价乘统一系数 k, 则 k 在分子分母同时出现被约掉 → 官方价算出的降幅 == relay 真实降幅. **只有当 relay 对 input 和 cacheRead 用不同系数时** (如 input 打折、cacheRead 不打折), 官方价才算偏. 在"比率一致"假设下, 用官方价 (OpenRouter) 做成本验证是可行的.

## 3. 四层降级

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 (最高) | `.agentflux/models.json` | 用户手填 relay 真实价, 覆盖一切 |
| 2 | 远程价格源 (`source_url`) | 默认 OpenRouter, 缓存 `pricing-cache.json` (TTL 24h) |
| 3 (兜底) | 均值 | 未知模型用价格表内所有模型各单价均值 |
| — | `source_url` 可配置 | 后续 GitHub Action 产物替换, 不改代码 |

### 数据源策略 (用户决策 1)

当前: 运行时从 `source_url` (OpenRouter `GET /api/v1/models`) 拉取, 本地缓存.
未来: GitHub Action + 脚本定期生成 `pricing-latest.json`, 客户端拉 latest 更新. 避免代码写死 API 源, 有改动只需更新价格文件不需重新发版代码.

`source_url` 在 `.agentflux/agentflux.json` 的 `pricing.source_url` 配置, 后续指向 `raw.githubusercontent.com/.../pricing-latest.json`.

### 模型名映射 (用户决策 2)

relay 名通常是 `分组/模型名` (如 `oa/deepseek-v4-flash`). 映射逻辑:

1. 去常见二次分发前缀 (`oa/`, `flux/`, `relay/` 等)
2. 精确匹配 (`vendor/model`)
3. 模糊匹配 (key 的 model 部分 contains 候选)
4. 兜底均值

实测 octopus relay 模型全部命中 OpenRouter:

| relay 名 | OpenRouter id | 命中 |
|---|---|---|
| `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | ✅ |
| `glm-5.2` | `z-ai/glm-5.2` | ✅ |
| `gpt-5.5` | `openai/gpt-5.5` | ✅ |
| `qwen3.7-max` | `qwen/qwen3.7-max` | ✅ |

### 兜底均值 (用户决策 3)

新模型完全匹配不到时, 用价格表内所有模型各单价的**均值** (非零值均值), 而非写死权重表. 优点:
- 随价格源更新自动演进
- 对新模型是合理的中位估计

实测: `oa/some-future-model-2027` → `source=fallback`, in=2.35e-6 out=1.06e-5 cacheRead=3.16e-7 (339 模型均值).

## 4. 归一化 (兼容多源格式)

`normalizeAny()` 自动识别:
- OpenRouter: `{data:[{id, pricing:{prompt, completion, input_cache_read, input_cache_write}}]}`
- 未来价格文件: `{models:[{id, input, output, cacheRead, cacheWrite}]}` 或 `{[id]:{...}}`

切换数据源只需数据源侧适配格式, `pricing.ts` 不改.

## 5. 实现位置

- `src/core/pricing.ts` — 核心价格层 (loadPricing / lookupPrice / calcCost)
- `src/core/types.ts` — `FluxConfig.pricing: PricingConfig`
- `src/extension/cache-monitor.ts` — `collectCacheStats(ctx, pricing?)` 逐条按 `message.model` 查价
- `src/extension/subagent.ts` — `runSubagent({pricing?})` 父进程重算子进程 cost
- `src/entry.ts` — `session_start` 加载 `pricingTable`, 传入 cache-monitor/subagent

## 6. 验证结果 (2026-06-25)

| 验证点 | 结果 |
|---|---|
| OpenRouter 远程拉取 | ✅ 339 模型, 498KB, 缓存 77KB |
| 模型名映射 | ✅ 4 个 relay 模型全部命中 |
| 价格本地算 | ✅ `cost=$0.00003481` (15in×9e-8 + 1664read×2e-8), 非 0 |
| 兜底均值 | ✅ 未知模型 → fallback, 339 模型均值 |
| 缓存 TTL | ✅ `pricing-cache.json` 24h 复用 |
| 显示精度 | ✅ `fmtCost`: 极低科学计数 ($4.65e-5), 低 6 位, 高 4 位 |

## 7. 下游影响

- **Phase 1 验证指标**: 以 deepseek-v4-flash 为基准, 实测 AgentFlux vs naive 真实成本降幅 (依赖本层). 60% 伪常数已移除 (docs/07).
- **Phase 3 ILP (BAMAS)**: 目标函数 `min Σ cost` 的系数 = 模型单价, 本层提供.
- **M6 异构路由**: 不同模型 cost 对比依赖本层, 逐条 message 按 model 查价支持混模型.
- **GitHub Action 分发**: 后续 `source_url` 指向仓库生成的 `pricing-latest.json`, 客户端零代码改动.
