/**
 * M2-5 质量门测试
 *
 * 测试内容:
 *   1. 质量门判定通过: 产出满足所有 criteria
 *   2. 质量门判定失败: 产出不满足部分 criteria
 *   3. 质量门空 criteria 跳过
 *   4. 质量门 JSON 解析容错
 *
 * 测试模型: deepseek-v4-flash
 */

import { checkQualityGate, formatQualityGateResult } from "../src/extension/quality-gate";
import { TelemetryWriter } from "../src/telemetry/events";
import { loadConfig } from "../src/core/config";
import { loadPricing } from "../src/core/pricing";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const CWD = process.cwd();
const FLUX_DIR = join(CWD, ".agentflux");

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`${icon} ${name}: ${detail}`);
}

async function main() {
	console.log("=".repeat(70));
	console.log("M2-5 Quality Gate Test");
	console.log(`Model: deepseek-v4-flash`);
	console.log("=".repeat(70) + "\n");

	const config = loadConfig(CWD);
	let pricingTable: any = null;
	try {
		pricingTable = await loadPricing(FLUX_DIR, config.pricing, "deepseek-v4-flash");
	} catch (e: any) {
		console.warn(`Pricing load failed: ${e?.message}`);
	}

	const telemetry = new TelemetryWriter(FLUX_DIR, true);
	const sessionId = `test-m2-5-${Date.now()}`;
	const MODEL = "deepseek-v4-flash";

	let provider: string | undefined;
	try {
		const modelsConfig = JSON.parse(readFileSync(join(FLUX_DIR, "models.json"), "utf-8"));
		provider = modelsConfig.models?.[MODEL]?.provider;
	} catch {}

	const commonOpts = { cwd: CWD, model: MODEL, provider, pricing: pricingTable ?? undefined, telemetry, sessionId };

	// ─── Test 1: 质量门判定通过 ───
	console.log("\n--- Test 1: Quality gate PASS (output meets all criteria) ---");

	const goodOutput = `## Summary
The file src/core/types.ts defines the following types:
- Mode: "M1" | "M2" | "M3" | "M4" | "M5" | "M6"
- Preset: "eco" | "fast" | "accurate" | "balanced" | "custom"
- ProjectStage: "Seed" | "Growth" | "Established" | "Mature"
- FluxRuntimeState: main runtime state interface
- RoutingDecision: routing result with mode, reason, confidence

## Issues
No issues found. The types are well-structured.`;

	const criteria1 = [
		"Output lists type names from the file",
		"Output has a Summary section",
		"Output mentions at least 3 type names",
	];

	console.log("  Running quality gate check...");
	const gateResult1 = await checkQualityGate(goodOutput, criteria1, commonOpts);
	console.log(formatQualityGateResult(gateResult1));

	record("T1.1 Gate returns passed=true for good output",
		gateResult1.passed === true,
		`passed=${gateResult1.passed}`);
	record("T1.2 Gate has criteria results",
		gateResult1.criteriaResults.length === criteria1.length,
		`got ${gateResult1.criteriaResults.length} criteria results (expected ${criteria1.length})`);
	record("T1.3 Gate has feedback text",
		gateResult1.feedback.length > 0,
		`feedback length=${gateResult1.feedback.length}`);
	record("T1.4 Gate has cost > 0 (LLM was called)",
		gateResult1.gateCost > 0 || gateResult1.gateInputTokens > 0,
		`cost=$${gateResult1.gateCost.toFixed(6)}, input_tokens=${gateResult1.gateInputTokens}`);

	// ─── Test 2: 质量门判定失败 ───
	console.log("\n--- Test 2: Quality gate FAIL (output missing criteria) ---");

	const badOutput = `I looked at the file. It has some types. Not sure what they are.`;

	const criteria2 = [
		"Output lists specific type names",
		"Output has a Summary section",
		"Output mentions at least 3 type names",
		"Output has an Issues section",
	];

	console.log("  Running quality gate check...");
	const gateResult2 = await checkQualityGate(badOutput, criteria2, commonOpts);
	console.log(formatQualityGateResult(gateResult2));

	record("T2.1 Gate returns passed=false for poor output",
		gateResult2.passed === false,
		`passed=${gateResult2.passed}`);
	record("T2.2 Gate has feedback explaining failure",
		gateResult2.feedback.length > 0,
		`feedback: ${gateResult2.feedback.slice(0, 100)}`);
	record("T2.3 Gate identifies which criteria are not met",
		gateResult2.criteriaResults.some(c => !c.met),
		`unmet criteria: ${gateResult2.criteriaResults.filter(c => !c.met).map(c => c.criterion).join("; ")}`);

	// ─── Test 3: 空 criteria 跳过 ───
	console.log("\n--- Test 3: Empty criteria (skip gate) ---");

	const gateResult3 = await checkQualityGate("Some output", [], commonOpts);

	record("T3.1 Empty criteria returns passed=true (skip)",
		gateResult3.passed === true,
		`passed=${gateResult3.passed}`);
	record("T3.2 Empty criteria has zero cost",
		gateResult3.gateCost === 0 && gateResult3.gateInputTokens === 0,
		`cost=$${gateResult3.gateCost}, tokens=${gateResult3.gateInputTokens}`);

	// ─── Test 4: 空输出跳过 ───
	console.log("\n--- Test 4: Empty output (skip gate) ---");

	const gateResult4 = await checkQualityGate("", ["Some criterion"], commonOpts);

	record("T4.1 Empty output returns passed=true (skip)",
		gateResult4.passed === true,
		`passed=${gateResult4.passed}`);

	// ─── 汇总 ───
	console.log("\n" + "=".repeat(70));
	console.log("Test Summary");
	console.log("=".repeat(70));
	const passed = results.filter(r => r.passed).length;
	const failed = results.filter(r => !r.passed).length;
	for (const r of results) {
		const icon = r.passed ? "✅" : "❌";
		console.log(`  ${icon} ${r.name}: ${r.detail}`);
	}
	console.log(`\n  Total: ${passed + failed} tests, ${passed} passed, ${failed} failed`);

	if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("Test error:", e); process.exit(1); });
