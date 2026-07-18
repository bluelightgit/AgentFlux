/**
 * Paid provider smoke for the real Desktop AgentRuntime.
 *
 * Uses an isolated project fixture so provider/role choices never mutate the
 * operator's workspace configuration. The two cases cover a direct M1 run and
 * an M2 run that must actually invoke a DeepSeek Flash subagent.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

type ModePolicy = "M1" | "M2" | "M5";
type RuntimeEvent = { type: string; data?: unknown };
type Snapshot = {
	runId: string;
	pid: number | null;
	status: string;
	events: RuntimeEvent[];
	exitCode: number | null;
	errorCode: string | null;
	stderrSummary: string;
};
type Runtime = {
	start(options: { projectRoot: string; name: string; initialTask: string; taskTitle: string; modePolicy: ModePolicy }): Promise<string>;
	list(): Snapshot[];
	stop(runId: string): Promise<void>;
	shutdownAll(): Promise<void>;
};

const require = createRequire(import.meta.url);
const sourceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(sourceRoot, ".agentflux", "test-workspaces", `deepseek-provider-${process.pid}`);
const desktopRoot = join(sourceRoot, "desktop");
const piCli = join(sourceRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const { AgentRuntime } = require(join(desktopRoot, "dist-electron", "agent-runtime.js")) as {
	AgentRuntime: new () => Runtime;
};

const sleep = (ms: number) => new Promise(resolveDone => setTimeout(resolveDone, ms));
const runtime = new AgentRuntime();

function createFixture(): void {
	mkdirSync(join(fixtureRoot, ".agentflux", "agents"), { recursive: true });
	cpSync(join(sourceRoot, "src"), join(fixtureRoot, "src"), { recursive: true });
	cpSync(join(sourceRoot, "README.md"), join(fixtureRoot, "README.md"));
	writeFileSync(join(fixtureRoot, ".agentflux", "agentflux.json"), JSON.stringify({
		preference: {
			profile: "custom",
			vector: { cost_sensitivity: 0.5, accuracy_priority: 0.8, latency_priority: 0.5, parallelism_willingness: 0.5, multi_agent_willingness: 0.8 },
			scenarios: {},
			escalate_hint: "suggest",
		},
		budget: { max_cost_per_task: 0.25, max_iterations: 3, max_wall_clock_seconds: 180 },
	}, null, 2));
	writeFileSync(join(fixtureRoot, ".agentflux", "models.json"), JSON.stringify({
		models: {
			"deepseek-v4-pro": { provider: "octopus-anthropic", contextWindow: 1_000_000 },
			"deepseek-v4-flash": { provider: "octopus-anthropic", contextWindow: 1_000_000 },
		},
		roles: {
			planner: { model: "deepseek-v4-pro", thinking: "off" },
			implementer: { model: "deepseek-v4-flash", thinking: "off" },
			reviewer: { model: "deepseek-v4-pro", thinking: "off" },
			tester: { model: "deepseek-v4-flash", thinking: "off" },
		},
		sharedSkills: [],
	}, null, 2));
	writeFileSync(join(fixtureRoot, ".agentflux", "agents", "flash-smoke.md"), `---
name: flash-smoke
description: Read-only provider smoke subagent
model: deepseek-v4-flash
provider: octopus-anthropic
thinking: off
tools: read,grep,find
---
Do not edit files. Follow the requested output format exactly.
`);
}

function serialized(snapshot: Snapshot): string {
	return JSON.stringify(snapshot.events);
}

async function waitFor(label: string, read: () => Snapshot | undefined, timeoutMs = 180_000): Promise<Snapshot> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await sleep(100);
	}
	throw new Error(`timeout waiting for ${label}`);
}

async function runCase(input: {
	name: string;
	model: "deepseek-v4-pro" | "deepseek-v4-flash";
	modePolicy: ModePolicy;
	prompt: string;
	marker: string;
	requireTool?: "flux_subagent" | "flux_execute_plan";
}): Promise<Record<string, unknown>> {
	process.env.AGENTFLUX_PI_MODEL = `octopus-anthropic/${input.model}`;
	process.env.AGENTFLUX_PI_THINKING = "off";
	const runId = await runtime.start({
		projectRoot: fixtureRoot,
		name: input.name,
		taskTitle: `${input.model} ${input.modePolicy} provider smoke`,
		initialTask: input.prompt,
		modePolicy: input.modePolicy,
	});
	const settled = await waitFor(`${input.name} marker and settled state`, () => {
		const current = runtime.list().find(item => item.runId === runId);
		if (!current) return undefined;
		if (current.status === "failed") throw new Error(`${input.name} failed: ${current.errorCode}\n${current.stderrSummary}`);
		return current.status === "done" && serialized(current).includes(input.marker) ? current : undefined;
	});
	const eventJson = serialized(settled);
	const invokedSubagent = eventJson.includes("flux_subagent") && eventJson.includes("flash-smoke");
	const invokedDag = eventJson.includes("flux_execute_plan");
	const dagPassed = eventJson.includes("[DAG Execution: PASSED]");
	if (input.requireTool === "flux_subagent" && !invokedSubagent) {
		throw new Error(`${input.name} returned a marker without invoking flash-smoke through flux_subagent`);
	}
	if (input.requireTool === "flux_execute_plan" && !invokedDag) {
		throw new Error(`${input.name} returned a marker without invoking flux_execute_plan`);
	}
	if (input.requireTool === "flux_execute_plan" && !dagPassed) {
		throw new Error(`${input.name} invoked flux_execute_plan but the DAG did not pass`);
	}
	await runtime.stop(runId);
	const exited = await waitFor(`${input.name} graceful exit`, () => {
		const current = runtime.list().find(item => item.runId === runId);
		return current?.exitCode === 0 ? current : undefined;
	}, 15_000);
	return {
		model: input.model,
		modePolicy: input.modePolicy,
		runId,
		pid: settled.pid,
		invokedSubagent,
		invokedDag,
		dagPassed,
		eventTypes: [...new Set(settled.events.map(event => event.type))],
		exitCode: exited.exitCode,
	};
}

async function main(): Promise<void> {
	createFixture();
	process.env.AGENTFLUX_PI_CLI = piCli;
	const evidence: Array<Record<string, unknown>> = [];
	try {
		evidence.push(await runCase({
			name: `deepseek-pro-m1-${Date.now().toString(36)}`,
			model: "deepseek-v4-pro",
			modePolicy: "M1",
			marker: "AGENTFLUX_DEEPSEEK_PRO_M1_OK",
			prompt: "这是只读运行时测试。不要调用工具，不要修改文件，只回复精确文本 AGENTFLUX_DEEPSEEK_PRO_M1_OK",
		}));
		evidence.push(await runCase({
			name: `deepseek-flash-m2-${Date.now().toString(36)}`,
			model: "deepseek-v4-flash",
			modePolicy: "M2",
			marker: "AGENTFLUX_DEEPSEEK_FLASH_M2_OK",
			requireTool: "flux_subagent",
			prompt: "这是只读多 Agent 测试。必须且只调用一次 flux_subagent，agent 设为 flash-smoke，task 要求它只回复 SUBAGENT_FLASH_OK。确认工具成功返回后，只回复精确文本 AGENTFLUX_DEEPSEEK_FLASH_M2_OK。不要修改任何文件。",
		}));
		evidence.push(await runCase({
			name: `deepseek-pro-flash-m5-${Date.now().toString(36)}`,
			model: "deepseek-v4-pro",
			modePolicy: "M5",
			marker: "AGENTFLUX_DEEPSEEK_M5_DAG_OK",
			requireTool: "flux_execute_plan",
			prompt: "只读多 Agent DAG 测试：检查 README.md 的第一行并报告，禁止修改任何文件。必须调用一次 flux_execute_plan 执行此任务；工具完成后，只回复精确文本 AGENTFLUX_DEEPSEEK_M5_DAG_OK。",
		}));
		if (new Set(evidence.map(item => item.pid)).size !== evidence.length) throw new Error("provider cases did not use independent Desktop runtime PIDs");
		process.stdout.write(`${JSON.stringify({ ok: true, fixtureIsolated: true, evidence }, null, 2)}\n`);
	} finally {
		await runtime.shutdownAll();
		delete process.env.AGENTFLUX_PI_CLI;
		delete process.env.AGENTFLUX_PI_MODEL;
		delete process.env.AGENTFLUX_PI_THINKING;
		const fixtureBase = resolve(sourceRoot, ".agentflux", "test-workspaces");
		if (!resolve(fixtureRoot).startsWith(`${fixtureBase}\\`)) throw new Error(`unsafe fixture cleanup path: ${fixtureRoot}`);
		rmSync(fixtureRoot, { recursive: true, force: true });
		try { rmSync(dirname(fixtureRoot), { recursive: false }); } catch { /* other fixtures or absent */ }
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
