import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgent } from "../../src/agents/agent-store";
import { deleteSessionAgents, deleteAgent, gcAgents } from "../../src/agents/agent-store";
import { withAgentReferenceFence } from "../../src/core/agent-reference-fence";
import { claimIssue } from "../../src/core/community";
import { registerAgentRun } from "../../src/core/run-registry";
import { updateTaskMetadata } from "../../src/core/task-registry";
import { createWorkflowDefinition, deleteWorkflowDefinition } from "../../src/workflows/workflow-registry";
import { runLifecycleGc } from "../../src/core/lifecycle-gc";

interface WorkerData {
	root: string;
	agentId: string;
	agentName: string;
	ownerSessionId?: string;
	targetAgentId?: string;
	targetOwnerSessionId?: string;
	taskId?: string;
	executionId?: string;
	issueId?: string;
	workflowId?: string;
	workflowName?: string;
	sourceTaskId?: string;
	dag?: any;
	forkFrom?: string;
	modelsConfig?: any;
	policy?: any;
	now?: string;
}

type Outcome = { ok: true; value?: unknown } | { ok: false; error: string };

const [role, operation, phase, root, barrierDir, dataJson] = process.argv.slice(2);
if (!role || !operation || !phase || !root || !barrierDir || !dataJson) {
	throw new Error("usage: agent-reference-worker <writer|gc> <operation> <writer-first|gc-first> <root> <barrier-dir> <json-data>");
}

const data = JSON.parse(dataJson) as WorkerData;
const fluxDir = join(root, ".agentflux");
mkdirSync(barrierDir, { recursive: true });

function marker(name: string): string {
	return join(barrierDir, name);
}

function signal(name: string): void {
	writeFileSync(marker(name), `${process.pid}\n`, "utf8");
}

function waitFor(name: string, timeoutMs = 30_000): void {
	const path = marker(name);
	const waiter = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`barrier timeout: ${name}`);
		Atomics.wait(waiter, 0, 0, 10);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function performWriter(): unknown {
	switch (operation) {
		case "run": {
			if (!data.taskId || !data.executionId) throw new Error("run writer requires taskId and executionId");
			return registerAgentRun(fluxDir, {
				id: `run-${data.agentId}`,
				taskId: data.taskId,
				executionId: data.executionId,
				sessionId: data.ownerSessionId ?? "reference-session",
				agent: data.agentName,
				agentId: data.agentId,
				role: "assistant",
				currentTask: "reference fence run",
				kind: "persistent",
			});
		}
		case "task": {
			if (!data.taskId) throw new Error("task writer requires taskId");
			return updateTaskMetadata(fluxDir, data.taskId, {
				team: [{ name: "stale-logical-name", agentId: data.agentId, role: "assistant", persistent: true }],
			});
		}
		case "claim": {
			if (!data.issueId) throw new Error("claim writer requires issueId");
			return claimIssue(root, data.issueId, "stale-logical-name", "reference-scope", {
				agentId: data.agentId,
				ownerSessionId: data.ownerSessionId,
				plan: "reference fence claim",
			});
		}
		case "workflow": {
			if (!data.workflowName || !data.dag) throw new Error("workflow writer requires workflowName and dag");
			return createWorkflowDefinition(fluxDir, {
				name: data.workflowName,
				dag: data.dag,
				sourceTaskId: data.sourceTaskId,
			});
		}
		case "workflow-bind": {
			if (!data.taskId || !data.workflowId) throw new Error("workflow-bind requires taskId and workflowId");
			return updateTaskMetadata(fluxDir, data.taskId, { resource: { type: "workflow", id: data.workflowId, version: 1 } });
		}
		case "fork": {
			if (!data.forkFrom) throw new Error("fork writer requires forkFrom");
			return createAgent(root, {
				name: "fence-fork-child",
				forkFrom: data.forkFrom,
				modelsConfig: data.modelsConfig ?? { models: {} },
			});
		}
		default:
			throw new Error(`unknown writer operation: ${operation}`);
	}
}

function performGc(): unknown {
	const targetAgentId = data.targetAgentId ?? data.agentId;
	switch (operation) {
		case "delete-agent":
			return deleteAgent(root, targetAgentId, data.targetOwnerSessionId ?? data.ownerSessionId);
		case "gc-agents":
			return gcAgents(root, 0, new Set(), { ownerSessionId: data.targetOwnerSessionId ?? data.ownerSessionId });
		case "delete-session":
			return deleteSessionAgents(root, data.targetOwnerSessionId ?? data.ownerSessionId ?? "");
		case "lifecycle-gc":
			return runLifecycleGc(fluxDir, data.policy, { now: data.now ? new Date(data.now) : undefined });
		case "workflow-delete": {
			if (!data.workflowId) throw new Error("workflow-delete requires workflowId");
			return deleteWorkflowDefinition(fluxDir, data.workflowId);
		}
		default:
			throw new Error(`unknown gc operation: ${operation}`);
	}
}

function invoke(action: () => unknown): Outcome {
	try {
		return { ok: true, value: action() };
	} catch (error) {
		return { ok: false, error: errorText(error) };
	}
}

function writeOutcome(outcome: Outcome): void {
	writeFileSync(marker(`${role}-result.json`), JSON.stringify(outcome), "utf8");
}

function controlledWriterFirst(): void {
	if (role === "writer") {
		withAgentReferenceFence(() => {
			signal("writer-acquired");
			waitFor("writer-commit");
			writeOutcome(invoke(performWriter));
			signal("writer-committed");
			waitFor("writer-release");
		});
		return;
	}
	waitFor("gc-start");
	writeOutcome(invoke(performGc));
	signal("gc-done");
}

function controlledGcFirst(): void {
	if (role === "gc") {
		withAgentReferenceFence(() => {
			signal("gc-acquired");
			waitFor("gc-commit");
			writeOutcome(invoke(performGc));
			signal("gc-committed");
			waitFor("gc-release");
		});
		return;
	}
	signal("writer-attempted");
	waitFor("writer-start");
	writeOutcome(invoke(performWriter));
	signal("writer-done");
}

function main(): void {
	signal(`${role}-ready`);
	waitFor(`${role}-start`);
	if (phase === "writer-first") controlledWriterFirst();
	else if (phase === "gc-first") controlledGcFirst();
	else if (phase === "direct") {
		writeOutcome(invoke(role === "writer" ? performWriter : performGc));
		signal(`${role}-done`);
	} else throw new Error(`unknown phase: ${phase}`);
}

try {
	main();
} catch (error) {
	const outcome: Outcome = { ok: false, error: errorText(error) };
	try { writeOutcome(outcome); } catch { /* parent will report the process failure */ }
	console.error(errorText(error));
	process.exitCode = 1;
}
