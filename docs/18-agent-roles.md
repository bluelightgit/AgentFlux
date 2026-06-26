# 18 - Agent 角色设计

> 角色不是硬编码的,是用户定义的模板。AgentFlux 提供基础模板,用户可自定义任意角色,运行时按需实例化。

## 设计目标

1. **不锁定角色**:用户可以定义任意角色,不只限于 planner/implementer/reviewer/tester
2. **不锁定模型**:角色可以通过能力需求向量让系统选模型,也可以直接指定模型
3. **模板与实例分离**:角色定义是模板,运行时创建的是实例 (同一角色可多实例并行)
4. **可自定义工具和 skill**:不同角色有不同的工具权限和 skill 配置

## 角色定义 (模板)

角色定义放在 `.agentflux/models.json` 的 `roles` 字段,或 `.agentflux/agents/*.md` 文件。

### JSON 格式 (models.json roles 字段)

```json
{
  "roles": {
    "planner": {
      "requirement": { "coding": 0.3, "reasoning": 0.9, "speed": 0.2, "context": 0.7, "cost_eff": 0.3 },
      "tools": ["read", "grep", "find", "ls", "bash"],
      "skills": ["planning"],
      "systemPrompt": "You are a senior planner. Analyze requirements, break down tasks, output implementation plan."
    },
    "implementer": {
      "model": "deepseek-v4-flash",
      "tools": ["read", "write", "edit", "bash", "grep", "find"],
      "skills": ["coding-patterns"],
      "systemPrompt": "You are a senior developer. Write clean, tested code."
    },
    "reviewer": {
      "requirement": { "coding": 0.7, "reasoning": 0.8, "cost_eff": 0.4 },
      "tools": ["read", "grep", "bash"],
      "skills": ["code-review"],
      "systemPrompt": "You are a code reviewer. Focus on correctness, security, maintainability."
    },
    "tester": {
      "requirement": { "coding": 0.7, "reasoning": 0.5, "speed": 0.5, "cost_eff": 0.6 },
      "tools": ["read", "write", "edit", "bash"],
      "systemPrompt": "You are a test engineer. Write comprehensive tests."
    }
  },
  "sharedSkills": ["project-context", "git-workflow"]
}
```

### MD 格式 (.agentflux/agents/*.md)

兼容 pi subagent 示例的 .md 格式,但扩展了 frontmatter:

```markdown
---
name: security-auditor
description: Security vulnerability scanner
tools: read, grep, bash
model: gpt-5.5
skills: security-checklist
---
You are a security auditor. Focus on: injection, auth bypass, data leaks.
Output: ## Critical / ## Warnings / ## Safe patterns / ## Summary
```

MD 格式的 frontmatter 字段:
- `name` (必填): 角色名
- `description` (可选): 一句话描述
- `tools` (可选): 逗号分隔的工具列表
- `model` (可选): 直接指定模型 (与 `requirement` 二选一)
- `requirement` (可选): JSON 格式的能力需求向量 (与 `model` 二选一)
- `skills` (可选): 逗号分隔的 skill 列表

MD body 作为 `systemPrompt`。

### 两种格式的关系

- MD 格式优先 (用户更熟悉,pi 生态兼容)
- JSON 格式是完整版 (支持 requirement 向量等扩展字段)
- 加载时 MD 被解析成与 JSON 相同的内部结构
- 同名时 MD 文件覆盖 JSON roles 字段中的定义

## 基础模板

内置 4 个基础模板 (作为 fallback,用户可覆盖):

| 角色 | 定位 | 默认模型选择 | 工具权限 |
|---|---|---|---|
| **planner** | 分析需求,拆解任务,输出计划 | reasoning 权重高 → 强模型 | 只读 |
| **implementer** | 写代码,跑测试 | cost_eff 权重高 → 快模型 | 可读写执行 |
| **reviewer** | 审查代码质量/安全/可维护性 | reasoning + coding 权重高 → 强模型 | 只读 |
| **tester** | 写测试用例,验证正确性 | coding + cost_eff 权重高 → 快模型 | 可写测试文件 |

### 内置 systemPrompt (精简版)

**planner**:
```
You are a senior planner. Analyze the requirement, break it down into implementation
steps, identify risks and dependencies. Output a structured plan with clear task
boundaries. Do not write implementation code.
```

**implementer**:
```
You are a senior developer. Implement the task according to the plan. Write clean,
maintainable code. Run tests to verify. If you encounter issues, document them.
```

**reviewer**:
```
You are a code reviewer. Review the diff for: correctness, security, performance,
maintainability. Output: ## Issues (must fix) / ## Suggestions (should consider) /
## Looks Good. Do not modify code directly.
```

**tester**:
```
You are a test engineer. Write comprehensive tests for the implementation. Cover
happy path, edge cases, and error handling. Run tests and report results.
```

## 角色实例化

角色定义是模板,运行时创建的是实例:

```
角色定义 (模板)          实例化 (运行时)
─────────────           ──────────────
planner          →     planner-1 (负责 API 设计)
planner          →     planner-2 (负责数据层设计)
implementer      →     impl-frontend
implementer      →     impl-backend
reviewer         →     reviewer-1
```

### 实例属性

| 属性 | 说明 |
|---|---|
| `name` | 唯一实例名 (用户指定或自动生成 `role-N`) |
| `role` | 引用的角色模板名 |
| `model` | 运行时解析出的实际模型 (亲和度匹配或直接指定) |
| `session` | 绑定的 pi session ID (每个实例独立 session) |
| `status` | idle / running / blocked / done / failed |
| `task` | 分配的任务描述 |
| `workingDir` | 工作目录 (默认项目根, 可选 worktree 隔离) |

### 实例注册表

运行时实例状态保存在 `.agentflux/runtime/registry.json`:

```json
{
  "instances": [
    {
      "name": "planner-1",
      "role": "planner",
      "model": "gpt-5.5",
      "session": "flux-team-planner-1",
      "status": "done",
      "task": "API 层设计",
      "createdAt": "2026-06-26T12:00:00Z",
      "output": "shared/handoffs/planner-1→impl-frontend.md"
    },
    {
      "name": "impl-frontend",
      "role": "implementer",
      "model": "deepseek-v4-flash",
      "session": "flux-team-impl-fe",
      "status": "running",
      "task": "前端实现",
      "createdAt": "2026-06-26T12:05:00Z"
    }
  ]
}
```

## 运行时检查

角色启动时的完整流程:

```
1. 加载角色定义 (从 models.json roles 或 .agentflux/agents/*.md)
2. 解析模型:
   a. role.model 存在 → 检查 model 在 models.json 中存在且 provider 可用
      → 可用: 使用该 model
      → 不可用: 如果有 requirement, 走亲和度; 否则报错
   b. role.requirement 存在 → 遍历 models.json 所有模型算亲和度, 取最高
   c. 都没有 → 报错 "角色必须指定 model 或 requirement"
3. 解析工具: role.tools 存在 → 限制子进程工具; 不存在 → 继承全部
4. 解析 skills: sharedSkills + role.skills 合并, 传给子进程 --skills
5. 创建实例记录, 写入 registry.json
6. 启动 pi 子进程 (独立 session)
7. 子进程加载 subagent-entry.ts (prefix layout, 不注册额外 tool)
8. 发送任务 prompt
9. 监控完成, 更新实例状态
```

## Agent 自创建角色 (未来方向)

呼应 Hermes Agent 的 self-improving 能力:

当主 agent 发现某个任务模式反复出现且值得固化 (例如 "每次 PR 都要先 lint 再审查"),它可以在 `.agentflux/agents/` 下生成新的角色 .md 文件。

触发条件 (初步):
- 同一操作序列出现 5+ 次 (参考 Hermes 的 skill 自动创建阈值)
- 错误恢复后形成的非显然工作流
- 用户纠正后学到的规范

这不是 Phase 2 的内容,但角色定义格式已经为此预留了空间——agent 只需要 write 一个 .md 文件。

## 命令

| 命令 | 功能 |
|---|---|
| `/flux roles` | 列出所有角色定义 + 解析出的模型 + 工具 |
| `/flux roles <name>` | 查看单个角色详情 |
| `/flux team status` | 显示所有实例状态 (来自 registry.json) |
| `/flux team plan <task>` | 创建 planner 实例分析任务 |
| `/flux team build <task>` | 创建 implementer 实例执行任务 |
| `/flux team review` | 创建 reviewer 实例审查当前变更 |

## 交叉引用

- 模型能力: [17](17-model-capability.md) — 亲和度匹配机制
- 多 agent 架构: [19](19-multi-agent-architecture.md) — 共享层和沟通机制
- subagent 实现: 代码 `src/extension/subagent.ts`
- 配置: [04](04-config-schema.md) — models.json 在配置体系中的位置
