# AgentFlux 自维护机制设计

> 设计日期: 2026-06-28
> 目标: 让 AgentFlux 具备运行时自诊断、状态查询、自重启、升级检测能力

## 1. 设计约束

### 1.1 pi 扩展运行模型
- AgentFlux 作为 pi 扩展运行在 pi 进程内部，无法真正"重启进程"
- "自重启"= 重新执行 session_start 初始化序列 (重载 config/pricing/roles/models，重置内存状态)
- 扩展代码通过 tsx 直接从源码加载，无编译步骤 → "升级"= git pull + 建议用户重启 pi

### 1.2 不能做的事
- 不能 fork/spawn 新 pi 进程替代自己
- 不能动态卸载/重载 entry.ts 模块 (Node.js ESM 无 unloading)
- 不能修改 pi 自身的运行时状态 (turn index, session file 等)

### 1.3 能做的事
- 重新读取磁盘配置文件 (config, models.json, agentflux.json)
- 重新初始化内存状态 (pricing table, complexity signal, roles)
- 重新运行 router
- 清理运行时缓存文件 (pricing-cache.json, dag-state.json)
- 执行 git 命令检查更新
- 扫描 telemetry 发现错误模式

## 2. 功能设计

### 2.1 `/flux status` — 全状态查询

一键显示 AgentFlux 所有子系统当前状态:

```
AgentFlux Status
═══════════════════════════════════════════════════
Version       0.1.0 · git c31029b (clean)
Mode          M2 · preset balanced · stage Growth
Session       turn 15 · cache hit 87% · cost $0.0234

Subsystems:
  ✅ config         .agentflux/agentflux.json
  ✅ pricing        341 models (remote, 24h cache)
  ✅ models.json    2 models, 0 roles
  ✅ roles          4 builtin (planner/impl/reviewer/tester)
  ✅ telemetry      459 events in events.jsonl
  ✅ shared-board   2 agents, 4 messages
  ⚠️ experience     0 records (cold start)
  ✅ runtime/       3 files (dag-state, persistent-agents, sessions/)

Active Agents:
  (none active)

Recent Issues (last 20 events):
  (none)
```

### 2.2 `/flux health` — 健康检查

主动诊断每个子系统是否正常工作:

```
AgentFlux Health Check
═══════════════════════════════════════════════════
[1/10] Config...                  ✅ agentflux.json parsed
[2/10] models.json...             ✅ models/roles parsed
[3/10] Pricing...                 ✅ cache current
[4/10] Telemetry...               ✅ writable
[5/10] SharedBoard...             ✅ all dirs exist
[6/10] ExperienceStore...         ⚠️ empty (cold start, not an error)
[7/10] Runtime...                 ✅ runtime files readable
[8/10] Git...                     ⚠️ working tree dirty
[9/10] Models...                  ✅ telemetry models known
[10/10] Retention...              ✅ auto GC enabled; terminal=3, read-direct=2, v2-terminal=4, v2-outstanding=1, v2-bytes=8192, active-sessions=1, archives=4
```

### 2.3 `/flux restart` — 自重启 (重新初始化)

重新执行 session_start 的初始化逻辑，不重启 pi 进程:

```
AgentFlux Restart
═══════════════════════════════════════════════════
[1] Clearing in-memory state...
[2] Reloading config from .agentflux/agentflux.json...
[3] Reloading pricing table...
[4] Reloading models.json...
[5] Recollecting complexity signal...
[6] Rebuilding team context...
[7] Re-running router...
[8] Updating footer...

Restart complete:
  mode M2 → M4 (complexity tier changed since last init)
  preset balanced · stage Growth
  telemetry continuity preserved (459 events retained)
```

### 2.4 `/flux upgrade` — 升级检查

检查 git 远程是否有新提交，提示用户升级:

```
AgentFlux Upgrade Check
═══════════════════════════════════════════════════
Current:    c31029b (Full-chain integration test + Electron roadmap)
Remote:     origin/main

Checking for updates...
  git fetch origin → 3 new commits:
    abc1234  fix: routing edge case when taskSignal is null
    def5678  feat: M4-5 persistent agent state sync
    ghi9012  docs: update Phase 3 progress

Status: 3 commits behind origin/main
Recommendation: run 'git pull' then '/flux restart'

To upgrade now:
  git pull origin main && /flux restart
```

### 2.5 自动错误追踪 (turn_end 集成)

在每次 turn_end 时扫描最近的 telemetry 事件，检测异常模式:

- 连续 N 次 subagent.run exitCode != 0 → 告警
- cache hit rate 持续 < 20% → 告警
- routing fallback 频率 > 50% → 告警
- pricing 加载失败 → 告警

告警通过 footer hint 显示 (非侵入式):
```
[flux] ⚠ 3 subagent failures in last 10 turns — run /flux health
```

## 3. 实现方案

### 3.1 新文件: src/extension/health-monitor.ts

```typescript
// 核心函数:
// - checkHealth(): 逐项检查 8 个子系统，返回 HealthReport
// - getFullStatus(): 聚合所有运行时状态，返回 StatusReport
// - scanRecentIssues(events): 扫描最近 N 条 telemetry 事件，返回 Issue[]
// - checkUpgrade(): git fetch + 比较 HEAD vs origin/main
// - performRestart(): 重新执行初始化序列
```

### 3.2 entry.ts 集成

在 `/flux` 命令中提供以下自维护子命令:
- `status` → getFullStatus()
- `health` → checkHealth()
- `gc dry-run` → 预览终态 registry、V1 已读点对点消息、全接收者终态的 V2 消息和孤儿 session 的归档
- `gc` → 执行安全 GC；有活跃子进程时拒绝执行
- `gc legacy dry-run <agent-name...>` / `gc legacy <agent-name...>` → 预览/归档显式点名、超过 TTL、无实例身份且无 PID 的旧版非终态记录；不会扩大为自动猜测
- `restart` → performRestart()
- `upgrade` → checkUpgrade()

在 `turn_end` 事件中添加 errorScan:
- 读取最近 20 条事件
- 检测异常模式
- 设置 footer hint (非侵入式)

### 3.3 数据结构

```typescript
interface HealthReport {
  checks: HealthCheck[];      // 8 项逐项结果
  okCount: number;
  warnCount: number;
  errorCount: number;
  timestamp: number;
}

interface StatusReport {
  version: string;
  gitCommit: string;
  gitClean: boolean;
  mode: string;
  preset: string;
  stage: string;
  turnIndex: number;
  cacheHitRate: number;
  totalCost: number;
  subsystems: Record<string, SubsystemStatus>;
  activeAgents: AgentInfo[];
  recentIssues: Issue[];
}

interface UpgradeInfo {
  currentCommit: string;
  currentMessage: string;
  remoteCommits: GitCommit[];   // HEAD..origin/main
  upToDate: boolean;
  recommendation: string;
}

interface Issue {
  severity: "warn" | "error";
  category: string;             // "subagent_failure", "low_cache", "routing_fallback"
  message: string;
  count: number;
}
```

### 3.4 重启策略

performRestart() 需要访问 entry.ts 的闭包变量 (state, telemetry, pricingTable 等)。
实现方式: 在 entry.ts 中定义 `restartInit()` 内部函数，health-monitor.ts 只负责检查逻辑，restart 由 entry.ts 执行。

保留的数据:
- events.jsonl (telemetry 连续性)
- experience.jsonl (经验记录)
- persistent-agents.json (活跃 agent 注册)
- project-profile.json (成熟度档案)

清除的数据:
- 内存中的 state (mode, preset, cache stats)
- pricing cache (重新从远程/本地加载)
- complexity signal (重新收集)
- team context (重建)

### 3.5 版本管理

在 package.json 中添加 gitCommit 字段 (构建时注入) 或运行时读取:
```typescript
// 运行时获取版本信息
function getVersionInfo(cwd: string) {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
  const commit = execSync("git rev-parse --short HEAD", { cwd }).toString().trim();
  const clean = execSync("git status --porcelain", { cwd }).toString().trim() === "";
  return { version: pkg.version, commit, clean };
}
```

## 4. 验证指标

| 指标 | 目标 |
|---|---|
| `/flux status` 响应时间 | < 100ms (纯文件读取 + 内存聚合) |
| `/flux health` 响应时间 | < 500ms (含 subagent spawn 验证则 < 5s) |
| `/flux restart` 响应时间 | < 3s (含 pricing 远程加载) |
| `/flux upgrade` 响应时间 | < 5s (含 git fetch) |
| 错误检测覆盖率 | 能检测 subagent 失败、低 cache、路由 fallback、pricing 失败 4 种模式 |
| 重启后状态正确性 | mode/preset/stage 与重启前一致或反映最新配置 |
