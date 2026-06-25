# AgentFlux V0 Probe

最小验证扩展,验证 AgentFlux 的 4 个核心假设 + 两个新能力的最小形态。

## 验证了什么

| # | 假设 | 结果 |
|---|---|---|
| 1 | cache stats 能实时拿到 | ✅ `cacheRead=4096 input=96 cacheHitRate=97.7%` |
| 2 | telemetry 能沉淀 | ✅ `.agentflux/events.jsonl` (routing.decision + cache.sample) |
| 3 | TUI 能承载状态 | ✅ `setFooter`/`setStatus` API 正确(TUI 模式渲染,非 TUI 走 stderr+events) |
| 4 | event schema 稳定 | ✅ 字段完整,后续 Web 可直接消费 |
| 5 | 路由偏好(docs/13) | ✅ 读 `preference.profile`,footer 显示倾向落点 |
| 6 | 项目演进(docs/14) | ✅ git 信号 → stage/role,`project-profile.json` 持久化 |

### 关键实证:跨 session 前缀缓存真实存在

V0 运行命中 `cacheRead=4096`(system prompt 前缀),命中率 97.7%。该前缀由同中转/模型的早先会话写热。
这实证了 docs/06 的 **L1 稳定前缀跨 session 可缓存** 立论——AgentFlux 成本优化的基石成立。

## 怎么跑

```bash
# 进 AgentFlux 仓库
cd E:/agent-projects/AgentFlux

# 交互式(TUI,看 footer + /flux why overlay)
pi -e experiments/v0-probe/agentflux-probe.ts

# print 模式验证 telemetry(用支持 cache 的 provider)
pi -e experiments/v0-probe/agentflux-probe.ts \
   --provider octopus-anthropic --model deepseek-v4-flash \
   -p "说你好"

# 看结果
cat .agentflux/events.jsonl        # 事件流
cat .agentflux/project-profile.json # 项目成熟度
grep '\[flux\]' 2>&1               # stderr 实时统计
```

## 命令

- `/flux` — 当前状态摘要(mode/stage/role/pref/cache/context)
- `/flux why` — route inspector overlay(TUI)或 notify(非 TUI)

## 数据落点

```
.agentflux/
├── events.jsonl           # routing.decision + cache.sample, 每轮追加
├── agentflux.json         # 用户偏好(可选,缺省 balanced)
└── project-profile.json   # 项目成熟度(自动生成/更新)
```

## 已知限制(V0 → Phase 1)

1. **cost 恒 0**:models.json 未给 octopus 模型配 cost 字段。Phase 1 需补 model cost 配置才能做预算路由(docs/05 层2)。
2. **cacheWrite 恒 0**:中转做服务端长缓存(`supportsLongCacheRetention`),读命中时不报 write。cacheRead 是关键指标,够用。
3. **mode 恒 M2**:V0 没接路由器,模式是静态占位。Phase 1 接 docs/05 三层路由。
4. **maturity 仅 2 信号**:只有 file_count + commit_count。LOC/耦合度/依赖深度需 Phase 1 静态分析(docs/14)。
5. **偏好只读 profile**:没实现五维调音台和场景覆盖,那是 Phase 1 F1-10/F1-11(docs/13)。
6. **无 mask/fork**:B 维度 context 治理未实现,Phase 1 F1-3(docs/06)。

## 验证通过,可进入 Phase 1

V0 证明:pi extension 能捕获真实 cache 数据、telemetry 能持久化、event schema 可复用、两个新能力的最小形态可落地。

## 缓存机制深挖实验 (experiments/v0-probe/CACHE-FINDINGS.md)

V0 之后进一步实证了 docs/06 的三个核心论点(均可复现):

1. **L1 system prompt 显式缓存** ✅ — pi 给 system 打 cache_control, 稳定命中 1536 token
2. **L2 长历史(≥1024 token)隐式缓存累积命中** ✅ — 每轮 read 增量 3200→22144 递增
3. **compaction 摧毁 L2 缓存前缀** ✅ — compact 后 read 增量 22144→1536 暴跌 93%, input 暴涨

关键修正: L2 不是默认命中, 需 ≥1024 token 阈值; pi 默认不给历史打 cache_control(只给 system+最后user); AgentFlux 可通过 `before_provider_request` 主动注入(已验证 cache-inject.ts 可行)。

下一步按 docs/07 Phase 1 任务 F1-1~F1-13 工程化。
