# Pi 子代理执行方式生态调研

采样日期：2026-10-01（UTC）。范围：公开实现的执行路径与流行度线索；不是扩展安全审计、Pi 0.99.2 兼容认证或运行性能测试。本轮未安装被调研扩展、未修改 AgentFlux 业务代码/依赖/production dist，也没有新增 Provider 请求。

## 结论

**进程内 SDK 是有主流社区实践支撑的方案，不是少见的实验路线。** 在本次去重后的六个社区实现样本中，三个采用同进程 SDK，一个采用“前台 Main 内 SDK / 后台独立 runner 内 SDK”的混合方案，两个启动独立 Pi 进程。官方随 Pi 0.99.2 安装的 subagent 示例仍采用独立 Pi 子进程。

因此，准确结论是“样本中四个存在 SDK 执行路径，较热门的两个子代理扩展都采用 SDK”，不是“已经证明整个生态大多数任务都与 Main 共用进程”。样本不是随机抽样，后台委派系统也计入了样本；下载量不是独立用户数或实际执行占比。

此外，**SDK、同进程、内存会话、后台运行是四个不同维度**：SDK 会话可以持久化到独立文件；后台 Promise 可以仍在 Main 内运行；独立后台进程也可以使用 SDK，而不是逐个启动 Pi CLI。

## 实现样本与源码依据

| 实现 / 快照 | 执行方式 | 已核验路径 |
|---|---|---|
| **[pi-subagents](https://github.com/nicobailon/pi-subagents)**，npm 0.74.0 / `b6bda32f` | **混合**。常规 Node 前台 child 在 Main 内创建独立 SDK session；后台启动 detached runner，session 在 runner 内运行。另有 binary Host 启动分支，不把全部安装形态笼统视作 Node 同进程。 | [child-session.ts:438](https://github.com/nicobailon/pi-subagents/blob/b6bda32f03b7f549623bc404c9be14dca298ddc4/src/runs/shared/child-session.ts#L438) 调用 `pi.createAgentSession`；同文件包装 prompt/abort/dispose；[async-execution.ts:744](https://github.com/nicobailon/pi-subagents/blob/b6bda32f03b7f549623bc404c9be14dca298ddc4/src/runs/background/async-execution.ts#L744) spawn runner；仓库 `run-child-session.ts` 的后台链使用 child factory 创建并 prompt。 |
| **[@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)**，npm 0.19.0 / `4f572eaa` | **Main 进程内 SDK**。前台/后台共享 `runAgent` 路径，后台由 manager 管理 Promise/AbortController，不因 background 标记另启动 Pi。支持独立 memory/file session。 | [agent-manager.ts:761](https://github.com/tintinweb/pi-subagents/blob/4f572eaa04c09d3dbc16e4a5f13a16b295e84e14/src/agent-manager.ts#L761) → [agent-runner.ts:1008](https://github.com/tintinweb/pi-subagents/blob/4f572eaa04c09d3dbc16e4a5f13a16b295e84e14/src/agent-runner.ts#L1008) `createAgentSession` → `session.prompt`；取消转 `session.abort`。 |
| **[pi-fast-subagent](https://github.com/tuansondinh/pi-fast-subagent)**，npm 0.9.4 / `559cc175` | **Main 进程内 SDK**。前台和后台调用同一个 runner；后台“detach”是将同一 Promise 的管理权交给 BackgroundJobManager，不是进程 detach。 | [runner.ts:134](https://github.com/tuansondinh/pi-fast-subagent/blob/559cc175447b25d1a162cf436875f0c60ac569be/runner.ts#L134) `createAgentSession` + `SessionManager.inMemory(cwd)`，之后 prompt/abort/dispose；入口前后台调用链已核验。 |
| **[pi-subagent-in-memory](https://github.com/ross-jill-ws/pi-subagent-in-memory)**，npm 0.3.0 / `de649363` | **Main 进程内 SDK**。父取消时 child 可以留在同一进程继续执行，而非产生独立后台进程。 | [extensions/index.ts:628](https://github.com/ross-jill-ws/pi-subagent-in-memory/blob/de649363a5e6726d981ff595e59cb594d16659d0/extensions/index.ts#L628) `createAgentSessionServices` → `createAgentSessionFromServices` + inMemory。这两个 services API 在本机 Pi 0.99.2 公开导出中存在，但不等于整个扩展经过兼容测试。 |
| **[@mjakl/pi-subagent](https://github.com/mjakl/pi-subagent)**，npm 3.0.1 / `0d132733` | **独立 Pi / RPC 子进程**。 | [runner.ts:470](https://github.com/mjakl/pi-subagent/blob/0d13273319902a84535c2bf4341a5aefbd422dc0/runner.ts#L470) spawn Pi，stdin 写 RPC prompt，消费事件，结束/取消控制进程。另采 HEAD `8f12f490` 的入口定位已有变化，未把它混作 npm 3.0.1 源码。 |
| **[pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks)**，仓库 2.6.9 / `4aceb55f` | **独立 Pi 子进程**。它是包含 delegated agent 的后台任务系统，不只是单一子代理工具。 | [registry.ts:2124](https://github.com/ismailsaleekh/pi-background-tasks/blob/4aceb55fc7dfa3e99b8e7b275f4910af4362a776/src/core/registry.ts#L2124) `startDelegateTask` spawn `launch.executable`，显式 cwd/env/stdin，独立退出事件。npm latest 查询失败，此版本只标作仓库快照。 |
| **[Pi 官方 subagent 示例](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)**，本机安装 0.99.2 | **独立 Pi / JSON print 子进程**。官方样例不算入上述六个社区样本。 | 安装包 `examples/extensions/subagent/index.ts:346` 调用 spawn，解析 JSON 输出；取消发送进程信号。官方在线链接是入口，本轮实际证据为本地 0.99.2 文件及 SHA256。 |

nico/tintin 的 npm `gitHead` 与仓库 HEAD 不同，但此次对照的 `child-session.ts`/`agent-runner.ts` blob SHA 一致；仍保存了两个版本来源。没有把 gotgenes/nklisch 等相关 fork、搜索结果重复页面或只见 SDK import 而未见调用链的候选计为独立样本。

### 流行度取样

[Pi package catalog](https://pi.dev/packages) 当日页面展示：`pi-subagents` 约 **536.6K/月**、`@tintinweb/pi-subagents` 约 **33.4K/月**、`pi-background-tasks` 约 **110.7K/月**。GitHub 当日元数据约为 nico 3,801 stars、tintin 1,240 stars。数字只用于说明 SDK 与进程方案均有真实流行实现；目录/搜索缓存会变化，不能据此计算生态 SDK 市占率。

## 对 AgentFlux 的意义与不能直接照搬的部分

调研支持将**同一个 Core Runner 下的 SDK session 适配**作为正式候选，而不是把独立 CLI spawn 当成 Pi 子代理的唯一正常实现。它可以消除每个 Run 的 Pi CLI 启动/JSONL 传输成本，并让普通 child 与 Main 共用承载进程；但它不会减少模型 Token 费用，也不会自动解决 SDK 模块解析被项目 dev 依赖遮蔽的问题。真正 Host 绑定仍须独立验证。

不能只把 `spawn()` 换成 `createAgentSession()`：

- AgentFlux 子入口目前以独立 env 注入 Run 身份/权限/任务归属；同进程须显式 factory/session 参数，不能临时修改共享 `process.env`。nico 为启动串行 env 窗口和 loader 缓存使用了专门补丁，源码也警告可能共享 module state；这不是可直接当作隔离保证的模式。
- 仍需独立 session、cwd、模型/权限与资源 loader、Message V2 pump、同代 settled/消费 ACK、费用 baseline、预算与文件锁。Core Task/Execution/Run/checkpoint 不能被社区的 Promise manager 或另一消息协议替代。
- `abort` 是协作取消，不能强杀不合作的 JS 或隔离内存故障。共享 Main PID 不能伪装成每个 child 的独立进程身份；需要明确 SDK Run 的逻辑生命周期/所有者及 Main 崩溃后的新谱系恢复。
- SDK 不必是内存会话；可以保留独立 SessionManager 文件和 native fork。父/子会话不应共享 Main 对话历史写入口，也不能靠直接改 `agent.state.messages` 实现继承。
- `pi-fast-subagent` 仍使用旧 `@mariozechner`/AuthStorage/ModelRegistry 接口。`pi-subagent-in-memory` 默认 1800s timeout、以 `agent_end` 完成及父取消后 child 继续的语义也不同于 AgentFlux；不能原样移植。
- in-memory README 记录 Pi 0.8x 的 `openai-codex` 同账号第二 session 使父下一请求挂起，作者声称 SSE/WebSocket 均复现。这是**第三方历史报告**，本轮没有在 Pi 0.99.2 复现，不能认定当前仍存在或已修复；它提示设计验收必须覆盖同 Provider 并发、child 结束后 Main 再请求、abort/retry/资源释放。

目前只得出候选方向，不表示 AgentFlux 已换成 SDK。设计依赖/验收只在 [COMPAT-22](../development-plan/04-pi-compatibility.md) 维护；未来需要强制进程终止、独立故障域或脱离 Main 生存的任务，仍可能需要进程后端。

## 证据与限制

本轮原始证据：`.agentflux/test-results/pi-subagent-survey-2026-10-01/`。`blob-sources.json` 与 `release-sources.json` 保存 commit/blob SHA/文件 SHA256；`npm-latest.json` 保存版本/peer/gitHead；`official/sources.json` 保存官方安装示例版本/指纹；catalog HTML 保留当日显示值。首次 raw fetch 失败、npm background 查询失败与错误路径等均保留，不以采集脚本 exit=0 代替完整下载或运行认证。补充采集 `run-child-session.ts` 遇 HTTP 403/网络失败；其先前完整网页读取的关键调用原文与两 commit 同 blob 证明另存 `background-chain-excerpt.json`，未伪称取得该文件的本地完整副本。fast 入口本地文件在补充采集首轮取得，后续重取失败日志亦保留。

这是针对执行链的静态审查，不宣称完整读取/审计所有大型模块或扩展全部模式，没有安装执行这六个扩展，没有性能对照、真实 SDK 并发或 Linux/macOS 认证。文档链接、源码快照与 AgentFlux 业务/依赖/dist 未变检查见本目录 `summary.json`。
