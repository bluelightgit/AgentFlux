/**
 * 统一 Agent 存储（docs/32 阶段二）— 取代 ephemeral/persistent 双轨。
 *
 * - 唯一 id + 可重名 name（创建时自动后缀去重，name 查询防御性返回 list）
 * - 三种创建路径：默认（无 role）/ 角色模板（role）/ 会话树分叉（forkFrom）
 * - 三层作用域：global（~/.agentflux）/ project / session（项目文件 + ownerSession 隔离）
 * - run = 与子代理对话：指令 + 超时，返回最后一条（或 last(k) 条）消息
 * - 生命周期：idle 保留 → 手动 delete / 自动 GC（无引用且非最新 k 个创建）
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonStore, updateJsonStore } from "../core/json-store";
import type { PricingTable } from "../core/pricing";
import { registerActiveContext, releaseActiveContext, type SpaceContext } from "../core/active-context";
import { assertSafePathSegment } from "../core/safe-path";
import type { AgentRecord, AgentScope, AgentStatus, ThinkingLevel } from "../core/types";
import { getAgentRun, listAgentRuns, type AgentRunRecord } from "../core/run-registry";
import { MessageBus, type SendMessageV2Result } from "../core/message-bus";
import { readAgentRunStop } from "./agent-run-control";
import type { RunHealthConfig } from "../core/run-health";
import type { TelemetryWriter } from "../telemetry/events";
import { runAgent, type AgentRunResult, type AgentTemplate } from "./agent-runner";
import { loadAllRoles } from "./templates";

interface AgentRegistry { agents: AgentRecord[]; }

export interface AgentRunContext {
	cwd: string;
	modelsConfig: any;
	telemetry?: TelemetryWriter;
	pricing?: PricingTable;
	sessionId: string;
	taskId?: string;
	executionId?: string;
	sharedSkills?: string[];
	prefixLayout: boolean;
	/** 未显式指定 Agent/角色模型时，继承当前 Main Agent 的模型。 */
	defaultModel?: string;
	defaultProvider?: string;
	timeoutMs?: number | null;
	/** 继承父执行的绝对 deadline；优先于 timeoutMs。 */
	deadlineAt?: number;
	maxCostUsd?: number;
	parentMaxCostUsd?: number;
	parentMaxTurns?: number;
	parentMaxInputTokens?: number;
	parentMaxParallel?: number;
	health?: RunHealthConfig;
	lockFiles?: string[];
	invocationOverride?: { command: string; args: string[] };
	/** 当前 Agent 派发所属空间；设置后以具体 lease 参与项目级互斥。 */
	space?: SpaceContext;
}

function registryPath(cwd: string, scope: AgentScope): string {
	if (scope === "global") return join(homedir(), ".agentflux", "agents.json");
	return join(cwd, ".agentflux", "runtime", "agents.json");
}

/** 旧格式记录（2026-08-12 前，无 scope/thinking 等字段）读取时内存级归一化，不重写文件。 */
function normalizeAgentRecord(record: any): AgentRecord {
	const now = new Date().toISOString();
	return {
		id: record.id ?? `legacy-${record.name ?? "unknown"}`,
		name: record.name ?? record.id ?? "unknown",
		scope: record.scope ?? "project",
		role: typeof record.role === "string" && record.role.trim() ? record.role.trim() : "assistant",
		roles: (() => {
			const primary = typeof record.role === "string" && record.role.trim() ? record.role.trim() : "assistant";
			const configured = Array.isArray(record.roles)
				? record.roles.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
				: [];
			return [...new Set([primary, ...configured])];
		})(),
		status: record.status ?? "idle",
		lineage: record.lineage ?? { origin: "fresh", forkedFrom: undefined },
		model: record.model,
		provider: record.provider,
		thinking: record.thinking,
		sessionId: record.sessionId,
		lastSessionId: record.lastSessionId,
		ownerSessionId: record.ownerSessionId,
		createdAt: record.createdAt ?? now,
		updatedAt: record.updatedAt ?? now,
		lastTask: record.lastTask,
		lastRole: record.lastRole,
		callCount: record.callCount ?? 0,
		totalCostUsd: record.totalCostUsd ?? 0,
		capabilityGeneration: record.capabilityGeneration ?? 1,
		// lastResult 仅透传结构完整的记录，损坏/旧格式丢弃以免展示 last=undefined
		lastResult: typeof record.lastResult?.exitCode === "number" && typeof record.lastResult?.success === "boolean" ? record.lastResult : undefined,
	};
}
const createRegistry = (): AgentRegistry => ({ agents: [] });
const isRegistry = (value: unknown): value is AgentRegistry =>
	!!value && typeof value === "object" && Array.isArray((value as AgentRegistry).agents);

function updateRegistry<R>(path: string, update: (agents: AgentRecord[]) => R): R {
	return updateJsonStore(path, createRegistry, isRegistry, store => update(store.agents));
}

/** 全部作用域列表（global → project → session 同文件）。 */
export function listAgents(cwd: string, ownerSessionId?: string): AgentRecord[] {
	const global = readJsonStore(registryPath(cwd, "global"), createRegistry, isRegistry).agents;
	const project = readJsonStore(registryPath(cwd, "project"), createRegistry, isRegistry).agents;
	return [...global, ...project].map(normalizeAgentRecord).filter(agent =>
		!ownerSessionId || agent.scope !== "session" || agent.ownerSessionId === ownerSessionId,
	);
}

/** 按 id（精确）或 name（可能多个）查找；archived/已删除不返回。提供 session 时隔离 session 作用域。 */
export function findAgents(cwd: string, selector: string, ownerSessionId?: string): AgentRecord[] {
	return listAgents(cwd, ownerSessionId).filter(agent => agent.status !== "archived" && (agent.id === selector || agent.name === selector));
}

function uniqueName(cwd: string, scope: AgentScope, name: string): string {
	const existing = new Set(
		(scope === "global"
			? readJsonStore(registryPath(cwd, "global"), createRegistry, isRegistry).agents.map(normalizeAgentRecord)
			: listAgents(cwd)
		).map(agent => agent.name),
	);
	if (!existing.has(name)) return name;
	let index = 1;
	while (existing.has(`${name}(${index})`)) index++;
	return `${name}(${index})`;
}

/**
 * 创建 Agent。三路径：
 * - 默认：不传 role，使用内置 assistant 模板
 * - 角色模板：role 必须是全局或项目级已注册模板
 * - 会话树分叉：forkFrom 为已有 Agent（id/name，继承其会话记忆）或会话文件路径
 */
/** 单次运行可覆盖的模型与思考等级（覆盖模板默认，不修改模板本身）。 */
export interface AgentRunOverrides {
	/** 以同一 Agent 身份执行本次任务时选择的角色。 */
	role?: string;
	/** shared 复用 Agent 会话；fresh 为本次角色运行生成独立持久会话。 */
	sessionMode?: "shared" | "fresh";
	model?: string;
	thinking?: ThinkingLevel;
}

/** 最近一次运行结果摘要（后台运行时供 list/show 查询）。 */
export interface AgentRunSummary {
	exitCode: number;
	success: boolean;
	summary: string;
	turns: number;
	costUsd: number;
	model?: string;
	role?: string;
	at: string;
}

export interface QueuedAgentInstruction {
	agent: AgentRecord;
	run: AgentRunRecord;
	message: SendMessageV2Result;
	pending: number;
}

/**
 * 将 busy Agent 的新指令放入唯一的 Message V2 pending 队列。
 * 返回 undefined 表示没有可接收的 active Run；调用方随后才可以尝试启动新 Run。
 */
export function enqueueAgentInstruction(
	selector: string,
	task: string,
	context: Pick<AgentRunContext, "cwd" | "sessionId" | "taskId">,
	priority: "normal" | "high" = "high",
): QueuedAgentInstruction | undefined {
	if (!task.trim()) throw new Error("queued Agent instruction cannot be empty");
	const record = findSingle(context.cwd, selector, context.sessionId);
	const fluxDir = join(context.cwd, ".agentflux");
	const run = listAgentRuns(fluxDir, { agent: record.name, activeOnly: true })
		.find(candidate => candidate.status === "starting" || candidate.status === "running");
	if (!run) return undefined;
	const bus = new MessageBus(fluxDir, { maxPendingPerRecipient: 20 });
	const acceptsInstruction = (): boolean => {
		try {
			const current = getAgentRun(fluxDir, run.id);
			return current?.id === run.id
				&& (current.status === "starting" || current.status === "running")
				&& !readAgentRunStop(context.cwd, run.id);
		} catch {
			// Registry/control uncertainty must not turn into a new delivery.
			return false;
		}
	};
	if (!acceptsInstruction()) return undefined;
	let message: SendMessageV2Result;
	try {
		message = bus.sendDirectGuarded("main", record.name, "steer", task.trim(), {
			priority,
			correlationId: run.id,
			taskId: context.taskId ?? run.taskId,
			senderInstanceId: `main:${context.sessionId}`,
		}, () => {
			if (!acceptsInstruction()) throw new Error(`Agent run is no longer accepting instructions: ${run.id}`);
		});
	} catch (error) {
		// A stop may win the fence race while send() is waiting for Message V2's
		// mutex.  Treat that as a rejected queue operation, not as a new Run input;
		// preserve unrelated backpressure/storage errors for the caller.
		if (!acceptsInstruction()) return undefined;
		throw error;
	}
	if (!acceptsInstruction()) {
		try { bus.reject(record.name, message.envelope.id, "run stopped before queued instruction was accepted"); } catch { /* stop/recovery may already have finalized it */ }
		return undefined;
	}
	const pending = bus.peek(record.name, { limit: 100, correlationId: run.id, includeUncorrelated: false })
		.filter(item => ["pending", "delivered"].includes(item.delivery.status)).length;
	return { agent: record, run, message, pending };
}

/** 停止某个具体 Run 时拒绝其尚未消费的 steer，避免旧指令污染下一次 Run。 */
export function rejectQueuedAgentInstructions(cwd: string, run: AgentRunRecord, reason = "run stopped"): number {
	return new MessageBus(join(cwd, ".agentflux")).rejectByCorrelation(run.agent, run.id, reason);
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 模型覆盖必须存在于模型表（fail-closed，防止无效模型白跑成本）。 */
function assertModelOverride(modelsConfig: any, model: string | undefined): void {
	if (model === undefined) return;
	if (!modelsConfig?.models?.[model]) {
		throw new Error(`Unknown model: ${model}. Available models: ${Object.keys(modelsConfig?.models ?? {}).join(", ") || "none"}.`);
	}
}

export function createAgent(cwd: string, input: { name: string; role?: string; roles?: string[]; forkFrom?: string; scope?: AgentScope; ownerSessionId?: string; modelsConfig: any; model?: string; thinking?: AgentRunOverrides["thinking"] }): AgentRecord {
	const safeName = assertSafePathSegment(input.name, "Agent name");
	const scope: AgentScope = input.scope ?? "project";
	const roleDefinitions = loadAllRoles(cwd, input.modelsConfig);
	const requestedRole = typeof input.role === "string" ? input.role.trim() : undefined;
	const configuredRoles = Array.isArray(input.roles) && input.roles.length > 0
		? [...new Set(input.roles.map(roleName => roleName.trim()).filter(Boolean))]
		: [requestedRole ?? "assistant"];
	const role = requestedRole ?? configuredRoles[0] ?? "assistant";
	if (!configuredRoles.includes(role)) configuredRoles.unshift(role);
	for (const roleName of configuredRoles) {
		if (!roleDefinitions.has(roleName)) {
			throw new Error(`Unknown Agent template: ${roleName}. Use a registered template id (${[...roleDefinitions.keys()].join(", ") || "none available"}); role is not a free-form description.`);
		}
	}
	assertModelOverride(input.modelsConfig, input.model);
	if (input.thinking !== undefined && !THINKING_LEVELS.includes(input.thinking)) {
		throw new Error(`Unknown thinking level: ${input.thinking}. Use one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	const template = roleDefinitions.get(role);
	const now = new Date().toISOString();
	const multiRole = configuredRoles.length > 1;
	let sessionId: string | undefined;
	let forkPoint: string | undefined;
	if (input.forkFrom) {
		const forkCandidates = findAgents(cwd, input.forkFrom, input.ownerSessionId);
		if (forkCandidates.length > 0) {
			sessionId = forkCandidates[0].sessionId; // 继承源 Agent 会话记忆
		} else {
			sessionId = input.forkFrom; // 视为会话文件路径
		}
		forkPoint = input.forkFrom;
	}
	const record: AgentRecord = {
		id: `agent-${randomUUID()}`,
		name: uniqueName(cwd, scope, safeName),
		scope,
		role,
		status: "idle",
		lineage: {
			origin: input.forkFrom ? "fork" : (requestedRole || input.roles?.length) ? "template" : "fresh",
			templateId: requestedRole ?? (input.roles?.length ? role : undefined),
			templateIds: [...configuredRoles],
			templateRevision: 1,
			forkPoint,
		},
		roles: [...configuredRoles],
		// 多角色 Agent 不把首个角色的模型固化到整个身份；每次 Run 按所选角色解析。
		model: input.model ?? (multiRole ? undefined : template?.model),
		provider: (() => {
			const m = input.model ?? (multiRole ? undefined : template?.model);
			return input.model
				? input.modelsConfig?.models?.[input.model]?.provider
				: (multiRole ? undefined : template?.provider) ?? (m ? input.modelsConfig?.models?.[m]?.provider : undefined);
		})(),
		thinking: input.thinking ?? (multiRole ? undefined : template?.thinking),
		sessionId: sessionId ?? `agent-${uniqueName(cwd, scope, safeName)}`,
		createdAt: now,
		updatedAt: now,
		callCount: 0,
		totalCostUsd: 0,
		capabilityGeneration: 1,
	};
	if (scope === "session") record.ownerSessionId = input.ownerSessionId;
	const path = registryPath(cwd, scope);
	updateRegistry(path, agents => { agents.push(record); return record; });
	return record;
}

/** 手动删除（硬删；运行中拒绝）。 */
export function deleteAgent(cwd: string, selector: string, ownerSessionId?: string): AgentRecord {
	for (const scope of ["global", "project"] as const) {
		const path = registryPath(cwd, scope);
		const removed = updateRegistry(path, agents => {
			const current = agents.find(agent => (agent.id === selector || agent.name === selector)
				&& agent.status !== "archived"
				&& (!ownerSessionId || agent.scope !== "session" || agent.ownerSessionId === ownerSessionId));
			if (!current) return undefined;
			if (current.status === "running") throw new Error(`Agent is running: ${current.name}`);
			const index = agents.indexOf(current);
			agents.splice(index, 1);
			return current;
		});
		if (removed) return removed;
	}
	throw new Error(`Agent not found: ${selector}`);
}

/**
 * 自动 GC：删除"无工作引用 且 创建时间早于最新第 k 个（默认 10）创建"的 Agent。
 * activeRefs：正在运行的 agent id/name、被活跃任务/issue 引用的名字（有引用永不清除）。
 */
export function gcAgents(cwd: string, keepLatestK = 10, activeRefs: ReadonlySet<string> = new Set()): string[] {
	const removed: string[] = [];
	for (const scope of ["global", "project"] as const) {
		const path = registryPath(cwd, scope);
		updateRegistry(path, agents => {
			const byCreation = [...agents].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
			const protectedNames = new Set(byCreation.slice(0, keepLatestK).map(agent => agent.name));
			const survivors = agents.filter(agent => {
				const referenced = activeRefs.has(agent.id) || activeRefs.has(agent.name) || agent.status === "running";
				const kept = protectedNames.has(agent.name);
				if (!referenced && !kept) removed.push(agent.name);
				return referenced || kept;
			});
			agents.splice(0, agents.length, ...survivors);
		});
	}
	return removed;
}

export function getAgentRoles(record: Pick<AgentRecord, "role" | "roles">): string[] {
	const primary = record.role?.trim() || "assistant";
	const configured = Array.isArray(record.roles)
		? record.roles
			.filter(role => typeof role === "string" && role.trim().length > 0)
			.map(role => role.trim())
		: [];
	return [...new Set([primary.trim(), ...configured])];
}

function toTemplate(record: AgentRecord, roleName: string, cwd: string, modelsConfig: any, sharedSkills: string[], defaults?: { model?: string; provider?: string }): AgentTemplate {
	const role = loadAllRoles(cwd, modelsConfig).get(roleName);
	if (!role) throw new Error(`Unknown Agent template: ${roleName}`);
	const model = record.model ?? role.model ?? defaults?.model;
	const provider = record.provider
		?? role.provider
		?? (record.model || role.model ? modelsConfig?.models?.[model ?? ""]?.provider : undefined)
		?? (model && defaults?.model === model ? defaults?.provider : undefined);
	return {
		name: record.name,
		role: roleName,
		description: role.description ?? record.role,
		model,
		provider,
		tools: role.tools,
		skills: [...new Set([...sharedSkills, ...(role.skills ?? [])])],
		mcpServers: role.mcpServers,
		workspace: role.workspace,
		systemPrompt: role.systemPrompt ?? `You are the ${roleName} specialist.`,
		thinking: record.thinking ?? role.thinking,
		communication: role.communication,
	};
}

function findSingle(cwd: string, selector: string, ownerSessionId?: string): AgentRecord {
	const matches = findAgents(cwd, selector, ownerSessionId);
	if (matches.length === 0) throw new Error(`Agent not found: ${selector}`);
	if (matches.length > 1) {
		throw new Error(`Agent name "${selector}" is ambiguous: ${matches.map(agent => `${agent.name} (${agent.id})`).join(", ")}. Use the unique id.`);
	}
	return matches[0];
}

/**
 * 运行 Agent = 与子代理对话：发出指令并等待完成（超时可配），
 * 返回其最后一条消息；assistantMessages 供 last(k) 展示更多执行消息。
 * busy 时由调用方通过 enqueueAgentInstruction 将指令放入 Message V2 pending 队列。
 * 同一 Agent 可在每次 Run 中选择其已注册的允许角色。
 */
async function runAgentRecordCore(selector: string, task: string, context: AgentRunContext, signal?: AbortSignal, sessionDir?: string, overrides?: AgentRunOverrides, onStatusChange?: (status: string, record: AgentRecord) => void, onProgress?: (event: { type: "message" | "tool"; text: string }) => void, onHealthChange?: (event: { health: string; reason?: string; warning: boolean }) => void): Promise<AgentRunResult> {
	assertModelOverride(context.modelsConfig, overrides?.model);
	if (overrides?.thinking !== undefined && !THINKING_LEVELS.includes(overrides.thinking)) {
		throw new Error(`Unknown thinking level: ${overrides.thinking}. Use one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	if (overrides?.sessionMode !== undefined && overrides.sessionMode !== "shared" && overrides.sessionMode !== "fresh") {
		throw new Error(`Unknown session mode: ${overrides.sessionMode}. Use shared or fresh.`);
	}
	if (!task.trim()) throw new Error("run requires task");
	const record = findSingle(context.cwd, selector, context.sessionId);
	const selectedRole = overrides?.role ?? record.role;
	const allowedRoles = getAgentRoles(record);
	if (!allowedRoles.includes(selectedRole)) {
		throw new Error(`Agent ${record.name} is not registered for role ${selectedRole}; allowed roles: ${allowedRoles.join(", ")}`);
	}
	const path = registryPath(context.cwd, record.scope);
	const persistentSessionId = overrides?.sessionMode === "fresh"
		? `${record.sessionId}-fresh-${randomUUID()}`
		: record.sessionId;
	const running = updateRegistry(path, agents => {
		const current = agents.find(agent => agent.id === record.id);
		if (!current) throw new Error(`Agent not found: ${selector}`);
		if (current.status === "running") throw new Error(`Agent is already running: ${current.name}`);
		current.status = "running";
		current.lastTask = task;
		current.lastRole = selectedRole;
		current.lastSessionId = persistentSessionId;
		current.updatedAt = new Date().toISOString();
		return structuredClone(current);
	});
	onStatusChange?.("running", running);
	context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, taskId: context.taskId, agentId: running.id, agent: running.name, kind: "subagent", origin: running.lineage.origin, status: "running", action: "started", role: selectedRole, forkPoint: running.lineage.forkPoint, model: running.model ?? context.defaultModel });
	let result: AgentRunResult;
	try {
		const template = toTemplate(running, selectedRole, context.cwd, context.modelsConfig, context.sharedSkills ?? [], { model: context.defaultModel, provider: context.defaultProvider });
		if (overrides?.model) {
			template.model = overrides.model;
			template.provider = context.modelsConfig?.models?.[overrides.model]?.provider;
		}
		if (overrides?.thinking !== undefined) template.thinking = overrides.thinking;
		result = await runAgent({
			cwd: context.cwd,
			agent: template,
			task,
			sessionId: context.sessionId,
			taskId: context.taskId,
			executionId: context.executionId,
			telemetry: context.telemetry,
			prefixLayout: context.prefixLayout,
			persistent: true,
			persistentSessionId,
			sessionDir: sessionDir ?? join(context.cwd, ".agentflux", "runtime", "sessions"),
			pricing: context.pricing,
			timeoutMs: context.timeoutMs,
			deadlineAt: context.deadlineAt,
			maxCostUsd: context.maxCostUsd,
			parentMaxCostUsd: context.parentMaxCostUsd,
			parentMaxTurns: context.parentMaxTurns,
			parentMaxInputTokens: context.parentMaxInputTokens,
			parentMaxParallel: context.parentMaxParallel,
			health: context.health,
			onHealthChange,
			lockFiles: context.lockFiles,
			signal,
			onProgress: onProgress,
			invocationOverride: context.invocationOverride,
			registeredRoles: allowedRoles,
		});
	} catch (error) {
		let failed: AgentRecord;
		try {
			failed = updateRegistry(path, agents => {
				const current = agents.find(agent => agent.id === running.id);
				if (!current) throw new Error(`Agent disappeared while running: ${running.name}`);
				current.status = signal?.aborted ? "cancelled" : "failed";
				current.lastResult = {
					exitCode: signal?.aborted ? 130 : 1,
					success: false,
					summary: String(error instanceof Error ? error.message : error).slice(0, 300),
					turns: 0, costUsd: 0, role: selectedRole, at: new Date().toISOString(),
				};
				current.updatedAt = new Date().toISOString();
				return structuredClone(current);
			});
		} catch (inner) {
			// 状态写回失败时保留原始 run 错误（原因为主），写回错误附加说明
			throw new AggregateError([error, inner], `run failed and status write-back also failed: ${String(inner instanceof Error ? inner.message : inner)}`);
		}
		context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, taskId: context.taskId, agentId: running.id, agent: running.name, kind: "subagent", origin: running.lineage.origin, status: signal?.aborted ? "cancelled" : "failed", action: signal?.aborted ? "cancelled" : "failed", role: selectedRole });
		onStatusChange?.(signal?.aborted ? "cancelled" : "failed", failed);
		throw error;
	}
	const completed = updateRegistry(path, agents => {
		const current = agents.find(agent => agent.id === running.id);
		if (!current) throw new Error(`Agent disappeared while running: ${running.name}`);
		current.status = result.exitCode === 0 && !result.errorMessage ? "idle" : result.exitCode === 130 ? "cancelled" : "failed";
		current.callCount += 1;
		current.totalCostUsd += result.usage.cost;
		current.lastResult = {
			exitCode: result.exitCode,
			success: result.exitCode === 0 && !result.errorMessage,
			summary: result.errorMessage?.slice(0, 300) ?? result.output.trim().slice(0, 300) ?? "",
			turns: result.usage.turns,
			costUsd: result.usage.cost,
			model: result.model ?? undefined,
			role: selectedRole,
			at: new Date().toISOString(),
		};
		current.updatedAt = new Date().toISOString();
		return structuredClone(current);
	});
	context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, taskId: context.taskId, agentId: completed.id, agent: completed.name, kind: "subagent", origin: completed.lineage.origin, status: completed.status, action: completed.status === "idle" ? "completed" : completed.status === "cancelled" ? "cancelled" : "failed", role: selectedRole });
	onStatusChange?.(completed.status, completed);
	return result;
}

/**
 * Main 派发的 persistent Agent 运行统一持有 main-space lease；Workflow/测试
 * 可省略 space，避免把节点级执行与外层 Workflow lease 重复计数。
 */
export async function runAgentRecord(selector: string, task: string, context: AgentRunContext, signal?: AbortSignal, sessionDir?: string, overrides?: AgentRunOverrides, onStatusChange?: (status: string, record: AgentRecord) => void, onProgress?: (event: { type: "message" | "tool"; text: string }) => void, onHealthChange?: (event: { health: string; reason?: string; warning: boolean }) => void): Promise<AgentRunResult> {
	let lease: ReturnType<typeof registerActiveContext> | undefined;
	try {
		if (context.space) {
			lease = registerActiveContext(context.cwd, {
				name: `${context.space}:${context.sessionId}:${randomUUID()}`,
				context: context.space,
				scope: context.executionId ?? context.taskId ?? context.sessionId,
				task,
			});
		}
		return await runAgentRecordCore(selector, task, context, signal, sessionDir, overrides, onStatusChange, onProgress, onHealthChange);
	} finally {
		if (lease) releaseActiveContext(context.cwd, lease.leaseId);
	}
}

/** 会话结束清理：删除本会话创建的 session 作用域 Agent（运行中保留）。 */
export function deleteSessionAgents(cwd: string, ownerSessionId: string): string[] {
	const removed: string[] = [];
	const path = join(cwd, ".agentflux", "runtime", "agents.json");
	updateRegistry(path, agents => {
		const kept = agents.filter(agent => !(agent.scope === "session" && agent.ownerSessionId === ownerSessionId && agent.status !== "running"));
		for (const agent of agents) {
			if (!kept.includes(agent) && agent.status !== "running") removed.push(agent.name);
		}
		agents.splice(0, agents.length, ...kept);
	});
	return removed;
}

/** 重置状态（孤儿 running 恢复等）。 */
export function resetAgentStatus(cwd: string, selector: string, status: Exclude<AgentStatus, "archived">, ownerSessionId?: string): AgentRecord {
	const record = findSingle(cwd, selector, ownerSessionId);
	const path = registryPath(cwd, record.scope);
	return updateRegistry(path, agents => {
		const current = agents.find(agent => agent.id === record.id);
		if (!current) throw new Error(`Agent not found: ${selector}`);
		current.status = status;
		current.updatedAt = new Date().toISOString();
		return structuredClone(current);
	});
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "-";
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function ageFrom(timestamp: string | undefined, now = Date.now()): number | undefined {
	if (!timestamp) return undefined;
	const at = Date.parse(timestamp);
	return Number.isFinite(at) ? Math.max(0, now - at) : undefined;
}

function latestActiveRuns(cwd: string): Map<string, AgentRunRecord> {
	const latest = new Map<string, AgentRunRecord>();
	try {
		for (const run of listAgentRuns(join(cwd, ".agentflux"), { activeOnly: true })) {
			if (!latest.has(run.agent)) latest.set(run.agent, run);
		}
	} catch { /* registry 损坏/不可读时不影响 Agent 身份列表 */ }
	return latest;
}

/**
 * 格式化 Agent 列表。兼容旧的 formatAgents(records, cwd) 调用，也支持
 * formatAgents(cwd)；在线字段只从 Core Run Registry 的 active Run 读取。
 */
export function formatAgents(cwd: string): string;
export function formatAgents(agents: AgentRecord[], cwd?: string): string;
export function formatAgents(input: AgentRecord[] | string, cwd?: string): string {
	const projectCwd = typeof input === "string" ? input : cwd;
	const agents = typeof input === "string" ? listAgents(input) : input;
	if (agents.length === 0) return "No Agents.";
	const active = projectCwd ? latestActiveRuns(projectCwd) : new Map<string, AgentRunRecord>();
	const now = Date.now();
	const sorted = sortAgentsByActivity(agents).sort((left, right) => Number(active.has(right.name)) - Number(active.has(left.name)));
	return ["Agents:", ...sorted.map(agent => {
		const run = active.get(agent.name);
		const summary = (agent.lastResult?.summary.trim().replace(/\s+/g, " ") || "(no output)").slice(0, 60);
		const roles = getAgentRoles(agent);
		const roleLabel = roles.length > 1 ? roles.join("|") : roles[0];
		const historicalCost = Number.isFinite(agent.totalCostUsd) ? agent.totalCostUsd : 0;
		const runModel = run?.model ?? agent.model ?? "default";
		const runProvider = run?.provider ?? agent.provider ?? "-";
		const activity = (run?.lastActivitySummary || run?.currentTask || "-").replace(/\s+/g, " ").slice(0, 100);
		const error = [run?.error, run?.modelError, run?.providerError].find(value => !!value)?.replace(/\s+/g, " ").slice(0, 120);
		const pending = run ? (() => { try { return new MessageBus(join(projectCwd ?? "", ".agentflux")).peek(agent.name, { limit: 100 }).filter(item => ["pending", "delivered"].includes(item.delivery.status)).length; } catch { return 0; } })() : 0;
		const progressFreshness = ageFrom(run?.lastProgressAt, now);
		const live = run
			? ` run=${run.status} phase=${run.phase} health=${run.health} elapsed=${formatDuration(ageFrom(run.createdAt, now))} freshness=${formatDuration(ageFrom(run.lastActivityAt, now))} progress=${formatDuration(progressFreshness)} turns=${run.turns} input=${run.input} output=${run.output} tokens=${run.input + run.output} liveCost=$${run.costUsd.toFixed(6)} model=${runModel} provider=${runProvider} queued=${pending} activity=${activity}${run.healthReason ? ` healthReason=${run.healthReason}` : ""}${error ? ` error=${error}` : ""}`
			: ` run=none phase=- elapsed=- freshness=- turns=0 input=0 output=0 tokens=0 liveCost=$0.000000 model=${runModel} provider=${runProvider} activity=-`;
		const displayStatus = run?.status ?? agent.status;
		const lines = [`  ${displayStatus.padEnd(14)} ${agent.name.padEnd(20)} scope=${agent.scope.padEnd(7)} role=${roleLabel} calls=${agent.callCount} totalCost=$${historicalCost.toFixed(6)}${live}${agent.lastResult ? ` last=${agent.lastResult.success ? "SUCCESS" : "FAILED"}${roles.length > 1 ? `·${agent.lastResult.role ?? agent.lastRole ?? roleLabel}` : ""}·t${agent.lastResult.turns}·$${agent.lastResult.costUsd.toFixed(6)}·${summary}` : ""}`];
		const sessionCommand = projectCwd ? formatAgentSessionCommand(projectCwd, agent) : undefined;
		if (sessionCommand) lines.push(`     ${sessionCommand}`);
		return lines.join("\n");
	})].join("\n");
}

/** 解析子代理实际会话文件（shared/fresh 均为 <时间戳>_<persistentSessionId>-cap-<hash>.jsonl，按最近一次 key 扫描）。 */
export function resolveAgentSessionFile(cwd: string, record: AgentRecord): string | undefined {
	const sessionKey = record.lastSessionId ?? record.sessionId;
	if (!sessionKey) return undefined;
	const sessionsDir = join(cwd, ".agentflux", "runtime", "sessions");
	const pattern = `_${sessionKey}-cap-`;
	try {
		const name = readdirSync(sessionsDir)
			.filter(name => name.endsWith(".jsonl") && name.includes(pattern))
			.map(name => ({ name, mtime: statSync(join(sessionsDir, name)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)[0]?.name;
		return name ? join(sessionsDir, name) : undefined;
	} catch { return undefined; }
}

/** 读取子代理会话文件中最后 count 条 assistant 文本消息（时间正序，最新在后；Talk 展示“对话内容”用）。
 * 会话文件事件类型为 message（非 message_end），逐行扫描收集最后 count 条含 text 的 assistant 消息。 */
export function readAgentLastMessages(cwd: string, record: AgentRecord, count = 3): string[] {
	const sessionFile = resolveAgentSessionFile(cwd, record);
	if (!sessionFile) return [];
	const messages: string[] = [];
	try {
		const lines = readFileSync(sessionFile, "utf8").split("\n");
		for (const line of lines) {
			try {
				const event = JSON.parse(line);
				if (event?.type === "message" && event.message?.role === "assistant") {
					const texts = (event.message.content ?? [])
						.filter((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim())
						.map((block: any) => block.text.trim());
					if (texts.length) messages.push(texts.join(" "));
				}
			} catch { /* 跳过坏行 */ }
		}
	} catch { return []; }
	return messages.slice(-count);
}

/** 读取子代理会话文件中最后一条 assistant 文本消息（“最后说的话”，Talk 展示用）。 */
export function readAgentLastMessage(cwd: string, record: AgentRecord): string | undefined {
	return readAgentLastMessages(cwd, record, 1)[0];
}

/** 进入子代理直接对话窗口的启动命令（单行）：npx pi --session "<会话文件>"。无会话文件时返回 undefined。 */
export function formatAgentSessionCommand(cwd: string, record: AgentRecord): string | undefined {
	const sessionFile = resolveAgentSessionFile(cwd, record);
	return sessionFile ? `npx pi --session "${sessionFile}"` : undefined;
}

/** TUI 底部状态行：运行中的优先，其次按创建时间新旧（最新在前），单行超长省略。 */
/** 排序：运行中优先，其次按创建时间最新在前（/flux agent list、TUI 菜单与底部栏共用，保证一致）。 */
export function sortAgentsByActivity(agents: AgentRecord[]): AgentRecord[] {
	return [...agents].sort((a, b) => {
		const arunning = a.status === "running" ? 0 : 1;
		const brunning = b.status === "running" ? 0 : 1;
		if (arunning !== brunning) return arunning - brunning;
		return String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
	});
}

export function formatSubagentStatusLine(agents: AgentRecord[]): string | undefined {
	const sorted = sortAgentsByActivity(agents.filter(agent => agent.status !== "archived"));
	if (sorted.length === 0) return undefined;
	const line = `subagent: ${sorted.map(agent => `${agent.name} - ${agent.status}`).join(" | ")}`;
	return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}
