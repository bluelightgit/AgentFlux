import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIssue, claimIssue, commentOnIssue, resolveIssue, submitClaim } from "../src/core/community";
import { parseWorkStyle } from "../src/core/config";
import { createTaskExecutionPlan } from "../src/core/task-execution";
import { DEFAULT_CONFIG } from "../src/core/types";
import { parseFluxCommand } from "../src/extension/commands";

let passed = 0;
function check(value: unknown, message: string): void { if (!value) throw new Error(message); passed++; console.log(`✓ ${message}`); }

const root = mkdtempSync(join(tmpdir(), "agentflux-workstyles-"));
try {
	check(parseWorkStyle("TEAM") === "team" && parseWorkStyle("M2") === undefined, "只接受四种工作方式，不接受旧模式");
	const plan = createTaskExecutionPlan({ task: "ship core", workStyle: "workflow", selectedBy: "user", budget: DEFAULT_CONFIG.budget });
	check(plan.workStyle === "workflow" && plan.taskId.startsWith("task-") && plan.selectedBy === "user", "任务计划只记录工作方式、选择者和预算");
	const command = parseFluxCommand("work community fix issue coordination");
	check(command.kind === "work" && command.style === "community", "TUI work 命令解析 Community");
	let rejected = false; try { parseFluxCommand("work M5 legacy"); } catch { rejected = true; }
	check(rejected, "TUI 拒绝旧 M 编号");

	const issue = createIssue(root, { title: "Core issue", description: "Implement it", acceptanceCriteria: ["tested"] });
	commentOnIssue(root, issue.id, "planner", "split into one claim");
	const claimed = claimIssue(root, issue.id, "implementer", "src/core");
	check(claimed.status === "executing" && claimed.claims.length === 1, "Community claim 进入 executing");
	let activeRejected = false; try { resolveIssue(root, issue.id); } catch { activeRejected = true; }
	check(activeRejected, "存在 active claim 时不能关闭 Issue");
	const submitted = submitClaim(root, issue.id, claimed.claims[0].id);
	check(submitted.status === "reviewing", "提交 claim 后进入 reviewing");
	check(resolveIssue(root, issue.id).status === "resolved", "完成 claim 后可以关闭 Issue");
	console.log(`\n${passed} core workstyle checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
