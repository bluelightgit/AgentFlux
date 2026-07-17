/**
 * M4 持久 multi-agent 测试
 *
 * 测试内容:
 *   M4-2: agent 间消息传递 (SharedBoard messages/)
 *   M4-3: 任务队列消费 (claimNextTask)
 *   M4-4: 状态同步 (completeTask 通知依赖者)
 *   M4-1/M4-5: 持久 agent 跨调用 session 续接 + 注册表
 *
 * 测试模型: deepseek-v4-flash
 */

import { SharedBoard } from "../src/core/shared-board";
import { runPersistentAgent, consumeNextTask } from "../src/extension/persistent-agent";
import { TelemetryWriter } from "../src/telemetry/events";
import { loadConfig } from "../src/core/config";
import { loadPricing } from "../src/core/pricing";
import { join } from "node:path";
import { readFileSync, existsSync, rmSync, readdirSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";

const CWD = process.cwd();
const SOURCE_FLUX_DIR = join(CWD, ".agentflux");
const TEST_ROOT = mkdtempSync(join(tmpdir(), "agentflux-m4-integration-"));
const PROJECT_CWD = join(TEST_ROOT, "project");
const FLUX_DIR = join(PROJECT_CWD, ".agentflux");
const TEST_SHARED_DIR = join(FLUX_DIR, "shared-test-m4");

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`${icon} ${name}: ${detail}`);
}

async function main() {
	console.log("=".repeat(70));
	console.log("M4 Persistent Multi-Agent Test");
	console.log(`Model: deepseek-v4-flash`);
	console.log("=".repeat(70) + "\n");

	// 清理测试目录
	try { rmSync(TEST_SHARED_DIR, { recursive: true, force: true }); } catch {}
	cpSync(join(CWD, "src"), join(PROJECT_CWD, "src"), { recursive: true });

	const config = loadConfig(CWD);
	let pricingTable: any = null;
	try {
		pricingTable = await loadPricing(FLUX_DIR, config.pricing, "deepseek-v4-flash");
	} catch (e: any) {
		console.warn(`Pricing load failed: ${e?.message}`);
	}

	const telemetry = new TelemetryWriter(FLUX_DIR, true);
	const sessionId = `test-m4-${Date.now()}`;
	// 临时项目不加载被测扩展，避免 subagent 反向写入真实工作区状态。
	const prefixLayout = false;
	const MODEL = "deepseek-v4-flash";

	let modelsConfig: any = null;
	try {
		modelsConfig = JSON.parse(readFileSync(join(SOURCE_FLUX_DIR, "models.json"), "utf-8"));
	} catch {}

	// ─── M4-2: Agent 间消息传递 ───
	console.log("\n--- M4-2: Agent messaging ---");

	// 使用测试专用黑板
	const testBoard = new TestSharedBoard(FLUX_DIR, "shared-test-m4");

	// 发送消息
	const msg1 = testBoard.sendMessage("planner-1", "implementer-1", "task_update", "Schema changed: user table added deleted_at column");
	const msg2 = testBoard.sendMessage("planner-1", "broadcast", "announcement", "All agents: please review the new schema");
	const msg3 = testBoard.sendMessage("reviewer-1", "implementer-1", "review_feedback", "The auth module needs error handling");

	record("M4-2.1 sendMessage creates message with ID",
		!!msg1.id,
		`msg1.id=${msg1.id}`);
	record("M4-2.2 sendMessage stores message",
		testBoard.listMessages().length === 3,
		`total messages=${testBoard.listMessages().length}`);

	// 获取收件箱
	const implInbox = testBoard.getInbox("implementer-1");
	record("M4-2.3 getInbox returns targeted + broadcast messages",
		implInbox.length === 3,
		`implementer-1 inbox=${implInbox.length} (2 targeted + 1 broadcast)`);

	const reviewerInbox = testBoard.getInbox("reviewer-1");
	record("M4-2.4 getInbox for reviewer only gets broadcast",
		reviewerInbox.length === 1,
		`reviewer-1 inbox=${reviewerInbox.length} (broadcast only)`);

	// 未读消息
	const unread = testBoard.getUnreadMessages("implementer-1");
	record("M4-2.5 getUnreadMessages returns all unread",
		unread.length === 3,
		`unread=${unread.length}`);

	// 标记已读
	testBoard.markMessageRead(msg1.id);
	const unreadAfter = testBoard.getUnreadMessages("implementer-1");
	record("M4-2.6 markMessageRead reduces unread count",
		unreadAfter.length === 2,
		`unread after mark=${unreadAfter.length}`);

	// ─── M4-3: 任务队列消费 ───
	console.log("\n--- M4-3: Task queue consumption ---");

	// 创建任务队列
	const task1 = testBoard.createTask({
		title: "Read types.ts and list type names",
		assignedTo: undefined,
		status: "pending",
		dependsOn: [],
		acceptanceCriteria: ["Output lists at least 3 type names"],
		inputHandoff: undefined,
	});

	const task2 = testBoard.createTask({
		title: "Review the type list",
		assignedTo: undefined,
		status: "blocked",   // 依赖 task1
		dependsOn: [task1.id],
		acceptanceCriteria: ["Output confirms the list is accurate"],
		inputHandoff: undefined,
	});

	// 认领任务
	const claimed = testBoard.claimNextTask("implementer-1");
	record("M4-3.1 claimNextTask returns first ready task",
		!!claimed && claimed.id === task1.id,
		`claimed=${claimed?.id}, expected=${task1.id}`);
	record("M4-3.2 claimed task status is in_progress",
		claimed?.status === "in_progress",
		`status=${claimed?.status}`);
	record("M4-3.3 claimed task is assigned to agent",
		claimed?.assignedTo === "implementer-1",
		`assignedTo=${claimed?.assignedTo}`);

	// task2 依赖 task1, 不应该被认领 (task1 还未完成)
	const claimed2 = testBoard.claimNextTask("reviewer-1");
	record("M4-3.4 Blocked task is not claimed (dependency not met)",
		claimed2 === null,
		`claimNextTask for blocked task=${claimed2}`);

	// ─── M4-4: 状态同步 ───
	console.log("\n--- M4-4: State synchronization ---");

	// 完成 task1 → 应该解锁 task2
	testBoard.completeTask(task1.id, { output: "Found 7 types: Mode, Preset, ProjectStage...", verdict: "completed" });
	const task2After = testBoard.getTask(task2.id);
	record("M4-4.1 completeTask marks task as done",
		testBoard.getTask(task1.id)?.status === "done",
		`task1 status=${testBoard.getTask(task1.id)?.status}`);
	record("M4-4.2 completeTask unblocks dependent task",
		task2After?.status === "pending",
		`task2 status=${task2After?.status} (was blocked)`);

	// 完成后应该有广播消息
	const broadcastMsgs = testBoard.listMessages().filter(m => m.type === "task_complete");
	record("M4-4.3 completeTask sends broadcast message",
		broadcastMsgs.length > 0,
		`task_complete messages=${broadcastMsgs.length}`);

	// ─── M4-1/M4-5: 持久 agent 跨调用 ───
	console.log("\n--- M4-1/M4-5: Persistent agent across calls ---");

	// 清理持久 agent 注册表
	const regPath = join(FLUX_DIR, "runtime", "persistent-agents.json");
	try { rmSync(regPath, { force: true }); } catch {}

	const persistOpts = {
		cwd: PROJECT_CWD, fluxDir: FLUX_DIR, modelsConfig, telemetry, prefixLayout,
		pricing: pricingTable ?? undefined, sessionId,
		sharedSkills: modelsConfig?.sharedSkills ?? [],
	};

	// 第一次调用持久 agent
	console.log("  Running persistent reviewer (call 1/2)...");
	const persistResult1 = await runPersistentAgent("test-reviewer-persist", "reviewer", "Read src/core/types.ts and list the first 3 type names you see. Just the names.", persistOpts);

	record("M4-1.1 Persistent agent call 1 succeeds",
		persistResult1.exitCode === 0 && persistResult1.output.length > 0,
		`exit=${persistResult1.exitCode}, output=${persistResult1.output.length}chars`);

	// 第二次调用同一 agent (应该续接 session)
	console.log("  Running persistent reviewer (call 2/2 - should resume)...");
	const persistResult2 = await runPersistentAgent("test-reviewer-persist", "reviewer", "What were the first 3 type names I asked you about? If you don't remember, say 'I don't remember'.", persistOpts);

	record("M4-1.2 Persistent agent call 2 succeeds",
		persistResult2.exitCode === 0 && persistResult2.output.length > 0,
		`exit=${persistResult2.exitCode}, output=${persistResult2.output.length}chars`);

	// 验证注册表
	const { readFileSync: rf } = require("node:fs");
	const reg = JSON.parse(rf(regPath, "utf-8"));
	const agent = reg.agents.find((a: any) => a.name === "test-reviewer-persist");
	record("M4-1.3 Persistent agent registry has correct call count",
		agent?.callCount === 2,
		`callCount=${agent?.callCount}`);
	record("M4-1.4 Persistent agent registry has cumulative cost",
		agent?.totalCost > 0,
		`totalCost=$${agent?.totalCost?.toFixed(6)}`);
	record("M4-5.5 Session file exists for persistent agent",
		!!agent?.sessionFile && existsSync(agent.sessionFile) || readdirSync(join(FLUX_DIR, "runtime", "sessions")).some(f => f.includes("flux-test-reviewer-persist")),
		`sessionFile in registry=${agent?.sessionFile}, actual jsonl exists=${readdirSync(join(FLUX_DIR, "runtime", "sessions")).some(f => f.includes("flux-test-reviewer-persist"))}`);

	// 第二次调用应该有更高的 cache hit
	const hitRate1 = persistResult1.usage.cacheRead / (persistResult1.usage.cacheRead + persistResult1.usage.input + 1e-9);
	const hitRate2 = persistResult2.usage.cacheRead / (persistResult2.usage.cacheRead + persistResult2.usage.input + 1e-9);
	console.log(`  Call 1 cache hit: ${(hitRate1 * 100).toFixed(0)}%, Call 2 cache hit: ${(hitRate2 * 100).toFixed(0)}%`);
	record("M4-5.6 Second call has cache hits (session continuity)",
		persistResult2.usage.cacheRead > 0,
		`call2 cacheRead=${persistResult2.usage.cacheRead}`);

	// ─── M4-3 完整流程: 任务队列消费 ───
	console.log("\n--- M4-3 full flow: Task queue consumption ---");

	// 使用默认 SharedBoard (consumeNextTask 内部会创建默认 SharedBoard)
	const defaultBoard = new SharedBoard(FLUX_DIR);
	// 清理默认黑板上的旧任务
	for (const oldTask of defaultBoard.listTasks()) {
		try { rmSync(join(FLUX_DIR, "shared", "tasks", `${oldTask.id}.json`)); } catch {}
	}
	defaultBoard.createTask({
		title: "Read src/core/config.ts and describe loadConfig function. Max 50 words.",
		assignedTo: undefined,
		status: "pending",
		dependsOn: [],
		acceptanceCriteria: [],
		inputHandoff: undefined,
	});

	// 使用 consumeNextTask 执行
	console.log("  Running consumeNextTask...");
	const consumeResult = await consumeNextTask("test-worker-1", "reviewer", persistOpts);

	record("M4-3.5 consumeNextTask claims and executes task",
		!!consumeResult && consumeResult.result.exitCode === 0,
		`task=${consumeResult?.task.id}, exit=${consumeResult?.result.exitCode}`);
	record("M4-3.6 Task status updated to done after consumption",
		defaultBoard.getTask(consumeResult?.task.id ?? "")?.status === "done",
		`task status=${defaultBoard.getTask(consumeResult?.task.id ?? "")?.status}`);

	// ─── 清理 ───
	try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}

	// ─── 汇总 ───
	console.log("\n" + "=".repeat(70));
	console.log("Test Summary");
	console.log("=".repeat(70));
	const passed = results.filter(r => r.passed).length;
	const failed = results.filter(r => !r.passed).length;
	for (const r of results) {
		const icon = r.passed ? "✅" : "❌";
		console.log(`  ${icon} ${r.name}: ${r.detail}`);
	}
	console.log(`\n  Total: ${passed + failed} tests, ${passed} passed, ${failed} failed`);

	if (failed > 0) throw new Error(`${failed} M4 integration tests failed`);
}

// ─── 测试用 SharedBoard 子类 (使用独立目录) ───

class TestSharedBoard extends SharedBoard {
	constructor(fluxDir: string, subDir: string) {
		super(fluxDir);
		// 覆盖 sharedDir 为测试目录
		(this as any).sharedDir = join(fluxDir, subDir);
		(this as any).ensureDirs();
	}
}

main()
	.catch(e => { console.error("Test error:", e); process.exitCode = 1; })
	.finally(() => { try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {} });
