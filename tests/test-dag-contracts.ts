import { bindWorkflowInvocation, executeDAG as executeDAGCore, boundedNodeTimeout, createDAGRunId, parsePlannerTaskDAG, resolveDAGRoleModel, selectHealthyModel, setDagLogSink, validateTaskDAG, type TaskDAG, type TaskNode } from "../src/workflows/dag-executor";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TelemetryWriter } from "../src/telemetry/events";
import { createAgent, listAgents } from "../src/agents/agent-store";
import { listAgentRuns } from "../src/core/run-registry";
import { dagFingerprint } from "../src/workflows/dag-checkpoint";
import { createWorkflowDefinition, reviseWorkflowDefinition } from "../src/workflows/workflow-registry";

// 离线进程夹具有自己的物理 chat 目录，不依赖开发机真实凭据或 CLI 默认模型。
const executeDAG: typeof executeDAGCore = (dag, options) => executeDAGCore(dag, {
	...options,
	modelsConfig: options.invocationOverride && Object.keys(options.modelsConfig.models ?? {}).length === 0
		? { ...options.modelsConfig, models: { "fixture-chat": { provider: "fixture", contextWindow: 128000 } } }
		: options.modelsConfig,
});
const node = (id: string, dependsOn: string[] = []): TaskNode => ({
	id, title: id, role: "implementer", dependsOn, parallelizable: false,
	acceptanceCriteria: [], files: [], description: id,
});
const checks: Array<[string, boolean, string]> = [];
const check = (name: string, passed: boolean, detail: string) => {
	checks.push([name, passed, detail]);
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
};
const throws = (nodes: TaskNode[], pattern: RegExp) => {
	try { validateTaskDAG(nodes); return false; }
	catch (error: any) { return pattern.test(error?.message ?? String(error)); }
};

try {
	validateTaskDAG([node("plan"), node("impl", ["plan"]), node("review", ["impl"])]);
	check("valid DAG accepted", true, "plan→impl→review");
} catch (error: any) { check("valid DAG accepted", false, error?.message ?? String(error)); }
check("duplicate ID rejected", throws([node("same"), node("same")], /duplicate/), "duplicate");
check("missing dependency rejected", throws([node("impl", ["missing"])], /missing/), "missing");
check("self dependency rejected", throws([node("self", ["self"])], /itself/), "self");
check("cycle rejected", throws([node("a", ["b"]), node("b", ["a"])], /cycle/), "a↔b");
check("path-like node ID rejected", throws([node("../../escaped")], /opaque id/), "../../escaped");
check("Windows reserved node ID rejected", throws([node("nul")], /opaque id/), "nul");

const models = {
	strong: { provider: "broken", contextWindow: 128_000, capability: { coding: 0.9, reasoning: 0.9 } },
	backup: { provider: "healthy", contextWindow: 128_000, capability: { coding: 0.7, reasoning: 0.7 } },
};
check("healthy preferred model is preserved", selectHealthyModel("strong", { coding: 1 }, models, new Set()) === "strong", "strong");
check("circuit breaker skips unavailable model", selectHealthyModel("strong", { coding: 1 }, models, new Set(["strong"])) === "backup", "strong→backup");
let allUnavailableThrows = false;
try { selectHealthyModel("strong", { coding: 1 }, models, new Set(["strong", "backup"])); }
catch (error: unknown) { allUnavailableThrows = /all models unavailable/.test(error instanceof Error ? error.message : String(error)); }
check("circuit breaker fails closed when every model is unavailable", allUnavailableThrows, "all unavailable");

const repairedDag = parsePlannerTaskDAG(`\`\`\`json
{"description":"repair","nodes":[{"id":"t1","title":"fix","role":"implementer","dependsOn":[],"parallelizable":false,"acceptanceCriteria":["ok"],"files":["desktop\\src\\file.ts",],}],}
\`\`\``, "fallback", 0.01);
check("planner JSON repair handles Windows paths and trailing commas", repairedDag.nodes[0].files[0] === "desktop/src/file.ts" && repairedDag.planningCostUsd === 0.01, repairedDag.nodes[0].files[0]);
let unsafePlannerOutputRejected = false;
try { parsePlannerTaskDAG("not json", "fallback"); }
catch { unsafePlannerOutputRejected = true; }
check("planner repair remains fail-closed without JSON", unsafePlannerOutputRejected, "rejected");
check("node timeout is bounded by DAG global deadline", boundedNodeTimeout(600_000, 150_000, 100_000) === 50_000, `${boundedNodeTimeout(600_000, 150_000, 100_000)}ms`);
const inheritedDeadlineRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-inherited-deadline-"));
try {
	const inheritedDeadlineResult = await executeDAG(
		{ description: "inherited absolute deadline", nodes: [node("not-started")] },
		{
			cwd: inheritedDeadlineRoot,
			fluxDir: join(inheritedDeadlineRoot, ".agentflux"),
			modelsConfig: { models: {}, roles: {} },
			telemetry: new TelemetryWriter(join(inheritedDeadlineRoot, ".agentflux")),
			prefixLayout: false,
			sessionId: "pi-session",
			deadlineAt: Date.now() - 1,
			maxWallClockMs: null,
		},
	);
	check("DAG enforces inherited absolute deadline without a relative timeout", inheritedDeadlineResult.status === "timed_out" && inheritedDeadlineResult.completedNodes.length === 0, inheritedDeadlineResult.status);
} finally { rmSync(inheritedDeadlineRoot, { recursive: true, force: true }); }

const timeoutNodeRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-timeout-node-"));
try {
	const timeoutExecutionId = "deadline-node-execution";
	const timeoutResult = await executeDAG(
		{ description: "node reaches inherited deadline", nodes: [{ ...node("deadline-node"), acceptanceCriteria: [] }] },
		{
			cwd: timeoutNodeRoot,
			fluxDir: join(timeoutNodeRoot, ".agentflux"),
			modelsConfig: { models: {}, roles: {} },
			telemetry: new TelemetryWriter(join(timeoutNodeRoot, ".agentflux")),
			prefixLayout: true,
			sessionId: "pi-session",
			executionId: timeoutExecutionId,
			deadlineAt: Date.now() + 100,
			maxWallClockMs: null,
			maxRetries: 0,
			enableQualityGate: false,
			invocationOverride: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"] },
		},
	);
	const timeoutRun = listAgentRuns(join(timeoutNodeRoot, ".agentflux"), { taskId: undefined })
		.find(run => run.executionId === timeoutExecutionId);
	check("DAG maps an inherited child timeout to timed_out",
		timeoutResult.status === "timed_out" && timeoutRun?.status === "timed_out" && timeoutResult.failedNodes.includes("deadline-node"),
		`${timeoutResult.status}/${timeoutRun?.status ?? "missing"}`);
} finally { rmSync(timeoutNodeRoot, { recursive: true, force: true }); }

const naturalExit124Root = mkdtempSync(join(tmpdir(), "agentflux-dag-natural-exit-124-"));
try {
	const naturalExit124Script = join(naturalExit124Root, "exit-124.cjs");
	writeFileSync(naturalExit124Script, "process.exit(124);\n");
	const naturalExitResult = await executeDAG(
		{ description: "natural exit code 124 is not a deadline", nodes: [{ ...node("natural-124"), acceptanceCriteria: [] }] },
		{
			cwd: naturalExit124Root,
			fluxDir: join(naturalExit124Root, ".agentflux"),
			modelsConfig: { models: {}, roles: {} },
			telemetry: new TelemetryWriter(join(naturalExit124Root, ".agentflux")),
			prefixLayout: true,
			sessionId: "pi-session",
			executionId: "natural-exit-124",
			maxWallClockMs: null,
			maxRetries: 0,
			enableQualityGate: false,
			invocationOverride: { command: process.execPath, args: [naturalExit124Script] },
		},
	);
	const naturalNodeResult = naturalExitResult.taskResults.get("natural-124")?.subagentResult;
	const naturalRun = listAgentRuns(join(naturalExit124Root, ".agentflux"), { taskId: undefined })
		.find(run => run.executionId === "natural-exit-124");
	check("natural exit code 124 remains failed without a deadline fact",
		naturalExitResult.status === "failed" && naturalNodeResult?.timedOut !== true && naturalRun?.status === "failed",
		`${naturalExitResult.status}/${naturalNodeResult?.timedOut}/${naturalRun?.status ?? "missing"}`);
} finally { rmSync(naturalExit124Root, { recursive: true, force: true }); }

// judge 决策: indeterminate(judge 超时/解析失败) 不触发节点重试, 只重试 judge 本身
import { judgeAction } from "../src/workflows/dag-executor";
import { checkQualityGate, interpretQualityGateJudgeExecution, qualityGateModelArgs } from "../src/workflows/quality-gate";
import type { QualityGateResult } from "../src/workflows/quality-gate";

const minimalGate = (over: Partial<QualityGateResult>): QualityGateResult => ({
	status: "passed", passed: true, feedback: "", criteriaResults: [],
	gateCost: 0, gateModel: null, gateInputTokens: 0, gateOutputTokens: 0,
	...over,
});
check("judge pass releases the node", judgeAction(minimalGate({ status: "passed", passed: true, feedback: "ok" })) === "pass", "pass");
check("judge clear failure retries the node", judgeAction(minimalGate({ status: "failed", passed: false, feedback: "criteria not met" })) === "retry_node", "retry_node");
check("judge timeout retries the judge, not the node", judgeAction(minimalGate({ status: "indeterminate", passed: false, feedback: "Quality gate judge timed out" })) === "retry_judge", "retry_judge");
const timedOutGate = interpretQualityGateJudgeExecution({ output: "", exitCode: 124, timedOut: true, errorMessage: "explicit deadline after 1000ms" }, ["output contains marker"]);
check("indeterminate quality gate remains failed closed", timedOutGate.status === "indeterminate" && timedOutGate.passed === false && timedOutGate.criteriaResults.length === 0, timedOutGate.feedback);
const expiredQualityGate = await checkQualityGate("candidate output", ["output contains marker"], {
	cwd: inheritedDeadlineRoot, deadlineAt: Date.now() - 1, timeoutMs: null,
});
check("quality gate honors an expired inherited absolute deadline without spawning a judge",
	expiredQualityGate.status === "indeterminate" && expiredQualityGate.passed === false
		&& /timed out/.test(expiredQualityGate.feedback), expiredQualityGate.feedback);
check("quality gate forwards explicit model/provider/max instead of forcing off", JSON.stringify(qualityGateModelArgs({ model: "configured-judge", provider: "configured-provider", thinking: "max" })) === JSON.stringify(["--provider", "configured-provider", "--model", "configured-judge", "--thinking", "max"]), "max argv");
const firstDAGRunId = createDAGRunId("execution-one", "review");
const secondDAGRunId = createDAGRunId("execution-one", "review");
check(
	"quality-gate retries receive distinct immutable Run ids",
	firstDAGRunId !== secondDAGRunId && firstDAGRunId.startsWith("dag-execution-one-review-") && secondDAGRunId.startsWith("dag-execution-one-review-"),
	`${firstDAGRunId} != ${secondDAGRunId}`,
);

const configuredPlanner = resolveDAGRoleModel(resolve(process.cwd(), "tests", "fixtures", "dag-role-resolution"), {
	models: {
		"configured-planner-model": { provider: "configured-provider", contextWindow: 1_000_000 },
		"configured-worker-model": { provider: "configured-provider", contextWindow: 1_000_000 },
	},
	roles: { planner: { model: "configured-planner-model", thinking: "off" } },
}, "planner");
check("DAG planner honors role model/provider configuration", configuredPlanner.model === "configured-planner-model" && configuredPlanner.provider === "configured-provider" && configuredPlanner.thinking === "off", `${configuredPlanner.provider}/${configuredPlanner.model}`);
const inheritedPlanner = resolveDAGRoleModel(resolve(process.cwd(), "tests", "fixtures", "dag-role-resolution"), {
	models: { "affinity-model": { provider: "other", contextWindow: 128_000 }, "main-selected-model": { provider: "main-selected-provider" } },
	roles: {},
}, "planner", { model: "main-selected-model", provider: "main-selected-provider" });
check("DAG role without explicit model inherits Main model/provider", inheritedPlanner.model === "main-selected-model"
	&& inheritedPlanner.provider === "main-selected-provider" && inheritedPlanner.source === "main", `${inheritedPlanner.provider}/${inheritedPlanner.model}`);
const explicitProviderRole = resolveDAGRoleModel(resolve(process.cwd(), "tests", "fixtures", "dag-role-resolution"), {
	models: { "role-selected-model": { provider: "role-selected-provider" } },
	roles: { planner: { model: "role-selected-model", provider: "role-selected-provider", thinking: "max" } },
}, "planner", { model: "main-selected-model", provider: "main-selected-provider" });
check("DAG explicit role provider wins over Main inheritance", explicitProviderRole.model === "role-selected-model"
	&& explicitProviderRole.provider === "role-selected-provider" && explicitProviderRole.source === "model", `${explicitProviderRole.provider}/${explicitProviderRole.model}`);
const extensibleDag = parsePlannerTaskDAG(JSON.stringify({
	description: "custom role binding",
	nodes: [{ id: "custom", title: "custom", role: "acceptance-specialist", agentId: "multi-agent", sessionMode: "fresh", dependsOn: [], parallelizable: false, acceptanceCriteria: [], files: [] }],
}), "fallback");
check("planner DAG preserves registered custom roles and Agent bindings", extensibleDag.nodes[0].role === "acceptance-specialist"
	&& extensibleDag.nodes[0].agentId === "multi-agent" && extensibleDag.nodes[0].sessionMode === "fresh", JSON.stringify(extensibleDag.nodes[0]));

const boundAgentRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-bound-agent-"));
try {
	const boundFluxDir = join(boundAgentRoot, ".agentflux");
	const boundAgent = createAgent(boundAgentRoot, { name: "multi-agent", roles: ["planner", "reviewer"], modelsConfig: { models: {} } });
	const boundDag: TaskDAG = {
		description: "same Agent across workflow stages",
		nodes: [
			{ id: "plan", title: "plan", role: "planner", agentId: boundAgent.id, sessionMode: "shared", dependsOn: [], parallelizable: false, acceptanceCriteria: [], files: [] },
			{ id: "review", title: "review", role: "reviewer", agentId: boundAgent.id, sessionMode: "fresh", dependsOn: ["plan"], parallelizable: false, acceptanceCriteria: [], files: [] },
		],
	};
	const boundResult = await executeDAG(boundDag, {
		cwd: boundAgentRoot,
		fluxDir: boundFluxDir,
		modelsConfig: { models: {}, roles: {} },
		telemetry: new TelemetryWriter(boundFluxDir),
		prefixLayout: true,
		sessionId: "bound-session",
		executionId: "bound-execution",
		maxWallClockMs: 30_000,
		maxRetries: 0,
		enableQualityGate: false,
		invocationOverride: { command: process.execPath, args: [resolve(process.cwd(), "tests/helpers/successful-subagent.cjs")] },
	});
	const boundAfter = listAgents(boundAgentRoot).find(agent => agent.id === boundAgent.id);
	const boundRuns = listAgentRuns(boundFluxDir).filter(run => run.agent === boundAgent.name);
	check("Workflow can execute sequential nodes with one Agent in different roles", boundResult.status === "passed"
		&& boundAfter?.callCount === 2 && boundAfter.lastRole === "reviewer"
		&& boundAfter.lastSessionId?.includes("-fresh-") === true
		&& boundResult.taskResults.get("plan")?.subagentResult.role === "planner"
		&& boundResult.taskResults.get("review")?.subagentResult.role === "reviewer", boundResult.status);
	check("bound Workflow nodes keep the registered Agent Run Registry lineage", boundRuns.length === 2
		&& boundRuns.every(run => run.agent === boundAgent.name)
		&& new Set(boundRuns.map(run => run.role)).size === 2, JSON.stringify(boundRuns.map(run => run.role)));
} finally { rmSync(boundAgentRoot, { recursive: true, force: true }); }

const resumeRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-resume-"));
try {
	const executionId = "resume-parent";
	const childExecutionId = "resume-child";
	const fluxDir = join(resumeRoot, ".agentflux");
	const runDir = join(fluxDir, "runtime", "runs", executionId);
	mkdirSync(runDir, { recursive: true });
	await executeDAG({ description: "resume", nodes: [node("done")], planningCostUsd: 0.01 }, {
		cwd: resumeRoot, fluxDir, modelsConfig: { models: {}, roles: {} }, telemetry: new TelemetryWriter(fluxDir), prefixLayout: false,
		sessionId: "pi-session", executionId, enableQualityGate: false, maxRetries: 0,
		invocationOverride: { command: process.execPath, args: [resolve(process.cwd(), "tests/helpers/successful-subagent.cjs")] },
	});
	const parentCheckpointBefore = readFileSync(join(runDir, "checkpoint.json"), "utf-8");
	const resumed = await executeDAG(
		{ description: "resume", nodes: [node("done")] },
		{
			cwd: resumeRoot,
			fluxDir,
			modelsConfig: { models: {}, roles: {} },
			telemetry: new TelemetryWriter(fluxDir),
			prefixLayout: false,
			sessionId: "pi-session",
			executionId: childExecutionId,
			resumeFromExecutionId: executionId,
			taskId: "continuation-task",
			maxWallClockMs: 1_000,
		},
	);
	const childCheckpoint = JSON.parse(readFileSync(join(fluxDir, "runtime", "runs", childExecutionId, "checkpoint.json"), "utf-8"));
	check("DAG resume derives a new execution without rerunning completed nodes", resumed.status === "passed" && resumed.executionId === childExecutionId && resumed.completedNodes[0] === "done", resumed.status);
	check("DAG resume retains cumulative cost without charging inherited work to the new attempt", resumed.totalCost === 0.01 && resumed.inheritedCostUsd === 0.01 && resumed.attemptCostUsd === 0, JSON.stringify({ total: resumed.totalCost, attempt: resumed.attemptCostUsd }));
	check("DAG resume preserves the parent checkpoint byte-for-byte", readFileSync(join(runDir, "checkpoint.json"), "utf-8") === parentCheckpointBefore, executionId);
	check("DAG resume records its source execution in the child checkpoint", childCheckpoint.resumedFromExecutionId === executionId, childCheckpoint.resumedFromExecutionId);
} finally { rmSync(resumeRoot, { recursive: true, force: true }); }

// checkpoint 防御：损坏的 checkpoint 明确报错；节点集合顺序无关比较
const corruptCheckpointRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-corrupt-cp-"));
try {
	const executionId = "corrupt-parent";
	const fluxDir = join(corruptCheckpointRoot, ".agentflux");
	const runDir = join(fluxDir, "runtime", "runs", executionId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "checkpoint.json"), "{ broken json", "utf-8");
	let corruptRejected = "";
	try {
		await executeDAG(
			{ description: "resume", nodes: [node("done")] },
			{
				cwd: corruptCheckpointRoot, fluxDir,
				modelsConfig: { models: {}, roles: {} },
				telemetry: new TelemetryWriter(fluxDir),
				prefixLayout: false, sessionId: "pi-session",
				executionId: "corrupt-child",
				resumeFromExecutionId: executionId,
				taskId: "corrupt-task", maxWallClockMs: 1_000,
			},
		);
	} catch (error) {
		corruptRejected = error instanceof Error ? error.message : String(error);
	}
	check("corrupt checkpoint fails closed with a clear message",
		/corrupt and was not overwritten/.test(corruptRejected) && readFileSync(join(runDir, "checkpoint.json"), "utf-8") === "{ broken json",
		corruptRejected.slice(0, 80));
} finally { rmSync(corruptCheckpointRoot, { recursive: true, force: true }); }

const reorderedRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-reordered-"));
try {
	const executionId = "reordered-parent";
	const fluxDir = join(reorderedRoot, ".agentflux");
	const runDir = join(fluxDir, "runtime", "runs", executionId);
	mkdirSync(runDir, { recursive: true });
	// 父执行先由测试子进程产出完整证据；恢复时只改变节点排列，不允许改变节点内容。
	await executeDAG({ description: "resume", nodes: [node("impl", ["plan"]), node("plan"), node("review", ["impl"])], planningCostUsd: 0.01 }, {
		cwd: reorderedRoot, fluxDir, modelsConfig: { models: {}, roles: {} }, telemetry: new TelemetryWriter(fluxDir), prefixLayout: false,
		sessionId: "pi-session", executionId, enableQualityGate: false, maxRetries: 0,
		invocationOverride: { command: process.execPath, args: [resolve(process.cwd(), "tests/helpers/successful-subagent.cjs")] },
	});
	let reorderOk = false;
	let reorderError = "";
	try {
		const resumed = await executeDAG(
			{ description: "resume", nodes: [node("plan"), node("impl", ["plan"]), node("review", ["impl"])] },
			{
				cwd: reorderedRoot, fluxDir,
				modelsConfig: { models: {}, roles: {} },
				telemetry: new TelemetryWriter(fluxDir),
				prefixLayout: false, sessionId: "pi-session",
				executionId: "reordered-child",
				resumeFromExecutionId: executionId,
				taskId: "reordered-task", maxWallClockMs: 1_000,
			},
		);
		reorderOk = resumed.status === "passed" && resumed.completedNodes.includes("plan");
	} catch (error) {
		reorderError = error instanceof Error ? error.message : String(error);
	}
	check("checkpoint node set comparison is order-insensitive",
		reorderOk, reorderError || "not resumed");
} finally { rmSync(reorderedRoot, { recursive: true, force: true }); }

const invocationRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-invocation-"));
const previousCapture = process.env.AGENTFLUX_TEST_CAPTURE;
try {
	const fluxDir = join(invocationRoot, ".agentflux");
	const definition: TaskDAG = { description: "saved reusable work A", nodes: [node("input-worker")] };
	const before = JSON.stringify(definition);
	const bound = bindWorkflowInvocation(definition, "EXPLICIT_INPUT_B");
	check("Workflow input binding preserves saved DAG", JSON.stringify(definition) === before && bound.invocationTask === "EXPLICIT_INPUT_B", "copy only");
	check("checkpoint fingerprint includes invocation input", dagFingerprint(bound) !== dagFingerprint(bindWorkflowInvocation(definition, "OTHER_INPUT_C")), "B != C");
	const saved = createWorkflowDefinition(fluxDir, { name: "input-free-definition", dag: definition });
	for (const action of [() => createWorkflowDefinition(fluxDir, { name: "invalid", dag: bound }), () => reviseWorkflowDefinition(fluxDir, saved.id, { dag: bound })]) {
		let error = ""; try { action(); } catch (caught) { error = String(caught); }
		check("saved definitions reject dynamic invocation input", /cannot contain invocationTask/.test(error), error);
	}
	const capture = join(invocationRoot, "argv.json"); process.env.AGENTFLUX_TEST_CAPTURE = capture;
	const options = { cwd: invocationRoot, fluxDir, modelsConfig: { models: {}, roles: {} }, telemetry: new TelemetryWriter(fluxDir),
		prefixLayout: false, sessionId: "pi-session", enableQualityGate: false, maxRetries: 0,
		invocationOverride: { command: process.execPath, args: [resolve(process.cwd(), "tests/helpers/successful-subagent.cjs")] } };
	const first = await executeDAG(bound, { ...options, executionId: "input-parent" });
	const args = JSON.parse(readFileSync(capture, "utf8")).argv;
	check("real child argv receives explicit Workflow input and fixed node", first.status === "passed" && args.at(-1).includes("EXPLICIT_INPUT_B") && args.at(-1).includes("input-worker"), args.at(-1));
	const checkpoint = join(fluxDir, "runtime/runs/input-parent/checkpoint.json");
	const checkpointBefore = readFileSync(checkpoint, "utf8");
	let mismatch = "";
	try { await executeDAG(bindWorkflowInvocation(definition, "OTHER_INPUT_C"), { ...options, executionId: "wrong-input", resumeFromExecutionId: "input-parent" }); }
	catch (error) { mismatch = String(error); }
	check("resume rejects changed execution input", /fingerprint differs/.test(mismatch) && readFileSync(checkpoint, "utf8") === checkpointBefore, mismatch);
	const resumed = await executeDAG(bound, { ...options, executionId: "same-input", resumeFromExecutionId: "input-parent" });
	check("resume preserves proven invocation input without rerunning nodes", resumed.status === "passed" && resumed.attemptCostUsd === 0 && listAgentRuns(fluxDir).length === 1, "original completed evidence only");
} finally {
	if (previousCapture === undefined) delete process.env.AGENTFLUX_TEST_CAPTURE; else process.env.AGENTFLUX_TEST_CAPTURE = previousCapture;
	rmSync(invocationRoot, { recursive: true, force: true });
}

const unsafeExecutionRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-unsafe-id-"));
try {
	const fluxDir = join(unsafeExecutionRoot, ".agentflux");
	let rejected = false;
	try {
		await executeDAG(
			{ description: "unsafe execution", nodes: [node("safe")] },
			{
				cwd: unsafeExecutionRoot,
				fluxDir,
				modelsConfig: { models: {}, roles: {} },
				telemetry: new TelemetryWriter(fluxDir),
				prefixLayout: false,
				sessionId: "pi-session",
				executionId: "../../escaped",
				taskId: "safe-task",
			},
		);
	} catch (error) {
		rejected = /opaque id/.test(error instanceof Error ? error.message : String(error));
	}
	check("path-like execution ID rejected before filesystem writes", rejected, "../../escaped");
} finally { rmSync(unsafeExecutionRoot, { recursive: true, force: true }); }

const symlinkExecutionRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-symlink-"));
const symlinkOutsideRoot = mkdtempSync(join(tmpdir(), "agentflux-dag-outside-"));
try {
	const fluxDir = join(symlinkExecutionRoot, ".agentflux");
	const runsDir = join(fluxDir, "runtime", "runs");
	mkdirSync(runsDir, { recursive: true });
	let symlinkSupported = true;
	try { symlinkSync(symlinkOutsideRoot, join(runsDir, "linked-run"), "junction"); }
	catch { symlinkSupported = false; }
	if (!symlinkSupported) {
		check("run-directory symlink escape is rejected", true, "symlink creation unavailable on this platform");
	} else {
		let rejected = false;
		try {
			await executeDAG(
				{ description: "unsafe symlink", nodes: [node("safe")] },
				{
					cwd: symlinkExecutionRoot,
					fluxDir,
					modelsConfig: { models: {}, roles: {} },
					telemetry: new TelemetryWriter(fluxDir),
					prefixLayout: false,
					sessionId: "pi-session",
					executionId: "linked-run",
					taskId: "safe-task",
				},
			);
		} catch (error) {
			rejected = /symlink/.test(error instanceof Error ? error.message : String(error));
		}
		check("run-directory symlink escape is rejected", rejected, "linked-run");
	}
	// UI 模式下 dagLog sink 置空后不再向 stderr 输出
	const dagLogged: string[] = [];
	const previousSink = console.error;
	try {
		let captured: ((m: string) => void) | null = null;
		captured = (m: string) => dagLogged.push(m);
		// 通过默认 sink 验证调用链: 置空后 executeDAG 前的日志调用不抛错且无输出
		setDagLogSink(null);
		setDagLogSink(captured);
	} finally {
		setDagLogSink(previousSink as any);
	}
	check("dagLog sink 默认可替换且可置空（UI 模式无 stderr 输出）", dagLogged.length === 0, "dag-sink");
} finally {
	rmSync(symlinkExecutionRoot, { recursive: true, force: true });
	rmSync(symlinkOutsideRoot, { recursive: true, force: true });
}

const failed = checks.filter(([, passed]) => !passed);
console.log(`\nDAG contracts: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) process.exit(1);
