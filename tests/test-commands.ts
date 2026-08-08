/**
 * Comprehensive unit tests for src/extension/commands.ts
 * Covers: parseFluxCommand, getFluxArgumentCompletions, FLUX_HELP
 */
import { strict as assert } from "node:assert";
import { parseFluxCommand, getFluxArgumentCompletions, type FluxCommand } from "../src/extension/commands";

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

// ─── parseFluxCommand ─────────────────────────────────────────────────

console.log("\n--- parseFluxCommand ---");

check("parses 'help' command", () => {
	const cmd = parseFluxCommand("help");
	assert.strictEqual(cmd.kind, "help");
});

check("parses empty string as help", () => {
	const cmd = parseFluxCommand("");
	assert.strictEqual(cmd.kind, "help");
});

check("parses whitespace-only as help", () => {
	const cmd = parseFluxCommand("   ");
	assert.strictEqual(cmd.kind, "help");
});

check("parses 'work direct <task>'", () => {
	const cmd = parseFluxCommand("work direct implement login");
	assert.strictEqual(cmd.kind, "work");
	if (cmd.kind === "work") {
		assert.strictEqual(cmd.style, "direct");
		assert.strictEqual(cmd.task, "implement login");
	}
});

check("parses 'work team <task>'", () => {
	const cmd = parseFluxCommand("work team design system");
	assert.strictEqual(cmd.kind, "work");
	if (cmd.kind === "work") {
		assert.strictEqual(cmd.style, "team");
		assert.strictEqual(cmd.task, "design system");
	}
});

check("parses 'work workflow <task>'", () => {
	const cmd = parseFluxCommand("work workflow deploy pipeline");
	assert.strictEqual(cmd.kind, "work");
	if (cmd.kind === "work") {
		assert.strictEqual(cmd.style, "workflow");
		assert.strictEqual(cmd.task, "deploy pipeline");
	}
});

check("parses 'work community <task>'", () => {
	const cmd = parseFluxCommand("work community fix coordination");
	assert.strictEqual(cmd.kind, "work");
	if (cmd.kind === "work") {
		assert.strictEqual(cmd.style, "community");
		assert.strictEqual(cmd.task, "fix coordination");
	}
});

check("rejects invalid work style", () => {
	assert.throws(() => parseFluxCommand("work M2 legacy"), /Usage/);
	assert.throws(() => parseFluxCommand("work invalid task"), /Usage/);
});

check("rejects work command without task", () => {
	assert.throws(() => parseFluxCommand("work direct"), /cannot be empty/);
});

check("parses 'task list'", () => {
	const cmd = parseFluxCommand("task list");
	assert.strictEqual(cmd.kind, "task");
	if (cmd.kind === "task") {
		assert.deepStrictEqual(cmd.args, ["list"]);
	}
});

check("parses 'task show <id>'", () => {
	const cmd = parseFluxCommand("task show task-123");
	assert.strictEqual(cmd.kind, "task");
	if (cmd.kind === "task") {
		assert.deepStrictEqual(cmd.args, ["show", "task-123"]);
	}
});

check("parses 'task continue <id> <task text>'", () => {
	const cmd = parseFluxCommand("task continue task-123 follow up work");
	assert.strictEqual(cmd.kind, "task");
	if (cmd.kind === "task") {
		assert.deepStrictEqual(cmd.args, ["continue", "task-123", "follow", "up", "work"]);
	}
});

check("parses 'agent list'", () => {
	const cmd = parseFluxCommand("agent list");
	assert.strictEqual(cmd.kind, "agent");
	if (cmd.kind === "agent") {
		assert.deepStrictEqual(cmd.args, ["list"]);
	}
});

check("parses 'agent create <name> <role>'", () => {
	const cmd = parseFluxCommand("agent create reviewer-1 reviewer");
	assert.strictEqual(cmd.kind, "agent");
	if (cmd.kind === "agent") {
		assert.deepStrictEqual(cmd.args, ["create", "reviewer-1", "reviewer"]);
	}
});

check("parses 'agent run <name> <task>'", () => {
	const cmd = parseFluxCommand("agent run assistant implement feature");
	assert.strictEqual(cmd.kind, "agent");
	if (cmd.kind === "agent") {
		assert.deepStrictEqual(cmd.args, ["run", "assistant", "implement", "feature"]);
	}
});

check("parses 'agent archive <name>'", () => {
	const cmd = parseFluxCommand("agent archive old-agent");
	assert.strictEqual(cmd.kind, "agent");
	if (cmd.kind === "agent") {
		assert.deepStrictEqual(cmd.args, ["archive", "old-agent"]);
	}
});

check("parses 'fork last'", () => {
	const cmd = parseFluxCommand("fork last");
	assert.strictEqual(cmd.kind, "fork");
	if (cmd.kind === "fork") {
		assert.deepStrictEqual(cmd.args, ["last"]);
	}
});

check("parses 'fork <entryId>'", () => {
	const cmd = parseFluxCommand("fork abc123def456");
	assert.strictEqual(cmd.kind, "fork");
	if (cmd.kind === "fork") {
		assert.deepStrictEqual(cmd.args, ["abc123def456"]);
	}
});

check("parses 'issue list'", () => {
	const cmd = parseFluxCommand("issue list");
	assert.strictEqual(cmd.kind, "issue");
	if (cmd.kind === "issue") {
		assert.deepStrictEqual(cmd.args, ["list"]);
	}
});

check("parses 'issue create <title>'", () => {
	const cmd = parseFluxCommand("issue create Fix login bug");
	assert.strictEqual(cmd.kind, "issue");
	if (cmd.kind === "issue") {
		assert.deepStrictEqual(cmd.args, ["create", "Fix", "login", "bug"]);
	}
});

check("parses 'issue show <id>'", () => {
	const cmd = parseFluxCommand("issue show issue-123");
	assert.strictEqual(cmd.kind, "issue");
	if (cmd.kind === "issue") {
		assert.deepStrictEqual(cmd.args, ["show", "issue-123"]);
	}
});

check("parses 'issue comment <id> <text>'", () => {
	const cmd = parseFluxCommand("issue comment issue-123 looks good to me");
	assert.strictEqual(cmd.kind, "issue");
	if (cmd.kind === "issue") {
		assert.deepStrictEqual(cmd.args, ["comment", "issue-123", "looks", "good", "to", "me"]);
	}
});

check("parses 'issue claim <id> <agent> <scope>'", () => {
	const cmd = parseFluxCommand("issue claim issue-123 implementer src/core");
	assert.strictEqual(cmd.kind, "issue");
	if (cmd.kind === "issue") {
		assert.deepStrictEqual(cmd.args, ["claim", "issue-123", "implementer", "src/core"]);
	}
});

check("parses 'issue submit <id> <claimId>'", () => {
	const cmd = parseFluxCommand("issue submit issue-123 claim-456");
	assert.strictEqual(cmd.kind, "issue");
	if (cmd.kind === "issue") {
		assert.deepStrictEqual(cmd.args, ["submit", "issue-123", "claim-456"]);
	}
});

check("parses 'issue resolve <id>'", () => {
	const cmd = parseFluxCommand("issue resolve issue-123");
	assert.strictEqual(cmd.kind, "issue");
	if (cmd.kind === "issue") {
		assert.deepStrictEqual(cmd.args, ["resolve", "issue-123"]);
	}
});

check("parses 'message <target> <text>'", () => {
	const cmd = parseFluxCommand("message reviewer-1 please review this");
	assert.strictEqual(cmd.kind, "message");
	if (cmd.kind === "message") {
		assert.strictEqual(cmd.target, "reviewer-1");
		assert.strictEqual(cmd.text, "please review this");
	}
});

check("rejects message without target", () => {
	assert.throws(() => parseFluxCommand("message"), /Usage/);
});

check("rejects message with only target", () => {
	assert.throws(() => parseFluxCommand("message agent1"), /Usage/);
});

check("parses 'cancel' without taskId", () => {
	const cmd = parseFluxCommand("cancel");
	assert.strictEqual(cmd.kind, "cancel");
	if (cmd.kind === "cancel") {
		assert.strictEqual(cmd.taskId, undefined);
	}
});

check("parses 'cancel <taskId>'", () => {
	const cmd = parseFluxCommand("cancel task-123");
	assert.strictEqual(cmd.kind, "cancel");
	if (cmd.kind === "cancel") {
		assert.strictEqual(cmd.taskId, "task-123");
	}
});

check("parses 'gc' without dry-run", () => {
	const cmd = parseFluxCommand("gc");
	assert.strictEqual(cmd.kind, "gc");
	if (cmd.kind === "gc") {
		assert.strictEqual(cmd.dryRun, false);
	}
});

check("parses 'gc dry-run'", () => {
	const cmd = parseFluxCommand("gc dry-run");
	assert.strictEqual(cmd.kind, "gc");
	if (cmd.kind === "gc") {
		assert.strictEqual(cmd.dryRun, true);
	}
});

check("rejects invalid gc subcommand", () => {
	assert.throws(() => parseFluxCommand("gc run"), /Usage/);
});

check("parses 'status'", () => {
	const cmd = parseFluxCommand("status");
	assert.strictEqual(cmd.kind, "status");
});

check("parses 'compact'", () => {
	const cmd = parseFluxCommand("compact");
	assert.strictEqual(cmd.kind, "compact");
});

check("rejects unknown top-level command", () => {
	assert.throws(() => parseFluxCommand("unknown_cmd"), /Unknown/);
});

// ─── getFluxArgumentCompletions ───────────────────────────────────────

console.log("\n--- getFluxArgumentCompletions ---");

check("returns top-level completions for empty prefix", () => {
	const result = getFluxArgumentCompletions("");
	assert.ok(result !== null);
	assert.ok(result!.some(item => item.value === "work"));
	assert.ok(result!.some(item => item.value === "help"));
});

check("returns null for exact top-level match", () => {
	const result = getFluxArgumentCompletions("work");
	assert.strictEqual(result, null);
});

check("returns filtered top-level completions", () => {
	const result = getFluxArgumentCompletions("w");
	assert.ok(result !== null);
	assert.ok(result!.every(item => item.value.startsWith("w")));
	assert.ok(result!.some(item => item.value === "work"));
});

check("returns work subcommand completions", () => {
	const result = getFluxArgumentCompletions("work ");
	assert.ok(result !== null);
	assert.ok(result!.some(item => item.value === "work direct"));
	assert.ok(result!.some(item => item.value === "work team"));
});

check("returns task subcommand completions", () => {
	const result = getFluxArgumentCompletions("task ");
	assert.ok(result !== null);
	assert.ok(result!.some(item => item.value === "task list"));
});

check("returns agent subcommand completions", () => {
	const result = getFluxArgumentCompletions("agent ");
	assert.ok(result !== null);
	assert.ok(result!.some(item => item.value === "agent list"));
});

check("returns issue subcommand completions", () => {
	const result = getFluxArgumentCompletions("issue ");
	assert.ok(result !== null);
	assert.ok(result!.some(item => item.value === "issue list"));
});

check("returns fork subcommand completions", () => {
	const result = getFluxArgumentCompletions("fork ");
	assert.ok(result !== null);
	assert.ok(result!.some(item => item.value === "fork last"));
});

check("returns gc subcommand completions", () => {
	const result = getFluxArgumentCompletions("gc ");
	assert.ok(result !== null);
	assert.ok(result!.some(item => item.value === "gc dry-run"));
});

check("returns null for unknown prefix with no space", () => {
	const result = getFluxArgumentCompletions("zzz_not_exists");
	assert.strictEqual(result, null);
});

console.log(`\n=== Commands Tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
