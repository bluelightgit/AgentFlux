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
	workStyle: "team",
	task: "实现功能并独立复核",
});
const encoded = encodeAgentFluxTaskEnvelope(envelope);
const parsed = parseAgentFluxTaskEnvelope(encoded);

check("Desktop task envelope round-trips task id, work style and task", () => {
	assert.deepEqual(parsed, envelope);
});
check("Task stays as a readable dynamic suffix", () => {
	assert.ok(encoded.endsWith("\n实现功能并独立复核"));
});
check("Plain TUI prompts remain untouched", () => {
	assert.equal(parseAgentFluxTaskEnvelope("普通任务"), null);
});
check("Unknown work styles fail closed", () => {
	const metadata = Buffer.from(JSON.stringify({ version: 1, taskId: "x", workStyle: "m6" })).toString("base64url");
	assert.throws(() => parseAgentFluxTaskEnvelope(`agentflux-task-v1:${metadata}\ntask`), /Invalid AgentFlux task envelope/);
});
check("Missing task body fails closed", () => {
	assert.throws(() => parseAgentFluxTaskEnvelope(encoded.split("\n")[0]), /task is missing/);
});

console.log(`\n${passed} task-envelope checks passed`);
