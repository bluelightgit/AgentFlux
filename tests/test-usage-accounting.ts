import { strict as assert } from "node:assert";
import {
	UsageAccounting,
	createUsageAccounting,
	type UsageAccountingSnapshot,
	type SessionEntryLike,
} from "../src/core/usage-accounting";
import type { PricingTable } from "../src/core/pricing";

let passed = 0;
let failed = 0;

function check(description: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${description}`);
	} catch (error: any) {
		failed++;
		console.log(`  ✗ ${description}: ${error.message}`);
	}
}

function usage(cost: number, input = 0, output = 0, extra: Record<string, unknown> = {}) {
	return { input, output, cacheRead: 0, cacheWrite: 0, ...extra, cost: { total: cost } };
}

function assertSnapshot(snapshot: UsageAccountingSnapshot, expected: Partial<UsageAccountingSnapshot>): void {
	for (const [key, value] of Object.entries(expected)) {
		if (typeof value === "number") assert.ok(Math.abs((snapshot as any)[key] - value) < 1e-12, `${key}: ${(snapshot as any)[key]} !== ${value}`);
		else assert.deepEqual((snapshot as any)[key], value, key);
	}
}

console.log("\n--- UsageAccounting ---");

check("retains provider/model/responseModel/operation on an assistant charge", () => {
	const account = new UsageAccounting();
	account.ingestMessageEnd({ type: "message_end", requestId: "identity-request", message: {
		role: "assistant", provider: "gateway", model: "virtual-selected", responseModel: "physical-v2", api: "responses",
		usage: usage(0.03, 3), stopReason: "stop",
	} });
	const charge = account.getCharges()[0];
	assert.equal(charge?.provider, "gateway");
	assert.equal(charge?.model, "virtual-selected");
	assert.equal(charge?.responseModel, "physical-v2");
	assert.equal(charge?.operation, "responses");
	assert.equal(charge?.known, true);
	assert.equal(charge?.attributionComplete, true);
});

check("aggregates native assistant, parent tool, and unknown-kind usage to .73", () => {
	const account = createUsageAccounting();
	account.ingestMessageEnd({ type: "message_end", requestId: "r-assistant", message: {
		role: "assistant", provider: "p", model: "main", api: "chat", usage: usage(0.03, 3, 4), stopReason: "stop",
	} });
	account.ingestEntry({ type: "message", id: "tool-entry", message: {
		role: "toolResult", toolCallId: "call-child", toolName: "flux_agent", usage: usage(0.40, 40), isError: false,
	} });
	account.ingestEntry({ type: "usage", id: "warm-entry", kind: "future_unknown_kind", provider: "p", model: "main", usage: usage(0.30, 30) });
	assertSnapshot(account.snapshot(), { input: 73, cost: 0.73, turns: 1, complete: true, known: true });
});

check("is idempotent for duplicate and out-of-order message_end/session entries", () => {
	const account = new UsageAccounting();
	const message = { role: "assistant", provider: "p", model: "m", responseId: "response-1", usage: usage(0.03, 3), stopReason: "stop" };
	const entry: SessionEntryLike = { type: "message", id: "entry-1", message };
	// The raw session entry arrives first; message_end and a retry of both are aliases.
	account.ingestEntry(entry);
	account.ingestMessageEnd({ type: "message_end", requestId: "request-1", message });
	account.ingestMessageEnd({ type: "message_end", requestId: "request-1", message });
	account.ingestEntry(entry);
	assertSnapshot(account.snapshot(), { input: 3, cost: 0.03, turns: 1, complete: true });
	assert.equal(account.getCharges().length, 1);
});

check("settles a cumulative stream without adding the final message twice", () => {
	const account = new UsageAccounting();
	account.ingestStream({ type: "message_update", requestId: "stream-1", assistantMessageEvent: {
		type: "text_delta", partial: { role: "assistant", provider: "p", model: "m", usage: usage(0.01, 1, 1) },
	} });
	assertSnapshot(account.snapshot(), { input: 1, output: 1, cost: 0.01, turns: 1, provisional: true, complete: false });
	account.ingestStream({ type: "message_update", requestId: "stream-1", assistantMessageEvent: {
		type: "text_delta", partial: { role: "assistant", provider: "p", model: "m", usage: usage(0.03, 3, 4) },
	} });
	assertSnapshot(account.snapshot(), { input: 3, output: 4, cost: 0.03, turns: 1, provisional: true });
	account.ingestStream({ type: "message_update", requestId: "stream-1", assistantMessageEvent: {
		type: "done", message: { role: "assistant", provider: "p", model: "m", responseId: "response-stream-1", usage: usage(0.03, 3, 4), stopReason: "toolUse",
	} } });
	account.ingestEntry({ type: "message", id: "entry-stream-1", message: {
		role: "assistant", provider: "p", model: "m", responseId: "response-stream-1", usage: usage(0.03, 3, 4), stopReason: "toolUse",
	} });
	assertSnapshot(account.snapshot(), { input: 3, output: 4, cost: 0.03, turns: 1, provisional: false, complete: true });
	assert.equal(account.getCharges().length, 1);
});

check("keeps native aggregate for a heterogeneous parent tool instead of applying Main price", () => {
	const table: PricingTable = {
		entries: { main: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, source: "remote" } },
		avg: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "unknown" },
		fetchedAt: 0,
		sourceUrl: "test",
		remoteOk: true,
	};
	const account = new UsageAccounting({ pricing: table, model: "main", provider: "main-provider" });
	account.ingestEntry({ type: "message", id: "tool-mixed", message: {
		role: "toolResult", toolCallId: "call-mixed", toolName: "codemode", usage: usage(0.40, 100, 100),
		nestedCalls: { complete: false }, isError: false,
	} });
	const snapshot = account.snapshot();
	assertSnapshot(snapshot, { input: 100, output: 100, cost: 0.40, complete: true, attributionComplete: false });
	assert.equal(account.getCharges()[0]?.costSource, "native");
});

check("provider-scoped user overrides never price another provider's same ID", () => {
	const table: PricingTable = { entries: {
		"p1/same": { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, source: "user" },
		"p2/same": { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0, source: "user" },
	}, avg: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "unknown" }, fetchedAt: 0, sourceUrl: "test", remoteOk: false };
	for (const [provider, expected] of [["p1", 0.1], ["p2", 0.2], ["p3", 0.03]] as const) {
		const account = new UsageAccounting({ pricing: table });
		account.ingestEntry({ type: "message", id: provider, message: { role: "assistant", provider, model: "same", usage: usage(0.03, 10), stopReason: "stop" } });
		assertSnapshot(account.snapshot(), { cost: expected, complete: true });
	}
});

check("baseline entry IDs exclude inherited fork/resume history", () => {
	const account = new UsageAccounting({ baselineEntryIds: ["old-assistant", "old-usage"] });
	account.ingestEntries([
		{ type: "message", id: "old-assistant", message: { role: "assistant", usage: usage(0.50, 50), provider: "p", model: "m" } },
		{ type: "usage", id: "old-usage", kind: "cache_warm", provider: "p", model: "m", usage: usage(0.25, 25) },
		{ type: "message", id: "new-assistant", message: { role: "assistant", usage: usage(0.03, 3), provider: "p", model: "m" } },
	]);
	assertSnapshot(account.snapshot(), { input: 3, cost: 0.03, turns: 1, complete: true });
});

check("preserves a failed raw request's native usage and cost", () => {
	const account = new UsageAccounting();
	account.ingest({ type: "request_error", requestId: "failed-request", provider: "p", model: "m", usage: usage(0.04, 4, 2), error: "upstream 500" });
	assertSnapshot(account.snapshot(), { input: 4, output: 2, cost: 0.04, turns: 0, complete: true });
});

check("unknown pricing remains visible as incomplete rather than becoming a zero quote", () => {
	const account = new UsageAccounting();
	account.ingestEntry({ type: "usage", id: "unknown-charge", kind: "provider_future_operation", provider: "unknown-provider", model: "unknown-model", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } });
	assertSnapshot(account.snapshot(), { input: 10, output: 2, cost: 0, known: false, complete: false });
	assert.equal(account.getCharges()[0]?.costSource, "unknown");
});

check("counts compaction and branch-summary usage once, including cacheWrite1h only once", () => {
	const account = new UsageAccounting();
	account.ingestEntries([
		{ type: "compaction", id: "compact-1", summary: "summary", firstKeptEntryId: "kept", tokensBefore: 100, usage: usage(0.10, 10, 5, { cacheWrite: 20, cacheWrite1h: 20, reasoning: 5 }) },
		{ type: "branch_summary", id: "branch-1", fromId: "old", summary: "branch", usage: usage(0.20, 20, 5) },
	]);
	assertSnapshot(account.snapshot(), { input: 30, output: 10, cacheWrite: 20, cost: 0.30, turns: 0, complete: true, attributionComplete: false });
	account.ingestEntry({ type: "compaction", id: "compact-1", summary: "summary", firstKeptEntryId: "kept", tokensBefore: 100, usage: usage(0.10, 10, 5, { cacheWrite: 20, cacheWrite1h: 20, reasoning: 5 }) });
	assert.ok(Math.abs(account.snapshot().cost - 0.30) < 1e-12);
});

check("invocation alias prevents an already aggregated child receipt from charging twice", () => {
	const account = new UsageAccounting();
	account.aliasInvocation({ invocationId: "child-run-1", toolCallId: "tool-call-1" });
	account.ingestInvocation("child-run-1", { usage: usage(0.40, 40), model: "child-model", provider: "child-provider" });
	account.ingestEntry({ type: "message", id: "tool-entry-1", message: {
		role: "toolResult", toolCallId: "tool-call-1", toolName: "flux_agent", usage: usage(0.40, 40), isError: false,
	} });
	assertSnapshot(account.snapshot(), { input: 40, cost: 0.40, complete: true });
	assert.equal(account.getCharges().length, 1);
});

check("distinct entry IDs with identical responses are separate charges", () => {
	const account = new UsageAccounting();
	const message = { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "OK" }], usage: usage(0.03, 3), stopReason: "stop" };
	account.ingestEntries([{ type: "message", id: "same-1", message }, { type: "message", id: "same-2", message }]);
	account.ingestEntries([{ type: "message", id: "same-2", message }, { type: "message", id: "same-1", message }]);
	assertSnapshot(account.snapshot(), { cost: 0.06, input: 6, turns: 2, complete: true });
});
check("delta-only JSON top-level cumulative usage settles once", () => {
	const account = new UsageAccounting();
	account.ingestStream({ type: "message_update", usage: usage(0.01, 3), assistantMessageEvent: { type: "text_delta", delta: "O" } }, { sourceId: "wire-1" });
	assertSnapshot(account.snapshot(), { cost: 0.01, input: 3, complete: false, provisional: true });
	const message = { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "OK" }], usage: usage(0.03, 3), stopReason: "stop" };
	account.ingestMessageEnd({ type: "message_end", message }, { sourceId: "wire-1" });
	account.ingestEntry({ type: "message", id: "wire-entry-1", message });
	assertSnapshot(account.snapshot(), { cost: 0.03, input: 3, turns: 1, complete: true });
});

console.log(`\n=== Usage Accounting Tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
