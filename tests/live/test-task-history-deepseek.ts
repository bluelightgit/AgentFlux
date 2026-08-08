import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agentflux-live-history-"));
const sessionDir = join(root, "sessions");
const piCli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

function run(prompt: string): string {
	const result = spawnSync(process.execPath, [piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", resolve("src/entry.ts"), "--no-skills", "--tools", "flux_task", "--session-dir", sessionDir, "--session-id", "history-live", "--provider", "octopus-anthropic", "--model", "deepseek-v4-pro", "--thinking", "off", prompt], { cwd: root, encoding: "utf-8", timeout: 120_000, windowsHide: true });
	const output = `${result.stdout}\n${result.stderr}`;
	if (result.status !== 0) throw new Error(`history live run failed (${result.status})\n${output.slice(-5000)}`);
	return output;
}

try {
	mkdirSync(join(root, ".agentflux"), { recursive: true });
	writeFileSync(join(root, ".agentflux", "agentflux.json"), JSON.stringify({ budget: { max_cost_per_task: 0.1, max_iterations: 3, max_wall_clock_seconds: 90 }, pricing: { enable_remote_fetch: false } }));
	writeFileSync(join(root, ".agentflux", "models.json"), JSON.stringify({ models: { "deepseek-v4-pro": { provider: "octopus-anthropic", contextWindow: 1_000_000 } }, roles: {}, sharedSkills: [] }));
	const first = run("只回答精确文本 HISTORY_SEED_OK。这是一个单一任务。");
	if (!first.includes("HISTORY_SEED_OK")) throw new Error("seed task marker missing");
	const second = run("继续刚才的任务，确认历史结果仍然有效，然后以 HISTORY_CONTINUE_OK 结束。");
	if (!second.includes("\"toolName\":\"flux_task\"") || !second.includes("HISTORY_CONTINUE_OK")) throw new Error(`Main Agent did not query task history before continuing\n${second.slice(-5000)}`);
	const registryPath = join(root, ".agentflux", "runtime", "tasks.json");
	if (!existsSync(registryPath)) throw new Error("Task Registry was not created");
	const tasks = JSON.parse(readFileSync(registryPath, "utf-8")).tasks;
	if (!tasks.some((task: any) => task.operation === "continue" && task.parentTaskId)) throw new Error("continuation lineage missing from Task Registry");
	console.log(JSON.stringify({ ok: true, seed: "HISTORY_SEED_OK", continuation: "HISTORY_CONTINUE_OK", historyToolUsed: true, taskCount: tasks.length }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
