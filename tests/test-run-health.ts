import { strict as assert } from "node:assert";
import { deadlineFrom, normalizeOptionalDurationMs, normalizeOptionalSeconds, remainingDuration } from "../src/core/deadline";
import { assessRunHealth, DEFAULT_RUN_HEALTH_CONFIG, shouldEmitHealthWarning } from "../src/core/run-health";

const now = Date.parse("2026-09-02T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let passed = 0;
function check(name: string, fn: () => void): void {
	try { fn(); passed++; console.log(`✓ ${name}`); }
	catch (error) { console.error(`✗ ${name}:`, error); process.exitCode = 1; }
}

check("optional deadline preserves omitted and null", () => {
	assert.equal(normalizeOptionalDurationMs(undefined), undefined);
	assert.equal(normalizeOptionalDurationMs(null), undefined);
	assert.equal(normalizeOptionalSeconds(undefined), undefined);
	assert.equal(deadlineFrom(now, null), undefined);
	assert.equal(remainingDuration(undefined, now), undefined);
});
check("deadline rejects zero and non-finite values", () => {
	assert.throws(() => normalizeOptionalDurationMs(0), /positive finite/);
	assert.throws(() => normalizeOptionalDurationMs(-1), /positive finite/);
	assert.throws(() => normalizeOptionalDurationMs(Number.POSITIVE_INFINITY), /positive finite/);
});
check("explicit deadline calculates remaining duration", () => {
	assert.equal(normalizeOptionalSeconds(2), 2_000);
	assert.equal(deadlineFrom(now, 500), now + 500);
	assert.equal(remainingDuration(now + 500, now + 100), 400);
	assert.equal(remainingDuration(now + 500, now + 600), 0);
});
check("heartbeat freshness does not count as semantic progress", () => {
	const result = assessRunHealth({
		phase: "running", nowMs: now, lastActivityAt: iso(now), lastProgressAt: iso(now - 61_000),
	}, DEFAULT_RUN_HEALTH_CONFIG);
	assert.equal(result.health, "quiet");
});
check("provider wait and tool wait are phase-aware", () => {
	assert.equal(assessRunHealth({ phase: "running", nowMs: now, lastProgressAt: iso(now - 31_000), waitingForProvider: true }, DEFAULT_RUN_HEALTH_CONFIG).health, "waiting_provider");
	assert.equal(assessRunHealth({ phase: "tool", nowMs: now, lastProgressAt: iso(now - 1_000) }, DEFAULT_RUN_HEALTH_CONFIG).health, "waiting_tool");
});
check("native user prompt wait is not provider stall", () => {
	assert.equal(assessRunHealth({ phase: "waiting_user", nowMs: now, lastProgressAt: iso(now - 3_600_000), waitingForProvider: true }).health, "waiting_user");
	assert.equal(assessRunHealth({ phase: "running", nowMs: now, lastProgressAt: iso(now) }).health, "healthy");
});
check("loop and context pressure retain evidence", () => {
	const loop = assessRunHealth({ phase: "running", nowMs: now, repeatActionSignature: "read:a", repeatActionCount: 3 }, DEFAULT_RUN_HEALTH_CONFIG);
	assert.equal(loop.health, "suspected_loop");
	assert.match(loop.reason ?? "", /read:a/);
	const pressure = assessRunHealth({ phase: "running", nowMs: now, contextPercent: 0.9 }, DEFAULT_RUN_HEALTH_CONFIG);
	assert.equal(pressure.health, "context_pressure");
});
check("health warnings change immediately and then obey cooldown", () => {
	const first = { health: "quiet" as const, reason: "quiet", warningKey: "quiet:quiet" };
	assert.equal(shouldEmitHealthWarning("healthy", first, now, undefined, 60_000), true);
	assert.equal(shouldEmitHealthWarning("quiet", first, now + 1_000, iso(now), 60_000), false);
	assert.equal(shouldEmitHealthWarning("quiet", first, now + 60_000, iso(now), 60_000), true);
	assert.equal(shouldEmitHealthWarning("quiet", { health: "healthy" }, now, iso(now), 60_000), false);
});

console.log(`Run health/deadline tests: ${passed} passed`);
if (process.exitCode) process.exit(1);
