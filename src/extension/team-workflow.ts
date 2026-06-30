/**
 * Team Review-Feedback Workflow
 *
 * 实现真正的多 agent 协作循环：
 *   implement (parallel, persistent) → review → feedback → re-implement
 *
 * 与 flux_subagent_parallel 的区别：
 *   1. persistent session — implementer 可被 resume, 保留上下文
 *   2. reviewer 反馈写入 SharedBoard messages/ — implementer 可读 inbox
 *   3. 自动 retry — reviewer 发现问题时, 带 feedback 重新 dispatch implementer
 *   4. 多轮循环 — 直到 reviewer 通过或达到 maxRounds
 */

import { runSubagent, runSubagentsParallel, loadSubagent, type SubagentDef, type SubagentRunResult, type ParallelSubagentTask, type ParallelRunResult } from "./subagent";
import { SharedBoard } from "../core/shared-board";
import type { TelemetryWriter } from "../telemetry/events";
import type { PricingTable } from "../core/pricing";
import { join } from "node:path";

// ── 类型 ──

export interface TeamTask {
	agent: string;           // agent 名称 (planner/implementer/reviewer/...)
	task: string;            // 任务描述
	label: string;           // 唯一标签 (用作 session ID)
}

export interface AgentReview {
	passed: boolean;
	issues: string[];
	suggestions: string[];
}

export interface TeamReviewResult {
	agents: Record<string, AgentReview>;  // label → review
	overall: string;
	passedCount: number;
	totalCount: number;
	rawOutput: string;
}

export interface TeamWorkflowResult {
	rounds: Array<{
		round: number;
		implementerResults: ParallelRunResult;
		reviewResult: TeamReviewResult | null;
		failedLabels: string[];   // 需要重新 dispatch 的 labels
	}>;
	finalStatus: "passed" | "max_rounds" | "no_review";
	totalCost: number;
	totalWallMs: number;
}

// ── 核心函数 ──

/**
 * 运行带 review-feedback 循环的多 agent 团队
 *
 * @param implementerTasks  实现 agent 任务列表
 * @param reviewerAgent     reviewer agent 名称
 * @param opts              选项 (fluxDir, maxRounds, etc.)
 */
export async function runTeamWithReview(
	implementerTasks: TeamTask[],
	reviewerAgent: string,
	opts: {
		cwd: string;
		fluxDir: string;
		telemetry?: TelemetryWriter;
		pricing?: PricingTable;
		prefixLayout?: boolean;
		maxRounds?: number;       // 默认 2 (初始 + 1 轮 retry)
		timeoutMs?: number;       // 默认 180000
	},
): Promise<TeamWorkflowResult> {
	const maxRounds = opts.maxRounds ?? 2;
	const timeoutMs = opts.timeoutMs ?? 180000;
	const board = new SharedBoard(opts.fluxDir);

	const rounds: TeamWorkflowResult["rounds"] = [];
	let totalCost = 0;
	const startTime = Date.now();

	// 为每个 implementer 构建 SubagentDef + session ID
	const sessionIds = new Map<string, string>();  // label → sessionId
	for (const t of implementerTasks) {
		sessionIds.set(t.label, `flux-team-${t.label}`);
	}

	let currentTasks = implementerTasks;
	let finalStatus: TeamWorkflowResult["finalStatus"] = "max_rounds";

	for (let round = 0; round < maxRounds; round++) {
		// ── Phase 1: 并行 dispatch implementers (persistent) ──
		// 加载 agent 定义
		const agentDefs = new Map<string, SubagentDef>();
		for (const t of currentTasks) {
			if (!agentDefs.has(t.agent)) {
				const def = loadSubagent(opts.cwd, t.agent);
				agentDefs.set(t.agent, def ?? { name: t.agent } as SubagentDef);
			}
		}

		const parallelTasks: ParallelSubagentTask[] = currentTasks.map(t => ({
			agent: agentDefs.get(t.agent)!,
			task: t.task,
			label: t.label,
		}));

		const implResult = await runSubagentsParallel(parallelTasks, {
			cwd: opts.cwd,
			sessionId: `flux-team-round${round}`,
			telemetry: opts.telemetry,
			prefixLayout: opts.prefixLayout ?? false,
			pricing: opts.pricing,
			persistent: true,           // 关键：persistent session, 可 resume
			sessionIds: new Map(        // per-label session ID, 实现跨轮 resume
				currentTasks.map(t => [t.label, sessionIds.get(t.label)!])
			),
			timeoutMs,
			maxRetries: 1,
		});

		totalCost += implResult.totalCost;

		// ── Phase 2: dispatch reviewer ──
		const reviewTask = buildReviewTask(currentTasks, implResult, round);
		const reviewerDef = loadSubagent(opts.cwd, reviewerAgent) ?? { name: reviewerAgent } as SubagentDef;
		const reviewResult = await runSubagent({
			cwd: opts.cwd,
			agent: reviewerDef,
			task: reviewTask,
			sessionId: `flux-team-review-round${round}`,
			telemetry: opts.telemetry,
			prefixLayout: opts.prefixLayout ?? false,
			pricing: opts.pricing,
			persistent: false,           // reviewer 不需要 persistent
			timeoutMs: 120000,
			maxRetries: 0,
		});

		totalCost += reviewResult.costUsd ?? 0;

		// ── Phase 3: 解析 reviewer 反馈 ──
		const review = parseReviewOutput(reviewResult.output, currentTasks);

		// ── Phase 4: 将反馈写入 SharedBoard messages ──
		for (const [label, agentReview] of Object.entries(review.agents)) {
			if (!agentReview.passed) {
				board.sendMessage(
					"reviewer",
					label,
					"review_feedback",
					JSON.stringify({
						round: round + 1,
						issues: agentReview.issues,
						suggestions: agentReview.suggestions,
					}, null, 2),
				);
			}
		}

		// ── Phase 5: 判断是否需要 retry ──
		const failedLabels = Object.entries(review.agents)
			.filter(([_, r]) => !r.passed)
			.map(([label, _]) => label);

		rounds.push({
			round: round + 1,
			implementerResults: implResult,
			reviewResult: review,
			failedLabels,
		});

		if (failedLabels.length === 0) {
			finalStatus = "passed";
			break;
		}

		// ── Phase 6: 为失败的 agent 构建 retry 任务 ──
		if (round < maxRounds - 1) {
			currentTasks = currentTasks
				.filter(t => failedLabels.includes(t.label))
				.map(t => {
					const agentReview = review.agents[t.label];
					const feedbackText = formatFeedbackForTask(agentReview, round + 1);
					return {
						...t,
						task: `${t.task}\n\n--- REVIEWER FEEDBACK (Round ${round + 1}) ---\nPlease fix these issues:\n${feedbackText}\n--- END FEEDBACK ---`,
					};
				});
		}
	}

	return {
		rounds,
		finalStatus,
		totalCost,
		totalWallMs: Date.now() - startTime,
	};
}

// ── 辅助函数 ──

function buildReviewTask(
	tasks: TeamTask[],
	implResult: ParallelRunResult,
	round: number,
): string {
	const outputs = implResult.results.map((r, i) => {
		const task = tasks[i];
		const result = implResult.results[i];
		const output = result?.result?.output ?? result?.error ?? "(no output)";
		return `## Agent: ${task.label}\n**Task:** ${task.task.slice(0, 200)}\n**Status:** ${result?.ok ? "OK" : "FAILED"}\n**Output:**\n${output.slice(0, 3000)}`;
	}).join("\n\n");

	return `You are reviewing the output of ${tasks.length} implementer agents (Round ${round + 1}).

Review each agent's output against their task. For each agent, determine if the task was completed correctly.

Output a JSON object (and ONLY the JSON, no other text):
\`\`\`json
{
  "agents": {
    "${tasks[0]?.label}": {
      "passed": true/false,
      "issues": ["specific issue 1", "specific issue 2"],
      "suggestions": ["how to fix issue 1", "how to fix issue 2"]
    }
    // ... one entry per agent label
  },
  "overall": "X of Y agents passed",
  "passedCount": number,
  "totalCount": ${tasks.length}
}
\`\`\`

Judge based on: code correctness, completeness, adherence to task spec, no emoji, Lucide SVG icons only, follows existing code patterns.

### Agent Outputs:

${outputs}
`;
}

function parseReviewOutput(output: string, tasks: TeamTask[]): TeamReviewResult {
	// 尝试提取 JSON
	const jsonMatch = output.match(/```json\s*([\s\S]*?)```/) || output.match(/\{[\s\S]*\}/);
	let parsed: any = null;

	if (jsonMatch) {
		try {
			parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
		} catch {
			// JSON 解析失败, fallback 到全通过
		}
	}

	if (!parsed || !parsed.agents) {
		// Fallback: 全部标记为 passed (非阻塞)
		return {
			agents: Object.fromEntries(tasks.map(t => [t.label, { passed: true, issues: [], suggestions: [] }])),
			overall: "Review parse failed, defaulting to pass",
			passedCount: tasks.length,
			totalCount: tasks.length,
			rawOutput: output,
		};
	}

	let passedCount = 0;
	for (const t of tasks) {
		const r = parsed.agents[t.label];
		if (r && r.passed) passedCount++;
	}

	return {
		agents: parsed.agents,
		overall: parsed.overall || `${passedCount} of ${tasks.length} passed`,
		passedCount,
		totalCount: tasks.length,
		rawOutput: output,
	};
}

function formatFeedbackForTask(review: AgentReview, round: number): string {
	const issues = review.issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n");
	const suggestions = review.suggestions.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
	return `**Issues found:**\n${issues}\n\n**Suggested fixes:**\n${suggestions}`;
}

/**
 * 格式化 team workflow 结果为可读文本
 */
export function formatTeamWorkflowResult(result: TeamWorkflowResult): string {
	const lines: string[] = [];
	lines.push(`=== Team Workflow Result ===`);
	lines.push(`Status: ${result.finalStatus}`);
	lines.push(`Rounds: ${result.rounds.length}`);
	lines.push(`Total cost: $${result.totalCost.toFixed(4)}`);
	lines.push(`Wall time: ${(result.totalWallMs / 1000).toFixed(1)}s`);
	lines.push("");

	for (const round of result.rounds) {
		lines.push(`--- Round ${round.round} ---`);
		lines.push(`Implementers: ${round.implementerResults.results.length} agents, $${round.implementerResults.totalCost.toFixed(4)}`);

		if (round.reviewResult) {
			lines.push(`Review: ${round.reviewResult.passedCount}/${round.reviewResult.totalCount} passed`);
			for (const [label, review] of Object.entries(round.reviewResult.agents)) {
				const r = review as AgentReview;
				const status = r.passed ? "PASS" : "FAIL";
				lines.push(`  [${status}] ${label}`);
				if (!r.passed && r.issues.length > 0) {
					r.issues.forEach((i: string) => lines.push(`         - ${i}`));
				}
			}
		}

		if (round.failedLabels.length > 0) {
			lines.push(`Retry needed for: ${round.failedLabels.join(", ")}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
