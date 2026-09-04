# AgentFlux

AgentFlux 是基于 [pi](https://github.com/earendil-works/pi-coding-agent) 的 Core + TUI Agent 调度扩展。

用户只需描述目标，Main Agent 可以直接完成任务，也可以按需要派发 Agent、运行固定 Workflow 或推进 Community 协作。项目重点是统一身份、角色职责、独立上下文、可控成本、可恢复执行和可审计结果。

## 快速开始

```bash
npm install
npm run build
pi -e ./dist/extension/entry.js
```

发布包携带 production dist，不依赖目标项目源码。需要真实模型调用时，使用本机 pi/provider 凭据或设置 `AGENTFLUX_LIVE_*` 环境变量。所有 live 场景的 provider、主模型、planner/worker/judge 模型和 thinking 均由 `tests/live/live-test-config.json` 的 profile 解析；默认 `local` profile 跟随当前 `PI_PROVIDER`、`PI_MODEL`、`PI_THINKING`，没有环境值时才使用配置文件 fallback。

## 产品能力

- **Main**：直接执行和跨步骤协调。
- **Agent**：默认、角色模板或真实会话分支创建；支持 `roles[]`、`shared/fresh`、模型继承、运行中 inspect/steer/stop、重试和 GC。
- **Workflow**：版本化固定 DAG，支持依赖、并行、文件锁、质量门、预算、重试和 checkpoint。
- **Community**：Issue → Proposal → Claim → Submit → Review → Resolve。
- **Message V2**：direct/group、recipient delivery、ACK、重投、过期、dedupe 和背压。
- **历史与恢复**：Task、Execution、Run Registry 保存状态、成本、失败原因和父谱系。

## 架构入口

```text
src/entry.ts
├── src/agents/       Agent、角色、会话、运行和子进程
├── src/workflows/    planner、DAG、checkpoint 和质量门
├── src/core/         Task、Community、Message V2、权限、成本和回收
└── src/extension/    TUI、命令、补全、通知和 RPC pump
```

Core 是任务、Agent、Workflow、Issue、消息、权限和运行状态的事实源；TUI 只呈现事实并发起命令。Host 文件/进程门禁不等于操作系统隔离。

## 常用命令

| 命令 | 作用 |
|---|---|
| `/flux` | 打开 Workbench |
| `/flux task ...` | 查询、继续、复用、恢复和重试任务 |
| `/flux agent ...` | 管理 Agent、运行、停止、重试和 GC |
| `/flux workflow ...` | 查看、复用、修改和删除 Workflow 定义 |
| `/flux issue ...` | 管理 Community Issue/Claim |
| `/flux message ...` | 发送、查看和确认 Message V2 |
| `/flux fork ...` | 从当前 pi 会话创建真实分支 |
| `/flux status` | 查看当前运行和状态 |
| `/flux usage` | 查看 Main usage 和成本 |

Workflow 支持命令/TUI 新建、运行、复用、修改、删除和 planner/DAG 执行；当前开发规划继续收口 P0-03 Community、P0-06 Message V2 和真实链路边界。

## 验证

```bash
npm run verify
npm run typecheck
npm run build
npm run test:live:multirole
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-controls
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-workflow-deadline
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-fanout
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-long
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-provider-overload
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-restart-recovery
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-owner-fence
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-02-space-isolation
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-task-lineage
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-package-boundary
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-soak
AGENTFLUX_LIVE_BUILT=1 npm run test:live:p0-07-bound-resume
npm run dogfood:restart
```

切换 live 场景配置时使用 `AGENTFLUX_LIVE_PROFILE`；覆盖单个值使用 `AGENTFLUX_LIVE_PROVIDER_ID`、`AGENTFLUX_LIVE_MODEL`、`AGENTFLUX_LIVE_PLANNER_MODEL`、`AGENTFLUX_LIVE_WORKER_MODEL`、`AGENTFLUX_LIVE_JUDGE_MODEL` 和 `AGENTFLUX_LIVE_THINKING`，不要修改测试文件中的模型常量。

P0-02 项目空间互斥已完成：Main persistent Agent 派发、Workflow 和 Community Claim 共用 active-context/lease，跨空间拒绝、同空间并行、失败/取消/deadline/crash 的实例级清理和 surviving sibling 不误删由 `test-active-context.ts`、`test-p0-02-space-isolation.ts` 与多 Pi production-dist 报告 `.agentflux/test-results/p0-02-space-isolation-latest.json` 覆盖。P0-07 已在提交 `5371db2` 上通过第四次独立验收并归档：`npm run verify`、typecheck、production build 和 controls、Workflow timeout、restart recovery、owner-fence production-dist 复跑均通过；四个 fresh production 场景统一使用 `openai-codex/gpt-5.6-luna`、`thinking=max`，latest 报告均记录 `passed=true`、`builtExtension=true`、`changedFiles=[]` 和匹配的 sourceCommit。其余 telemetry、fanout、long-run、provider-overload、task-lineage、package-boundary、bound-resume、soak 报告作为独立场景证据保留。真实链路测试统一从 `tests/live/live-test-config.json` 选择 profile，模型/provider/thinking 不写死在测试代码中；必须同时检查 Registry、delivery、checkpoint、成本和失败原因。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/00-product.md](docs/00-product.md) | 产品目标、范围和成功标准 |
| [docs/01-architecture.md](docs/01-architecture.md) | 项目架构和不可违反的契约 |
| [docs/development-plan/00-index.md](docs/development-plan/00-index.md) | 当前开发规划入口和规划规则 |
| [docs/history-plans/](docs/history-plans/) | 已完成或被替代的历史规划 |

开发规则见 `AGENTS.md`；续接事实见 `.codex/CONTINUATION.md`。
