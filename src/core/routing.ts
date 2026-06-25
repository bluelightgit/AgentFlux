/**
 * AgentFlux Core — 路由 (Phase 1 规则 + Phase 2 静态分析信号)
 * 文档依据: docs/05-routing, 13-routing-preference, 14-project-evolution, 08-references RGAO
 *
 * 三层路由 (Phase 1+2):
 *   层1 静态: 任务复杂度信号 (RGAO 复杂度向量) → 推荐 mode
 *   偏好层: 项目成熟度 baseline + 用户偏好向量偏置
 *   层2/3 (Phase 3): ILP budget + RL experience (未实现)
 *
 * route() 综合: taskSignal (如果有) + maturity baseline + preference expected
 */

import {
	MODES,
	type Mode, type ProjectStage, type PreferenceConfig, type RoutingDecision, type Preset,
} from "./types";
import { presetToExpectedMode } from "./config";
import type { TaskComplexitySignal } from "./complexity";

/** 项目成熟度 → baseline mode (docs/14) */
export function maturityBaselineMode(stage: ProjectStage): Mode {
	switch (stage) {
		case "Seed": return "M1";
		case "Growth": return "M2";
		case "Established": return "M2"; // delegate_impl=true, 但基线仍 M2 (主+sub)
		case "Mature": return "M4";
	}
}

/** 偏好向量打分: 给候选 mode 打分, 越高越优 (docs/13) */
function scoreMode(mode: Mode, pref: PreferenceConfig): number {
	const v = pref.vector;
	const m = MODES[mode];
	let score = 0;
	// 成本敏感: 单 context / 共享前缀的 mode 更省
	const costWeight = { M1: 1.0, M2: 0.7, M3: 0.6, M4: 0.3, M5: 0.5, M6: 0.2 };
	score += (1 - v.cost_sensitivity) * 0 + v.cost_sensitivity * costWeight[mode];
	// 准确性: 多视角/review 的 mode 更准
	const accWeight = { M1: 0.4, M2: 0.6, M3: 0.7, M4: 0.8, M5: 0.6, M6: 0.95 };
	score += v.accuracy_priority * accWeight[mode];
	// 延迟: 并行/fork 的 mode 更快
	const latWeight = { M1: 0.5, M2: 0.6, M3: 0.8, M4: 0.9, M5: 0.7, M6: 0.85 };
	score += v.latency_priority * latWeight[mode];
	// 并行意愿
	const parWeight = { M1: 0.2, M2: 0.5, M3: 0.4, M4: 1.0, M5: 0.6, M6: 1.0 };
	score += v.parallelism_willingness * parWeight[mode];
	// 多 agent 意愿
	const maWeight = { M1: 0.1, M2: 0.4, M3: 0.2, M4: 1.0, M5: 0.5, M6: 1.0 };
	score += v.multi_agent_willingness * maWeight[mode];
	return score;
}

export interface RouteInput {
	stage: ProjectStage;
	pref: PreferenceConfig;
	preset: Preset;
	/** Phase 2: 任务复杂度信号 (RGAO 静态分析). undefined 时只用偏好+成熟度 */
	taskSignal?: TaskComplexitySignal;
	/** 显式指定的模式信号 (兼容旧接口, taskSignal 优先) */
	taskSignalMode?: Mode;
}

/** Phase 1+2 路由主入口 */
export function route(input: RouteInput): RoutingDecision {
	const baseline = maturityBaselineMode(input.stage);
	const prefExpected = presetToExpectedMode(input.preset);

	// 候选集: baseline + prefExpected + 邻近 mode
	const candidates = new Set<Mode>([baseline, prefExpected, "M1", "M2"]);
	if (input.stage !== "Seed") candidates.add("M3");
	if (input.pref.vector.multi_agent_willingness > 0.6) { candidates.add("M4"); candidates.add("M6"); }
	// Phase 2: 如果有 taskSignal, 把它的推荐 mode 也加入候选
	if (input.taskSignal) candidates.add(input.taskSignal.recommendedMode);

	// 打分选最优
	let best: Mode = baseline;
	let bestScore = -Infinity;
	for (const m of candidates) {
		let s = scoreMode(m, input.pref);
		// Phase 2: taskSignal 推荐的模式额外加权 (置信度越高加权越大)
		if (input.taskSignal && m === input.taskSignal.recommendedMode) {
			const signalBoost = 0.3 + input.taskSignal.complexityTier * 0.1; // tier 越高, 信号越强
			s += signalBoost;
		}
		if (s > bestScore) { bestScore = s; best = m; }
	}

	const reason: string[] = [];
	reason.push(`stage:${input.stage}→baseline:${baseline}`);
	reason.push(`pref:${input.preset}→expected:${prefExpected}`);
	if (input.taskSignal) {
		reason.push(`taskSignal:tier${input.taskSignal.complexityTier}→${input.taskSignal.recommendedMode} (${input.taskSignal.reason.join("; ")})`);
	} else if (input.taskSignalMode) {
		reason.push(`taskSignal:${input.taskSignalMode}`);
	}
	reason.push(`score:best=${best}(${bestScore.toFixed(2)})`);

	const expected = modeExpectedTiers(best);

	// 置信度: 有 taskSignal 时提升
	const confidence = input.taskSignal
		? Math.min(0.85, 0.6 + input.taskSignal.complexityTier * 0.08)
		: 0.6;

	return {
		mode: best,
		fallback: baseline,
		reason,
		confidence,
		expected,
		biasSources: { maturity: baseline, preference: prefExpected, taskSignal: input.taskSignal?.recommendedMode ?? input.taskSignalMode },
	};
}

function modeExpectedTiers(mode: Mode): RoutingDecision["expected"] {
	const map: Record<Mode, RoutingDecision["expected"]> = {
		M1: { cost: "low", latency: "low", accuracy: "low" },
		M2: { cost: "med", latency: "med", accuracy: "med" },
		M3: { cost: "med", latency: "low", accuracy: "high" },
		M4: { cost: "high", latency: "med", accuracy: "high" },
		M5: { cost: "med", latency: "med", accuracy: "med" },
		M6: { cost: "high", latency: "high", accuracy: "high" },
	};
	return map[mode];
}
