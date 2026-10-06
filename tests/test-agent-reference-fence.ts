import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface WorkerOutcome {
	ok: boolean;
	value?: any;
	error?: string;
}

interface WorkerHandle {
	child: ChildProcess;
	role: "writer" | "gc";
	stdout: string;
	stderr: string;
}

type ReferenceKind = "run" | "task" | "claim" | "workflow";
type DeleteMode = "delete-agent" | "gc-agents" | "delete-session";
type Phase = "writer-first" | "gc-first";

let checks = 0;
function check(value: unknown, message: string): void {
	if (!value) throw new Error(message);
	checks++;
	console.log(`✓ ${message}`);
}

function waitForFile(path: string, timeoutMs = 12_000): void {
	const waiter = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`barrier timeout: ${path}`);
		Atomics.wait(waiter, 0, 0, 10);
	}
}

function signal(path: string): void {
	writeFileSync(path, `${process.pid}\n`, "utf8");
}

function readText(path: string): string | undefined {
	try { return readFileSync(path, "utf8"); } catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

function readJson(path: string): any {
	return JSON.parse(readFileSync(path, "utf8"));
}

function snapshot(paths: string[]): Map<string, string | undefined> {
	return new Map(paths.map(path => [path, readText(path)]));
}

function assertSnapshot(before: Map<string, string | undefined>, message: string): void {
	for (const [path, value] of before) assert.equal(readText(path), value, `${message}: ${path}`);
}

function stopWorker(handle: WorkerHandle): void {
	if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
	try { handle.child.kill("SIGKILL"); } catch { /* child may have exited between the checks */ }
}

function spawnWorker(
	sourceRoot: string,
	tsxCli: string,
	workerScript: string,
	role: "writer" | "gc",
	operation: string,
	phase: string,
	root: string,
	barrierDir: string,
	data: Record<string, unknown>,
	env: NodeJS.ProcessEnv,
): WorkerHandle {
	const child = spawn(process.execPath, [tsxCli, workerScript, role, operation, phase, root, barrierDir, JSON.stringify(data)], {
		cwd: root,
		env,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const handle: WorkerHandle = { child, role, stdout: "", stderr: "" };
	child.stdout?.on("data", chunk => { handle.stdout += chunk.toString(); });
	child.stderr?.on("data", chunk => { handle.stderr += chunk.toString(); });
	return handle;
}

function waitWorker(handle: WorkerHandle, timeoutMs = 12_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolveExit, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			stopWorker(handle);
			reject(new Error(`${handle.role} worker timed out; stderr=${handle.stderr.slice(-2000)}`));
		}, timeoutMs);
		handle.child.once("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		handle.child.once("exit", (code, signalCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveExit({ code, signal: signalCode });
		});
	});
}

function workerResult(barrierDir: string, role: "writer" | "gc"): WorkerOutcome {
	const path = join(barrierDir, `${role}-result.json`);
	waitForFile(path);
	return readJson(path) as WorkerOutcome;
}

interface RaceResult {
	writer: WorkerOutcome;
	gc: WorkerOutcome;
	writerExit: { code: number | null; signal: NodeJS.Signals | null };
	gcExit: { code: number | null; signal: NodeJS.Signals | null };
	writerAgentBytes?: string;
}

async function runFenceRace(
	sourceRoot: string,
	tsxCli: string,
	workerScript: string,
	env: NodeJS.ProcessEnv,
	root: string,
	writerOperation: string,
	gcOperation: string,
	phase: Phase,
	data: Record<string, unknown>,
): Promise<RaceResult> {
	const barrierDir = mkdtempSync(join(root, "barrier-"));
	const writer = spawnWorker(sourceRoot, tsxCli, workerScript, "writer", writerOperation, phase, root, barrierDir, data, env);
	const gc = spawnWorker(sourceRoot, tsxCli, workerScript, "gc", gcOperation, phase, root, barrierDir, data, env);
	let writerAgentBytes: string | undefined;
	try {
		waitForFile(join(barrierDir, "writer-ready"));
		waitForFile(join(barrierDir, "gc-ready"));
		if (phase === "writer-first") {
			signal(join(barrierDir, "writer-start"));
			waitForFile(join(barrierDir, "writer-acquired"));
			signal(join(barrierDir, "gc-start"));
			signal(join(barrierDir, "writer-commit"));
			waitForFile(join(barrierDir, "writer-committed"));
			writerAgentBytes = readText(join(root, ".agentflux", "runtime", "agents.json"));
			signal(join(barrierDir, "writer-release"));
			waitForFile(join(barrierDir, "gc-done"));
		} else {
			signal(join(barrierDir, "gc-start"));
			waitForFile(join(barrierDir, "gc-acquired"));
			signal(join(barrierDir, "writer-start"));
			waitForFile(join(barrierDir, "writer-attempted"));
			signal(join(barrierDir, "gc-commit"));
			waitForFile(join(barrierDir, "gc-committed"));
			signal(join(barrierDir, "gc-release"));
			waitForFile(join(barrierDir, "writer-done"));
		}
		const [writerExit, gcExit] = await Promise.all([waitWorker(writer), waitWorker(gc)]);
		if (writerExit.code !== 0 || gcExit.code !== 0) {
			throw new Error(`reference workers failed: writer=${writerExit.code}/${writer.stderr}; gc=${gcExit.code}/${gc.stderr}`);
		}
		return {
			writer: workerResult(barrierDir, "writer"),
			gc: workerResult(barrierDir, "gc"),
			writerExit,
			gcExit,
			writerAgentBytes,
		};
	} finally {
		stopWorker(writer);
		stopWorker(gc);
	}
}

async function runDirectPair(
	tsxCli: string,
	workerScript: string,
	env: NodeJS.ProcessEnv,
	root: string,
	writerOperation: string,
	gcOperation: string,
	data: Record<string, unknown>,
): Promise<RaceResult> {
	const barrierDir = mkdtempSync(join(root, "direct-barrier-"));
	const writer = spawnWorker(resolve("."), tsxCli, workerScript, "writer", writerOperation, "direct", root, barrierDir, data, env);
	const gc = spawnWorker(resolve("."), tsxCli, workerScript, "gc", gcOperation, "direct", root, barrierDir, data, env);
	try {
		waitForFile(join(barrierDir, "writer-ready"));
		waitForFile(join(barrierDir, "gc-ready"));
		signal(join(barrierDir, "writer-start"));
		signal(join(barrierDir, "gc-start"));
		waitForFile(join(barrierDir, "writer-done"));
		waitForFile(join(barrierDir, "gc-done"));
		const [writerExit, gcExit] = await Promise.all([waitWorker(writer), waitWorker(gc)]);
		if (writerExit.code !== 0 || gcExit.code !== 0) {
			throw new Error(`direct workers failed: writer=${writerExit.code}/${writer.stderr}; gc=${gcExit.code}/${gc.stderr}`);
		}
		return {
			writer: workerResult(barrierDir, "writer"),
			gc: workerResult(barrierDir, "gc"),
			writerExit,
			gcExit,
		};
	} finally {
		stopWorker(writer);
		stopWorker(gc);
	}
}

interface ReferenceFixture {
	root: string;
	fluxDir: string;
	agent: any;
	sessionId: string;
	scope: "project" | "session";
	kind: ReferenceKind;
	deleteMode: DeleteMode;
	taskId?: string;
	executionId?: string;
	issueId?: string;
	workflowName?: string;
	dag?: any;
	referencePath: string;
	sourcePaths: string[];
	data: Record<string, unknown>;
}

function createReferenceFixture(
	sandbox: string,
	kind: ReferenceKind,
	deleteMode: DeleteMode,
	createAgent: any,
	registerTask: any,
	createTaskExecutionPlan: any,
	createIssue: any,
	DEFAULT_CONFIG: any,
): ReferenceFixture {
	const root = mkdtempSync(join(sandbox, `${kind}-${deleteMode}-`));
	const fluxDir = join(root, ".agentflux");
	mkdirSync(join(fluxDir, "runtime"), { recursive: true });
	const scope: "project" | "session" = deleteMode === "delete-session" ? "session" : "project";
	const sessionId = `${kind}-${deleteMode}-owner`;
	const agent = createAgent(root, {
		name: `reference-${kind}-${deleteMode}`,
		scope,
		ownerSessionId: scope === "session" ? sessionId : undefined,
		modelsConfig: { models: {} },
	});
	let taskId: string | undefined;
	let executionId: string | undefined;
	let issueId: string | undefined;
	let workflowName: string | undefined;
	let dag: any;
	if (kind === "run" || kind === "task" || kind === "workflow") {
		taskId = `reference-task-${kind}`;
		executionId = `reference-execution-${kind}`;
		registerTask(fluxDir, sessionId, createTaskExecutionPlan({
			taskId,
			executionId,
			task: `reference ${kind} task`,
			selectedBy: "user",
			budget: DEFAULT_CONFIG.budget,
		}));
	}
	if (kind === "claim") {
		issueId = createIssue(root, {
			title: "reference fence issue",
			description: "reference fence claim",
			createdBy: "test",
		}).id;
	}
	if (kind === "workflow") {
		workflowName = "reference-fence-workflow";
		dag = {
			description: "reference fence workflow",
			nodes: [{
				id: "reference-node",
				title: "reference node",
				role: "assistant",
				agentId: agent.id,
				dependsOn: [],
				parallelizable: false,
				acceptanceCriteria: [],
				files: [],
			}],
		};
	}
	const referencePath = kind === "run"
		? join(fluxDir, "runtime", "runs.json")
		: kind === "task"
			? join(fluxDir, "runtime", "tasks.json")
			: kind === "claim"
				? join(root, ".agentflux", "issues.json")
				: join(fluxDir, "runtime", "workflows.json");
	const sourcePaths = [referencePath, join(fluxDir, "runtime", "active-context.json")];
	return {
		root, fluxDir, agent, sessionId, scope, kind, deleteMode, taskId, executionId, issueId,
		workflowName, dag, referencePath, sourcePaths,
		data: {
			root,
			agentId: agent.id,
			agentName: agent.name,
			ownerSessionId: sessionId,
			targetAgentId: agent.id,
			targetOwnerSessionId: scope === "session" ? sessionId : undefined,
			taskId,
			executionId,
			issueId,
			workflowName,
			sourceTaskId: taskId,
			dag,
		},
	};
}

function assertStableReference(fixture: ReferenceFixture): void {
	const agents = readJson(join(fixture.fluxDir, "runtime", "agents.json")).agents;
	const agent = agents.find((item: any) => item.id === fixture.agent.id);
	assert.ok(agent, "referenced Agent must remain registered");
	switch (fixture.kind) {
		case "run": {
			const run = readJson(fixture.referencePath).runs.find((item: any) => item.id === `run-${fixture.agent.id}`);
			assert.ok(run && run.agentId === fixture.agent.id && run.agent === fixture.agent.name, "Run stores the stable agentId and canonical name");
			break;
		}
		case "task": {
			const task = readJson(fixture.referencePath).tasks.find((item: any) => item.id === fixture.taskId);
			const member = task?.team?.find((item: any) => item.agentId === fixture.agent.id);
			assert.ok(member && member.name === fixture.agent.name, "Task.team stores the stable agentId and canonical name");
			break;
		}
		case "claim": {
			const issue = readJson(fixture.referencePath).issues.find((item: any) => item.id === fixture.issueId);
			const claim = issue?.claims?.find((item: any) => item.agentId === fixture.agent.id);
			assert.ok(claim && claim.agent === fixture.agent.name, "Claim stores the stable agentId and canonical name");
			break;
		}
		case "workflow": {
			const definitions = readJson(fixture.referencePath).definitions;
			const nodes = definitions.flatMap((definition: any) => definition.dag?.nodes ?? []);
			assert.ok(nodes.some((node: any) => node.agentId === fixture.agent.id), "Workflow node stores the canonical stable agentId");
			break;
		}
	}
}

function verifyRace(fixture: ReferenceFixture, phase: Phase, result: RaceResult, beforeSource: Map<string, string | undefined>): void {
	if (phase === "writer-first") {
		check(result.writer.ok, `${fixture.kind}/${fixture.deleteMode} writer-first writer commits`);
		if (fixture.deleteMode === "delete-agent") {
			check(!result.gc.ok && /referenced|cannot be deleted/i.test(result.gc.error ?? ""), `${fixture.kind}/delete-agent writer-first rejects referenced Agent`);
		} else {
			check(result.gc.ok && Array.isArray(result.gc.value) && result.gc.value.length === 0, `${fixture.kind}/${fixture.deleteMode} writer-first GC preserves the referenced Agent`);
		}
		assertStableReference(fixture);
		assert.equal(readText(join(fixture.fluxDir, "runtime", "agents.json")), result.writerAgentBytes, "GC rejection does not rewrite the Agent source");
	} else {
		check(result.gc.ok, `${fixture.kind}/${fixture.deleteMode} GC-first removes the unreferenced Agent`);
		check(!result.writer.ok && /missing|inaccessible|ambiguous|not found/i.test(result.writer.error ?? ""), `${fixture.kind}/${fixture.deleteMode} GC-first rejects the writer before source mutation`);
		assertSnapshot(beforeSource, `${fixture.kind}/${fixture.deleteMode} GC-first source remains byte-for-byte unchanged`);
		const agents = readJson(join(fixture.fluxDir, "runtime", "agents.json")).agents;
		assert.equal(agents.some((item: any) => item.id === fixture.agent.id), false, "GC-first removes only the target Agent");
	}
}

async function main(): Promise<void> {
	const sandbox = mkdtempSync(join(tmpdir(), "agentflux-agent-reference-fence-"));
	const home = join(sandbox, "home");
	mkdirSync(home, { recursive: true });
	const previousEnv = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	};
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
	const sourceRoot = resolve(import.meta.dirname, "..");
	const tsxCli = join(sourceRoot, "node_modules", "tsx", "dist", "cli.mjs");
	const workerScript = resolve(import.meta.dirname, "helpers", "agent-reference-worker.ts");
	const workerEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") };
	try {
		const { updateReferenceStore, withAgentReferenceFence } = await import("../src/core/agent-reference-fence");
		const { createAgent, deleteAgent, deleteSessionAgents, gcAgents, resolveAgentSessionFile } = await import("../src/agents/agent-store");
		const { createIssue, claimIssue } = await import("../src/core/community");
		const { registerAgentRun } = await import("../src/core/run-registry");
		const { createTaskExecutionPlan } = await import("../src/core/task-execution");
		const { registerTask, updateTaskMetadata } = await import("../src/core/task-registry");
		const { DEFAULT_CONFIG } = await import("../src/core/types");
		const { createWorkflowDefinition } = await import("../src/workflows/workflow-registry");
		const { runLifecycleGc } = await import("../src/core/lifecycle-gc");
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");

		check(withAgentReferenceFence(() => withAgentReferenceFence(() => "reentrant")) === "reentrant", "reference fence is synchronous and reentrant in one process");
		let asyncRejected = false;
		try { withAgentReferenceFence(async () => "not allowed"); } catch (error) { asyncRejected = /synchronous callback|cannot span asynchronous/i.test(String(error)); }
		check(asyncRejected, "reference fence rejects an async callback");
		let promiseRejected = false;
		try { withAgentReferenceFence(() => Promise.resolve("not allowed")); } catch (error) { promiseRejected = /cannot span asynchronous/i.test(String(error)); }
		check(promiseRejected && withAgentReferenceFence(() => 42) === 42, "reference fence releases after a rejected promise-returning callback");
		const probePath = join(sandbox, "reference-store-probe.json");
		const probeValue = updateReferenceStore(probePath, () => ({ count: 0 }), (value): value is { count: number } => !!value && typeof value === "object" && typeof (value as any).count === "number", store => {
			store.count++;
			return store.count;
		});
		check(probeValue === 1 && readJson(probePath).count === 1, "updateReferenceStore composes the common fence with atomic store updates");

		for (const kind of ["run", "task", "claim", "workflow"] as const) {
			for (const deleteMode of ["delete-agent", "gc-agents", "delete-session"] as const) {
				for (const phase of ["writer-first", "gc-first"] as const) {
					const fixture = createReferenceFixture(sandbox, kind, deleteMode, createAgent, registerTask, createTaskExecutionPlan, createIssue, DEFAULT_CONFIG);
					const beforeSource = snapshot(fixture.sourcePaths);
					try {
						const result = await runFenceRace(sourceRoot, tsxCli, workerScript, workerEnv, fixture.root, kind, deleteMode, phase, fixture.data);
						verifyRace(fixture, phase, result, beforeSource);
					} finally {
						rmSync(fixture.root, { recursive: true, force: true });
					}
				}
			}
		}

		for (const phase of ["writer-first", "gc-first"] as const) {
			const root = mkdtempSync(join(sandbox, `owner-${phase}-`));
			mkdirSync(join(root, ".agentflux", "runtime"), { recursive: true });
			const ownerA = "session-a";
			const ownerB = "session-b";
			const agentA = createAgent(root, { name: `owner-a-${phase}`, scope: "session", ownerSessionId: ownerA, modelsConfig: { models: {} } });
			const agentB = createAgent(root, { name: `owner-b-${phase}`, scope: "session", ownerSessionId: ownerB, modelsConfig: { models: {} } });
			const taskId = `owner-task-${phase}`;
			const executionId = `owner-execution-${phase}`;
			registerTask(join(root, ".agentflux"), ownerB, createTaskExecutionPlan({ taskId, executionId, task: "owner isolation", selectedBy: "user", budget: DEFAULT_CONFIG.budget }));
			const data = {
				root,
				agentId: agentB.id,
				agentName: agentB.name,
				ownerSessionId: ownerB,
				targetAgentId: agentA.id,
				targetOwnerSessionId: ownerA,
				taskId,
				executionId,
			};
			try {
				const result = await runFenceRace(sourceRoot, tsxCli, workerScript, workerEnv, root, "task", "delete-session", phase, data);
				check(result.writer.ok && result.gc.ok, `owner isolation ${phase} allows session-B writer and session-A cleanup`);
				const agents = readJson(join(root, ".agentflux", "runtime", "agents.json")).agents;
				check(!agents.some((item: any) => item.id === agentA.id) && agents.some((item: any) => item.id === agentB.id), `owner isolation ${phase} never deletes another session's Agent`);
				const task = readJson(join(root, ".agentflux", "runtime", "tasks.json")).tasks.find((item: any) => item.id === taskId);
				check(task?.team?.some((member: any) => member.agentId === agentB.id), `owner isolation ${phase} keeps the other session's stable reference`);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}

		const logicalRoot = mkdtempSync(join(sandbox, "logical-names-"));
		mkdirSync(join(logicalRoot, ".agentflux", "runtime"), { recursive: true });
		try {
			const persistentOnly = createAgent(logicalRoot, { name: "persistent-only-target", modelsConfig: { models: {} } });
			registerAgentRun(join(logicalRoot, ".agentflux"), {
				id: "logical-persistent-run",
				sessionId: "logical-session",
				agent: "logical-actor-not-registered",
				role: "assistant",
				currentTask: "logical persistent actor",
				kind: "persistent",
			});
			const removedPersistentOnly = gcAgents(logicalRoot, 0);
			check(removedPersistentOnly.includes(persistentOnly.name), "kind=persistent without agentId does not imply a registered Agent");

			const logicalRunAgent = createAgent(logicalRoot, { name: "logical-run-name", modelsConfig: { models: {} } });
			registerAgentRun(join(logicalRoot, ".agentflux"), {
				id: "logical-name-run",
				sessionId: "logical-session",
				agent: logicalRunAgent.name,
				role: "assistant",
				currentTask: "legacy logical name",
				kind: "persistent",
			});
			const logicalTask = registerTask(join(logicalRoot, ".agentflux"), "logical-session", createTaskExecutionPlan({ taskId: "logical-task", executionId: "logical-execution", task: "logical team", selectedBy: "user", budget: DEFAULT_CONFIG.budget }));
			const logicalTeamAgent = createAgent(logicalRoot, { name: "logical-team-name", modelsConfig: { models: {} } });
			updateTaskMetadata(join(logicalRoot, ".agentflux"), logicalTask.id, { team: [{ name: logicalTeamAgent.name, persistent: true }] });
			const logicalIssue = createIssue(logicalRoot, { title: "logical claim", description: "legacy claim", createdBy: "test" });
			const logicalClaimAgent = createAgent(logicalRoot, { name: "logical-claim-name", modelsConfig: { models: {} } });
			claimIssue(logicalRoot, logicalIssue.id, logicalClaimAgent.name, "legacy-scope");
			const logicalRemoved = gcAgents(logicalRoot, 0);
			check(!logicalRemoved.includes(logicalRunAgent.name), "legacy logical Run names remain conservatively protected");
			check(!logicalRemoved.includes(logicalTeamAgent.name), "legacy logical Task.team names remain conservatively protected");
			check(!logicalRemoved.includes(logicalClaimAgent.name), "legacy logical Claim names remain conservatively protected");
		} finally {
			rmSync(logicalRoot, { recursive: true, force: true });
		}

		for (const corruptStore of ["runs", "tasks", "issues", "workflows", "agents"] as const) {
			const root = mkdtempSync(join(sandbox, `corrupt-${corruptStore}-`));
			mkdirSync(join(root, ".agentflux", "runtime"), { recursive: true });
			const agent = createAgent(root, { name: `corrupt-${corruptStore}`, modelsConfig: { models: {} } });
			const paths: Record<string, string> = {
				runs: join(root, ".agentflux", "runtime", "runs.json"),
				tasks: join(root, ".agentflux", "runtime", "tasks.json"),
				issues: join(root, ".agentflux", "issues.json"),
				workflows: join(root, ".agentflux", "runtime", "workflows.json"),
				agents: join(root, ".agentflux", "runtime", "agents.json"),
			};
			const corruptPath = paths[corruptStore];
			writeFileSync(corruptPath, "{ definitely corrupt\n", "utf8");
			const corruptBytes = readText(corruptPath);
			const agentPath = join(root, ".agentflux", "runtime", "agents.json");
			const agentBytes = readText(agentPath);
			try {
				let gcRejected = false;
				try { gcAgents(root, 0); } catch (error) { gcRejected = /corrupt|invalid|JSON/i.test(String(error)); }
				check(gcRejected, `corrupt ${corruptStore} store makes Agent GC fail closed`);
				let deleteRejected = false;
				try { deleteAgent(root, agent.id); } catch (error) { deleteRejected = /corrupt|invalid|JSON|reference/i.test(String(error)); }
				check(deleteRejected, `corrupt ${corruptStore} store makes deleteAgent fail closed`);
				let sessionRejected = false;
				try { deleteSessionAgents(root, "corrupt-session"); } catch (error) { sessionRejected = /corrupt|invalid|JSON|reference/i.test(String(error)); }
				check(sessionRejected, `corrupt ${corruptStore} store makes deleteSessionAgents fail closed`);
				let lifecycleBlocked = false;
				try {
					const report = runLifecycleGc(join(root, ".agentflux"), DEFAULT_CONFIG.retention, { now: new Date(Date.now() + 10 * 60 * 60 * 1000) });
					lifecycleBlocked = !!report.blockedReason;
				} catch { lifecycleBlocked = true; }
				check(lifecycleBlocked, `corrupt ${corruptStore} store blocks lifecycle GC`);
				assert.equal(readText(agentPath), agentBytes, `corrupt ${corruptStore} store never rewrites Agent registry`);
				assert.equal(readText(corruptPath), corruptBytes, `corrupt ${corruptStore} store remains unchanged`);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}

		const duplicateRoot = mkdtempSync(join(sandbox, "duplicate-name-ttl-"));
		mkdirSync(join(duplicateRoot, ".agentflux", "runtime"), { recursive: true });
		try {
			const duplicatePath = join(duplicateRoot, ".agentflux", "runtime", "agents.json");
			writeFileSync(duplicatePath, JSON.stringify({ agents: [
				{ id: "agent-duplicate-keep", name: "duplicate-name", scope: "project", sessionId: "agent-duplicate-keep", status: "idle", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" },
				{ id: "agent-duplicate-remove", name: "duplicate-name", scope: "project", sessionId: "agent-duplicate-remove", status: "idle", createdAt: "2020-01-02T00:00:00.000Z", updatedAt: "2020-01-02T00:00:00.000Z" },
			] }, null, 2), "utf8");
			const taskId = "duplicate-name-task";
			registerTask(join(duplicateRoot, ".agentflux"), "duplicate-session", createTaskExecutionPlan({ taskId, executionId: "duplicate-name-execution", task: "duplicate name reference", selectedBy: "user", budget: DEFAULT_CONFIG.budget }));
			updateTaskMetadata(join(duplicateRoot, ".agentflux"), taskId, { team: [{ name: "stale-name", agentId: "agent-duplicate-keep", persistent: true }] });
			const duplicateStore = readJson(duplicatePath);
			for (const item of duplicateStore.agents) { item.status = "archived"; item.createdAt = "2020-01-01T00:00:00.000Z"; item.updatedAt = "2020-01-01T00:00:00.000Z"; }
			writeFileSync(duplicatePath, JSON.stringify(duplicateStore, null, 2), "utf8");
			const report = runLifecycleGc(join(duplicateRoot, ".agentflux"), { ...DEFAULT_CONFIG.retention, terminal_agent_ttl_hours: 1 }, { now: new Date("2026-01-01T00:00:00.000Z") });
			const remaining = readJson(duplicatePath).agents;
			check(report.removed.persistentAgents.length === 1 && remaining.some((item: any) => item.id === "agent-duplicate-keep") && !remaining.some((item: any) => item.id === "agent-duplicate-remove"), "duplicate Agent names use stable IDs for TTL candidate deletion");
			check(readJson(join(duplicateRoot, ".agentflux", "runtime", "tasks.json")).tasks[0].team[0].agentId === "agent-duplicate-keep", "duplicate-name GC does not leave the protected stable reference dangling");
		} finally {
			rmSync(duplicateRoot, { recursive: true, force: true });
		}

		const globalRoot = mkdtempSync(join(sandbox, "global-guard-"));
		mkdirSync(join(globalRoot, ".agentflux", "runtime"), { recursive: true });
		try {
			const globalAgent = createAgent(globalRoot, { name: "global-guard-agent", scope: "global", modelsConfig: { models: {} } });
			const globalPath = join(home, ".agentflux", "agents.json");
			const globalBefore = readText(globalPath);
			let denied = false;
			try { deleteAgent(globalRoot, globalAgent.id); } catch (error) { denied = /complete cross-project reference inventory/i.test(String(error)); }
			check(denied, "global Agent deletion requires a complete cross-project inventory");
			check(gcAgents(globalRoot, 0).length === 0, "ordinary project GC never deletes a global Agent");
			assert.equal(readText(globalPath), globalBefore, "global deletion rejection leaves the isolated global store unchanged");
			const globalStore = readJson(globalPath);
			const stored = globalStore.agents.find((item: any) => item.id === globalAgent.id);
			stored.status = "archived";
			stored.createdAt = "2020-01-01T00:00:00.000Z";
			stored.updatedAt = "2020-01-01T00:00:00.000Z";
			writeFileSync(globalPath, JSON.stringify(globalStore, null, 2), "utf8");
			const lifecycle = runLifecycleGc(join(globalRoot, ".agentflux"), DEFAULT_CONFIG.retention, { now: new Date("2026-01-01T00:00:00.000Z") });
			check(!lifecycle.removed.persistentAgents.includes(globalAgent.name), "lifecycle GC also preserves global Agents without all-project inventory");
		} finally {
			rmSync(globalRoot, { recursive: true, force: true });
		}

		const workflowRoot = mkdtempSync(join(sandbox, "workflow-lock-order-"));
		mkdirSync(join(workflowRoot, ".agentflux", "runtime"), { recursive: true });
		try {
			const taskId = "workflow-lock-task";
			const executionId = "workflow-lock-execution";
			registerTask(join(workflowRoot, ".agentflux"), "workflow-session", createTaskExecutionPlan({ taskId, executionId, task: "workflow lock order", selectedBy: "user", budget: DEFAULT_CONFIG.budget }));
			const definition = createWorkflowDefinition(join(workflowRoot, ".agentflux"), { name: "workflow-lock-order", dag: { description: "lock order", nodes: [] }, sourceTaskId: taskId });
			const result = await runDirectPair(tsxCli, workerScript, workerEnv, workflowRoot, "workflow-bind", "workflow-delete", { root: workflowRoot, agentId: "unused", agentName: "unused", taskId, workflowId: definition.id });
			check(result.writer.ok !== result.gc.ok, "Workflow→Task bind and Workflow delete race without deadlock");
			const task = readJson(join(workflowRoot, ".agentflux", "runtime", "tasks.json")).tasks.find((item: any) => item.id === taskId);
			const workflows = readJson(join(workflowRoot, ".agentflux", "runtime", "workflows.json")).definitions;
			check(!task?.resource || workflows.some((item: any) => item.id === task.resource.id), "Workflow race never leaves a dangling task.resource");
		} finally {
			rmSync(workflowRoot, { recursive: true, force: true });
		}

		for (const phase of ["writer-first", "gc-first"] as const) {
			const forkRoot = mkdtempSync(join(sandbox, `fork-session-fence-${phase}-`));
			mkdirSync(join(forkRoot, ".agentflux", "runtime", "sessions"), { recursive: true });
			try {
				const source = createAgent(forkRoot, { name: "fence-fork-source", modelsConfig: { models: {} } });
				const sessionDir = join(forkRoot, ".agentflux", "runtime", "sessions");
				const sourceSession = SessionManager.create(forkRoot, sessionDir, { id: `${source.sessionId}-cap-source` });
				sourceSession.appendMessage({ role: "user", content: "fence source", timestamp: Date.now() } as any);
				sourceSession.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "fence source answer" }],
					provider: "test",
					model: "test-model",
					api: "openai-completions",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as any);
				const sourceFile = sourceSession.getSessionFile();
				assert.ok(sourceFile && existsSync(sourceFile), `fork source session file exists: ${sourceFile}`);
				const sourceBytes = readText(sourceFile!);
				const orphan = join(sessionDir, "orphan-fence-session.jsonl");
				writeFileSync(orphan, "orphan\n", "utf8");
				const old = new Date(Date.now() - 4 * 60 * 60 * 1000);
				utimesSync(orphan, old, old);
				const policy = { ...DEFAULT_CONFIG.retention, orphan_session_ttl_hours: 1 };
				const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
				const result = await runFenceRace(sourceRoot, tsxCli, workerScript, workerEnv, forkRoot, "fork", "lifecycle-gc", phase, {
					root: forkRoot, agentId: source.id, agentName: source.name, forkFrom: sourceFile, modelsConfig: { models: {} }, policy, now: future,
				});
				check(result.writer.ok && result.gc.ok, `fork ${phase} writer and session GC both complete (writer=${result.writer.error ?? "ok"}; gc=${result.gc.error ?? "ok"})`);
				const fork = readJson(join(forkRoot, ".agentflux", "runtime", "agents.json")).agents.find((item: any) => item.name === "fence-fork-child");
				assert.ok(fork && fork.lineage?.origin === "fork", `fork ${phase} registers the fork Agent`);
				assert.ok(resolveAgentSessionFile(forkRoot, fork), `fork ${phase} keeps the fork session physical file`);
				check(result.gc.value?.removed?.orphanSessions?.includes("orphan-fence-session.jsonl"), `fork ${phase} session GC archives the stale orphan without archiving the fork`);
				assert.equal(readText(sourceFile!), sourceBytes, `fork ${phase} leaves the native source session bytes unchanged`);
			} finally {
				rmSync(forkRoot, { recursive: true, force: true });
			}
		}

		console.log(`Agent reference fence checks passed (${checks})`);
	} finally {
		if (previousEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = previousEnv.HOME;
		if (previousEnv.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousEnv.USERPROFILE;
		if (previousEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousEnv.PI_CODING_AGENT_DIR;
		rmSync(sandbox, { recursive: true, force: true });
	}
}

await main();
