/**
 * Comprehensive unit tests for src/extension/prefix-layout.ts
 * Covers: applyPrefixLayout
 */
import { strict as assert } from "node:assert";
import { applyPrefixLayout } from "../src/extension/prefix-layout";
import type { CacheConfig } from "../src/core/types";

let passed = 0;
let failed = 0;

function check(description: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${description}`);
	} catch (error: any) {
		failed++;
		console.log(`  ✗ ${description}: ${error.message}`);
	}
}

const enabledConfig: CacheConfig = {
	prefix_layout: "static_first",
	cache_breaker_actions: [],
	target_hit_rate: 0.85,
};

const disabledConfig: CacheConfig = {
	prefix_layout: "none",
	cache_breaker_actions: [],
	target_hit_rate: 0.85,
};

function makePayload(messages: any[]) {
	return { messages: [...messages] };
}

// ─── applyPrefixLayout ───────────────────────────────────────────────

console.log("\n--- applyPrefixLayout ---");

check("returns noop when prefix_layout disabled", () => {
	const payload = makePayload([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
	const result = applyPrefixLayout(payload, disabledConfig);
	assert.strictEqual(result.result.applied, false);
	assert.strictEqual(result.payload, payload);
});

check("returns noop when messages < 2", () => {
	const payload = makePayload([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
	const result = applyPrefixLayout(payload, enabledConfig);
	assert.strictEqual(result.result.applied, false);
});

check("applies cache_control to second-to-last message", () => {
	const payload = makePayload([
		{ role: "user", content: [{ type: "text", text: "history" }] },
		{ role: "assistant", content: [{ type: "text", text: "response" }] },
	]);
	const result = applyPrefixLayout(payload, enabledConfig);
	assert.strictEqual(result.result.applied, true);
	assert.strictEqual(result.result.targetMsgIndex, 0);
});

check("cache_control is added to last content block of history message", () => {
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
	];
	const payload = makePayload(msgs);
	const result = applyPrefixLayout(payload, enabledConfig);
	const histMsg = result.payload.messages[0];
	// Both blocks should have no cache_control, last block gets it
	for (let i = 0; i < histMsg.content.length - 1; i++) {
		assert.strictEqual(histMsg.content[i].cache_control, undefined);
	}
	const lastBlock = histMsg.content[histMsg.content.length - 1];
	assert.deepStrictEqual(lastBlock.cache_control, { type: "ephemeral" });
});

check("preserves existing native cache_control without rewriting", () => {
	const msgs = [
		{
			role: "user",
			content: [
				{ type: "text", text: "first", cache_control: { type: "ephemeral" } },
				{ type: "text", text: "second", cache_control: { type: "ephemeral" } },
			],
		},
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
	];
	const payload = makePayload(msgs);
	const result = applyPrefixLayout(payload, enabledConfig);
	assert.strictEqual(result.result.applied, false);
	assert.strictEqual(result.payload, payload);
	assert.deepStrictEqual(result.payload.messages[0].content.map((block: any) => block.cache_control), [{ type: "ephemeral" }, { type: "ephemeral" }]);
});

check("preserves native 1h TTL, system and tools", () => {
	const payload = { system: [{ text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }], tools: [{ name: "read", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [
		{ role: "user", content: [{ type: "text", text: "history", cache_control: { type: "ephemeral", ttl: "1h" } }] },
		{ role: "user", content: [{ type: "text", text: "next" }] },
	] };
	const original = JSON.stringify(payload);
	const result = applyPrefixLayout(payload, enabledConfig);
	assert.strictEqual(result.result.applied, false);
	assert.strictEqual(result.payload, payload);
	assert.strictEqual(JSON.stringify(result.payload), original);
});

check("does not modify the last message", () => {
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "history" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
	];
	const payload = makePayload(msgs);
	const result = applyPrefixLayout(payload, enabledConfig);
	// Last message unchanged
	assert.deepStrictEqual(result.payload.messages[1], msgs[1]);
});

check("handles messages with string content (non-array)", () => {
	const msgs = [
		{ role: "user", content: "plain text" },
		{ role: "assistant", content: "response" },
	];
	const payload = makePayload(msgs);
	const result = applyPrefixLayout(payload, enabledConfig);
	assert.strictEqual(result.result.applied, false);
	assert.strictEqual(result.result.reason.includes("no content blocks"), true);
});

check("handles messages with empty content array", () => {
	const msgs = [
		{ role: "user", content: [] },
		{ role: "assistant", content: [{ type: "text", text: "response" }] },
	];
	const payload = makePayload(msgs);
	const result = applyPrefixLayout(payload, enabledConfig);
	assert.strictEqual(result.result.applied, false);
});

check("does not mutate the original payload", () => {
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "history" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
	];
	const payload = makePayload(msgs);
	const originalText = msgs[0].content[0].text;
	applyPrefixLayout(payload, enabledConfig);
	// Original msgs array should not have been mutated
	assert.strictEqual((msgs[0].content[0] as { cache_control?: unknown }).cache_control, undefined);
});

check("works with more than 2 messages", () => {
	const payload = makePayload([
		{ role: "user", content: [{ type: "text", text: "first" }] },
		{ role: "assistant", content: [{ type: "text", text: "second" }] },
		{ role: "user", content: [{ type: "text", text: "third" }] },
	]);
	const result = applyPrefixLayout(payload, enabledConfig);
	assert.strictEqual(result.result.applied, true);
	// Second-to-last message (index 1) gets cache_control
	assert.strictEqual(result.result.targetMsgIndex, 1);
	const histMsg = result.payload.messages[1];
	assert.deepStrictEqual(histMsg.content[0].cache_control, { type: "ephemeral" });
});

check("handles null/undefined payload gracefully", () => {
	// Should not crash with these inputs
	applyPrefixLayout(undefined, enabledConfig);
	applyPrefixLayout(null, enabledConfig);
});

console.log(`\n=== Prefix Layout Tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
