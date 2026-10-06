import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActiveContext } from "../src/core/active-context";
import {
	claimIssue,
	deleteIssue,
	commentOnIssue,
	createIssue,
	formatIssue,
	getIssue,
	nextActions,
	opposeProposal,
	proposeIssue,
	resolveIssue,
	reviewClaim,
	setCommunityLimits,
	submitClaim,
	supportProposal,
} from "../src/core/community";

/**
 * 社区协作 3b（docs/33 第七章）确定性测试：
 * 提案生命周期、认领多提案绑定与方案总结、停止条件门禁（无进展/预算/轮次）、
 * 解决理由落档、时间线事件完整。
 */
const root = mkdtempSync(join(tmpdir(), "agentflux-community-3b-"));
let passed = 0;

function check(description: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  \u2713 ${description}`);
	} catch (error: any) {
		console.error(`  \u2717 ${description}\n    ${error?.stack ?? error}`);
		process.exitCode = 1;
	}
}

// 门禁测试用独立参数，避免污染其他用例的默认值
setCommunityLimits({ stallThreshold: 3, maxCostPerTask: 2, maxRounds: 5 });

try {
	// ─── 提案生命周期 ──────────────────────────────────────────────

	console.log("\n--- proposals ---");

	check("proposeIssue creates a proposal with empty support/oppose lists", () => {
		const issue = createIssue(root, { title: "Cache Tuning", description: "pick a strategy" });
		const after = proposeIssue(root, issue.id, { title: "Prefix-first", body: "reorder prefix layout", createdBy: "planner" });
		const proposal = after.proposals[0];
		assert.ok(proposal.id.startsWith("proposal-"));
		assert.strictEqual(proposal.title, "Prefix-first");
		assert.strictEqual(proposal.createdBy, "planner");
		assert.deepEqual(proposal.supporters, []);
		assert.deepEqual(proposal.opposers, []);
		assert.ok(after.timeline.some(event => event.type === "proposed"));
	});

	check("proposeIssue rejects an empty title", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		assert.throws(() => proposeIssue(root, issue.id, { title: "  ", body: "x" }), /title cannot be empty/);
	});

	check("support adds an actor and dedupes; same actor cannot support twice", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		const after = proposeIssue(root, issue.id, { title: "Plan A", body: "a" });
		const pid = after.proposals[0].id;
		const supported = supportProposal(root, issue.id, pid, "worker-1");
		assert.ok(supported.proposals[0].supporters.includes("worker-1"));
		assert.ok(supported.timeline.some(event => event.type === "supported"));
		assert.throws(() => supportProposal(root, issue.id, pid, "worker-1"), /Already supported/);
	});

	check("same actor cannot both support and oppose", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		const after = proposeIssue(root, issue.id, { title: "Plan B", body: "b" });
		const pid = after.proposals[0].id;
		supportProposal(root, issue.id, pid, "worker-2");
		assert.throws(() => opposeProposal(root, issue.id, pid, "worker-2"), /already supports/);
	});

	check("support/oppose reject missing proposals", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		assert.throws(() => supportProposal(root, issue.id, "proposal-nope", "x"), /Proposal not found/);
		assert.throws(() => opposeProposal(root, issue.id, "proposal-nope", "x"), /Proposal not found/);
	});

	// ─── 认领多提案绑定与方案总结 ──────────────────────────────────

	console.log("\n--- claim with proposals + plan ---");

	check("claim binds multiple proposals and records the plan", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		const withProps = proposeIssue(root, issue.id, { title: "A", body: "a" });
		const p1 = withProps.proposals[0].id;
		const withProps2 = proposeIssue(root, issue.id, { title: "B", body: "b" });
		const p2 = withProps2.proposals[1].id;
		const claimed = claimIssue(root, issue.id, "agent-x", "scope-a", { proposalIds: [p1, p2], plan: "merge A and B" });
		const claim = claimed.claims[0];
		assert.deepEqual(claim.proposalIds, [p1, p2]);
		assert.strictEqual(claim.plan, "merge A and B");
		assert.ok(claimed.timeline.some(event => event.type === "claimed" && event.detail.includes(p1) && event.detail.includes(p2)));
	});

	check("claim rejects a non-existent proposal binding", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		assert.throws(() => claimIssue(root, issue.id, "a", "s", { proposalIds: ["proposal-missing"] }), /Proposal not found/);
	});

	check("submit can refine the plan and records it in the timeline", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		const claimed = claimIssue(root, issue.id, "a", "s", { plan: "initial plan" });
		const submitted = submitClaim(root, issue.id, claimed.claims[0].id, "refined plan after execution");
		assert.strictEqual(submitted.claims[0].plan, "refined plan after execution");
		const evt = submitted.timeline.find(event => event.type === "submitted");
		assert.ok(evt && evt.detail.includes("refined plan after execution"));
	});

	// ─── 解决理由落档 ──────────────────────────────────────────────

	console.log("\n--- resolve with reason ---");

	check("resolve with a reason stores resolvedReason and records it in the timeline", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		const claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "pass", "main");
		const resolved = resolveIssue(root, issue.id, "adopted plan A with cache read 95%");
		assert.strictEqual(resolved.status, "resolved");
		assert.strictEqual(resolved.resolvedReason, "adopted plan A with cache read 95%");
		const evt = resolved.timeline.find(event => event.type === "resolved");
		assert.ok(evt && evt.detail.includes("adopted plan A"));
		assert.ok(formatIssue(resolved).includes("resolved reason:"));
	});

	check("resolve without a reason still works (reason optional)", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		const claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "pass", "main");
		const resolved = resolveIssue(root, issue.id);
		assert.strictEqual(resolved.status, "resolved");
		assert.strictEqual(resolved.resolvedReason, undefined);
	});

	// ─── 停止条件：无进展（连续退回无新反馈） ───────────────────────

	console.log("\n--- stall guard ---");

	check("rework with empty feedback accumulates stallStreak", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		let claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "");
		// 第一次空反馈退回 → streak 1
		claim = getIssue(root, issue.id)!.claims[0];
		assert.strictEqual(getIssue(root, issue.id)!.stallStreak, 1);
		// 第二次仍空反馈 → streak 2，允许（未达阈值 3）
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "");
		assert.strictEqual(getIssue(root, issue.id)!.stallStreak, 2);
		// 第三次空反馈 → streak 3 落盘（达到阈值）；后续 submit/claim 被拒
		claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "");
		assert.strictEqual(getIssue(root, issue.id)!.stallStreak, 3);
		assert.throws(() => submitClaim(root, issue.id, claim.id), /no progress/);
		assert.throws(() => claimIssue(root, issue.id, "b", "s2"), /no progress/);
	});

	check("rework with repeated identical feedback also accumulates stall", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		let claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "needs more detail");
		claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "needs more detail");
		claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "needs more detail");
		assert.strictEqual(getIssue(root, issue.id)!.stallStreak, 3);
		assert.throws(() => submitClaim(root, issue.id, claim.id), /no progress/);
	});

	check("new distinct feedback resets the stall streak", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		let claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "feedback one");
		claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "feedback two");
		assert.strictEqual(getIssue(root, issue.id)!.stallStreak, 1);
	});

	check("pass resets the stall streak; claim/submit are blocked once stalled", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		let claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "same");
		claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "same");
		claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		// 已有 streak 2；第三次提交时评审以 pass 放行 → streak 重置
		reviewClaim(root, issue.id, claim.id, "pass", "reviewer");
		assert.strictEqual(getIssue(root, issue.id)!.stallStreak, 0);
		// 新认领走新的 3 次空反馈退回达到阈值 → 后续 claim 被拒绝
		claimIssue(root, issue.id, "b", "s2");
		claim = getIssue(root, issue.id)!.claims[1];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "");
		claim = getIssue(root, issue.id)!.claims[1];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "");
		assert.strictEqual(getIssue(root, issue.id)!.stallStreak, 2);
		claim = getIssue(root, issue.id)!.claims[1];
		submitClaim(root, issue.id, claim.id);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "");
		// streak=3 → 后续 claim 被拒绝
		assert.throws(() => claimIssue(root, issue.id, "c", "s3"), /no progress/);
		assert.throws(() => submitClaim(root, issue.id, getIssue(root, issue.id)!.claims[1].id), /no progress/);
		assert.ok(nextActions(getIssue(root, issue.id)!).some(action => action.includes("Stop condition reached")));
	});

	// ─── 停止条件：预算超支 ────────────────────────────────────────

	console.log("\n--- budget guard ---");

	check("submit accumulates cost and rejects when the per-task budget is exceeded", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		let claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id, undefined, 1.2);
		assert.ok(Math.abs((getIssue(root, issue.id)!.costUsd ?? 0) - 1.2) < 1e-9);
		reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "fix it");
		claim = getIssue(root, issue.id)!.claims[0];
		// 1.2 + 1.0 > 2.0 → 拒绝
		assert.throws(() => submitClaim(root, issue.id, claim.id, undefined, 1.0), /budget exceeded/);
		assert.ok(Math.abs((getIssue(root, issue.id)!.costUsd ?? 0) - 1.2) < 1e-9);
		// 0.5 可以（1.7 <= 2.0）
		submitClaim(root, issue.id, claim.id, undefined, 0.5);
		assert.ok(Math.abs((getIssue(root, issue.id)!.costUsd ?? 0) - 1.7) < 1e-9);
	});

	check("submit without cost does not change costUsd", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		const claim = getIssue(root, issue.id)!.claims[0];
		submitClaim(root, issue.id, claim.id);
		assert.strictEqual(getIssue(root, issue.id)!.costUsd, 0);
	});

	// ─── 停止条件：最大轮次 ────────────────────────────────────────

	console.log("\n--- rounds guard ---");

	check("claims increment rounds and reject beyond maxRounds", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		for (let round = 1; round <= 5; round++) {
			claimIssue(root, issue.id, `a${round}`, `s${round}`);
			const current = getIssue(root, issue.id)!;
			assert.strictEqual(current.rounds, round);
			// 立即 pass 关闭本轮（stall 保持 0）
			const claim = current.claims[current.claims.length - 1];
			submitClaim(root, issue.id, claim.id);
			reviewClaim(root, issue.id, claim.id, "pass", "reviewer");
		}
		assert.throws(() => claimIssue(root, issue.id, "a6", "s6"), /round limit exceeded/);
		assert.strictEqual(getIssue(root, issue.id)!.rounds, 5);
	});

	// ─── 门禁参数配置 ──────────────────────────────────────────────

	console.log("\n--- setCommunityLimits ---");

	check("stalled issue can still be resolved by a human (manual bailout)", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		let claim = getIssue(root, issue.id)!.claims[0];
		// 3 次空反馈退回 → streak 3 停摆，claim 卡在 active
		for (let i = 0; i < 3; i++) {
			submitClaim(root, issue.id, claim.id);
			reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "");
		}
		assert.strictEqual(getIssue(root, issue.id)!.stallStreak, 3);
		assert.throws(() => submitClaim(root, issue.id, claim.id), /no progress/);
		// 停摆状态下人工 resolve 放行（兜底：跳过 active claim 校验）
		const resolved = resolveIssue(root, issue.id, "人工评估后直接解决");
		assert.strictEqual(resolved.status, "resolved");
		assert.strictEqual(resolved.resolvedReason, "人工评估后直接解决");
	});

	check("stalled issue can be deleted as a manual bailout", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		let claim = getIssue(root, issue.id)!.claims[0];
		for (let i = 0; i < 3; i++) {
			submitClaim(root, issue.id, claim.id);
			reviewClaim(root, issue.id, claim.id, "rework", "reviewer", "");
		}
		assert.strictEqual(getIssue(root, issue.id)!.stallStreak, 3);
		// 停摆状态下人工删除放行（兜底）
		const removed = deleteIssue(root, issue.id);
		assert.strictEqual(removed.id, issue.id);
		assert.strictEqual(getIssue(root, issue.id), undefined);
		// 认领时注册的 community 空间条目随删除释放，避免幽灵占用
		check("deleting a stalled issue releases its community space entry", () => {
			assert.ok(!readActiveContext(root).entries.some(entry => entry.name === `issue:${issue.id}` || entry.name.startsWith(`issue:${issue.id}:`)));
		});
	});

	check("setCommunityLimits validates its inputs", () => {
		assert.throws(() => setCommunityLimits({ stallThreshold: 0 }), /positive integer/);
		assert.throws(() => setCommunityLimits({ maxCostPerTask: 0 }), /> 0/);
		assert.throws(() => setCommunityLimits({ maxRounds: -1 }), /positive integer/);
	});

	check("formatIssue surfaces rounds, cost and stall state", () => {
		const issue = createIssue(root, { title: "T", description: "d" });
		claimIssue(root, issue.id, "a", "s");
		const out = formatIssue(getIssue(root, issue.id)!);
		assert.ok(out.includes("rounds 1"));
		assert.ok(out.includes("cost $"));
	});

	// 还原默认门禁参数（避免影响其他测试文件共享进程内状态）
	setCommunityLimits({ stallThreshold: 3, maxCostPerTask: 2, maxRounds: 5 });

	console.log(`\n${passed} community-3b checks passed`);
} finally {
	setCommunityLimits({ stallThreshold: 3, maxCostPerTask: 2, maxRounds: 5 });
	rmSync(root, { recursive: true, force: true });
}
