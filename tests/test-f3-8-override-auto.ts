/**
 * F3-8 override_mode auto 测试
 *
 * 测试内容:
 *   1. override_mode=suggest (默认): applied=false, 经验推荐作为加权候选
 *   2. override_mode=auto: applied=true, 路由器自动应用推荐
 *   3. override_mode=auto + 高置信度经验推荐: 经验覆盖路由结果
 *   4. override_mode=auto + 低置信度经验推荐: 不覆盖
 *   5. override_mode=manual: applied=false, 纯建议
 */

import { route } from "../src/core/routing";
import { ExperienceStore, type ModeRecommendation } from "../src/core/experience-store";
import { DEFAULT_PREFERENCE, type ProjectStage, type Preset } from "../src/core/types";
import { generateTaskRoutingSignal } from "../src/core/task-router";
import { join } from "node:path";
import { rmSync } from "node:fs";

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
	console.log("F3-8 override_mode auto Test");
	console.log("=".repeat(70) + "\n");

	const stage: ProjectStage = "Growth";
	const preset: Preset = "balanced";

	// 生成一个任务路由信号
	const signal = generateTaskRoutingSignal(CWD, "Fix the bug in src/core/types.ts where the mode definition is incorrect");

	// ─── 1. suggest 模式 (默认) ───
	console.log("--- 1. override_mode=suggest (default) ---\n");

	const routeSuggest = route({ stage, pref: DEFAULT_PREFERENCE, preset, taskRoutingSignal: signal });
	record("suggest: applied is false",
		routeSuggest.applied === false || routeSuggest.applied === undefined,
		`applied=${routeSuggest.applied}`);
	record("suggest: has reason with override:suggest",
		routeSuggest.reason.some(r => r.includes("override:suggest")),
		`reason has override:suggest=${routeSuggest.reason.some(r => r.includes("override:suggest"))}`);

	// ─── 2. auto 模式 (无经验推荐) ───
	console.log("\n--- 2. override_mode=auto (no experience) ---\n");

	const routeAuto = route({ stage, pref: DEFAULT_PREFERENCE, preset, taskRoutingSignal: signal, overrideMode: "auto" });
	record("auto: applied is true",
		routeAuto.applied === true,
		`applied=${routeAuto.applied}`);
	record("auto: has reason with override:auto",
		routeAuto.reason.some(r => r.includes("override:auto")),
		`reason has override:auto=${routeAuto.reason.some(r => r.includes("override:auto"))}`);
	record("auto: mode is selected",
		routeAuto.mode !== null,
		`mode=${routeAuto.mode}`);

	// ─── 3. auto + 高置信度经验推荐 → 覆盖 ───
	console.log("\n--- 3. override_mode=auto + high-confidence experience → override ---\n");

	const highConfRec: ModeRecommendation = {
		mode: "M4",
		confidence: 0.85,
		sampleCount: 10,
		avgCost: 0.002,
		avgLatencyMs: 30000,
		successRate: 0.9,
		reason: "M4: 10 samples, 90% success",
	};

	const routeAutoWithExp = route({
		stage, pref: DEFAULT_PREFERENCE, preset,
		taskRoutingSignal: signal,
		overrideMode: "auto",
		experienceRecommendation: highConfRec,
	});

	record("auto+exp: mode is M4 (experience override)",
		routeAutoWithExp.mode === "M4",
		`mode=${routeAutoWithExp.mode} (experience recommended M4)`);
	record("auto+exp: reason mentions experience [AUTO-APPLIED]",
		routeAutoWithExp.reason.some(r => r.includes("experience:M4") && r.includes("[AUTO-APPLIED]")),
		`reason has experience AUTO-APPLIED=${routeAutoWithExp.reason.some(r => r.includes("[AUTO-APPLIED]"))}`);
	record("auto+exp: applied is true",
		routeAutoWithExp.applied === true,
		`applied=${routeAutoWithExp.applied}`);

	// ─── 4. auto + 低置信度经验推荐 → 不覆盖 ───
	console.log("\n--- 4. override_mode=auto + low-confidence experience → no override ---\n");

	const lowConfRec: ModeRecommendation = {
		mode: "M1",
		confidence: 0.45,  // < 0.7 threshold
		sampleCount: 2,
		avgCost: 0.0001,
		avgLatencyMs: 5000,
		successRate: 0.5,
		reason: "M1: 2 samples, 50% success",
	};

	const routeAutoLowExp = route({
		stage, pref: DEFAULT_PREFERENCE, preset,
		taskRoutingSignal: signal,
		overrideMode: "auto",
		experienceRecommendation: lowConfRec,
	});

	record("auto+low-exp: mode is NOT M1 (low confidence, no override)",
		routeAutoLowExp.mode !== "M1" || routeAutoLowExp.mode === signal.recommendedMode,
		`mode=${routeAutoLowExp.mode} (low confidence experience did not override)`);
	record("auto+low-exp: reason mentions experience but NOT [AUTO-APPLIED]",
		routeAutoLowExp.reason.some(r => r.includes("experience:M1")) &&
		!routeAutoLowExp.reason.some(r => r.includes("[AUTO-APPLIED]")),
		`reason has experience without AUTO-APPLIED`);

	// ─── 5. suggest + 经验推荐 → 加权候选但不覆盖 ───
	console.log("\n--- 5. override_mode=suggest + experience → weighted candidate ---\n");

	const routeSuggestWithExp = route({
		stage, pref: DEFAULT_PREFERENCE, preset,
		taskRoutingSignal: signal,
		overrideMode: "suggest",
		experienceRecommendation: highConfRec,
	});

	record("suggest+exp: applied is false",
		routeSuggestWithExp.applied === false || routeSuggestWithExp.applied === undefined,
		`applied=${routeSuggestWithExp.applied}`);
	record("suggest+exp: reason mentions experience",
		routeSuggestWithExp.reason.some(r => r.includes("experience:M4")),
		`reason has experience=${routeSuggestWithExp.reason.some(r => r.includes("experience:M4"))}`);
	record("suggest+exp: NOT auto-applied",
		!routeSuggestWithExp.reason.some(r => r.includes("[AUTO-APPLIED]")),
		`no AUTO-APPLIED tag`);

	// ─── 6. manual 模式 ───
	console.log("\n--- 6. override_mode=manual ---\n");

	const routeManual = route({ stage, pref: DEFAULT_PREFERENCE, preset, overrideMode: "manual" });
	record("manual: applied is false",
		routeManual.applied === false || routeManual.applied === undefined,
		`applied=${routeManual.applied}`);
	record("manual: has reason with override:manual",
		routeManual.reason.some(r => r.includes("override:manual")),
		`reason has override:manual=${routeManual.reason.some(r => r.includes("override:manual"))}`);

	// ─── 7. 对比: 有/无 taskRoutingSignal 的路由差异 ───
	console.log("\n--- 7. routing with vs without taskRoutingSignal ---\n");

	const routeNoSignal = route({ stage, pref: DEFAULT_PREFERENCE, preset });
	const routeWithSignal = route({ stage, pref: DEFAULT_PREFERENCE, preset, taskRoutingSignal: signal });

	record("with-signal: confidence > without-signal",
		routeWithSignal.confidence > routeNoSignal.confidence,
		`with=${routeWithSignal.confidence.toFixed(2)} > without=${routeNoSignal.confidence.toFixed(2)}`);
	record("with-signal: reason mentions taskRoutingSignal",
		routeWithSignal.reason.some(r => r.includes("taskRoutingSignal")),
		`has taskRoutingSignal in reason`);

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
