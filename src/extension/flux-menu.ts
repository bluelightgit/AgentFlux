/**
 * AgentFlux Extension — Main /flux menu (TUI)
 *
 * Full-width settings-style menu (not overlay) with submenus:
 *   - Mode: SelectList submenu (eco/fast/balanced/accurate/custom)
 *   - Preference: Custom progress-bar tuner with ←→ adjustment
 *   - Project: Info display
 *   - Complexity: Info display
 *   - Compact: Info display
 *   - Team: Submenu (plan/build/review/status)
 *
 * All text in English per user request.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container, Spacer, Text, type SelectItem, SelectList, type SettingItem, SettingsList,
	type Component, truncateToWidth,
} from "@earendil-works/pi-tui";
import { join } from "node:path";
import { loadPreference, savePreference } from "../core/config";
import type { Preset, PreferenceConfig, PreferenceVector } from "../core/types";
import { formatComplexitySignal, type TaskComplexitySignal } from "../core/complexity";
import { formatCompactionAdvice, type CompactionAdvice } from "./compaction-advisor";

// ── State passed from entry.ts ──

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
		// Non-TUI fallback: print summary
		const lines = [
			"AgentFlux Menu (TUI required for interactive mode)",
			`  mode         ${state.preset} → ${state.mode}`,
			`  stage        ${state.stage} / ${state.role}`,
			`  reason       ${state.reason.join("; ")}`,
			"",
			"Commands: /flux mode <preset> | /flux preference | /flux why | /flux team ...",
		];
		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info"); else console.log(lines.join("\n"));
		return;
	}

	const pref = loadPreference(ctx.cwd);

	const items: SettingItem[] = [
		{
			id: "mode",
			label: "Mode",
			description: "Select working mode preset. eco=M1 single-agent, fast=M3 fork, balanced=M2 subagent, accurate=M6 heterogeneous team, custom=manual",
			currentValue: state.preset,
			submenu: (_current, done) => new ModeSubmenu(state.preset, (preset) => {
				callbacks.onModeChange(preset);
				done(preset);
			}, () => done()),
		},
		{
			id: "preference",
			label: "Preference",
			description: "5-dimension routing preference tuner: cost sensitivity, accuracy priority, latency priority, parallelism willingness, multi-agent willingness",
			currentValue: pref.profile,
			submenu: (_current, done) => new PreferenceSubmenu(ctx.cwd, pref, (newPref) => {
				callbacks.onPreferenceChange(newPref);
				callbacks.onReroute();
			}, () => done()),
		},
		{
			id: "project",
			label: "Project",
			description: "Project maturity stage and role evolution",
			currentValue: `${state.stage} / ${state.role}`,
		},
		{
			id: "complexity",
			label: "Complexity",
			description: state.complexitySignal
				? `tier ${state.complexitySignal.complexityTier} → ${state.complexitySignal.recommendedMode} · ${state.complexitySignal.fileCount} files, ${state.complexitySignal.loc} LOC, depth ${state.complexitySignal.dependencyDepth}`
				: "Not collected",
			currentValue: state.complexitySignal
				? `tier${state.complexitySignal.complexityTier} → ${state.complexitySignal.recommendedMode}`
				: "N/A",
		},
		{
			id: "compact",
			label: "Compaction",
			description: state.compactionAdvice?.reason ?? "Not available",
			currentValue: state.compactionAdvice?.action ?? "N/A",
		},
		{
			id: "route-info",
			label: "Route",
			description: `Mode ${state.mode} (fallback ${state.fallback}) · expected ${state.expectedMode}`,
			currentValue: `${state.mode}`,
		},
		{
			id: "reason",
			label: "Reason",
			description: state.reason.join("; "),
			currentValue: state.reason.length > 0 ? `${state.reason.length} factors` : "none",
		},
		{
			id: "team",
			label: "Team",
			description: "Multi-agent team operations: plan, build, review, pipeline, status",
			currentValue: "open",
			submenu: (_current, done) => new TeamSubmenu((sub, task) => {
				callbacks.onTeamCommand(sub, task);
				done();
			}, () => done()),
		},
	];

	await ctx.ui.custom((_tui: any, theme: any, _kb: any, done: () => void) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("AgentFlux Control Panel")), 0, 0));
		container.addChild(new Text(theme.fg("dim", `stage: ${state.stage} · role: ${state.role} · mode: ${state.mode}`), 0, 1));
		container.addChild(new Spacer(1));

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(_id: string, _newValue: string) => {},
			() => done(),
		);
		container.addChild(settingsList);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) { settingsList.handleInput?.(data); },
		};
	});
}

// ── Mode Submenu (SelectList) ──

class ModeSubmenu extends Container {
	constructor(currentPreset: Preset, onSelect: (preset: Preset) => void, onCancel: () => void) {
		super();

		const presets: { value: Preset; label: string; description: string }[] = [
			{ value: "eco",      label: "eco",      description: "M1 single-agent · lowest cost" },
			{ value: "fast",     label: "fast",     description: "M3 fork exploration · wall-clock priority" },
			{ value: "balanced", label: "balanced", description: "M2 main + subagent · balanced" },
			{ value: "accurate", label: "accurate", description: "M6 heterogeneous team · quality first" },
			{ value: "custom",   label: "custom",   description: "Manual · Level 2/3 takes over" },
		];

		const items: SelectItem[] = presets.map(p => ({
			value: p.value,
			label: p.value === currentPreset ? `${p.label} (active)` : p.label,
			description: p.description,
		}));

		this.addChild(new Text("", 0, 0));
		this.addChild(new Text("Select Mode Preset", 0, 0));
		this.addChild(new Spacer(1));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t: string) => t,
			selectedText: (t: string) => t,
			description: (t: string) => t,
			scrollInfo: (t: string) => t,
			noMatch: (t: string) => t,
		});

		// Pre-select current
		const idx = presets.findIndex(p => p.value === currentPreset);
		if (idx >= 0) selectList.setSelectedIndex(idx);

		selectList.onSelect = (item: any) => onSelect(item.value as Preset);
		selectList.onCancel = onCancel;
		this.addChild(selectList);

		this.addChild(new Spacer(1));
		this.addChild(new Text("Up/Down navigate · Enter select · Esc cancel", 0, 0));
	}
}

// ── Preference Submenu (progress bar + ←→ adjustment) ──

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

class PreferenceSubmenu implements Component {
	private cwd: string;
	private pref: PreferenceConfig;
	private onChange: (pref: PreferenceConfig) => void;
	private onCancel: () => void;
	private selectedIdx = 0;
	private theme: any;

	constructor(cwd: string, pref: PreferenceConfig, onChange: (pref: PreferenceConfig) => void, onCancel: () => void) {
		this.cwd = cwd;
		this.pref = { ...pref, vector: { ...pref.vector } };
		this.onChange = onChange;
		this.onCancel = onCancel;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		lines.push("");
		lines.push(this.theme ? this.theme.fg("accent", this.theme.bold("Preference Tuner")) : "Preference Tuner");
		lines.push(this.theme ? this.theme.fg("dim", `profile: ${this.pref.profile} · ←→ adjust · ↑↓ navigate · Esc save & close`) : `profile: ${this.pref.profile}`);
		lines.push("");

		for (let i = 0; i < PREF_DIMENSIONS.length; i++) {
			const dim = PREF_DIMENSIONS[i];
			const val = this.pref.vector[dim.key];
			const selected = i === this.selectedIdx;
			const barWidth = 20;
			const filled = Math.round(val * barWidth);
			const empty = barWidth - filled;
			const bar = "█".repeat(filled) + "░".repeat(empty);
			const valStr = val.toFixed(1);

			const prefix = selected ? "▶ " : "  ";
			const labelPad = dim.label.padEnd(24);
			const line = `${prefix}${labelPad} [${bar}] ${valStr}`;

			if (this.theme) {
				const styled = selected
					? this.theme.fg("accent", line)
					: line;
				lines.push(truncateToWidth(styled, width));
			} else {
				lines.push(truncateToWidth(line, width));
			}

			if (selected) {
				lines.push(this.theme ? this.theme.fg("dim", `    ${dim.description}`) : `    ${dim.description}`);
			}
		}

		lines.push("");
		lines.push(this.theme ? this.theme.fg("dim", "  ←→ adjust · ↑↓ navigate · Esc save & close") : "  ←→ adjust · ↑↓ navigate · Esc save & close");

		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		// Up/Down: navigate dimensions
		if (data === "\x1b[A" || data === "k") { // Up
			this.selectedIdx = (this.selectedIdx - 1 + PREF_DIMENSIONS.length) % PREF_DIMENSIONS.length;
			return;
		}
		if (data === "\x1b[B" || data === "j") { // Down
			this.selectedIdx = (this.selectedIdx + 1) % PREF_DIMENSIONS.length;
			return;
		}
		// Left/Right: adjust value
		if (data === "\x1b[D" || data === "h") { // Left
			const dim = PREF_DIMENSIONS[this.selectedIdx];
			const cur = this.pref.vector[dim.key];
			const newVal = Math.max(0, Math.round((cur - 0.1) * 10) / 10);
			this.pref.vector[dim.key] = newVal;
			this.save();
			return;
		}
		if (data === "\x1b[C" || data === "l") { // Right
			const dim = PREF_DIMENSIONS[this.selectedIdx];
			const cur = this.pref.vector[dim.key];
			const newVal = Math.min(1, Math.round((cur + 0.1) * 10) / 10);
			this.pref.vector[dim.key] = newVal;
			this.save();
			return;
		}
		// Esc: save & close
		if (data === "\x1b" || data === "\x1b\x1b") {
			this.save();
			this.onChange(this.pref);
			this.onCancel();
			return;
		}
	}

	private save(): void {
		savePreference(this.cwd, this.pref);
		this.onChange(this.pref);
	}
}

// ── Team Submenu ──

class TeamSubmenu implements Component {
	private onSelect: (sub: string, task: string) => void;
	private onCancel: () => void;
	private selectedIdx = 0;
	private theme: any;

	private options = [
		{ value: "status",    label: "Team Status",       description: "Show all agent instances + blackboard" },
		{ value: "plan",      label: "Plan",              description: "Launch planner agent for task analysis" },
		{ value: "build",     label: "Build",             description: "Launch implementer agent (auto-chains planner handoff)" },
		{ value: "review",    label: "Review",            description: "Launch reviewer agent (auto-chains implementer handoff + git diff)" },
		{ value: "pipeline",  label: "Pipeline",          description: "Run plan→build→review in sequence" },
		{ value: "roles",     label: "Roles",             description: "List all role definitions" },
		{ value: "models",    label: "Models",            description: "List all models + capability vectors" },
		{ value: "affinity",  label: "Affinity",          description: "Show per-role model affinity ranking" },
	];

	constructor(onSelect: (sub: string, task: string) => void, onCancel: () => void) {
		this.onSelect = onSelect;
		this.onCancel = onCancel;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push("");
		lines.push(this.theme ? this.theme.fg("accent", this.theme.bold("Team Operations")) : "Team Operations");
		lines.push("");

		for (let i = 0; i < this.options.length; i++) {
			const opt = this.options[i];
			const selected = i === this.selectedIdx;
			const prefix = selected ? "▶ " : "  ";
			const line = `${prefix}${opt.label.padEnd(16)} ${opt.description}`;
			lines.push(this.theme
				? (selected ? this.theme.fg("accent", truncateToWidth(line, width)) : truncateToWidth(line, width))
				: truncateToWidth(line, width));
		}

		lines.push("");
		lines.push(this.theme ? this.theme.fg("dim", "  Up/Down navigate · Enter select · Esc back") : "  Up/Down navigate · Enter select · Esc back");
		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "\x1b[A" || data === "k") {
			this.selectedIdx = (this.selectedIdx - 1 + this.options.length) % this.options.length;
			return;
		}
		if (data === "\x1b[B" || data === "j") {
			this.selectedIdx = (this.selectedIdx + 1) % this.options.length;
			return;
		}
		if (data === "\r" || data === " ") {
			this.onSelect(this.options[this.selectedIdx].value, "");
			return;
		}
		if (data === "\x1b" || data === "\x1b\x1b") {
			this.onCancel();
			return;
		}
	}
}
