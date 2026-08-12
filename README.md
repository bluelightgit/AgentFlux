# AgentFlux

AgentFlux 是基于 [pi](https://github.com/earendil-works/pi-coding-agent) 的多 Agent 工作台运行时。产品只保留一个递进的任务能力体系：Direct 是 Main Agent 基础执行；Team 在其上增加动态 Agent 调用；Workflow 和 Community 平级建立在 Team 能力之上，分别增加固定 DAG 与基于 Issue/Claim 的任务驱动协作。模型选择、Agent 生命周期、会话 fork 与权限不再包装成独立“模式”。`agent_decides` 是由 Main Agent 选择上述工作方式的入口，不是第五种工作方式。

## 安装

AgentFlux 是 npm 上的 pi 包（`pi-package`），安装后自动注册 `/flux` 命令族和六个调度工具：

```bash
pi install npm:agentflux          # 从 npm registry 安装（推荐，固定版本）
pi install git:github.com/bluelightgit/AgentFlux   # 从 git 仓库安装（默认 main）
pi install git:github.com/bluelightgit/AgentFlux@v0.1.0  # 固定 tag
```

未安装时也可以临时试用：`pi -e npm:agentflux`。

依赖说明：AgentFlux 声明 `@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui` 与 `typebox` 为 peerDependencies（均为 `*`），运行时使用 pi 主进程自身提供的实例，发布包不携带这些依赖，也不会与 pi 自带版本产生双实例冲突。

## 使用

项目已在 `.pi/settings.json` 配置本地扩展，进入仓库后直接运行 pi；也可手动加载：

```bash
pi -e ./dist/extension/entry.js --provider <provider> --model <model>
```

先执行 `npm run build` 生成扩展入口。`src/entry.ts` 只用于源码开发和测试；全局安装加载 `dist/extension/entry.js`，发布包不携带 `src`。

TUI 命令：

| 命令 | 作用 |
|---|---|
| `/flux` | 打开 AgentFlux Workbench 交互菜单；输入 `/flux ` 可补全子命令 |
| `/flux work direct <task>` | Main Agent 直接执行 |
| `/flux work team <task>` | Main Agent 动态创建或调用 Agent，并负责整合 |
| `/flux work workflow <task>` | 生成并执行带依赖、并行和质量门的 DAG |
| `/flux work community <task>` | 创建 Community Issue，由 Main Agent 主持认领、执行和关闭 |
| `/flux workflow` | 打开已保存 Workflow 菜单 |
| `/flux workflow list` | 列出工作区内最新版本的 Workflow 定义 |
| `/flux workflow show <selector>` | 查看指定 Workflow 的节点与依赖 |
| `/flux workflow reuse <selector> <task>` | 跳过 planner，按保存的 DAG 创建新执行 |
| `/flux workflow modify <selector> <change>` | 重新规划并保存同一 Workflow ID 的新版本 |
| `/flux task` | 打开当前 Pi 会话的任务历史菜单 |
| `/flux task list` | 列出历史任务及状态、工作方式和父任务关系 |
| `/flux task show [latest\|latest_<style>\|taskId]` | 查看最近或指定任务 |
| `/flux task reuse [selector] [task]` | 复用历史任务的工作方式和协作结构，创建新执行 |
| `/flux task resume [selector] [task]` | 从失败、取消、超时或中断任务恢复；Workflow 会读取 checkpoint |
| `/flux task continue [selector] [task]` | 基于历史结果继续，创建带父任务关系的新执行 |
| `/flux task retry [selector] [task]` | 重试失败、取消或超时任务，并保留父任务与父执行关系 |
| `/flux agent` | 列出 Main、Persistent 与 execution Agent，查看身份、状态、模型、session、调用/成本和 capability；选择后可继续 session 或发送消息 |
| `/flux agent list` | 以文本列出 Persistent Agents |
| `/flux agent create <name> <role>` | 从角色模板创建 Persistent Agent |
| `/flux agent run <name> <task>` | 继续调用 Persistent Agent 的稳定 session |
| `/flux agent archive <name>` | 归档空闲 Persistent Agent |
| `/flux fork [last\|index\|entryId]` | 从当前 pi 会话创建真实分支 |
| `/flux issue ...` | list/create/show/comment/claim/submit/resolve |
| `/flux message` | 打开 Main inbox 与消息群组菜单 |
| `/flux message send <agent> <text>` | 向仍在线的 Agent 发送可靠 Message V2 |
| `/flux message inbox [agent]` | 拉取收件箱并将消息标记为 delivered |
| `/flux message ack <agent> <messageId>` | 确认已经处理的消息 |
| `/flux message group list` | 列出消息群组及成员 |
| `/flux message group create <name> <member,...>` | 创建自动包含 Main 的消息群组 |
| `/flux message group send <groupId> <text>` | 群发到除发送者外的所有成员 |
| `/flux cancel [taskId]` | 取消运行中的 Workflow |
| `/flux gc [dry-run]` | 预览或执行终态 Agent、消息与孤儿 session 回收 |
| `/flux status` | 显示当前工作方式、运行、Persistent Agents 和 Issues |
| `/flux compact` | 查看上下文压缩建议 |

角色模板位于 `.agentflux/agents/*.md` 或 `.agentflux/models.json` 的 `roles`；模板定义 model、thinking、tools、skills、communication 与 workspace 上界。注册后的 Persistent Agent 可以持久收窄权限，单次运行还可继续收窄，不能扩权。

Main Agent 也可以直接调用 `flux_task` 查询历史。用户只需说“继续最近的 Workflow”“恢复刚才超时的任务”或“复用上次 Team 处理新模块”，无需提供内部 ID；当存在多个候选时再从 `/flux task` 菜单选择。

## 工作方式选择与切换

工作方式属于一次 AgentFlux task，而不是 Pi 会话的永久模式：

- TUI 的 `/flux work <style> <task>` 为新任务创建固定工作方式；任务结束后释放当前选择。
- 工作方式选择器保存的是“下一条空闲时发送任务”的用户偏好。运行中的 `steer` 和排队的 `followUp` 继续当前 task，不会中途改成另一种工作方式；Agent 已空闲后再次发送会创建新 task，并使用当时选择的工作方式。需要显式继承历史语义时使用 `reuse/resume/continue`。
- `agent_decides` 不运行独立分类器。Main Agent 根据任务目标和稳定协议自行判断：不调用调度工具即落为 Direct；调用 Team、Workflow 或 Community 对应工具时记录实际工作方式。
- `reuse`、`resume`、`continue` 默认继承来源任务的工作方式；它们创建有 `parentTaskId` 的新 task，不篡改已经完成的记录。

递进能力矩阵已经在 Main 工具入口统一硬门禁：Direct 拒绝 Agent、消息、DAG 和 Community 写操作；Team 拒绝 DAG 和 Community；Workflow 继承 Team 并拒绝 Community；Community 继承 Team 并拒绝 Workflow。只读的 Agent/Issue/Task 查询保持可用，便于 Main 选择历史资源。固定 task 也不能通过 `flux_task` 中途切换工作方式。

工作方式会影响 system prompt，但影响是有限且稳定的：

- 所有任务共享相同的 Pi 基础提示词、AgentFlux 通用协议和工具 schema。
- 固定工作方式只在末尾追加 Direct、Team、Workflow 或 Community 的常量模板；不追加 taskId、任务正文或动态预算。
- 同一种工作方式跨任务的 AgentFlux system prompt 完全一致，有利于命中相同前缀。
- 从一种工作方式切到另一种时，公共前缀仍可复用，但工作方式后缀不同，不能承诺跨方式完整缓存命中；切回原工作方式能否命中还取决于 provider 的缓存保留策略。
- Main 可见的六个 AgentFlux 工具在各工作方式下保持相同，因此切换工作方式本身不改变工具 schema。硬门禁在执行入口检查，不动态增删 Main 工具，避免每次切换额外破坏工具前缀。
- 本次递进协议升级修改了固定常量提示词，因此升级后的第一次请求可能无法复用旧版本完整前缀；同一版本后续任务继续使用稳定模板。

四种任务操作的语义：

| 操作 | 标识与上下文 | 各工作方式的行为 |
|---|---|---|
| `new` | 新 task | 正常创建 Direct、Team、Workflow 或 Community |
| `reuse` | 新 task，记录 `parentTaskId` | 复用工作方式；Team 提供上次成员结构，Workflow 复用已保存 DAG 并跳过 planner，Community提供原 Issue 关联 |
| `resume` | 新 task 关联中断 task | Direct 继续 Main 会话；Team 重新调度所需职责；Workflow 读取原 DAG/checkpoint 并跳过已完成节点；Community继续原 Issue |
| `continue` | 新 task，记录 `parentTaskId` | 继承历史结果后开展下一阶段，不覆盖已经完成的执行 |

## 简化原理

AgentFlux 将模型输入和运行控制分开：

```text
Pi session UUID
└── AgentFlux task
    ├── Main Agent
    ├── Team / DAG / Issue
    └── Agent runs、消息、成本与状态
```

- Pi 原生 UUIDv7 作为稳定 `sessionId`，重开会话不变；AgentFlux 为每次任务和 Agent run 自动生成关联标识。
- 模型不接收 session/task/run/agent ID。ID 只存在于 Task Registry 和 telemetry。
- 兼容任务信封只用于把工作方式送进 extension；`input` hook 会在 Pi 持久化和 provider 请求前将它剥离，因此会话与模型只看到用户原文。
- system prompt 只由稳定的通用协议和四个固定工作方式模板组成，不包含随机 taskId、任务正文或动态预算。
- Task Registry 位于 `.agentflux/runtime/tasks.json`；它让 Main Agent 在 compaction 或重开后仍能按需查询历史，而不把全部任务塞进 system prompt。
- 复用 ID 本身不会提高缓存；真正的缓存收益来自稳定 system/tools/skills/model，以及 Persistent Agent 的稳定 session。Ephemeral Agent 仍按单次任务结束。

## 数据目录

```text
.agentflux/
├── agentflux.json       # 预算、缓存、上下文、通信、回收配置
├── models.json          # 模型、角色和共享 Skills
├── events.jsonl         # task/agent/message/capability telemetry
├── runtime/             # Persistent Agent、session 与运行时状态
│   ├── tasks.json       # 可查询的 Task Registry
│   ├── workflows.json   # Workflow 定义及历史版本
│   └── runs/<id>/       # Workflow DAG、checkpoint 与 artifacts
├── community/           # Issues 与 Claims
├── shared/              # Message V2、Agent presence 与协作数据
└── archive/             # 生命周期回收归档
```

## 验证

```bash
npm run verify     # 类型检查 + 全部确定性 Core/TUI 回归
npm run test:live  # DeepSeek Pro/Flash 的 Direct/Team/Workflow/Community 全链路 smoke
npm run test:live:history # 同一 Pi session 两轮任务，验证 Main 自动 continue 与父任务关系
npm run test:live:workflow-reuse # 同一 Pi session 创建并精确复用已保存 Workflow
npm run test:live:workflow-modify # 修改得到 v2、保留 v1，再精确复用 v2
```

### Live 测试自定义 Provider

`test:live*` 默认使用本机 `~/.pi/agent` 凭据和 `octopus-anthropic` provider。
设置以下环境变量后，会在临时 agent 目录写入 pi models.json 的 `providers` 段并
通过 `PI_CODING_AGENT_DIR` 重定向，把测试指向任意 OpenAI 兼容 / Anthropic 兼容端点
（结构与 pi `docs/models.md` 一致，`AGENTFLUX_LIVE_API_KEY` 对应 `apiKey` 字段，
可用字面量或 `$ENV` 引用）：

```bash
AGENTFLUX_LIVE_BASE_URL=https://api.example.com/v1 \
AGENTFLUX_LIVE_API=openai-completions \
AGENTFLUX_LIVE_API_KEY=sk-xxx \
AGENTFLUX_LIVE_MODEL_PRO=my-model \
AGENTFLUX_LIVE_MODEL_FLASH=my-model \
AGENTFLUX_LIVE_THINKING=off \
AGENTFLUX_LIVE_CASES=direct,team \
AGENTFLUX_LIVE_PROVIDER_ID=agentflux-ci \
  npm run test:live
```

- `AGENTFLUX_LIVE_BASE_URL`：自定义端点 baseUrl；设置后 provider 切换到自定义端点，否则使用本机默认。
- `AGENTFLUX_LIVE_API`：api 类型，默认 `openai-completions`（也支持 `openai-responses`、`anthropic-messages` 等）。
- `AGENTFLUX_LIVE_API_KEY`：API key，可省略（改用 `--api-key` 或 `/login` 凭据）。
- `AGENTFLUX_LIVE_MODEL_PRO` / `AGENTFLUX_LIVE_MODEL_FLASH`：高/低能力模型名，默认 `deepseek-v4-pro` / `deepseek-v4-flash`。
- `AGENTFLUX_LIVE_THINKING`：思考等级，默认 `off`（`off|minimal|low|medium|high|xhigh|max`）。
- `AGENTFLUX_LIVE_CASES`：core smoke 的用例子集，默认 `direct,team,workflow,community`。
- `AGENTFLUX_LIVE_PROVIDER_ID`：provider id，默认 `agentflux-ci`。

CI 中可通过仓库 `.github/workflows/live.yml` 手动触发（workflow_dispatch）或定时
（schedule + `AGENTFLUX_LIVE_*` Secrets）运行真实链路测试。

### 精确 Team 调度

Team 并行调度统一通过 `flux_team` 工具（Main 驱动）入口执行；结构化自动化场景可复用同一能力契约，不再提供独立的 host 调度入口。

`spec.tasks` 就是实际启动的 Agent 清单，不再经过 Main 模型二次改写。每项可固定 `workspace`、`lockFiles`、`model`、`provider`、`thinking`、`maxTurns`、`maxInputTokens` 和 `completionProof`；相对 `lockFiles` 与完成凭证文件均以目标 workspace 为基准。顶层可提供稳定 `taskId`、`sessionId` 和面向用户的 `task` 摘要。Host 会登记父 Team task 与成员，并将成功、校验异常、子进程失败、全部超时或全部取消分别收敛到明确终态，不依赖调用脚本补写状态。AgentFlux 的任务、消息、生命周期与 telemetry 仍写入控制项目的 `.agentflux`，子进程只在目标 workspace 工作。精确调度默认 `maxRetries=0`，只有 spec 显式设置时才重试。测试任务应设置顶层 `executionProfile: "low_cost_test"`：它会强制使用 `deepseek-v4-flash`、`octopus-completions`、`thinking=off`、最多 6 轮和 12000 input token，并保留调用方设置的更严格上限。

精确调度用于“调用参数必须原样执行”的场景；自然语言 `flux_team` 仍适合由 Main Agent 自主拆分职责。`edit`/`write` 会拒绝修改未声明文件；这不是 OS 沙箱，允许 `bash` 的角色仍应只用于可信任务。轮次或输入 token 达到硬上限时任务以 exit 74 结束且不重试。声明 `completionProof.files[].contains` 后，模型即使正常结束也必须通过文件事实检查，否则以 exit 75 拒绝假成功；只有 exit 74 可由通过的完成凭证恢复为成功，provider、权限、通信等其他错误不会被覆盖。

当前完成度、测试证据与明确限制见 [实现状态](docs/26-implementation-status.md)。架构决策见 [Agent 生命周期与工作方式](docs/28-agent-workstyle-redesign.md)。
