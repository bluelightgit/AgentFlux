import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type FluxConfig } from "./types";
import { discoverPiModels, mergeModels, type ModelEntry } from "./model-capability";

function merge<T>(base: T, value: Partial<T> | undefined): T {
	if (!value) return base;
	const out: any = { ...(base as any) };
	for (const [key, next] of Object.entries(value)) {
		const current = (base as any)[key];
		out[key] = next && current && typeof next === "object" && typeof current === "object" && !Array.isArray(next)
			? merge(current, next as any)
			: next;
	}
	return out;
}

export function loadRawConfig(cwd: string): Record<string, unknown> {
	const path = join(cwd, ".agentflux", "agentflux.json");
	if (!existsSync(path)) return {};
	try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
}

export function loadConfig(cwd: string): FluxConfig {
	return merge(DEFAULT_CONFIG, loadRawConfig(cwd) as Partial<FluxConfig>);
}

export function loadModelsConfig(cwd: string): Record<string, unknown> & { models: Record<string, ModelEntry> } {
	const path = join(cwd, ".agentflux", "models.json");
	let value: Record<string, unknown> = { models: {} };
	if (existsSync(path)) {
		try { value = JSON.parse(readFileSync(path, "utf-8")); } catch {}
	}
	return {
		...value,
		models: mergeModels((value.models as Record<string, ModelEntry> | undefined) ?? {}, discoverPiModels()),
	};
}

export function resolveSharedSkills(_config: FluxConfig, modelsConfig: any): string[] {
	if (!Array.isArray(modelsConfig?.sharedSkills)) return [];
	const skills: string[] = modelsConfig.sharedSkills.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0).map((item: string) => item.trim());
	return [...new Set(skills)];
}

export function validateConfig(config: FluxConfig): string[] {
	const warnings: string[] = [];
	if (!Number.isFinite(config.budget.max_cost_per_task) || config.budget.max_cost_per_task <= 0) warnings.push("budget.max_cost_per_task 必须大于 0");
	if (!Number.isInteger(config.budget.max_iterations) || config.budget.max_iterations < 1) warnings.push("budget.max_iterations 必须是正整数");
	if (!Number.isFinite(config.budget.max_wall_clock_seconds) || config.budget.max_wall_clock_seconds < 1) warnings.push("budget.max_wall_clock_seconds 必须大于 0");
	return warnings;
}
