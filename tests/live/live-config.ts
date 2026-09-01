import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Live 测试的可配置 Provider 加载。
 *
 * 默认（不设置任何环境变量）使用当前 pi 内置
 * octopus-completions provider 和本机 auth.json 凭据；如需兼容旧环境可显式传入 provider id。
 *
 * 设置 AGENTFLUX_LIVE_BASE_URL 后，会把 provider 定义按 pi models.json
 * 的 providers 段结构写入临时 agent 目录（PI_CODING_AGENT_DIR 重定向），
 * pi 子进程即可使用任意 OpenAI 兼容 / Anthropic 兼容端点：
 *
 *   AGENTFLUX_LIVE_PROVIDER_ID   provider id（默认 agentflux-ci）
 *   AGENTFLUX_LIVE_BASE_URL      baseUrl（如 https://api.example.com/v1）
 *   AGENTFLUX_LIVE_API           api 类型：openai-completions（默认）
 *                                / anthropic / openai-responses 等
 *   AGENTFLUX_LIVE_API_KEY       API key（可省略，改用 --api-key 时同源）
 *   AGENTFLUX_LIVE_MODEL_PRO     高能力模型名（默认 deepseek-v4-pro）
 *   AGENTFLUX_LIVE_MODEL_FLASH   低能力模型名（默认 deepseek-v4-flash）
 *   AGENTFLUX_LIVE_THINKING      thinking 等级（默认 off：
 *                                off|minimal|low|medium|high|xhigh|max）
 *
 * 结构对应 pi models.json（docs/models.md）：
 *
 *   {
 *     "providers": {
 *       "<id>": {
 *         "baseUrl": "...",
 *         "api": "openai-completions",
 *         "apiKey": "...",
 *         "models": [{ "id": "..." }, ...]
 *       }
 *     }
 *   }
 */
export interface LiveConfig {
	providerId: string;
	modelPro: string;
	modelFlash: string;
	thinking: string;
	/** spawn pi 时追加的 provider/model/thinking/api-key CLI 参数 */
	cliArgs(model: string): string[];
	/** spawn 环境变量（自定义 provider 时注入 PI_CODING_AGENT_DIR） */
	env: NodeJS.ProcessEnv;
	/** AgentFlux fixture 的 .agentflux/models.json 内容 */
	fluxModelsJson(): object;
	cleanup(): void;
}

export function loadLiveConfig(): LiveConfig {
	const baseUrl = process.env.AGENTFLUX_LIVE_BASE_URL?.trim();
	const providerId = process.env.AGENTFLUX_LIVE_PROVIDER_ID?.trim() || (baseUrl ? "agentflux-ci" : "octopus-completions");
	const api = process.env.AGENTFLUX_LIVE_API?.trim() || "openai-completions";
	const apiKey = process.env.AGENTFLUX_LIVE_API_KEY?.trim();
	const modelPro = process.env.AGENTFLUX_LIVE_MODEL_PRO?.trim() || "deepseek-v4-pro";
	const modelFlash = process.env.AGENTFLUX_LIVE_MODEL_FLASH?.trim() || "deepseek-v4-flash";
	const thinking = process.env.AGENTFLUX_LIVE_THINKING?.trim() || "off";

	let agentDir: string | undefined;
	let env = process.env;
	if (baseUrl) {
		agentDir = mkdtempSync(join(tmpdir(), "agentflux-live-"));
		const provider: Record<string, unknown> = {
			baseUrl,
			api,
			models: [{ id: modelPro }, { id: modelFlash }],
		};
		if (apiKey) provider.apiKey = apiKey;
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [providerId]: provider } }, null, 2));
		env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
	}

	const cliArgs = (model: string): string[] => {
		const args = ["--provider", providerId, "--model", model, "--thinking", thinking];
		if (apiKey) args.push("--api-key", apiKey);
		return args;
	};

	const fluxModelsJson = (): object => ({
		models: {
			[modelPro]: { provider: providerId, contextWindow: 1_000_000 },
			[modelFlash]: { provider: providerId, contextWindow: 1_000_000 },
		},
		roles: {
			planner: { model: modelPro, thinking, tools: ["read", "grep", "find", "ls"] },
			implementer: { model: modelFlash, thinking, tools: ["read", "grep", "find", "ls"] },
			reviewer: { model: modelFlash, thinking, tools: ["read", "grep", "find", "ls"] },
			tester: { model: modelFlash, thinking, tools: ["read", "grep", "find", "ls"] },
		},
		sharedSkills: [],
	});

	return {
		providerId,
		modelPro,
		modelFlash,
		thinking,
		cliArgs,
		env,
		fluxModelsJson,
		cleanup: () => { if (agentDir) rmSync(agentDir, { recursive: true, force: true }); },
	};
}
