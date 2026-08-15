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

import {
	readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync,
	unlinkSync, openSync, closeSync, realpathSync, renameSync,
} from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertSafeOpaqueId } from "./safe-path";
import { isProcessAlive, parseOwnerPid, stealStaleLock } from "./fs-lock";

const PROCESS_OWNER_ID = `${process.pid}-${randomUUID()}`;

// ──────────────────────────────── 类型 ────────────────────────────────

export interface AgentStatus {
	status: "idle" | "running" | "blocked" | "done" | "failed" | "cancelled" | "retry_wait";
	workingOn?: string;          // task ID
	waitingFor?: string;         // 实例名
	output?: string;             // 产出物路径
	updatedAt?: string;          // 终态 GC 依据；旧记录缺失时保守保留
}

export interface Blackboard {
	project: string;
	currentWorkStyle: string;
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
	status: "pending" | "in_progress" | "done" | "blocked" | "failed" | "cancelled" | "retry_wait";
	dependsOn: string[];         // task IDs
	createdAt: string;
	inputHandoff?: string;       // handoff 文件路径
	acceptanceCriteria: string[];
	attempts?: number;
	claimedAt?: string;
	completedAt?: string;
	retryAt?: string;
	error?: string;
	cancelReason?: string;
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

// Agent 间消息传递

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
	status: "idle" | "running" | "blocked" | "done" | "failed" | "cancelled";
	currentTask?: string;
	model?: string;
	provider?: string;
	sessionFile?: string;
	thinking?: string;
	/** Stable identity of a concrete long-lived runtime process. */
	instanceId?: string;
	/** PID is observational only; instanceId remains the ownership boundary. */
	runtimePid?: number;
	heartbeatAt?: string;
	lastSeen: string;
	registeredAt: string;
}

// ──────────────────────────────── 黑板 ────────────────────────────────

export class SharedBoard {
	private readonly sharedDir: string;
	private readonly projectRoot: string;

	constructor(fluxDir: string, options: { ensureDirs?: boolean } = {}) {
		this.sharedDir = join(fluxDir, "shared");
		this.projectRoot = dirname(resolve(fluxDir));
		if (options.ensureDirs !== false) this.ensureDirs();
	}

	private ensureDirs(): void {
		for (const sub of ["", "tasks", "handoffs", "decisions", "messages", "groups", "agents"]) {
			const dir = join(this.sharedDir, sub);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}
	}

	/** 同目录临时文件 + rename，避免读者观察到半截 JSON。 */
	private writeJsonAtomic(path: string, value: unknown): void {
		const tempPath = `${path}.${PROCESS_OWNER_ID}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf-8");
			renameSync(tempPath, path);
		} finally {
			try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
		}
	}

	/**
	 * 注册表/blackboard 的短临界区。竞争时有限重试，超时后 fail-closed，
	 * 不能继续用旧快照覆盖其他进程刚写入的数据。
	 */
	private withMutex<T>(name: string, operation: () => T, timeoutMs = 2_000): T {
		const deadline = Date.now() + timeoutMs;
		const waiter = new Int32Array(new SharedArrayBuffer(4));
		do {
			const release = this.tryAcquireMutex(name, Math.max(30_000, timeoutMs * 2));
			if (release) {
				try { return operation(); }
				finally { release(); }
			}
			Atomics.wait(waiter, 0, 0, 10);
		} while (Date.now() < deadline);
		throw new Error(`SharedBoard mutex timeout: ${name}`);
	}

	// ── Blackboard ──

	getBlackboard(): Blackboard {
		const path = join(this.sharedDir, "blackboard.json");
		if (!existsSync(path)) {
			return {
				project: "",
				currentWorkStyle: "",
				sharedContext: {},
				agentStatuses: {},
				updatedAt: new Date().toISOString(),
			};
		}
		return JSON.parse(readFileSync(path, "utf-8"));
	}

	saveBlackboard(bb: Blackboard): void {
		bb.updatedAt = new Date().toISOString();
		this.writeJsonAtomic(join(this.sharedDir, "blackboard.json"), bb);
	}

	updateAgentStatus(name: string, status: AgentStatus): void {
		this.withMutex("blackboard", () => {
			const bb = this.getBlackboard();
			bb.agentStatuses[name] = { ...status, updatedAt: new Date().toISOString() };
			this.saveBlackboard(bb);
		});
	}

	/** 只移除调用方指定且仍处于终态的黑板状态，避免 GC 快照竞争误删活跃 agent。 */
	pruneTerminalBlackboardStatuses(names: string[], dryRun = false): string[] {
		const requested = new Set(names);
		return this.withMutex("blackboard", () => {
			const bb = this.getBlackboard();
			const removed = Object.entries(bb.agentStatuses)
				.filter(([name, status]) => requested.has(name) && ["done", "failed", "cancelled"].includes(status.status))
				.map(([name]) => name);
			if (!dryRun && removed.length > 0) {
				for (const name of removed) delete bb.agentStatuses[name];
				this.saveBlackboard(bb);
			}
			return removed;
		});
	}

	setSharedContext(ctx: Partial<Blackboard["sharedContext"]>): void {
		this.withMutex("blackboard", () => {
			const bb = this.getBlackboard();
			bb.sharedContext = { ...bb.sharedContext, ...ctx };
			this.saveBlackboard(bb);
		});
	}

	// ── Tasks ──

	createTask(task: Omit<Task, "id" | "createdAt">): Task {
		const id = `task-${randomUUID()}`;
		const full: Task = { ...task, id, createdAt: new Date().toISOString() };
		this.writeJsonAtomic(join(this.sharedDir, "tasks", `${id}.json`), full);
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
		this.writeJsonAtomic(join(this.sharedDir, "tasks", `${id}.json`), { ...task, ...updates });
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

	// ── Messages ──

	sendMessage(from: string, to: string, type: string, content: string): AgentMessage {
		const id = `msg-${randomUUID()}`;
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
		this.withMutex("messages", () => {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".json") || !file.startsWith(msgId)) continue;
				const path = join(dir, file);
				if (!existsSync(path)) continue;
				const msg = JSON.parse(readFileSync(path, "utf-8")) as AgentMessage;
				msg.read = true;
				this.writeJsonAtomic(path, msg);
				break;
			}
		});
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

	/**
	 * 将已读的点对点消息移出活跃 inbox。广播和未读消息永不由该入口处理。
	 * 返回实际归档的消息，调用方可写入审计清单。
	 */
	archiveReadDirectMessages(messageIds: string[], archiveDir: string, dryRun = false): AgentMessage[] {
		const requested = new Set(messageIds);
		const dir = join(this.sharedDir, "messages");
		if (!existsSync(dir) || requested.size === 0) return [];
		return this.withMutex("messages", () => {
			const matched: Array<{ file: string; message: AgentMessage }> = [];
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".json")) continue;
				const path = join(dir, file);
				if (!existsSync(path)) continue;
				let message: AgentMessage;
				try { message = JSON.parse(readFileSync(path, "utf-8")) as AgentMessage; }
				catch { continue; }
				if (requested.has(message.id) && message.read === true && message.to !== "broadcast") {
					matched.push({ file, message });
				}
			}
			if (!dryRun && matched.length > 0) {
				mkdirSync(archiveDir, { recursive: true });
				for (const item of matched) renameSync(join(dir, item.file), join(archiveDir, item.file));
			}
			return matched.map(item => item.message);
		});
	}

	// ── Task Queue ──

	private tryAcquireMutex(name: string, ttlMs = 30_000): (() => void) | null {
		const path = join(this.lockDir(), `.mutex-${name}.lock`);
		const token = randomUUID();
		const now = Date.now();
		const create = (): boolean => {
			let fd: number | null = null;
			try {
				fd = openSync(path, "wx");
				writeFileSync(fd, JSON.stringify({ token, ownerId: PROCESS_OWNER_ID, timestamp: now }));
				return true;
			} catch (error: any) {
				// Windows may report EPERM/EACCES/EBUSY instead of EEXIST while another
				// process is creating, closing, or deleting the same wx lock file. Treat
				// those transient sharing violations as contention and let withMutex retry;
				// persistent directory permission failures still surface as a bounded
				// mutex timeout rather than crashing one registry writer mid-update.
				const transientWindowsContention = process.platform === "win32"
					&& ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
				if (error?.code !== "EEXIST" && !transientWindowsContention) throw error;
				return false;
			} finally {
				if (fd !== null) closeSync(fd);
			}
		};

		if (!create()) {
			let existing: any = null;
			try {
				existing = JSON.parse(readFileSync(path, "utf-8"));
			} catch {
				// 锁内容未知时 fail-closed，不能覆盖一个可能仍在工作的 owner。
				return null;
			}
			// 时间超时 且 持有者进程已消失才算过期；活进程的锁不可偷（长写保护）
			const pid = typeof existing.ownerId === "string" ? parseOwnerPid(existing.ownerId) : undefined;
			if (typeof existing.timestamp !== "number" || now - existing.timestamp <= ttlMs) return null;
			if (pid === undefined || isProcessAlive(pid)) return null;
			stealStaleLock(path);
			if (!create()) return null;
		}

		return () => {
			try {
				const existing = JSON.parse(readFileSync(path, "utf-8"));
				if (existing.token === token) unlinkSync(path);
			} catch { /* 已释放或不再属于当前 owner */ }
		};
	}

	/** 认领一个就绪任务 (依赖已完成, 状态为 pending) */
	claimNextTask(agentName: string): Task | null {
		const tasks = this.listTasks();
		for (const task of tasks) {
			const release = this.tryAcquireMutex(`task-claim-${task.id}`);
			if (!release) continue;
			try {
				// 必须在锁内重新读取，避免两个进程基于同一份 listTasks 快照重复认领。
				const current = this.getTask(task.id);
				if (!current) continue;
				const retryReady = current.status === "retry_wait"
					&& !!current.retryAt && Date.parse(current.retryAt) <= Date.now();
				if (current.status !== "pending" && !retryReady) continue;
				const depsDone = current.dependsOn.every(depId => this.getTask(depId)?.status === "done");
				if (!depsDone) continue;
				this.updateTask(current.id, {
					status: "in_progress",
					assignedTo: agentName,
					claimedAt: new Date().toISOString(),
					attempts: (current.attempts ?? 0) + 1,
					retryAt: undefined,
					error: undefined,
				});
				return this.getTask(current.id);
			} finally {
				release();
			}
		}
		return null;
	}

	/** 完成任务并通知依赖者。 */
	completeTask(taskId: string, result: { output?: string; verdict?: string }): boolean {
		const release = this.tryAcquireMutex(`task-claim-${taskId}`);
		if (!release) return false;
		let task: Task;
		try {
			const current = this.getTask(taskId);
			if (!current || current.status !== "in_progress") return false;
			task = current;
			this.updateTask(taskId, { status: "done", completedAt: new Date().toISOString(), error: undefined });
		} finally {
			release();
		}

		// 通知依赖此任务的其他 Agent。
		const allTasks = this.listTasks();
		for (const dependent of allTasks) {
			if (dependent.dependsOn.includes(taskId) && dependent.status === "blocked") {
				const releaseDependent = this.tryAcquireMutex(`task-claim-${dependent.id}`);
				if (!releaseDependent) continue;
				try {
					const current = this.getTask(dependent.id);
					if (!current || current.status !== "blocked") continue;
					const allDepsDone = current.dependsOn.every(d => this.getTask(d)?.status === "done");
					if (allDepsDone) this.updateTask(current.id, { status: "pending" });
				} finally {
					releaseDependent();
				}
			}
		}

		// 广播任务结果。
		if (task.assignedTo) {
			this.sendMessage(task.assignedTo, "broadcast", "task_complete",
				`Task ${taskId} completed. ${result.verdict ? `Verdict: ${result.verdict}.` : ""} ${result.output ? `Output: ${result.output.slice(0, 200)}` : ""}`);
		}
		return true;
	}

	/** 执行失败是终态，不会把依赖者解锁。 */
	failTask(taskId: string, error: string): boolean {
		const release = this.tryAcquireMutex(`task-claim-${taskId}`);
		if (!release) return false;
		let task: Task;
		try {
			const current = this.getTask(taskId);
			if (!current || ["done", "cancelled"].includes(current.status)) return false;
			task = current;
			this.updateTask(taskId, { status: "failed", error, completedAt: new Date().toISOString() });
		} finally {
			release();
		}
		if (task.assignedTo) {
			this.sendMessage(task.assignedTo, "broadcast", "task_failed", `Task ${taskId} failed: ${error.slice(0, 200)}`);
		}
		return true;
	}

	/** 将失败任务安排到未来重试；到 retryAt 前不可认领。 */
	scheduleTaskRetry(taskId: string, error: string, retryAt: string): boolean {
		const timestamp = Date.parse(retryAt);
		if (!Number.isFinite(timestamp)) return false;
		const release = this.tryAcquireMutex(`task-claim-${taskId}`);
		if (!release) return false;
		try {
			const task = this.getTask(taskId);
			if (!task || ["done", "cancelled"].includes(task.status)) return false;
			this.updateTask(taskId, { status: "retry_wait", error, retryAt: new Date(timestamp).toISOString() });
			return true;
		} finally {
			release();
		}
	}

	/** 取消是终态；后续迟到的执行结果不能再把任务标记为 done。 */
	cancelTask(taskId: string, reason = "cancelled by user"): boolean {
		const release = this.tryAcquireMutex(`task-claim-${taskId}`);
		if (!release) return false;
		try {
			const task = this.getTask(taskId);
			if (!task || task.status === "done" || task.status === "cancelled") return false;
			this.updateTask(taskId, {
				status: "cancelled",
				cancelReason: reason,
				completedAt: new Date().toISOString(),
			});
			return true;
		} finally {
			release();
		}
	}

	// ── Decisions ──

	writeDecision(decision: Omit<Decision, "id" | "timestamp">): Decision {
		const id = `decision-${randomUUID()}`;
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
		return this.withMutex("registry-groups", () => {
			const registry = this.listGroups();
			if (type === "all") {
				const existing = registry.find(group => group.id === "all");
				if (existing) return existing;
			}
			const id = type === "all" ? "all" : `${type}-${randomUUID()}`;
			const group: AgentGroup = {
				id, name, type, members: [...new Set(members)], description,
				created: new Date().toISOString(),
				createdBy,
			};
			this.writeJsonAtomic(join(this.sharedDir, "groups", "_registry.json"), [...registry, group]);
			mkdirSync(join(this.sharedDir, "groups", id), { recursive: true });
			return group;
		});
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
		assertSafeOpaqueId(groupId, "groupId");
		const groups = this.listGroups();
		const group = groups.find(g => g.id === groupId);
		if (!group) throw new Error(`Group ${groupId} not found`);
		if (!group.members.includes(from) && group.type !== "all") {
			throw new Error(`${from} is not a member of group ${groupId}`);
		}

		const groupDir = join(this.sharedDir, "groups", groupId);
		if (!existsSync(groupDir)) mkdirSync(groupDir, { recursive: true });

		const msgFile = join(groupDir, "messages.jsonl");
		const msg: GroupMessage = {
			id: `gm-${randomUUID()}`,
			groupId, from, content,
			timestamp: new Date().toISOString(),
		};
		appendFileSync(msgFile, JSON.stringify(msg) + "\n");
		return msg;
	}

	/** 获取群组消息 (支持 sinceTs 增量读取) */
	getGroupMessages(groupId: string, sinceTs?: string): GroupMessage[] {
		assertSafeOpaqueId(groupId, "groupId");
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
		return this.withMutex("registry-groups", () => {
			const groups = this.listGroups();
			let allGroup = groups.find(g => g.id === "all");
			if (!allGroup) {
				allGroup = {
					id: "all",
					name: "All Agents",
					type: "all",
					members: [...new Set(agentNames)],
					created: new Date().toISOString(),
					createdBy,
					description: "全 agent 公开沟通频道",
				};
				this.writeJsonAtomic(join(this.sharedDir, "groups", "_registry.json"), [...groups, allGroup]);
				mkdirSync(join(this.sharedDir, "groups", "all"), { recursive: true });
				return allGroup;
			}
			const merged = [...new Set([...allGroup.members, ...agentNames])];
			if (merged.length !== allGroup.members.length) {
				allGroup = { ...allGroup, members: merged };
				this.writeJsonAtomic(
					join(this.sharedDir, "groups", "_registry.json"),
					groups.map(group => group.id === "all" ? allGroup! : group),
				);
			}
			return allGroup;
		});
	}

	// ── Agent 注册表 ──

	/** 注册或更新 agent 信息 */
	registerAgent(info: Omit<AgentInfo, "registeredAt" | "lastSeen"> & { registeredAt?: string; lastSeen?: string }): AgentInfo {
		return this.withMutex("registry-agents", () => {
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
			this.writeJsonAtomic(join(this.sharedDir, "agents", "_registry.json"), updated);
			return full;
		});
	}

	/** 列出所有注册的 agent */
	listAgents(): AgentInfo[] {
		const path = join(this.sharedDir, "agents", "_registry.json");
		if (!existsSync(path)) return [];
		return JSON.parse(readFileSync(path, "utf-8"));
	}

	/**
	 * Register a persistent/RPC runtime with an instance lease. A second live
	 * process cannot silently take over the same routable agent name.
	 */
	registerRuntimeAgent(
		info: Omit<AgentInfo, "registeredAt" | "lastSeen" | "heartbeatAt"> & { instanceId: string },
		options: { now?: Date; leaseMs?: number } = {},
	): AgentInfo {
		if (!info.instanceId.trim()) throw new Error("runtime instanceId is required");
		const now = options.now ?? new Date();
		const leaseMs = Math.max(5_000, options.leaseMs ?? 30_000);
		return this.withMutex("registry-agents", () => {
			const registry = this.listAgents();
			const existing = registry.find(agent => agent.name === info.name);
			const active = existing && ["idle", "running", "blocked"].includes(existing.status);
			const lastSeenMs = existing ? Date.parse(existing.heartbeatAt ?? existing.lastSeen) : 0;
			const leaseFresh = Number.isFinite(lastSeenMs) && now.getTime() - lastSeenMs < leaseMs;
			if (active && existing?.instanceId !== info.instanceId && leaseFresh) {
				throw new Error(`runtime name already leased: ${info.name} by ${existing?.instanceId ?? "legacy-instance"}`);
			}
			const timestamp = now.toISOString();
			const sameInstance = existing?.instanceId === info.instanceId;
			const full: AgentInfo = {
				...(sameInstance ? existing : undefined),
				...info,
				registeredAt: sameInstance ? existing!.registeredAt : timestamp,
				lastSeen: timestamp,
				heartbeatAt: timestamp,
			};
			this.writeJsonAtomic(
				join(this.sharedDir, "agents", "_registry.json"),
				[...registry.filter(agent => agent.name !== info.name), full],
			);
			return full;
		});
	}

	/** 只移除调用方指定且仍处于终态的 registry 记录。 */
	pruneTerminalAgents(names: string[], dryRun = false): AgentInfo[] {
		const requested = new Set(names);
		return this.withMutex("registry-agents", () => {
			const registry = this.listAgents();
			const removed = registry.filter(agent => requested.has(agent.name) && ["done", "failed", "cancelled"].includes(agent.status));
			if (!dryRun && removed.length > 0) {
				const removedNames = new Set(removed.map(agent => agent.name));
				this.writeJsonAtomic(
					join(this.sharedDir, "agents", "_registry.json"),
					registry.filter(agent => !removedNames.has(agent.name)),
				);
			}
			return removed;
		});
	}

	/**
	 * Remove only fenced RPC runtimes whose heartbeat is older than the supplied
	 * cutoff. Ordinary Agents without runtime identity are preserved.
	 */
	pruneStaleRuntimeAgents(names: string[], staleBefore: Date, dryRun = false): AgentInfo[] {
		const requested = new Set(names);
		const cutoff = staleBefore.getTime();
		return this.withMutex("registry-agents", () => {
			const registry = this.listAgents();
			const removed = registry.filter(agent => {
				if (!requested.has(agent.name) || agent.role !== "rpc-runtime" || !agent.instanceId || !agent.heartbeatAt) return false;
				if (!["idle", "running", "blocked"].includes(agent.status)) return false;
				const heartbeat = Date.parse(agent.heartbeatAt);
				return Number.isFinite(heartbeat) && heartbeat <= cutoff;
			});
			if (!dryRun && removed.length > 0) {
				const removedNames = new Set(removed.map(agent => agent.name));
				this.writeJsonAtomic(
					join(this.sharedDir, "agents", "_registry.json"),
					registry.filter(agent => !removedNames.has(agent.name)),
				);
			}
			return removed;
		});
	}

	/** 更新 agent 状态/在线信息 */
	updateAgentPresence(name: string, updates: Partial<AgentInfo>, expectedInstanceId?: string): boolean {
		return this.withMutex("registry-agents", () => {
			const registry = this.listAgents();
			const agent = registry.find(a => a.name === name);
			if (!agent) return false;
			if (expectedInstanceId && agent.instanceId !== expectedInstanceId) return false;
			Object.assign(agent, updates, { lastSeen: new Date().toISOString() });
			this.writeJsonAtomic(join(this.sharedDir, "agents", "_registry.json"), registry);
			return true;
		});
	}

	/**
	 * Atomically converge a runtime lease when its process/session exits. Existing
	 * failure/cancellation terminal states win over a later zero process exit.
	 */
	finalizeRuntimeAgentPresence(name: string, expectedInstanceId: string, exitCode: number): boolean {
		return this.withMutex("registry-agents", () => {
			const registry = this.listAgents();
			const agent = registry.find(item => item.name === name);
			if (!agent || agent.instanceId !== expectedInstanceId) return false;
			const preserved = agent.status === "failed" || agent.status === "cancelled";
			agent.status = preserved ? agent.status : exitCode === 0 ? "done" : exitCode === 130 ? "cancelled" : "failed";
			agent.lastSeen = new Date().toISOString();
			this.writeJsonAtomic(join(this.sharedDir, "agents", "_registry.json"), registry);
			return true;
		});
	}

	/** 获取单个 agent 信息 */
	getAgent(name: string): AgentInfo | null {
		return this.listAgents().find(a => a.name === name) ?? null;
	}

	// ── 文件锁 (防并行 agent 编辑冲突) ──

	private lockDir(): string {
		const dir = join(this.sharedDir, "locks");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	}

	private canonicalFilePath(filePath: string): string {
		const absolute = resolve(isAbsolute(filePath) ? filePath : join(this.projectRoot, filePath));
		let canonical = absolute;
		try { canonical = realpathSync.native(absolute); } catch { /* 新文件尚不存在时使用规范化绝对路径 */ }
		canonical = canonical.replace(/\\/g, "/");
		return process.platform === "win32" ? canonical.toLowerCase() : canonical;
	}

	private lockPath(filePath: string): string {
		const canonical = this.canonicalFilePath(filePath);
		const hash = createHash("sha256").update(canonical).digest("hex");
		return join(this.lockDir(), `${hash}.lock`);
	}

	private lockOwner(agentName: string): string {
		return `${agentName}:${PROCESS_OWNER_ID}`;
	}

	/** 获取文件锁. 返回 true=成功, false=已被其他 agent 锁定 */
	acquireFileLock(agentName: string, filePath: string, ttlMs = 300000): boolean {
		const lp = this.lockPath(filePath);
		const canonicalPath = this.canonicalFilePath(filePath);
		const ownerId = this.lockOwner(agentName);
		const now = Date.now();
		const payload = {
			agent: agentName,
			ownerId,
			filePath,
			canonicalPath,
			timestamp: now,
			expiresAt: now + ttlMs,
		};

		const create = (): boolean => {
			let fd: number | null = null;
			try {
				fd = openSync(lp, "wx");
				writeFileSync(fd, JSON.stringify(payload, null, 2));
				return true;
			} catch (error: any) {
				if (error?.code !== "EEXIST") throw error;
				return false;
			} finally {
				if (fd !== null) closeSync(fd);
			}
		};

		if (create()) return true;
		try {
			const lock = JSON.parse(readFileSync(lp, "utf-8"));
			if (lock.ownerId === ownerId) {
				writeFileSync(lp, JSON.stringify(payload, null, 2));
				return true;
			}
			if (typeof lock.expiresAt !== "number" || now < lock.expiresAt) return false;
			unlinkSync(lp);
		} catch {
			// 损坏或读取竞争时 fail-closed，不能把潜在活锁当成成功。
			return false;
		}
		return create();
	}

	/** 只释放当前进程 owner 持有的文件锁。 */
	releaseFileLock(filePath: string, agentName?: string): boolean {
		const lp = this.lockPath(filePath);
		try {
			const lock = JSON.parse(readFileSync(lp, "utf-8"));
			const ownedByProcess = typeof lock.ownerId === "string" && lock.ownerId.endsWith(`:${PROCESS_OWNER_ID}`);
			if (!ownedByProcess || (agentName && lock.ownerId !== this.lockOwner(agentName))) return false;
			unlinkSync(lp);
			return true;
		} catch { return false; }
	}

	/** 释放 agent 持有的所有锁 */
	releaseAllLocks(agentName: string): string[] {
		const released: string[] = [];
		try {
			const files = readdirSync(this.lockDir());
			for (const f of files) {
				if (!f.endsWith(".lock")) continue;
				const lp = join(this.lockDir(), f);
				try {
					const lock = JSON.parse(readFileSync(lp, "utf-8"));
					if (lock.ownerId === this.lockOwner(agentName)) {
						unlinkSync(lp);
						released.push(lock.filePath ?? f);
					}
				} catch { /* */ }
			}
		} catch { /* */ }
		return released;
	}

	/** 查看所有活跃锁 */
	getFileLocks(): { agent: string; ownerId: string; filePath: string; canonicalPath: string; timestamp: number; expiresAt: number }[] {
		const locks: { agent: string; ownerId: string; filePath: string; canonicalPath: string; timestamp: number; expiresAt: number }[] = [];
		try {
			const files = readdirSync(this.lockDir());
			const now = Date.now();
			for (const f of files) {
				if (!f.endsWith(".lock")) continue;
				try {
					const lock = JSON.parse(readFileSync(join(this.lockDir(), f), "utf-8"));
					if (now < lock.expiresAt) {  // 只返回未过期的
						locks.push(lock);
					}
				} catch { /* */ }
			}
		} catch { /* */ }
		return locks;
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
	lines.push(`  work style: ${bb.currentWorkStyle || "(unset)"}`);
	if (bb.sharedContext.goal) lines.push(`  goal: ${bb.sharedContext.goal}`);
	if (bb.sharedContext.constraints?.length) {
		lines.push(`  constraints: ${bb.sharedContext.constraints.join(", ")}`);
	}
	lines.push("");
	lines.push("  Agents:");
	for (const [name, status] of Object.entries(bb.agentStatuses)) {
		const icon = { idle: "○", running: "●", blocked: "⚠", done: "✓", failed: "✗", cancelled: "⊘", retry_wait: "↻" }[status.status] ?? "?";
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
		const icon = { pending: "○", in_progress: "●", done: "✓", blocked: "⚠", failed: "✗", cancelled: "⊘", retry_wait: "↻" }[t.status] ?? "?";
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
		const icon = { idle: "○", running: "●", blocked: "⚠", done: "✓", failed: "✗", cancelled: "⊘" }[a.status] ?? "?";
		lines.push(`  ${icon} ${a.name} (${a.role}) — ${a.status}`);
		if (a.currentTask) lines.push(`    task: ${a.currentTask.slice(0, 80)}`);
		if (a.model) lines.push(`    model: ${a.model}${a.thinking ? ` [${a.thinking}]` : ""}`);
	}
	return lines.join("\n");
}
