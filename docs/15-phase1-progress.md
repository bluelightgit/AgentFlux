# AgentFlux Phase 1+2 — 实现进度

> Phase 1 目标(docs/07): 在 pi 上用前缀布局 + mask + cache 监控优化 subagent 流程成本。
> 实测结论: prefix layout 边际收益取决于场景 (主进程5轮仅2.6%, subagent6轮37.8%)。
> Phase 2: M3 fork + RGAO 复杂度路由 + 模型能力层 + 多 agent 架构 + team 管道。
> 技术栈: 纯 TypeScript(pi extension), 模块化 src/ 结构, pi 直接加载 entry.ts 无需构建。
>
> 成本基准: deepseek-v4-flash, 价格层见 docs/16。成本实验见 docs/20 实证数据。
> **战略转向**: 核心价值是多模式智能路由, 不是成本优化 (见 docs/07 战略转向节)。

## M1.1 已实现 (src/)

模块化架构, pi 通过 `-e src/entry.ts` 加载, 相对 import 正常解析(已验证)。

```
src/
├── core/
│   ├── types.ts        类型定义: 维度/模式/配置/偏好/成熟度/路由决策 (docs/02,03,04,13,14)
│   ├── config.ts       配置加载 + 优先级链 + 场景覆盖 + 软约束校验 + savePreference (F1-1)
│   ├── routing.ts      Phase 1 规则路由: 成熟度基线 + 偏好偏置 + 复杂度信号 (docs/05,13,14)
│   ├── pricing.ts      价格层: OpenRouter + models.json + 兑底均值 (F1-14, docs/16)
│   ├── complexity.ts   RGAO 静态分析: git churn + import graph + 复杂度等级 (F2-3,12)
│   ├── model-capability.ts  模型能力向量 + 亲和度匹配 (F2-4, docs/17)
│   ├── role-manager.ts      角色定义 + 内置模板 + 实例注册表 (F2-5, docs/18)
│   └── shared-board.ts      共享黑板: tasks/handoffs/decisions (F2-6, docs/19)
├── telemetry/
│   └── events.ts       统一事件模型 + JSONL writer (F1-8)
├── extension/
│   ├── cache-monitor.ts    cache 累计 + context 占用采集 + percent/100 归一化 (F1-4)
│   ├── maturity.ts         git 信号 → stage/role + profile 持久化 (F1-12)
│   ├── footer.ts           TUI footer (setFooter only, setStatus 已弃用) + 摘要/inspector (F1-5,10)
│   ├── prefix-layout.ts    before_provider_request 注入 cache_control (F1-2)
│   ├── mask.ts             context 事件 mask 旧 tool result (F1-3, 需重设计)
│   ├── fork-mode.ts        M3 对话树 fork + fork merge 指导 (F2-1,2)
│   ├── compaction-advisor.ts  B 维度自适应: session_before_compact 拦截 (F2-11)
│   ├── flux-menu.ts        全宽 /flux 菜单: flat SelectList + 进度条调音台 (F1-6,11)
│   └── team.ts             /flux team 命令 + M5 管道 handoff 链 (F2-7,8)
├── subagent-entry.ts   行为隔离的 subagent 入口 (不注册 flux_subagent tool)
└── entry.ts            主入口: 事件注册 + /flux 命令 + 路由 + TUI菜单 (F1-9,13)
```

## Phase 1 验证结果 (14/14 ✅)

| 任务 | 状态 | 验证证据 |
|---|---|---|
| F1-1 配置加载 | ✅ | loadConfig/loadPreference 合并默认, applyScenarioOverride 场景覆盖 |
| F1-2 前缀布局 | ✅ | subagent 6轮公平对照: input 减半, hit 68.5%→81.7%, 省 37.8% |
| F1-3 mask | ✅ (需重设计) | 功能实现, 但实测发现三个问题, 见 docs/20 三.3 |
| F1-4 cache 监控 | ✅ | cacheRead/cacheWrite/context% 实时采集, percent/100 归一化修复 |
| F1-5 footer | ✅ | setFooter (setStatus 已弃用: 创建无法消除的持久栏) |
| F1-6 模式选择器 | ✅ | flat SelectList 全宽菜单 (非 SettingsList submenu, 见 TUI 修复) |
| F1-7 subagent 适配 | ✅ | flux_subagent 工具, 子进程加载 subagent-entry.ts, telemetry |
| F1-8 telemetry | ✅ | routing.decision + cache.sample + subagent.run 写 events.jsonl |
| F1-9 route inspector | ✅ | /flux why 文本展示, /flux 菜单信息项 |
| F1-10 偏好落点 | ✅ | footer 显示 preset→expected |
| F1-11 调音台 | ✅ | 进度条 + ←→ 调整 + 实时保存 (非 SettingsList, 自定义 Component) |
| F1-12 项目成熟度 | ✅ | git file/commit → stage/role, project-profile.json |
| F1-13 项目面板 | ✅ | /flux project + /flux 菜单信息项 |
| F1-14 价格层 | ✅ | OpenRouter 远程 + models.json + 兑底均值, 见 docs/16 |

## 关键技术决策 (实证驱动)

1. **模块化 .ts 直接加载**: pi 支持 `-e src/entry.ts` + 相对 import, 无需构建步骤
2. **前缀布局路径**: `before_provider_request` replace payload, 给历史末尾打 cache_control
3. **mask 触发条件**: context >= compaction_threshold - 0.10 (默认 60%), 低占用零成本 noop — 但需重设计 (docs/20 三.3)
4. **pi tool result 格式**: 独立消息 role="toolResult", 不在 user content block
5. **路由器展示优先**: Phase 1 路由计算 expected mode 并展示, 实际模式切换受限于已实现能力
6. **percent 刻度归一化**: pi 返回 0-100, AgentFlux 统一 /100 转为 0-1 (曾导致 mask 0.6% 触发 + 显示 395%)
7. **subagent 行为隔离**: subagent-entry.ts 不注册 flux_subagent tool, 避免 tool description 改变 LLM 行为
8. **TUI flat SelectList**: 不用 SettingsList submenu (Container 无 handleInput, submenu 委托失效), 改用 ctx.ui.custom + SelectList (参考 pi preset.ts)
9. **setStatus 弃用**: setStatus 创建无法消除的持久状态栏, 改用 setFooter 显示所有状态
10. **override_mode 非侵入式**: 路由建议用 footer hint 小字显示, 不用弹窗 (弹窗打断菜单操作)
11. **cost_eff log scale**: 线性映射 (1.0→0.1) 在 2 模型时差距太大, 改用 log scale (0.85→0.25)
12. **git churn 复杂度**: 用 `git log --numstat` 替代硬编码后缀, 黑名单策略排除非代码文件

## 待实现

Phase 1: 14/14 ✅ 全部完成 (含 F1-6/F1-11 TUI 交互已实现)
Phase 2: 12/12 ✅ 全部完成

## F1-7 subagent 适配验证

naive vs agentflux 对照 (2轮 task: read README.md + 总结):

| 组 | turns | input | cacheRead | hit rate | cost |
|---|---|---|---|---|---|
| naive (无前缀布局) | 2 | 152 | 3200 | 95% | $0 |
| agentflux (有前缀布局) | 2 | 152 | 3200 | 95% | $0 |

两者相同, 符合预期 (docs/20 实验四): 短2轮历史, 隐式缓存已覆盖 system L1 (1536/轮),
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
cd <agentflux-dir>
# 交互式 (TUI, footer + 命令)
pi -e src/entry.ts --provider <your-provider> --model <your-model>
# print 模式验证 telemetry
pi --no-extensions --no-skills --no-prompt-templates -e src/entry.ts \
   --provider <your-provider> --model <your-model> --thinking off -p "..."
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

## 基础功能完整 (commit 07c1b47)

### Git Churn 复杂度检测 (complexity.ts 重写)
- 用 `git log --numstat` 替代硬编码后缀, 黑名单策略排除非代码文件
- fileCount: 53(含docs) → 27(纯代码) 更准确
- 新增 totalChurn, topChurnFiles (churn最高的5个文件)
- 基于 Michael Feathers 的 Churn × Complexity = Hotspots 方法论

### M5 管道 Handoff 链 (team.ts)
- `/flux team build` 自动查找最近 planner handoff 拼接到任务前
- `/flux team review` 自动查找最近 implementer handoff + git diff
- `/flux team pipeline <task>` 一键执行 plan→build→review 全链路
- E2E 验证: build 拼接了 planner handoff (1960 chars), review 拼接了 implementer handoff (3409 chars)

### B 维度 Compaction 自适应 (compaction-advisor.ts, F2-11)
- session_before_compact 事件拦截, 5级建议:
  - allow: 上下文 <60%, 正常放行
  - suggest_mask: 60-85% + toolResult >10, 建议 mask 保 prefix
  - suggest_fork: 60-85% + 轮次 >15, 建议 fork 新分支
  - force_compact: >85%, 必须 compact
- `/flux compact` 命令显示当前建议
- 当前只建议不拦截, Phase 3 接入自动决策

### Fork Merge (fork-mode.ts)
- `/flux fork merge` 显示合并策略说明
- 自动 merge 在 Phase 3 实现 (需要 LLM 合并两分支输出)

### Tools 白名单验证
- `--tools "read,ls"` 正确限制子进程工具: LLM 报告"没有 bash 工具可用"
- 角色工具隔离 (planner 只读, implementer 可写) 可用

### TUI 菜单重写 (flux-menu.ts)

**问题**: 原 /flux 菜单用 SettingsList submenu, 但 Container 类没有 handleInput 方法, 导致 Mode 子菜单卡住无法操作。setStatus 创建无法消除的持久状态栏。override_mode 弹窗打断菜单交互。

**修复**: 
- 改用 flat SelectList 模式 (参考 pi preset.ts), 每个菜单独立 ctx.ui.custom() overlay
- 主题通过 closure 捕获传递给子菜单组件
- setStatus 弃用, 所有状态走 setFooter
- override_mode suggest 改为非侵入式 footer hint (路由建议小字显示在 footer)
- 信息类选项 (Project/Complexity/Compaction/Route) 选择后通过 ctx.ui.notify 显示在对话栏并立即退出菜单
- 全英文 TUI 文本

### Phase 2 完成状态: 12/12 ✅

| 任务 | 状态 | 说明 |
|---|---|---|
| F2-1 M3 fork | ✅ | fork-mode.ts, ctx.fork() + withSession |
| F2-2 fork merge | ✅ | 信息性指导, 自动 merge 延至 Phase 3 |
| F2-3 静态路由 | ✅ | complexity.ts, git churn + import graph |
| F2-4 模型能力 | ✅ | model-capability.ts, 5维向量 + 亲和度 |
| F2-5 角色定义 | ✅ | role-manager.ts, JSON/MD + 4内置模板 |
| F2-6 共享黑板 | ✅ | shared-board.ts, tasks/handoffs/decisions |
| F2-7 team 命令 | ✅ | team.ts, 8个子命令 |
| F2-8 M5 管道 | ✅ | handoff 自动链, plan→build→review |
| F2-9 Level 2 开关 | ✅ | 配置层 + 软约束校验 |
| F2-10 override suggest | ✅ | 非侵入式 footer hint (非弹窗) |
| F2-11 B 维度自适应 | ✅ | compaction-advisor.ts, 5级建议 |
| F2-12 git 统计信号 | ✅ | hotspot/recent/testCov/todo + git churn |

---

## Phase 2.5: 模式执行能力补全 (进行中)

> 战略调整 (2026-07): 先把 M2-M5 执行能力做扎实, 再做智能路由。详见 [docs/22](22-mode-capability-roadmap.md)。

### 当前模式执行能力差距

| 模式 | 路由器能选 | 实际执行能力 | 差距 |
|---|---|---|---|
| M1 单 agent | ✅ | ✅ pi 原生 | 无 |
| M2 主+subagent | ✅ | ⚠️ 基础 | 串行、不持久、无并行、无质量门 |
| M3 对话树 fork | ✅ | ⚠️ 基础 | merge 手动、无 A/B 自动比较 |
| M4 持久 multi-agent | ✅ | ❌ 几乎没有 | team 命令只是串行临时 subagent |
| M5 管道 handoff | ✅ | ⚠️ 刚性 | 硬编码三步、无条件分支/并行/重试 |
| M6 异构团队 | ✅ | ❌ 空白 | Phase 3 |

### Phase 2.5 任务清单

#### M2 增强: subagent 能力补全

| 任务 | 状态 | 说明 |
|---|---|---|
| M2-1 并行 subagent | ✅ | `runSubagentsParallel` + `flux_subagent_parallel` 工具, 实测 1.80x 加速 |
| M2-2 subagent 持久化 | ✅ | `persistent` + `sessionDir` 参数, `--session-id` 替代 `--no-session`, 实测 cache hit 99% |
| M2-3 工具白名单执行 | ✅ | `--tools` 参数验证: read-only agent 无法写入, bash agent 可执行命令 |
| M2-4 reasoning effort 传递 | ✅ | `--thinking` 参数按角色/调用配置, 内置角色 planner/reviewer=high, implementer=medium |
| M2-5 subagent 结果质量检查 | ✅ | `quality-gate.ts`: LLM 检查产出是否满足 criteria, 通过/失败+反馈, 实测 $0.0001/次 |

#### M3 增强: 对话树 fork 工作流

| 任务 | 状态 | 说明 |
|---|---|---|
| M3-1 fork 工作流封装 | ✅ | `/flux fork explore <task>` 一键 fork A/B, fork-workflow.ts |
| M3-2 fork 结果比较 | ✅ | `compareAndMergeForks()` LLM 对比两分支输出, 推荐胜者 |
| M3-3 fork merge 自动化 | ✅ | LLM 合并最佳部分, 注入当前分支 via appendEntry |
| M3-4 fork prune | ✅ | `/flux fork prune <A|B|id>` 标记分支为 pruned + 记录原因 |

#### M4 实现: 持久 multi-agent (从零搭建)

| 任务 | 状态 | 说明 |
|---|---|---|
| M4-1 持久 session subagent | ✅ | `runPersistentAgent()`: 持久 session + 注册表, 实测跨调用 cache hit 97% |
| M4-2 agent 间消息传递 | ✅ | SharedBoard `messages/` 目录, sendMessage/getInbox/getUnreadMessages/markRead |
| M4-3 任务队列消费 | ✅ | `claimNextTask()` + `consumeNextTask()`: agent 主动认领就绪任务 |
| M4-4 agent 状态同步 | ✅ | `completeTask()` 更新状态 + 解锁依赖任务 + 广播通知 |
| M4-5 持久 reviewer 甜区 | ✅ | 同一 reviewer 跨 2 次调用保留 session, callCount=2, cache hit 97% |

#### M5 增强: 管道柔性化

| 任务 | 状态 | 说明 |
|---|---|---|
| M5-1 动态任务分解 | ✅ | `generateTaskDAG()`: planner 输出结构化任务 DAG (JSON), 实测 3 节点 |
| M5-2 DAG 执行器 | ✅ | `executeDAG()`: 拓扑序执行, 独立节点并行, 2 节点 DAG 全通过 |
| M5-3 条件分支 | ✅ | reviewer 失败 → 重跑 implementer, 实测验证 |
| M5-4 质量门 | ✅ | acceptance criteria 检查 + 自动重试, t2 首次失败重试后通过 |
| M5-5 管道中断/恢复 | ✅ | `dag-state.json` 保存执行状态到黑板 |

### Phase 3: 异构 + 智能路由

#### F3-1/F3-2: M6 异构团队 + 任务级路由

| 任务 | 状态 | 说明 |
|---|---|---|
| F3-1 M6 异构团队 | ✅ | per-agent model config + thinking, `executeHeterogeneousTeam()` 拓扑序异构执行 + 成本对比 |
| F3-2 任务级路由 | ✅ | `classifyTask()` + `analyzeTaskScope()` (git diff) + `computeTaskComplexity()` + `route()` 集成 |
| F3-3 反馈闭环 | ✅ | `ExperienceStore`: record/querySimilar/suggest/importFromTelemetry, 统计版 "穷人 RL" |
| F3-4 step-level model routing | ✅ | `selectModelForStep()`: 按步骤复杂度选 model + thinking, 预算约束降级 |
| F3-8 override_mode: auto | ✅ | `route()` 集成 overrideMode + experienceRecommendation, auto 模式高置信度经验直接覆盖 |
