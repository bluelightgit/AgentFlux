import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPiCliPath as resolvePiCliPath } from "../../src/core/pi-runtime";
import { resolveSubagentRuntime } from "../../src/core/config";

/** Test-only installed Host selection; still validates manifest/bin/SDK VERSION. */
export function getPiCliPath(): string {
	const packageDir = process.env.AGENTFLUX_LIVE_PI_PACKAGE_DIR;
	return packageDir ? resolvePiCliPath({ hostPackageDir: packageDir, processEntryPath: null }) : resolvePiCliPath();
}

/**
 * Live 验证的模型/provider 配置。
 *
 * 测试场景到 profile 的映射位于 live-test-config.json。默认 local profile
 * 固定使用用户指定的本地模型/provider/thinking，不隐式跟随 Main 的 PI_MODEL。
 * 需要切换 provider 或角色模型时，使用 AGENTFLUX_LIVE_PROFILE
 * 或对应的 AGENTFLUX_LIVE_* 环境变量，不修改测试代码。
 *
 * 自定义兼容 provider 可设置 AGENTFLUX_LIVE_BASE_URL、
 * AGENTFLUX_LIVE_API、AGENTFLUX_LIVE_API_KEY，并选择 environment profile。
 */
export interface LiveConfig {
	profileName: string;
	configPath: string;
	providerId: string;
	mainModel: string;
	plannerModel: string;
	workerModel: string;
	judgeModel: string;
	thinking: string;
	subagentRuntime: "process" | "sdk";
	/** spawn pi 时追加的 provider/model/thinking/api-key CLI 参数 */
	cliArgs(model: string): string[];
	/** spawn 环境变量（自定义 provider 时注入 PI_CODING_AGENT_DIR） */
	env: NodeJS.ProcessEnv;
	/** AgentFlux fixture 的 .agentflux/models.json 内容 */
	fluxModelsJson(): object;
	cleanup(): void;
}

type Setting = string | {
	value?: string;
	env?: string;
	fallback?: string;
};

type LiveProfile = {
	provider?: Setting;
	mainModel?: Setting;
	plannerModel?: Setting;
	workerModel?: Setting;
	judgeModel?: Setting;
	thinking?: Setting;
};

type LiveTestFile = {
	version?: number;
	defaultProfile?: string;
	profiles?: Record<string, LiveProfile>;
	tests?: Record<string, string>;
};

const CONFIG_PATH = resolve(import.meta.dirname, "live-test-config.json");
const MODEL_ENV_OVERRIDES: Record<keyof Pick<LiveConfig, "providerId" | "mainModel" | "plannerModel" | "workerModel" | "judgeModel">, string> = {
	providerId: "AGENTFLUX_LIVE_PROVIDER_ID",
	mainModel: "AGENTFLUX_LIVE_MODEL",
	plannerModel: "AGENTFLUX_LIVE_PLANNER_MODEL",
	workerModel: "AGENTFLUX_LIVE_WORKER_MODEL",
	judgeModel: "AGENTFLUX_LIVE_JUDGE_MODEL",
};

function readConfig(): LiveTestFile {
	const path = process.env.AGENTFLUX_LIVE_CONFIG?.trim() || CONFIG_PATH;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`无法读取 live test config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object") throw new Error(`live test config must be an object: ${path}`);
	const config = parsed as LiveTestFile;
	if (config.version !== undefined && config.version !== 1) throw new Error(`unsupported live test config version: ${String(config.version)}`);
	if (!config.profiles || typeof config.profiles !== "object") throw new Error(`live test config has no profiles: ${path}`);
	return config;
}

function settingValue(setting: Setting | undefined, env: NodeJS.ProcessEnv): string | undefined {
	if (typeof setting === "string") return setting.trim() || undefined;
	if (!setting || typeof setting !== "object") return undefined;
	if (setting.env) {
		const fromEnv = env[setting.env]?.trim();
		if (fromEnv) return fromEnv;
	}
	const value = setting.value?.trim();
	if (value) return value;
	return setting.fallback?.trim() || undefined;
}

function requiredSetting(name: string, value: string | undefined, profileName: string): string {
	if (value) return value;
	throw new Error(`live test profile '${profileName}' has no ${name}; configure it in live-test-config.json or environment`);
}

function uniqueModels(...models: string[]): string[] {
	return [...new Set(models)];
}

export function loadLiveConfig(testName = process.env.AGENTFLUX_LIVE_TEST?.trim() || "default"): LiveConfig {
	const file = readConfig();
	const profileName = process.env.AGENTFLUX_LIVE_PROFILE?.trim()
		|| file.tests?.[testName]
		|| file.defaultProfile
		|| "local";
	const profile = file.profiles?.[profileName];
	if (!profile) throw new Error(`unknown live test profile '${profileName}' for test '${testName}'`);

	const baseUrl = process.env.AGENTFLUX_LIVE_BASE_URL?.trim();
	const env = process.env;
	const profileValue = (key: keyof LiveProfile): string | undefined => settingValue(profile[key], env);
	const providerId = requiredSetting(
		"provider",
		(env[MODEL_ENV_OVERRIDES.providerId]?.trim() || (baseUrl ? "agentflux-ci" : undefined) || profileValue("provider")),
		profileName,
	);
	const mainModel = requiredSetting(
		"mainModel",
		env[MODEL_ENV_OVERRIDES.mainModel]?.trim() || profileValue("mainModel"),
		profileName,
	);
	const plannerModel = requiredSetting(
		"plannerModel",
		env[MODEL_ENV_OVERRIDES.plannerModel]?.trim() || profileValue("plannerModel") || mainModel,
		profileName,
	);
	const workerModel = requiredSetting(
		"workerModel",
		env[MODEL_ENV_OVERRIDES.workerModel]?.trim() || profileValue("workerModel") || mainModel,
		profileName,
	);
	const judgeModel = requiredSetting(
		"judgeModel",
		env[MODEL_ENV_OVERRIDES.judgeModel]?.trim() || profileValue("judgeModel") || plannerModel,
		profileName,
	);
	const thinking = requiredSetting(
		"thinking",
		env.AGENTFLUX_LIVE_THINKING?.trim() || profileValue("thinking") || env.PI_THINKING?.trim() || "off",
		profileName,
	);

	let agentDir: string | undefined;
	let childEnv = env;
	if (baseUrl) {
		agentDir = mkdtempSync(join(tmpdir(), "agentflux-live-"));
		const api = process.env.AGENTFLUX_LIVE_API?.trim() || "openai-completions";
		const apiKey = process.env.AGENTFLUX_LIVE_API_KEY?.trim();
		const provider: Record<string, unknown> = {
			baseUrl,
			api,
			models: uniqueModels(mainModel, plannerModel, workerModel, judgeModel).map(id => ({ id })),
		};
		if (apiKey) provider.apiKey = apiKey;
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [providerId]: provider } }, null, 2));
		childEnv = { ...env, PI_CODING_AGENT_DIR: agentDir };
	}

	const config: LiveConfig = {
		profileName,
		configPath: process.env.AGENTFLUX_LIVE_CONFIG?.trim() || CONFIG_PATH,
		providerId,
		mainModel,
		plannerModel,
		workerModel,
		judgeModel,
		thinking,
		subagentRuntime: resolveSubagentRuntime(env.AGENTFLUX_LIVE_RUNTIME),
		cliArgs: (model: string): string[] => {
			const args = ["--provider", providerId, "--model", model, "--thinking", thinking];
			const apiKey = process.env.AGENTFLUX_LIVE_API_KEY?.trim();
			if (apiKey) args.push("--api-key", apiKey);
			return args;
		},
		env: childEnv,
		fluxModelsJson: () => ({
			models: Object.fromEntries(uniqueModels(config.mainModel, config.plannerModel, config.workerModel, config.judgeModel).map(model => [model, { provider: config.providerId, contextWindow: 1_000_000 }])),
			roles: {
				assistant: { model: config.workerModel, provider: config.providerId, thinking: config.thinking, tools: ["read", "grep", "find", "ls"] },
				planner: { model: config.plannerModel, provider: config.providerId, thinking: config.thinking, tools: ["read", "grep", "find", "ls"] },
				implementer: { model: config.workerModel, provider: config.providerId, thinking: config.thinking, tools: ["read", "grep", "find", "ls"] },
				reviewer: { model: config.workerModel, provider: config.providerId, thinking: config.thinking, tools: ["read", "grep", "find", "ls"] },
				tester: { model: config.workerModel, provider: config.providerId, thinking: config.thinking, tools: ["read", "grep", "find", "ls"] },
			},
			sharedSkills: [],
		}),
		cleanup: () => { if (agentDir) rmSync(agentDir, { recursive: true, force: true }); },
	};
	return config;
}
