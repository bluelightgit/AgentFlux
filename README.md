# AgentFlux

AgentFlux 是基于 [pi](https://github.com/earendil-works/pi-coding-agent) 的 Core + TUI Agent 调度扩展。

用户只需描述目标，Main Agent 可以直接完成任务，也可以按需要派发 Agent、运行固定 Workflow 或推进 Community 协作。项目重点是统一身份、角色职责、独立上下文、可控成本、可恢复执行和可审计结果。

## 快速开始

```bash
npm install
npm run build
pi -e ./dist/extension/entry.js
```

发布包携带 production dist，不依赖目标项目源码。需要真实模型调用时，使用本机 pi/provider 凭据或设置 `AGENTFLUX_LIVE_*` 环境变量。

## 产品能力

- **Main**：直接执行和跨步骤协调。
- **Agent**：默认、角色模板或真实会话分支创建；支持 `roles[]`、`shared/fresh`、模型继承、运行、停止、重试和 GC。
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

Workflow 的命令/TUI 新建与直接 run 入口仍在当前开发规划中；已保存定义可通过工具执行或由 TUI 复用。

## 验证

```bash
npm run verify
npm run typecheck
npm run build
npm run test:live:multirole
npm run dogfood:restart
```

最近确定性基线为 609/609，production build 已通过。真实链路测试默认使用低成本模型、`thinking=off`、短提示和受限输入；必须同时检查 Registry、delivery、checkpoint、成本和失败原因。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/00-product.md](docs/00-product.md) | 产品目标、范围和成功标准 |
| [docs/01-architecture.md](docs/01-architecture.md) | 项目架构和不可违反的契约 |
| [docs/development-plan/00-index.md](docs/development-plan/00-index.md) | 当前开发规划入口和规划规则 |
| [docs/history-plans/](docs/history-plans/) | 已完成或被替代的历史规划 |

开发规则见 `AGENTS.md`；续接事实见 `.codex/CONTINUATION.md`。
