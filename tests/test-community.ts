/**
 * Comprehensive unit tests for src/core/community.ts
 * Covers: CRUD operations, edge cases, error handling
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createIssue,
	commentOnIssue,
	claimIssue,
	deleteIssue,
	submitClaim,
	reviewClaim,
	resolveIssue,
	listIssues,
	getIssue,
	formatIssue,
	formatIssueTimeline,
	nextActions,
} from "../src/core/community";

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

const root = mkdtempSync(join(tmpdir(), "agentflux-community-test-"));

try {
	// ─── createIssue ─────────────────────────────────────────────────

	console.log("\n--- createIssue ---");

	check("creates a valid issue with required fields", () => {
		const issue = createIssue(root, { title: "Test Issue", description: "Test description" });
		assert.ok(issue.id.startsWith("issue-"));
		assert.strictEqual(issue.title, "Test Issue");
		assert.strictEqual(issue.description, "Test description");
		assert.strictEqual(issue.status, "open");
		assert.strictEqual(issue.createdBy, "main");
		assert.strictEqual(issue.comments.length, 0);
		assert.strictEqual(issue.claims.length, 0);
	});

	check("trims title whitespace", () => {
		const issue = createIssue(root, { title: "  Trimmed Title  ", description: "desc" });
		assert.strictEqual(issue.title, "Trimmed Title");
	});

	check("trims description whitespace", () => {
		const issue = createIssue(root, { title: "Title", description: "  desc  " });
		assert.strictEqual(issue.description, "desc");
	});

	check("throws on empty title", () => {
		assert.throws(() => createIssue(root, { title: "", description: "desc" }), /empty/);
	});

	check("throws on whitespace-only title", () => {
		assert.throws(() => createIssue(root, { title: "   ", description: "desc" }), /empty/);
	});

	check("accepts custom createdBy", () => {
		const issue = createIssue(root, { title: "Custom Creator", description: "desc", createdBy: "planner" });
		assert.strictEqual(issue.createdBy, "planner");
	});

	check("accepts acceptance criteria", () => {
		const issue = createIssue(root, {
			title: "With Criteria", description: "desc",
			acceptanceCriteria: ["must pass tests", "must be reviewed"],
		});
		assert.deepStrictEqual(issue.acceptanceCriteria, ["must pass tests", "must be reviewed"]);
	});

	// ─── listIssues / getIssue ──────────────────────────────────────

	console.log("\n--- listIssues / getIssue ---");

	check("lists all created issues", () => {
		const issues = listIssues(root);
		assert.ok(issues.length >= 3);
	});

	check("getIssue returns correct issue by id", () => {
		const issues = listIssues(root);
		const first = issues[0];
		const found = getIssue(root, first.id);
		assert.strictEqual(found?.id, first.id);
	});

	check("getIssue returns undefined for non-existent id", () => {
		assert.strictEqual(getIssue(root, "non-existent"), undefined);
	});

	// ─── commentOnIssue ─────────────────────────────────────────────

	console.log("\n--- commentOnIssue ---");

	check("adds a comment to an issue", () => {
		const issues = listIssues(root);
		const issue = issues[0];
		const updated = commentOnIssue(root, issue.id, "reviewer", "Looks good!");
		assert.strictEqual(updated.comments.length, 1);
		assert.strictEqual(updated.comments[0].author, "reviewer");
		assert.strictEqual(updated.comments[0].body, "Looks good!");
	});

	check("trims comment body", () => {
		const issues = listIssues(root);
		const issue = issues[0];
		const updated = commentOnIssue(root, issue.id, "tester", "  Needs work  ");
		const lastComment = updated.comments[updated.comments.length - 1];
		assert.strictEqual(lastComment.body, "Needs work");
	});

	check("throws on non-existent issue for comment", () => {
		assert.throws(() => commentOnIssue(root, "non-existent", "user", "comment"), /not found/);
	});

	// ─── claimIssue ─────────────────────────────────────────────────

	console.log("\n--- claimIssue ---");

	check("claims a scope on an issue", () => {
		const issue = createIssue(root, { title: "Claimable", description: "desc" });
		const claimed = claimIssue(root, issue.id, "implementer", "src/core");
		assert.strictEqual(claimed.status, "executing");
		assert.strictEqual(claimed.claims.length, 1);
		assert.strictEqual(claimed.claims[0].agent, "implementer");
		assert.strictEqual(claimed.claims[0].scope, "src/core");
		assert.strictEqual(claimed.claims[0].status, "active");
	});

	check("throws on duplicate claim for same scope", () => {
		const issue = createIssue(root, { title: "Duplicate Claim", description: "desc" });
		claimIssue(root, issue.id, "agent1", "scope1");
		assert.throws(() => claimIssue(root, issue.id, "agent2", "scope1"), /already claimed/);
	});

	check("allows different scopes to be claimed by different agents", () => {
		const issue = createIssue(root, { title: "Multi Scope", description: "desc" });
		claimIssue(root, issue.id, "agent1", "scope-a");
		claimIssue(root, issue.id, "agent2", "scope-b");
		const updated = getIssue(root, issue.id)!;
		assert.strictEqual(updated.claims.length, 2);
	});

	check("throws on non-existent issue for claim", () => {
		assert.throws(() => claimIssue(root, "non-existent", "agent", "scope"), /not found/);
	});

	// ─── submitClaim ────────────────────────────────────────────────

	console.log("\n--- submitClaim ---");

	check("submits an active claim", () => {
		const issue = createIssue(root, { title: "Submittable", description: "desc" });
		claimIssue(root, issue.id, "agent1", "scope");
		const claim = getIssue(root, issue.id)!.claims[0];
		const submitted = submitClaim(root, issue.id, claim.id);
		assert.strictEqual(submitted.status, "reviewing");
		const updatedClaim = submitted.claims.find(c => c.id === claim.id)!;
		assert.strictEqual(updatedClaim.status, "submitted");
	});

	check("throws on non-existent claim", () => {
		const issue = createIssue(root, { title: "Bad Claim", description: "desc" });
		assert.throws(() => submitClaim(root, issue.id, "non-existent"), /not found/);
	});

	check("throws on non-existent issue for submit", () => {
		assert.throws(() => submitClaim(root, "non-existent", "claim-1"), /not found/);
	});

	// ─── resolveIssue ───────────────────────────────────────────────

	// ─── deleteIssue ────────────────────────────────────────────────

	console.log("\n--- deleteIssue ---");

	check("deletes an open issue with no claims", () => {
		const issue = createIssue(root, { title: "To Delete", description: "desc" });
		const removed = deleteIssue(root, issue.id);
		assert.strictEqual(removed.id, issue.id);
		assert.strictEqual(listIssues(root).some(item => item.id === issue.id), false);
	});

	check("deletes a resolved issue", () => {
		const issue = createIssue(root, { title: "Done", description: "desc" });
		claimIssue(root, issue.id, "agent", "scope");
		const claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "pass", "main");
		resolveIssue(root, issue.id);
		const removed = deleteIssue(root, issue.id);
		assert.strictEqual(removed.status, "resolved");
	});

	check("delete rejects while a claim is active or submitted", () => {
		const issue = createIssue(root, { title: "Active Claim", description: "desc" });
		claimIssue(root, issue.id, "agent", "scope");
		assert.throws(() => deleteIssue(root, issue.id), /active or submitted claims/);
		const claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		assert.throws(() => deleteIssue(root, issue.id), /active or submitted claims/);
	});

	check("delete rejects executing issues without claims", () => {
		const issue = createIssue(root, { title: "Executing", description: "desc" });
		const raw = JSON.parse(readFileSync(join(root, ".agentflux", "issues.json"), "utf-8"));
		raw.issues.find((item: any) => item.id === issue.id).status = "executing";
		writeFileSync(join(root, ".agentflux", "issues.json"), JSON.stringify(raw));
		assert.throws(() => deleteIssue(root, issue.id), /Only resolved or open issues/);
	});

	// ─── resolveIssue ───────────────────────────────────────────────

	console.log("\n--- resolveIssue ---");

	check("resolves an issue with no active claims", () => {
		const issue = createIssue(root, { title: "Resolvable", description: "desc" });
		const resolved = resolveIssue(root, issue.id);
		assert.strictEqual(resolved.status, "resolved");
	});

	check("resolves an issue with all reviewed claims", () => {
		const issue = createIssue(root, { title: "Completed Claims", description: "desc" });
		claimIssue(root, issue.id, "agent", "scope");
		const claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "pass", "main");
		const resolved = resolveIssue(root, issue.id);
		assert.strictEqual(resolved.status, "resolved");
	});

	check("resolve rejects while a claim is submitted (awaiting review)", () => {
		const issue = createIssue(root, { title: "Pending Review", description: "desc" });
		claimIssue(root, issue.id, "agent", "scope");
		const claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		assert.throws(() => resolveIssue(root, issue.id), /active or submitted claims/);
	});

	check("timeline records the full issue room lifecycle", () => {
		const issue = createIssue(root, { title: "Timeline", description: "desc" });
		commentOnIssue(root, issue.id, "worker-a", "let me handle this");
		claimIssue(root, issue.id, "worker-a", "scope-a");
		claimIssue(root, issue.id, "worker-b", "scope-b");
		const claims = getIssue(root, issue.id)!.claims;
		submitClaim(root, issue.id, claims[0].id);
		submitClaim(root, issue.id, claims[1].id);
		reviewClaim(root, issue.id, claims[0].id, "pass", "main");
		reviewClaim(root, issue.id, claims[1].id, "rework", "main", "please add tests");
		const final = getIssue(root, issue.id)!;
		assert.strictEqual(final.status, "executing"); // rework 退回
		assert.strictEqual(final.claims[1].status, "active");
		const types = final.timeline.map(event => event.type);
		assert.deepStrictEqual(types, ["created", "commented", "claimed", "claimed", "submitted", "submitted", "reviewed", "reworked"]);
	});

	check("nextActions derives deterministic state-machine steps", () => {
		const issue = createIssue(root, { title: "Next", description: "desc" });
		assert.deepStrictEqual(nextActions(issue), ["propose a plan: flux_issue propose <id> <title> <body>", "claim scope: flux_issue claim <id> <agent> <scope> [--plan <text>]"]);
		claimIssue(root, issue.id, "agent", "scope");
		const withClaim = getIssue(root, issue.id)!;
		assert.deepStrictEqual(nextActions(withClaim), ["submit claim: flux_issue submit <id> <claimId>"]);
		submitClaim(root, issue.id, withClaim.claims[0].id);
		const pending = getIssue(root, issue.id)!;
		assert.ok(pending.timeline.length === 3 && pending.status === "reviewing");
		assert.deepStrictEqual(nextActions(pending), ["review claim: flux_issue review <id> <claimId> pass|rework [feedback]"]);
	});

	check("terminal state is protected: claim after resolve throws and status stays resolved", () => {
		const issue = createIssue(root, { title: "Terminal", description: "desc" });
		claimIssue(root, issue.id, "agent", "scope");
		const claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "pass", "main");
		resolveIssue(root, issue.id);
		assert.throws(() => claimIssue(root, issue.id, "other", "scope2"), /already resolved and immutable/);
		assert.strictEqual(getIssue(root, issue.id)!.status, "resolved");
	});

	check("terminal state is protected: comment after resolve throws", () => {
		const issue = createIssue(root, { title: "Terminal", description: "desc" });
		resolveIssue(root, issue.id);
		assert.throws(() => commentOnIssue(root, issue.id, "main", "late comment"), /already resolved and immutable/);
		assert.strictEqual(getIssue(root, issue.id)!.comments.length, 0);
	});

	check("terminal state is protected: submit after resolve throws", () => {
		const issue = createIssue(root, { title: "Terminal", description: "desc" });
		claimIssue(root, issue.id, "agent", "scope");
		const claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "pass", "main");
		resolveIssue(root, issue.id);
		assert.throws(() => submitClaim(root, issue.id, claim.id), /already resolved and immutable/);
		assert.strictEqual(getIssue(root, issue.id)!.status, "resolved");
	});

	check("terminal state is protected: resolve after resolve throws", () => {
		const issue = createIssue(root, { title: "Terminal", description: "desc" });
		resolveIssue(root, issue.id);
		assert.throws(() => resolveIssue(root, issue.id), /already resolved and immutable/);
	});

	check("throws when resolving with active claims", () => {
		const issue = createIssue(root, { title: "Active Claim Block", description: "desc" });
		claimIssue(root, issue.id, "agent", "scope");
		assert.throws(() => resolveIssue(root, issue.id), /active or submitted claims/);
	});

	check("throws on non-existent issue for resolve", () => {
		assert.throws(() => resolveIssue(root, "non-existent"), /not found/);
	});

	// ─── formatIssue ────────────────────────────────────────────────

	console.log("\n--- formatIssue ---");

	check("formats an issue with basic fields", () => {
		const issue = createIssue(root, { title: "Formatted", description: "desc" });
		const formatted = formatIssue(issue);
		assert.ok(formatted.includes(issue.id));
		assert.ok(formatted.includes("open"));
		assert.ok(formatted.includes("Formatted"));
	});

	check("formats an issue with claims", () => {
		const issue = createIssue(root, { title: "With Claims", description: "desc" });
		claimIssue(root, issue.id, "implementer", "src");
		const formatted = formatIssue(getIssue(root, issue.id)!);
		assert.ok(formatted.includes("implementer"));
		assert.ok(formatted.includes("src"));
	});

	console.log("\n--- legacy issues.json migration ---");

	const legacyRoot = mkdtempSync(join(tmpdir(), "agentflux-community-legacy-"));
	try {
		const legacyIssuesPath = join(legacyRoot, ".agentflux", "issues.json");
		const legacyIssues = [
			{
				id: "iss_mr3mav9p_aifgpq",
				title: "sessions下的搜索过滤按钮超出父容器范围",
				status: "open",
				priority: "high",
				created: 1783003590349,
				updated: 1783003590349,
				tags: ["ui"],
			},
			{
				id: "iss_closed_legacy",
				title: "already closed issue",
				status: "closed",
			},
		];
		mkdirSync(join(legacyRoot, ".agentflux"), { recursive: true });
		writeFileSync(legacyIssuesPath, JSON.stringify(legacyIssues));

		check("legacy array issues.json is migrated to current store shape on read", () => {
			const issues = listIssues(legacyRoot);
			assert.strictEqual(issues.length, 2);
			assert.strictEqual(issues[0].id, "iss_mr3mav9p_aifgpq");
			assert.strictEqual(issues[0].title, "sessions下的搜索过滤按钮超出父容器范围");
			assert.strictEqual(issues[0].status, "open");
			assert.ok(issues[0].description.includes("priority: high"));
			assert.ok(issues[0].description.includes("tags: ui"));
			assert.strictEqual(issues[1].status, "resolved");
		});

		check("migrated store is rewritten as object shape and backed up", () => {
			const store = JSON.parse(readFileSync(legacyIssuesPath, "utf-8"));
			assert.ok(Array.isArray(store.issues) && !Array.isArray(store));
			assert.ok(readFileSync(join(legacyRoot, ".agentflux", "issues.json.bak"), "utf-8").includes("iss_mr3mav9p_aifgpq"));
		});

		check("migrated issues remain writable through the normal update path", () => {
			const issue = commentOnIssue(legacyRoot, "iss_mr3mav9p_aifgpq", "main", "after migration");
			assert.strictEqual(issue.comments.length, 1);
			const store = JSON.parse(readFileSync(legacyIssuesPath, "utf-8"));
			assert.strictEqual(store.issues[0].comments.length, 1);
		});
	} finally {
		rmSync(legacyRoot, { recursive: true, force: true });
	}

	const issueCountBeforeConcurrency = listIssues(root).length;
	const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
	const worker = resolve("tests/helpers/transactional-store-worker.ts");
	await Promise.all(Array.from({ length: 4 }, (_, workerIndex) => new Promise<void>((resolveWorker, rejectWorker) => {
		const child = spawn(process.execPath, [tsxCli, worker, "issue", root, `w${workerIndex}`, "10"], {
			cwd: process.cwd(),
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", chunk => { stderr += chunk.toString(); });
		child.on("error", rejectWorker);
		child.on("exit", code => code === 0 ? resolveWorker() : rejectWorker(new Error(`issue store worker exited ${code}: ${stderr}`)));
	})));
	check("concurrent issue writers preserve every issue", () => {
		assert.strictEqual(listIssues(root).length, issueCountBeforeConcurrency + 40);
	});

	console.log(`\n=== Community Tests: ${passed} passed, ${failed} failed ===`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
if (failed > 0) process.exit(1);
