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

import { runSubagent, runSubagentsParallel, loadSubagent, withSharedSkills, type SubagentDef, type SubagentRunResult, type ParallelSubagentTask, type ParallelRunResult } from "./subagent";
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
	status: TeamReviewStatus;
	passed: boolean;
	issues: string[];
	suggestions: string[];
}

export type TeamReviewStatus = "passed" | "failed" | "indeterminate";

export interface TeamReviewResult {
	status: TeamReviewStatus;
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
	finalStatus: "passed" | "max_rounds" | "no_review" | "indeterminate" | "cancelled" | "budget_exceeded";
	totalCost: number;
	totalWallMs: number;
}

// ── 核心函数 ──

// ── 文件路径自动提取 (用于文件锁) ──

/** 从 task 文本中提取文件路径 */
function extractFilePaths(task: string): string[] {
	const matches = task.match(/[\w/.-]+\.(?:tsx?|jsx?|json|md|css|html)/g) ?? [];
	return [...new Set(matches.filter(p => p.includes('/')))];
}

/** 为并行任务分配文件锁, 检测冲突 */
function buildLockAssignments(tasks: { task: string; label: string }[]): Record<string, string[]> {
	const fileOwner: Record<string, string> = {};
	const lockMap: Record<string, string[]> = {};
	for (const t of tasks) {
		const files = extractFilePaths(t.task);
		for (const fp of files) {
			if (!fileOwner[fp]) {
				fileOwner[fp] = t.label;
			} else if (fileOwner[fp] !== t.label) {
				console.error(`[team-workflow] file conflict: ${fp} wanted by ${t.label}, already owned by ${fileOwner[fp]}`);
			}
		}
		// 冲突任务仍必须请求同一把锁；否则第二个任务会因“未分配锁”继续写入。
		if (files.length > 0) lockMap[t.label] = files;
	}
	return lockMap;
}

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
		signal?: AbortSignal;
		maxCostUsd?: number;
		sharedSkills?: string[];
	},
): Promise<TeamWorkflowResult> {
	const maxRounds = opts.maxRounds ?? 2;
	const timeoutMs = opts.timeoutMs ?? 180000;
	const board = new SharedBoard(opts.fluxDir);
	if (implementerTasks.length === 0) throw new Error("Team workflow requires at least one implementer task");
	if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error("Team workflow maxRounds must be a positive integer");
	const labels = implementerTasks.map(t => t.label);
	if (new Set(labels).size !== labels.length) throw new Error("Team workflow task labels must be unique");

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
		if (opts.signal?.aborted) { finalStatus = "cancelled"; break; }
		if (opts.maxCostUsd !== undefined && totalCost >= opts.maxCostUsd) { finalStatus = "budget_exceeded"; break; }
		// ── Phase 1: 并行 dispatch implementers (persistent) ──
		// 加载 agent 定义
		const agentDefs = new Map<string, SubagentDef>();
		for (const t of currentTasks) {
			if (!agentDefs.has(t.agent)) {
				const loaded = loadSubagent(opts.cwd, t.agent);
				const def = loaded ? withSharedSkills(loaded, opts.sharedSkills) : null;
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
			maxRetries: 2,   // 502/timeout 自动重试
			lockFiles: buildLockAssignments(currentTasks.map(t => ({ task: t.task, label: t.label }))),
			signal: opts.signal,
			maxCostUsd: opts.maxCostUsd === undefined ? undefined : Math.max(0, opts.maxCostUsd - totalCost),
		});

		totalCost += implResult.totalCost;
		if (opts.signal?.aborted) {
			rounds.push({ round: round + 1, implementerResults: implResult, reviewResult: null, failedLabels: currentTasks.map(task => task.label) });
			finalStatus = "cancelled";
			break;
		}
		if (opts.maxCostUsd !== undefined && totalCost >= opts.maxCostUsd) {
			rounds.push({ round: round + 1, implementerResults: implResult, reviewResult: null, failedLabels: currentTasks.map(task => task.label) });
			finalStatus = "budget_exceeded";
			break;
		}

		// ── Phase 2/3: dispatch reviewer + 严格解析反馈 ──
		const reviewTask = buildReviewTask(currentTasks, implResult, round);
		const loadedReviewer = loadSubagent(opts.cwd, reviewerAgent);
		const reviewerDef = loadedReviewer ? withSharedSkills(loadedReviewer, opts.sharedSkills) : null;
		let reviewerRun: SubagentRunResult | null = null;
		let review: TeamReviewResult;

		if (!reviewerDef) {
			review = createIndeterminateTeamReview(currentTasks, "", `Reviewer '${reviewerAgent}' is not available`);
		} else {
			try {
				reviewerRun = await runSubagent({
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
					signal: opts.signal,
					maxCostUsd: opts.maxCostUsd === undefined ? undefined : Math.max(0, opts.maxCostUsd - totalCost),
				});
				totalCost += reviewerRun.usage.cost;

				if (reviewerRun.exitCode !== 0 || reviewerRun.errorMessage || !reviewerRun.output.trim()) {
					const reason = reviewerRun.errorMessage
						?? (reviewerRun.exitCode !== 0 ? `Reviewer exited with code ${reviewerRun.exitCode}` : "Reviewer returned empty output");
					review = createIndeterminateTeamReview(currentTasks, reviewerRun.output, reason);
				} else {
					review = parseReviewOutput(reviewerRun.output, currentTasks);
				}
			} catch (e: any) {
				review = createIndeterminateTeamReview(currentTasks, "", `Reviewer execution failed: ${e?.message ?? e}`);
			}
		}

		// implementer 进程失败是硬失败，不能被 reviewer 的 passed=true 覆盖。
		review = mergeImplementerExecutionFailures(review, currentTasks, implResult);

		// ── Phase 4: 将反馈写入群组 + DM ──
		// 创建团队群组 (如果不存在)
		let teamGroupId: string | null = null;
		const allMembers = [...currentTasks.map(t => t.label), reviewerAgent];
		try {
			const group = board.createGroup(`Team Round ${round + 1}`, allMembers, "team", reviewerAgent, "实现→审查反馈循环");
			teamGroupId = group.id;
			// reviewer 发送总体反馈到群组 (所有 agent 可见)
			board.sendGroupMessage(reviewerAgent, teamGroupId, `Round ${round + 1} review [${review.status}]: ${review.passedCount}/${review.totalCount} passed. ${review.overall}`);
		} catch { /* 群组消息失败不改变 review verdict */ }

		for (const [label, agentReview] of Object.entries(review.agents)) {
			if (!agentReview.passed) {
				// 群组消息: 具体反馈 (所有 agent 可见, 透明)
				try {
					if (teamGroupId) board.sendGroupMessage(reviewerAgent, teamGroupId,
						`@${label}: ${agentReview.issues.length} issues found. ${agentReview.suggestions.slice(0, 2).join(" ")}`);
				} catch {}
				// DM: 完整反馈 (只有该 agent 看)
				board.sendMessage(
					reviewerAgent,
					label,
					"review_feedback",
					JSON.stringify({ round: round + 1, status: agentReview.status, issues: agentReview.issues, suggestions: agentReview.suggestions }, null, 2),
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

		if (review.status === "indeterminate") {
			finalStatus = "indeterminate";
			break;
		}

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

export function buildReviewTask(
	tasks: TeamTask[],
	implResult: ParallelRunResult,
	round: number,
): string {
	const outputs = tasks.map((task, i) => {
		const result = implResult.results[i];
		const succeeded = !!result && result.exitCode === 0 && !result.errorMessage;
		const output = result?.output || "(no output)";
		const error = result?.errorMessage ? `\n**Execution error:** ${result.errorMessage.slice(0, 500)}` : "";
		return `## Agent: ${task.label}\n**Task:** ${task.task.slice(0, 200)}\n**Status:** ${succeeded ? "OK" : "FAILED"}${error}\n**Output:**\n${output.slice(0, 3000)}`;
	}).join("\n\n");
	const responseExample = JSON.stringify({
		agents: Object.fromEntries(tasks.map(t => [t.label, {
			passed: false,
			issues: ["specific issue"],
			suggestions: ["specific fix"],
		}])),
		overall: `0 of ${tasks.length} agents passed`,
		passedCount: 0,
		totalCount: tasks.length,
	}, null, 2);

	return `You are reviewing the output of ${tasks.length} implementer agents (Round ${round + 1}).

Review each agent's output against their task. For each agent, determine if the task was completed correctly.

Output a JSON object (and ONLY the JSON, no other text). The agents object MUST contain exactly these labels and no others: ${tasks.map(t => t.label).join(", ")}.
\`\`\`json
${responseExample}
\`\`\`

Judge based on: code correctness, completeness, adherence to task spec, no emoji, Lucide SVG icons only, follows existing code patterns.

### Agent Outputs:

${outputs}
`;
}

export function createIndeterminateTeamReview(
	tasks: TeamTask[],
	rawOutput: string,
	reason: string,
): TeamReviewResult {
	return {
		status: "indeterminate",
		agents: Object.fromEntries(tasks.map(t => [t.label, {
			status: "indeterminate" as const,
			passed: false,
			issues: [reason],
			suggestions: [],
		}])),
		overall: reason,
		passedCount: 0,
		totalCount: tasks.length,
		rawOutput,
	};
}

function implementerFailureReason(result: SubagentRunResult | undefined): string | null {
	if (!result) return "Implementer result is missing";
	if (result.errorMessage) return `Implementer execution failed: ${result.errorMessage}`;
	if (result.exitCode !== 0) return `Implementer exited with code ${result.exitCode}`;
	return null;
}

/** Reviewer 不能覆盖已知的 implementer 进程失败。 */
export function mergeImplementerExecutionFailures(
	review: TeamReviewResult,
	tasks: TeamTask[],
	implResult: ParallelRunResult,
): TeamReviewResult {
	const agents: Record<string, AgentReview> = { ...review.agents };
	const failedByExecution: string[] = [];

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		const reason = implementerFailureReason(implResult.results[i]);
		if (!reason) continue;
		failedByExecution.push(task.label);
		const existing = agents[task.label] ?? {
			status: "indeterminate" as const, passed: false, issues: [], suggestions: [],
		};
		agents[task.label] = {
			...existing,
			status: "failed",
			passed: false,
			issues: [reason, ...existing.issues.filter(issue => issue !== reason)],
		};
	}

	const passedCount = tasks.filter(t => agents[t.label]?.passed === true).length;
	const status: TeamReviewStatus = review.status === "indeterminate"
		? "indeterminate"
		: passedCount === tasks.length ? "passed" : "failed";
	return {
		...review,
		status,
		agents,
		passedCount,
		totalCount: tasks.length,
		overall: failedByExecution.length > 0
			? `Implementer execution failed for: ${failedByExecution.join(", ")}. ${review.overall}`
			: review.overall,
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

export function parseReviewOutput(output: string, tasks: TeamTask[]): TeamReviewResult {
	const jsonMatch = output.match(/```json\s*([\s\S]*?)```/) || output.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return createIndeterminateTeamReview(tasks, output, "Reviewer response did not contain JSON");

	let parsed: any;
	try {
		parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
	} catch (e: any) {
		return createIndeterminateTeamReview(tasks, output, `Reviewer returned invalid JSON: ${e?.message ?? e}`);
	}

	if (!parsed || typeof parsed !== "object" || !parsed.agents || typeof parsed.agents !== "object" || Array.isArray(parsed.agents)) {
		return createIndeterminateTeamReview(tasks, output, "Reviewer response does not match the required schema");
	}
	if (typeof parsed.overall !== "string" || !Number.isInteger(parsed.passedCount) || !Number.isInteger(parsed.totalCount)) {
		return createIndeterminateTeamReview(tasks, output, "Reviewer summary fields are missing or malformed");
	}

	const expectedLabels = tasks.map(t => t.label).sort();
	const actualLabels = Object.keys(parsed.agents).sort();
	if (new Set(expectedLabels).size !== expectedLabels.length || actualLabels.length !== expectedLabels.length
		|| actualLabels.some((label, i) => label !== expectedLabels[i])) {
		return createIndeterminateTeamReview(tasks, output,
			`Reviewer labels do not match expected labels: ${expectedLabels.join(", ")}`);
	}

	const agents: Record<string, AgentReview> = {};
	for (const task of tasks) {
		const raw = parsed.agents[task.label];
		if (!raw || typeof raw !== "object" || typeof raw.passed !== "boolean"
			|| !isStringArray(raw.issues) || !isStringArray(raw.suggestions)) {
			return createIndeterminateTeamReview(tasks, output, `Reviewer result for '${task.label}' is malformed`);
		}
		agents[task.label] = {
			status: raw.passed ? "passed" : "failed",
			passed: raw.passed,
			issues: raw.issues,
			suggestions: raw.suggestions,
		};
	}

	const passedCount = tasks.filter(t => agents[t.label].passed).length;
	if (parsed.totalCount !== tasks.length || parsed.passedCount !== passedCount) {
		return createIndeterminateTeamReview(tasks, output,
			`Reviewer counts are inconsistent: reported ${parsed.passedCount}/${parsed.totalCount}, actual ${passedCount}/${tasks.length}`);
	}

	return {
		status: passedCount === tasks.length ? "passed" : "failed",
		agents,
		overall: parsed.overall,
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
			lines.push(`Review [${round.reviewResult.status}]: ${round.reviewResult.passedCount}/${round.reviewResult.totalCount} passed`);
			for (const [label, review] of Object.entries(round.reviewResult.agents)) {
				const r = review as AgentReview;
				const status = r.status === "indeterminate" ? "INDETERMINATE" : r.passed ? "PASS" : "FAIL";
				lines.push(`  [${status}] ${label}`);
				if (!r.passed && r.issues.length > 0) {
					r.issues.forEach((i: string) => lines.push(`         - ${i}`));
				}
			}
		}

		if (round.failedLabels.length > 0 && round.reviewResult?.status !== "indeterminate") {
			lines.push(`Retry needed for: ${round.failedLabels.join(", ")}`);
		} else if (round.reviewResult?.status === "indeterminate") {
			lines.push("Reviewer unavailable or response invalid; workflow stopped without retrying.");
		}
		lines.push("");
	}

	return lines.join("\n");
}
