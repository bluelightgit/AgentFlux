/**
 * AgentFlux Core — 配置加载与优先级链
 * 文档依据: docs/04-config-schema, 13-routing-preference
 *
 * 优先级: 运行时覆盖 > 场景偏好覆盖 > 全局偏好 > Level 3 参数 > Level 2 开关 > Level 1 档位 > 默认
 *
 * 配置文件: <cwd>/.agentflux/agentflux.json (零依赖, 不引入 yaml)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_CONFIG, DEFAULT_PREFERENCE, PRESET_TO_MODE, PRESET_VECTORS,
	type FluxConfig, type PreferenceConfig, type Preset, type Mode, type Scenario,
} from "./types";

const CONFIG_FILENAME = "agentflux.json";

function deepMerge<T>(base: T, override: Partial<T> | undefined | null): T {
	if (!override) return base;
	const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
	for (const k of Object.keys(override)) {
		const bv = (base as any)[k];
		const ov = (override as any)[k];
		if (ov && typeof ov === "object" && !Array.isArray(ov) && bv && typeof bv === "object") {
			out[k] = deepMerge(bv, ov);
		} else if (ov !== undefined) {
			out[k] = ov;
		}
	}
	return out as T;
}

function readJsonSafe(path: string): any | null {
	if (!existsSync(path)) return null;
	try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

/** 读原始配置文件 (含 mode/preference/cache 等) */
export function loadRawConfig(cwd: string): any {
	return readJsonSafe(join(cwd, ".agentflux", CONFIG_FILENAME)) ?? {};
}

/** 加载完整 FluxConfig (Level 1/2/3), 合并默认 */
export function loadConfig(cwd: string): FluxConfig {
	const raw = loadRawConfig(cwd);
	return deepMerge(DEFAULT_CONFIG, raw as Partial<FluxConfig>);
}

/** 加载偏好配置 (docs/13) */
export function loadPreference(cwd: string): PreferenceConfig {
	const raw = loadRawConfig(cwd);
	const pref = raw.preference ?? {};
	const profile = (pref.profile ?? raw.mode ?? DEFAULT_PREFERENCE.profile) as Preset;
	const presetVector = profile === "custom" ? DEFAULT_PREFERENCE.vector : PRESET_VECTORS[profile] ?? DEFAULT_PREFERENCE.vector;
	return deepMerge({ ...DEFAULT_PREFERENCE, profile, vector: { ...presetVector } }, pref as Partial<PreferenceConfig>);
}

/**
 * 解析项目共享 Skill。
 *
 * docs/18、docs/19 将 sharedSkills 定义在 models.json，因此 modelsConfig 是主来源；
 * 早期版本曾把它放进 agentflux.json，保留 config.sharedSkills 作为兼容回退。
 * 两处同时存在时不做并集，避免旧配置意外扩大子 agent 权限。
 */
export function resolveSharedSkills(config: FluxConfig, modelsConfig: any): string[] {
	const hasModelsValue = !!modelsConfig
		&& typeof modelsConfig === "object"
		&& Object.prototype.hasOwnProperty.call(modelsConfig, "sharedSkills");
	const raw = hasModelsValue ? modelsConfig.sharedSkills : config.sharedSkills;
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw
		.filter((value): value is string => typeof value === "string")
		.map(value => value.trim())
		.filter(value => value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value))
	)];
}

/** 保存偏好配置回 .agentflux/agentflux.json (合并写入) */
export function savePreference(cwd: string, pref: PreferenceConfig): void {
	const dir = join(cwd, ".agentflux");
	const path = join(dir, CONFIG_FILENAME);
	let raw: any = {};
	try { raw = JSON.parse(readFileSync(path, "utf-8")); } catch {}
	raw.preference = pref;
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(raw, null, 2), "utf-8");
}

/** preset → 期望落点模式 (docs/13 预设映射) */
export function presetToExpectedMode(preset: Preset): Mode {
	return PRESET_TO_MODE[preset] ?? "M2";
}

/** 应用场景覆盖 (docs/13): 场景偏好优先于全局 */
export function applyScenarioOverride(
	pref: PreferenceConfig,
	scenario: Scenario | undefined,
): PreferenceConfig {
	if (!scenario || !pref.scenarios[scenario]) return pref;
	const ov = pref.scenarios[scenario]!;
	const profile = ov.profile ?? pref.profile;
	const profileVector = profile === "custom" ? pref.vector : PRESET_VECTORS[profile] ?? pref.vector;
	const merged: PreferenceConfig = {
		...pref,
		profile,
		vector: { ...profileVector, ...ov } as any,
	};
	if (ov.profile) {
		merged.profile = ov.profile;
	}
	// 删除 scenarios 里混入的非 vector 字段
	delete (merged.vector as any).profile;
	return merged;
}

/** 运行时覆盖: 命令行/交互临时改 preset, 优先级最高 */
export function applyRuntimeOverride(
	config: FluxConfig,
	pref: PreferenceConfig,
	runtimePreset: Preset | undefined,
): { config: FluxConfig; pref: PreferenceConfig } {
	if (!runtimePreset || runtimePreset === config.mode) return { config, pref };
	return {
		config: { ...config, mode: runtimePreset },
		pref: {
			...pref,
			profile: runtimePreset,
			vector: runtimePreset === "custom" ? pref.vector : { ...(PRESET_VECTORS[runtimePreset] ?? pref.vector) },
		},
	};
}

/** 校验配置软约束 (docs/04), 返回 warning 列表 */
export function validateConfig(config: FluxConfig): string[] {
	const warnings: string[] = [];
	if (!Number.isInteger(config.communication.poll_interval_ms) || config.communication.poll_interval_ms < 100 || config.communication.poll_interval_ms > 60_000) {
		warnings.push("communication.poll_interval_ms 必须是 100–60000 的整数毫秒");
	}
	if (!Number.isInteger(config.communication.batch_size) || config.communication.batch_size < 1 || config.communication.batch_size > 20) {
		warnings.push("communication.batch_size 必须是 1–20 的整数");
	}
	if (!Number.isInteger(config.communication.heartbeat_interval_ms) || config.communication.heartbeat_interval_ms < 1_000 || config.communication.heartbeat_interval_ms > 60_000) {
		warnings.push("communication.heartbeat_interval_ms 必须是 1000–60000 的整数毫秒");
	}
	if (!Number.isInteger(config.communication.runtime_lease_ms) || config.communication.runtime_lease_ms < 5_000 || config.communication.runtime_lease_ms > 300_000) {
		warnings.push("communication.runtime_lease_ms 必须是 5000–300000 的整数毫秒");
	} else if (config.communication.runtime_lease_ms < config.communication.heartbeat_interval_ms * 2) {
		warnings.push("communication.runtime_lease_ms 应至少为 heartbeat_interval_ms 的 2 倍");
	}
	if (!Number.isInteger(config.communication.redelivery_after_ms) || config.communication.redelivery_after_ms < 5_000 || config.communication.redelivery_after_ms > 3_600_000) {
		warnings.push("communication.redelivery_after_ms 必须是 5000–3600000 的整数毫秒");
	}
	if (config.retention.enabled) {
		for (const [name, value] of Object.entries({
			stale_runtime_ttl_hours: config.retention.stale_runtime_ttl_hours,
			terminal_agent_ttl_hours: config.retention.terminal_agent_ttl_hours,
			read_message_ttl_hours: config.retention.read_message_ttl_hours,
			orphan_session_ttl_hours: config.retention.orphan_session_ttl_hours,
		})) {
			if (!Number.isFinite(value) || value < 1) warnings.push(`retention.${name} 必须是 >= 1 的有限小时数`);
		}
		for (const [name, value] of Object.entries({
			max_terminal_agents: config.retention.max_terminal_agents,
			max_read_messages: config.retention.max_read_messages,
		})) {
			if (!Number.isInteger(value) || value < 0) warnings.push(`retention.${name} 必须是 >= 0 的整数`);
		}
	}
	if (config.routing.budget_aware) {
		warnings.push("routing.budget_aware 当前仅执行任务成本/次数/墙钟硬限制；model/topology 预算优化器尚未接入生产入口");
	}
	if (config.context_topology === "peers" && config.lifecycle === "compact") {
		warnings.push("peers + compact: 持久 session 用 compact 会频繁摧毁 cache, 建议 handoff/fork-prune");
	}
	if (config.context_topology === "fork" && config.lifecycle === "handoff") {
		warnings.push("fork + handoff: fork 本身就是生命周期管理, 建议 fork-prune");
	}
	if (config.model_strategy === "heterogeneous" && config.context_topology === "single") {
		warnings.push("heterogeneous + single: 单 context 无法放多 model (error 级, 应改 star/peers)");
	}
	if (config.parallelism === "task" && config.budget.max_cost_per_task < 1.0) {
		warnings.push("task 并行 + 低预算: 并行多 context 可能超预算, 建议 stage");
	}
	return warnings;
}
