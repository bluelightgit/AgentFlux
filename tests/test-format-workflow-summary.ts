import {
	formatWorkflowSummary,
	type DAGExecutionResult,
	type TaskExecutionResult,
	type TaskNode,
} from "../src/workflows/dag-executor";

import { hasProductCopyViolation } from "./helpers/product-copy";

// ─── Helpers ───

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, passed: boolean, detail: string) => {
	checks.push([name, passed, detail]);
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
};

/** Build a minimal TaskNode for synthetic results. */
function makeNode(id: string, role = "implementer", title?: string): TaskNode {
	return {
		id,
		title: title ?? id,
		role,
		dependsOn: [],
		parallelizable: false,
		acceptanceCriteria: [],
		files: [],
	};
}

/** Build a synthetic DAGExecutionResult for testing formatWorkflowSummary. */
function makeResult(overrides: Partial<DAGExecutionResult> & {
	/** Passed-node ids (become completedNodes + taskResults entries). */
	passedNodes?: string[];
	/** Failed-node ids (become failedNodes + taskResults entries). */
	failedNodes?: string[];
	/** Role override per node id. */
	roles?: Record<string, string>;
}): DAGExecutionResult {
	const passed = overrides.passedNodes ?? [];
	const failed = overrides.failedNodes ?? [];
	const roles = overrides.roles ?? {};
	const taskResults = new Map<string, TaskExecutionResult>();

	for (const id of [...passed, ...failed]) {
		const isPassed = passed.includes(id);
		const node = makeNode(id, roles[id] ?? "implementer");
		taskResults.set(id, {
			node,
			subagentResult: {
				agent: `dag-${id}`,
				exitCode: isPassed ? 0 : 1,
				output: isPassed ? `${id} output` : "",
				usage: { turns: 1, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: isPassed ? 0.001 : 0.002, contextTokens: 150 },
				model: isPassed ? "gpt-4" : "gpt-4",
				errorMessage: isPassed ? undefined : `${id} error`,
			},
			gateResult: null,
			retryCount: isPassed ? 0 : 1,
			passed: isPassed,
		});
	}

	return {
		executionId: overrides.executionId ?? "test-exec-001",
		taskResults,
		allPassed: failed.length === 0,
		status: overrides.status ?? "passed",
		totalCost: overrides.totalCost ?? 0.005,
		wallClockMs: overrides.wallClockMs ?? 5000,
		completedNodes: passed,
		failedNodes: failed,
		artifactPaths: overrides.artifactPaths ?? {},
	};
}

/** Check that a string contains a given substring (case-sensitive). */
function contains(haystack: string, needle: string): boolean {
	return haystack.indexOf(needle) !== -1;
}

// ─────────────────────────────────────────────────────
//  1. All statuses render an English badge without icons
// ─────────────────────────────────────────────────────

(function testAllStatuses() {
	const statuses: Array<DAGExecutionResult["status"]> = [
		"passed", "failed", "cancelled", "budget_exceeded", "timed_out",
	];

	for (const status of statuses) {
		const r = makeResult({ status, passedNodes: ["t1"], executionId: `status-${status}` });
		const out = formatWorkflowSummary(r, "test-label");
		const plainText = !hasProductCopyViolation(out);
		const badgeOk = contains(out, `\`${status.toUpperCase()}\``);
		check(
			`status "${status}" renders an English badge without icons`,
			plainText && badgeOk,
			`plainText=${plainText} badge=\`${status.toUpperCase()}\``,
		);
	}
})();

// ─────────────────────────────────────────────────────
//  2. Edge: 0 nodes (empty DAG)
// ─────────────────────────────────────────────────────

(function testZeroNodes() {
	const r = makeResult({
		status: "passed",
		passedNodes: [],
		failedNodes: [],
		totalCost: 0,
		wallClockMs: 0,
		executionId: "zero-nodes",
	});
	const out = formatWorkflowSummary(r, "no-nodes");
	const noTables = !contains(out, "### Passed") && !contains(out, "### Failed");
	const zeroBreakdown = contains(out, "0 passed / 0 failed / 0 total");
	check("0-node DAG does not crash and shows zero counts", noTables && zeroBreakdown, "no tables, 0/0/0");
})();

// ─────────────────────────────────────────────────────
//  3. Edge: all-passed (completedNodes has entries)
// ─────────────────────────────────────────────────────

(function testAllPassed() {
	const r = makeResult({
		status: "passed",
		passedNodes: ["t1", "t2"],
		failedNodes: [],
	});
	const out = formatWorkflowSummary(r, "all-good");
	const hasPassedTable = contains(out, "### Passed");
	const noFailedTable = !contains(out, "### Failed");
	const countOk = contains(out, "2 passed / 0 failed / 2 total");
	check("all-passed shows Passed table, no Failed table", hasPassedTable && noFailedTable && countOk, "✅ table present, ❌ table absent");
})();

// ─────────────────────────────────────────────────────
//  4. Edge: all-failed (failedNodes has entries)
// ─────────────────────────────────────────────────────

(function testAllFailed() {
	const r = makeResult({
		status: "failed",
		passedNodes: [],
		failedNodes: ["t1", "t2"],
	});
	const out = formatWorkflowSummary(r, "all-bad");
	const hasFailedTable = contains(out, "### Failed");
	const noPassedTable = !contains(out, "### Passed");
	const countOk = contains(out, "0 passed / 2 failed / 2 total");
	check("all-failed shows Failed table, no Passed table", hasFailedTable && noPassedTable && countOk, "❌ table present, ✅ table absent");
})();

// ─────────────────────────────────────────────────────
//  5. Mixed: some passed, some failed → both tables
// ─────────────────────────────────────────────────────

(function testMixed() {
	const r = makeResult({
		status: "failed",
		passedNodes: ["t1"],
		failedNodes: ["t2"],
		roles: { t1: "implementer", t2: "reviewer" },
	});
	const out = formatWorkflowSummary(r, "mixed");
	const bothTables = contains(out, "### Passed") && contains(out, "### Failed");
	const countOk = contains(out, "1 passed / 1 failed / 2 total");
	check("mixed result shows both Passed and Failed tables", bothTables && countOk, "both tables present");
})();

// ─────────────────────────────────────────────────────
//  6. Missing optional timeLabel → "(not provided)"
// ─────────────────────────────────────────────────────

(function testMissingTimeLabel() {
	const r = makeResult({ status: "passed", passedNodes: ["t1"] });

	// undefined
	const out1 = formatWorkflowSummary(r);
	check("undefined timeLabel shows '(not provided)'", contains(out1, "(not provided)"), "undefined fallback");

	// empty string
	const out2 = formatWorkflowSummary(r, "");
	check("empty string timeLabel shows '(not provided)'", contains(out2, "(not provided)"), "empty string fallback");

	// blank string
	const out3 = formatWorkflowSummary(r, "   ");
	check("blank timeLabel shows '(not provided)'", contains(out3, "(not provided)"), "blank fallback");
})();

// ─────────────────────────────────────────────────────
//  7. Time formatting — sub-second
// ─────────────────────────────────────────────────────

(function testTimeSubSecond() {
	const r = makeResult({ status: "passed", passedNodes: ["t1"], wallClockMs: 500 });
	const out = formatWorkflowSummary(r, "fast");
	check("wallClock < 1000ms renders as ms", contains(out, "500ms"), `output includes 500ms`);
})();

// ─────────────────────────────────────────────────────
//  8. Time formatting — seconds
// ─────────────────────────────────────────────────────

(function testTimeSeconds() {
	const r = makeResult({ status: "passed", passedNodes: ["t1"], wallClockMs: 12300 });
	const out = formatWorkflowSummary(r, "seconds");
	check("wallClock 1s–60s renders as X.Xs", contains(out, "12.3s"), `output includes 12.3s`);
})();

// ─────────────────────────────────────────────────────
//  9. Time formatting — minutes + seconds
// ─────────────────────────────────────────────────────

(function testTimeMinutes() {
	// 91000ms = 1min 31s → Math.floor(91000/60000) = 1, ((91000%60000)/1000) = 31
	const r = makeResult({ status: "passed", passedNodes: ["t1"], wallClockMs: 91000 });
	const out = formatWorkflowSummary(r, "long");
	check("wallClock >= 60s renders as Xmin Xs", contains(out, "1min") && contains(out, "31s"), `output includes 1min 31s (91000ms → Math.floor=1min, 31s)`);
})();

// ─────────────────────────────────────────────────────
// 10. Cost formatting — fixed 6 decimals
// ─────────────────────────────────────────────────────

(function testCostFormatting() {
	const r = makeResult({ status: "passed", passedNodes: ["t1"], totalCost: 0.1234567 });
	const out = formatWorkflowSummary(r, "cost");
	// toFixed(6) rounds 0.1234567 → "0.123457"
	check("totalCost is formatted with 6 decimal places", contains(out, "$0.123457"), "cost = $0.123457");

	// Also verify node-level cost in the Passed table
	const nodeCostOk = contains(out, "$0.001000");
	check("node-level cost shows 6 decimal places", nodeCostOk, "node cost = $0.001000");
})();

// ─────────────────────────────────────────────────────
// 11. Run ID is included
// ─────────────────────────────────────────────────────

(function testRunId() {
	const r = makeResult({ status: "passed", passedNodes: ["t1"], executionId: "custom-run-42" });
	const out = formatWorkflowSummary(r, "id-check");
	check("executionId (run ID) appears in output", contains(out, "custom-run-42"), "Run ID visible");
})();

// ─────────────────────────────────────────────────────
// 12. Passed table includes role, retries, and cost columns
// ─────────────────────────────────────────────────────

(function testPassedTableContent() {
	const r = makeResult({
		status: "passed",
		passedNodes: ["t1"],
		failedNodes: [],
		roles: { t1: "implementer" },
	});
	const out = formatWorkflowSummary(r, "table-check");
	const hasRole = contains(out, "implementer");
	const hasRetries = contains(out, "| 0 |");
	const hasNodeCost = contains(out, "$0.001000");
	check("passed table has role, retries, and cost columns", hasRole && hasRetries && hasNodeCost, "role=implementer, retries=0, cost=$0.001000");
})();

// ─────────────────────────────────────────────────────
// 13. Failed table includes error message
// ─────────────────────────────────────────────────────

(function testFailedTableContent() {
	const r = makeResult({
		status: "failed",
		passedNodes: [],
		failedNodes: ["t1"],
	});
	const out = formatWorkflowSummary(r, "fail-table");
	const hasError = contains(out, "t1 error");
	check("failed table shows error message from subagent", hasError, "error visible");
})();

// ─────────────────────────────────────────────────────
// 14. Failed entry with no taskResult detail still renders
// ─────────────────────────────────────────────────────

(function testFailedNodeMissingTaskResult() {
	// Place the orphan in taskResults so the failed table renders,
	// but omit subagentResult so it hits the "no details" fallback.
	const orphanNode = makeNode("orphan");
	const taskResults = new Map<string, TaskExecutionResult>();
	taskResults.set("orphan", {
		node: orphanNode,
		subagentResult: {
			agent: "dag-orphan", exitCode: 1, output: "",
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
			model: null, errorMessage: "",
		},
		gateResult: null, retryCount: 0, passed: false,
	});
	const r: DAGExecutionResult = {
		executionId: "missing-detail",
		taskResults,
		allPassed: false,
		status: "failed",
		totalCost: 0.01,
		wallClockMs: 1000,
		completedNodes: [],
		failedNodes: ["orphan"],
		artifactPaths: {},
	};
	const out = formatWorkflowSummary(r, "orphan");
	const fallbackShown = contains(out, "(no details)");
	check("node with empty errorMessage still renders with fallback", fallbackShown, "orphan node shows _(no details)_");
})();

// ─────────────────────────────────────────────────────
// 15. Artifact paths show file name in passed table
// ─────────────────────────────────────────────────────

(function testArtifactInPassedTable() {
	const r = makeResult({
		status: "passed",
		passedNodes: ["t1"],
		artifactPaths: { t1: "/some/path/t1-output.md" },
	});
	const out = formatWorkflowSummary(r, "artifact");
	const hasArtifactColumn = contains(out, "| Artifact |");
	const hasFileName = contains(out, "t1-output.md");
	check("artifact column appears and shows file name", hasArtifactColumn && hasFileName, "Artifact header + t1-output.md");
})();

// ─────────────────────────────────────────────────────
// 16. Non-standard status remains visible without an icon
// ─────────────────────────────────────────────────────

(function testUnknownStatus() {
	// Cast a non-standard status to test forward-compatible presentation
	const r: DAGExecutionResult = {
		...makeResult({ status: "passed", passedNodes: ["t1"] }),
		status: "unknown_status" as DAGExecutionResult["status"],
	};
	const out = formatWorkflowSummary(r, "weird");
	check("unknown status remains visible without an icon", contains(out, "`UNKNOWN_STATUS`") && !hasProductCopyViolation(out), "UNKNOWN_STATUS badge");
})();

// ─────────────────────────────────────────────────────
// 17. timeLabel with surrounding whitespace is trimmed
// ─────────────────────────────────────────────────────

(function testTimeLabelTrimmed() {
	const r = makeResult({ status: "passed", passedNodes: ["t1"] });
	const out = formatWorkflowSummary(r, "  my-label  ");
	check("timeLabel with surrounding spaces is trimmed", contains(out, "my-label") && !contains(out, "  my-label  "), "trimmed to 'my-label'");
})();

// ─────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────

const failed = checks.filter(([, passed]) => !passed);
console.log(`\nformatWorkflowSummary: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) process.exit(1);
