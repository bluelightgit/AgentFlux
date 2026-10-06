/**
 * Comprehensive unit tests for src/core/cache-impact.ts
 * Covers: assessCacheImpact, diffRuntimeCacheShape, formatCacheImpactWarning
 */
import { strict as assert } from "node:assert";
import {
	assessCacheImpact,
	diffRuntimeCacheShape,
	formatCacheImpactWarning,
	type CacheImpactChange,
	type RuntimeCacheShape,
} from "../src/core/cache-impact";

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

// ─── assessCacheImpact ────────────────────────────────────────────────

console.log("\n--- assessCacheImpact ---");

check("tool_schema has high severity and invalidates prefix", () => {
	const result = assessCacheImpact("tool_schema", 1);
	assert.strictEqual(result.severity, "high");
	assert.strictEqual(result.invalidatesReusablePrefix, true);
	assert.strictEqual(result.requiresNewSessionGeneration, true);
	assert.strictEqual(result.shouldNotifyUser, true);
});

check("skill_set adds context tokens", () => {
	const result = assessCacheImpact("skill_set", 1);
	assert.strictEqual(result.addsContextTokens, true);
	assert.strictEqual(result.severity, "high");
});

check("mcp_set has high severity", () => {
	const result = assessCacheImpact("mcp_set", 1);
	assert.strictEqual(result.severity, "high");
	assert.strictEqual(result.invalidatesReusablePrefix, true);
});

check("system_prompt change requires new session generation", () => {
	const result = assessCacheImpact("system_prompt", 1);
	assert.strictEqual(result.requiresNewSessionGeneration, true);
	assert.strictEqual(result.addsContextTokens, true);
});

check("model change invalidates prefix", () => {
	const result = assessCacheImpact("model", 1);
	assert.strictEqual(result.severity, "high");
	assert.strictEqual(result.invalidatesReusablePrefix, true);
});

check("session_generation requires new session", () => {
	const result = assessCacheImpact("session_generation", 1);
	assert.strictEqual(result.requiresNewSessionGeneration, true);
});

check("runtime_policy_guard has none severity and does not invalidate prefix", () => {
	const result = assessCacheImpact("runtime_policy_guard", 1);
	assert.strictEqual(result.severity, "none");
	assert.strictEqual(result.invalidatesReusablePrefix, false);
	assert.strictEqual(result.requiresNewSessionGeneration, false);
	assert.strictEqual(result.shouldNotifyUser, false);
});

check("message_injection has low severity and adds context tokens", () => {
	const result = assessCacheImpact("message_injection", 1);
	assert.strictEqual(result.severity, "low");
	assert.strictEqual(result.invalidatesReusablePrefix, false);
	assert.strictEqual(result.addsContextTokens, true);
});

check("cost sensitivity zero suppresses notification", () => {
	const result = assessCacheImpact("model", 0);
	assert.strictEqual(result.shouldNotifyUser, false);
	assert.strictEqual(result.suppressedReason, "cost_sensitivity_zero");
});

check("no cache hit impact suppresses notification with different reason", () => {
	const result = assessCacheImpact("message_injection", 1);
	assert.strictEqual(result.shouldNotifyUser, false);
	assert.strictEqual(result.suppressedReason, "no_cache_hit_impact");
});

check("cost sensitivity is clamped between 0 and 1", () => {
	const low = assessCacheImpact("tool_schema", -1);
	assert.ok(low.costSensitivity >= 0);
	const high = assessCacheImpact("tool_schema", 10);
	assert.ok(high.costSensitivity <= 1);
});

check("every change type produces a unique reason string", () => {
	const changes: CacheImpactChange[] = [
		"tool_schema", "skill_set", "mcp_set", "system_prompt",
		"model", "session_generation", "runtime_policy_guard", "message_injection",
	];
	const reasons = changes.map(c => assessCacheImpact(c, 0.5).reason);
	const unique = new Set(reasons);
	assert.strictEqual(unique.size, reasons.length, "all reasons should be unique");
});

// ─── formatCacheImpactWarning ─────────────────────────────────────────

console.log("\n--- formatCacheImpactWarning ---");

check("returns null when should not notify user", () => {
	const result = assessCacheImpact("message_injection", 1);
	assert.strictEqual(formatCacheImpactWarning(result), null);
});

check("returns warning string when should notify user", () => {
	const result = assessCacheImpact("tool_schema", 1);
	const warning = formatCacheImpactWarning(result);
	assert.ok(warning !== null);
	assert.ok(warning!.includes("Warning: Cache impact"));
	assert.ok(warning!.includes("tool_schema"));
	assert.ok(warning!.includes("cost_sensitivity"));
	assert.ok(warning!.includes("reusable-prefix=invalidated"));
});

// ─── diffRuntimeCacheShape ───────────────────────────────────────────

console.log("\n--- diffRuntimeCacheShape ---");

const base: RuntimeCacheShape = {
	toolSchema: "tool-v1",
	skillSet: "skill-v1",
	mcpSet: "mcp-v1",
	systemPrompts: "prompt-v1",
	modelAssignments: "model-v1",
};

check("identical shapes produce no changes", () => {
	const changes = diffRuntimeCacheShape(base, { ...base });
	assert.strictEqual(changes.length, 0);
});

check("detects tool_schema change", () => {
	const changes = diffRuntimeCacheShape(base, { ...base, toolSchema: "tool-v2" });
	assert.deepStrictEqual(changes, ["tool_schema"]);
});

check("detects skill_set change", () => {
	const changes = diffRuntimeCacheShape(base, { ...base, skillSet: "skill-v2" });
	assert.deepStrictEqual(changes, ["skill_set"]);
});

check("detects mcp_set change", () => {
	const changes = diffRuntimeCacheShape(base, { ...base, mcpSet: "mcp-v2" });
	assert.deepStrictEqual(changes, ["mcp_set"]);
});

check("detects system_prompt change", () => {
	const changes = diffRuntimeCacheShape(base, { ...base, systemPrompts: "prompt-v2" });
	assert.deepStrictEqual(changes, ["system_prompt"]);
});

check("detects model change", () => {
	const changes = diffRuntimeCacheShape(base, { ...base, modelAssignments: "model-v2" });
	assert.deepStrictEqual(changes, ["model"]);
});

check("detects multiple changes simultaneously", () => {
	const after: RuntimeCacheShape = {
		toolSchema: "tool-v2",
		skillSet: "skill-v1",
		mcpSet: "mcp-v2",
		systemPrompts: "prompt-v1",
		modelAssignments: "model-v2",
	};
	const changes = diffRuntimeCacheShape(base, after);
	assert.deepStrictEqual(changes, ["tool_schema", "mcp_set", "model"]);
});

check("detects all changes simultaneously", () => {
	const after: RuntimeCacheShape = {
		toolSchema: "tool-v2",
		skillSet: "skill-v2",
		mcpSet: "mcp-v2",
		systemPrompts: "prompt-v2",
		modelAssignments: "model-v2",
	};
	const changes = diffRuntimeCacheShape(base, after);
	assert.deepStrictEqual(changes, ["tool_schema", "skill_set", "mcp_set", "system_prompt", "model"]);
});

check("field order in change detection is deterministic", () => {
	const after = { ...base, modelAssignments: "model-v2", toolSchema: "tool-v2" };
	const changes = diffRuntimeCacheShape(base, after);
	assert.deepStrictEqual(changes, ["tool_schema", "model"]);
});

console.log(`\n=== Cache Impact: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
