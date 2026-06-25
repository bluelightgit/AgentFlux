# AgentFlux Phase 1 — 实现进度

> Phase 1 目标(docs/07): 在 pi 上用前缀布局 + mask + cache 监控把 subagent 流程成本砍 60%+。
> 技术栈: 纯 TypeScript(pi extension), 模块化 src/ 结构, pi 直接加载 entry.ts 无需构建。

## M1.1 已实现 (src/)

模块化架构, pi 通过 `-e src/entry.ts` 加载, 相对 import 正常解析(已验证)。

```
src/
├── core/
│   ├── types.ts        类型定义: 维度/模式/配置/偏好/成熟度/路由决策 (docs/02,03,04,13,14)
│   ├── config.ts       配置加载 + 优先级链 + 场景覆盖 + 软约束校验 (F1-1)
│   └── routing.ts      Phase 1 规则路由: 成熟度基线 + 偏好偏置 (docs/05,13,14)
├── telemetry/
│   └── events.ts       统一事件模型 + JSONL writer (F1-8)
├── extension/
│   ├── cache-monitor.ts    cache 累计 + context 占用采集 (F1-4)
│   ├── maturity.ts         git 信号 → stage/role + profile 持久化 (F1-12)
│   ├── footer.ts           TUI footer/status + 摘要/inspector 文本 (F1-5,10)
│   ├── prefix-layout.ts    before_provider_request 注入 cache_control (F1-2)
│   └── mask.ts             context 事件 mask 旧 tool result (F1-3)
└── entry.ts            主入口: 事件注册 + /flux 命令 (F1-9,13)
```

## 验证结果 (pi 0.80.2 + octopus-anthropic/deepseek-v4-flash)

| 任务 | 状态 | 验证证据 |
|---|---|---|
| F1-1 配置加载 | ✅ | loadConfig/loadPreference 合并默认, applyScenarioOverride 场景覆盖 |
| F1-2 前缀布局 | ✅ | 多轮对照: input 245→117(减半), hit 96%→98%, read 增量 +200 |
| F1-3 mask | ✅ | 3 toolResult 保留最近2, 最早替换占位符, 消息结构不变(5→5) |
| F1-4 cache 监控 | ✅ | cacheRead/cacheWrite/context% 实时采集, hit rate 计算 |
| F1-5 footer | ✅ | setFooter API 正确(左 cache/mode/ctx/$ + 右 stage/role/preset) |
| F1-8 telemetry | ✅ | routing.decision + cache.sample + context.event 写 events.jsonl |
| F1-9 route inspector | ✅ | buildInspectorText 生成, TUI overlay 代码完成 |
| F1-10 偏好落点 | ✅ | footer 显示 preset→expected, /flux preference 命令 |
| F1-12 项目成熟度 | ✅ | git file/commit → stage/role, project-profile.json 持久化 |
| F1-13 项目面板 | ✅ | /flux project 命令显示成熟度信号 + 跃迁阈值 |
| F1-7 subagent 适配 | ✅ | flux_subagent 工具, 子进程加载 entry.ts, telemetry subagent.run |
| F1-14 价格层 | ✅ | OpenRouter 远程+models.json 覆盖+兑底均值, cost 本地算 (token×单价), 见 docs/16 |

## 关键技术决策 (实证驱动)

1. **模块化 .ts 直接加载**: pi 支持 `-e src/entry.ts` + 相对 import, 无需构建步骤 (验证通过)
2. **前缀布局路径**: `before_provider_request` replace payload, 给历史末尾打 cache_control (CACHE-FINDINGS 实证)
3. **mask 触发条件**: context >= compaction_threshold - 0.10 (默认 60%), 低占用零成本 noop
4. **pi tool result 格式**: 独立消息 role="toolResult", 不在 user content block (dump 确认, mask 已适配)
5. **路由器展示优先**: Phase 1 路由计算 expected mode 并展示, 实际模式切换受限于已实现能力

## 待实现

| 任务 | 说明 | 依赖 |
|---|---|---|
| F1-6 模式选择器 | ctx.ui.custom overlay + SelectList (eco/balanced 切换) | TUI 验证 |
| F1-11 调音台 | SettingsList 五维滑块 + 场景覆盖 | TUI 验证 |

## F1-7 subagent 适配验证

naive vs agentflux 对照 (2轮 task: read README.md + 总结):

| 组 | turns | input | cacheRead | hit rate | cost |
|---|---|---|---|---|---|
| naive (无前缀布局) | 2 | 152 | 3200 | 95% | $0 |
| agentflux (有前缀布局) | 2 | 152 | 3200 | 95% | $0 |

两者相同, 符合预期 (CACHE-FINDINGS 实验四): 短2轮历史, 隐式缓存已覆盖 system L1 (1536/轮),
显式 cache_control 边际不显著。AgentFlux subagent 增量价值在:
  1. telemetry 可观测 (cacheRead/cost/turns 跟踪, subagent.run 事件)
  2. 统一前缀布局 (为长历史/跨调用场景准备)
  3. 路由决策 (何时用 subagent, Phase 2 静态路由接入)

### F1-14 价格层验证 (2026-06-25)

成本公式: cost = input×p_in + output×p_out + cacheRead×p_cacheRead + cacheWrite×p_cacheWrite
四层降级: models.json(用户) > OpenRouter远程(缓存24h) > 兑底均值(339模型均价)

| 验证点 | 结果 |
|---|---|
| OpenRouter 远程拉取 | ✅ 339 模型, 498KB |
| 模型名映射 | ✅ deepseek-v4-flash/glm-5.2/gpt-5.5/qwen3.7-max 全命中 |
| 价格本地算 | ✅ cost=$3.48e-5 (15in×9e-8 + 1664read×2e-8), 非 0 |
| 兑底均值 | ✅ 未知模型 → fallback, 339 模型均值 |

关键修正: docs/07 的“成本−60%”是借 librarian-demo 第三方锚点, 在用户 relay 下不可复现。
现改为以 deepseek-v4-flash 为基准 + 价格层实测降幅, 去掉伪常数。

关键技术决策 (Windows spawn 调试结论):
  - 子进程用 `node + require.resolve(cli.js)` shell:false, 避免 args 分词
  - 子进程需 --approve (tool 执行权限)
  - outputParts/stderrBuf 需在 Promise 外声明 (作用域)

## 用法

```bash
cd E:/agent-projects/AgentFlux
# 交互式 (TUI, footer + 命令)
pi -e src/entry.ts
# print 模式验证 telemetry
pi --no-extensions --no-skills --no-prompt-templates -e src/entry.ts \
   --provider octopus-anthropic --model deepseek-v4-flash --thinking off -p "..."
# 命令 (TUI/RPC 交互模式)
/flux                 # 状态摘要
/flux why             # route inspector
/flux mode eco        # 切换预设 (运行时覆盖)
/flux preference      # 偏好画像
/flux project         # 项目成熟度面板
```

## 配置 (.agentflux/agentflux.json, 可选)

```json
{
  "mode": "balanced",
  "cache": { "prefix_layout": "static_first", "target_hit_rate": 0.85 },
  "context": { "compaction_threshold": 0.70, "mask_strategy": "hide_tool_results", "mask_keep_last_n": 3 },
  "preference": {
    "profile": "balanced",
    "vector": { "cost_sensitivity": 0.5, "accuracy_priority": 0.6, "latency_priority": 0.4, "parallelism_willingness": 0.5, "multi_agent_willingness": 0.4 }
  }
}
```
