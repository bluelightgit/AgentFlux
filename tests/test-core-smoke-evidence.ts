import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isSafeChildPath,
	productionDistEvidence,
	snapshotCoreSmokeFacts,
	validateCoreSmokeCase,
	type CoreSmokeProcessResult,
} from "./helpers/core-smoke-evidence";

const root = mkdtempSync(join(tmpdir(), "agentflux-core-smoke-evidence-"));
const runtime = join(root, ".agentflux", "runtime");
const marker = "CORE_SMOKE_EVIDENCE_OK";
const token = "CORE_SMOKE_EVIDENCE_TOKEN";
const now = new Date().toISOString();

function writeStores(input: {
	taskStatus?: string;
	executionStatus?: string;
	outcomeStatus?: string;
	resource?: any;
	issue?: any;
} = {}): void {
	mkdirSync(runtime, { recursive: true });
	writeFileSync(join(runtime, "tasks.json"), JSON.stringify({ version: 2, tasks: [{
		id: "task-evidence",
		executionId: "execution-evidence",
		sessionId: "session-evidence",
		task: `${token} deterministic fixture`,
		operation: "new",
		status: input.taskStatus ?? "completed",
		resource: input.resource,
		createdAt: now,
		updatedAt: now,
	}], executions: [{
		id: "execution-evidence",
		taskId: "task-evidence",
		sessionId: "session-evidence",
		operation: "new",
		status: input.executionStatus ?? "completed",
		outcome: { status: input.outcomeStatus ?? "success" },
		costUsd: 0,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
		createdAt: now,
		updatedAt: now,
		finishedAt: now,
	}] }, null, 2));
	writeFileSync(join(runtime, "runs.json"), JSON.stringify({ version: 1, runs: [] }, null, 2));
	writeFileSync(join(runtime, "agents.json"), JSON.stringify({ agents: [] }, null, 2));
	writeFileSync(join(runtime, "workflows.json"), JSON.stringify({ version: 1, definitions: [] }, null, 2));
	writeFileSync(join(runtime, "active-context.json"), JSON.stringify({ version: 1, entries: [] }, null, 2));
	writeFileSync(join(root, ".agentflux", "issues.json"), JSON.stringify({ issues: input.issue ? [input.issue] : [] }, null, 2));
}

const assistantSuccess: CoreSmokeProcessResult = {
	label: "deterministic",
	pid: process.pid,
	exitCode: 0,
	signal: null,
	stdout: JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: marker }] } })
		+ "\n"
		+ JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: marker }] } }) + "\n",
	stderr: "",
	timedOut: false,
	startedAt: now,
	finishedAt: now,
	watchdogTimeoutMs: 1_000,
};

try {
	const distSource = join(root, "source"); const distFixture = join(root, "fixture");
	for (const base of [distSource, distFixture]) {
		mkdirSync(join(base, "dist/extension"), { recursive: true });
		for (const entry of ["entry.js", "subagent-entry.js"]) writeFileSync(join(base, "dist/extension", entry), "export default () => {};");
	}
	assert.equal(productionDistEvidence(distSource, distFixture).builtExtension, false, "two entries without the preload are not a complete package");
	for (const base of [distSource, distFixture]) writeFileSync(join(base, "dist/extension/background-preload.mjs"), "export {};");
	assert.equal(productionDistEvidence(distSource, distFixture).builtExtension, true);
	writeFileSync(join(distFixture, "dist/extension/background-preload.mjs"), "// mismatched preload");
	assert.equal(productionDistEvidence(distSource, distFixture).builtExtension, false);
	assert.equal(isSafeChildPath(root, join(root, "fixture")), true);
	assert.equal(isSafeChildPath(root, root), false);
	assert.equal(isSafeChildPath(root, join(root, "..", "outside")), false);

	writeStores();
	let facts = snapshotCoreSmokeFacts(root, root);
	let check = validateCoreSmokeCase({ label: "direct", marker, taskToken: token }, assistantSuccess, facts);
	assert.equal(check.output.assistant.markerMatched, true);
	assert.equal(check.passed, true);
	const required = { label: "direct", marker, taskToken: token, requireCostAccounting: true };
	assert.equal(validateCoreSmokeCase(required, assistantSuccess, facts).passed, false, "missing coverage is not complete");
	const execution = facts.executions[0];
	execution.costAccounting = { mainCostUsd: execution.costUsd, invocationCostUsd: 0, complete: true };
	assert.equal(validateCoreSmokeCase(required, assistantSuccess, facts).passed, true);
	execution.invocationOutcomes = [{ costUsd: 0 }];
	assert.equal(validateCoreSmokeCase(required, assistantSuccess, facts).passed, false, "unmarked receipt must not be complete");

	writeStores({ taskStatus: "failed", executionStatus: "failed", outcomeStatus: "failure" });
	facts = snapshotCoreSmokeFacts(root, root);
	check = validateCoreSmokeCase({ label: "failed-terminal", marker, taskToken: token }, assistantSuccess, facts);
	assert.equal(check.output.passed, true);
	assert.equal(check.taskExecution.passed, false);
	assert.equal(check.passed, false);

	writeStores();
	writeFileSync(join(runtime, "tasks.json"), JSON.stringify({ version: 2, tasks: [], executions: [] }, null, 2));
	facts = snapshotCoreSmokeFacts(root, root);
	check = validateCoreSmokeCase({ label: "missing-facts", marker, taskToken: token }, assistantSuccess, facts);
	assert.equal(check.taskExecution.passed, false);
	assert.equal(check.passed, false);

	const issue = {
		id: "issue-evidence",
		title: "evidence issue",
		description: "deterministic",
		status: "resolved",
		createdBy: "main",
		createdAt: now,
		updatedAt: now,
		acceptanceCriteria: ["ok"],
		comments: [],
		claims: [{ id: "claim-evidence", agent: "reviewer", scope: "evidence", status: "reviewed", proposalIds: [], plan: "plan", leaseId: "lease-evidence" }],
		proposals: [],
		timeline: [
			{ id: "event-created", type: "created", createdAt: now },
			{ id: "event-claimed", type: "claimed", createdAt: now },
			{ id: "event-submitted", type: "submitted", createdAt: now },
			{ id: "event-reviewed", type: "reviewed", createdAt: now },
			{ id: "event-resolved", type: "resolved", createdAt: now },
		],
		costUsd: 0,
	};
	writeStores({ resource: { type: "issue", id: issue.id }, issue });
	const issueOutput: CoreSmokeProcessResult = {
		...assistantSuccess,
		stdout: JSON.stringify({ type: "tool_execution_start", toolName: "flux_issue", args: { action: "resolve" } }) + "\n" + assistantSuccess.stdout,
	};
	facts = snapshotCoreSmokeFacts(root, root);
	check = validateCoreSmokeCase({ label: "community", marker, taskToken: token, requiredToolStarts: [{ toolName: "flux_issue", action: "resolve" }], resourceType: "issue" }, issueOutput, facts);
	assert.equal(check.resource.issue.passed, true);
	assert.equal(check.passed, true);

	const incompleteIssue = { ...issue, claims: [{ ...issue.claims[0], status: "submitted" }], timeline: issue.timeline.filter((event: any) => event.type !== "reviewed") };
	writeStores({ resource: { type: "issue", id: issue.id }, issue: incompleteIssue });
	facts = snapshotCoreSmokeFacts(root, root);
	check = validateCoreSmokeCase({ label: "community-incomplete", marker, taskToken: token, resourceType: "issue" }, assistantSuccess, facts);
	assert.equal(check.resource.issue.passed, false);
	assert.equal(check.passed, false);

	writeStores({ resource: { type: "workflow", id: "workflow-empty" } });
	facts = snapshotCoreSmokeFacts(root, root);
	facts.workflows = [{ id: "workflow-empty", dag: { nodes: [] } }];
	check = validateCoreSmokeCase({ label: "workflow-empty", marker, taskToken: token, resourceType: "workflow", expectedWorkflowNodes: 3 }, assistantSuccess, facts);
	assert.equal(check.resource.definitionPresent, true);
	assert.equal(check.resource.allNodesProven, false);
	assert.equal(check.passed, false, "只有定义/最终 marker 不等于三个节点与质量门真实完成");

	const echoedOnly: CoreSmokeProcessResult = { ...assistantSuccess, stdout: JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: marker }] } }) + "\n" };
	writeStores();
	facts = snapshotCoreSmokeFacts(root, root);
	check = validateCoreSmokeCase({ label: "prompt-echo", marker, taskToken: token }, echoedOnly, facts);
	assert.equal(check.output.assistant.markerMatched, false);
	assert.equal(check.passed, false);

	console.log("Core smoke evidence: prompt echo, failed terminal, missing facts, and community lifecycle checks passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
