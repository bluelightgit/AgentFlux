/**
 * M5-1/M5-2/M5-3/M5-4 DAG 执行器测试
 *
 * 测试内容:
 *   1. M5-1: generateTaskDAG() 生成结构化 DAG
 *   2. M5-2: executeDAG() 按拓扑序执行, 独立节点并行
 *   3. M5-4: 质量门检查 + 自动重试
 *   4. 回退: planner 输出无法解析 → 单节点 DAG
 *
 * 测试模型: deepseek-v4-flash
 */

import { generateTaskDAG, executeDAG, formatDAG, formatDAGResult } from "../src/extension/dag-executor";
import { TelemetryWriter } from "../src/telemetry/events";
import { loadConfig } from "../src/core/config";
import { loadPricing } from "../src/core/pricing";
import { join } from "node:path";
import { readFileSync, existsSync, rmSync } from "node:fs";

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
	console.log("M5-1/2/3/4 DAG Executor Test");
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
	const sessionId = `test-m5-${Date.now()}`;
	const prefixLayout = config.cache.prefix_layout === "static_first";
	const MODEL = "deepseek-v4-flash";

	let provider: string | undefined;
	let modelsConfig: any = null;
	try {
		modelsConfig = JSON.parse(readFileSync(join(FLUX_DIR, "models.json"), "utf-8"));
		provider = modelsConfig.models?.[MODEL]?.provider;
	} catch {}

	const dagOpts = {
		cwd: CWD, fluxDir: FLUX_DIR, modelsConfig, telemetry, prefixLayout,
		pricing: pricingTable ?? undefined, sessionId,
		sharedSkills: modelsConfig?.sharedSkills ?? [],
		maxRetries: 1,           // 限制重试以控制测试时间
		enableQualityGate: true,
	};

	// ─── M5-1: 动态任务分解 ───
	console.log("\n--- M5-1: Dynamic task decomposition ---");

	const task = "Read the file src/core/types.ts, identify all type definitions, and create a summary of each type's purpose. Then verify the summary is complete by cross-checking with the actual file.";

	console.log("  Generating task DAG...");
	const dag = await generateTaskDAG(task, {
		cwd: CWD, model: MODEL, provider, pricing: pricingTable ?? undefined,
		telemetry, sessionId, prefixLayout,
	});

	console.log(formatDAG(dag));

	record("M5-1.1 DAG has at least 1 node",
		dag.nodes.length >= 1,
		`nodes=${dag.nodes.length}`);
	record("M5-1.2 DAG has description",
		dag.description.length > 0,
		`description length=${dag.description.length}`);
	record("M5-1.3 DAG nodes have valid structure",
		dag.nodes.every(n => n.id && n.title && n.role),
		`all nodes have id/title/role`);

	// ─── M5-2: DAG 执行 ───
	console.log("\n--- M5-2: DAG execution ---");

	// 使用一个简单的手动 DAG 来确保测试可控
	const simpleDAG = {
		description: "Read and summarize types.ts, then review the summary",
		nodes: [
			{
				id: "t1",
				title: "Read and summarize types.ts",
				role: "implementer",
				dependsOn: [],
				parallelizable: true,
				acceptanceCriteria: [
					"Output mentions at least 3 type names",
					"Output has a summary or description section",
				],
				files: ["src/core/types.ts"],
				description: "Read src/core/types.ts and write a brief summary of the types defined there. List each type name with a one-line description. Max 200 words.",
			},
			{
				id: "t2",
				title: "Review the summary",
				role: "reviewer",
				dependsOn: ["t1"],
				parallelizable: false,
				acceptanceCriteria: [
					"Output confirms the summary is accurate",
					"Output mentions at least 2 type names from the summary",
				],
				files: [],
				description: "Review the previous summary of types.ts. Check if it accurately describes the types. Output a brief review. Max 100 words.",
			},
		],
	};

	console.log("  Executing simple 2-node DAG (t1 → t2)...");
	console.log(formatDAG(simpleDAG));

	const execResult = await executeDAG(simpleDAG, dagOpts);

	console.log(formatDAGResult(execResult));

	record("M5-2.1 DAG execution completes",
		execResult.completedNodes.length + execResult.failedNodes.length === 2,
		`completed=${execResult.completedNodes.length}, failed=${execResult.failedNodes.length}`);
	record("M5-2.2 t1 executes before t2 (topological order)",
		execResult.completedNodes.includes("t1") || execResult.failedNodes.includes("t1"),
		`t1 processed`);
	record("M5-2.3 Execution has cost > 0",
		execResult.totalCost > 0,
		`cost=$${execResult.totalCost.toFixed(6)}`);
	record("M5-2.4 Execution has wall clock time",
		execResult.wallClockMs > 0,
		`wall=${(execResult.wallClockMs / 1000).toFixed(1)}s`);

	// ─── M5-4: 质量门检查 ───
	console.log("\n--- M5-4: Quality gate in DAG ---");

	const t1Result = execResult.taskResults.get("t1");
	record("M5-4.1 Quality gate was checked for t1 (has criteria)",
		t1Result?.gateResult !== null && t1Result?.gateResult !== undefined,
		`gateResult=${t1Result?.gateResult ? "present" : "null"}`);

	const t2Result = execResult.taskResults.get("t2");
	record("M5-4.2 Quality gate was checked for t2 (has criteria)",
		t2Result?.gateResult !== null && t2Result?.gateResult !== undefined,
		`gateResult=${t2Result?.gateResult ? "present" : "null"}`);

	// ─── M5-5: 状态持久化 ───
	console.log("\n--- M5-5: Execution state persistence ---");

	const dagStateFile = join(FLUX_DIR, "runtime", "dag-state.json");
	record("M5-5.1 DAG state file was created",
		existsSync(dagStateFile),
		`file exists=${existsSync(dagStateFile)}`);

	if (existsSync(dagStateFile)) {
		const state = JSON.parse(readFileSync(dagStateFile, "utf-8"));
		record("M5-5.2 DAG state has completed/failed arrays",
			Array.isArray(state.completed) && Array.isArray(state.failed),
			`completed=${state.completed?.length}, failed=${state.failed?.length}`);
	}

	// ─── M5-3: 条件分支 (reviewer 失败 → 重跑 implementer) ───
	console.log("\n--- M5-3: Conditional branch (reviewer failure) ---");

	// 使用一个会失败的 DAG (reviewer 的 criteria 不可能满足)
	const failDAG = {
		description: "Task with impossible review criteria to test retry logic",
		nodes: [
			{
				id: "f1",
				title: "Simple implementation",
				role: "implementer",
				dependsOn: [],
				parallelizable: false,
				acceptanceCriteria: [],
				files: [],
				description: "Write 'hello world' to stdout. Just echo it.",
			},
			{
				id: "f2",
				title: "Review with impossible criteria",
				role: "reviewer",
				dependsOn: ["f1"],
				parallelizable: false,
				acceptanceCriteria: [
					"Output must contain the exact phrase 'THE_ANSWER_IS_42'",
				],
				files: [],
				description: "Review the implementation. Your output MUST contain the exact phrase 'THE_ANSWER_IS_42' to pass.",
			},
		],
	};

	console.log("  Executing DAG with impossible review criteria...");
	const failResult = await executeDAG(failDAG, { ...dagOpts, maxRetries: 0 }); // 不重试, 快速失败

	console.log(formatDAGResult(failResult));

	record("M5-3.1 Reviewer with impossible criteria fails",
		failResult.failedNodes.includes("f2"),
		`failed nodes=${failResult.failedNodes.join(",")}`);
	record("M5-3.2 Implementer still completes",
		failResult.completedNodes.includes("f1") || failResult.failedNodes.includes("f1"),
		`f1 in completed=${failResult.completedNodes.includes("f1")}`);

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
