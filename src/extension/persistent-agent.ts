/**
 * AgentFlux M4 — 持久 multi-agent runner
 * 文档依据: docs/22-mode-capability-roadmap.md M4 实现
 *
 * M4-1: 持久 session subagent — subagent 保留 session, 可被再次调用续接
 * M4-2: agent 间消息传递 — 通过 SharedBoard messages/ 目录
 * M4-3: 任务队列消费 — agent 主动从 tasks/ 认领任务
 * M4-4: agent 状态同步 — 完成任务后更新黑板 + 通知依赖者
 * M4-5: 持久 reviewer 甜区 — 同一 reviewer 跨多次调用保留 session
 */

import { runSubagent, type SubagentDef, type SubagentRunResult } from "./subagent";
import { SharedBoard, type Task } from "../core/shared-board";
import { loadAllRoles, type RoleDefinition } from "../core/role-manager";
import type { TelemetryWriter } from "../telemetry/events";
import type { PricingTable } from "../core/pricing";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// ─── 持久 agent 注册表 ───

export interface PersistentAgent {
	name: string;               // 唯一实例名 (如 "reviewer-1")
	role: string;               // 角色模板名
	model: string;
	sessionFile: string;        // .agentflux/runtime/sessions/{name}.session
	status: "idle" | "running" | "done" | "failed";
	callCount: number;          // 被调用次数
	totalCost: number;          // 累计成本
	totalCacheRead: number;     // 累计 cache read
	createdAt: string;
	lastUsedAt: string;
}

export interface PersistentRegistry {
	agents: PersistentAgent[];
}

const REGISTRY_FILE = "persistent-agents.json";

function loadPersistentRegistry(fluxDir: string): PersistentRegistry {
	const path = join(fluxDir, "runtime", REGISTRY_FILE);
	if (!existsSync(path)) return { agents: [] };
	try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return { agents: [] }; }
}

function savePersistentRegistry(fluxDir: string, registry: PersistentRegistry): void {
	const dir = join(fluxDir, "runtime");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify(registry, null, 2));
}

// ─── M4-1/M4-5: 持久 agent runner ───

export interface PersistentAgentOptions {
	cwd: string;
	fluxDir: string;
	modelsConfig: any;
	telemetry: TelemetryWriter;
	prefixLayout: boolean;
	pricing?: PricingTable;
	sessionId: string;
	sharedSkills?: string[];
}

/**
 * 运行持久 agent (M4-1/M4-5).
 *
 * 与普通 subagent 的区别:
 *   - 使用 --session-id 保留 session 文件, 跨调用续接
 *   - 维护 agent 注册表, 记录调用次数和累计成本
 *   - 同一 agent 名称的多次调用共享 session (L2 cache 跨调用复用)
 *   - 更新 SharedBoard 黑板状态 (M4-4)
 */
export async function runPersistentAgent(
	agentName: string,
	roleName: string,
	task: string,
	opts: PersistentAgentOptions,
): Promise<SubagentRunResult> {
	const roles = loadAllRoles(opts.cwd, opts.modelsConfig);
	const role = roles.get(roleName);
	if (!role) throw new Error(`Role ${roleName} not found`);

	const models = opts.modelsConfig?.models ?? {};
	const sessionDir = join(opts.fluxDir, "runtime", "sessions");
	try { mkdirSync(sessionDir, { recursive: true }); } catch {}

	// 构建 agent 定义
	const agentDef: SubagentDef = {
		name: agentName,
		description: role.description ?? agentName,
		tools: role.tools,
		model: role.model,
		provider: role.model ? models[role.model]?.provider : undefined,
		systemPrompt: role.systemPrompt ?? `You are a ${roleName}.`,
		thinking: role.thinking,
		skills: [...(opts.sharedSkills ?? []), ...(role.skills ?? [])].length > 0
			? [...(opts.sharedSkills ?? []), ...(role.skills ?? [])] : undefined,
	};

	// 更新注册表
	const registry = loadPersistentRegistry(opts.fluxDir);
	let agent = registry.agents.find(a => a.name === agentName);
	if (!agent) {
		agent = {
			name: agentName, role: roleName,
			model: agentDef.model ?? "default",
			sessionFile: join(sessionDir, `flux-${agentName}.session`),
			status: "idle", callCount: 0, totalCost: 0, totalCacheRead: 0,
			createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
		};
		registry.agents.push(agent);
	}

	agent.status = "running";
	agent.lastUsedAt = new Date().toISOString();
	savePersistentRegistry(opts.fluxDir, registry);

	// 更新黑板
	const board = new SharedBoard(opts.fluxDir);
	board.updateAgentStatus(agentName, { status: "running", workingOn: task.slice(0, 100) });

	// M4-2: 检查收件箱, 将未读消息附加到任务
	const unread = board.getUnreadMessages(agentName);
	let fullTask = task;
	if (unread.length > 0) {
		const inboxSummary = unread.map(m => `[${m.from}] ${m.content}`).join("\n");
		fullTask = `${task}\n\n--- Messages from other agents ---\n${inboxSummary}`;
		for (const m of unread) board.markMessageRead(m.id);
		console.error(`[flux m4] ${agentName}: read ${unread.length} unread messages`);
	}

	// 运行 subagent (persistent=true)
	const result = await runSubagent({
		cwd: opts.cwd,
		agent: agentDef,
		task: fullTask,
		sessionId: opts.sessionId,
		telemetry: opts.telemetry,
		prefixLayout: opts.prefixLayout,
		model: agentDef.model,
		provider: agentDef.provider,
		pricing: opts.pricing,
		persistent: true,
		sessionDir,
		thinking: agentDef.thinking,
		timeoutMs: 180000,
		maxRetries: 1,
	});

	// 更新注册表
	const reg2 = loadPersistentRegistry(opts.fluxDir);
	const agent2 = reg2.agents.find(a => a.name === agentName);
	if (agent2) {
		agent2.status = result.exitCode === 0 ? "done" : "failed";
		agent2.callCount++;
		agent2.totalCost += result.usage.cost;
		agent2.totalCacheRead += result.usage.cacheRead;
		agent2.lastUsedAt = new Date().toISOString();
		savePersistentRegistry(opts.fluxDir, reg2);
	}

	// 更新黑板 (M4-4)
	board.updateAgentStatus(agentName, {
		status: result.exitCode === 0 ? "done" : "failed",
		output: result.output?.slice(0, 200),
	});

	return result;
}

// ─── M4-3: 任务队列消费 ───

/**
 * 让持久 agent 认领并执行下一个就绪任务 (M4-3).
 *
 * 工作流:
 *   1. 从 SharedBoard 认领一个 pending 且依赖已完成的任务
 *   2. 用 runPersistentAgent 执行
 *   3. 完成后更新任务状态 + 通知依赖者 (M4-4)
 *
 * @returns 执行结果, 或 null 如果没有就绪任务
 */
export async function consumeNextTask(
	agentName: string,
	roleName: string,
	opts: PersistentAgentOptions,
): Promise<{ task: Task; result: SubagentRunResult } | null> {
	const board = new SharedBoard(opts.fluxDir);

	// M4-3: 认领任务
	const task = board.claimNextTask(agentName);
	if (!task) {
		console.error(`[flux m4] ${agentName}: no ready tasks in queue`);
		return null;
	}

	console.error(`[flux m4] ${agentName}: claimed task ${task.id} — ${task.title.slice(0, 80)}`);

	// 执行任务
	const result = await runPersistentAgent(agentName, roleName, task.title, opts);

	// M4-4: 完成任务 + 通知依赖者
	board.completeTask(task.id, {
		output: result.output?.slice(0, 500),
		verdict: result.exitCode === 0 ? "completed" : "failed",
	});

	return { task, result };
}

// ─── 格式化 ───

export function formatPersistentRegistry(registry: PersistentRegistry): string {
	if (registry.agents.length === 0) return "No persistent agents.";
	const lines = ["Persistent Agents:", ""];
	for (const a of registry.agents) {
		const icon = { idle: "○", running: "●", done: "✓", failed: "✗" }[a.status] ?? "?";
		lines.push(`  ${icon} ${a.name.padEnd(20)} ${a.role.padEnd(12)} calls=${a.callCount} cost=$${a.totalCost.toFixed(6)} cache=${a.totalCacheRead}`);
	}
	return lines.join("\n");
}
