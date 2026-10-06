import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import sourceEntry from "../src/subagent-entry";
import { resolveCapabilityPolicy } from "../src/core/capability-policy";

// 真实 SDK 的执行 pipeline；危险工具的 execute 只设毒丸计数，绝不运行命令或读文件。
const root = mkdtempSync(join(tmpdir(), "flux-subentry-host-"));
const agentDir = join(root, "pi"); mkdirSync(agentDir);
const envKeys = Object.keys(process.env).filter(key => key.startsWith("AGENTFLUX_"));
const original = new Map(envKeys.map(key => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
const entry = original.get("AGENTFLUX_HOST_TEST_BUILT") === "1" ? (await import(new URL("../dist/extension/subagent-entry.js", import.meta.url).href)).default : sourceEntry;
process.env.AGENTFLUX_CAPABILITY_POLICY = JSON.stringify(resolveCapabilityPolicy({ cwd: root, agentName: "fixture", role: "fixture", runId: "fixture", template: {
	tools: ["fixture_parent", "read"], workspace: { roots: [root], deniedPaths: ["denied.txt"] },
} }).effective);
const manager = SessionManager.create(root, join(root, "sessions"));
const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
let requests = 0, executions = 0, checked = 0;
const events: any[] = [];
runtime.registerProvider("fixture", { api: "fixture-api" as any, apiKey: "offline", baseUrl: "http://127.0.0.1:1", models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 }],
	streamSimple(model: any) {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const content: any = requests++ === 0 ? [{ type: "toolCall", id: "parent", name: "fixture_parent", arguments: {} }] : [{ type: "text", text: "BLOCKS_VERIFIED" }];
			const stopReason = content[0].type === "toolCall" ? "toolUse" : "stop";
			const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push({ type: "done", reason: stopReason, message }); stream.end();
		}); return stream;
	},
});
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
	extensionFactories: [pi => { pi.on("tool_call", event => { events.push({ toolName: event.toolName, parentToolCallId: event.parentToolCallId }); }); }, entry, pi => {
		for (const name of ["fixture_leaf", "read", "powershell"]) pi.registerTool({ name, label: name, description: "Never execute this poison pill", exposure: "codemode", parameters: name === "read" ? Type.Object({ path: Type.String() }) : name === "powershell" ? Type.Object({ command: Type.String() }) : Type.Object({}), async execute() {
			executions++; throw new Error("Policy bypass: poison pill executed");
		} });
		pi.registerTool({ name: "fixture_parent", label: "Parent", description: "Verify nested permissions", parameters: Type.Object({}), async execute(_id, _args, _signal, _update, ctx) {
			for (const [name, args, pattern] of [["fixture_leaf", {}, /not allowed/i], ["read", { path: "denied.txt" }, /denied/i], ["powershell", { command: "git reset --hard" }, /PowerShell.*unavailable/i]] as const) {
				const outcome = await ctx.executeTool(name, args);
				assert.equal(outcome.isError, true, JSON.stringify(outcome));
				assert.match(JSON.stringify(outcome.result.content), pattern); checked++;
			}
			return { content: [{ type: "text", text: "Blocked" }], details: { ok: true } };
		} });
	}] });
let session: any;
try {
	await loader.reload();
	const created = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel("fixture", "fixture"), thinkingLevel: "off", settingsManager: settings, sessionManager: manager, resourceLoader: loader });
	session = created.session;
	assert.deepEqual(created.extensionsResult.errors, []);
	await session.bindExtensions({ mode: "json" });
	await session.prompt("Execute the permission fixture.");
	assert.equal(checked, 3); assert.equal(executions, 0);
	const nested = events.filter(event => ["fixture_leaf", "read", "powershell"].includes(event.toolName));
	assert.equal(nested.length, 3); assert.ok(nested.every(event => event.parentToolCallId === "parent"));
	// 权威 nestedCalls 同样保留拒绝事实。
	const parentResult: any = manager.getEntries().find((item: any) => item.message?.role === "toolResult" && item.message.toolCallId === "parent");
	assert.equal(parentResult.message.isError, false);
	assert.ok(JSON.stringify(parentResult.message).includes("fixture_leaf"));
	const receipt: any = manager.getEntries().find((item: any) => item.customType === "agentflux.boundary.receipt");
	assert.equal(receipt.data.generation, 1); assert.equal(receipt.data.outcome, "completed"); assert.equal(receipt.data.settled, false);
	console.log(`Pi ${VERSION} subentry: inactive nested leaf, denied path and PowerShell blocked; no execution; native boundary receipt preserved (no Provider request)`);
} finally {
	session?.dispose();
	for (const key of Object.keys(process.env).filter(key => key.startsWith("AGENTFLUX_"))) delete process.env[key];
	for (const [key, value] of original) if (value !== undefined) process.env[key] = value;
	rmSync(root, { recursive: true, force: true });
}
