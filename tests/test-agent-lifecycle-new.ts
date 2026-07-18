import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEphemeralRecord, finishEphemeralRecord } from "../src/agents/agent-lifecycle";
import { runAgent, runAgentsParallel, type AgentTemplate } from "../src/agents/agent-runner";
import { archivePersistentAgent, listPersistentAgents, registerPersistentAgent, runPersistentAgent } from "../src/agents/persistent-agent";
import { TelemetryWriter } from "../src/telemetry/events";

let passed = 0;
function check(value: unknown, message: string): void { if (!value) throw new Error(message); passed++; console.log(`✓ ${message}`); }

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "agentflux-agent-life-"));
	try {
		const helper = resolve("tests/helpers/successful-subagent.cjs");
		const invocationOverride = { command: process.execPath, args: [helper] };
		const template: AgentTemplate = { name: "worker", role: "implementer", description: "test", tools: [], systemPrompt: "Complete the task." };
		const telemetry = new TelemetryWriter(join(root, ".agentflux"));
		const record = createEphemeralRecord({ name: "worker-1", role: "implementer", sessionId: "test", telemetry });
		const result = await runAgent({ cwd: root, agent: { ...template, name: record.name }, task: "short task", sessionId: "test", telemetry, prefixLayout: true, persistent: false, invocationOverride });
		finishEphemeralRecord(record, result.exitCode, result.usage.cost, telemetry, "test");
		check(result.exitCode === 0 && record.status === "done" && record.callCount === 1, "Ephemeral Agent 单次运行后进入终态");

		const team = await runAgentsParallel([
			{ agent: { ...template, name: "worker-a" }, task: "A", label: "A" },
			{ agent: { ...template, name: "worker-b" }, task: "B", label: "B" },
		], { cwd: root, sessionId: "team", telemetry, prefixLayout: true, invocationOverride });
		check(team.allSucceeded && team.results.length === 2, "Team 并行运行两个独立 Ephemeral Agent");
		const lifecycleEvents = readFileSync(join(root, ".agentflux", "events.jsonl"), "utf-8")
			.trim().split("\n").map(line => JSON.parse(line)).filter(event => event.type === "agent.lifecycle" && ["worker-a", "worker-b"].includes(event.agent));
		check(lifecycleEvents.filter(event => event.action === "created").length === 2 && lifecycleEvents.filter(event => event.action === "completed").length === 2, "Team child 的创建与终态均写入 lifecycle telemetry");

		const persistent = registerPersistentAgent(root, "reviewer-main", "reviewer", { models: {} });
		check(persistent.kind === "persistent" && listPersistentAgents(root).length === 1, "Persistent Agent 从模板注册");
		const persistentResult = await runPersistentAgent("reviewer-main", "review task", { cwd: root, modelsConfig: { models: {} }, telemetry, sessionId: "persistent", sharedSkills: [], prefixLayout: true, invocationOverride });
		const afterRun = listPersistentAgents(root)[0];
		check(persistentResult.exitCode === 0 && afterRun.status === "idle" && afterRun.callCount === 1, "Persistent Agent 完成后回到 idle 并保留身份");
		check(archivePersistentAgent(root, "reviewer-main").status === "archived", "空闲 Persistent Agent 可归档");
		console.log(`\n${passed} Agent lifecycle checks passed`);
	} finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
