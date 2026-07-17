import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SharedBoard } from "../src/core/shared-board";
import { getTeamAbortRequest, requestTeamAbort } from "../src/extension/team";

let passed = 0;
function check(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
	passed++;
	console.log(`✓ ${message}`);
}

async function main(): Promise<void> {
const root = mkdtempSync(join(tmpdir(), "agentflux-p0-board-"));
const fluxDir = join(root, ".agentflux");

try {
	const boardA = new SharedBoard(fluxDir);
	const boardB = new SharedBoard(fluxDir);
	const first = boardA.createTask({
		title: "first",
		status: "pending",
		dependsOn: [],
		acceptanceCriteria: [],
	});
	const dependent = boardA.createTask({
		title: "dependent",
		status: "blocked",
		dependsOn: [first.id],
		acceptanceCriteria: [],
	});

	check(/^task-[0-9a-f-]{36}$/.test(first.id), "task 使用 UUID，避免按列表长度碰撞");
	check(first.id !== dependent.id, "连续创建的 task ID 唯一");
	const claimed = boardA.claimNextTask("worker-a");
	check(claimed?.id === first.id && claimed.status === "in_progress", "就绪任务只在原子认领后进入 in_progress");
	check(boardB.claimNextTask("worker-b") === null, "第二个 board 不能重复认领同一任务");

	check(boardA.failTask(first.id, "boom"), "执行中的任务可进入 failed 终态");
	check(boardA.getTask(dependent.id)?.status === "blocked", "failed 任务不会解锁依赖者");
	check(!boardA.completeTask(first.id, {}), "failed 任务不能被迟到结果覆盖成 done");

	const retry = boardA.createTask({
		title: "retry",
		status: "pending",
		dependsOn: [],
		acceptanceCriteria: [],
	});
	check(boardA.claimNextTask("worker-a")?.id === retry.id, "重试样本任务可被首次认领");
	check(boardA.scheduleTaskRetry(retry.id, "temporary", new Date(Date.now() + 60_000).toISOString()), "任务可进入 retry_wait");
	check(boardB.claimNextTask("worker-b") === null, "retryAt 到达前不可认领 retry_wait 任务");
	check(boardA.scheduleTaskRetry(retry.id, "temporary", new Date(Date.now() - 1_000).toISOString()), "可更新合法 retryAt");
	check(boardB.claimNextTask("worker-b")?.id === retry.id, "retryAt 到达后任务可再次原子认领");
	check((boardA.getTask(retry.id)?.attempts ?? 0) === 2, "每次成功认领都会增加 attempts");
	check(boardA.cancelTask(retry.id, "user stop"), "运行中任务可进入 cancelled 终态");
	check(!boardB.completeTask(retry.id, {}), "cancelled 任务不能被迟到结果覆盖成 done");

	const sourceDir = join(root, "src");
	mkdirSync(sourceDir, { recursive: true });
	const absoluteTarget = join(sourceDir, "same.ts");
	writeFileSync(absoluteTarget, "export {};\n");
	check(boardA.acquireFileLock("agent-a", "src/same.ts"), "首次文件锁使用 wx 原子创建成功");
	check(!boardB.acquireFileLock("agent-b", absoluteTarget), "相对/绝对路径 canonicalize 后识别同一文件冲突");
	check(boardB.releaseAllLocks("agent-b").length === 0, "非 owner 不能释放其他 agent 的锁");
	check(boardA.getFileLocks().length === 1, "冲突后原锁仍保持有效");
	check(boardA.releaseFileLock(absoluteTarget, "agent-a"), "仅当前 owner 可显式释放 canonical 文件锁");
	check(boardB.acquireFileLock("agent-b", absoluteTarget), "owner 释放后其他 agent 可获取锁");

	const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
	const workerScript = join(process.cwd(), "tests", "helpers", "shared-board-registry-worker.ts");
	const runRegistryWorker = (prefix: string): Promise<void> => new Promise((resolveWorker, rejectWorker) => {
		const child = spawn(process.execPath, [tsxCli, workerScript, fluxDir, prefix], {
			cwd: process.cwd(),
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			error ? rejectWorker(error) : resolveWorker();
		};
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.once("error", error => finish(error));
		// close 在 exit 之后、stdio 全部关闭后触发；Windows 上可避免测试清理与
		// 子进程最后一次文件写入/句柄释放竞争。
		child.once("close", code => code === 0
			? finish()
			: finish(new Error(`registry worker ${prefix} exited ${code}: ${stderr}`)));
	});
	await Promise.all(["w1", "w2", "w3", "w4"].map(runRegistryWorker));
	const registered = boardA.listAgents().filter(agent => /^w\d-agent-\d+$/.test(agent.name));
	check(registered.length === 40, "多进程并发注册不会丢失 agent registry 更新");
	const allGroup = boardA.listGroups().find(group => group.id === "all");
	check(allGroup?.members.filter(name => /^w\d-agent-\d+$/.test(name)).length === 40, "多进程并发合并 All Agents 成员不会丢更新");
	check(boardA.listGroups().filter(group => group.type === "team").length === 20, "多进程并发创建 group 不会覆盖 registry");
	check(Object.keys(boardA.getBlackboard().agentStatuses).filter(name => /^w\d-agent-\d+$/.test(name)).length === 40, "多进程 blackboard 状态更新不会丢失");

	const abort = requestTeamAbort(fluxDir, "implementer-test", "test cancel");
	check(/^abort-[0-9a-f-]{36}$/.test(abort.id), "abort request 使用 UUID");
	check(getTeamAbortRequest(fluxDir, "implementer-test")?.reason === "test cancel", "abort 意图持久化且可由执行层读取");

	console.log(`\n${passed}/${passed} tests passed`);
} finally {
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
