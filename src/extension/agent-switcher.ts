/**
 * Agent Switcher — `/flux-agents` and `/flux-back` TUI commands.
 *
 * Lets the user directly enter any registered agent's session, communicate
 * with it, and return to the main agent — all without losing state.
 * Also supports agent deletion (main agent is protected).
 *
 * Architecture:
 * - /flux-agents: SelectList TUI with 'd' to delete (y/n confirm)
 * - ctx.switchSession(): switches pi to the agent's session file
 * - before_agent_start (entry.ts): injects agent role system prompt
 * - /flux-back: restores the main agent session
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { SharedBoard, type AgentInfo } from "../core/shared-board";
import { loadSubagent } from "./subagent";

// ─── State files ───────────────────────────────────────────────────────────

const ACTIVE_AGENT_FILE = "active-agent.json";
const MAIN_BACKUP_FILE = "main-session-backup.json";

function runtimeDir(cwd: string): string {
	return join(cwd, ".agentflux", "runtime");
}

/** Read the currently active agent name (null = main agent). */
export function getActiveAgent(cwd: string): string | null {
	const p = join(runtimeDir(cwd), ACTIVE_AGENT_FILE);
	if (!existsSync(p)) return null;
	try {
		const d = JSON.parse(readFileSync(p, "utf-8"));
		return d.agentName ?? null;
	} catch { return null; }
}

/** Set the active agent (null = main agent). */
export function setActiveAgent(cwd: string, name: string | null): void {
	const p = join(runtimeDir(cwd), ACTIVE_AGENT_FILE);
	writeFileSync(p, JSON.stringify({ agentName: name, setAt: new Date().toISOString() }));
}

/** Save the main session file path for /flux-back. */
export function saveMainSession(cwd: string, sessionFile: string): void {
	const p = join(runtimeDir(cwd), MAIN_BACKUP_FILE);
	writeFileSync(p, JSON.stringify({ sessionFile, savedAt: new Date().toISOString() }));
}

/** Read the saved main session file path. */
export function readMainSession(cwd: string): string | null {
	const p = join(runtimeDir(cwd), MAIN_BACKUP_FILE);
	if (!existsSync(p)) return null;
	try {
		const d = JSON.parse(readFileSync(p, "utf-8"));
		return d.sessionFile ?? null;
	} catch { return null; }
}

// ─── Agent session file discovery ──────────────────────────────────────────

/** Find the most recent session file for an agent. */
export function findAgentSessionFile(cwd: string, agentName: string): string | null {
	// 1. Check registry sessionFile field
	const board = new SharedBoard(join(cwd, ".agentflux"));
	const agent = board.getAgent(agentName);
	if (agent?.sessionFile && existsSync(agent.sessionFile)) return agent.sessionFile;

	// 2. Scan sessions directory for *flux-{agentName}.jsonl
	const sessionsDir = join(cwd, ".agentflux", "runtime", "sessions");
	if (!existsSync(sessionsDir)) return null;
	const files = readdirSync(sessionsDir)
		.filter(f => f.includes(`flux-${agentName}`) && f.endsWith(".jsonl"));
	if (files.length === 0) return null;
	files.sort().reverse(); // most recent first (timestamp prefix)
	return join(sessionsDir, files[0]);
}

// ─── Agent deletion ────────────────────────────────────────────────────────

/** Delete an agent from the registry and remove its session file. */
function deleteAgent(cwd: string, agentName: string): void {
	const agentsDir = join(cwd, ".agentflux", "shared", "agents");
	const registryPath = join(agentsDir, "_registry.json");
	if (existsSync(registryPath)) {
		const registry: AgentInfo[] = JSON.parse(readFileSync(registryPath, "utf-8"));
		const filtered = registry.filter(a => a.name !== agentName);
		writeFileSync(registryPath, JSON.stringify(filtered, null, 2));
	}
	// Delete session file
	const sessionFile = findAgentSessionFile(cwd, agentName);
	if (sessionFile && existsSync(sessionFile)) {
		try { unlinkSync(sessionFile); } catch {}
	}
}

// ─── Status icons ──────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
	idle: "○", running: "●", blocked: "⚠", done: "✓", failed: "✗",
};

// ─── /flux-agents command ──────────────────────────────────────────────────

export async function handleFluxAgentsCommand(_args: unknown, ctx: any): Promise<void> {
	if (!ctx.hasUI) {
		const board = new SharedBoard(join(ctx.cwd, ".agentflux"));
		const agents = board.listAgents();
		console.log(formatAgentList(agents));
		return;
	}

	await showAgentList(ctx);
}

/** Show the agent list TUI and handle selection/deletion. */
async function showAgentList(ctx: any): Promise<void> {
	const cwd: string = ctx.cwd;
	const board = new SharedBoard(join(cwd, ".agentflux"));
	const agents = board.listAgents();

	const items: SelectItem[] = [
		{ value: "main", label: "Main Agent", description: "current session (protected)" },
		...agents.map(a => ({
			value: a.name,
			label: `${a.name} (${a.role}) ${STATUS_ICON[a.status] ?? "○"}`,
			description: `${a.model ?? "?"}${a.thinking ? ` /${a.thinking}` : ""} · ${(a.currentTask ?? "idle").slice(0, 60)}`,
		})),
	];

	if (items.length === 1) {
		ctx.ui.notify("No registered agents. Dispatch agents first via /flux work or flux_subagent.", "info");
		return;
	}

	const result = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select Agent")), 1, 0));
		container.addChild(new Text(theme.fg("muted", "Enter session directly — talk to the agent"), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		selectList.onSelect = (item: SelectItem) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · d delete · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const key = data.toString();
				// Intercept 'd' for delete (before SelectList sees it)
				if (key === "d" || key === "D") {
					const selected = selectList.getSelectedItem();
					if (selected && selected.value !== "main") {
						done(`delete:${selected.value}:${selected.label}`);
					}
					// 'd' on Main Agent = no-op (protected)
				} else {
					selectList.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});

	// Handle result
	if (result === null) return; // cancelled

	// Delete flow
	if (result.startsWith("delete:")) {
		const parts = result.split(":");
		const agentName = parts[1];
		const agentLabel = parts.slice(2).join(":");
		const confirmed = await ctx.ui.confirm(
			"Delete Agent",
			`Delete "${agentLabel}"?\nThis removes its session file and registry entry. This cannot be undone.`,
		);
		if (confirmed) {
			deleteAgent(cwd, agentName);
			ctx.ui.notify(`Agent "${agentName}" deleted.`, "info");
		}
		// Re-show list (recursive)
		await showAgentList(ctx);
		return;
	}

	// Main agent — switch back
	if (result === "main") {
		const mainSession = readMainSession(cwd);
		if (mainSession && existsSync(mainSession)) {
			setActiveAgent(cwd, null);
			await ctx.switchSession(mainSession, {
				withSession: async (newCtx: any) => {
					newCtx.ui.notify("Returned to main agent", "info");
				},
			});
		} else {
			ctx.ui.notify("Already in main agent session", "info");
		}
		return;
	}

	// Agent — switch to its session
	const agentName = result;
	const sessionFile = findAgentSessionFile(cwd, agentName);
	if (!sessionFile) {
		ctx.ui.notify(`No session file found for agent "${agentName}". The agent may have used an ephemeral session.`, "error");
		return;
	}

	// Save current session as main session (if not already saved)
	const currentSession = ctx.sessionManager?.getSessionFile?.();
	if (currentSession && !readMainSession(cwd)) {
		saveMainSession(cwd, currentSession);
	} else if (currentSession) {
		// Update backup if we're currently in main session
		const activeAgent = getActiveAgent(cwd);
		if (!activeAgent) {
			saveMainSession(cwd, currentSession);
		}
	}

	setActiveAgent(cwd, agentName);
	await ctx.switchSession(sessionFile, {
		withSession: async (newCtx: any) => {
			newCtx.ui.notify(`Switched to agent "${agentName}". Type /flux-back to return to main agent.`, "info");
		},
	});
}

// ─── /flux-back command ────────────────────────────────────────────────────

export async function handleFluxBackCommand(_args: unknown, ctx: any): Promise<void> {
	const cwd: string = ctx.cwd;
	const mainSession = readMainSession(cwd);

	if (!mainSession || !existsSync(mainSession)) {
		if (ctx.hasUI) ctx.ui.notify("No main session to return to. You may already be in the main agent.", "info");
		else console.log("[flux-back] No main session to return to.");
		return;
	}

	const activeAgent = getActiveAgent(cwd);
	if (!activeAgent) {
		if (ctx.hasUI) ctx.ui.notify("Already in main agent session.", "info");
		else console.log("[flux-back] Already in main agent session.");
		return;
	}

	setActiveAgent(cwd, null);
	await ctx.switchSession(mainSession, {
		withSession: async (newCtx: any) => {
			if (newCtx.hasUI) newCtx.ui.notify("Returned to main agent", "info");
		},
	});
}

// ─── before_agent_start: inject agent system prompt ─────────────────────────

/**
 * Called from entry.ts before_agent_start handler.
 * If an agent is active, loads its role definition and appends to system prompt.
 */
export function getAgentSystemPromptOverride(cwd: string): string | null {
	const agentName = getActiveAgent(cwd);
	if (!agentName) return null;

	// Load agent role definition from .agentflux/agents/{name}.md
	const agentDef = loadSubagent(cwd, agentName);
	if (agentDef?.systemPrompt?.trim()) {
		return agentDef.systemPrompt.trim();
	}

	// Fallback: construct from registry info
	const board = new SharedBoard(join(cwd, ".agentflux"));
	const agent = board.getAgent(agentName);
	if (agent) {
		return `You are "${agent.name}", a ${agent.role} agent. Continue your role as defined in your previous conversation history. Respond according to your role: ${agent.role}.`;
	}

	return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatAgentList(agents: AgentInfo[]): string {
	if (agents.length === 0) return "No registered agents.";
	const lines = agents.map(a => {
		const icon = STATUS_ICON[a.status] ?? "○";
		const task = a.currentTask ? ` · ${(a.currentTask.slice(0, 50))}` : "";
		return `  ${icon} ${a.name} (${a.role}) [${a.status}]${task}`;
	});
	return ["Agents:", ...lines].join("\n");
}
