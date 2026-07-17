/** Three-layer capability policy: role template -> registered instance -> run. */
import {
	existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
	resolveCommunicationPolicy, type CommunicationPolicy, type CommunicationPolicyInput,
} from "./communication-policy";

export type CapabilityLayer = "template" | "registered" | "run";

export interface WorkspaceCapabilityInput {
	roots?: string[];
	deniedPaths?: string[];
	blockDangerousCommands?: boolean;
}

export interface CapabilityPolicyInput {
	tools?: string[];
	skills?: string[];
	mcpServers?: string[];
	communication?: CommunicationPolicyInput;
	workspace?: WorkspaceCapabilityInput;
}

export interface EffectiveCapabilityPolicy {
	tools: string[];
	skills: string[];
	mcpServers: string[];
	communication: CommunicationPolicy;
	workspace: {
		roots: string[];
		deniedPaths: string[];
		blockDangerousCommands: boolean;
		/** bash inspection is conservative but is not an OS sandbox. */
		enforcement: "tool_hook_partial" | "unavailable";
	};
}

export interface CapabilityProvenance {
	field: "tools" | "skills" | "mcpServers" | "communication" | "workspace";
	sourceLayer: CapabilityLayer;
	reason: string;
}

export interface ResolvedCapabilityPolicy {
	schemaVersion: 1;
	agentName: string;
	role: string;
	instanceId?: string;
	runId: string;
	layers: {
		template: CapabilityPolicyInput;
		registered?: CapabilityPolicyInput;
		run?: CapabilityPolicyInput;
	};
	effective: EffectiveCapabilityPolicy;
	provenance: CapabilityProvenance[];
	narrowed: string[];
	updatedAt: string;
}

export interface RegisteredCapabilityOverride {
	schemaVersion: 1;
	agentName: string;
	role: string;
	revision: number;
	override: CapabilityPolicyInput;
	updatedAt: string;
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const ITEM = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;

function cleanList(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	const result = [...new Set(value.map(item => {
		if (typeof item !== "string" || !ITEM.test(item.trim())) throw new Error(`invalid ${field} item: ${String(item)}`);
		return item.trim();
	}))];
	return result.sort();
}

function cleanWorkspace(cwd: string, value?: WorkspaceCapabilityInput): EffectiveCapabilityPolicy["workspace"] {
	const roots = value?.roots?.length ? value.roots : [cwd];
	const normalizedRoots = [...new Set(roots.map(root => resolve(cwd, root)))].sort();
	const deniedPaths = [...new Set((value?.deniedPaths ?? []).map(path => resolve(cwd, path)))].sort();
	return {
		roots: normalizedRoots,
		deniedPaths,
		blockDangerousCommands: value?.blockDangerousCommands !== false,
		enforcement: "tool_hook_partial",
	};
}

function subset(next: string[], current: string[], field: string, layer: CapabilityLayer): string[] {
	const allowed = new Set(current);
	const widened = next.filter(item => !allowed.has(item));
	if (widened.length > 0) throw new Error(`${layer} ${field} cannot widen template/effective policy: ${widened.join(", ")}`);
	return next;
}

function targetCovered(target: string, allowed: string[]): boolean {
	return allowed.includes("*") || allowed.includes(target)
		|| (target.startsWith("group:") && allowed.includes("group:*"));
}

function narrowCommunication(
	current: CommunicationPolicy,
	override: CommunicationPolicyInput | undefined,
	layer: CapabilityLayer,
): CommunicationPolicy {
	if (!override) return current;
	if (!current.enabled && override.enabled !== false) throw new Error(`${layer} communication cannot re-enable a disabled template`);
	const actions = override.actions === undefined ? current.actions : subset(
		[...new Set(override.actions)], current.actions, "communication.actions", layer,
	) as CommunicationPolicy["actions"];
	const targets = override.allowedTargets === undefined ? current.allowedTargets : [...new Set(override.allowedTargets)];
	const widenedTargets = targets.filter(target => !targetCovered(target, current.allowedTargets));
	if (widenedTargets.length > 0) throw new Error(`${layer} communication targets cannot widen policy: ${widenedTargets.join(", ")}`);
	const required = override.requiredSendTo === undefined
		? current.requiredSendTo : [...new Set([...current.requiredSendTo, ...override.requiredSendTo])];
	if (override.requireExplicitInboxAck === false && current.requireExplicitInboxAck) {
		throw new Error(`${layer} communication cannot remove explicit ACK requirement`);
	}
	if (override.maxMessagesPerRun !== undefined && override.maxMessagesPerRun > current.maxMessagesPerRun) {
		throw new Error(`${layer} maxMessagesPerRun cannot increase above ${current.maxMessagesPerRun}`);
	}
	return resolveCommunicationPolicy(undefined, {
		enabled: current.enabled && override.enabled !== false,
		actions,
		allowedTargets: targets,
		requiredSendTo: required,
		requireExplicitInboxAck: current.requireExplicitInboxAck || override.requireExplicitInboxAck === true,
		maxMessagesPerRun: Math.min(current.maxMessagesPerRun, override.maxMessagesPerRun ?? current.maxMessagesPerRun),
	});
}

function pathWithin(path: string, roots: string[]): boolean {
	const normalized = resolve(path).toLowerCase();
	return roots.some(root => normalized === resolve(root).toLowerCase()
		|| normalized.startsWith(resolve(root).toLowerCase().replace(/[\\/]+$/, "") + "\\")
		|| normalized.startsWith(resolve(root).toLowerCase().replace(/[\\/]+$/, "") + "/"));
}

function narrowWorkspace(
	cwd: string,
	current: EffectiveCapabilityPolicy["workspace"],
	override: WorkspaceCapabilityInput | undefined,
	layer: CapabilityLayer,
): EffectiveCapabilityPolicy["workspace"] {
	if (!override) return current;
	const requestedRoots = override.roots?.map(root => resolve(cwd, root)) ?? current.roots;
	const widened = requestedRoots.filter(root => !pathWithin(root, current.roots));
	if (widened.length > 0) throw new Error(`${layer} workspace roots cannot widen policy: ${widened.join(", ")}`);
	if (current.blockDangerousCommands && override.blockDangerousCommands === false) {
		throw new Error(`${layer} cannot disable dangerous command blocking`);
	}
	return {
		roots: [...new Set(requestedRoots)].sort(),
		deniedPaths: [...new Set([...current.deniedPaths, ...(override.deniedPaths ?? []).map(path => resolve(cwd, path))])].sort(),
		blockDangerousCommands: current.blockDangerousCommands || override.blockDangerousCommands === true,
		enforcement: "tool_hook_partial",
	};
}

export function resolveCapabilityPolicy(input: {
	cwd: string;
	agentName: string;
	role: string;
	runId: string;
	instanceId?: string;
	template: CapabilityPolicyInput;
	registered?: CapabilityPolicyInput;
	run?: CapabilityPolicyInput;
}): ResolvedCapabilityPolicy {
	if (!NAME.test(input.agentName)) throw new Error(`invalid capability agent name: ${input.agentName}`);
	const template: CapabilityPolicyInput = {
		...input.template,
		tools: cleanList(input.template.tools ?? ["read", "bash", "edit", "write"], "tools"),
		skills: cleanList(input.template.skills ?? [], "skills"),
		mcpServers: cleanList(input.template.mcpServers ?? [], "mcpServers"),
	};
	let tools = template.tools!;
	let skills = template.skills!;
	let mcpServers = template.mcpServers!;
	let communication = resolveCommunicationPolicy(template.communication);
	let workspace = cleanWorkspace(input.cwd, template.workspace);
	const provenance: CapabilityProvenance[] = [
		{ field: "tools", sourceLayer: "template", reason: "role template allowlist" },
		{ field: "skills", sourceLayer: "template", reason: "shared + role template allowlist" },
		{ field: "mcpServers", sourceLayer: "template", reason: "role template allowlist" },
		{ field: "communication", sourceLayer: "template", reason: "role communication policy" },
		{ field: "workspace", sourceLayer: "template", reason: "project-root tool hook boundary" },
	];
	const narrowed: string[] = [];
	for (const [layer, override] of [["registered", input.registered], ["run", input.run]] as const) {
		if (!override) continue;
		const nextTools = cleanList(override.tools, "tools");
		const nextSkills = cleanList(override.skills, "skills");
		const nextMcp = cleanList(override.mcpServers, "mcpServers");
		if (nextTools) { tools = subset(nextTools, tools, "tools", layer); narrowed.push(`${layer}:tools`); }
		if (nextSkills) { skills = subset(nextSkills, skills, "skills", layer); narrowed.push(`${layer}:skills`); }
		if (nextMcp) { mcpServers = subset(nextMcp, mcpServers, "mcpServers", layer); narrowed.push(`${layer}:mcpServers`); }
		if (override.communication) { communication = narrowCommunication(communication, override.communication, layer); narrowed.push(`${layer}:communication`); }
		if (override.workspace) { workspace = narrowWorkspace(input.cwd, workspace, override.workspace, layer); narrowed.push(`${layer}:workspace`); }
		for (const field of ["tools", "skills", "mcpServers", "communication", "workspace"] as const) {
			if (override[field]) provenance.push({ field, sourceLayer: layer, reason: `${layer} override narrowed effective policy` });
		}
	}
	if (mcpServers.length > 0) {
		throw new Error(`MCP server policy cannot be enforced by the current pi runtime: ${mcpServers.join(", ")}`);
	}
	if (communication.enabled && !tools.includes("flux_agent_message")) tools = [...tools, "flux_agent_message"].sort();
	return {
		schemaVersion: 1,
		agentName: input.agentName,
		role: input.role,
		instanceId: input.instanceId,
		runId: input.runId,
		layers: { template: input.template, registered: input.registered, run: input.run },
		effective: { tools, skills, mcpServers, communication, workspace },
		provenance,
		narrowed,
		updatedAt: new Date().toISOString(),
	};
}

function readJson<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return null; }
}

function writeAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, JSON.stringify(value, null, 2), "utf-8");
	renameSync(temp, path);
}

function overridePath(fluxDir: string, agentName: string): string {
	if (!NAME.test(agentName)) throw new Error(`invalid capability agent name: ${agentName}`);
	return join(fluxDir, "runtime", "capability-overrides", `${agentName}.json`);
}

export function loadRegisteredCapabilityOverride(fluxDir: string, agentName: string): RegisteredCapabilityOverride | null {
	const record = readJson<RegisteredCapabilityOverride>(overridePath(fluxDir, agentName));
	return record?.schemaVersion === 1 && record.agentName === agentName ? record : null;
}

export function saveRegisteredCapabilityOverride(input: {
	fluxDir: string;
	agentName: string;
	role: string;
	override: CapabilityPolicyInput;
	expectedRevision?: number;
}): RegisteredCapabilityOverride {
	const path = overridePath(input.fluxDir, input.agentName);
	const lockPath = `${path}.lock`;
	mkdirSync(dirname(path), { recursive: true });
	let fd: number | null = null;
	let ownsLock = false;
	try {
		try {
			fd = openSync(lockPath, "wx");
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			let stale = false;
			try { stale = Date.now() - statSync(lockPath).mtimeMs > 30_000; } catch {}
			if (!stale) throw new Error(`capability override update already in progress: ${input.agentName}`);
			try { unlinkSync(lockPath); } catch {}
			fd = openSync(lockPath, "wx");
		}
		ownsLock = true;
		const current = loadRegisteredCapabilityOverride(input.fluxDir, input.agentName);
		if (input.expectedRevision !== undefined && (current?.revision ?? 0) !== input.expectedRevision) {
			throw new Error(`capability revision conflict: expected ${input.expectedRevision}, current ${current?.revision ?? 0}`);
		}
		const record: RegisteredCapabilityOverride = {
			schemaVersion: 1,
			agentName: input.agentName,
			role: input.role,
			revision: (current?.revision ?? 0) + 1,
			override: input.override,
			updatedAt: new Date().toISOString(),
		};
		writeAtomic(path, record);
		return record;
	} finally {
		if (fd !== null) closeSync(fd);
		if (ownsLock) try { unlinkSync(lockPath); } catch {}
	}
}

export function writeEffectiveCapabilitySnapshot(fluxDir: string, policy: ResolvedCapabilityPolicy): string {
	const path = join(fluxDir, "runtime", "capability-effective", `${policy.agentName}.json`);
	writeAtomic(path, policy);
	return path;
}

/** Host-side tool hook gate. This is enforceable for pi tools, but not an OS sandbox. */
export function evaluateCapabilityToolCall(
	policy: EffectiveCapabilityPolicy,
	cwd: string,
	toolName: string,
	input: Record<string, unknown>,
): string | null {
	if (!policy.tools.includes(toolName)) return `Tool ${toolName} is not allowed by effective capability policy`;
	const roots = policy.workspace.roots.map(root => resolve(cwd, root));
	const denied = policy.workspace.deniedPaths.map(path => resolve(cwd, path));
	const checkPath = (raw: unknown): string | null => {
		if (typeof raw !== "string" || !raw.trim()) return null;
		const path = resolve(cwd, raw);
		if (!pathWithin(path, roots)) return `Path outside allowed workspace roots: ${raw}`;
		if (denied.some(blocked => pathWithin(path, [blocked]))) return `Path denied by capability policy: ${raw}`;
		return null;
	};
	if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName)) {
		const reason = checkPath(input.path);
		if (reason) return reason;
	}
	if (toolName === "bash" && policy.workspace.blockDangerousCommands) {
		const command = String(input.command ?? "");
		const dangerous = [
			/\brm\s+(?:-[^\s]*r[^\s]*f|--recursive)/i,
			/\b(?:sudo|runas)\b/i,
			/\b(?:chmod|chown)\b/i,
			/\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f)/i,
			/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|pwsh|powershell)\b/i,
		];
		if (dangerous.some(pattern => pattern.test(command))) return "Dangerous command blocked by capability policy";
		if (/(?:^|[\s"'])(?:\.\.[\\/])/.test(command)) return "Parent-directory shell traversal blocked by capability policy";
		for (const path of command.match(/[a-zA-Z]:\\[^\s"']+/g) ?? []) {
			const reason = checkPath(path);
			if (reason) return reason;
		}
	}
	return null;
}
