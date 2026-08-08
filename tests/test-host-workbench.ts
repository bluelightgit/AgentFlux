import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	archivePersistentAgentFromHost,
	acknowledgeAgentMessage,
	createAgentGroup,
	mutateCommunityIssue,
	pollAgentInbox,
	readAgentFluxEvents,
	readAgentFluxProject,
	readAgentFluxTaskDetail,
	readAgentFluxTaskHistory,
	registerPersistentAgent,
	resolveAgentFluxTeamStatus,
	runAgentFluxTeam,
	sendAgentGroupMessage,
	stopEphemeralAgent,
} from "../src/host/index";
import { MessageBus } from "../src/core/message-bus";
import { readAgentRunStop } from "../src/agents/agent-run-control";
import { TelemetryWriter } from "../src/telemetry/events";
import { getTask } from "../src/core/task-registry";
import { getAgentRun, markAgentRunRunning, registerAgentRun } from "../src/core/run-registry";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
	try {
		await fn();
		console.log(`✓ ${name}`);
		passed++;
	} catch (error) {
		console.error(`✗ ${name}`, error);
		failed++;
	}
}

const root = mkdtempSync(join(tmpdir(), "agentflux-host-workbench-"));

await check("project snapshot exposes persistent capability and cache metadata", () => {
	const agent = registerPersistentAgent(root, "reviewer-main", "reviewer", { models: {} });
	const snapshot = readAgentFluxProject(root);
	const capability = snapshot.persistentAgentCapabilities.find(item => item.agentName === agent.name);
	assert.ok(capability);
	assert.strictEqual(capability?.role, "reviewer");
	assert.ok(capability?.tools.includes("read"));
	assert.strictEqual(capability?.capabilityGeneration, 1);
	assert.strictEqual(capability?.cacheImpact, "stable");
	assert.strictEqual(capability?.sessionId, "persistent-reviewer-main");
});

await check("project snapshot exposes sanitized Workflow checkpoint and quality gate facts", () => {
	const runtimeDir = join(root, ".agentflux", "runtime");
	const runDir = join(runtimeDir, "runs", "workflow-task");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runtimeDir, "tasks.json"), JSON.stringify({
		version: 1,
		tasks: [{
			id: "workflow-task",
			sessionId: "workflow-session",
			task: "Review implementation",
			workStyle: "workflow",
			selectedBy: "user",
			operation: "new",
			status: "completed",
			resource: { type: "workflow", id: "workflow-definition", version: 2 },
			createdAt: "2026-07-30T00:00:00.000Z",
			updatedAt: "2026-07-30T00:01:00.000Z",
		}],
	}, null, 2));
	writeFileSync(join(runDir, "checkpoint.json"), JSON.stringify({
		executionId: "workflow-task",
		nodeIds: ["review"],
		completed: ["review"],
		failed: [],
		status: "passed",
		totalCost: 0.012,
		iterationCount: 1,
		timestamp: 1234,
		artifactPaths: { review: "artifacts/review.md" },
		taskResults: [["review", {
			passed: true,
			retryCount: 1,
			subagentResult: {
				exitCode: 0,
				output: "must not leak into snapshot",
				model: "deepseek-v4-flash",
				usage: { cost: 0.01 },
			},
			gateResult: {
				status: "passed",
				passed: true,
				feedback: "criteria met",
				criteriaResults: [{ criterion: "tests pass", met: true }],
				gateCost: 0.002,
				gateModel: "deepseek-v4-flash",
			},
		}]],
	}, null, 2));
	const run = readAgentFluxProject(root).workflowRuns.find(item => item.taskId === "workflow-task");
	assert.ok(run);
	assert.strictEqual(run?.status, "passed");
	assert.deepStrictEqual(run?.completed, ["review"]);
	assert.strictEqual(run?.nodes[0].retryCount, 1);
	assert.strictEqual(run?.nodes[0].gate?.feedback, "criteria met");
	assert.strictEqual(run?.artifactPaths.review, "artifacts/review.md");
	assert.strictEqual("output" in (run?.nodes[0] ?? {}), false);
});

await check("host group operations persist messages for every member except main", () => {
	const group = createAgentGroup(root, { name: "review-room", members: ["reviewer-main", "tester-main"] });
	const result = sendAgentGroupMessage(root, {
		taskId: "task-group",
		groupId: group.id,
		content: "Please coordinate the review.",
	});
	assert.deepStrictEqual(result.envelope.recipients, ["reviewer-main", "tester-main"]);
	const snapshot = readAgentFluxProject(root);
	assert.ok(snapshot.groups.some(item => item.id === group.id));
	assert.ok(snapshot.messages.some(item => item.envelope.id === result.envelope.id));
});

await check("host Main inbox poll and ACK expose real delivery transitions", () => {
	const bus = new MessageBus(join(root, ".agentflux"));
	const sent = bus.sendDirect("reviewer-main", "main", "message", "Review is ready.", {
		taskId: "task-inbox",
	});
	const inbox = pollAgentInbox(root, { recipient: "main" });
	assert.ok(inbox.some(item => item.envelope.id === sent.envelope.id && item.delivery.status === "delivered"));
	const delivery = acknowledgeAgentMessage(root, "main", sent.envelope.id);
	assert.strictEqual(delivery.status, "acknowledged");
});

await check("host Ephemeral stop creates a run-scoped cross-process request", () => {
	const fluxDir = join(root, ".agentflux");
	registerAgentRun(fluxDir, {
		id: "run-worker-live",
		sessionId: "session-team",
		taskId: "task-team",
		agent: "worker-live",
		kind: "ephemeral",
		role: "reviewer",
		currentTask: "Review live changes",
	});
	markAgentRunRunning(fluxDir, "run-worker-live", process.pid, 1);
	const result = stopEphemeralAgent(root, {
		taskId: "task-team",
		agent: "worker-live",
		runId: "run-worker-live",
	});
	assert.strictEqual(result.status, "stop_requested");
	assert.strictEqual(readAgentRunStop(root, "run-worker-live")?.runId, "run-worker-live");
	assert.strictEqual(getAgentRun(fluxDir, "run-worker-live")?.status, "stop_requested");
	assert.ok(readAgentFluxProject(root).runs.some(run => run.id === "run-worker-live"));
});

await check("exact Team validation failure reaches the task registry", async () => {
	await assert.rejects(
		() => runAgentFluxTeam(root, {
			sessionId: "host-failure-session",
			taskId: "host-failure-task",
			task: "Validate failure propagation",
			tasks: [{
				name: "missing-role-worker",
				role: "role-that-does-not-exist",
				task: "This must fail before spawning.",
				workspace: root,
			}],
		}),
		/Unknown Agent template/,
	);
	assert.strictEqual(getTask(join(root, ".agentflux"), "host-failure-task")?.status, "failed");
});

await check("exact Team terminal status distinguishes timeout and cancellation", () => {
	const base = {
		wallClockMs: 1,
		sumIndividualMs: 1,
		speedupRatio: 1,
		totalCost: 0,
		allSucceeded: false,
		errors: ["failed"],
	};
	const result = (exitCode: number) => ({
		...base,
		results: [{
			agent: "worker",
			exitCode,
			output: "",
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
			model: null,
			errorMessage: "failed",
		}],
	});
	assert.strictEqual(resolveAgentFluxTeamStatus(result(124)), "timed_out");
	assert.strictEqual(resolveAgentFluxTeamStatus(result(130)), "cancelled");
	assert.strictEqual(resolveAgentFluxTeamStatus(result(1)), "failed");
});

await check("host community actions cover create, claim, submit and resolve", () => {
	let issue = mutateCommunityIssue(root, { action: "create", title: "Review release", body: "Check the release." });
	issue = mutateCommunityIssue(root, { action: "comment", issueId: issue.id, body: "Starting triage." });
	issue = mutateCommunityIssue(root, { action: "claim", issueId: issue.id, agent: "reviewer-main", scope: "code review" });
	issue = mutateCommunityIssue(root, { action: "submit", issueId: issue.id, claimId: issue.claims[0].id });
	issue = mutateCommunityIssue(root, { action: "resolve", issueId: issue.id });
	assert.strictEqual(issue.status, "resolved");
	assert.strictEqual(issue.comments.length, 1);
	assert.strictEqual(issue.claims[0].status, "submitted");
});

await check("host archive removes a persistent agent from the active roster", () => {
	const result = archivePersistentAgentFromHost(root, "reviewer-main");
	assert.strictEqual(result.status, "archived");
	const snapshot = readAgentFluxProject(root);
	assert.strictEqual(snapshot.persistentAgents.find(item => item.name === "reviewer-main")?.status, "archived");
});

await check("Host task history is bounded, pageable, and has an exact detail endpoint", () => {
	const snapshot = readAgentFluxProject(root, { historyLimit: 1 });
	assert.strictEqual(snapshot.tasks.length, 1);
	assert.strictEqual(snapshot.history.limit, 1);
	assert.strictEqual(snapshot.history.truncated, true);
	const firstPage = readAgentFluxTaskHistory(root, { limit: 1 });
	assert.strictEqual(firstPage.tasks.length, 1);
	assert.ok(firstPage.nextOffset);
	const detail = readAgentFluxTaskDetail(root, "host-failure-task");
	assert.strictEqual(detail.task.id, "host-failure-task");
	assert.strictEqual(detail.executions.length, 1);
});

await check("Host event reader streams large logs in cursor-compatible bounded pages", () => {
	const stressRoot = mkdtempSync(join(tmpdir(), "agentflux-event-page-"));
	try {
		const eventDir = join(stressRoot, ".agentflux");
		mkdirSync(eventDir, { recursive: true });
		const lines = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({
			type: "context.event",
			timestamp: index,
			sessionId: "stress",
			turnIndex: index,
			action: "compact_triggered",
			contextPercentBefore: null,
			contextPercentAfter: null,
		}));
		writeFileSync(join(eventDir, "events.jsonl"), `${lines.join("\n")}\n`, "utf-8");
		const first = readAgentFluxEvents(stressRoot, 0, 128);
		const second = readAgentFluxEvents(stressRoot, first.nextCursor, 128);
		const tail = readAgentFluxEvents(stressRoot, 9_950, 100);
		assert.strictEqual(first.events.length, 128);
		assert.strictEqual(first.nextCursor, 128);
		assert.strictEqual(first.hasMore, true);
		assert.strictEqual((first.events[0] as any).turnIndex, 0);
		assert.strictEqual((second.events[0] as any).turnIndex, 128);
		assert.strictEqual(tail.events.length, 50);
		assert.strictEqual(tail.nextCursor, 10_000);
		assert.strictEqual(tail.hasMore, false);
	} finally {
		rmSync(stressRoot, { recursive: true, force: true });
	}
});

rmSync(root, { recursive: true, force: true });
console.log(`\nHost workbench: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
