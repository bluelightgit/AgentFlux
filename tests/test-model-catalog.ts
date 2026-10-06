import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildChatCatalog, resolveChatModel } from "../src/core/model-catalog";
import { discoverPiModels, rankModels, assignModel } from "../src/core/model-capability";
import { toJsonValue, toolDetailsFailed } from "../src/core/tool-result";
import { runDurationMs } from "../src/core/run-duration";

const native = [
	{ provider: "p1", id: "same", type: "chat", api: "openai-completions", contextWindow: 128000 },
	{ provider: "p2", id: "same", type: "chat", api: "openai-completions" },
	{ provider: "p1", id: "image", type: "image", contextWindow: 5000 },
	{ provider: "p1", id: "classifier", type: "classifier" },
	{ provider: "p3", id: "legacy", contextWindow: 32000 },
	{ provider: "router", id: "auto", type: "chat", api: "pi-virtual" },
];
const models = buildChatCatalog(native);
assert.equal(models.image, undefined);
assert.equal(models.classifier, undefined);
assert.equal(models.same, undefined);
assert.throws(() => resolveChatModel("same", models), /Ambiguous/);
assert.deepEqual(resolveChatModel("same", models, "p1").model, "same");
assert.equal(resolveChatModel("p2/same", models).provider, "p2");
assert.equal(models["p2/same"].contextWindow, undefined);
assert.equal(models.legacy.provider, "p3");
assert.throws(() => resolveChatModel("auto", models, "router", { physical: true }), /Virtual/);
assert.throws(() => resolveChatModel("legacy", buildChatCatalog(native, {}, { registeredProviders: ["p3"] }), undefined, { physical: true }), /Host registration/);
assert.throws(() => resolveChatModel("same", buildChatCatalog(native, {}, { available: [] }), "p1"), /unavailable/);
const pinned = buildChatCatalog(native, { same: { provider: "p2", pricing: { input: 1, output: 2 }, capability: { coding: 1 } } });
assert.equal(pinned.same.provider, "p2");
assert.equal(pinned.same.pricing?.input, 1);
assert.equal(pinned["p1/same"].pricing, undefined);
assert.equal(rankModels({ coding: 1 }, models).filter(item => item.model.includes("same")).length, 2);
assert.ok(rankModels({ coding: 1 }, models).every(item => item.model !== "router/auto"));
assert.throws(() => assignModel("reviewer", { model: "missing", requirement: { coding: 1 } }, models), /explicitly/);
const dir = mkdtempSync(join(tmpdir(), "flux-model-catalog-"));
try {
	const file = join(dir, "models.json");
	writeFileSync(file, JSON.stringify({ providers: { p1: { models: native.filter(item => item.provider === "p1") } } }));
	const found = discoverPiModels(file);
	assert.equal(found.image, undefined);
	assert.equal(found.classifier, undefined);
	assert.equal(found.same.contextWindow, 128000);
} finally { rmSync(dir, { recursive: true, force: true }); }
assert.deepEqual(JSON.parse(JSON.stringify(toJsonValue({ ok: true, absent: undefined, array: ["x", 1] }))), { ok: true, array: ["x", 1] });
assert.throws(() => toJsonValue(new Map([["x", 1]])), /projection/);
assert.throws(() => toJsonValue({ value: Infinity }), /non-finite/);
const circular: any = {}; circular.self = circular;
assert.throws(() => toJsonValue(circular), /circular/);
assert.equal(toolDetailsFailed({ ok: false }), true);
assert.equal(toolDetailsFailed({ ok: true, queued: true }), false);
assert.equal(toolDetailsFailed({ status: "cancelled" }), true);
const run = { createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:10.000Z", status: "completed" };
assert.equal(runDurationMs(run, Date.parse("2026-02-01")), 10000);
assert.equal(runDurationMs({ ...run, finishedAt: undefined }), undefined);
assert.equal(runDurationMs({ ...run, status: "running", finishedAt: undefined }, Date.parse(run.createdAt) + 20000), 20000);
console.log("Chat catalog, JSON DTO and frozen duration checks passed");
