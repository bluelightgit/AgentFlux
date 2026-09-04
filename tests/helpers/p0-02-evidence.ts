import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, join } from "node:path";
import { readActiveContext } from "../../src/core/active-context";
import { assistantMessageTexts, assistantOutputEvidence, parseJsonLines, toolExecutionStarts } from "./pi-json-output";

const MAX_RECORDS = 500;
const MAX_EVENTS = 40;
const MAX_TEXT = 64 * 1024;
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export interface ProcessOutputResult {
	label: string;
	pid?: number;
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function readJson(path: string): any | undefined {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function clip(value: unknown, max = 4096): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.length <= max ? value : `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

function nonNegative(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function numberOrZero(value: unknown): number {
	return nonNegative(value) ? value as number : 0;
}

function boundedArray(value: unknown, max = MAX_RECORDS): any[] {
	return Array.isArray(value) ? value.slice(-max) : [];
}

function relativeReportPath(sourceRoot: string, path: string): string {
	return relative(sourceRoot, path).replace(/\\/g, "/");
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function auditTask(task: any): any {
	return {
		id: task?.id ?? null,
		executionId: task?.executionId ?? null,
		sessionId: task?.sessionId ?? null,
		task: clip(task?.task, 2000) ?? "",
		selectedBy: task?.selectedBy ?? null,
		operation: task?.operation ?? null,
		parentTaskId: task?.parentTaskId ?? null,
		parentExecutionId: task?.parentExecutionId ?? null,
		status: task?.status ?? null,
		deadlineAt: task?.deadlineAt ?? null,
		resource: task?.resource ?? null,
		team: boundedArray(task?.team, 50),
		createdAt: task?.createdAt ?? null,
		updatedAt: task?.updatedAt ?? null,
	};
}

function auditExecution(execution: any): any {
	return {
		id: execution?.id ?? null,
		taskId: execution?.taskId ?? null,
		ownerPid: execution?.ownerPid ?? null,
		sessionId: execution?.sessionId ?? null,
		operation: execution?.operation ?? null,
		parentTaskId: execution?.parentTaskId ?? null,
		parentExecutionId: execution?.parentExecutionId ?? null,
		status: execution?.status ?? null,
		deadlineAt: execution?.deadlineAt ?? null,
		budget: execution?.budget ?? null,
		costUsd: numberOrZero(execution?.costUsd),
		usage: execution?.usage ? {
			input: numberOrZero(execution.usage.input),
			output: numberOrZero(execution.usage.output),
			cacheRead: numberOrZero(execution.usage.cacheRead),
			cacheWrite: numberOrZero(execution.usage.cacheWrite),
			costUsd: numberOrZero(execution.usage.costUsd),
			model: execution.usage.model ?? null,
		} : null,
		outcome: execution?.outcome ? {
			status: execution.outcome.status ?? null,
			error: clip(execution.outcome.error, 2000) ?? null,
		} : null,
		createdAt: execution?.createdAt ?? null,
		updatedAt: execution?.updatedAt ?? null,
		finishedAt: execution?.finishedAt ?? null,
	};
}

function auditRun(run: any): any {
	return {
		id: run?.id ?? null,
		taskId: run?.taskId ?? null,
		executionId: run?.executionId ?? null,
		sessionId: run?.sessionId ?? null,
		agent: run?.agent ?? null,
		role: run?.role ?? null,
		currentTask: clip(run?.currentTask, 2000) ?? "",
		model: run?.model ?? null,
		provider: run?.provider ?? null,
		kind: run?.kind ?? null,
		status: run?.status ?? null,
		pid: run?.pid ?? null,
		attempt: numberOrZero(run?.attempt),
		turns: numberOrZero(run?.turns),
		input: numberOrZero(run?.input),
		output: numberOrZero(run?.output),
		cacheRead: numberOrZero(run?.cacheRead),
		cacheWrite: numberOrZero(run?.cacheWrite),
		contextTokens: numberOrZero(run?.contextTokens),
		costUsd: numberOrZero(run?.costUsd),
		phase: run?.phase ?? null,
		health: run?.health ?? null,
		healthReason: clip(run?.healthReason, 1000) ?? null,
		lastProgressAt: run?.lastProgressAt ?? null,
		lastProgressType: run?.lastProgressType ?? null,
		lastProgressSummary: clip(run?.lastProgressSummary, 1000) ?? null,
		lastActivityAt: run?.lastActivityAt ?? null,
		lastActivityType: run?.lastActivityType ?? null,
		lastActivitySummary: clip(run?.lastActivitySummary, 1000) ?? null,
		modelError: clip(run?.modelError, 2000) ?? null,
		providerError: clip(run?.providerError, 2000) ?? null,
		error: clip(run?.error, 2000) ?? null,
		createdAt: run?.createdAt ?? null,
		updatedAt: run?.updatedAt ?? null,
		heartbeatAt: run?.heartbeatAt ?? null,
		finishedAt: run?.finishedAt ?? null,
		recentEvents: boundedArray(run?.recentEvents, 20).map(event => ({
			at: event?.at ?? null,
			type: event?.type ?? null,
			phase: event?.phase ?? null,
			summary: clip(event?.summary, 1000) ?? "",
		})),
	};
}

function auditAgent(agent: any): any {
	return {
		id: agent?.id ?? null,
		name: agent?.name ?? null,
		scope: agent?.scope ?? null,
		role: agent?.role ?? null,
		roles: boundedArray(agent?.roles, 20),
		status: agent?.status ?? null,
		lineage: agent?.lineage ?? null,
		model: agent?.model ?? null,
		provider: agent?.provider ?? null,
		thinking: agent?.thinking ?? null,
		sessionId: agent?.sessionId ?? null,
		lastSessionId: agent?.lastSessionId ?? null,
		ownerSessionId: agent?.ownerSessionId ?? null,
		createdAt: agent?.createdAt ?? null,
		updatedAt: agent?.updatedAt ?? null,
		lastTask: clip(agent?.lastTask, 2000) ?? null,
		lastRole: agent?.lastRole ?? null,
		callCount: numberOrZero(agent?.callCount),
		totalCostUsd: numberOrZero(agent?.totalCostUsd),
		capabilityGeneration: numberOrZero(agent?.capabilityGeneration),
		lastResult: agent?.lastResult ? {
			exitCode: agent.lastResult.exitCode ?? null,
			success: agent.lastResult.success ?? null,
			summary: clip(agent.lastResult.summary, 2000) ?? "",
			turns: numberOrZero(agent.lastResult.turns),
			costUsd: numberOrZero(agent.lastResult.costUsd),
			model: agent.lastResult.model ?? null,
			role: agent.lastResult.role ?? null,
			at: agent.lastResult.at ?? null,
		} : null,
	};
}

function auditIssue(issue: any): any {
	return {
		id: issue?.id ?? null,
		title: clip(issue?.title, 1000) ?? "",
		description: clip(issue?.description, 2000) ?? "",
		status: issue?.status ?? null,
		createdBy: issue?.createdBy ?? null,
		createdAt: issue?.createdAt ?? null,
		updatedAt: issue?.updatedAt ?? null,
		acceptanceCriteria: boundedArray(issue?.acceptanceCriteria, 50).map(value => clip(value, 1000) ?? ""),
		comments: boundedArray(issue?.comments, 50).map(comment => ({
			id: comment?.id ?? null,
			author: comment?.author ?? null,
			body: clip(comment?.body, 2000) ?? "",
			createdAt: comment?.createdAt ?? null,
		})),
		claims: boundedArray(issue?.claims, 50).map(claim => ({
			id: claim?.id ?? null,
			agent: claim?.agent ?? null,
			scope: claim?.scope ?? null,
			status: claim?.status ?? null,
			createdAt: claim?.createdAt ?? null,
			proposalIds: boundedArray(claim?.proposalIds, 20),
			plan: clip(claim?.plan, 2000) ?? "",
			leaseId: claim?.leaseId ?? null,
		})),
		proposals: boundedArray(issue?.proposals, 50).map(proposal => ({
			id: proposal?.id ?? null,
			title: clip(proposal?.title, 1000) ?? "",
			body: clip(proposal?.body, 2000) ?? "",
			createdBy: proposal?.createdBy ?? null,
			createdAt: proposal?.createdAt ?? null,
			supporters: boundedArray(proposal?.supporters, 50),
			opposers: boundedArray(proposal?.opposers, 50),
		})),
		timeline: boundedArray(issue?.timeline, 100).map(event => ({
			id: event?.id ?? null,
			type: event?.type ?? null,
			actor: event?.actor ?? null,
			detail: clip(event?.detail, 2000) ?? "",
			createdAt: event?.createdAt ?? null,
		})),
		rounds: numberOrZero(issue?.rounds),
		costUsd: numberOrZero(issue?.costUsd),
		stallStreak: numberOrZero(issue?.stallStreak),
		lastReworkFeedback: clip(issue?.lastReworkFeedback, 2000) ?? null,
		resolvedReason: clip(issue?.resolvedReason, 2000) ?? null,
	};
}

function auditWorkflow(definition: any): any {
	return {
		id: definition?.id ?? null,
		name: definition?.name ?? null,
		version: definition?.version ?? null,
		description: clip(definition?.description, 2000) ?? "",
		sourceTaskId: definition?.sourceTaskId ?? null,
		createdAt: definition?.createdAt ?? null,
		updatedAt: definition?.updatedAt ?? null,
		dag: definition?.dag ? {
			description: clip(definition.dag.description, 2000) ?? "",
			nodes: boundedArray(definition.dag.nodes, 100).map(node => ({
				id: node?.id ?? null,
				title: clip(node?.title, 1000) ?? "",
				role: node?.role ?? null,
				dependsOn: boundedArray(node?.dependsOn, 50),
				parallelizable: node?.parallelizable ?? null,
				files: boundedArray(node?.files, 50),
			})),
		} : null,
	};
}

function collectNested(value: unknown, predicate: (candidate: any) => boolean, found: any[] = []): any[] {
	if (!value || typeof value !== "object") return found;
	if (predicate(value)) found.push(value);
	if (Array.isArray(value)) {
		for (const item of value) collectNested(item, predicate, found);
	} else {
		for (const item of Object.values(value as Record<string, unknown>)) collectNested(item, predicate, found);
	}
	return found;
}

function summarizeToolResults(stdout: string, stderr: string): any[] {
	const roots = [...parseJsonLines(stdout), ...parseJsonLines(stderr)];
	return roots.flatMap(root => collectNested(root, candidate =>
		(candidate?.role === "toolResult" || candidate?.type === "toolResult") && typeof candidate?.toolName === "string",
	)).slice(-MAX_EVENTS).map(result => ({
		toolName: result.toolName,
		toolCallId: result.toolCallId ?? result.id ?? null,
		isError: result.isError === true,
		content: clip(JSON.stringify(result.content ?? null), 4000) ?? "",
		details: clip(JSON.stringify(result.details ?? null), 4000) ?? null,
	}));
}

function summarizeToolStarts(stdout: string, stderr: string): any[] {
	const starts = [
		...toolExecutionStarts(stdout, "flux_agent"),
		...toolExecutionStarts(stdout, "flux_workflow"),
		...toolExecutionStarts(stdout, "flux_issue"),
		...toolExecutionStarts(stderr, "flux_agent"),
		...toolExecutionStarts(stderr, "flux_workflow"),
		...toolExecutionStarts(stderr, "flux_issue"),
	];
	return starts.slice(-MAX_EVENTS).map(event => ({
		toolName: event.toolName,
		toolCallId: event.toolCallId ?? null,
		arguments: clip(JSON.stringify(event.args ?? event.arguments ?? null), 4000) ?? null,
	}));
}

/**
 * 将完整子 Pi 输出先写入外部 artifact，再把可解析终态摘要写入报告。
 * artifactDir 位于 fixture workspace 之外，因此 finally 删除 workspace 后仍可审计。
 */
export function buildProcessOutputEvidence(
	result: ProcessOutputResult,
	expectedMarker: string | undefined,
	sourceRoot: string,
	artifactDir: string,
): any {
	mkdirSync(artifactDir, { recursive: true });
	const safeLabel = result.label.replace(/[^a-zA-Z0-9._-]+/g, "_");
	const stdoutPath = join(artifactDir, `${safeLabel}.stdout.jsonl`);
	const stderrPath = join(artifactDir, `${safeLabel}.stderr.log`);
	const finalTextPath = join(artifactDir, `${safeLabel}.final-assistant.txt`);
	writeFileSync(stdoutPath, result.stdout, "utf8");
	writeFileSync(stderrPath, result.stderr, "utf8");
	const assistant = assistantOutputEvidence(result.stdout, result.stderr, expectedMarker);
	writeFileSync(finalTextPath, assistant.finalAssistantText, "utf8");
	const finalTextBytes = Buffer.byteLength(assistant.finalAssistantText, "utf8");
	const evidence: any = {
		label: result.label,
		pid: result.pid ?? null,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		stdoutTail: result.stdout.slice(-5000),
		stderrTail: result.stderr.slice(-3000),
		outputArtifacts: {
			stdout: {
				path: relativeReportPath(sourceRoot, stdoutPath),
				bytes: Buffer.byteLength(result.stdout, "utf8"),
				sha256: sha256(result.stdout),
			},
			stderr: {
				path: relativeReportPath(sourceRoot, stderrPath),
				bytes: Buffer.byteLength(result.stderr, "utf8"),
				sha256: sha256(result.stderr),
			},
			finalAssistantText: {
				path: relativeReportPath(sourceRoot, finalTextPath),
				bytes: finalTextBytes,
				sha256: sha256(assistant.finalAssistantText),
			},
		},
		assistantMessageCount: assistant.assistantMessageCount,
		assistantMessageTexts: assistantMessageTexts(`${result.stdout}\n${result.stderr}`).slice(-20).map(text => clip(text, MAX_TEXT) ?? ""),
		finalAssistantText: clip(assistant.finalAssistantText, MAX_TEXT) ?? "",
		finalAssistantTextTruncated: finalTextBytes > Buffer.byteLength(clip(assistant.finalAssistantText, MAX_TEXT) ?? "", "utf8"),
		finalAssistantTextSha256: sha256(assistant.finalAssistantText),
		parseable: assistant.parseable,
		structuredEvents: {
			jsonLines: parseJsonLines(result.stdout).length + parseJsonLines(result.stderr).length,
			toolExecutionStarts: summarizeToolStarts(result.stdout, result.stderr),
			toolResults: summarizeToolResults(result.stdout, result.stderr),
		},
	};
	if (expectedMarker !== undefined) {
		evidence.expectedMarker = expectedMarker;
		evidence.markerMatched = assistant.markerMatched === true;
		evidence.markerMatchRule = assistant.markerMatchRule;
	}
	return evidence;
}

export function validateProcessOutputEvidence(
	evidence: any[],
	expectedMarkers: Record<string, string>,
	sourceRoot: string,
): any {
	const expectedLabels = Object.keys(expectedMarkers);
	const observedLabels = evidence.map(item => item?.label).filter((label): label is string => typeof label === "string");
	const missingLabels = expectedLabels.filter(label => !observedLabels.includes(label));
	const duplicateLabels = observedLabels.filter((label, index) => observedLabels.indexOf(label) !== index);
	const records = expectedLabels.map(label => evidence.find(item => item?.label === label));
	const artifactsPresent = records.every(record => {
		if (!record?.outputArtifacts) return false;
		return [record.outputArtifacts.stdout, record.outputArtifacts.stderr, record.outputArtifacts.finalAssistantText]
			.every((artifact: any) => typeof artifact?.path === "string" && existsSync(join(sourceRoot, artifact.path)));
	});
	const markersExact = records.every((record, index) => {
		const label = expectedLabels[index];
		return record?.parseable === true
			&& numberOrZero(record?.assistantMessageCount) > 0
			&& record?.expectedMarker === expectedMarkers[label]
			&& record?.markerMatchRule === "trimmed-exact"
			&& record?.markerMatched === true;
	});
	return {
		expectedProcessCount: expectedLabels.length,
		observedProcessCount: evidence.length,
		missingLabels,
		duplicateLabels,
		allAssistantEvidenceParseable: records.every(record => record?.parseable === true && numberOrZero(record?.assistantMessageCount) > 0),
		allMarkersExact: markersExact,
		allArtifactsPresent: artifactsPresent,
		passed: missingLabels.length === 0 && duplicateLabels.length === 0 && evidence.length === expectedLabels.length && markersExact && artifactsPresent,
	};
}

function aggregateRunUsage(runs: any[]): any {
	return {
		turns: runs.reduce((sum, run) => sum + numberOrZero(run.turns), 0),
		input: runs.reduce((sum, run) => sum + numberOrZero(run.input), 0),
		output: runs.reduce((sum, run) => sum + numberOrZero(run.output), 0),
		cacheRead: runs.reduce((sum, run) => sum + numberOrZero(run.cacheRead), 0),
		cacheWrite: runs.reduce((sum, run) => sum + numberOrZero(run.cacheWrite), 0),
		contextTokens: runs.reduce((sum, run) => sum + numberOrZero(run.contextTokens), 0),
		costUsd: runs.reduce((sum, run) => sum + numberOrZero(run.costUsd), 0),
	};
}

function aggregateExecutionUsage(executions: any[]): any {
	return {
		input: executions.reduce((sum, execution) => sum + numberOrZero(execution.usage?.input), 0),
		output: executions.reduce((sum, execution) => sum + numberOrZero(execution.usage?.output), 0),
		cacheRead: executions.reduce((sum, execution) => sum + numberOrZero(execution.usage?.cacheRead), 0),
		cacheWrite: executions.reduce((sum, execution) => sum + numberOrZero(execution.usage?.cacheWrite), 0),
		costUsd: executions.reduce((sum, execution) => sum + numberOrZero(execution.usage?.costUsd), 0),
	};
}

/** 在 fixture workspace 删除前读取所有相关 Core Registry，并生成有界快照和一致性结论。 */
export function snapshotP002CoreFacts(fixtureRoot: string, expectedIssueIds: string[], workflowId: string): any {
	const runtimeDir = join(fixtureRoot, ".agentflux", "runtime");
	const taskStore = readJson(join(runtimeDir, "tasks.json")) ?? {};
	const runStore = readJson(join(runtimeDir, "runs.json")) ?? {};
	const agentStore = readJson(join(runtimeDir, "agents.json")) ?? {};
	const issueStore = readJson(join(fixtureRoot, ".agentflux", "issues.json")) ?? {};
	const workflowStore = readJson(join(runtimeDir, "workflows.json")) ?? {};
	const tasks = boundedArray(taskStore.tasks).map(auditTask);
	const executions = boundedArray(taskStore.executions).map(auditExecution);
	const runs = boundedArray(runStore.runs).map(auditRun);
	const agents = boundedArray(agentStore.agents).map(auditAgent);
	const issues = boundedArray(issueStore.issues).map(auditIssue);
	const workflowDefinitions = boundedArray(workflowStore.definitions).map(auditWorkflow);
	const activeContextEntries = (() => {
		try { return boundedArray(readActiveContext(fixtureRoot).entries, 100); } catch { return []; }
	})();
	const taskIds = new Set(tasks.map(task => task.id).filter(Boolean));
	const executionIds = new Set(executions.map(execution => execution.id).filter(Boolean));
	const taskById = new Map(tasks.map(task => [task.id, task]));
	const executionById = new Map(executions.map(execution => [execution.id, execution]));
	const taskExecutionLinksValid = tasks.length > 0 && tasks.every(task => executionIds.has(task.executionId))
		&& executions.every(execution => taskIds.has(execution.taskId));
	const runReferencesValid = runs.length > 0 && runs.every(run =>
		(!run.taskId || taskIds.has(run.taskId)) && (!run.executionId || executionIds.has(run.executionId))
		&& (!run.executionId || taskById.get(run.taskId)?.executionId === run.executionId || !run.taskId),
	);
	const parentLineageValid = tasks.every(task =>
		(!task.parentTaskId || taskIds.has(task.parentTaskId))
		&& (!task.parentExecutionId || executionIds.has(task.parentExecutionId)),
	) && executions.every(execution =>
		(!execution.parentTaskId || taskIds.has(execution.parentTaskId))
		&& (!execution.parentExecutionId || executionIds.has(execution.parentExecutionId)),
	);
	const usageValid = runs.every(run => [run.turns, run.input, run.output, run.cacheRead, run.cacheWrite, run.contextTokens, run.costUsd].every(nonNegative))
		&& executions.every(execution => nonNegative(execution.costUsd) && (!execution.usage || [execution.usage.input, execution.usage.output, execution.usage.cacheRead, execution.usage.cacheWrite, execution.usage.costUsd].every(nonNegative)));
	const costValid = agents.every(agent => nonNegative(agent.totalCostUsd)) && issues.every(issue => nonNegative(issue.costUsd));
	const expectedIssuesPresent = expectedIssueIds.every(id => issues.some(issue => issue.id === id));
	const workflowPresent = workflowDefinitions.some(definition => definition.id === workflowId);
	const allTaskExecutionsTerminal = tasks.every(task => TERMINAL_TASK_STATUSES.has(task.status));
	const allExecutionsTerminal = executions.every(execution => TERMINAL_TASK_STATUSES.has(execution.status));
	const allRunsTerminal = runs.every(run => TERMINAL_TASK_STATUSES.has(run.status));
	const consistencyChecks = {
		tasksPresent: tasks.length > 0,
		executionsPresent: executions.length > 0,
		agentsPresent: agents.length > 0,
		runsPresent: runs.length > 0,
		issuesPresent: issues.length >= expectedIssueIds.length,
		workflowPresent,
		expectedIssuesPresent,
		taskExecutionLinksValid,
		runReferencesValid,
		parentLineageValid,
		usageValid,
		costValid,
		allTaskExecutionsTerminal,
		allExecutionsTerminal,
		allRunsTerminal,
		noActiveRuns: runs.every(run => !["starting", "running", "stop_requested"].includes(run.status)),
		noActiveContextEntries: activeContextEntries.length === 0,
	};
	const consistencyReasons = Object.entries(consistencyChecks).filter(([, value]) => !value).map(([key]) => key);
	const runUsage = aggregateRunUsage(runs);
	const executionUsage = aggregateExecutionUsage(executions);
	const executionCost = executions.reduce((sum, execution) => sum + numberOrZero(execution.costUsd), 0);
	const agentCost = agents.reduce((sum, agent) => sum + numberOrZero(agent.totalCostUsd), 0);
	const issueCost = issues.reduce((sum, issue) => sum + numberOrZero(issue.costUsd), 0);
	const parentLineage = {
		tasks: tasks.map(task => ({ taskId: task.id, executionId: task.executionId, parentTaskId: task.parentTaskId, parentExecutionId: task.parentExecutionId })),
		executions: executions.map(execution => ({ executionId: execution.id, taskId: execution.taskId, parentTaskId: execution.parentTaskId, parentExecutionId: execution.parentExecutionId })),
		runs: runs.map(run => ({
			runId: run.id,
			taskId: run.taskId,
			executionId: run.executionId,
			parentTaskId: taskById.get(run.taskId)?.parentTaskId ?? executionById.get(run.executionId)?.parentTaskId ?? null,
			parentExecutionId: taskById.get(run.taskId)?.parentExecutionId ?? executionById.get(run.executionId)?.parentExecutionId ?? null,
		})),
	};
	return {
		tasks,
		executions,
		agents,
		runs,
		issues,
		workflowDefinitions,
		activeContextAtSnapshot: activeContextEntries,
		usage: { runs: runUsage, executions: executionUsage },
		costUsd: {
			runs: runUsage.costUsd,
			executions: executionCost,
			agents: agentCost,
			issues: issueCost,
			observedRunAndExecution: runUsage.costUsd + executionCost,
		},
		costUsdTotal: runUsage.costUsd + executionCost,
		parentLineage,
		coreFactConsistency: {
			counts: { tasks: tasks.length, executions: executions.length, agents: agents.length, runs: runs.length, issues: issues.length, workflows: workflowDefinitions.length },
			checks: consistencyChecks,
			failedChecks: consistencyReasons,
			passed: consistencyReasons.length === 0,
		},
	};
}