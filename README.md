# AgentFlux

AgentFlux 是基于 [pi](https://github.com/earendil-works/pi-coding-agent) 的多 Agent 工作台运行时。产品只保留四种工作方式：主 Agent 直接执行、动态组队、固定 DAG 工作流和基于 Issue/Claim 的社区协作。模型选择、Agent 生命周期、会话 fork 与权限不再包装成独立“模式”。

## 使用

项目已在 `.pi/settings.json` 配置本地扩展，进入仓库后直接运行 pi；也可手动加载：

```bash
pi -e ./dist/extension/entry.js --provider <provider> --model <model>
```

先执行 `npm run build` 生成扩展入口。`src/entry.ts` 只用于源码开发和测试；全局安装及 Desktop 集成均加载 `dist/extension/entry.js`，发布包不携带 `src`。

TUI 命令：

| 命令 | 作用 |
|---|---|
| `/flux` | 打开 AgentFlux Workbench 交互菜单；输入 `/flux ` 可补全子命令 |
| `/flux work direct <task>` | Main Agent 直接执行 |
| `/flux work team <task>` | Main Agent 动态创建或调用 Agent，并负责整合 |
| `/flux work workflow <task>` | 生成并执行带依赖、并行和质量门的 DAG |
| `/flux work community <task>` | 创建 Community Issue，由 Main Agent 主持认领、执行和关闭 |
| `/flux agent` | 列出 Main、Persistent 与 execution Agent，查看身份、状态、模型、session、调用/成本和 capability；选择后可继续 session 或发送消息 |
| `/flux agent list` | 以文本列出 Persistent Agents |
| `/flux agent create <name> <role>` | 从角色模板创建 Persistent Agent |
| `/flux agent run <name> <task>` | 继续调用 Persistent Agent 的稳定 session |
| `/flux agent archive <name>` | 归档空闲 Persistent Agent |
| `/flux fork [last\|index\|entryId]` | 从当前 pi 会话创建真实分支 |
| `/flux issue ...` | list/create/show/comment/claim/submit/resolve |
| `/flux message <agent> <text>` | 向仍在线的 Agent 发送可靠 Message V2 |
| `/flux cancel [taskId]` | 取消运行中的 Workflow |
| `/flux gc [dry-run]` | 预览或执行终态 Agent、消息与孤儿 session 回收 |
| `/flux status` | 显示当前工作方式、运行、Persistent Agents 和 Issues |
| `/flux compact` | 查看上下文压缩建议 |

角色模板位于 `.agentflux/agents/*.md` 或 `.agentflux/models.json` 的 `roles`；模板定义 model、thinking、tools、skills、communication 与 workspace 上界。注册后的 Persistent Agent 可以持久收窄权限，单次运行还可继续收窄，不能扩权。

## 数据目录

```text
.agentflux/
├── agentflux.json       # 预算、缓存、上下文、通信、回收配置
├── models.json          # 模型、角色和共享 Skills
├── events.jsonl         # task/agent/message/capability telemetry
├── runtime/             # Persistent Agent、session 与运行时状态
├── community/           # Issues 与 Claims
├── shared/              # Message V2、Agent presence 与协作数据
└── archive/             # 生命周期回收归档
```

## 验证

```bash
npm run verify     # 类型检查 + 全部确定性 Core/TUI 回归
npm run test:live  # DeepSeek Pro/Flash 的 Direct/Team/Workflow/Community 全链路 smoke
```

当前完成度、测试证据与明确限制见 [实现状态](docs/26-implementation-status.md)。架构决策见 [Agent 生命周期与工作方式](docs/28-agent-workstyle-redesign.md)，Desktop 重构顺序见 [Desktop 工作台规划](docs/29-desktop-workbench-plan.md)。
