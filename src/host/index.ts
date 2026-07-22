import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { archivePersistentAgent, listPersistentAgents, registerPersistentAgent } from "../agents/persistent-agent";
import { loadAllRoles } from "../agents/templates";
import { claimIssue, commentOnIssue, createIssue, getIssue, listIssues, resolveIssue, submitClaim } from "../core/community";
import { loadConfig, loadModelsConfig, validateConfig } from "../core/config";
import { runLifecycleGc, type LifecycleGcOptions } from "../core/lifecycle-gc";
import { MessageBus } from "../core/message-bus";
import type { FluxEvent } from "../telemetry/events";

export interface AgentFluxProjectSnapshot {
	config: ReturnType<typeof loadConfig>;
	warnings: string[];
	roles: ReturnType<typeof loadAllRoles> extends Map<string, infer T> ? T[] : never[];
	persistentAgents: ReturnType<typeof listPersistentAgents>;
	issues: ReturnType<typeof listIssues>;
}

export interface AgentFluxEventPage {
	events: FluxEvent[];
	nextCursor: number;
}

export function readAgentFluxProject(cwd: string): AgentFluxProjectSnapshot {
	const config = loadConfig(cwd);
	const modelsConfig = loadModelsConfig(cwd);
	return {
		config,
		warnings: validateConfig(config),
		roles: [...loadAllRoles(cwd, modelsConfig).values()],
		persistentAgents: listPersistentAgents(cwd),
		issues: listIssues(cwd),
	};
}

export function readAgentFluxEvents(cwd: string, cursor = 0): AgentFluxEventPage {
	const path = join(cwd, ".agentflux", "events.jsonl");
	if (!existsSync(path)) return { events: [], nextCursor: 0 };
	const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
	const start = Math.max(0, Math.min(Math.trunc(cursor), lines.length));
	const events: FluxEvent[] = [];
	for (const line of lines.slice(start)) {
		try { events.push(JSON.parse(line) as FluxEvent); } catch {}
	}
	return { events, nextCursor: lines.length };
}

export {
	archivePersistentAgent,
	claimIssue,
	commentOnIssue,
	createIssue,
	getIssue,
	listIssues,
	listPersistentAgents,
	registerPersistentAgent,
	resolveIssue,
	submitClaim,
};

export function sendAgentMessage(cwd: string, sender: string, target: string, content: string) {
	return new MessageBus(join(cwd, ".agentflux")).sendDirect(sender, target, "message", content);
}

export function acknowledgeAgentMessage(cwd: string, agent: string, messageId: string) {
	return new MessageBus(join(cwd, ".agentflux")).acknowledge(agent, messageId);
}

export function runAgentFluxGc(cwd: string, options: LifecycleGcOptions) {
	const config = loadConfig(cwd);
	return runLifecycleGc(join(cwd, ".agentflux"), config.retention, options);
}
