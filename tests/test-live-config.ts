import assert from "node:assert/strict";
import { loadLiveConfig } from "./live/live-config";

const keys = [
	"AGENTFLUX_LIVE_CONFIG",
	"AGENTFLUX_LIVE_PROFILE",
	"AGENTFLUX_LIVE_PROVIDER_ID",
	"AGENTFLUX_LIVE_MODEL",
	"AGENTFLUX_LIVE_PLANNER_MODEL",
	"AGENTFLUX_LIVE_WORKER_MODEL",
	"AGENTFLUX_LIVE_JUDGE_MODEL",
	"AGENTFLUX_LIVE_THINKING",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_THINKING",
] as const;
const previous = new Map(keys.map(key => [key, process.env[key]]));
try {
	delete process.env.AGENTFLUX_LIVE_CONFIG;
	process.env.AGENTFLUX_LIVE_PROFILE = "local";
	process.env.AGENTFLUX_LIVE_PROVIDER_ID = "configured-provider";
	process.env.AGENTFLUX_LIVE_MODEL = "configured-main";
	process.env.AGENTFLUX_LIVE_PLANNER_MODEL = "configured-planner";
	process.env.AGENTFLUX_LIVE_WORKER_MODEL = "configured-worker";
	process.env.AGENTFLUX_LIVE_JUDGE_MODEL = "configured-judge";
	process.env.AGENTFLUX_LIVE_THINKING = "max";
	process.env.PI_PROVIDER = "ignored-fallback-provider";
	process.env.PI_MODEL = "ignored-fallback-model";
	process.env.PI_THINKING = "off";

	const config = loadLiveConfig("p0-07-workflow-deadline");
	assert.equal(config.profileName, "local");
	assert.match(config.configPath, /live-test-config\.json$/);
	assert.equal(config.providerId, "configured-provider");
	assert.equal(config.mainModel, "configured-main");
	assert.equal(config.plannerModel, "configured-planner");
	assert.equal(config.workerModel, "configured-worker");
	assert.equal(config.judgeModel, "configured-judge");
	assert.equal(config.thinking, "max");
	const fixture = config.fluxModelsJson() as any;
	assert.equal(fixture.roles.planner.model, "configured-planner");
	assert.equal(fixture.roles.implementer.model, "configured-worker");
	assert.equal(config.cliArgs(config.mainModel).at(-1), "max");
	config.cleanup();
	console.log("✓ live test profile resolves provider, role models and thinking from config/environment");
	for (const key of keys.filter(key => key.startsWith("AGENTFLUX_LIVE_") && key !== "AGENTFLUX_LIVE_PROFILE")) delete process.env[key];
	const local = loadLiveConfig("multirole");
	assert.equal(local.providerId, "openai-codex");
	for (const model of [local.mainModel, local.plannerModel, local.workerModel, local.judgeModel]) assert.equal(model, "gpt-5.6-luna");
	assert.equal(local.thinking, "max");
	assert.equal((local.fluxModelsJson() as any).roles.assistant.thinking, "max");
	local.cleanup();
	console.log("✓ explicit local Luna/max profile is not replaced by Main PI_MODEL/PI_THINKING");
	console.log("Live config: 2/2 passed");
} finally {
	for (const key of keys) {
		const value = previous.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
