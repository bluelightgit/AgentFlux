/** Three-layer capability policy: role template -> registered instance -> run. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { withJsonStoreLock, writeJsonFileAtomic } from "./json-store";
import {
	resolveCommunicationPolicy, type CommunicationPolicy, type CommunicationPolicyInput,
} from "./communication-policy";

export type CapabilityLayer = "template" | "registered" | "run";

/**
 * Pi exposes PowerShell as a separate tool, but AgentFlux does not yet have a
 * reliable cross-platform parser/path gate for it.  It must therefore stay
 * fail-closed at both capability resolution and the runtime tool hook.  This
 * is deliberately not a Bash allowlist expansion.
 */
export const UNSUPPORTED_CAPABILITY_TOOLS = ["powershell"] as const;

export function capabilityToolUnsupportedReason(toolName: string): string | null {
	return UNSUPPORTED_CAPABILITY_TOOLS.includes(toolName.toLowerCase() as (typeof UNSUPPORTED_CAPABILITY_TOOLS)[number])
		? "PowerShell capability is unavailable: a reliable capability/path gate is not implemented"
		: null;
}

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

/**
 * Tool-call models sometimes materialize every optional array as `[]`. At the
 * run layer that must not silently mean "remove every capability". Explicit
 * deny-all flags keep that narrowing available without making an empty schema
 * shell destructive.
 */
export interface RuntimeCapabilityOverrideInput extends CapabilityPolicyInput {
	denyAllTools?: boolean;
	denyAllSkills?: boolean;
	denyAllMcpServers?: boolean;
}

export interface RuntimeCommunicationOverrideInput extends CommunicationPolicyInput {
	disable?: boolean;
}

function nonEmptyList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.length > 0 ? value as string[] : undefined;
}

/** Collapse provider-generated empty/default shells to an omitted run override. */
export function normalizeRuntimeCapabilityOverride(
	input?: RuntimeCapabilityOverrideInput,
): CapabilityPolicyInput | undefined {
	if (!input) return undefined;
	const tools = input.denyAllTools === true ? [] : nonEmptyList(input.tools);
	const skills = input.denyAllSkills === true ? [] : nonEmptyList(input.skills);
	const mcpServers = input.denyAllMcpServers === true ? [] : nonEmptyList(input.mcpServers);
	const roots = nonEmptyList(input.workspace?.roots);
	const deniedPaths = nonEmptyList(input.workspace?.deniedPaths);
	const workspace = roots || deniedPaths || input.workspace?.blockDangerousCommands === true
		? { roots, deniedPaths, blockDangerousCommands: input.workspace?.blockDangerousCommands === true ? true : undefined }
		: undefined;
	const result: CapabilityPolicyInput = { tools, skills, mcpServers, workspace };
	return Object.values(result).some(value => value !== undefined) ? result : undefined;
}

/**
 * Ignore the common false/empty/1 object produced for an omitted communication
 * override. `disable: true` is the unambiguous way to turn messaging off.
 */
export function normalizeRuntimeCommunicationOverride(
	input?: RuntimeCommunicationOverrideInput,
): CommunicationPolicyInput | undefined {
	if (!input) return undefined;
	const actions = nonEmptyList(input.actions) as CommunicationPolicyInput["actions"];
	const allowedTargets = nonEmptyList(input.allowedTargets);
	const requiredSendTo = nonEmptyList(input.requiredSendTo);
	const meaningful = input.disable === true || actions || allowedTargets || requiredSendTo
		|| input.requireExplicitInboxAck === true;
	if (!meaningful) return undefined;
	return {
		enabled: input.disable === true ? false : (input.enabled === true ? true : undefined),
		actions,
		allowedTargets,
		requiredSendTo,
		requireExplicitInboxAck: input.requireExplicitInboxAck === true ? true : undefined,
		maxMessagesPerRun: input.maxMessagesPerRun,
	};
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
	const unsupportedTool = tools.find(tool => capabilityToolUnsupportedReason(tool));
	if (unsupportedTool) {
		throw new Error(capabilityToolUnsupportedReason(unsupportedTool)!);
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
	let text: string;
	try { text = readFileSync(path, "utf-8"); } catch (error: any) {
		if (error?.code === "ENOENT") return null;
		throw new Error(`Cannot read capability store: ${path}`, { cause: error });
	}
	try {
		const value = JSON.parse(text);
		if (value === null) throw new Error("null is not a capability record");
		return value as T;
	} catch (error) {
		throw new Error(`Corrupt capability store (not overwritten): ${path}`, { cause: error });
	}
}

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value).every(key => keys.includes(key));
}

function validOverride(value: unknown): value is CapabilityPolicyInput {
	if (!objectWithKeys(value, ["tools", "skills", "mcpServers", "communication", "workspace"])) return false;
	const strings = (list: unknown, test: (s: string) => boolean) => Array.isArray(list)
		&& list.every(item => typeof item === "string" && test(item));
	for (const key of ["tools", "skills", "mcpServers"]) {
		if (value[key] !== undefined && !strings(value[key], s => ITEM.test(s))) return false;
	}
	const w = value.workspace;
	if (w !== undefined) {
		if (!objectWithKeys(w, ["roots", "deniedPaths", "blockDangerousCommands"])) return false;
		for (const key of ["roots", "deniedPaths"]) {
			if (w[key] !== undefined && !strings(w[key], s => !!s.trim() && !s.includes("\u0000"))) return false;
		}
		if (w.blockDangerousCommands !== undefined && typeof w.blockDangerousCommands !== "boolean") return false;
	}
	const c = value.communication;
	if (c !== undefined) {
		if (!objectWithKeys(c, ["enabled", "actions", "allowedTargets", "requiredSendTo", "requireExplicitInboxAck", "maxMessagesPerRun"])) return false;
		for (const key of ["enabled", "requireExplicitInboxAck"]) if (c[key] !== undefined && typeof c[key] !== "boolean") return false;
		if (c.actions !== undefined && !strings(c.actions, s => ["send", "poll", "ack", "status"].includes(s))) return false;
		for (const key of ["allowedTargets", "requiredSendTo"]) if (c[key] !== undefined && !strings(c[key], s => /^(?:\*|group:\*|group:[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}|[a-zA-Z0-9][a-zA-Z0-9._-]{0,79})$/.test(s))) return false;
		if (c.maxMessagesPerRun !== undefined && (!Number.isInteger(c.maxMessagesPerRun) || c.maxMessagesPerRun < 1 || c.maxMessagesPerRun > 100)) return false;
	}
	return true;
}

function readRegistered(path: string, agentName: string, role?: string): RegisteredCapabilityOverride | null {
	const record = readJson<unknown>(path);
	if (record === null) return null;
	if (!objectWithKeys(record, ["schemaVersion", "agentName", "role", "revision", "override", "updatedAt"])
		|| record.schemaVersion !== 1 || record.agentName !== agentName
		|| typeof record.role !== "string" || !record.role.trim() || (role !== undefined && record.role !== role)
		|| !Number.isSafeInteger(record.revision) || record.revision < 1
		|| typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))
		|| !validOverride(record.override)) throw new Error(`Invalid capability override schema/identity: ${path}`);
	return record as RegisteredCapabilityOverride;
}


function overridePath(fluxDir: string, agentName: string): string {
	if (!NAME.test(agentName)) throw new Error(`invalid capability agent name: ${agentName}`);
	return join(fluxDir, "runtime", "capability-overrides", `${agentName}.json`);
}

function roleArtifactSuffix(role: string): string {
	return createHash("sha256").update(role).digest("hex").slice(0, 16);
}

function roleOverridePath(fluxDir: string, agentName: string, role: string): string {
	if (!NAME.test(agentName)) throw new Error(`invalid capability agent name: ${agentName}`);
	return join(fluxDir, "runtime", "capability-overrides", `${agentName}.${roleArtifactSuffix(role)}.json`);
}

function effectiveSnapshotPath(fluxDir: string, agentName: string, role?: string): string {
	if (!NAME.test(agentName)) throw new Error(`invalid capability agent name: ${agentName}`);
	return join(fluxDir, "runtime", "capability-effective", role
		? `${agentName}.${roleArtifactSuffix(role)}.json`
		: `${agentName}.json`);
}

export function loadRegisteredCapabilityOverride(fluxDir: string, agentName: string): RegisteredCapabilityOverride | null {
	return readRegistered(overridePath(fluxDir, agentName), agentName);
}

/** 按本次所选角色读取实例收窄；旧的单角色文件仍可直接使用。 */
export function loadRegisteredCapabilityOverrideForRole(
	fluxDir: string,
	agentName: string,
	role: string,
): RegisteredCapabilityOverride | null {
	const scoped = readRegistered(roleOverridePath(fluxDir, agentName, role), agentName, role);
	if (scoped) return scoped;
	const base = loadRegisteredCapabilityOverride(fluxDir, agentName);
	return base?.role === role ? base : null;
}

export function loadEffectiveCapabilitySnapshot(fluxDir: string, agentName: string, role?: string): ResolvedCapabilityPolicy | null {
	const path = effectiveSnapshotPath(fluxDir, agentName, role);
	const record = readJson<ResolvedCapabilityPolicy>(path)
		?? (role ? readJson<ResolvedCapabilityPolicy>(effectiveSnapshotPath(fluxDir, agentName)) : null);
	return record?.schemaVersion === 1 && record.agentName === agentName && (!role || record.role === role) ? record : null;
}

export function saveRegisteredCapabilityOverride(input: {
	fluxDir: string;
	agentName: string;
	role: string;
	override: CapabilityPolicyInput;
	expectedRevision?: number;
}): RegisteredCapabilityOverride {
	if (!validOverride(input.override) || !input.role?.trim()) throw new Error("Invalid capability override input");
	const basePath = overridePath(input.fluxDir, input.agentName);
	// 所有角色共用 base fence，选择文件与 revision 检查也在锁内，防止首次并发写覆盖另一角色。
	return withJsonStoreLock(basePath, () => {
		const base = loadRegisteredCapabilityOverride(input.fluxDir, input.agentName);
		const path = base && base.role !== input.role ? roleOverridePath(input.fluxDir, input.agentName, input.role) : basePath;
		const current = readRegistered(path, input.agentName, input.role);
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
		writeJsonFileAtomic(path, record);
		return record;
	});
}

export function writeEffectiveCapabilitySnapshot(fluxDir: string, policy: ResolvedCapabilityPolicy, role?: string): string {
	const path = effectiveSnapshotPath(fluxDir, policy.agentName, role);
	writeJsonFileAtomic(path, policy);
	return path;
}

/** Host-side tool hook gate. This is enforceable for pi tools, but not an OS sandbox. */
export function evaluateCapabilityToolCall(
	policy: EffectiveCapabilityPolicy,
	cwd: string,
	toolName: string,
	input: Record<string, unknown>,
): string | null {
	if (!policy || !Array.isArray(policy.tools) || !policy.workspace
		|| !Array.isArray(policy.workspace.roots) || !Array.isArray(policy.workspace.deniedPaths)) {
		return "Invalid effective capability policy; tool call rejected";
	}
	const unsupportedReason = capabilityToolUnsupportedReason(toolName);
	if (unsupportedReason) return unsupportedReason;
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

/** File-scope gate used by exact Team runs. Reads remain available for context. */
export function evaluateLockFileToolCall(
	cwd: string,
	lockFiles: string[],
	toolName: string,
	input: Record<string, unknown>,
): string | null {
	if (lockFiles.length === 0 || !["edit", "write"].includes(toolName)) return null;
	const target = typeof input.path === "string" ? resolve(cwd, input.path) : "";
	const allowed = lockFiles.map(file => resolve(cwd, file));
	if (target && allowed.some(file => file.toLowerCase() === target.toLowerCase())) return null;
	return `Edit outside AgentFlux lockFiles scope: ${String(input.path ?? "(missing path)")}`;
}
