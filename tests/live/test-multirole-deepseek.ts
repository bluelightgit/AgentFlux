import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLiveConfig } from "./live-config";

/**
 * 真实 Pi/Provider 多角色链路：Main 创建一个绑定 planner+reviewer 的 Agent，
 * 再按两个不同 role 顺序运行，最后核对注册表与 Run Registry 的事实。
 * 使用时请显式设置低成本 provider/model，例如：
 * AGENTFLUX_LIVE_PROVIDER_ID=octopus-completions
 * AGENTFLUX_LIVE_MODEL_PRO=deepseek-v4-flash AGENTFLUX_LIVE_MODEL_FLASH=deepseek-v4-flash
 * AGENTFLUX_LIVE_THINKING=off npx tsx tests/live/test-multirole-deepseek.ts
 */
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `multirole-${process.pid}`);
const reportPath = join(sourceRoot, ".agentflux", "test-results", "multirole-latest.json");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

async function main(): Promise<void> {
	const config = loadLiveConfig();
	const startedAt = Date.now();
	mkdirSync(join(sourceRoot, ".agentflux", "test-results"), { recursive: true });
	mkdirSync(join(fixtureRoot, ".agentflux"), { recursive: true });
	cpSync(join(sourceRoot, "src"), join(fixtureRoot, "src"), { recursive: true });
	writeFileSync(join(fixtureRoot, "README.md"), "# AgentFlux multirole fixture\n");
	writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
		budget: { max_cost_per_task: 0.15, max_iterations: 3, max_wall_clock_seconds: 180 },
		pricing: { enable_remote_fetch: false },
	}, null, 2));
	writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify(config.fluxModelsJson(), null, 2));
	const prompt = [
		"必须严格按顺序实际调用 AgentFlux 的 flux_agent 工具，不要调用 flux_workflow、flux_issue 或其他协作工具。",
		"1) action=create，name=multirole-live，roles=[planner, reviewer]，scope=project。",
		"2) action=run，agent=multirole-live，role=planner，background=false，task=只回复 PLAN_LIVE_OK。",
		"3) action=run，agent=multirole-live，role=reviewer，background=false，task=只回复 REVIEW_LIVE_OK。",
		"三次工具调用都成功后，只输出 MULTIROLE_LIVE_OK。",
	].join("\n");
	const args = [
		piCli, "--mode", "json", "-p", "--approve", "--no-extensions", "-e", join(fixtureRoot, "src", "entry.ts"),
		"--no-skills", "--tools", "read,grep,find,ls,flux_task,flux_agent", ...config.cliArgs(config.modelFlash), prompt,
	];
	let stdout = "";
	let stderr = "";
	try {
		const child = spawn(process.execPath, args, { cwd: fixtureRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: config.env });
		child.stdout.on("data", value => { stdout += value.toString(); });
		child.stderr.on("data", value => { stderr += value.toString(); });
		const exitCode = await new Promise<number>((resolveExit, reject) => {
			const timer = setTimeout(() => {
				if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
				else child.kill("SIGKILL");
				reject(new Error("multi-role live test timeout"));
			}, 240_000);
			child.on("error", reject);
			child.on("close", code => { clearTimeout(timer); resolveExit(code ?? 1); });
		});
		const agentsPath = join(fixtureRoot, ".agentflux", "runtime", "agents.json");
		const runsPath = join(fixtureRoot, ".agentflux", "runtime", "runs.json");
		const agents = existsSync(agentsPath) ? JSON.parse(readFileSync(agentsPath, "utf-8")) : undefined;
		const runs = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, "utf-8")) : undefined;
		const agent = agents?.agents?.find((item: any) => item.name === "multirole-live");
		const roleRuns = runs?.runs?.filter((item: any) => item.agent === "multirole-live") ?? [];
		const evidence = {
			updatedAt: new Date().toISOString(),
			provider: config.providerId,
			model: config.modelFlash,
			thinking: config.thinking,
			exitCode,
			wallClockMs: Date.now() - startedAt,
			marker: stdout.includes("MULTIROLE_LIVE_OK") || stderr.includes("MULTIROLE_LIVE_OK"),
			agent: agent ? { name: agent.name, roles: agent.roles, callCount: agent.callCount, lastRole: agent.lastRole, status: agent.status } : undefined,
			roleRuns: roleRuns.map((item: any) => ({ role: item.role, status: item.status, costUsd: item.costUsd })),
			stdoutTail: stdout.slice(-4000),
			stderrTail: stderr.slice(-4000),
		};
		writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
		if (exitCode !== 0 || !evidence.marker || agent?.callCount !== 2 || agent?.lastRole !== "reviewer"
			|| agent?.status !== "idle" || roleRuns.length !== 2 || new Set(roleRuns.map((item: any) => item.role)).size !== 2) {
			throw new Error(`multi-role live evidence failed; report=${reportPath}`);
		}
		console.log(JSON.stringify(evidence, null, 2));
	} finally {
		try {
			rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		} catch (error) {
			// Windows may release a child-session handle slightly after close; leave
			// evidence intact rather than turning a successful live run into a false
			// failure. The next run uses a different PID-scoped fixture.
			console.warn(`multi-role fixture cleanup deferred: ${String(error)}`);
		}
		config.cleanup();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
