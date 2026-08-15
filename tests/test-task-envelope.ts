import { strict as assert } from "node:assert";
import {
	createAgentFluxTaskEnvelope,
	encodeAgentFluxTaskEnvelope,
	parseAgentFluxTaskEnvelope,
} from "../src/core/task-envelope";

let passed = 0;
function check(message: string, fn: () => void): void {
	fn();
	passed += 1;
	console.log(`✓ ${message}`);
}

const envelope = createAgentFluxTaskEnvelope({
	taskId: "task-desktop-1",
	task: "实现功能并独立复核",
});
const encoded = encodeAgentFluxTaskEnvelope(envelope);
const parsed = parseAgentFluxTaskEnvelope(encoded);

check("Task envelope round-trips task id and task without work style", () => {
	assert.deepEqual(parsed, envelope);
	assert.ok(!("workStyle" in (parsed as object)));
});
check("Task stays as a readable dynamic suffix", () => {
	assert.ok(encoded.endsWith("\n实现功能并独立复核"));
});
check("Plain TUI prompts remain untouched", () => {
	assert.equal(parseAgentFluxTaskEnvelope("普通任务"), null);
});
check("Invalid metadata fields fail closed", () => {
	const badVersion = Buffer.from(JSON.stringify({ version: 2, taskId: "x" })).toString("base64url");
	assert.throws(() => parseAgentFluxTaskEnvelope(`agentflux-task-v1:${badVersion}\ntask`), /Invalid AgentFlux task envelope/);
	const badId = Buffer.from(JSON.stringify({ version: 1, taskId: 42 })).toString("base64url");
	assert.throws(() => parseAgentFluxTaskEnvelope(`agentflux-task-v1:${badId}\ntask`), /Invalid AgentFlux task envelope/);
});
check("Missing task body fails closed", () => {
	assert.throws(() => parseAgentFluxTaskEnvelope(encoded.split("\n")[0]), /task is missing/);
});
check("Path-like task ids fail closed", () => {
	for (const taskId of ["../escape", "..", "C:\\escape", "/absolute", "nul", "a/b"]) {
		assert.throws(() => createAgentFluxTaskEnvelope({ taskId, task: "x" }), /opaque id/);
	}
	const metadata = Buffer.from(JSON.stringify({ version: 1, taskId: "../../escape" })).toString("base64url");
	assert.throws(() => parseAgentFluxTaskEnvelope(`agentflux-task-v1:${metadata}\ntask`), /opaque id/);
});

console.log(`\n${passed} task-envelope checks passed`);
