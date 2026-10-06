import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import sourceAgentFlux from "../src/entry";
const agentFlux = process.env.AGENTFLUX_HOST_TEST_BUILT === "1" ? (await import(new URL("../dist/extension/entry.js", import.meta.url).href)).default : sourceAgentFlux;
import { collectCacheStats } from "../src/extension/cache-monitor";

// 真实 Pi SDK/权限/持久化链路，确定性响应；不是真实 Provider 请求或账单。
const root = mkdtempSync(join(tmpdir(), "flux-pi-host-migration-"));
const agentDir = join(root, "pi");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(root, ".agentflux"));
writeFileSync(join(root, ".agentflux", "agentflux.json"), JSON.stringify({ pricing: { enable_remote_fetch: false } }));
const usage = (cost: number) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const manager = SessionManager.create(root, join(root, "sessions"));
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
let request = 0;
modelRuntime.registerProvider("migration-fixture", {
	api: "migration-fixture-api" as any, apiKey: "offline", baseUrl: "http://127.0.0.1:1",
	models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 }],
	streamSimple(model: any) {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const current = request++;
			const content: any = current === 0 ? [{ type: "toolCall", id: "prepare", name: "flux_task", arguments: { action: "new", task: "Migration accounting" } }]
				: current === 1 ? [{ type: "toolCall", id: "parent", name: "fixture_parent", arguments: {} }] : [{ type: "text", text: "OK" }];
			const reason = content[0].type === "toolCall" ? "toolUse" : "stop";
			const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, usage: usage(0.01), stopReason: reason, timestamp: Date.now() };
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push({ type: "done", reason, message }); stream.end();
		});
		return stream;
	},
});
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
let ctx: any;
let warmed = false;
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
	extensionFactories: [agentFlux, pi => {
		pi.registerTool({ name: "fixture_leaf", label: "Leaf", description: "Simulated usage", parameters: Type.Object({}), async execute() {
			return { content: [{ type: "text", text: "leaf" }], details: { ok: true }, usage: usage(0.4) } as any;
		} });
		pi.registerTool({ name: "fixture_parent", label: "Parent", description: "Nested fixture", parameters: Type.Object({}), async execute(_id, _params, _signal, _update, context) {
			ctx = context;
			const blocked = await context.executeTool("flux_task", { action: "list" });
			assert.equal(blocked.isError, true, JSON.stringify(blocked));
			assert.match(JSON.stringify(blocked.result.content), /model-only|not available|not callable|not active|not found|unknown tool/i);
			await context.executeTool("fixture_leaf", {});
			return { content: [{ type: "text", text: "parent" }], details: { ok: true } };
		} });
		pi.on("agent_before_settle", () => {
			if (!warmed) { warmed = true; manager.appendUsage("cache_warm", "migration-fixture", "fixture", usage(0.3)); }
		});
	}] });
await loader.reload();
const { session, extensionsResult } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel("migration-fixture", "fixture"), thinkingLevel: "off", settingsManager: settings, sessionManager: manager, resourceLoader: loader });
try {
	assert.deepEqual(extensionsResult.errors, []);
	await session.bindExtensions({ mode: "json" });
	await session.prompt("Run fixture.");
	assert.equal(request, 3);
	const store = JSON.parse(readFileSync(join(root, ".agentflux", "runtime", "tasks.json"), "utf8"));
	const task = store.tasks.find((item: any) => item.task === "Migration accounting");
	const execution = store.executions.find((item: any) => item.id === task.executionId);
	assert.equal(task.status, "completed");
	assert.ok(Math.abs(execution.costUsd - 0.73) < 1e-12, JSON.stringify(execution));
	assert.ok(Math.abs(session.getSessionStats().cost - 0.73) < 1e-12);
	assert.equal(execution.costAccounting.complete, true);
	assert.equal(execution.costAccounting.attributionComplete, false, "heterogeneous parent total is known, attribution is separate");
	const stats = collectCacheStats(ctx);
	assert.ok(Math.abs(stats.costUsd - 0.73) < 1e-12);
	assert.equal(stats.costComplete, true);
	const promptEntries = manager.getEntries().filter((entry: any) => entry.type === "message" && entry.message?.role === "system");
	assert.ok(promptEntries.some((entry: any) => entry.message.sections?.agentflux?.includes("AgentFlux operating protocol")), "structured protocol persisted");
	console.log(`Pi ${VERSION} Host: accounting .73, native nested usage, model-only control rejection and structured prompt passed (no Provider request)`);
} finally { session.dispose(); rmSync(root, { recursive: true, force: true }); }
