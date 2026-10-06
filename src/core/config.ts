import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type FluxConfig, type SubagentRuntime } from "./types";
import { discoverPiModels, mergeModels, type ModelEntry } from "./model-capability";
import { buildChatCatalog, type HostChatModel } from "./model-catalog";

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

export function resolveSubagentRuntime(value: unknown): SubagentRuntime {
	if (value === undefined) return "process";
	if (value === "process" || value === "sdk") return value;
	throw new Error('subagent_runtime must be "process" or "sdk"');
}

/** 执行方式是安全边界，坏配置不能被容错解析静默变回 process。 */
export function loadSubagentRuntime(cwd: string): SubagentRuntime {
	const path = join(cwd, ".agentflux", "agentflux.json");
	if (!existsSync(path)) return "process";
	let value: unknown;
	try { value = JSON.parse(readFileSync(path, "utf8")); }
	catch { throw new Error(`Cannot read subagent runtime configuration: ${path}`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid subagent runtime configuration: ${path}`);
	return resolveSubagentRuntime((value as Record<string, unknown>).subagent_runtime);
}

export function loadModelsConfig(cwd: string, host?: { models: readonly HostChatModel[]; available?: readonly HostChatModel[]; registeredProviders?: readonly string[] }): Record<string, unknown> & { models: Record<string, ModelEntry> } {
	const path = join(cwd, ".agentflux", "models.json");
	let value: Record<string, unknown> = { models: {} };
	if (existsSync(path)) {
		try { value = JSON.parse(readFileSync(path, "utf-8")); } catch {}
	}
	return {
		...value,
		models: host
			? buildChatCatalog(host.models, (value.models as Record<string, ModelEntry> | undefined) ?? {}, host)
			: mergeModels((value.models as Record<string, ModelEntry> | undefined) ?? {}, discoverPiModels()),
	};
}

export function resolveSharedSkills(_config: FluxConfig, modelsConfig: any): string[] {
	if (!Array.isArray(modelsConfig?.sharedSkills)) return [];
	const skills: string[] = modelsConfig.sharedSkills.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0).map((item: string) => item.trim());
	return [...new Set(skills)];
}

export function validateConfig(config: FluxConfig): string[] {
	const warnings: string[] = [];
	try { resolveSubagentRuntime(config.subagent_runtime); } catch (error) { warnings.push((error as Error).message); }
	if (!Number.isFinite(config.budget.max_cost_per_task) || config.budget.max_cost_per_task <= 0) warnings.push("budget.max_cost_per_task must be greater than 0");
	if (!Number.isInteger(config.budget.max_iterations) || config.budget.max_iterations < 1) warnings.push("budget.max_iterations must be a positive integer");
	if (config.budget.max_turns_per_task !== undefined && (!Number.isInteger(config.budget.max_turns_per_task) || config.budget.max_turns_per_task < 1)) warnings.push("budget.max_turns_per_task must be a positive integer, or omitted for no turn limit");
	if (config.budget.max_input_tokens_per_task !== undefined && (!Number.isInteger(config.budget.max_input_tokens_per_task) || config.budget.max_input_tokens_per_task < 1)) warnings.push("budget.max_input_tokens_per_task must be a positive integer, or omitted for no input token limit");
	if (config.budget.max_parallel_agents !== undefined && (!Number.isInteger(config.budget.max_parallel_agents) || config.budget.max_parallel_agents < 1)) warnings.push("budget.max_parallel_agents must be a positive integer, or omitted for no concurrency limit");
	const deadlineSeconds = config.budget.max_wall_clock_seconds;
	if (deadlineSeconds !== undefined && deadlineSeconds !== null
		&& (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0)) {
		warnings.push("budget.max_wall_clock_seconds must be null, omitted, or greater than 0");
	}
	const health = config.health;
	if (health) {
		if (!Number.isFinite(health.waiting_provider_after_ms) || health.waiting_provider_after_ms < 1) warnings.push("health.waiting_provider_after_ms must be greater than 0");
		if (!Number.isFinite(health.quiet_after_ms) || health.quiet_after_ms < 1) warnings.push("health.quiet_after_ms must be greater than 0");
		if (!Number.isFinite(health.suspected_stall_after_ms) || health.suspected_stall_after_ms < health.quiet_after_ms) warnings.push("health.suspected_stall_after_ms must not be less than quiet_after_ms");
		if (!Number.isInteger(health.suspected_loop_repeats) || health.suspected_loop_repeats < 2) warnings.push("health.suspected_loop_repeats must be at least 2");
		if (!Number.isFinite(health.warning_cooldown_ms) || health.warning_cooldown_ms < 0) warnings.push("health.warning_cooldown_ms must not be negative");
		if (!Number.isFinite(health.context_pressure_percent) || health.context_pressure_percent <= 0 || health.context_pressure_percent > 1) warnings.push("health.context_pressure_percent must be greater than 0 and at most 1");
	}
	if (config.quality_gate?.timeout_ms !== undefined && config.quality_gate.timeout_ms !== null
		&& (!Number.isFinite(config.quality_gate.timeout_ms) || config.quality_gate.timeout_ms <= 0)) warnings.push("quality_gate.timeout_ms must be null, omitted, or greater than 0");
	if (config.community_stall_threshold !== undefined && (!Number.isInteger(config.community_stall_threshold) || config.community_stall_threshold < 1)) warnings.push("community_stall_threshold must be a positive integer");
	return warnings;
}
