import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonStore, updateJsonStore } from "../core/json-store";
import type { PricingTable } from "../core/pricing";
import { assertSafePathSegment } from "../core/safe-path";
import type { AgentRecord, AgentStatus } from "../core/types";
import type { TelemetryWriter } from "../telemetry/events";
import { runAgent, type AgentRunResult, type AgentTemplate } from "./agent-runner";
import { loadAllRoles } from "./templates";

interface AgentRegistry { agents: AgentRecord[]; }

export interface PersistentAgentContext {
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

function registryPath(cwd: string): string { return join(cwd, ".agentflux", "runtime", "agents.json"); }
const createRegistry = (): AgentRegistry => ({ agents: [] });
const isRegistry = (value: unknown): value is AgentRegistry =>
	!!value && typeof value === "object" && Array.isArray((value as AgentRegistry).agents);

export function listPersistentAgents(cwd: string): AgentRecord[] {
	return readJsonStore(registryPath(cwd), createRegistry, isRegistry).agents;
}

function updateRegistry<R>(cwd: string, update: (agents: AgentRecord[]) => R): R {
	return updateJsonStore(registryPath(cwd), createRegistry, isRegistry, store => update(store.agents));
}

export function resetPersistentAgentStatus(cwd: string, name: string, status: Exclude<AgentStatus, "archived">): AgentRecord {
	return updateRegistry(cwd, agents => {
		const current = agents.find(agent => agent.name === name && agent.status !== "archived");
		if (!current) throw new Error(`Persistent Agent not found: ${name}`);
		current.status = status;
		current.updatedAt = new Date().toISOString();
		return structuredClone(current);
	});
}

export function registerPersistentAgent(cwd: string, name: string, role: string, modelsConfig: any): AgentRecord {
	name = assertSafePathSegment(name, "Persistent Agent name");
	const roles = loadAllRoles(cwd, modelsConfig);
	const template = roles.get(role);
	if (!template) throw new Error(`Unknown Agent template: ${role}`);
	const model = template.model;
	const now = new Date().toISOString();
	const record: AgentRecord = {
		id: `agent-${randomUUID()}`,
		name,
		scope: "project",
		role,
		status: "idle",
		lineage: { origin: "template", templateId: role, templateRevision: 1 },
		model,
		provider: model ? modelsConfig?.models?.[model]?.provider : undefined,
		sessionId: `persistent-${name}`,
		createdAt: now,
		updatedAt: now,
		callCount: 0,
		totalCostUsd: 0,
		capabilityGeneration: 1,
	};
	return updateRegistry(cwd, agents => {
		if (agents.some(agent => agent.name === name && agent.status !== "archived")) {
			throw new Error(`Persistent Agent already exists: ${name}`);
		}
		agents.push(record);
		return record;
	});
}

export function archivePersistentAgent(cwd: string, name: string): AgentRecord {
	return updateRegistry(cwd, agents => {
		const record = agents.find(agent => agent.name === name && agent.status !== "archived");
		if (!record) throw new Error(`Persistent Agent not found: ${name}`);
		if (record.status === "running") throw new Error(`Persistent Agent is running: ${name}`);
		record.status = "archived";
		record.updatedAt = new Date().toISOString();
		return record;
	});
}

function toTemplate(record: AgentRecord, cwd: string, modelsConfig: any, sharedSkills: string[]): AgentTemplate {
	const role = loadAllRoles(cwd, modelsConfig).get(record.role);
	if (!role) throw new Error(`Unknown Agent template: ${record.role}`);
	return {
		name: record.name,
		role: record.role,
		description: role.description ?? record.role,
		model: role.model,
		provider: role.model ? modelsConfig?.models?.[role.model]?.provider : undefined,
		tools: role.tools,
		skills: [...new Set([...sharedSkills, ...(role.skills ?? [])])],
		mcpServers: role.mcpServers,
		workspace: role.workspace,
		systemPrompt: role.systemPrompt ?? `You are the ${record.role} specialist.`,
		thinking: role.thinking,
		communication: role.communication,
	};
}

export async function runPersistentAgent(name: string, task: string, context: PersistentAgentContext, signal?: AbortSignal): Promise<AgentRunResult> {
	const record = updateRegistry(context.cwd, agents => {
		const current = agents.find(agent => agent.name === name && agent.status !== "archived");
		if (!current) throw new Error(`Persistent Agent not found: ${name}`);
		if (current.status === "running") throw new Error(`Persistent Agent is already running: ${name}`);
		current.status = "running";
		current.lastTask = task;
		current.updatedAt = new Date().toISOString();
		return structuredClone(current);
	});
	context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, taskId: context.taskId, agentId: record.id, agent: record.name, kind: "subagent", origin: record.lineage.origin, status: "running", action: "started" });
	let result: AgentRunResult;
	try {
		result = await runAgent({
			cwd: context.cwd,
			agent: toTemplate(record, context.cwd, context.modelsConfig, context.sharedSkills ?? []),
			task,
			sessionId: context.sessionId,
			taskId: context.taskId,
			executionId: context.executionId,
			telemetry: context.telemetry,
			prefixLayout: context.prefixLayout,
			persistent: true,
			persistentSessionId: record.sessionId,
			sessionDir: join(context.cwd, ".agentflux", "runtime", "sessions"),
			pricing: context.pricing,
			timeoutMs: context.timeoutMs,
			maxCostUsd: context.maxCostUsd,
			signal,
			invocationOverride: context.invocationOverride,
		});
	} catch (error) {
		updateRegistry(context.cwd, agents => {
			const current = agents.find(agent => agent.id === record.id);
			if (current) {
				current.status = "failed";
				current.updatedAt = new Date().toISOString();
			}
		});
		context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, taskId: context.taskId, agentId: record.id, agent: record.name, kind: "subagent", origin: record.lineage.origin, status: "failed", action: "failed" });
		throw error;
	}
	const completed = updateRegistry(context.cwd, agents => {
		const current = agents.find(agent => agent.id === record.id);
		if (!current) throw new Error(`Persistent Agent disappeared while running: ${name}`);
		current.status = result.exitCode === 0 && !result.errorMessage ? "idle" : result.exitCode === 130 ? "cancelled" : "failed";
		current.callCount += 1;
		current.totalCostUsd += result.usage.cost;
		current.updatedAt = new Date().toISOString();
		return structuredClone(current);
	});
	context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, taskId: context.taskId, agentId: completed.id, agent: completed.name, kind: "subagent", origin: completed.lineage.origin, status: completed.status, action: completed.status === "idle" ? "completed" : completed.status === "cancelled" ? "cancelled" : "failed" });
	return result;
}

export function formatPersistentAgents(agents: AgentRecord[]): string {
	if (agents.length === 0) return "No persistent Agents.";
	return ["Persistent Agents:", ...agents.map(agent => `  ${agent.status.padEnd(9)} ${agent.name.padEnd(20)} role=${agent.role} calls=${agent.callCount} cost=$${agent.totalCostUsd.toFixed(6)}`)].join("\n");
}
