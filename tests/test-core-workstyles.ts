import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIssue, claimIssue, commentOnIssue, resolveIssue, reviewClaim, submitClaim } from "../src/core/community";
import { createTaskExecutionPlan } from "../src/core/task-execution";
import { DEFAULT_CONFIG } from "../src/core/types";
import { parseFluxCommand } from "../src/extension/commands";

let passed = 0;
function check(value: unknown, message: string): void { if (!value) throw new Error(message); passed++; console.log(`✓ ${message}`); }

const root = mkdtempSync(join(tmpdir(), "agentflux-core-"));
try {
	// 无模式体系: 任务计划不再携带工作方式
	const plan = createTaskExecutionPlan({ task: "ship core", selectedBy: "user", budget: DEFAULT_CONFIG.budget });
	check(plan.taskId.startsWith("task-") && plan.selectedBy === "user" && !("workStyle" in plan), "任务计划不再记录工作方式，只记录选择者与预算");
	const mainPlan = createTaskExecutionPlan({ task: "handle ad-hoc", selectedBy: "main_agent", budget: DEFAULT_CONFIG.budget });
	check(mainPlan.operation === "new" && mainPlan.selectedBy === "main_agent", "Main 自主规划任务不依赖任何模式");
	// /flux 命令不再有 work 模式选择
	let rejected = false; try { parseFluxCommand("work community fix issue coordination"); } catch { rejected = true; }
	check(rejected, "TUI 已移除 work 模式选择命令");
	const historyCommand = parseFluxCommand("task continue latest follow up");
	check(historyCommand.kind === "task" && historyCommand.args[0] === "continue", "TUI task 命令解析历史操作");
	const workflowCommand = parseFluxCommand("workflow reuse release-review run again");
	check(workflowCommand.kind === "workflow" && workflowCommand.args[0] === "reuse", "TUI workflow 命令解析定义复用");
	const messageCommand = parseFluxCommand("message group send release-group status");
	check(messageCommand.kind === "message" && messageCommand.args[0] === "group", "TUI message 命令解析群组发送");
	let legacyRejected = false; try { parseFluxCommand("work M5 legacy"); } catch { legacyRejected = true; }
	check(legacyRejected, "TUI 拒绝旧 M 编号命令");

	const issue = createIssue(root, { title: "Core issue", description: "Implement it", acceptanceCriteria: ["tested"] });
	commentOnIssue(root, issue.id, "planner", "split into one claim");
	const claimed = claimIssue(root, issue.id, "implementer", "src/core");
	check(claimed.status === "executing" && claimed.claims.length === 1, "Community claim 进入 executing");
	let activeRejected = false; try { resolveIssue(root, issue.id); } catch { activeRejected = true; }
	check(activeRejected, "存在 active claim 时不能关闭 Issue");
	const submitted = submitClaim(root, issue.id, claimed.claims[0].id);
	check(submitted.status === "reviewing", "提交 claim 后进入 reviewing");
	let pendingRejected = false; try { resolveIssue(root, issue.id); } catch { pendingRejected = true; }
	check(pendingRejected, "submitted claim 待评审时不能关闭 Issue");
	reviewClaim(root, issue.id, claimed.claims[0].id, "pass", "main");
	check(resolveIssue(root, issue.id).status === "resolved", "完成 claim 后可以关闭 Issue");
	console.log(`\n${passed} core checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
