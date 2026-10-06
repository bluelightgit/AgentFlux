// 三个 production Main：真实 Run → Claim 引用保护 → 删除引用后 GC；不伪造 Registry 状态。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getPiCliPath, loadLiveConfig } from "./live-config";
import { hasAssistantFinalMarker, parseJsonLines } from "../helpers/pi-json-output";
import { isProcessAlive } from "../../src/core/fs-lock";

const source = resolve(import.meta.dirname, "../..");
const iteration = `${Date.now()}-${process.pid}`;
const root = join(source, ".agentflux/test-workspaces", `gc-references-${iteration}`);
const results = join(source, ".agentflux/test-results");
const read = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function main() {
	const config = loadLiveConfig("core");
	const report: any = { root, startedAt: new Date().toISOString(), passed: false, workspaceRetained: true,
		provider: config.providerId, model: config.mainModel, thinking: config.thinking, backend: config.subagentRuntime, phases: [], pricingAuthoritative: false };
	mkdirSync(join(root, ".agentflux"), { recursive: true }); mkdirSync(results, { recursive: true });
	const store = (name: string) => read(join(root, ".agentflux/runtime", `${name}.json`));
	async function run(label: string, calls: any[], marker: string) {
		const prompt = `Perform exactly these tool calls in order, using the given JSON arguments. Do not retry, inspect files, diagnose, or call any other tools. If any call fails, stop and report the error instead of the success marker. Calls: ${JSON.stringify(calls)}. After all calls succeed, reply exactly ${marker}.`;
		const child = spawn(process.execPath, [getPiCliPath(),
			"--mode", "json", "-p", "--approve", "--no-extensions", "-e", join(root, "dist/extension/host-entry.ts"),
			"--no-skills", "--tools", "read,flux_agent,flux_issue", ...config.cliArgs(config.mainModel), prompt],
			{ cwd: root, env: config.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		const phase: any = { label, pid: child.pid, testWatchdogMs: 360000 }; report.phases.push(phase);
		let stdout = "", stderr = "";
		child.stdout.on("data", chunk => { stdout += chunk; appendFileSync(join(root, `${label}.stdout.jsonl`), chunk); });
		child.stderr.on("data", chunk => { stderr += chunk; appendFileSync(join(root, `${label}.stderr.log`), chunk); });
		const stop = () => {
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
			if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
		};
		const watchdog = setTimeout(() => { phase.watchdogExpired = true; stop(); }, phase.testWatchdogMs);
		try {
			phase.exitCode = await new Promise<number>((done, reject) => { child.on("error", reject); child.on("close", code => done(code ?? 1)); });
			assert.equal(phase.exitCode, 0); assert.ok(!phase.watchdogExpired);
			assert.ok(hasAssistantFinalMarker(stdout, stderr, marker));
			const actual = parseJsonLines(stdout).filter(event => event.type === "tool_execution_start")
				.map(event => ({ tool: event.toolName, args: event.args }));
			assert.deepEqual(actual, calls, "exact ordered calls, with no unexpected calls or retries");
		} finally {
			clearTimeout(watchdog); stop(); const until = Date.now() + 10000;
			while (child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(50);
			phase.alive = child.pid ? isProcessAlive(child.pid) : false;
			assert.equal(phase.alive, false);
		}
	}
	try {
		assert.equal(process.env.AGENTFLUX_LIVE_BUILT, "1");
		cpSync(join(source, "dist/extension"), join(root, "dist/extension"), { recursive: true });
		report.dist = ["entry.js", "host-entry.ts", "subagent-entry.js", "background-preload.mjs"].map(name => ({ name, sha256: hash(join(root, "dist/extension", name)) }));
		writeFileSync(join(root, "README.md"), "# GC reference fixture\n");
		writeFileSync(join(root, ".agentflux/models.json"), JSON.stringify(config.fluxModelsJson()));
		writeFileSync(join(root, ".agentflux/agentflux.json"), JSON.stringify({ subagent_runtime: config.subagentRuntime, budget: { max_cost_per_task: 0.15,
			max_iterations: 3, max_turns_per_task: 16, max_input_tokens_per_task: 100000, max_parallel_agents: 2, max_wall_clock_seconds: null }, pricing: { enable_remote_fetch: false } }));
		await run("seed", [
			{ tool: "flux_agent", args: { action: "create", name: "gc-protected", role: "reviewer", scope: "project" } },
			{ tool: "flux_agent", args: { action: "create", name: "gc-unreferenced", role: "reviewer", scope: "project" } },
			{ tool: "flux_agent", args: { action: "run", agent: "gc-protected", background: false, task: "Do not use tools. Reply exactly GC_AGENT_READY." } },
			{ tool: "flux_issue", args: { action: "create", title: "GC reference test", body: "Keep the registered worker until this Issue is removed." } },
		], "GC_SEED_OK");
		const initialAgents = store("agents").agents;
		assert.equal(initialAgents.length, 2);
		const agent = initialAgents.find((item: any) => item.name === "gc-protected"); assert.ok(agent);
		const initialRuns = store("runs"); assert.equal(initialRuns.runs.length, 1);
		assert.equal(initialRuns.runs[0].agentId, agent.id, "production Run must bind the registered stable Agent ID");
		assert.equal(initialRuns.runs[0].status, "completed");
		assert.equal(initialRuns.runs[0].backend, config.subagentRuntime, "the configured backend must actually execute the Run");
		assert.equal(initialRuns.runs[0].costAccounting?.complete, true);
		const initialTasks = store("tasks");
		const issue = read(join(root, ".agentflux/issues.json")).issues[0]; assert.ok(issue);
		const sessionsDir = join(root, ".agentflux/runtime/sessions");
		const sessions = readdirSync(sessionsDir).filter(name => name.endsWith(".jsonl")).map(name => ({ path: join(sessionsDir, name), sha256: hash(join(sessionsDir, name)) }));
		assert.ok(sessions.length > 0);
		await run("protect", [
			{ tool: "flux_issue", args: { action: "claim", issueId: issue.id, agent: agent.id, scope: "retention" } },
			{ tool: "flux_agent", args: { action: "gc", keepLatestK: 0 } },
		], "GC_PROTECTED_OK");
		const protectedIssue = read(join(root, ".agentflux/issues.json")).issues[0];
		assert.equal(protectedIssue.claims.length, 1);
		assert.equal(protectedIssue.claims[0].agentId, agent.id);
		assert.equal(protectedIssue.claims[0].agent, agent.name);
		assert.deepEqual(store("agents").agents.map((item: any) => item.id), [agent.id]);
		for (const session of sessions) assert.equal(hash(session.path), session.sha256);
		report.protected = { agent, claim: protectedIssue.claims[0], sessions };
		const claimId = protectedIssue.claims[0].id;
		await run("release", [
			{ tool: "flux_issue", args: { action: "submit", issueId: issue.id, claimId, plan: "Reference protection verified." } },
			{ tool: "flux_issue", args: { action: "review", issueId: issue.id, claimId, verdict: "pass" } },
			{ tool: "flux_issue", args: { action: "resolve", issueId: issue.id } },
			{ tool: "flux_issue", args: { action: "delete", issueId: issue.id } },
			{ tool: "flux_agent", args: { action: "gc", keepLatestK: 0 } },
		], "GC_RELEASED_OK");
		assert.equal(store("agents").agents.length, 0);
		assert.equal(read(join(root, ".agentflux/issues.json")).issues.length, 0);
		assert.deepEqual(store("runs").runs, initialRuns.runs, "GC must not alter historical Runs");
		const tasks = store("tasks");
		assert.equal(tasks.tasks.length, 3); assert.equal(tasks.executions.length, 3);
		assert.ok(tasks.tasks.every((task: any) => task.status === "completed" && task.deadlineAt === undefined));
		assert.ok(tasks.executions.every((execution: any) => execution.status === "completed" && execution.outcome?.status === "success" && execution.deadlineAt === undefined));
		for (const old of initialTasks.tasks) assert.deepEqual(tasks.tasks.find((task: any) => task.id === old.id), old);
		for (const old of initialTasks.executions) assert.deepEqual(tasks.executions.find((task: any) => task.id === old.id), old);
		report.tasks = tasks; report.runs = store("runs").runs;
		const activePath = join(root, ".agentflux/runtime/active-context.json");
		if (existsSync(activePath)) {
			report.activeContext = read(activePath);
			assert.equal(report.activeContext.entries.length, 0, "all owned leases must be released");
		}
		report.passed = true;
	} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
	finally {
		report.finishedAt = new Date().toISOString();
		const path = join(results, `gc-references-${iteration}.json`);
		writeFileSync(path, JSON.stringify(report, null, 2)); writeFileSync(join(results, "gc-references-latest.json"), JSON.stringify(report, null, 2));
		config.cleanup(); console.log(JSON.stringify({ passed: report.passed, error: report.error, reportPath: path }));
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
