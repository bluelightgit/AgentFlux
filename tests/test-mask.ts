/**
 * Comprehensive unit tests for src/extension/mask.ts
 * Covers: shouldMask, applyMask
 */
import { strict as assert } from "node:assert";
import { shouldMask, applyMask } from "../src/extension/mask";
import type { ContextConfig } from "../src/core/types";

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

const config: ContextConfig = {
	compaction_threshold: 0.70,
	mask_strategy: "hide_tool_results",
	mask_keep_last_n: 3,
};

// ─── shouldMask ───────────────────────────────────────────────────────

console.log("\n--- shouldMask ---");

check("returns true when context% reaches threshold minus buffer", () => {
	assert.strictEqual(shouldMask(0.65, config), true);  // 0.70 - 0.10 = 0.60, 0.65 >= 0.60
});

check("returns true when context% exceeds threshold", () => {
	assert.strictEqual(shouldMask(0.80, config), true);
});

check("returns false when context% is below trigger point", () => {
	assert.strictEqual(shouldMask(0.50, config), false);
	assert.strictEqual(shouldMask(0.59, config), false);
});

check("returns false when contextPercent is null", () => {
	assert.strictEqual(shouldMask(null, config), false);
});

check("returns false when mask_strategy is 'none'", () => {
	const disabled: ContextConfig = { ...config, mask_strategy: "none" };
	assert.strictEqual(shouldMask(0.80, disabled), false);
});

check("returns true exactly at threshold boundary", () => {
	assert.strictEqual(shouldMask(0.60, config), true); // exact trigger point
});

check("returns false just below trigger boundary", () => {
	assert.strictEqual(shouldMask(0.599, config), false);
});

// ─── applyMask ────────────────────────────────────────────────────────

console.log("\n--- applyMask ---");

check("returns noop when context is below threshold", () => {
	const messages = [{ role: "toolResult", content: "result1" }];
	const result = applyMask(messages, config, 0.50);
	assert.strictEqual(result.result.applied, false);
	assert.strictEqual(result.result.maskedCount, 0);
	assert.strictEqual(result.messages, messages); // same reference
});

check("returns noop when mask_strategy is 'none'", () => {
	const disabled: ContextConfig = { ...config, mask_strategy: "none" };
	const messages = [{ role: "toolResult", content: "data" }];
	const result = applyMask(messages, config, 0.80);
	// Let's fix the config usage - should use disabled config
	const r2 = applyMask(messages, disabled, 0.80);
	assert.strictEqual(r2.result.applied, false);
});

check("masks old tool results beyond keep_last_n", () => {
	const messages = [
		{ role: "user", content: "hello" },
		{ role: "toolResult", content: "old_result_1" },
		{ role: "toolResult", content: "old_result_2" },
		{ role: "user", content: "continue" },
		{ role: "toolResult", content: "keep_1" },
		{ role: "toolResult", content: "keep_2" },
		{ role: "toolResult", content: "keep_3" },
	];
	const result = applyMask(messages, config, 0.65);
	assert.strictEqual(result.result.applied, true);
	assert.strictEqual(result.result.maskedCount, 2); // first 2 masked, last 3 kept
});

check("does not mask when tool results <= keep_last_n", () => {
	const messages = [
		{ role: "toolResult", content: "r1" },
		{ role: "toolResult", content: "r2" },
		{ role: "toolResult", content: "r3" },
	];
	const result = applyMask(messages, config, 0.65);
	assert.strictEqual(result.result.applied, false);
	assert.strictEqual(result.result.maskedCount, 0);
});

check("handles zero keep_last_n (mask all)", () => {
	const zeroConfig: ContextConfig = { ...config, mask_keep_last_n: 0 };
	const messages = [
		{ role: "toolResult", content: "r1" },
		{ role: "toolResult", content: "r2" },
	];
	const result = applyMask(messages, zeroConfig, 0.65);
	assert.strictEqual(result.result.applied, true);
});

check("replaces masked tool result content with placeholder", () => {
	const messages = [
		{ role: "toolResult", content: [{ type: "text", text: "long_result" }] },
		{ role: "toolResult", content: "simple_result" },
	];
	const zeroConfig: ContextConfig = { ...config, mask_keep_last_n: 0 };
	const result = applyMask(messages, zeroConfig, 0.65);
	assert.strictEqual(result.result.applied, true);
	const firstMasked = result.messages[0];
	assert.ok(Array.isArray(firstMasked.content));
	assert.ok(firstMasked.content[0].text.includes("masked"));
	const secondMasked = result.messages[1];
	assert.strictEqual(secondMasked.content, "[masked by AgentFlux: old tool result]");
});

check("only masks toolResult and tool role messages", () => {
	const messages = [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "thinking" },
		{ role: "tool", content: "tool_call_1" },
		{ role: "toolResult", content: "result_1" },
		{ role: "toolResult", content: "result_2" },
	];
	const zeroConfig: ContextConfig = { ...config, mask_keep_last_n: 1 };
	const result = applyMask(messages, zeroConfig, 0.65);
	assert.strictEqual(result.result.applied, true);
	// 2 tool + toolResult messages, keep 1 -> mask 1
	assert.strictEqual(result.result.maskedCount, 1);
});

check("does not modify messages when not applied", () => {
	const messages = [{ role: "user", content: "hello" }];
	const result = applyMask(messages, config, 0.50);
	assert.strictEqual(result.result.applied, false);
	assert.strictEqual(result.messages, messages); // same reference
});

check("contextPercent is recorded in result", () => {
	const messages = [
		{ role: "toolResult", content: "old" },
		{ role: "toolResult", content: "keep" },
	];
	const zeroConfig: ContextConfig = { ...config, mask_keep_last_n: 1 };
	const result = applyMask(messages, zeroConfig, 0.80);
	assert.strictEqual(result.result.contextPercentBefore, 0.80);
});

check("handles null contextPercent correctly", () => {
	const messages = [{ role: "toolResult", content: "data" }];
	const result = applyMask(messages, config, null);
	assert.strictEqual(result.result.applied, false);
	assert.strictEqual(result.result.contextPercentBefore, null);
});

check("handles empty messages array", () => {
	const result = applyMask([], config, 0.80);
	assert.strictEqual(result.result.applied, false);
});

console.log(`\n=== Mask Tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
