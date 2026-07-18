import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `core-deepseek-${process.pid}`);
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

function setup(): void {
	mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
	cpSync(join(sourceRoot, "src"), join(fixtureRoot, "src"), { recursive: true });
	writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux live fixture\n");
	writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({ budget: { max_cost_per_task: 0.25, max_iterations: 3, max_wall_clock_seconds: 240 }, pricing: { enable_remote_fetch: false } }, null, 2));
	writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify({
		models: {
			"deepseek-v4-pro": { provider: "octopus-anthropic", contextWindow: 1_000_000 },
			"deepseek-v4-flash": { provider: "octopus-anthropic", contextWindow: 1_000_000 },
		},
		roles: {
			planner: { model: "deepseek-v4-pro", thinking: "off", tools: ["read", "grep", "find", "ls"] },
			implementer: { model: "deepseek-v4-flash", thinking: "off", tools: ["read", "grep", "find", "ls"] },
			reviewer: { model: "deepseek-v4-flash", thinking: "off", tools: ["read", "grep", "find", "ls"] },
			tester: { model: "deepseek-v4-flash", thinking: "off", tools: ["read", "grep", "find", "ls"] },
		}, sharedSkills: [],
	}, null, 2));
}

async function run(label: string, model: string, prompt: string, expected: string[], timeoutMs = 300_000): Promise<Record<string, unknown>> {
	const args = [piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", join(fixtureRoot, "src", "entry.ts"), "--no-skills", "--tools", "flux_agent,flux_team,flux_workflow,flux_issue,flux_message", "--provider", "octopus-anthropic", "--model", model, "--thinking", "off", prompt];
	const started = Date.now();
	const child = spawn(process.execPath, args, { cwd: fixtureRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = ""; let stderr = "";
	child.stdout.on("data", value => { stdout += value.toString(); }); child.stderr.on("data", value => { stderr += value.toString(); });
	const exitCode = await new Promise<number>((done, reject) => {
		const timer = setTimeout(() => { if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL"); reject(new Error(`${label} timeout`)); }, timeoutMs);
		child.on("error", reject); child.on("close", code => { clearTimeout(timer); done(code ?? 1); });
	});
	if (exitCode !== 0) throw new Error(`${label} exit ${exitCode}\n${stderr}\n${stdout.slice(-2000)}`);
	const combined = `${stdout}\n${stderr}`;
	for (const marker of expected) if (!combined.includes(marker)) throw new Error(`${label} missing ${marker}\nSTDERR:\n${stderr.slice(-4000)}\nSTDOUT:\n${stdout.slice(-4000)}`);
	return { label, model, pid: child.pid, exitCode, wallClockMs: Date.now() - started, markers: expected };
}

async function main(): Promise<void> {
	setup(); const evidence: Record<string, unknown>[] = [];
	try {
		evidence.push(await run("direct", "deepseek-v4-pro", "这是只读 Direct 测试。不要调用任何工具，只回复精确文本 AGENTFLUX_DIRECT_OK", ["AGENTFLUX_DIRECT_OK"]));
		evidence.push(await run("team", "deepseek-v4-flash", "这是只读 Team 测试。必须调用一次 flux_team，创建一个 name=reviewer-smoke、role=reviewer 的临时任务，让它只回复 TEAM_CHILD_OK；成功后只回复精确文本 AGENTFLUX_TEAM_OK。", ["flux_team", "TEAM_CHILD_OK", "AGENTFLUX_TEAM_OK"]));
		evidence.push(await run("workflow", "deepseek-v4-pro", "必须调用一次 flux_workflow，task 设置为：只读检查 README.md 第一行，不得修改文件，保持 DAG 最小并完成验收。工具结束后只回复 AGENTFLUX_WORKFLOW_OK。", ["flux_workflow", "[DAG Execution: PASSED]", "AGENTFLUX_WORKFLOW_OK"]));
		evidence.push(await run("community", "deepseek-v4-pro", "使用 flux_issue 完成只读 Community 测试：创建 Issue，添加评论，认领 scope=readme-audit，提交该 claim 并关闭 Issue；完成后只回复精确文本 AGENTFLUX_COMMUNITY_OK。", ["flux_issue", "resolved", "AGENTFLUX_COMMUNITY_OK"]));
		process.stdout.write(`${JSON.stringify({ ok: true, evidence }, null, 2)}\n`);
	} finally {
		const base = resolve(sourceRoot, ".agentflux", "test-workspaces"); const target = resolve(fixtureRoot);
		if (!target.startsWith(`${base}\\`)) throw new Error(`unsafe cleanup: ${target}`);
		rmSync(target, { recursive: true, force: true });
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
