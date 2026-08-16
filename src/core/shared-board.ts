/**
 * 共享黑板 — 多 agent 协作的共享状态层

 *
 * 目录结构:
 *   .agentflux/shared/
 *     blackboard.json   — 全局状态



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
	// ── Messages ──

	sendMessage(from: string, to: string, type: string, content: string): AgentMessage {
		const id = `msg-${randomUUID()}`;
		const msg: AgentMessage = {
			id, from, to, type, content,
			timestamp: new Date().toISOString(),
			read: false,
		};
		// 文件名: {id}__{from}-{to}.json (便于按收件人过滤；避免 → 等非 ASCII 字符)
		const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
		const filename = `${id}__${safeName(from)}-${safeName(to)}.json`;
		writeFileSync(join(this.sharedDir, "messages", filename), JSON.stringify(msg, null, 2));
		return msg;
	}

	/** 获取指定 agent 的收件箱 (发给它的 + 广播) */
	getInbox(agentName: string): AgentMessage[] {
		const dir = join(this.sharedDir, "messages");
		if (!existsSync(dir)) return [];
		const messages: AgentMessage[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			try {
				messages.push(JSON.parse(readFileSync(join(dir, file), "utf-8")) as AgentMessage);
			} catch {
				// 单文件损坏跳过，不阻塞收件箱读取。
			}
		}
		return messages
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
				let msg: AgentMessage;
				try {
					msg = JSON.parse(readFileSync(path, "utf-8")) as AgentMessage;
				} catch {
					continue;
				}
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
		const messages: AgentMessage[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			try {
				messages.push(JSON.parse(readFileSync(join(dir, file), "utf-8")) as AgentMessage);
			} catch {
				// 单文件损坏跳过，不阻塞 GC 等聚合读取。
			}
		}
		return messages.sort((a: AgentMessage, b: AgentMessage) => a.timestamp.localeCompare(b.timestamp));
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
	// ── Decisions ──
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
		try {
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			// 注册表单文件损坏时降级为空，避免阻塞 GC/消息等聚合读取。
			return [];
		}
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
		const msgs: GroupMessage[] = [];
		for (const line of lines) {
			try {
				msgs.push(JSON.parse(line) as GroupMessage);
			} catch {
				// 单行损坏跳过，不阻塞整个群组消息读取。
			}
		}
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

	/** 从锁 ownerId（`<agent>:<pid>-<uuid>`）解析持有者 pid；解析不出返回 undefined。
	 * 只用冒号后的 `<pid>-` 段：agent 名可数字开头（如 123worker），逐段匹配会误判。 */
	private lockOwnerPid(ownerId: string): number | undefined {
		const m = /:(\d+)-/.exec(ownerId);
		return m ? Number(m[1]) : undefined;
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
			// 持有者进程仍存活时不偷锁（与 fs-lock 的“活进程锁不可偷”一致）——
			// ownerId 格式 `<agent>:<pid>-<uuid>`，解析出 pid 后做存活检查
			const ownerPid = this.lockOwnerPid(String(lock.ownerId ?? ""));
			if (ownerPid !== undefined && isProcessAlive(ownerPid)) return false;
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
// ──────────────────────────────── 格式化 ────────────────────────────────
export function formatMessages(msgs: AgentMessage[]): string {
	if (msgs.length === 0) return "No messages.";
	const lines = ["Messages:", ""];
	for (const m of msgs) {
		const readIcon = m.read ? "✓" : "●";
		lines.push(`  ${readIcon} ${m.id}: ${m.from}→${m.to} [${m.type}] ${m.content.slice(0, 80)}`);
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
