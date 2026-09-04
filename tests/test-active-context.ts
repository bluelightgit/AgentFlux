import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatActiveContext, hasActiveContext, pruneStaleActiveContext, readActiveContext, registerActiveContext, releaseActiveContext } from "../src/core/active-context";
import { claimIssue, createIssue, resolveIssue } from "../src/core/community";

let passed = 0;
function check(value: unknown, message: string): void { if (!value) throw new Error(message); passed++; console.log(`✓ ${message}`); }

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "agentflux-context-"));
	try {
		// ─── 基础读写 ───
		check(!hasActiveContext(root) && readActiveContext(root).entries.length === 0, "无状态时视为无活跃上下文");
		check(formatActiveContext(readActiveContext(root)) === "no active context", "空上下文展示为 no active context");

		// ─── 互斥：不同空间拒绝 ───
		registerActiveContext(root, { name: "worker-1", context: "main", task: "main task" });
		check(hasActiveContext(root) && readActiveContext(root).entries.length === 1, "main 空间注册成功");
		let workflowRejected = false;
		try {
			registerActiveContext(root, { name: "dag-1", context: "workflow", task: "dag task" });
		} catch (error: any) {
			workflowRejected = String(error?.message ?? "").includes("main 空间活跃");
		}
		check(workflowRejected, "main 活跃时启动 workflow 被拒绝并提示活跃者");
		let communityRejected = false;
		try {
			registerActiveContext(root, { name: "issue:x", context: "community", task: "issue task" });
		} catch (error: any) {
			communityRejected = String(error?.message ?? "").includes("main 空间活跃");
		}
		check(communityRejected, "main 活跃时启动 community 被拒绝");

		// ─── 同空间并行允许 ───
		registerActiveContext(root, { name: "worker-2", context: "main", task: "parallel main task" });
		check(readActiveContext(root).entries.length === 2, "main 空间内多个子代理并行允许");
		check(formatActiveContext(readActiveContext(root)).includes("[main] worker-2"), "展示包含条目与空间归属");
		const duplicateA = registerActiveContext(root, { name: "same-worker", context: "main", scope: "same-scope", task: "parallel A" });
		const duplicateB = registerActiveContext(root, { name: "same-worker", context: "main", scope: "same-scope", task: "parallel B" });
		let ambiguousReleaseRejected = false;
		try { releaseActiveContext(root, "same-worker"); } catch (error: any) { ambiguousReleaseRejected = String(error?.message ?? "").includes("ambiguous"); }
		check(ambiguousReleaseRejected && readActiveContext(root).entries.some(entry => entry.leaseId === duplicateA.leaseId)
			&& readActiveContext(root).entries.some(entry => entry.leaseId === duplicateB.leaseId), "共享 name/scope 释放歧义时 fail-closed");
		check(releaseActiveContext(root, duplicateA.leaseId) && readActiveContext(root).entries.some(entry => entry.leaseId === duplicateB.leaseId), "具体 leaseId 只释放对应实例");
		check(releaseActiveContext(root, duplicateB.leaseId), "第二个具体 lease 也可独立释放");

		// ─── 释放与恢复 ───
		check(releaseActiveContext(root, "worker-1"), "按 name 释放条目");
		check(readActiveContext(root).entries.length === 1, "释放后仅剩一个条目");
		check(!releaseActiveContext(root, "no-such-entry"), "释放不存在的条目返回 false");
		check(releaseActiveContext(root, "worker-2") && !hasActiveContext(root), "全部释放后回到无活跃状态");

		// ─── 崩溃残留清理（stale pid / 超时） ───
		registerActiveContext(root, { name: "ghost", context: "workflow", pid: 999999, task: "crashed dag" });
		check(readActiveContext(root).entries.length === 0, "pid 不存在的条目视为崩溃残留，读取即忽略");
		pruneStaleActiveContext(root);
		check(!hasActiveContext(root), "清理后无残留条目");
		registerActiveContext(root, { name: "old-entry", context: "main", task: "long ago" });
		const statePath = join(root, ".agentflux", "runtime", "active-context.json");
		const raw = JSON.parse(readFileSync(statePath, "utf-8"));
		raw.entries[0].updatedAt = new Date(Date.now() - 60 * 60 * 1000 - 1000).toISOString();
		writeFileSync(statePath, JSON.stringify(raw));
		check(readActiveContext(root).entries.length === 1, "超过 stale 阈值但 pid 存活的条目仍视为活跃（长运行空间保留）");
		raw.entries[0].pid = 999999;
		writeFileSync(statePath, JSON.stringify(raw));
		check(readActiveContext(root).entries.length === 0, "超过 stale 阈值且 pid 消失的条目视为崩溃残留");

		// ─── workflow 运行中 community claim 被拒（社区入口集成） ───
		registerActiveContext(root, { name: "workflow:task-1", context: "workflow", scope: "exec-1", task: "dag" });
		const issue = createIssue(root, { title: "coordinate fix", description: "fix together" });
		let claimRejected = false;
		try {
			claimIssue(root, issue.id, "worker", "scope-a");
		} catch (error: any) {
			claimRejected = String(error?.message ?? "").includes("workflow 空间活跃");
		}
		check(claimRejected, "workflow 活跃时社区 claim 被拒绝（community.ts 抛互斥错误）");
		releaseActiveContext(root, "workflow:task-1");
		const claimed = claimIssue(root, issue.id, "worker", "scope-a");
		const parallelClaim = claimIssue(root, issue.id, "worker-2", "scope-b");
		check(claimed.status === "executing" && parallelClaim.claims.length === 2, "无冲突时同一 community 空间支持并行 claim");
		const claimLeases = readActiveContext(root).entries.filter(entry => entry.context === "community");
		const firstClaim = parallelClaim.claims[0];
		const secondClaim = parallelClaim.claims[1];
		check(claimLeases.length === 2 && new Set(claimLeases.map(entry => entry.leaseId)).size === 2
			&& !!firstClaim && !!secondClaim && typeof firstClaim.leaseId === "string" && typeof secondClaim.leaseId === "string", "并行 claim 拥有互不相同的具体 lease");
		submitAndResolve:
		{
			// resolve 要求先 review 全部 claim；先通过一个 claim，不能误删另一个。
			const { submitClaim, reviewClaim } = await import("../src/core/community");
			const submitted = submitClaim(root, issue.id, firstClaim.id);
			check(submitted.status === "reviewing", "submit 进入评审");
			reviewClaim(root, issue.id, firstClaim.id, "pass", "main");
			check(readActiveContext(root).entries.filter(entry => entry.context === "community").length === 1,
				"通过一个 claim 只释放自己的 lease，不误删并行 claim");
			submitClaim(root, issue.id, secondClaim.id);
			reviewClaim(root, issue.id, secondClaim.id, "pass", "main");
			check(resolveIssue(root, issue.id).status === "resolved", "全部评审通过后可 resolve");
		}
		check(!hasActiveContext(root), "resolve 释放 community 空间条目");

		console.log(`\n${passed} active-context checks passed`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
main().catch(error => { console.error(error); process.exit(1); });
