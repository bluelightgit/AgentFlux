# AgentFlux Phase 1+2 — 实现进度

> Phase 1 目标(docs/07): 在 pi 上用前缀布局 + mask + cache 监控优化 subagent 流程成本。
> 实测结论: prefix layout 边际收益取决于场景 (主进程5轮仅2.6%, subagent6轮37.8%)。
> Phase 2: M3 fork + RGAO 复杂度路由 + subagent 精简入口。
> 技术栈: 纯 TypeScript(pi extension), 模块化 src/ 结构, pi 直接加载 entry.ts 无需构建。
>
> 成本基准: deepseek-v4-flash, 价格层见 docs/16。成本实验见 experiments/v0-probe/COST-CONCLUSIONS.md。

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

## Phase 2 已实现 (commit 5d774d6)

### RGAO 静态分析路由 (src/core/complexity.ts)
- 从 git ls-files + 简单正则提取代码复杂度信号 (零依赖)
- 信号: file_count, loc, dependency_depth, cross_module_coupling, symbol_density
- 复杂度等级 0-3 (FastPath/SubAgent/MultiAgent/DeepResearch) → recommendedMode
- 路由器 route() 接入 taskSignal, 推荐mode额外加权 0.3+tier*0.1
- 命令: /flux complexity 显示信号面板, /flux why 包含复杂度信号

### M3 对话树 fork (src/extension/fork-mode.ts)
- session_before_fork / session_before_tree 事件记录到 telemetry
- /flux fork 命令: 列出候选fork点 (最近5条用户消息), 从指定entry fork
- 用 pi ctx.fork(entryId) API, withSession 回调通知

### Subagent 精简入口 (src/subagent-entry.ts)
- 只加载 prefix-layout + 轻量 telemetry, 不注册 flux_subagent tool 和 /flux 命令
- 解决实验C暴露的问题: 完整entry.ts注册tool改变LLM工具列表, 导致行为差异
- 验证: naive和agentflux都做6轮(之前flux只做1轮), 公平对比 flux省37.8%

### Mask 刻度 Bug 修复 (commit d565eab)
- pi getContextUsage() 返回 percent 是 0-100 刻度, 但 mask.ts 当 0-1 用
- 导致 mask 在 0.7% 占用时就触发 (应为 70% 才触发)
- 修复: cache-monitor.ts 里 percent/100 归一化
- 之前误判 contextWindow=10000, 实际一直是 1M

## 下一步方向

按用户反馈, 从"省钱"转向"多模式 + 智能路由":
1. M2 subagent 完善: 更多 agent 定义 (tester, planner), 工作流预设
2. M3 fork 验证: 实际 fork 探索场景测试
3. 路由优化: file_count 只统计代码文件, 复杂度阈值调优
4. M4/M6 持久 team: 异构模型分工 (Phase 3)
5. F1-6 模式选择器 overlay, F1-11 偏好调音台 (TUI 交互验证)

## Phase 2: 模型能力层 + 多 agent 基础 (commit 557370a)

### 模型能力层 (src/core/model-capability.ts, docs/17)
- 5 维能力向量: coding/reasoning/speed/context/cost_eff
- 亲和度 = 加权点积 (requirement × capability)
- 四层降级: 用户手填 > 家族启发式 > 自动计算(context/cost) > 均值
- cost_eff 用 log scale 归一化, 避免极便宜模型在所有角色上全赢
- rankModels 排序 + cost_eff 破平局 (差值 < 0.05)
- assignModel 三路径: model 指定 / affinity 匹配 / single 退化

### 角色定义层 (src/core/role-manager.ts, docs/18)
- 角色定义来源: .agentflux/agents/*.md > models.json roles > 内置 4 模板
- MD frontmatter: name/description/tools/model/requirement/skills + body=systemPrompt
- 实例注册表: .agentflux/runtime/registry.json
- createInstance: 角色模板 → 运行时实例 (含模型分配详情)

### 共享黑板 (src/core/shared-board.ts, docs/19)
- .agentflux/shared/blackboard.json — 全局状态 (所有 agent 可读)
- tasks/ — 任务队列 (leader 分配, worker 认领)
- handoffs/ — 交接文档 (结构化, 不是塞对话历史)
- decisions/ — 决策记录 (append-only, 审计用)

### Team 命令 (src/extension/team.ts)
- /flux team status — 黑板 + 任务 + 实例状态
- /flux team plan <task> — 创建 planner 实例分析任务
- /flux team build <task> — 创建 implementer 实例执行任务
- /flux team review — 创建 reviewer 实例审查 git diff
- /flux team abort <name> — 终止实例
- /flux team roles — 列出所有角色定义
- /flux team models — 列出模型 + 能力向量
- /flux team affinity — 亲和度排名

### E2E 验证
- planner-1 (deepseek-v4-flash) 成功分析 model-capability.ts 代码结构
- handoff 写入 handoffs/planner-1→next.md
- blackboard 更新 planner-1 status=done
- registry.json 记录实例完成

### 已知限制
- /flux team 命令在 RPC/print 模式下不执行 (pi 限制), 需 TUI 交互模式
- 角色定义的 tools 过滤尚未接入子进程 (当前继承全部工具)
- skills 过滤尚未接入子进程 --skills 参数
- 亲和度匹配对 2 模型场景的区分度有限 (cost_eff log scale 已缓解)

## 基础功能完善 (commit 2f842af)

### F2-12 Git 统计信号 (complexity.ts)
- fileCount 修正: 只统计代码文件 (27), 不含 docs/markdown (之前 54 虚高)
- 新增 4 个 git 统计信号:
  - hotspotFiles: 30天内修改>3次的文件数 (4个)
  - recentCommits: 7天内提交数 (16)
  - testCoverageEstimate: 测试文件/源码文件比 (4%)
  - todoDensity: TODO/FIXME每千行 (3.2/kloc)
- 路由理由加入 git 信号补充 (如 "测试覆盖率低, 倾向加 tester")

### Skills 角色隔离 (subagent.ts)
- 角色有 skills 时: 用 `--skill <path>` 逐个传入子进程
- 无 skills 时: `--no-skills` 全部禁用 (保持原有行为)
- 支持 sharedSkills + role.skills 合并传递

### Cost 修复 (team.ts)
- TeamContext 加 pricing 字段
- runTeamAgent 传 pricing 到子进程, cost 从 $0 变为真实计算

### E2E 管道验证 (plan→build→review)
完整三阶段管道测试通过:

| Agent | turns | input | output | cacheRead | hit% | cost |
|---|---|---|---|---|---|---|
| planner | 2 | 3172 | 1050 | 3200 | 50% | $0.000538 |
| implementer | 2 | 181 | 336 | 5760 | 97% | $0.000192 |
| reviewer | 1 | 124 | 1733 | 4096 | 97% | $0.000405 |
| **TOTAL** | | | | | | **$0.001135** |

验证项:
- ✅ 3 实例 (planner-1/implementer-1/reviewer-1) 全部 status=done
- ✅ 3 handoff 文件正确生成
- ✅ blackboard 3 agent 状态更新
- ✅ registry.json 记录完整 (model/assignSource/status)
- ✅ telemetry 3 个 subagent.run 事件, cost 正确计算
- ✅ implementer/reviewer cache hit 97% (前缀布局 + subagent-entry.ts 生效)
- ✅ 亲和度匹配: 3 角色都通过 affinity 匹配到 deepseek-v4-flash
