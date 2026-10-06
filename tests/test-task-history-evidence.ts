import assert from "node:assert/strict";
import {
	assertLineage,
	assertNoDeadline,
	assertTerminalTask,
	exactAssistantEvidence,
	parseOutputEvents,
	toolEvidence,
} from "./helpers/task-history-evidence";

const assistant = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
const userEcho = JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "prompt mentions EXACT_MARKER" }] } });
const toolStart = JSON.stringify({ type: "tool_execution_start", toolName: "flux_task", toolCallId: "call-1", args: { action: "continue", selector: "task-1" } });
const toolEnd = JSON.stringify({ type: "tool_execution_end", toolName: "flux_task", toolCallId: "call-1", isError: true, result: { content: [{ type: "text", text: "rejected" }] } });
const output = [userEcho, toolStart, toolEnd, assistant("wrong output"), assistant("EXACT_MARKER")].join("\n");

const markerEvidence = exactAssistantEvidence(output, "", "EXACT_MARKER");
assert.equal(markerEvidence.markerMatched, true);
assert.equal(markerEvidence.finalAssistantText, "EXACT_MARKER");
assert.equal(parseOutputEvents(output).length, 5);
const rejection = toolEvidence(output, "", "flux_task");
assert.equal(rejection.starts.length, 1);
assert.equal(rejection.ends.length, 1);
assert.equal(rejection.errors.length, 1);

const parent = {
	id: "task-parent",
	executionId: "execution-parent",
	sessionId: "session-1",
	task: "source body",
	selectedBy: "main_agent",
	operation: "new",
	status: "failed",
	parentTaskId: undefined,
	parentExecutionId: undefined,
	deadlineAt: undefined,
};
const child = {
	id: "task-child",
	executionId: "execution-child",
	sessionId: "session-1",
	task: "source body",
	selectedBy: "main_agent",
	operation: "retry",
	status: "completed",
	parentTaskId: parent.id,
	parentExecutionId: parent.executionId,
	deadlineAt: undefined,
};
const core = {
	tasks: [parent, child],
	executions: [
		{ id: parent.executionId, taskId: parent.id, operation: "new", status: "failed", costUsd: 0, outcome: { status: "failure", error: "provider rejected" }, deadlineAt: undefined, invocationOutcomes: [{ id: "bad", action: "failed", status: "failure", error: "provider rejected" }] },
		{ id: child.executionId, taskId: child.id, operation: "retry", parentTaskId: parent.id, parentExecutionId: parent.executionId, status: "completed", costUsd: 0, outcome: { status: "success" }, deadlineAt: undefined },
	],
	runs: [],
	agents: [],
	events: [],
};
assertTerminalTask(core, parent, "failed");
assertTerminalTask(core, child, "completed");
assertLineage(core, child, parent, "retry");
assertNoDeadline(core);

assert.throws(() => exactAssistantEvidence(assistant("EXACT_MARKER\nextra"), "", "EXACT_MARKER"), /exactly equal/);
assert.throws(() => assertLineage(core, { ...child, id: parent.id }, parent, "retry"), /new Task identity/);
console.log("✓ task-history evidence: exact marker, tool rejection, Core terminal status, lineage and deadline checks");
