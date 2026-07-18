import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PricingTable } from "../core/pricing";
import type { AgentRecord } from "../core/types";
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
	sharedSkills?: string[];
	prefixLayout: boolean;
	timeoutMs?: number;
	maxCostUsd?: number;
	invocationOverride?: { command: string; args: string[] };
}

function registryPath(cwd: string): string { return join(cwd, ".agentflux", "runtime", "agents.json"); }

export function listPersistentAgents(cwd: string): AgentRecord[] {
	const path = registryPath(cwd);
	if (!existsSync(path)) return [];
	try {
		const data = JSON.parse(readFileSync(path, "utf-8")) as AgentRegistry;
		return Array.isArray(data.agents) ? data.agents : [];
	} catch { return []; }
}

function save(cwd: string, agents: AgentRecord[]): void {
	const path = registryPath(cwd);
	mkdirSync(join(cwd, ".agentflux", "runtime"), { recursive: true });
	writeFileSync(path, JSON.stringify({ agents } satisfies AgentRegistry, null, 2));
}

export function registerPersistentAgent(cwd: string, name: string, role: string, modelsConfig: any): AgentRecord {
	const roles = loadAllRoles(cwd, modelsConfig);
	const template = roles.get(role);
	if (!template) throw new Error(`Unknown Agent template: ${role}`);
	const agents = listPersistentAgents(cwd);
	if (agents.some(agent => agent.name === name && agent.status !== "archived")) throw new Error(`Persistent Agent already exists: ${name}`);
	const model = template.model;
	const now = new Date().toISOString();
	const record: AgentRecord = {
		id: `agent-${randomUUID()}`,
		name,
		kind: "persistent",
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
	agents.push(record); save(cwd, agents); return record;
}

export function archivePersistentAgent(cwd: string, name: string): AgentRecord {
	const agents = listPersistentAgents(cwd);
	const record = agents.find(agent => agent.name === name && agent.status !== "archived");
	if (!record) throw new Error(`Persistent Agent not found: ${name}`);
	if (record.status === "running") throw new Error(`Persistent Agent is running: ${name}`);
	record.status = "archived"; record.updatedAt = new Date().toISOString(); save(cwd, agents); return record;
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
	const agents = listPersistentAgents(context.cwd);
	const record = agents.find(agent => agent.name === name && agent.status !== "archived");
	if (!record) throw new Error(`Persistent Agent not found: ${name}`);
	if (record.status === "running") throw new Error(`Persistent Agent is already running: ${name}`);
	record.status = "running"; record.lastTask = task; record.updatedAt = new Date().toISOString(); save(context.cwd, agents);
	context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, agentId: record.id, agent: record.name, kind: "persistent", origin: record.lineage.origin, status: "running", action: "started" });
	let result: AgentRunResult;
	try {
		result = await runAgent({
			cwd: context.cwd,
			agent: toTemplate(record, context.cwd, context.modelsConfig, context.sharedSkills ?? []),
			task,
			sessionId: context.sessionId,
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
		record.status = "failed"; record.updatedAt = new Date().toISOString(); save(context.cwd, agents);
		context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, agentId: record.id, agent: record.name, kind: "persistent", origin: record.lineage.origin, status: "failed", action: "failed" });
		throw error;
	}
	record.status = result.exitCode === 0 && !result.errorMessage ? "idle" : result.exitCode === 130 ? "cancelled" : "failed";
	record.callCount += 1; record.totalCostUsd += result.usage.cost; record.updatedAt = new Date().toISOString(); save(context.cwd, agents);
	context.telemetry?.writeAgentLifecycle({ sessionId: context.sessionId, agentId: record.id, agent: record.name, kind: "persistent", origin: record.lineage.origin, status: record.status, action: record.status === "idle" ? "completed" : record.status === "cancelled" ? "cancelled" : "failed" });
	return result;
}

export function formatPersistentAgents(agents: AgentRecord[]): string {
	if (agents.length === 0) return "No persistent Agents.";
	return ["Persistent Agents:", ...agents.map(agent => `  ${agent.status.padEnd(9)} ${agent.name.padEnd(20)} role=${agent.role} calls=${agent.callCount} cost=$${agent.totalCostUsd.toFixed(6)}`)].join("\n");
}
