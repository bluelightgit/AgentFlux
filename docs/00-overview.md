# 00 - 项目概览

更新日期：2026-07-18。

AgentFlux 的主体由三组正交概念组成：

- **Agent 生命周期**：Main、Ephemeral、Persistent。
- **创建来源**：fresh、template、pi session fork。
- **工作方式**：Direct、Team、Workflow、Community。

四种工作方式解决不同的协作问题，而不是给同一执行器换名称：Direct 不创建 Agent；Team 由 Main Agent 动态调度；Workflow 由明确 DAG 固定依赖；Community 通过 Issue/Claim/讨论逐步形成工作图。

模型/provider/thinking、工具、Skills、通信和 workspace 是 Agent policy。用户或 Main Agent 显式选择工作方式；自动路由、模型/拓扑优化和 OS 沙箱均为后置能力，不阻塞主体功能。

代码入口：

```text
src/entry.ts
├── agents/       Agent 执行、模板、Persistent 生命周期、session fork
├── workflows/    DAG 与质量门
├── core/         Issue、消息、权限、预算、缓存、回收、telemetry contract
└── extension/    TUI 命令、上下文 mask/prefix/compaction
```

当前事实源为 [26 - 实现状态](26-implementation-status.md)。旧 M1–M6 文档仅保留为历史设计背景，不是运行时契约。
