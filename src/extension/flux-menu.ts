/**
 * AgentFlux Extension — Main /flux menu (TUI)
 *
 * Uses ctx.ui.custom() with flat SelectList (same pattern as pi preset.ts).
 * Each action opens its own overlay; info items show results in chat and exit.
 *
 * All text in English.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container, Spacer, Text, type SelectItem, SelectList,
	type Component, truncateToWidth,
} from "@earendil-works/pi-tui";
import { loadPreference, savePreference } from "../core/config";
import type { Preset, PreferenceConfig, PreferenceVector } from "../core/types";
import { formatComplexitySignal, type TaskComplexitySignal } from "../core/complexity";
import { formatCompactionAdvice, type CompactionAdvice } from "./compaction-advisor";

export interface FluxMenuState {
	preset: Preset;
	expectedMode: string;
	mode: string;
	fallback: string;
	stage: string;
	role: string;
	reason: string[];
	complexitySignal: TaskComplexitySignal | null;
	compactionAdvice: CompactionAdvice | null;
}

export interface FluxMenuCallbacks {
	onModeChange: (preset: Preset) => void;
	onPreferenceChange: (pref: PreferenceConfig) => void;
	onTeamCommand: (sub: string, task: string) => void;
	onReroute: () => void;
}

// ── Main menu ──

export async function showFluxMenu(
	ctx: any,
	state: FluxMenuState,
	callbacks: FluxMenuCallbacks,
): Promise<void> {
	if (ctx.mode !== "tui") {
		const lines = [
			"AgentFlux Menu (TUI required for interactive mode)",
			`  mode         ${state.preset} -> ${state.mode}`,
			`  stage        ${state.stage} / ${state.role}`,
			`  reason       ${state.reason.join("; ")}`,
			"",
			"Commands: /flux mode <preset> | /flux preference | /flux why | /flux team ...",
		];
		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info"); else console.log(lines.join("\n"));
		return;
	}

	const pref = loadPreference(ctx.cwd);

	// Main menu items
	type MenuItem = { id: string; label: string; description: string; kind: "action" | "info" };
	const menuItems: MenuItem[] = [
		{ id: "mode",        label: "Mode",        description: "Working mode preset", kind: "action" },
		{ id: "preference",  label: "Preference",  description: "5-dimension routing tuner", kind: "action" },
		{ id: "team",        label: "Team",        description: "Multi-agent team operations", kind: "action" },
		{ id: "project",     label: "Project",     description: "Maturity stage and role", kind: "info" },
		{ id: "complexity",  label: "Complexity",  description: "Code complexity analysis", kind: "info" },
		{ id: "compaction",  label: "Compaction",  description: "Compaction advisor status", kind: "info" },
		{ id: "route",       label: "Route",       description: "Current route and reason", kind: "info" },
	];

	const selectItems: SelectItem[] = menuItems.map(item => ({
		value: item.id,
		label: item.label,
		description: item.description,
	}));

	// Show main menu, get selected item id
	const selected = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("AgentFlux")), 0, 0));
		container.addChild(new Text(theme.fg("dim", `stage: ${state.stage} | role: ${state.role} | mode: ${state.mode}`), 0, 1));
		container.addChild(new Spacer(1));

		const selectList = new SelectList(selectItems, Math.min(selectItems.length, 12), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});

		selectList.onSelect = (item: any) => done(item.value as string);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "Up/Down navigate | Enter select | Esc cancel"), 0, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!selected) return; // Esc pressed

	const menuItem = menuItems.find(i => i.id === selected);
	if (!menuItem) return;

	// Route to submenu or info display
	switch (selected) {
		case "mode":
			await showModeMenu(ctx, state, callbacks);
			break;
		case "preference":
			await showPreferenceMenu(ctx, pref, callbacks);
			break;
		case "team":
			await showTeamMenu(ctx, callbacks);
			break;
		// Info items: show result in chat and exit
		case "project":
			ctx.ui.notify(formatProjectInfo(state), "info");
			break;
		case "complexity":
			ctx.ui.notify(
				state.complexitySignal
					? formatComplexitySignal(state.complexitySignal)
					: "Complexity signal not collected yet.",
				"info",
			);
			break;
		case "compaction":
			ctx.ui.notify(
				state.compactionAdvice
					? formatCompactionAdvice(state.compactionAdvice)
					: "Compaction advisor not available.",
				"info",
			);
			break;
		case "route":
			ctx.ui.notify(formatRouteInfo(state), "info");
			break;
	}
}

function formatProjectInfo(state: FluxMenuState): string {
	return [
		"AgentFlux Project Status",
		`  stage:   ${state.stage}`,
		`  role:    ${state.role}`,
		`  mode:    ${state.mode}`,
		`  preset:  ${state.preset} -> ${state.expectedMode}`,
	].join("\n");
}

function formatRouteInfo(state: FluxMenuState): string {
	return [
		"AgentFlux Route Info",
		`  mode:      ${state.mode} (fallback ${state.fallback})`,
		`  expected:  ${state.expectedMode}`,
		`  reason:    ${state.reason.join("; ")}`,
	].join("\n");
}

// ── Mode submenu ──

async function showModeMenu(
	ctx: any,
	state: FluxMenuState,
	callbacks: FluxMenuCallbacks,
): Promise<void> {
	const presets: { value: Preset; label: string; description: string }[] = [
		{ value: "eco",      label: "eco",      description: "M1 single-agent | lowest cost" },
		{ value: "fast",     label: "fast",     description: "M3 fork exploration | wall-clock priority" },
		{ value: "balanced", label: "balanced", description: "M2 main + subagent | balanced" },
		{ value: "accurate", label: "accurate", description: "M6 heterogeneous team | quality first" },
		{ value: "custom",   label: "custom",   description: "Manual | Level 2/3 takes over" },
	];

	const items: SelectItem[] = presets.map(p => ({
		value: p.value,
		label: p.value === state.preset ? `${p.label} (active)` : p.label,
		description: p.description,
	}));

	const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select Mode Preset")), 0, 0));
		container.addChild(new Spacer(1));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});

		const idx = presets.findIndex(p => p.value === state.preset);
		if (idx >= 0) selectList.setSelectedIndex(idx);

		selectList.onSelect = (item: any) => done(item.value as string);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "Up/Down navigate | Enter select | Esc back"), 0, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!result) return;

	callbacks.onModeChange(result as Preset);
	ctx.ui.notify(`Mode preset changed to: ${result}`, "info");
}

// ── Preference submenu (progress bar + <-/-> adjustment) ──

interface PrefDimension {
	key: keyof PreferenceVector;
	label: string;
	description: string;
}

const PREF_DIMENSIONS: PrefDimension[] = [
	{ key: "cost_sensitivity",        label: "Cost Sensitivity",        description: "1.0 = minimize cost above all" },
	{ key: "accuracy_priority",       label: "Accuracy Priority",       description: "1.0 = quality first, use best model" },
	{ key: "latency_priority",        label: "Latency Priority",        description: "1.0 = wall-clock time matters most" },
	{ key: "parallelism_willingness", label: "Parallelism Willingness", description: "1.0 = eager to run parallel branches" },
	{ key: "multi_agent_willingness", label: "Multi-Agent Willingness", description: "1.0 = prefer multi-agent teams" },
];

async function showPreferenceMenu(
	ctx: any,
	pref: PreferenceConfig,
	callbacks: FluxMenuCallbacks,
): Promise<void> {
	const workingPref: PreferenceConfig = { ...pref, vector: { ...pref.vector } };
	let selectedIdx = 0;

	await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => {
		return {
			render(width: number): string[] {
				const lines: string[] = [];
				lines.push("");
				lines.push(theme.fg("accent", theme.bold("Preference Tuner")));
				lines.push(theme.fg("dim", `profile: ${workingPref.profile} | <-/-> adjust | Up/Down navigate | Esc save & close`));
				lines.push("");

				for (let i = 0; i < PREF_DIMENSIONS.length; i++) {
					const dim = PREF_DIMENSIONS[i];
					const val = workingPref.vector[dim.key];
					const selected = i === selectedIdx;
					const barWidth = 20;
					const filled = Math.round(val * barWidth);
					const empty = barWidth - filled;
					const bar = "█".repeat(filled) + "░".repeat(empty);
					const valStr = val.toFixed(1);

					const prefix = selected ? "▶ " : "  ";
					const labelPad = dim.label.padEnd(24);
					const line = `${prefix}${labelPad} [${bar}] ${valStr}`;

					lines.push(truncateToWidth(selected ? theme.fg("accent", line) : line, width));

					if (selected) {
						lines.push(theme.fg("dim", `    ${dim.description}`));
					}
				}

				lines.push("");
				lines.push(theme.fg("dim", "  <-/-> adjust | Up/Down navigate | Esc save & close"));
				return lines;
			},
			invalidate() {},
			handleInput(data: string): void {
				if (data === "\x1b[A" || data === "k") {
					selectedIdx = (selectedIdx - 1 + PREF_DIMENSIONS.length) % PREF_DIMENSIONS.length;
					tui.requestRender();
					return;
				}
				if (data === "\x1b[B" || data === "j") {
					selectedIdx = (selectedIdx + 1) % PREF_DIMENSIONS.length;
					tui.requestRender();
					return;
				}
				if (data === "\x1b[D" || data === "h") {
					const dim = PREF_DIMENSIONS[selectedIdx];
					workingPref.vector[dim.key] = Math.max(0, Math.round((workingPref.vector[dim.key] - 0.1) * 10) / 10);
					savePreference(ctx.cwd, workingPref);
					tui.requestRender();
					return;
				}
				if (data === "\x1b[C" || data === "l") {
					const dim = PREF_DIMENSIONS[selectedIdx];
					workingPref.vector[dim.key] = Math.min(1, Math.round((workingPref.vector[dim.key] + 0.1) * 10) / 10);
					savePreference(ctx.cwd, workingPref);
					tui.requestRender();
					return;
				}
				if (data === "\x1b" || data === "\x1b\x1b") {
					callbacks.onPreferenceChange(workingPref);
					callbacks.onReroute();
					done();
					return;
				}
			},
		};
	});

	ctx.ui.notify("Preference saved and route updated.", "info");
}

// ── Team submenu ──

async function showTeamMenu(
	ctx: any,
	callbacks: FluxMenuCallbacks,
): Promise<void> {
	const options = [
		{ value: "status",   label: "Status",    description: "Show all agent instances + blackboard" },
		{ value: "plan",     label: "Plan",       description: "Launch planner agent for task analysis" },
		{ value: "build",    label: "Build",      description: "Launch implementer (auto-chains planner handoff)" },
		{ value: "review",   label: "Review",     description: "Launch reviewer (auto-chains implementer handoff)" },
		{ value: "pipeline", label: "Pipeline",   description: "Run plan->build->review in sequence" },
		{ value: "roles",    label: "Roles",      description: "List all role definitions" },
		{ value: "models",   label: "Models",     description: "List all models + capability vectors" },
		{ value: "affinity", label: "Affinity",   description: "Show per-role model affinity ranking" },
	];

	const items: SelectItem[] = options.map(o => ({
		value: o.value,
		label: o.label,
		description: o.description,
	}));

	const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Team Operations")), 0, 0));
		container.addChild(new Spacer(1));

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});

		selectList.onSelect = (item: any) => done(item.value as string);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "Up/Down navigate | Enter select | Esc back"), 0, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!result) return;

	// Info-type team commands show result and exit; action commands execute
	const infoCmds = ["status", "roles", "models", "affinity"];
	callbacks.onTeamCommand(result, "");

	if (infoCmds.includes(result)) {
		// Results will be shown by the team command handler via ctx.ui.notify
	}
}
