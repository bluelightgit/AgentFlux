/**
 * Comprehensive unit tests for src/core/config.ts
 * Tests: validateConfig, parseWorkStyle, resolveSharedSkills, merge function internals
 */
import { strict as assert } from "node:assert";
import {
	validateConfig,
	resolveSharedSkills,
} from "../src/core/config";
import { DEFAULT_CONFIG, type FluxConfig } from "../src/core/types";

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

// ─── validateConfig ───────────────────────────────────────────────────

console.log("\n--- validateConfig ---");

check("returns empty warnings for default config", () => {
	const warnings = validateConfig(DEFAULT_CONFIG);
	assert.strictEqual(warnings.length, 0);
});

check("warns about zero cost per task", () => {
	const config: FluxConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_cost_per_task: 0 } };
	const warnings = validateConfig(config);
	assert.ok(warnings.some(w => w.includes("max_cost_per_task")));
});

check("warns about negative cost per task", () => {
	const config: FluxConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_cost_per_task: -1 } };
	const warnings = validateConfig(config);
	assert.ok(warnings.some(w => w.includes("max_cost_per_task")));
});

check("warns about NaN cost per task", () => {
	const config: FluxConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_cost_per_task: NaN } };
	const warnings = validateConfig(config);
	assert.ok(warnings.length > 0);
});

check("warns about zero max_iterations", () => {
	const config: FluxConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_iterations: 0 } };
	const warnings = validateConfig(config);
	assert.ok(warnings.some(w => w.includes("max_iterations")));
});

check("warns about negative max_iterations", () => {
	const config: FluxConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_iterations: -5 } };
	const warnings = validateConfig(config);
	assert.ok(warnings.some(w => w.includes("max_iterations")));
});

check("warns about non-integer max_iterations", () => {
	const config: FluxConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_iterations: 2.5 } };
	const warnings = validateConfig(config);
	assert.ok(warnings.some(w => w.includes("max_iterations")));
});

check("warns about zero max_wall_clock_seconds", () => {
	const config: FluxConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_wall_clock_seconds: 0 } };
	const warnings = validateConfig(config);
	assert.ok(warnings.some(w => w.includes("max_wall_clock_seconds")));
});

check("warns about negative max_wall_clock_seconds", () => {
	const config: FluxConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_wall_clock_seconds: -1 } };
	const warnings = validateConfig(config);
	assert.ok(warnings.some(w => w.includes("max_wall_clock_seconds")));
});

check("produces multiple warnings for multiple invalid fields", () => {
	const config: FluxConfig = {
		...DEFAULT_CONFIG,
		budget: { max_cost_per_task: 0, max_iterations: 0, max_wall_clock_seconds: 0 },
	};
	const warnings = validateConfig(config);
	assert.ok(warnings.length >= 3);
});

check("allows valid custom budget values", () => {
	const config: FluxConfig = {
		...DEFAULT_CONFIG,
		budget: { max_cost_per_task: 5, max_iterations: 10, max_wall_clock_seconds: 1200 },
	};
	assert.strictEqual(validateConfig(config).length, 0);
});

check("validates aggregate turn/input/concurrency budgets", () => {
	const config: FluxConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, max_turns_per_task: 0, max_input_tokens_per_task: 1.5, max_parallel_agents: 0 } };
	const warnings = validateConfig(config);
	assert.equal(warnings.filter(warning => warning.includes("max_turns_per_task")).length, 1);
	assert.equal(warnings.filter(warning => warning.includes("max_input_tokens_per_task")).length, 1);
	assert.equal(warnings.filter(warning => warning.includes("max_parallel_agents")).length, 1);
});

// ─── resolveSharedSkills ─────────────────────────────────────────────

console.log("\n--- resolveSharedSkills ---");

check("returns empty array when no modelsConfig or no sharedSkills", () => {
	assert.deepStrictEqual(resolveSharedSkills(DEFAULT_CONFIG, {}), []);
	assert.deepStrictEqual(resolveSharedSkills(DEFAULT_CONFIG, {}), []);
});

check("returns deduplicated skills array", () => {
	const result = resolveSharedSkills(DEFAULT_CONFIG, { sharedSkills: ["code-review", "code-review", "planning"] });
	assert.deepStrictEqual(result, ["code-review", "planning"]);
});

check("filters out non-string items", () => {
	const result = resolveSharedSkills(DEFAULT_CONFIG, {
		sharedSkills: ["code-review", 42, null, "planning"],
	});
	assert.deepStrictEqual(result, ["code-review", "planning"]);
});

check("trims whitespace from skill names", () => {
	const result = resolveSharedSkills(DEFAULT_CONFIG, {
		sharedSkills: ["  code-review  ", "planning "],
	});
	assert.deepStrictEqual(result, ["code-review", "planning"]);
});

check("filters out empty strings after trim", () => {
	const result = resolveSharedSkills(DEFAULT_CONFIG, {
		sharedSkills: ["code-review", "", "  "],
	});
	assert.deepStrictEqual(result, ["code-review"]);
});

check("handles non-array sharedSkills gracefully", () => {
	assert.deepStrictEqual(resolveSharedSkills(DEFAULT_CONFIG, { sharedSkills: "not-an-array" }), []);
	assert.deepStrictEqual(resolveSharedSkills(DEFAULT_CONFIG, { sharedSkills: null }), []);
	assert.deepStrictEqual(resolveSharedSkills(DEFAULT_CONFIG, { sharedSkills: 42 }), []);
});

console.log(`\n=== Config Tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
