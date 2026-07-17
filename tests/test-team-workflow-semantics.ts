/**
 * Team review 严格解析与执行失败合并的确定性回归测试。
 * 不启动 subagent；SharedBoard 仅使用系统临时目录。
 */

import {
	buildReviewTask,
	createIndeterminateTeamReview,
	mergeImplementerExecutionFailures,
	parseReviewOutput,
	type TeamTask,
} from "../src/extension/team-workflow";
import type { ParallelRunResult, SubagentRunResult } from "../src/extension/subagent";
import { SharedBoard } from "../src/core/shared-board";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function subagentResult(agent: string, overrides: Partial<SubagentRunResult> = {}): SubagentRunResult {
	return {
		agent,
		exitCode: 0,
		output: `${agent} completed`,
		usage: { turns: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.002, contextTokens: 15 },
		model: "test-model",
		...overrides,
	};
}

function parallel(resultsForAgents: SubagentRunResult[]): ParallelRunResult {
	return {
		results: resultsForAgents,
		wallClockMs: 10,
		sumIndividualMs: 15,
		speedupRatio: 1.5,
		totalCost: resultsForAgents.reduce((sum, result) => sum + result.usage.cost, 0),
		allSucceeded: resultsForAgents.every(result => result.exitCode === 0 && !result.errorMessage),
		errors: resultsForAgents.filter(result => result.exitCode !== 0 || result.errorMessage)
			.map(result => result.errorMessage ?? `${result.agent} exit ${result.exitCode}`),
	};
}

function reviewerJson(tasks: TeamTask[], passedByLabel: Record<string, boolean>): string {
	const agents = Object.fromEntries(tasks.map(task => {
		const passed = passedByLabel[task.label];
		return [task.label, {
			passed,
			issues: passed ? [] : ["specific issue"],
			suggestions: passed ? [] : ["specific fix"],
		}];
	}));
	const passedCount = Object.values(passedByLabel).filter(Boolean).length;
	return JSON.stringify({
		agents,
		overall: `${passedCount} of ${tasks.length} agents passed`,
		passedCount,
		totalCount: tasks.length,
	});
}

async function main() {
	const tempRoot = mkdtempSync(join(tmpdir(), "agentflux-team-test-"));
	const tasks: TeamTask[] = [
		{ agent: "implementer", label: "frontend", task: "Implement src/frontend.ts" },
		{ agent: "implementer", label: "backend", task: "Implement src/backend.ts" },
	];

	try {
		const impl = parallel([
			subagentResult("implementer", { output: "frontend real output" }),
			subagentResult("implementer", { exitCode: 2, output: "", errorMessage: "compile failed" }),
		]);

		const reviewTask = buildReviewTask(tasks, impl, 0);
		record("review prompt uses real SubagentRunResult output",
			reviewTask.includes("frontend real output") && reviewTask.includes("**Status:** OK"),
			"real output and OK status are present");
		record("review prompt exposes implementer execution failure",
			reviewTask.includes("compile failed") && reviewTask.includes("**Status:** FAILED"),
			"failure reason and FAILED status are present");
		record("review prompt requests exact labels with valid JSON example",
			reviewTask.includes("exactly these labels") && reviewTask.includes('"frontend"') && !reviewTask.includes("// ..."),
			"strict labels requested, no JSON comments");

		const valid = parseReviewOutput(reviewerJson(tasks, { frontend: true, backend: false }), tasks);
		record("valid complete reviewer JSON is accepted",
			valid.status === "failed" && valid.passedCount === 1 && valid.agents.frontend.passed && !valid.agents.backend.passed,
			`status=${valid.status}, passed=${valid.passedCount}`);

		const missingLabelPayload = JSON.parse(reviewerJson(tasks, { frontend: true, backend: true }));
		delete missingLabelPayload.agents.backend;
		missingLabelPayload.passedCount = 1;
		const missingLabel = parseReviewOutput(JSON.stringify(missingLabelPayload), tasks);
		record("missing reviewer label is indeterminate",
			missingLabel.status === "indeterminate" && !missingLabel.agents.frontend.passed,
			`status=${missingLabel.status}`);

		const extraLabelPayload = JSON.parse(reviewerJson(tasks, { frontend: true, backend: true }));
		extraLabelPayload.agents.unexpected = { passed: true, issues: [], suggestions: [] };
		const extraLabel = parseReviewOutput(JSON.stringify(extraLabelPayload), tasks);
		record("extra reviewer label is indeterminate",
			extraLabel.status === "indeterminate",
			`status=${extraLabel.status}`);

		const malformedPayload = JSON.parse(reviewerJson(tasks, { frontend: true, backend: false }));
		malformedPayload.agents.backend.issues = "not-an-array";
		const malformed = parseReviewOutput(JSON.stringify(malformedPayload), tasks);
		record("malformed per-agent schema is indeterminate",
			malformed.status === "indeterminate",
			`status=${malformed.status}`);

		const inconsistentCountPayload = JSON.parse(reviewerJson(tasks, { frontend: true, backend: true }));
		inconsistentCountPayload.passedCount = 0;
		const inconsistentCount = parseReviewOutput(JSON.stringify(inconsistentCountPayload), tasks);
		record("inconsistent reviewer counts are indeterminate",
			inconsistentCount.status === "indeterminate",
			`status=${inconsistentCount.status}`);

		const reviewerPassesEverything = parseReviewOutput(reviewerJson(tasks, { frontend: true, backend: true }), tasks);
		const merged = mergeImplementerExecutionFailures(reviewerPassesEverything, tasks, impl);
		record("implementer failure overrides reviewer pass",
			merged.status === "failed" && !merged.agents.backend.passed && merged.agents.backend.status === "failed"
				&& merged.agents.backend.issues.some(issue => issue.includes("compile failed")),
			`status=${merged.status}, backend=${merged.agents.backend.status}`);

		const missingResult = mergeImplementerExecutionFailures(
			reviewerPassesEverything,
			tasks,
			parallel([subagentResult("implementer")]),
		);
		record("missing implementer result is a hard failure",
			missingResult.status === "failed" && missingResult.agents.backend.issues.some(issue => issue.includes("missing")),
			`status=${missingResult.status}`);

		const unavailable = createIndeterminateTeamReview(tasks, "", "reviewer unavailable");
		record("reviewer unavailable marks every task indeterminate",
			unavailable.status === "indeterminate"
				&& Object.values(unavailable.agents).every(review => review.status === "indeterminate" && !review.passed),
			`status=${unavailable.status}`);

		// 验证 workflow 应使用 createGroup() 返回的真实 ID；所有文件都在 tempRoot 下。
		const board = new SharedBoard(join(tempRoot, ".agentflux"));
		const group = board.createGroup("Test Team", ["reviewer", "frontend"], "team", "reviewer");
		board.sendGroupMessage("reviewer", group.id, "review result");
		record("SharedBoard returned group ID is immediately usable",
			board.getGroupMessages(group.id).length === 1,
			`groupId=${group.id}`);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}

	const failed = results.filter(result => !result.passed);
	console.log(`\nTeam workflow tests: ${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
