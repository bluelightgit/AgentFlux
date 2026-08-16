# AgentFlux

AgentFlux 是基于 [pi](https://github.com/earendil-works/pi-coding-agent) 的多 Agent 调度扩展。日常任务在 Main Agent 中直接执行，需要时可派发子代理；Workflow（固定 DAG）与 Community（Issue/Claim 协作）是两种可选的执行方法，由 Main Agent 按任务需要调用。同一时间只允许一个项目级执行空间（main / workflow / community）活跃。

## 安装

AgentFlux 是 npm 上的 pi 包，安装后自动注册 `/flux` 命令族和调度工具：

```bash
pi install npm:agentflux            # 从 npm registry 安装（推荐）
pi install git:github.com/bluelightgit/AgentFlux   # 从 git 仓库安装
pi install git:github.com/bluelightgit/AgentFlux@v0.1.0  # 固定 tag
```

未安装时临时试用：`pi -e npm:agentflux`。

开发本仓库时，先执行 `npm run build` 生成 `dist/extension/entry.js`，然后在项目内直接运行 `pi`（`.pi/settings.json` 已配置本地扩展）或手动加载：`pi -e ./dist/extension/entry.js`。发布包只携带 `dist`，不携带 `src`。

## 核心概念

- **执行**：任务在 Main Agent 中直接完成，或按需派发子代理（`flux_agent`）。AgentFlux 不预设执行方式。
- **Agent 实体**：单一子代理模型。三种创建路径——默认模板、角色模板、从既有会话树分叉（继承源会话记忆）；可重名（自动 `xxx(1)` 后缀）；三层作用域（global / project / session，会话结束清理 session 作用域）。`run` 携带指令与超时并返回对话的最近消息，`delete` 硬删除，自动 GC 保留最近 k 个（默认 10）。
- **Workflow**：保存的固定 DAG 定义（含版本历史），按需创建执行；节点可并行、可挂质量门，执行支持断点续跑（`resume`）。
- **Community**：Issue/Claim 协作。提案（propose/support/oppose）可多提案绑定认领，claim → submit → review（pass/rework）→ resolve，带轮次、成本与停摆门禁。
- **消息**：Message V2 提供 Agent 间直接消息、群组与投递确认（send/poll/ack/lease 重投）。
- **互斥**：`.agentflux/runtime/active-context.json` 是权威互斥状态，一个空间活跃时阻止其他空间启动；空间内并行允许。
- **权限**：角色模板定义上界，注册实例与单次运行逐层收窄，下层不能扩大上层能力。子代理的 `edit`/`write` 拒绝修改未声明文件；文件锁防并行编辑冲突。此门禁提供进程与文件级保护，覆盖 OS 级沙箱。

## TUI 命令

| 命令 | 作用 |
|---|---|
| `/flux` | 打开 Workbench 菜单；`/flux ` 可补全子命令 |
| `/flux task list\|show\|new\|reuse\|resume\|continue\|retry` | 任务注册表：查询、新建、复用、恢复、继续、重试（保留父任务谱系，不修改历史任务） |
| `/flux workflow list\|show\|reuse\|modify\|delete` | 已保存 Workflow 定义：列出、查看 DAG、按原版本执行、生成新版本并执行、删除 |
| `/flux agent list\|create\|run\|stop\|retry\|delete\|gc` | 子代理生命周期：列出、创建（默认/角色模板）、对话、停止、重跑上次任务、删除、自动回收 |
| `/flux issue list\|create\|show\|comment\|propose\|support\|oppose\|claim\|submit\|review\|resolve\|delete` | Community 协作全流程 |
| `/flux message send\|inbox\|ack` | 直接消息：发送、收件箱、确认 |
| `/flux message group list\|create\|send` | 消息群组 |
| `/flux fork [last\|index\|entryId]` | 从当前 pi 会话创建真实分支 |
| `/flux status` | 当前任务、活跃运行、Agents 与 Issues 概览 |
| `/flux space` | 活跃空间、Workflow/Community 定义与最近 Agent 活动时间线 |
| `/flux usage` | Main 会话逐轮 token、缓存命中与成本 |
| `/flux gc [dry-run]` | 预览或执行终态 Agent、消息与孤儿 session 回收 |
| `/flux cancel [taskId]` | 取消运行中的 Workflow |
| `/flux compact` | 查看上下文压缩建议 |

Main Agent 可通过工具直接调度：`flux_task`（历史查询与任务操作）、`flux_agent`（子代理）、`flux_workflow`（DAG 执行）、`flux_issue`（Community）、`flux_message`（消息）。用户只需描述目标（如“继续最近的 Workflow”“恢复刚才超时的任务”），无需提供内部 ID。

## 数据目录

```text
.agentflux/
├── agentflux.json       # 预算、缓存、通信、回收等配置
├── models.json          # 模型表、角色模板与共享 Skills
├── issues.json          # Community Issues 与 Claims
├── events.jsonl         # task/agent/message telemetry
├── runtime/             # 任务注册表、Workflow 定义、会话与运行状态
│   ├── tasks.json       # Task Registry
│   ├── workflows.json   # Workflow 定义及历史版本
│   ├── runs/<id>/       # 执行 DAG、checkpoint 与产物
│   └── sessions/        # 子代理会话文件
└── shared/              # Message V2、文件锁与协作数据
```

## 验证

```bash
npm run verify                        # 类型检查 + 全部确定性回归（25 组，581 断言）
npm run test:live                     # DeepSeek 全链路 smoke
npm run test:live:history             # 同一会话两轮任务：自动继续与父任务关系
npm run test:live:workflow-reuse      # 创建并精确复用已保存 Workflow
npm run test:live:workflow-modify     # 修改得到 v2，保留 v1，再精确复用 v2
```

Live 测试默认使用本机 `~/.pi/agent` 凭据与 `octopus-anthropic` provider；通过 `AGENTFLUX_LIVE_*` 环境变量可指向任意 OpenAI/Anthropic 兼容端点（baseUrl、api、apiKey、模型、thinking、用例子集、provider id，详见 tests/live/）。CI 中由 `.github/workflows/live.yml` 手动或定时触发。

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/26-implementation-status.md](docs/26-implementation-status.md) | 当前实现状态、测试证据与已知限制 |
| [docs/33-workstyle-redesign.md](docs/33-workstyle-redesign.md) | 执行模型与空间互斥设计 |
| [docs/31-live-test-report-2026-08-12.md](docs/31-live-test-report-2026-08-12.md) | 真实链路测试报告 |
| [docs/32-code-review-2026-08-14.md](docs/32-code-review-2026-08-14.md) | 代码评审与修复记录 |
| [docs/design-spec.md](docs/design-spec.md) 与 docs/00-overview.md | 设计与总览 |
