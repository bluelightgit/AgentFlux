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
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonStore, updateJsonStore } from "../core/json-store";
import type { PricingTable } from "../core/pricing";
import { assertSafePathSegment } from "../core/safe-path";
import type { AgentRecord, AgentScope, AgentStatus } from "../core/types";
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
	timeoutMs?: number;
	maxCostUsd?: number;
	invocationOverride?: { command: string; args: string[] };
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
		role: record.role ?? "assistant",
		status: record.status ?? "idle",
		lineage: record.lineage ?? { origin: "fresh", forkedFrom: undefined },
		model: record.model,
		provider: record.provider,
		thinking: record.thinking,
		sessionId: record.sessionId,
		ownerSessionId: record.ownerSessionId,
		createdAt: record.createdAt ?? now,
		updatedAt: record.updatedAt ?? now,
		lastTask: record.lastTask,
		callCount: record.callCount ?? 0,
		totalCostUsd: record.totalCostUsd ?? 0,
		capabilityGeneration: record.capabilityGeneration ?? 1,
	};
}
const createRegistry = (): AgentRegistry => ({ agents: [] });
const isRegistry = (value: unknown): value is AgentRegistry =>
	!!value && typeof value === "object" && Array.isArray((value as AgentRegistry).agents);

function updateRegistry<R>(path: string, update: (agents: AgentRecord[]) => R): R {
	return updateJsonStore(path, createRegistry, isRegistry, store => update(store.agents));
}

/** 全部作用域列表（global → project → session 同文件）。 */
export function listAgents(cwd: string): AgentRecord[] {
	const global = readJsonStore(registryPath(cwd, "global"), createRegistry, isRegistry).agents;
	const project = readJsonStore(registryPath(cwd, "project"), createRegistry, isRegistry).agents;
	return [...global, ...project].map(normalizeAgentRecord);
}

/** 按 id（精确）或 name（可能多个）查找；archived/已删除不返回。 */
export function findAgents(cwd: string, selector: string): AgentRecord[] {
	return listAgents(cwd).filter(agent => agent.status !== "archived" && (agent.id === selector || agent.name === selector));
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
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 模型覆盖必须存在于模型表（fail-closed，防止无效模型白跑成本）。 */
function assertModelOverride(modelsConfig: any, model: string | undefined): void {
	if (model === undefined) return;
	if (!modelsConfig?.models?.[model]) {
		throw new Error(`Unknown model: ${model}. Available models: ${Object.keys(modelsConfig?.models ?? {}).join(", ") || "none"}.`);
	}
}

export function createAgent(cwd: string, input: { name: string; role?: string; forkFrom?: string; scope?: AgentScope; ownerSessionId?: string; modelsConfig: any; model?: string; thinking?: AgentRunOverrides["thinking"] }): AgentRecord {
	const safeName = assertSafePathSegment(input.name, "Agent name");
	const scope: AgentScope = input.scope ?? "project";
	const roles = loadAllRoles(cwd, input.modelsConfig);
	if (input.role && !roles.has(input.role)) {
		throw new Error(`Unknown Agent template: ${input.role}. Use a registered template id (${[...roles.keys()].join(", ") || "none available"}); role is not a free-form description.`);
	}
	const role = input.role ?? "assistant";
	assertModelOverride(input.modelsConfig, input.model);
	if (input.thinking !== undefined && !THINKING_LEVELS.includes(input.thinking)) {
		throw new Error(`Unknown thinking level: ${input.thinking}. Use one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	const template = roles.get(role);
	const now = new Date().toISOString();
	let sessionId: string | undefined;
	let forkPoint: string | undefined;
	if (input.forkFrom) {
		const forkCandidates = findAgents(cwd, input.forkFrom);
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
			origin: input.forkFrom ? "fork" : input.role ? "template" : "fresh",
			templateId: input.role,
			templateRevision: 1,
			forkPoint,
		},
		model: input.model ?? template?.model,
		provider: (() => { const m = input.model ?? template?.model; return m ? input.modelsConfig?.models?.[m]?.provider : undefined; })(),
		thinking: input.thinking ?? template?.thinking,
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
export function deleteAgent(cwd: string, selector: string): AgentRecord {
	for (const scope of ["global", "project"] as const) {
		const path = registryPath(cwd, scope);
		const removed = updateRegistry(path, agents => {
			const current = agents.find(agent => (agent.id === selector || agent.name === selector) && agent.status !== "archived");
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

function toTemplate(record: AgentRecord, cwd: string, modelsConfig: any, sharedSkills: string[]): AgentTemplate {
	const role = loadAllRoles(cwd, modelsConfig).get(record.role);
	if (!role) throw new Error(`Unknown Agent template: ${record.role}`);
	const model = record.model ?? role.model;
	return {
		name: record.name,
		role: record.role,
		description: role.description ?? record.role,
		model,
		provider: model ? modelsConfig?.models?.[model]?.provider : undefined,
		tools: role.tools,
		skills: [...new Set([...sharedSkills, ...(role.skills ?? [])])],
		mcpServers: role.mcpServers,
		workspace: role.workspace,
		systemPrompt: role.systemPrompt ?? `You are the ${record.role} specialist.`,
		thinking: record.thinking ?? role.thinking,
		communication: role.communication,
	};
}

function findSingle(cwd: string, selector: string): AgentRecord {
	const matches = findAgents(cwd, selector);
	if (matches.length === 0) throw new Error(`Agent not found: ${selector}`);
	if (matches.length > 1) {
		throw new Error(`Agent name "${selector}" is ambiguous: ${matches.map(agent => `${agent.name} (${agent.id})`).join(", ")}. Use the unique id.`);
	}
	return matches[0];
}

/**
 * 运行 Agent = 与子代理对话：发出指令并等待完成（超时可配），
 * 返回其最后一条消息；assistantMessages 供 last(k) 展示更多执行消息。
 * busy 时拒绝（对话排队由 Message V2 pending 投递承载）。
 */
export async function runAgentRecord(selector: string, task: string, context: AgentRunContext, signal?: AbortSignal, sessionDir?: string, overrides?: AgentRunOverrides): Promise<AgentRunResult> {
	assertModelOverride(context.modelsConfig, overrides?.model);
	if (overrides?.thinking !== undefined && !THINKING_LEVELS.includes(overrides.thinking)) {
		throw new Error(`Unknown thinking level: ${overrides.thinking}. Use one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	if (!task.trim()) throw new Error("run requires task");
	const record = findSingle(context.cwd, selector);
	const path = registryPath(context.cwd, record.scope);
	const running = updateRegistry(path, agents => {
		const current = agents.find(agent => agent.id === record.id);
		if (!current) throw new Error(`Agent not found: ${selector}`);
		if (current.status === "running") throw new Error(`Agent is already running: ${current.name}`);
		current.status = "running";
		current.lastTask = task;
		current.updatedAt = new Date().toISOString();
		return structuredClone(current);
	});
	context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, taskId: context.taskId, agentId: running.id, agent: running.name, kind: "subagent", origin: running.lineage.origin, status: "running", action: "started", role: running.role, forkPoint: running.lineage.forkPoint, model: running.model });
	let result: AgentRunResult;
	try {
		const template = toTemplate(running, context.cwd, context.modelsConfig, context.sharedSkills ?? []);
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
			persistentSessionId: running.sessionId,
			sessionDir: sessionDir ?? join(context.cwd, ".agentflux", "runtime", "sessions"),
			pricing: context.pricing,
			timeoutMs: context.timeoutMs,
			maxCostUsd: context.maxCostUsd,
			signal,
			invocationOverride: context.invocationOverride,
		});
	} catch (error) {
		updateRegistry(path, agents => {
			const current = agents.find(agent => agent.id === running.id);
			if (current) {
				current.status = signal?.aborted ? "cancelled" : "failed";
				current.updatedAt = new Date().toISOString();
			}
		});
		context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, taskId: context.taskId, agentId: running.id, agent: running.name, kind: "subagent", origin: running.lineage.origin, status: signal?.aborted ? "cancelled" : "failed", action: signal?.aborted ? "cancelled" : "failed" });
		throw error;
	}
	const completed = updateRegistry(path, agents => {
		const current = agents.find(agent => agent.id === running.id);
		if (!current) throw new Error(`Agent disappeared while running: ${running.name}`);
		current.status = result.exitCode === 0 && !result.errorMessage ? "idle" : result.exitCode === 130 ? "cancelled" : "failed";
		current.callCount += 1;
		current.totalCostUsd += result.usage.cost;
		current.updatedAt = new Date().toISOString();
		return structuredClone(current);
	});
	context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, taskId: context.taskId, agentId: completed.id, agent: completed.name, kind: "subagent", origin: completed.lineage.origin, status: completed.status, action: completed.status === "idle" ? "completed" : completed.status === "cancelled" ? "cancelled" : "failed" });
	return result;
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
export function resetAgentStatus(cwd: string, selector: string, status: Exclude<AgentStatus, "archived">): AgentRecord {
	const record = findSingle(cwd, selector);
	const path = registryPath(cwd, record.scope);
	return updateRegistry(path, agents => {
		const current = agents.find(agent => agent.id === record.id);
		if (!current) throw new Error(`Agent not found: ${selector}`);
		current.status = status;
		current.updatedAt = new Date().toISOString();
		return structuredClone(current);
	});
}

export function formatAgents(agents: AgentRecord[]): string {
	if (agents.length === 0) return "No Agents.";
	return ["Agents:", ...agents.map(agent => `  ${agent.status.padEnd(9)} ${agent.name.padEnd(20)} scope=${agent.scope.padEnd(7)} role=${agent.role} calls=${agent.callCount} cost=$${agent.totalCostUsd.toFixed(6)}`)].join("\n");
}
