# Multi-Agent UI Requirements

## 目标
为 Electron 应用添加多 agent 状态面板和群组聊天面板，让用户能观察 agent 之间的协作。

## 数据源 (SharedBoard 文件结构)

### Agent 注册表
路径: `.agentflux/shared/agents/_registry.json`
格式: `[{name, role, status, currentTask, model, provider, sessionFile, thinking, lastSeen, registeredAt}]`
- status: "idle" | "running" | "blocked" | "done" | "failed"

### 群组注册表
路径: `.agentflux/shared/groups/_registry.json`
格式: `[{id, name, type, members[], created, createdBy, description}]`
- type: "all" (大群) | "team" (小群) | "direct" (私聊)

### 群组消息
路径: `.agentflux/shared/groups/{groupId}/messages.jsonl`
格式: 每行一个 JSON: `{id, groupId, from, content, timestamp}`

### 1对1消息
路径: `.agentflux/shared/messages/` 目录
文件名: `{msgId}__{from}→{to}.json`
格式: `{id, from, to, type, content, timestamp, read}`

## 需要开发的组件

### 1. group-reader.ts (数据层)
- `listGroups(): Promise<AgentGroup[]>` — 读 groups/_registry.json
- `getGroupMessages(groupId): Promise<GroupMessage[]>` — 读 groups/{id}/messages.jsonl
- `listAgents(): Promise<AgentInfo[]>` — 读 agents/_registry.json
- `getDirectMessages(): Promise<AgentMessage[]>` — 读 messages/ 目录
- 所有读取通过 `window.api?.readFileContent` (Electron IPC) 或 async fetch
- 处理文件不存在的 fallback (返回空数组)

### 2. GroupChatPage.tsx (群组聊天页面)
- 左侧: 群组列表 (tabs: All / Team-1 / Direct / ...)
- 右侧: 聊天消息流 (sender name + timestamp + content)
- 自动滚动到底部
- 2s 轮询更新 (用 useLiveUpdate hook)
- 空状态: "No groups yet"

### 3. AgentRegistryPanel.tsx (Agent 状态面板)
- 表格: name | role | status (icon) | current task | model | thinking | last seen
- 状态 icon: ●running ✓done ✗failed ⚠blocked ○idle
- 2s 轮询更新
- 点击行展开详情

### 4. 集成 (Batch 2)
- AppShell sidebar 添加 "Chat" 导航项 (MessageCircle icon)
- App.tsx 添加 GroupChatPage 路由
- AgentsPage.tsx 顶部添加 AgentRegistryPanel
- dashboard-store.ts 添加 "chat" 到 PageName

## 设计约束
- 零 emoji, 全 Lucide SVG icons
- 暗色模式 dark: 变体
- 用 shared formatters (lib/format.ts)
- 用 shared UI 组件 (ui.tsx: Card, Badge, Icon, DataTable, EmptyState)
