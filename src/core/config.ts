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
	if (config.budget.max_turns_per_task !== undefined && (!Number.isInteger(config.budget.max_turns_per_task) || config.budget.max_turns_per_task < 1)) warnings.push("budget.max_turns_per_task 必须是正整数，或省略表示无轮次上限");
	if (config.budget.max_input_tokens_per_task !== undefined && (!Number.isInteger(config.budget.max_input_tokens_per_task) || config.budget.max_input_tokens_per_task < 1)) warnings.push("budget.max_input_tokens_per_task 必须是正整数，或省略表示无 input token 上限");
	if (config.budget.max_parallel_agents !== undefined && (!Number.isInteger(config.budget.max_parallel_agents) || config.budget.max_parallel_agents < 1)) warnings.push("budget.max_parallel_agents 必须是正整数，或省略表示不限制并发");
	const deadlineSeconds = config.budget.max_wall_clock_seconds;
	if (deadlineSeconds !== undefined && deadlineSeconds !== null
		&& (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0)) {
		warnings.push("budget.max_wall_clock_seconds 必须为 null/省略或大于 0");
	}
	const health = config.health;
	if (health) {
		if (!Number.isFinite(health.waiting_provider_after_ms) || health.waiting_provider_after_ms < 1) warnings.push("health.waiting_provider_after_ms 必须大于 0");
		if (!Number.isFinite(health.quiet_after_ms) || health.quiet_after_ms < 1) warnings.push("health.quiet_after_ms 必须大于 0");
		if (!Number.isFinite(health.suspected_stall_after_ms) || health.suspected_stall_after_ms < health.quiet_after_ms) warnings.push("health.suspected_stall_after_ms 不能小于 quiet_after_ms");
		if (!Number.isInteger(health.suspected_loop_repeats) || health.suspected_loop_repeats < 2) warnings.push("health.suspected_loop_repeats 必须至少为 2");
		if (!Number.isFinite(health.warning_cooldown_ms) || health.warning_cooldown_ms < 0) warnings.push("health.warning_cooldown_ms 不能为负数");
		if (!Number.isFinite(health.context_pressure_percent) || health.context_pressure_percent <= 0 || health.context_pressure_percent > 1) warnings.push("health.context_pressure_percent 必须在 0 和 1 之间");
	}
	if (config.quality_gate?.timeout_ms !== undefined && config.quality_gate.timeout_ms !== null
		&& (!Number.isFinite(config.quality_gate.timeout_ms) || config.quality_gate.timeout_ms <= 0)) warnings.push("quality_gate.timeout_ms 必须为 null/省略或大于 0");
	if (config.community_stall_threshold !== undefined && (!Number.isInteger(config.community_stall_threshold) || config.community_stall_threshold < 1)) warnings.push("community_stall_threshold 必须是正整数");
	return warnings;
}
