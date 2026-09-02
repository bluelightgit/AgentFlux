import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkflowDefinition, getWorkflowDefinition } from "../../src/workflows/workflow-registry";
import { loadLiveConfig } from "./live-config";

const sourceRoot = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "agentflux-live-workflow-modify-"));
const sessionDir = join(root, "sessions");
const fluxDir = join(root, ".agentflux");
const piCli = resolve(sourceRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const config = loadLiveConfig("workflow-modify");

function run(prompt: string): string {
	const result = spawnSync(process.execPath, [
		piCli,
		"--mode", "json", "-p", "--approve", "--no-extensions",
		"-e", join(root, "src", "entry.ts"),
		"--no-skills",
		"--tools", "read,grep,find,ls,flux_task,flux_workflow",
		"--session-dir", sessionDir,
		"--session-id", "workflow-modify-live",
		...config.cliArgs(config.mainModel),
		prompt,
	], {
		cwd: root,
		encoding: "utf-8",
		timeout: 300_000,
		maxBuffer: 32 * 1024 * 1024,
		windowsHide: true,
		env: config.env,
	});
	const output = `${result.stdout}\n${result.stderr}`;
	if (result.status !== 0) {
		throw new Error(`workflow modify live failed (status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? "none"})\n${output.slice(-6000)}`);
	}
	return output;
}

try {
	cpSync(join(sourceRoot, "src"), join(root, "src"), { recursive: true });
	mkdirSync(fluxDir, { recursive: true });
	writeFileSync(join(root, "README.md"), "# AgentFlux workflow modify fixture\n");
	writeFileSync(join(fluxDir, "agentflux.json"), JSON.stringify({
		budget: { max_cost_per_task: 0.25, max_iterations: 3, max_wall_clock_seconds: 240 },
		pricing: { enable_remote_fetch: false },
	}));
	writeFileSync(join(fluxDir, "models.json"), JSON.stringify(config.fluxModelsJson()));
	const seed = createWorkflowDefinition(fluxDir, {
		name: "readme-check",
		sourceTaskId: "seed-task",
		dag: {
			description: "Read the README fixture",
			nodes: [{
				id: "read",
				title: "Read README",
				role: "implementer",
				dependsOn: [],
				parallelizable: false,
				acceptanceCriteria: ["Output includes WORKFLOW_READ_OK"],
				files: ["README.md"],
				description: "Read the first line of README.md and output WORKFLOW_READ_OK.",
			}],
		},
	});

	const modified = run("修改工作区里保存的 readme-check 流程：保留读取步骤，并在其后增加独立 reviewer 复核；执行修改后的流程，全部通过后以 WORKFLOW_MODIFY_OK 结束。");
	if (!modified.includes("[DAG Execution: PASSED]") || !modified.includes("WORKFLOW_MODIFY_OK")) {
		throw new Error(`modified Workflow did not pass\n${modified.slice(-6000)}`);
	}
	const v1 = getWorkflowDefinition(fluxDir, `${seed.id}@1`);
	const v2 = getWorkflowDefinition(fluxDir, `${seed.id}@2`);
	if (!v1 || !v2 || v1.dag.nodes.length !== 1 || v2.dag.nodes.length < 2) {
		throw new Error("Workflow v1/v2 history was not preserved after modify");
	}

	const reused = run("完整复用 readme-check 的最新版本再次执行，不要重新设计流程；完成后以 WORKFLOW_V2_REUSE_OK 结束。");
	if (!reused.includes("[DAG Execution: PASSED]") || !reused.includes("WORKFLOW_V2_REUSE_OK")) {
		throw new Error(`Workflow v2 reuse did not pass\n${reused.slice(-6000)}`);
	}
	const definitions = JSON.parse(readFileSync(join(fluxDir, "runtime", "workflows.json"), "utf-8")).definitions;
	const tasks = JSON.parse(readFileSync(join(fluxDir, "runtime", "tasks.json"), "utf-8")).tasks;
	if (definitions.length !== 2 || definitions.some((item: any) => item.id !== seed.id)) {
		throw new Error("Modify/reuse changed Workflow identity or created an unexpected version");
	}
	if (!tasks.some((task: any) => task.operation === "continue" && task.resource?.id === seed.id)
		|| !tasks.some((task: any) => task.operation === "reuse" && task.resource?.id === seed.id)) {
		throw new Error("Workflow modify/reuse task lineage is incomplete");
	}
	console.log(JSON.stringify({
		ok: true,
		workflowId: seed.id,
		versions: definitions.map((item: any) => item.version),
		v1Nodes: v1.dag.nodes.length,
		v2Nodes: v2.dag.nodes.length,
		modifiedAndReused: true,
	}, null, 2));
} finally {
	rmSync(root, { recursive: true, force: true });
	config.cleanup();
}
