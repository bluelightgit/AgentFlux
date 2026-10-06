import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonStore } from "./json-store";

interface Target { id: string; name: string; scope?: string; ownerSessionId?: string; status?: string; }
interface Registry { agents: Target[]; }
const valid = (value: unknown): value is Registry => !!value && typeof value === "object" && Array.isArray((value as Registry).agents);

/** 调用者持有共同 fence；显式注册引用必须重新解析，不把逻辑 actor 或持久会话推断成 Agent。 */
export function findAgentReference(cwd: string, selector: string, ownerSessionId?: string): Target | undefined {
	const all = [join(homedir(), ".agentflux", "agents.json"), join(cwd, ".agentflux", "runtime", "agents.json")]
		.flatMap(path => readJsonStore(path, () => ({ agents: [] }), valid).agents)
		.map(agent => ({ ...agent, id: agent.id ?? `legacy-${agent.name}` }));
	const matches = all.filter(agent => agent.id === selector || agent.name === selector);
	if (matches.length === 0) return undefined;
	if (matches.length !== 1 || matches[0].status === "archived"
		|| (matches[0].scope === "session" && (!ownerSessionId || matches[0].ownerSessionId !== ownerSessionId))) {
		throw new Error(`Registered Agent reference is missing, inaccessible or ambiguous: ${selector}`);
	}
	return matches[0];
}

export function resolveAgentReference(cwd: string, selector: string, ownerSessionId?: string): Target {
	if (typeof selector !== "string" || !selector.trim()) throw new Error("Registered Agent reference must be a non-empty string");
	const target = findAgentReference(cwd, selector, ownerSessionId);
	if (!target) throw new Error(`Registered Agent reference is missing, inaccessible or ambiguous: ${selector}`);
	return target;
}

export function assertAgentReference(cwd: string, id: string, ownerSessionId?: string): Target {
	const agent = resolveAgentReference(cwd, id, ownerSessionId);
	if (agent.id !== id) throw new Error(`Registered Agent reference requires a stable id: ${id}`);
	return agent;
}
