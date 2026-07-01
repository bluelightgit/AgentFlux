/**
 * 共享黑板 — 多 agent 协作的共享状态层
 * 文档依据: docs/19-multi-agent-architecture.md
 *
 * 目录结构:
 *   .agentflux/shared/
 *     blackboard.json   — 全局状态
 *     tasks/            — 任务队列
 *     handoffs/         — 交接文档
 *     decisions/        — 决策记录
 *
 * 设计: 文件-based, 不做 IPC, 可审计, git 友好
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────── 类型 ────────────────────────────────

export interface AgentStatus {
	status: "idle" | "running" | "blocked" | "done" | "failed";
	workingOn?: string;          // task ID
	waitingFor?: string;         // 实例名
	output?: string;             // 产出物路径
}

export interface Blackboard {
	project: string;
	currentMode: string;
	sharedContext: {
		goal?: string;
		constraints?: string[];
		decidedArchitecture?: string;
	};
	agentStatuses: Record<string, AgentStatus>;
	updatedAt: string;
}

export interface Task {
	id: string;
	title: string;
	assignedTo?: string;         // 实例名
	status: "pending" | "in_progress" | "done" | "blocked";
	dependsOn: string[];         // task IDs
	createdAt: string;
	inputHandoff?: string;       // handoff 文件路径
	acceptanceCriteria: string[];
}

export interface Decision {
	id: string;
	by: string;                  // 实例名
	type: string;                // "review_verdict" | "architecture" | ...
	verdict?: string;
	issues?: string[];
	suggestions?: string[];
	timestamp: string;
}

// M4-2: agent 间消息传递

export interface AgentMessage {
	id: string;
	from: string;                // 发送者实例名
	to: string;                   // 接收者实例名 或 "broadcast"
	type: string;                // "task_update" | "question" | "result" | "handoff"
	content: string;
	timestamp: string;
	read: boolean;                // 接收者是否已读
}

// ── 群组/频道系统 ──

export type GroupType = "all" | "team" | "direct";

export interface AgentGroup {
	id: string;                  // 群组 ID (如 "all", "team-impl", "direct-planner-reviewer")
	name: string;                // 显示名
	type: GroupType;             // all=大群, team=小群, direct=私聊
	members: string[];           // agent 名称列表
	created: string;
	createdBy: string;
	description?: string;
}

export interface GroupMessage {
	id: string;
	groupId: string;
	from: string;
	content: string;
	timestamp: string;
}

// ── Agent 注册表 ──

export interface AgentInfo {
	name: string;
	role: string;                // planner/implementer/reviewer/tester/designer
	status: "idle" | "running" | "blocked" | "done" | "failed";
	currentTask?: string;
	model?: string;
	provider?: string;
	sessionFile?: string;
	thinking?: string;
	lastSeen: string;
	registeredAt: string;
}

// ──────────────────────────────── 黑板 ────────────────────────────────

export class SharedBoard {
	private readonly sharedDir: string;

	constructor(fluxDir: string) {
		this.sharedDir = join(fluxDir, "shared");
		this.ensureDirs();
	}

	private ensureDirs(): void {
		for (const sub of ["", "tasks", "handoffs", "decisions", "messages", "groups", "agents"]) {
			const dir = join(this.sharedDir, sub);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}
	}

	// ── Blackboard ──

	getBlackboard(): Blackboard {
		const path = join(this.sharedDir, "blackboard.json");
		if (!existsSync(path)) {
			return {
				project: "",
				currentMode: "",
				sharedContext: {},
				agentStatuses: {},
				updatedAt: new Date().toISOString(),
			};
		}
		return JSON.parse(readFileSync(path, "utf-8"));
	}

	saveBlackboard(bb: Blackboard): void {
		bb.updatedAt = new Date().toISOString();
		writeFileSync(join(this.sharedDir, "blackboard.json"), JSON.stringify(bb, null, 2));
	}

	updateAgentStatus(name: string, status: AgentStatus): void {
		const bb = this.getBlackboard();
		bb.agentStatuses[name] = status;
		this.saveBlackboard(bb);
	}

	setSharedContext(ctx: Partial<Blackboard["sharedContext"]>): void {
		const bb = this.getBlackboard();
		bb.sharedContext = { ...bb.sharedContext, ...ctx };
		this.saveBlackboard(bb);
	}

	// ── Tasks ──

	createTask(task: Omit<Task, "id" | "createdAt">): Task {
		const existing = this.listTasks();
		const num = existing.length + 1;
		const id = `task-${String(num).padStart(3, "0")}`;
		const full: Task = { ...task, id, createdAt: new Date().toISOString() };
		writeFileSync(join(this.sharedDir, "tasks", `${id}.json`), JSON.stringify(full, null, 2));
		return full;
	}

	getTask(id: string): Task | null {
		const path = join(this.sharedDir, "tasks", `${id}.json`);
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8"));
	}

	listTasks(): Task[] {
		const dir = join(this.sharedDir, "tasks");
		if (!existsSync(dir)) return [];
		const { readdirSync } = require("node:fs");
		return readdirSync(dir)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => JSON.parse(readFileSync(join(dir, f), "utf-8")))
			.sort((a: Task, b: Task) => a.createdAt.localeCompare(b.createdAt));
	}

	updateTask(id: string, updates: Partial<Task>): void {
		const task = this.getTask(id);
		if (!task) return;
		writeFileSync(join(this.sharedDir, "tasks", `${id}.json`), JSON.stringify({ ...task, ...updates }, null, 2));
	}

	// ── Handoffs ──

	writeHandoff(from: string, to: string, content: string): string {
		const filename = `${from}→${to}.md`;
		writeFileSync(join(this.sharedDir, "handoffs", filename), content);
		return `handoffs/${filename}`;
	}

	readHandoff(from: string, to: string): string | null {
		const path = join(this.sharedDir, "handoffs", `${from}→${to}.md`);
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf-8");
	}

	listHandoffs(): string[] {
		const dir = join(this.sharedDir, "handoffs");
		if (!existsSync(dir)) return [];
		const { readdirSync } = require("node:fs");
		return readdirSync(dir).filter((f: string) => f.endsWith(".md"));
	}

	// ── M4-2: Messages (agent 间消息传递) ──

	sendMessage(from: string, to: string, type: string, content: string): AgentMessage {
		const existing = this.listMessages();
		const num = existing.length + 1;
		const id = `msg-${String(num).padStart(3, "0")}`;
		const msg: AgentMessage = {
			id, from, to, type, content,
			timestamp: new Date().toISOString(),
			read: false,
		};
		// 文件名: {id}__{from}→{to}.json (便于按收件人过滤)
		const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
		const filename = `${id}__${safeName(from)}→${safeName(to)}.json`;
		writeFileSync(join(this.sharedDir, "messages", filename), JSON.stringify(msg, null, 2));
		return msg;
	}

	/** 获取指定 agent 的收件箱 (发给它的 + 广播) */
	getInbox(agentName: string): AgentMessage[] {
		const dir = join(this.sharedDir, "messages");
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as AgentMessage)
			.filter((m: AgentMessage) => m.to === agentName || m.to === "broadcast")
			.sort((a: AgentMessage, b: AgentMessage) => a.timestamp.localeCompare(b.timestamp));
	}

	/** 获取未读消息 */
	getUnreadMessages(agentName: string): AgentMessage[] {
		return this.getInbox(agentName).filter(m => !m.read);
	}

	/** 标记消息为已读 */
	markMessageRead(msgId: string): void {
		const dir = join(this.sharedDir, "messages");
		if (!existsSync(dir)) return;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json") || !file.startsWith(msgId)) continue;
			const path = join(dir, file);
			const msg = JSON.parse(readFileSync(path, "utf-8")) as AgentMessage;
			msg.read = true;
			writeFileSync(path, JSON.stringify(msg, null, 2));
			break;
		}
	}

	/** 列出所有消息 */
	listMessages(): AgentMessage[] {
		const dir = join(this.sharedDir, "messages");
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as AgentMessage)
			.sort((a: AgentMessage, b: AgentMessage) => a.timestamp.localeCompare(b.timestamp));
	}

	// ── M4-3: Task Queue (任务队列消费) ──

	/** 认领一个就绪任务 (依赖已完成, 状态为 pending) */
	claimNextTask(agentName: string): Task | null {
		const tasks = this.listTasks();
		for (const task of tasks) {
			if (task.status !== "pending") continue;
			// 检查依赖是否都完成
			const depsDone = task.dependsOn.every(depId => {
				const dep = this.getTask(depId);
				return dep?.status === "done";
			});
			if (!depsDone) continue;
			// 认领任务
			this.updateTask(task.id, { status: "in_progress", assignedTo: agentName });
			return this.getTask(task.id);
		}
		return null;
	}

	/** 完成任务并通知依赖者 (M4-4: 状态同步) */
	completeTask(taskId: string, result: { output?: string; verdict?: string }): void {
		this.updateTask(taskId, { status: "done" });
		const task = this.getTask(taskId);
		if (!task) return;

		// M4-4: 通知依赖此任务的其他 agent
		const allTasks = this.listTasks();
		for (const dependent of allTasks) {
			if (dependent.dependsOn.includes(taskId) && dependent.status === "blocked") {
				// 检查是否所有依赖都完成了
				const allDepsDone = dependent.dependsOn.every(d => this.getTask(d)?.status === "done");
				if (allDepsDone) {
					this.updateTask(dependent.id, { status: "pending" }); // 解锁
				}
			}
		}

		// M4-2: 发送结果消息给广播
		if (task.assignedTo) {
			this.sendMessage(task.assignedTo, "broadcast", "task_complete",
				`Task ${taskId} completed. ${result.verdict ? `Verdict: ${result.verdict}.` : ""} ${result.output ? `Output: ${result.output.slice(0, 200)}` : ""}`);
		}
	}

	// ── Decisions ──

	writeDecision(decision: Omit<Decision, "id" | "timestamp">): Decision {
		const existing = this.listDecisions();
		const num = existing.length + 1;
		const id = `decision-${String(num).padStart(3, "0")}`;
		const full: Decision = { ...decision, id, timestamp: new Date().toISOString() };
		writeFileSync(join(this.sharedDir, "decisions", `${id}.json`), JSON.stringify(full, null, 2));
		return full;
	}

	listDecisions(): Decision[] {
		const dir = join(this.sharedDir, "decisions");
		if (!existsSync(dir)) return [];
		const { readdirSync } = require("node:fs");
		return readdirSync(dir)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => JSON.parse(readFileSync(join(dir, f), "utf-8")))
			.sort((a: Decision, b: Decision) => a.timestamp.localeCompare(b.timestamp));
	}

	// ── 群组/频道系统 ──

	/** 创建群组 */
	createGroup(name: string, members: string[], type: GroupType, createdBy: string, description?: string): AgentGroup {
		const registry = this.listGroups();
		const num = registry.length + 1;
		const id = type === "all" ? "all" : `${type}-${String(num).padStart(2, "0")}`;
		const group: AgentGroup = {
			id, name, type, members, description,
			created: new Date().toISOString(),
			createdBy,
		};
		writeFileSync(join(this.sharedDir, "groups", "_registry.json"), JSON.stringify([...registry, group], null, 2));
		// 创建群组消息目录
		mkdirSync(join(this.sharedDir, "groups", id), { recursive: true });
		return group;
	}

	/** 列出所有群组 */
	listGroups(): AgentGroup[] {
		const path = join(this.sharedDir, "groups", "_registry.json");
		if (!existsSync(path)) return [];
		return JSON.parse(readFileSync(path, "utf-8"));
	}

	/** 获取 agent 所在的群组 */
	getGroupsForAgent(agentName: string): AgentGroup[] {
		return this.listGroups().filter(g => g.members.includes(agentName) || g.type === "all");
	}

	/** 向群组发送消息 */
	sendGroupMessage(from: string, groupId: string, content: string): GroupMessage {
		const groups = this.listGroups();
		const group = groups.find(g => g.id === groupId);
		if (!group) throw new Error(`Group ${groupId} not found`);
		if (!group.members.includes(from) && group.type !== "all") {
			throw new Error(`${from} is not a member of group ${groupId}`);
		}

		const groupDir = join(this.sharedDir, "groups", groupId);
		if (!existsSync(groupDir)) mkdirSync(groupDir, { recursive: true });

		const msgFile = join(groupDir, "messages.jsonl");
		const existing = existsSync(msgFile) ? readFileSync(msgFile, "utf-8").trim().split("\n").filter(Boolean) : [];
		const num = existing.length + 1;
		const msg: GroupMessage = {
			id: `gm-${groupId}-${String(num).padStart(3, "0")}`,
			groupId, from, content,
			timestamp: new Date().toISOString(),
		};
		appendFileSync(msgFile, JSON.stringify(msg) + "\n");
		return msg;
	}

	/** 获取群组消息 (支持 sinceTs 增量读取) */
	getGroupMessages(groupId: string, sinceTs?: string): GroupMessage[] {
		const msgFile = join(this.sharedDir, "groups", groupId, "messages.jsonl");
		if (!existsSync(msgFile)) return [];
		const lines = readFileSync(msgFile, "utf-8").trim().split("\n").filter(Boolean);
		const msgs = lines.map(l => JSON.parse(l) as GroupMessage);
		if (sinceTs) return msgs.filter(m => m.timestamp > sinceTs);
		return msgs;
	}

	/** 获取 agent 在所有群组中的未读消息 */
	getGroupInbox(agentName: string): Array<{ group: AgentGroup; messages: GroupMessage[] }> {
		const groups = this.getGroupsForAgent(agentName);
		return groups.map(group => ({
			group,
			messages: this.getGroupMessages(group.id),
		}));
	}

	/** 确保 "all" 大群存在 (包含指定 agents) */
	ensureAllGroup(agentNames: string[], createdBy = "system"): AgentGroup {
		const groups = this.listGroups();
		let allGroup = groups.find(g => g.id === "all");
		if (!allGroup) {
			allGroup = this.createGroup("All Agents", [...new Set(agentNames)], "all", createdBy, "全 agent 公开沟通频道");
		} else {
			// 合并新成员
			const merged = [...new Set([...allGroup.members, ...agentNames])];
			if (merged.length !== allGroup.members.length) {
				allGroup.members = merged;
				const updated = groups.map(g => g.id === "all" ? allGroup! : g);
				writeFileSync(join(this.sharedDir, "groups", "_registry.json"), JSON.stringify(updated, null, 2));
			}
		}
		return allGroup;
	}

	// ── Agent 注册表 ──

	/** 注册或更新 agent 信息 */
	registerAgent(info: Omit<AgentInfo, "registeredAt" | "lastSeen"> & { registeredAt?: string; lastSeen?: string }): AgentInfo {
		const registry = this.listAgents();
		const existing = registry.find(a => a.name === info.name);
		const now = new Date().toISOString();
		const full: AgentInfo = {
			...existing,
			...info,
			registeredAt: existing?.registeredAt ?? info.registeredAt ?? now,
			lastSeen: now,
		};
		const updated = registry.filter(a => a.name !== info.name);
		updated.push(full);
		writeFileSync(join(this.sharedDir, "agents", "_registry.json"), JSON.stringify(updated, null, 2));
		return full;
	}

	/** 列出所有注册的 agent */
	listAgents(): AgentInfo[] {
		const path = join(this.sharedDir, "agents", "_registry.json");
		if (!existsSync(path)) return [];
		return JSON.parse(readFileSync(path, "utf-8"));
	}

	/** 更新 agent 状态/在线信息 */
	updateAgentPresence(name: string, updates: Partial<AgentInfo>): void {
		const registry = this.listAgents();
		const agent = registry.find(a => a.name === name);
		if (!agent) return;
		Object.assign(agent, updates, { lastSeen: new Date().toISOString() });
		writeFileSync(join(this.sharedDir, "agents", "_registry.json"), JSON.stringify(registry, null, 2));
	}

	/** 获取单个 agent 信息 */
	getAgent(name: string): AgentInfo | null {
		return this.listAgents().find(a => a.name === name) ?? null;
	}

	// ── 路径 ──

	get path(): string {
		return this.sharedDir;
	}
}

// ──────────────────────────────── Handoff 生成 ────────────────────────────────

export function generateHandoffContent(
	from: string,
	to: string,
	task: string,
	details: {
		context?: string;
		plan?: string[];
		filesToRead?: string[];
		acceptanceCriteria?: string[];
		output?: string;
	},
): string {
	const lines = [`# Handoff: ${from} → ${to}`, "", "## Task", task, ""];

	if (details.context) {
		lines.push("## Context", details.context, "");
	}
	if (details.plan && details.plan.length > 0) {
		lines.push("## Plan");
		for (const step of details.plan) lines.push(`- ${step}`);
		lines.push("");
	}
	if (details.filesToRead && details.filesToRead.length > 0) {
		lines.push("## Files to Read");
		for (const f of details.filesToRead) lines.push(`- ${f}`);
		lines.push("");
	}
	if (details.acceptanceCriteria && details.acceptanceCriteria.length > 0) {
		lines.push("## Acceptance Criteria");
		for (const c of details.acceptanceCriteria) lines.push(`- ${c}`);
		lines.push("");
	}
	if (details.output) {
		lines.push("## Output", details.output, "");
	}

	return lines.join("\n");
}

// ──────────────────────────────── 格式化 ────────────────────────────────

export function formatBlackboard(bb: Blackboard): string {
	const lines = ["Blackboard:", ""];
	lines.push(`  project: ${bb.project || "(unset)"}`);
	lines.push(`  mode: ${bb.currentMode || "(unset)"}`);
	if (bb.sharedContext.goal) lines.push(`  goal: ${bb.sharedContext.goal}`);
	if (bb.sharedContext.constraints?.length) {
		lines.push(`  constraints: ${bb.sharedContext.constraints.join(", ")}`);
	}
	lines.push("");
	lines.push("  Agents:");
	for (const [name, status] of Object.entries(bb.agentStatuses)) {
		const icon = { idle: "○", running: "●", blocked: "⚠", done: "✓", failed: "✗" }[status.status] ?? "?";
		lines.push(`    ${icon} ${name}: ${status.status}${status.workingOn ? ` (${status.workingOn})` : ""}`);
	}
	return lines.join("\n");
}

export function formatMessages(msgs: AgentMessage[]): string {
	if (msgs.length === 0) return "No messages.";
	const lines = ["Messages:", ""];
	for (const m of msgs) {
		const readIcon = m.read ? "✓" : "●";
		lines.push(`  ${readIcon} ${m.id}: ${m.from}→${m.to} [${m.type}] ${m.content.slice(0, 80)}`);
	}
	return lines.join("\n");
}

export function formatTaskList(tasks: Task[]): string {
	if (tasks.length === 0) return "No tasks.";
	const lines = ["Tasks:", ""];
	for (const t of tasks) {
		const icon = { pending: "○", in_progress: "●", done: "✓", blocked: "⚠" }[t.status] ?? "?";
		lines.push(`  ${icon} ${t.id}: ${t.title}`);
		if (t.assignedTo) lines.push(`    assigned: ${t.assignedTo}`);
		if (t.dependsOn.length > 0) lines.push(`    depends: ${t.dependsOn.join(", ")}`);
	}
	return lines.join("\n");
}

// ── 群组格式化 ──

export function formatGroups(groups: AgentGroup[]): string {
	if (groups.length === 0) return "No groups.";
	const lines = ["Groups:", ""];
	for (const g of groups) {
		const typeIcon = { all: "📢", team: "👥", direct: "💬" }[g.type];
		lines.push(`  ${typeIcon} ${g.id}: ${g.name} [${g.type}] (${g.members.length} members: ${g.members.join(", ")})`);
	}
	return lines.join("\n");
}

export function formatGroupMessages(msgs: GroupMessage[]): string {
	if (msgs.length === 0) return "No group messages.";
	const lines = ["Group Messages:", ""];
	for (const m of msgs) {
		lines.push(`  ${m.timestamp.slice(11, 19)} ${m.from}: ${m.content.slice(0, 120)}`);
	}
	return lines.join("\n");
}

export function formatAgents(agents: AgentInfo[]): string {
	if (agents.length === 0) return "No registered agents.";
	const lines = ["Agents:", ""];
	for (const a of agents) {
		const icon = { idle: "○", running: "●", blocked: "⚠", done: "✓", failed: "✗" }[a.status] ?? "?";
		lines.push(`  ${icon} ${a.name} (${a.role}) — ${a.status}`);
		if (a.currentTask) lines.push(`    task: ${a.currentTask.slice(0, 80)}`);
		if (a.model) lines.push(`    model: ${a.model}${a.thinking ? ` [${a.thinking}]` : ""}`);
	}
	return lines.join("\n");
}
