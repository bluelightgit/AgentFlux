/**
 * M3-2/M3-3 Fork 比较与合并测试
 *
 * 测试 compareAndMergeForks() 函数:
 *   1. 两个不同质量的输出 → LLM 选出更好的那个
 *   2. 两个各有优势的输出 → LLM 合并最佳部分
 *   3. 空输出容错
 *
 * 注意: M3-1 (fork explore) 和 M3-4 (prune) 需要 pi TUI 的 ctx.fork() API,
 *       无法在独立脚本中测试, 需在真实 pi 环境验证.
 *
 * 测试模型: deepseek-v4-flash
 */

import { compareAndMergeForks } from "../src/extension/fork-workflow";
import { loadConfig } from "../src/core/config";
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
	console.log("M3-2/M3-3 Fork Compare & Merge Test");
	console.log(`Model: deepseek-v4-flash`);
	console.log("=".repeat(70) + "\n");

	const config = loadConfig(CWD);
	const MODEL = "deepseek-v4-flash";

	let provider: string | undefined;
	try {
		const modelsConfig = JSON.parse(readFileSync(join(FLUX_DIR, "models.json"), "utf-8"));
		provider = modelsConfig.models?.[MODEL]?.provider;
	} catch {}

	const opts = { cwd: CWD, model: MODEL, provider };

	// ─── Test 1: A 明显优于 B ───
	console.log("\n--- Test 1: Branch A clearly better than B ---");

	const outputA_good = `## Analysis of src/core/types.ts

The file defines these core types:
1. **Mode** — Union type "M1" | "M2" | "M3" | "M4" | "M5" | "M6"
2. **Preset** — Union type "eco" | "fast" | "accurate" | "balanced" | "custom"
3. **ProjectStage** — Union type "Seed" | "Growth" | "Established" | "Mature"
4. **ProjectRole** — Union type "doer" | "doer+reviewer" | "planner+orchestrator+reviewer" | "coordinator"
5. **FluxRuntimeState** — Interface with mode, preset, stage, role, cache, turnIndex
6. **RoutingDecision** — Interface with mode, reason[], confidence, fallback, biasSources, expected
7. **CacheStats** — Interface with input, output, cacheRead, cacheWrite, costUsd, etc.

## Summary
Well-structured type definitions covering the core domain model. The types are comprehensive and well-named.`;

	const outputB_poor = `I looked at the file. It has some types. I think there are like 5 or 6 types maybe. They seem to be about modes and stuff.`;

	console.log("  Running comparison...");
	const result1 = await compareAndMergeForks(outputA_good, outputB_poor, "Analyze src/core/types.ts and describe the types defined there.", opts);

	console.log(`  Winner: ${result1.winner}`);
	console.log(`  Reasoning: ${result1.reasoning.slice(0, 200)}`);

	record("T1.1 Winner is A (clearly better output)",
		result1.winner === "A",
		`winner=${result1.winner}`);
	record("T1.2 Merged output contains detailed type list",
		/Mode.*Preset.*ProjectStage/i.test(result1.mergedOutput) || /M1.*M2.*M3/i.test(result1.mergedOutput),
		`merged output length=${result1.mergedOutput.length}, contains type details`);
	record("T1.3 Reasoning explains why A won",
		result1.reasoning.length > 10,
		`reasoning: ${result1.reasoning.slice(0, 100)}`);

	// ─── Test 2: B 明显优于 A ───
	console.log("\n--- Test 2: Branch B clearly better than A ---");

	console.log("  Running comparison...");
	const result2 = await compareAndMergeForks(outputB_poor, outputA_good, "Analyze src/core/types.ts and describe the types defined there.", opts);

	console.log(`  Winner: ${result2.winner}`);

	record("T2.1 Winner is B (reversed inputs, B is better)",
		result2.winner === "B",
		`winner=${result2.winner}`);

	// ─── Test 3: 两个各有优势的输出 → 合并 ───
	console.log("\n--- Test 3: Merge complementary outputs ---");

	const outputA_partial = `## Types in types.ts

Found these types:
- Mode: M1-M6
- Preset: eco/fast/accurate/balanced/custom
- FluxRuntimeState: main state with mode, preset, stage

I didn't find any other types.`;

	const outputB_partial = `## Additional Types

Looking deeper into the file, I found:
- ProjectStage: Seed/Growth/Established/Mature
- ProjectRole: doer/coordinator roles
- RoutingDecision: with confidence and fallback
- CacheStats: with cache metrics

These are the less obvious types that complement the main ones.`;

	console.log("  Running comparison...");
	const result3 = await compareAndMergeForks(outputA_partial, outputB_partial, "Analyze src/core/types.ts and describe ALL types defined there.", opts);

	console.log(`  Winner: ${result3.winner}`);
	console.log(`  Merged output length: ${result3.mergedOutput.length}`);

	record("T3.1 Merged output contains types from BOTH branches",
		/Mode/i.test(result3.mergedOutput) && /RoutingDecision|ProjectStage/i.test(result3.mergedOutput),
		`merged contains Mode=${/Mode/i.test(result3.mergedOutput)}, RoutingDecision/ProjectStage=${/RoutingDecision|ProjectStage/i.test(result3.mergedOutput)}`);
	record("T3.2 Comparison produces reasoning",
		result3.reasoning.length > 10,
		`reasoning: ${result3.reasoning.slice(0, 100)}`);

	// ─── Test 4: 空输出容错 ───
	console.log("\n--- Test 4: Empty output handling ---");

	const result4 = await compareAndMergeForks("", "Some valid output", "Test task", opts);

	record("T4.1 Comparison with empty A doesn't crash",
		result4.winner === "A" || result4.winner === "B" || result4.winner === "tie",
		`winner=${result4.winner}, no crash`);

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
	console.log("\n  Note: M3-1 (fork explore) and M3-4 (fork prune) require pi TUI ctx.fork()");
	console.log("        and cannot be tested in standalone scripts. Verify manually in pi TUI.");

	if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("Test error:", e); process.exit(1); });
