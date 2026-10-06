import { createHash } from "node:crypto";
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { assistantOutputEvidence, parseJsonLines } from "./pi-json-output";
import { buildProcessOutputEvidence, snapshotP002CoreFacts } from "./p0-02-evidence";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);
const ALLOWED_AGENTFLUX_TOOLS = new Set(["flux_task", "flux_agent", "flux_workflow", "flux_issue", "flux_message"]);

export interface CoreSmokeProcessResult {
	label: string;
	pid?: number;
	exitCode: number;
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	startedAt: string;
	finishedAt: string;
	watchdogTimeoutMs: number;
}

export interface CoreSmokeProcessHandle {
	label: string;
	child: ChildProcess;
	result: Promise<CoreSmokeProcessResult>;
	snapshot(): { stdout: string; stderr: string };
}

export interface CoreSmokeCaseExpectation {
	label: string;
	marker: string;
	taskToken: string;
	requiredToolStarts?: Array<string | { toolName: string; action?: string }>;
	resourceType?: "workflow" | "issue";
	minRuns?: number;
	expectedWorkflowNodes?: number;
	agentNames?: string[];
	requireDelivery?: boolean;
	requireCostAccounting?: boolean;
}

export interface CoreSmokeFacts {
	capturedAt: string;
	fixtureRoot: string;
	tasks: any[];
	executions: any[];
	runs: any[];
	agents: any[];
	issues: any[];
	workflows: any[];
	activeContext: any[];
	messages: { envelopes: any[]; deliveries: any[]; cursors: any[] };
	storeArtifacts: any[];
	usage: { runs: Record<string, number>; executions: Record<string, number> };
	costs: {
		runs: number;
		executions: number;
		executionUsage: number;
		agents: number;
		issues: number;
	};
	coreFactConsistency: {
		counts: Record<string, number>;
		checks: Record<string, boolean>;
		failedChecks: string[];
		passed: boolean;
	};
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizedReportPath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

export function portableReportPath(root: string, path: string): string {
	return normalizedReportPath(root, path);
}

function safeLabel(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "process";
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function storeRead(path: string): { exists: boolean; value?: any; text?: string; error?: string } {
	if (!existsSync(path)) return { exists: false };
	try {
		const text = readFileSync(path, "utf8");
		return { exists: true, text, value: JSON.parse(text) };
	} catch (error) {
		return { exists: true, error: String(error) };
	}
}

function storeArtifact(path: string, sourceRoot: string, parsed: ReturnType<typeof storeRead>): any {
	if (!parsed.exists) return { path: normalizedReportPath(sourceRoot, path), exists: false };
	return {
		path: normalizedReportPath(sourceRoot, path),
		exists: true,
		bytes: Buffer.byteLength(parsed.text ?? "", "utf8"),
		sha256: sha256(parsed.text ?? ""),
		parseable: !parsed.error,
		error: parsed.error ?? null,
	};
}

export function isPidAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

/** 只停止本次 harness 传入的、仍然存活的 ChildProcess。 */
export function stopOwnedProcess(child: ChildProcess): boolean {
	const pid = child.pid;
	if (!pid || child.exitCode !== null || child.signalCode !== null || !isPidAlive(pid)) return false;
	if (process.platform === "win32") {
		try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
		catch { try { child.kill("SIGKILL"); } catch { /* exited concurrently */ } }
		return true;
	}
	try { process.kill(-pid, "SIGKILL"); }
	catch { try { child.kill("SIGKILL"); } catch { /* exited concurrently */ } }
	return true;
}

export function isSafeChildPath(basePath: string, candidatePath: string): boolean {
	const base = resolve(basePath);
	const candidate = resolve(candidatePath);
	const descendant = relative(base, candidate);
	return descendant.length > 0 && descendant !== ".."
		&& !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant);
}

export async function waitForOwnedProcesses(children: ChildProcess[], timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (children.every(child => !child.pid || !isPidAlive(child.pid))) return true;
		await new Promise<void>(resolveWait => setTimeout(resolveWait, 50));
	}
	return children.every(child => !child.pid || !isPidAlive(child.pid));
}

export function productionDistEvidence(sourceRoot: string, fixtureRoot: string): any {
	const sourceExtension = join(sourceRoot, "dist", "extension");
	const fixtureExtension = join(fixtureRoot, "dist", "extension");
	const entries = { main: "entry.js", subagent: "subagent-entry.js", backgroundPreload: "background-preload.mjs" };
	const result: any = { builtExtension: true, entries: {} };
	for (const [name, file] of Object.entries(entries)) {
		const sourcePath = join(sourceExtension, file);
		const fixturePath = join(fixtureExtension, file);
		if (!existsSync(sourcePath) || !existsSync(fixturePath)) {
			result.builtExtension = false;
			result.entries[name] = { file, sourcePath, fixturePath, present: false };
			continue;
		}
		const sourceBytes = readFileSync(sourcePath);
		const fixtureBytes = readFileSync(fixturePath);
		result.entries[name] = {
			file,
			sourcePath: normalizedReportPath(sourceRoot, sourcePath),
			fixturePath: normalizedReportPath(sourceRoot, fixturePath),
			present: true,
			sourceBytes: sourceBytes.byteLength,
			fixtureBytes: fixtureBytes.byteLength,
			sourceSha256: sha256(sourceBytes),
			fixtureSha256: sha256(fixtureBytes),
			sameBytes: sourceBytes.equals(fixtureBytes),
		};
		if (!result.entries[name].sameBytes) result.builtExtension = false;
	}
	return result;
}

/** 保存完整 stdout/stderr、最终 assistant 文本和独立退出回执。 */
export function persistCoreSmokeProcessEvidence(
	result: CoreSmokeProcessResult,
	expectedMarker: string,
	sourceRoot: string,
	artifactDir: string,
): any {
	mkdirSync(artifactDir, { recursive: true });
	const output = buildProcessOutputEvidence(result, expectedMarker, sourceRoot, artifactDir);
	const receiptPath = join(artifactDir, `${safeLabel(result.label)}.exit.json`);
	const receipt = {
		label: result.label,
		pid: result.pid ?? null,
		exitCode: result.exitCode,
		signal: result.signal ?? null,
		timedOut: result.timedOut,
		watchdog: { kind: "fixture-process-watchdog", timeoutMs: result.watchdogTimeoutMs },
		startedAt: result.startedAt,
		finishedAt: result.finishedAt,
		closeObserved: true,
		aliveAtReceipt: isPidAlive(result.pid),
		stdout: { path: output.outputArtifacts.stdout.path, bytes: Buffer.byteLength(result.stdout, "utf8"), sha256: sha256(result.stdout) },
		stderr: { path: output.outputArtifacts.stderr.path, bytes: Buffer.byteLength(result.stderr, "utf8"), sha256: sha256(result.stderr) },
	};
	writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
	return { ...output, exitEvidence: { ...receipt, path: normalizedReportPath(sourceRoot, receiptPath) } };
}

function toolStartArgs(event: any): any {
	const args = event?.args ?? event?.arguments;
	if (args && typeof args === "object") return args;
	if (typeof args === "string") {
		try { return JSON.parse(args); } catch { return undefined; }
	}
	return undefined;
}

export function coreSmokeToolStarts(stdout: string, stderr: string): any[] {
	return [...parseJsonLines(stdout), ...parseJsonLines(stderr)]
		.filter(event => event?.type === "tool_execution_start" && typeof event?.toolName === "string")
		.map(event => ({
			toolName: event.toolName,
			action: toolStartArgs(event)?.action ?? null,
			toolCallId: event.toolCallId ?? event.id ?? null,
			args: toolStartArgs(event) ?? null,
		}));
}

export function validateCoreSmokeProcessOutput(
	result: Pick<CoreSmokeProcessResult, "exitCode" | "timedOut" | "stdout" | "stderr">,
	expectation: Pick<CoreSmokeCaseExpectation, "marker" | "requiredToolStarts">,
): any {
	const assistant = assistantOutputEvidence(result.stdout, result.stderr, expectation.marker);
	const starts = coreSmokeToolStarts(result.stdout, result.stderr);
	const requiredToolChecks = (expectation.requiredToolStarts ?? []).map(item => {
		const expected = typeof item === "string" ? { toolName: item } : item;
		const count = starts.filter(start => start.toolName === expected.toolName
			&& (expected.action === undefined || start.action === expected.action)).length;
		return { ...expected, count, passed: count > 0 };
	});
	const invalidAgentFluxTools = starts
		.filter(start => start.toolName.startsWith("flux_") && !ALLOWED_AGENTFLUX_TOOLS.has(start.toolName))
		.map(start => start.toolName);
	return {
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		processSucceeded: result.exitCode === 0 && result.timedOut === false,
		assistant: {
			parseable: assistant.parseable,
			assistantMessageCount: assistant.assistantMessageCount,
			finalAssistantText: assistant.finalAssistantText,
			marker: expectation.marker,
			markerMatched: assistant.markerMatched === true && assistant.markerMatchRule === "trimmed-exact",
			markerMatchRule: assistant.markerMatchRule,
		},
		toolStarts: starts,
		requiredToolChecks,
		invalidAgentFluxTools,
		passed: result.exitCode === 0 && result.timedOut === false
			&& assistant.parseable && assistant.markerMatched === true
			&& assistant.markerMatchRule === "trimmed-exact"
			&& requiredToolChecks.every(check => check.passed)
			&& invalidAgentFluxTools.length === 0,
	};
}

function readDirectoryJson(directory: string, sourceRoot: string, artifactPaths: any[]): any[] {
	if (!existsSync(directory)) return [];
	let files: string[];
	try { files = readdirSync(directory).filter(file => file.endsWith(".json")); } catch { return []; }
	return files.flatMap(file => {
		const path = join(directory, file);
		const parsed = storeRead(path);
		artifactPaths.push(storeArtifact(path, sourceRoot, parsed));
		return parsed.value ? [parsed.value] : [];
	});
}

function readMessageFacts(fluxDir: string, sourceRoot: string, artifactPaths: any[]): CoreSmokeFacts["messages"] {
	const root = join(fluxDir, "shared", "messages-v2");
	const envelopes = readDirectoryJson(join(root, "envelopes"), sourceRoot, artifactPaths);
	const deliveries: any[] = [];
	const deliveriesRoot = join(root, "deliveries");
	if (existsSync(deliveriesRoot)) {
		for (const recipient of readdirSync(deliveriesRoot, { withFileTypes: true })) {
			if (!recipient.isDirectory()) continue;
			for (const delivery of readDirectoryJson(join(deliveriesRoot, recipient.name), sourceRoot, artifactPaths)) deliveries.push(delivery);
		}
	}
	const cursors = readDirectoryJson(join(root, "cursors"), sourceRoot, artifactPaths);
	return { envelopes, deliveries, cursors };
}

function runUsage(runs: any[]): Record<string, number> {
	return {
		turns: runs.reduce((sum, item) => sum + numberOrZero(item.turns), 0),
		input: runs.reduce((sum, item) => sum + numberOrZero(item.input), 0),
		output: runs.reduce((sum, item) => sum + numberOrZero(item.output), 0),
		cacheRead: runs.reduce((sum, item) => sum + numberOrZero(item.cacheRead), 0),
		cacheWrite: runs.reduce((sum, item) => sum + numberOrZero(item.cacheWrite), 0),
		contextTokens: runs.reduce((sum, item) => sum + numberOrZero(item.contextTokens), 0),
		costUsd: runs.reduce((sum, item) => sum + numberOrZero(item.costUsd), 0),
	};
}

function executionUsage(executions: any[]): Record<string, number> {
	return {
		input: executions.reduce((sum, item) => sum + numberOrZero(item.usage?.input), 0),
		output: executions.reduce((sum, item) => sum + numberOrZero(item.usage?.output), 0),
		cacheRead: executions.reduce((sum, item) => sum + numberOrZero(item.usage?.cacheRead), 0),
		cacheWrite: executions.reduce((sum, item) => sum + numberOrZero(item.usage?.cacheWrite), 0),
		costUsd: executions.reduce((sum, item) => sum + numberOrZero(item.usage?.costUsd), 0),
	};
}

/** 复用 P0 Core 事实快照，并补充 Message V2 delivery 与原始 store 摘要。 */
export function snapshotCoreSmokeFacts(fixtureRoot: string, sourceRoot = fixtureRoot): CoreSmokeFacts {
	const fluxDir = join(fixtureRoot, ".agentflux");
	const runtimeDir = join(fluxDir, "runtime");
	const paths = {
		tasks: join(runtimeDir, "tasks.json"),
		runs: join(runtimeDir, "runs.json"),
		agents: join(runtimeDir, "agents.json"),
		workflows: join(runtimeDir, "workflows.json"),
		issues: join(fluxDir, "issues.json"),
		activeContext: join(runtimeDir, "active-context.json"),
	};
	const parsed = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, storeRead(path)])) as Record<keyof typeof paths, ReturnType<typeof storeRead>>;
	const artifactPaths = Object.entries(paths).map(([name, path]) => ({ name, ...storeArtifact(path, sourceRoot, parsed[name as keyof typeof paths]) }));
	const issueIds = Array.isArray(parsed.issues.value?.issues) ? parsed.issues.value.issues.map((issue: any) => issue.id).filter(Boolean) : [];
	const workflowId = Array.isArray(parsed.workflows.value?.definitions) ? parsed.workflows.value.definitions[0]?.id ?? "" : "";
	let p0: any;
	try { p0 = snapshotP002CoreFacts(fixtureRoot, issueIds, workflowId); }
	catch (error) {
		p0 = { tasks: [], executions: [], agents: [], runs: [], issues: [], workflowDefinitions: [], activeContextAtSnapshot: [], usage: { runs: {}, executions: {} }, costUsd: {}, coreFactConsistency: { checks: {}, failedChecks: [String(error)], passed: false } };
	}
	const messages = readMessageFacts(fluxDir, sourceRoot, artifactPaths);
	const envelopes = new Map(messages.envelopes.map(envelope => [envelope.id, envelope]));
	const deliveryReferencesValid = messages.deliveries.every(delivery => {
		const envelope = envelopes.get(delivery.messageId);
		return !!envelope && Array.isArray(envelope.recipients) && envelope.recipients.includes(delivery.recipient)
			&& delivery.schemaVersion === 2 && typeof delivery.status === "string";
	});
	const parseableStores = Object.values(parsed).every(item => !item.error);
	const runs = p0.runs ?? [];
	const executions = p0.executions ?? [];
	const tasks = p0.tasks ?? [];
	const agents = p0.agents ?? [];
	const issues = p0.issues ?? [];
	const workflows = p0.workflowDefinitions ?? [];
	const p0Checks = p0.coreFactConsistency?.checks ?? {};
	const checks: Record<string, boolean> = {
		storesParseable: parseableStores,
		tasksPresent: tasks.length > 0,
		executionsPresent: executions.length > 0,
		taskExecutionLinksValid: p0Checks.taskExecutionLinksValid === true,
		runReferencesValid: runs.length === 0 || p0Checks.runReferencesValid === true,
		parentLineageValid: p0Checks.parentLineageValid === true,
		usageValid: p0Checks.usageValid === true,
		costsValid: p0Checks.costValid === true,
		deliveryReferencesValid,
		allTaskExecutionsTerminal: tasks.every((task: any) => TERMINAL_STATUSES.has(task.status))
			&& executions.every((execution: any) => TERMINAL_STATUSES.has(execution.status)),
		allRunsTerminal: runs.every((run: any) => TERMINAL_STATUSES.has(run.status)),
		noActiveContextEntries: (p0.activeContextAtSnapshot ?? []).length === 0,
	};
	const failedChecks = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
	const runTotals = runUsage(runs);
	const executionTotals = executionUsage(executions);
	return {
		capturedAt: new Date().toISOString(),
		fixtureRoot,
		tasks,
		executions,
		runs,
		agents,
		issues,
		workflows,
		activeContext: p0.activeContextAtSnapshot ?? [],
		messages,
		storeArtifacts: artifactPaths,
		usage: { runs: runTotals, executions: executionTotals },
		costs: {
			runs: runTotals.costUsd,
			executions: executions.reduce((sum: number, item: any) => sum + numberOrZero(item.costUsd), 0),
			executionUsage: executionTotals.costUsd,
			agents: agents.reduce((sum: number, item: any) => sum + numberOrZero(item.totalCostUsd), 0),
			issues: issues.reduce((sum: number, item: any) => sum + numberOrZero(item.costUsd), 0),
		},
		coreFactConsistency: {
			counts: {
				tasks: tasks.length, executions: executions.length, runs: runs.length, agents: agents.length,
				issues: issues.length, workflows: workflows.length,
				envelopes: messages.envelopes.length, deliveries: messages.deliveries.length,
			},
			checks,
			failedChecks,
			passed: failedChecks.length === 0,
		},
	};
}

function issueLifecycleCheck(issue: any): any {
	if (!issue) return { present: false, passed: false };
	const timeline = Array.isArray(issue.timeline) ? issue.timeline : [];
	const indexOf = (type: string): number => timeline.findIndex((event: any) => event?.type === type);
	const submitted = indexOf("submitted");
	const reviewed = indexOf("reviewed");
	const resolved = indexOf("resolved");
	const reviewedClaim = issue.claims?.some((claim: any) => claim?.status === "reviewed") === true;
	return {
		present: true,
		status: issue.status,
		timelineTypes: timeline.map((event: any) => event?.type ?? null),
		submittedIndex: submitted,
		reviewedIndex: reviewed,
		resolvedIndex: resolved,
		reviewedClaim,
		passed: issue.status === "resolved"
			&& submitted >= 0 && reviewed > submitted && resolved > reviewed && reviewedClaim,
	};
}

/** Marker、tool_execution_start 和持久事实必须同时满足，不能靠 prompt 回显。 */
export function validateCoreSmokeCase(
	expectation: CoreSmokeCaseExpectation,
	result: Pick<CoreSmokeProcessResult, "exitCode" | "timedOut" | "stdout" | "stderr">,
	facts: CoreSmokeFacts,
): any {
	const output = validateCoreSmokeProcessOutput(result, expectation);
	const matchingTasks = facts.tasks.filter(task => typeof task.task === "string" && task.task.includes(expectation.taskToken));
	const task = matchingTasks.length === 1 ? matchingTasks[0] : undefined;
	const execution = task ? facts.executions.find(item => item.id === task.executionId) : undefined;
	const runs = task ? facts.runs.filter(run => run.taskId === task.id || run.executionId === execution?.id) : [];
	const minRuns = expectation.minRuns ?? 0;
	const runsPresent = runs.length >= minRuns;
	const runsSuccessful = runsPresent && runs.every(run => run.status === "completed");
	const agentNamesPresent = (expectation.agentNames ?? []).every(name =>
		facts.agents.some(agent => agent.name === name)
		&& runs.some(run => run.agent === name && run.status === "completed"));
	const taskExecution = {
		matchingTaskCount: matchingTasks.length,
		taskId: task?.id ?? null,
		executionId: execution?.id ?? null,
		taskStatus: task?.status ?? null,
		executionStatus: execution?.status ?? null,
		outcomeStatus: execution?.outcome?.status ?? null,
		passed: matchingTasks.length === 1 && task?.status === "completed"
			&& execution?.status === "completed" && execution?.outcome?.status === "success",
	};
	let resource: any = { required: false, passed: true };
	if (expectation.resourceType === "workflow") {
		const reference = task?.resource?.type === "workflow" ? task.resource : undefined;
		resource = {
			required: true,
			type: task?.resource?.type ?? null,
			id: reference?.id ?? null,
			definitionPresent: !!reference && facts.workflows.some(workflow => workflow.id === reference.id),
		};
		resource.passed = resource.type === "workflow" && resource.definitionPresent;
		if (expectation.expectedWorkflowNodes !== undefined) {
			const nodes = facts.workflows.find(workflow => workflow.id === reference?.id)?.dag?.nodes ?? [];
			const runsRoot = join(facts.fixtureRoot, ".agentflux", "runtime", "runs");
			const checkpointPath = join(runsRoot, String(execution?.id), "checkpoint.json");
			const checkpoint = isSafeChildPath(runsRoot, checkpointPath) ? storeRead(checkpointPath).value : undefined;
			resource.expectedNodes = expectation.expectedWorkflowNodes;
			resource.nodeCount = nodes.length;
			resource.checkpointStatus = checkpoint?.status;
			resource.allNodesProven = nodes.length === expectation.expectedWorkflowNodes && checkpoint?.status === "passed"
				&& nodes.every((node: any) => checkpoint.completed?.includes(node.id)
					&& runs.some(run => run.agent === `dag-${node.id}` && run.status === "completed")
					&& checkpoint.taskResults?.some((entry: any) => Array.isArray(entry) && entry[0] === node.id
						&& entry[1]?.passed === true && entry[1]?.subagentResult?.exitCode === 0 && entry[1]?.gateResult?.status === "passed"));
			resource.passed = resource.passed && resource.allNodesProven;
		}
	}
	if (expectation.resourceType === "issue") {
		const reference = task?.resource?.type === "issue" ? task.resource : undefined;
		const issue = reference ? facts.issues.find(item => item.id === reference.id) : undefined;
		resource = { required: true, type: task?.resource?.type ?? null, id: reference?.id ?? null, issue: issueLifecycleCheck(issue) };
		resource.passed = resource.type === "issue" && resource.issue.passed === true;
	}
	const deliveryMatches = task
		? facts.messages.deliveries.filter(delivery => facts.messages.envelopes.some(envelope => envelope.id === delivery.messageId
			&& envelope.taskId === task.id && delivery.status === "acknowledged"))
		: [];
	const delivery = {
		required: expectation.requireDelivery === true,
		acknowledgedCount: deliveryMatches.length,
		passed: expectation.requireDelivery !== true || deliveryMatches.length > 0,
	};
	const accounting = execution?.costAccounting;
	const receipts = execution?.invocationOutcomes ?? [];
	const costAccounting = {
		required: expectation.requireCostAccounting === true,
		complete: accounting?.complete === true,
		passed: expectation.requireCostAccounting !== true || (!!accounting && accounting.complete === true
			&& Number.isFinite(execution?.costUsd) && execution.costUsd >= 0
			&& Math.abs(execution.costUsd - accounting.mainCostUsd - accounting.invocationCostUsd) < 1e-9
			&& receipts.every((receipt: any) => receipt.costComplete === true)
			&& Math.abs(accounting.invocationCostUsd - receipts.reduce((sum: number, receipt: any) => sum + (receipt.costUsd ?? 0), 0)) < 1e-9),
	};
	const persistentFacts = {
		taskExecution: taskExecution.passed,
		costAccounting: costAccounting.passed,
		runs: minRuns === 0 ? true : runsSuccessful,
		agents: agentNamesPresent,
		resource: resource.passed,
		delivery: delivery.passed,
		coreConsistency: facts.coreFactConsistency.passed,
	};
	return {
		label: expectation.label,
		marker: expectation.marker,
		taskToken: expectation.taskToken,
		output,
		taskExecution,
		costAccounting,
		runs: runs.map(run => ({ id: run.id, agent: run.agent, role: run.role, status: run.status, model: run.model, provider: run.provider, costUsd: run.costUsd })),
		runsPresent,
		runsSuccessful,
		agentNamesPresent,
		resource,
		delivery,
		persistentFacts,
		passed: output.passed && Object.values(persistentFacts).every(Boolean),
	};
}

export function compactError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
