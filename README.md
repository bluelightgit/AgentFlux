# AgentFlux

AgentFlux 是基于 [pi](https://github.com/earendil-works/pi-coding-agent) 的 Core + TUI Agent 调度扩展。

用户只需描述目标，Main Agent 可以直接完成任务，也可以按需要派发 Agent、运行固定 Workflow 或推进 Community 协作。项目重点是统一身份、角色职责、独立上下文、可控成本、可恢复执行和可审计结果。

## 快速开始

需要 Node.js **>=22.19.0**、Pi **>=1.0.0**；当前开发/限定真实验证基线为 Pi 1.0.0。插件经 Pi Host loader 取得 SDK；process 模式子 Pi 使用同一 Host 安装。升级后重启当前 Pi，build 不会热加载已运行的 Main。

```bash
npm install
npm run build
pi install ./
# 或临时加载（必须经 Host wrapper，不能把 native ESM import 当模块身份凭据）
pi -e ./dist/extension/host-entry.ts
```

发布包携带 production dist，不依赖目标项目源码。需要真实模型调用时，使用本机 pi/provider 凭据或设置 `AGENTFLUX_LIVE_*` 环境变量。所有 live 场景的 provider、主模型、planner/worker/judge 模型和 thinking 均由 `tests/live/live-test-config.json` 的 profile 解析；当前 `local` profile 固定为 `openai-codex/gpt-5.6-luna`、`thinking=max`，不随交互 Main 的 `PI_*` 切换；显式 `AGENTFLUX_LIVE_*` 覆盖仍优先。

## 子代理运行配置

在项目 `.agentflux/agentflux.json` 合并 `"subagent_runtime": "sdk"`，即可使用 Main 进程内的独立 AgentSession；设为 `"process"` 或省略则使用独立 Pi 子进程。修改只影响后续 Run，活动 Run 不切换，未知值拒绝且不会静默 fallback。两模式共用 Core/权限/费用/消息/历史。

SDK 共享 Main 故障域，只能协作取消，不自动降低 Token 费用；需要强制终止或独立生存的任务选择 process。SDK 的 shell 工具仍可启动系统进程，两个模式都不是 OS 沙箱。

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
├── src/agents/       Agent、角色、会话、统一 Runner 和 process/SDK driver
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

最新 Pi1.0/双后端开发、两模式真实调用/本地插件安装、通过/失败与未验证范围见 [实施验证报告](docs/reviews/2026-10-02-dual-runtime-validation.md) 与 [v0.1.3发布验收](docs/reviews/2026-10-06-v0.1.3-release.md)。Linux/Windows CI验证不代表macOS生命周期支持；SDK只有协作取消，人工UI/断电/长期soak仍需独立验收。原生压缩/缓存/prompt/session API 已复用；MCP/codemode/typed operations 等可选受限接入未默认开启，不替代 Core 事实源。

```bash
npm run verify
npm run typecheck
npm run build
npm run test:live:multirole
AGENTFLUX_LIVE_BUILT=1 AGENTFLUX_LIVE_RUNTIME=sdk npm run test:live:runtime-lifecycle
AGENTFLUX_LIVE_BUILT=1 AGENTFLUX_LIVE_RUNTIME=process npm run test:live:installed
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

切换 live 测试技术后端使用 `AGENTFLUX_LIVE_RUNTIME=process|sdk`（产品字段为 `subagent_runtime`）。切换 live 场景配置时使用 `AGENTFLUX_LIVE_PROFILE`；覆盖单个值使用 `AGENTFLUX_LIVE_PROVIDER_ID`、`AGENTFLUX_LIVE_MODEL`、`AGENTFLUX_LIVE_PLANNER_MODEL`、`AGENTFLUX_LIVE_WORKER_MODEL`、`AGENTFLUX_LIVE_JUDGE_MODEL` 和 `AGENTFLUX_LIVE_THINKING`，不要修改测试文件中的模型常量。

P0-02 的 Main 失败 sibling 覆盖返工已在指定生产快照取得独立 PASS；旧第四次 rework 报告保留，不外推至新构建、权威账单或全部孙进程。P0-07 已归档。当前仍是开发级版本，逐功能实现、实际使用与未验证范围见 [功能验证报告](docs/reviews/2026-09-08-function-validation.md)，具体待办仅维护在 `docs/development-plan/`。真实链路测试统一从 `tests/live/live-test-config.json` 选择 profile，模型/provider/thinking 不写死在测试代码中；必须同时检查 Registry、delivery、checkpoint、成本和失败原因。

GC 共同引用 fence 与消息强杀/ACK 丢失重投已完成专项验证；同构建八类 live 脚本最新结果通过，失败保留，详见 [GC/消息阶段摘要](docs/history-plans/2026-09-08-gc-message-validation.md)。后续 [PID 局部阶段](docs/history-plans/2026-09-08-pid-identity-validation.md) 已接入出生记录/异步核验、启动异常与实际退出门禁，并完成五类 fresh 验证。这不代表全部功能关闭：首次启动握手/控制接管/原子性、完整恢复/迁移/容量与发布验收仍有缺口。

产品自带文案使用英文且无 emoji，用户/历史/外部原文保留。Windows 子 Pi 使用后台启动兼容层，保留进程树控制；这是 Host 默认选项，不是 GUI 隔离。实现与真实验证范围见 [英文/后台阶段摘要](docs/history-plans/2026-09-08-english-background-validation.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/00-product.md](docs/00-product.md) | 产品目标、范围和成功标准 |
| [docs/01-architecture.md](docs/01-architecture.md) | 项目架构和不可违反的契约 |
| [docs/development-plan/00-index.md](docs/development-plan/00-index.md) | 当前开发规划入口和规划规则 |
| [docs/history-plans/](docs/history-plans/) | 已完成或被替代的历史规划 |

开发规则见 `AGENTS.md`；续接事实见 `.codex/CONTINUATION.md`。
