# 09 - 技术栈选型与主流框架调研

## 决策结论

**技术栈**:TypeScript(pi extension/编排层)+ Python(路由决策 sidecar,Phase 3 引入)
**集成目标**:内置 pi
**TUI**:复用 pi 原生 TUI + extension 增强(不用 Electron / 不重写 TUI)

理由见 [10-pi-integration](10-pi-integration.md)。本章先给调研依据。

---

## 一、主流 Agent 框架对比

### 核心对比(2026-04 多源汇总)

| | Claude Code | Codex CLI | Cline | OpenCode | Cursor | **pi** |
|---|---|---|---|---|---|---|
| 厂商 | Anthropic | OpenAI | 社区 OSS | 社区 OSS | Anysphere | earendil-works |
| 语言 | TypeScript | Rust + TS | TypeScript | Go | Electron TS | TypeScript |
| 界面 | CLI + SDK + IDE | CLI (Rust TUI) | VS Code ext | CLI (TUI) | IDE fork | CLI (React/Ink TUI) + SDK + RPC |
| 模型 | Claude only | OpenAI only | 50+ providers | Anthropic+OpenAI | 多模型 | 多 provider + 订阅/API key |
| 体量 | ~500K LOC | ~80K | ~150K | ~30K | - | minimal |
| 许可 | 专有 | Apache 2.0 | Apache 2.0 | MIT | 专有 | (pi 包) |
| 安全 | permission + hooks | OS 级 sandbox | UI approval | channel approval | editor 模型 | permission + hooks + project trust |
| Context 管理 | 多策略 compaction | auto + truncation | sliding window + summary | SQLite sessions + summary | - | tree + compaction(可 hook) |
| Sub-agent | full multi-agent teams | full + guardian | sub-agent | task sub-agents | background agents | **故意不做,留 extension**(有示例) |
| 文件编辑 | search-and-replace | unified diff | full rewrite or diff | line-range | - | search-and-replace |
| Session 持久化 | JSON transcript | JSONL resume | VS Code state | SQLite | - | **JSONL tree** |
| TUI 框架 | React/Ink | ratatui | VS Code Webview | Bubbletea | Electron | React/Ink |

来源:Haseeb-Qureshi 源码分析 gist、aicatchup、developersdigest、morphllm、requesty、codex.danielvaughan 收敛性分析。

### 关键洞察

1. **所有 agent 收敛到同一 ReAct pipeline**(observe-act-reflect)。13 个 agent 源码分析:7/13 用 sequential ReAct,其余变体同构。真正的差异不在 model,在 model 周围:**sandboxing、context 管理、plugin/composition、config/governance**。

2. **pi 的定位最契合 AgentFlux**:pi 是 minimal harness,核心理念"adapt pi to your workflows, not the other way around, without forking"。**故意不做 subagent 和 plan mode,留给 extension**——这恰好给 AgentFlux 留出了编排层的位置。其他框架要么锁死 subagent 实现(难以注入路由决策),要么体量过大(500K LOC 难以掌控)。

3. **pi 的可扩展性最强**:extension(全生命周期 hook)+ skill + prompt template + theme + package(npm/git 分发)+ 四种运行模式(interactive/print/json/rpc)+ SDK 嵌入。AgentFlux 几乎所有概念都能映射到 pi 的某个 hook(见 [10](10-pi-integration.md))。

### 为什么选 pi 不选其他

| 候选 | 否决理由 |
|---|---|
| Claude Code | 专有源码,无法深度定制路由;subagent 锁死其 teams 实现 |
| Codex CLI | Rust + OS sandbox,扩展生态弱;OpenAI only |
| OpenCode | Go,与 Python/TS 路由层集成成本高;体量小但生态薄 |
| Cursor | 闭源 IDE fork,不是可编程 harness |
| Cline | VS Code 扩展,脱离 IDE 难独立运行 |
| **pi** | ✅ TS 同栈、minimal 可掌控、extension-first、原生 session tree、RPC 跨语言、有 subagent/handoff 示例 |

---

## 二、aionui / paperclip 调研

用户考察了这两个项目,以为是 electron。实际有差异,需澄清。

### AionUi(iOfficeAI/AionUi)

- **形态**:Electron + React 桌面 app,Apache-2.0,~29K stars,TypeScript
- **定位**:"统一管理多个 AI coding agent 的 Cowork 桌面 app"
- **能力**:
  - auto-detect 本机 CLI(Claude Code/Codex/Gemini CLI/OpenCode/OpenClaw/Goose/Copilot 等 20+)
  - 20+ 模型平台(含国内 Dashscope/Zhipu/Moonshot,本地 Ollama)
  - MCP 配置一次,所有 agent 同步
  - 12+ 内置 assistant(PPT/Excel/Word/UI/UX 等)
  - 定时任务(自然语言转 cron,24/7,结果推 Telegram/飞书/钉钉)
  - 预览面板
- **本质**:**多 agent 的统一 UI 壳 + MCP 统一配置 + 定时调度**。不做路由决策,不做 context/cache 优化,不做工作模式选择。

### Paperclip(paperclipai/paperclip)

- **形态**:**Node.js server + React UI(不是 electron!)**,MIT,~70K stars,TypeScript。可手机访问。
- **定位**:"管理 AI agents for work 的 app","If OpenClaw is an employee, Paperclip is the company"
- **能力**:
  - Bring Your Own Agent(OpenClaw/Claude Code/Codex/Cursor/Bash/HTTP,"if it can receive a heartbeat, it's hired")
  - org chart(组织架构)、roles、reporting lines
  - goal alignment(任务追溯回公司 mission)
  - heartbeats(agent 按计划唤醒,检查工作,act)
  - cost control(每月每 agent 预算,到限即停)
  - multi-company(一部署多公司,数据隔离)
  - ticket system(对话可追溯,决策可解释)
- **本质**:**agent 编排成"公司组织架构"的业务层**,偏组织治理 + 预算 + 调度,不是技术路由层。
- 注:fredruss/agent-paperclip 是另一个项目(桌面 companion,27 stars),勿混淆。

### 与 AgentFlux 的层次关系

| 项目 | 层次 | 核心问题 |
|---|---|---|
| **Paperclip** | 业务编排层 | 多 agent 如何像公司一样协作、预算、治理 |
| **AionUi** | 统一入口/壳层 | 多 agent 如何在一个 UI 里管理和调度 |
| **AgentFlux** | **技术决策层** | **单 agent 内的工作模式路由 + context/cache 优化** |

三者不冲突,层次不同:
- AgentFlux 是 pi 之上的能力增强(让单个 pi 知道何时该 fork、何时该 compact、何时该切 model)
- AionUi/Paperclip 可以把增强后的 pi 作为一个 agent 纳入管理
- Paperclip 的 agent 级 budget 理念与 AgentFlux 的 task 级预算路由相通,但粒度不同

**结论**:AgentFlux 不与 aionui/paperclip 竞争,而是填补它们都未覆盖的"单 agent 内工作模式路由 + cache 优化"这一层。

---

## 三、技术栈最终选择

### 语言分工

| 层 | 语言 | 理由 |
|---|---|---|
| pi extension / 编排 / TUI | **TypeScript** | pi 同栈,直接用 extension API + TUI 组件,无跨语言开销 |
| 路由决策(ILP/RL/复杂度分析) | **Python** | ortools/pulp(ILP)、stable-baselines(RL)、ast/networkx(复杂度)生态强 |
| 通信 | stdio JSON / HTTP | extension 调 Python sidecar |

### 渐进引入策略(关键)

**Phase 1–2 纯 TS,Phase 3 才引入 Python**:
- Phase 1(前缀布局 + mask):用 `before_agent_start` + `context` 事件,纯 TS,不需要 Python
- Phase 2(静态路由 + fork):硬编码规则 + pi fork API,纯 TS 够用
- Phase 3(ILP 预算 + RL 经验):才需要 Python 的优化/学习生态,此时引入 sidecar

这样避免过早引入跨语言复杂度,Phase 1/2 能快速验证。

### TUI 方案:复用 pi 原生

- **不**用 Electron(重,且 pi 是终端 harness)
- **不**用 Python 重写 TUI(pi RPC 模式下 custom TUI 组件是 no-op,等于放弃 pi 资产)
- **用** pi interactive mode + extension 增强:`setWidget`(todo/进度)、`setFooter`(cache hit rate/mode 指示)、`custom`/overlay(模式选择器、决策确认)、`setStatus`
- pi TUI 已有 SelectList/SettingsList/BorderedLoader 等组件,覆盖 90% 需求

### 不选 Electron 的理由(对 aionui 路线的回应)

aionui 走 Electron 是因为它要统一管理 20+ 异构 CLI agent,需要跨进程 GUI 容器。AgentFlux 只内置 pi 一个 agent,目标是增强 pi 而非管理多 agent,终端 TUI 足够且更轻、更贴合 pi 哲学。若未来要兼容多 agent,可再考虑 web UI,但不是初期目标。
