/**
 * Telemetry v3 identifiers/lifecycle contract + ExperienceStore import compatibility.
 *
 * 全部读写都发生在 OS 临时目录，不读写或删除项目 `.agentflux` 数据。
 * 运行: npx tsx tests/test-telemetry-experience-import.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceStore } from "../src/core/experience-store";
import { TelemetryWriter } from "../src/telemetry/events";

function readJsonl(path: string): any[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

function writeJsonl(path: string, events: any[]): void {
	writeFileSync(path, events.map(event => JSON.stringify(event)).join("\n") + "\n", "utf-8");
}

function routingDecision(sessionId: string, extra: Record<string, any> = {}) {
	return {
		sessionId,
		mode: "M2" as const,
		preset: "balanced" as const,
		stage: "Growth" as const,
		role: "doer" as const,
		reason: ["test"],
		confidence: 0.8,
		fallback: "M1" as const,
		biasSources: { maturity: "M2" as const, preference: "M2" as const },
		expected: { cost: "med" as const, latency: "med" as const, accuracy: "med" as const },
		...extra,
	};
}

function testFlatWriterSchema(root: string): void {
	const fluxDir = join(root, "flat", ".agentflux");
	const writer = new TelemetryWriter(fluxDir, true);
	writer.writeRoutingDecision(routingDecision("session-flat", {
		taskId: "task-flat",
		taskType: "bugfix",
		complexityTier: 1,
		fileCount: 2,
		diffLines: 24,
	}));

	const decision = readJsonl(writer.path)[0];
	assert.match(decision.decisionId, /^decision-session-flat-/);

	writer.writeSubagentRun({
		sessionId: "session-flat",
		taskId: "task-flat",
		decisionId: decision.decisionId,
		stepId: "step-review",
		agent: "reviewer-1",
		task: "review change",
		model: "test-model",
		turns: 2,
		input: 100,
		output: 20,
		cacheRead: 300,
		cacheWrite: 0,
		costUsd: 0.012,
		contextTokens: 420,
		cacheHitRate: 0.75,
		prefixLayout: true,
		exitCode: 0,
		startedAt: 1_000,
		finishedAt: 2_500,
		evidence: [{ type: "test", name: "unit", passed: true }],
	});

	const events = readJsonl(writer.path);
	const run = events[1];
	assert.match(run.runId, /^run-session-flat-reviewer-1-/);
	assert.equal(run.attemptId, `${run.runId}-attempt-0`);
	assert.equal(run.latencyMs, 1_500);
	assert.equal(run.outcome.status, "success");
	assert.equal(run.outcome.success, true);

	const store = new ExperienceStore(fluxDir);
	assert.equal(store.importFromTelemetry(writer.path), 1);
	const [record] = store.loadAll();
	assert.equal(record.taskId, "task-flat");
	assert.equal(record.runId, run.runId);
	assert.equal(record.decisionId, decision.decisionId);
	assert.equal(record.stepId, "step-review");
	assert.equal(record.startedAt, 1_000);
	assert.equal(record.finishedAt, 2_500);
	assert.equal(record.signature.taskType, "bugfix");
	assert.equal(record.outcome.success, true);
	assert.equal(record.outcome.status, "success");
	assert.equal(record.outcome.cost, 0.012);
	assert.equal(record.outcome.costUsd, 0.012);
	assert.equal(record.outcome.latencyMs, 1_500);
	assert.equal(record.outcome.evidence?.[0]?.name, "unit");
}

function testLegacyPayloadSchema(root: string): void {
	const fluxDir = join(root, "legacy", ".agentflux");
	const store = new ExperienceStore(fluxDir);
	const eventsPath = join(root, "legacy-events.jsonl");
	writeJsonl(eventsPath, [
		{
			type: "routing.decision",
			sessionId: "session-legacy",
			payload: { mode: "M4", taskType: "refactor", complexityTier: 3, fileCount: 18, diffLines: 420 },
		},
		{
			type: "subagent.run",
			sessionId: "session-legacy",
			payload: { cost: 0.02, latencyMs: 9_000, exitCode: 1, cacheHitRate: 0.5, turns: 3 },
		},
	]);

	assert.equal(store.importFromTelemetry(eventsPath), 1);
	const [record] = store.loadAll();
	assert.equal(record.signature.taskType, "refactor");
	assert.equal(record.routedMode, "M4");
	assert.equal(record.outcome.success, false);
	assert.equal(record.outcome.status, "failure");
	assert.equal(record.outcome.costUsd, 0.02);
	assert.equal(record.outcome.latencyMs, 9_000);
}

function testDecisionWithoutRealRun(root: string): void {
	const fluxDir = join(root, "no-run", ".agentflux");
	const store = new ExperienceStore(fluxDir);
	const eventsPath = join(root, "no-run-events.jsonl");
	writeJsonl(eventsPath, [
		{ type: "routing.decision", sessionId: "session-empty", mode: "M2", taskType: "feature" },
		// 有 subagent.run 外形但没有 outcome/status/exitCode，也不是可用的完成 run。
		{ type: "subagent.run", sessionId: "session-empty", costUsd: 0 },
		{ type: "routing.decision", sessionId: "session-no-event", mode: "M1", taskType: "docs" },
	]);

	assert.equal(store.importFromTelemetry(eventsPath), 0);
	assert.deepEqual(store.loadAll(), []);
}

function main(): void {
	const root = mkdtempSync(join(tmpdir(), "agentflux-telemetry-import-"));
	try {
		testFlatWriterSchema(root);
		testLegacyPayloadSchema(root);
		testDecisionWithoutRealRun(root);
		console.log("✅ telemetry/experience import: flat schema, legacy payload, no-run guard all passed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main();
