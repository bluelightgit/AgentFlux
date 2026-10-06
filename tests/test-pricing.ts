/**
 * Comprehensive unit tests for src/core/pricing.ts
 * Covers: generateCandidates, lookupPrice, calcCost, calcCostCumulative
 */
import { strict as assert } from "node:assert";
import {
	generateCandidates,
	lookupPrice,
	calcCost,
	calcCostCumulative,
	UNKNOWN_PRICE,
	type PricingTable,
	type PriceEntry,
	loadPricing,
	resolveUsageCost,
	resolveUsageCostDetailed,
} from "../src/core/pricing";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRICING_CONFIG } from "../src/core/pricing";

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

const sampleTable: PricingTable = {
	entries: {
		"openai/gpt-4": { input: 0.00001, output: 0.00003, cacheRead: 0.000005, cacheWrite: 0, source: "remote" },
		"openai/gpt-4o": { input: 0.000005, output: 0.000015, cacheRead: 0.0000025, cacheWrite: 0, source: "remote" },
		"anthropic/claude-3-opus": { input: 0.000015, output: 0.000075, cacheRead: 0.0000075, cacheWrite: 0.000015, source: "remote" },
		"vendor/model-fast": { input: 0.0000005, output: 0.0000015, cacheRead: 0.00000025, cacheWrite: 0, source: "remote" },
		"glm-5.2": { input: 0.000002, output: 0.000004, cacheRead: 0.000001, cacheWrite: 0, source: "user" },
	},
	avg: UNKNOWN_PRICE,
	fetchedAt: Date.now(),
	sourceUrl: "https://openrouter.ai/api/v1/models",
	remoteOk: true,
};

// ─── generateCandidates ──────────────────────────────────────────────

console.log("\n--- generateCandidates ---");

check("returns empty array for empty input", () => {
	assert.deepStrictEqual(generateCandidates(""), []);
});

check("returns original name first", () => {
	const candidates = generateCandidates("openai/gpt-4");
	assert.strictEqual(candidates[0], "openai/gpt-4");
});

check("strips one-level prefix", () => {
	const candidates = generateCandidates("oa/glm-5.2");
	assert.ok(candidates.includes("glm-5.2"));
});

check("strips known redistribution prefix (oa)", () => {
	const candidates = generateCandidates("oa/glm-5.2");
	assert.ok(candidates.includes("glm-5.2"));
});

check("strips known redistribution prefix (flux)", () => {
	const candidates = generateCandidates("flux/gpt-4");
	assert.ok(candidates.includes("gpt-4"));
});

check("strips known redistribution prefix (relay)", () => {
	const candidates = generateCandidates("relay/gpt-4o");
	assert.ok(candidates.includes("gpt-4o"));
});

check("strips known redistribution prefix (gateway)", () => {
	const candidates = generateCandidates("gateway/opus");
	assert.ok(candidates.includes("opus"));
});

check("strips known redistribution prefix (proxy)", () => {
	const candidates = generateCandidates("proxy/glm-5.2");
	assert.ok(candidates.includes("glm-5.2"));
});

check("handles multi-segment names", () => {
	const candidates = generateCandidates("vendor/model-fast");
	assert.ok(candidates.includes("model-fast"));
	assert.strictEqual(candidates[0], "vendor/model-fast");
});

check("does not duplicate candidates", () => {
	const candidates = generateCandidates("oa/glm-5.2");
	const unique = new Set(candidates);
	assert.strictEqual(candidates.length, unique.size);
});

// ─── lookupPrice ──────────────────────────────────────────────────────

console.log("\n--- lookupPrice ---");

check("finds exact match", () => {
	const price = lookupPrice(sampleTable, "openai/gpt-4");
	assert.strictEqual(price.input, 0.00001);
	assert.strictEqual(price.source, "remote");
});

check("finds model-part exact match", () => {
	const price = lookupPrice(sampleTable, "oa/glm-5.2");
	assert.strictEqual(price.input, 0.000002);
});

check("returns UNKNOWN_PRICE for unknown model", () => {
	const price = lookupPrice(sampleTable, "completely/unknown");
	assert.strictEqual(price, UNKNOWN_PRICE);
	assert.strictEqual(price.source, "unknown");
});

check("finds via model-part prefix match", () => {
	const price = lookupPrice(sampleTable, "vendor/model-fast-coding");
	assert.strictEqual(price.input, 0.0000005);
});

check("returns UNKNOWN_PRICE for short prefix (<= 3 chars)", () => {
	const price = lookupPrice(sampleTable, "unknown/v1");
	assert.strictEqual(price.source, "unknown");
});

check("finds via redistributed prefix stripping", () => {
	const price = lookupPrice(sampleTable, "flux/glm-5.2");
	assert.strictEqual(price.input, 0.000002);
});

check("user source overrides remote", () => {
	const price = lookupPrice(sampleTable, "glm-5.2");
	assert.strictEqual(price.source, "user");
});

// ─── calcCost ─────────────────────────────────────────────────────────

console.log("\n--- calcCost ---");

check("returns 0 for unknown price", () => {
	const cost = calcCost({ input: 100, output: 50 }, UNKNOWN_PRICE);
	assert.strictEqual(cost, 0);
});

check("calculates cost correctly for known price", () => {
	const price: PriceEntry = { input: 0.00001, output: 0.00003, cacheRead: 0.000005, cacheWrite: 0, source: "remote" };
	const cost = calcCost({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 }, price);
	const expected = 1000 * 0.00001 + 500 * 0.00003 + 200 * 0.000005;
	assert.strictEqual(cost, expected);
});

check("returns 0 for zero usage", () => {
	const price: PriceEntry = { input: 0.00001, output: 0.00003, cacheRead: 0.000005, cacheWrite: 0.00001, source: "remote" };
	const cost = calcCost({}, price);
	assert.strictEqual(cost, 0);
});

check("handles cache write cost", () => {
	const price: PriceEntry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.01, source: "remote" };
	const cost = calcCost({ cacheWrite: 100 }, price);
	assert.strictEqual(cost, 1.0);
});

check("handles missing fields as zero", () => {
	const price: PriceEntry = { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0004, source: "remote" };
	const cost = calcCost({ input: 10 }, price);
	assert.strictEqual(cost, 10 * 0.001);
});

// ─── calcCostCumulative ──────────────────────────────────────────────

console.log("\n--- calcCostCumulative ---");

check("sums multiple usages", () => {
	const usages = [
		{ input: 100, output: 50 },
		{ input: 200, output: 100 },
	];
	const cost = calcCostCumulative(usages, sampleTable, "openai/gpt-4o");
	const price = sampleTable.entries["openai/gpt-4o"];
	const expected = (100 + 200) * price.input + (50 + 100) * price.output;
	assert.ok(Math.abs(cost - expected) < 1e-12, `${cost} != ${expected}`);
});

check("returns 0 for empty usage array", () => {
	const cost = calcCostCumulative([], sampleTable, "openai/gpt-4");
	assert.strictEqual(cost, 0);
});

check("cumulative resolution preserves native request totals before remote quotes", () => {
	const cost = calcCostCumulative([{ input: 100, cost: { total: 0.7 } }], sampleTable, "openai/gpt-4");
	assert.strictEqual(cost, 0.7);
});

check("uses unknown price for unknown model (returns 0)", () => {
	const cost = calcCostCumulative([{ input: 100 }], sampleTable, "unknown/model");
	assert.strictEqual(cost, 0);
});

const localPricingRoot = mkdtempSync(join(tmpdir(), "agentflux-pricing-"));
try {
	writeFileSync(join(localPricingRoot, "models.json"), JSON.stringify({
		models: {
			"metadata-only": { provider: "provider", contextWindow: 272000 },
			"modalities-not-price": { input: ["text"], provider: "provider" },
			"explicit-free": { pricing: { input: 0, output: 0 } },
			"configured-worker-model": {
				provider: "configured-provider",
				pricing: { input: 9e-8, output: 1.8e-7, cacheRead: 2e-8, cacheWrite: 1e-7 },
			},
		},
	}));
	const localTable = await loadPricing(localPricingRoot, { ...DEFAULT_PRICING_CONFIG, enable_remote_fetch: false }, "configured-worker-model");
	check("metadata and modalities do not become explicit user zero prices", () => {
		assert.equal(localTable.entries["metadata-only"], undefined);
		assert.equal(localTable.entries["modalities-not-price"], undefined);
		assert.equal(resolveUsageCost({ input: 1157, output: 37, cost: { total: 0.0002758 } }, "metadata-only", localTable), 0.0002758);
	});
	check("known quotes, native usage, and fallback retain explicit precedence", () => {
		assert.equal(resolveUsageCost({ input: 10, cost: { total: 0.7 } }, "explicit-free", localTable), 0);
		assert.equal(resolveUsageCost({ input: 10, cost: { total: 0 } }, "configured-worker-model", localTable), 9e-7);
		assert.equal(resolveUsageCost({ cost: { total: 0 } }, "metadata-only", localTable), 0);
		assert.equal(resolveUsageCost({ input: 10 }, "metadata-only", localTable), calcCost({ input: 10 }, lookupPrice(localTable, "metadata-only")));
		assert.equal(resolveUsageCost({ cost: { total: NaN } }), 0);
		const remote: PricingTable = { ...localTable, entries: { remote: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, source: "remote" } } };
		assert.equal(resolveUsageCost({ input: 10, cost: { total: 0.7 } }, "remote", remote), 0.7);
		assert.equal(resolveUsageCost({ input: 10 }, "remote", remote), 0.1);
		assert.deepEqual(resolveUsageCostDetailed({ input: 10, cost: { total: 0.7 } }, "remote", remote), { cost: 0.7, source: "native", known: true });
		assert.deepEqual(resolveUsageCostDetailed({ input: 10 }, "remote", remote), { cost: 0.1, source: "remote", known: true });
		assert.deepEqual(resolveUsageCostDetailed({ input: 10 }), { cost: 0, source: "unknown", known: false });
	});
	check("loads pricing from the canonical nested models.json shape", () => {
		const price = lookupPrice(localTable, "configured-worker-model");
		assert.strictEqual(price.source, "user");
		assert.strictEqual(price.input, 9e-8);
		assert.strictEqual(price.output, 1.8e-7);
	});
} finally {
	rmSync(localPricingRoot, { recursive: true, force: true });
}

console.log(`\n=== Pricing Tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
