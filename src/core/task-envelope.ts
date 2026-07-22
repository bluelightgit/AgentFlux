import { randomUUID } from "node:crypto";
import type { WorkStyleSelection } from "./types";

const PREFIX = "agentflux-task-v1:";

export interface AgentFluxTaskEnvelope {
	version: 1;
	taskId: string;
	workStyle: WorkStyleSelection;
	task: string;
}

function isWorkStyleSelection(value: unknown): value is WorkStyleSelection {
	return value === "agent_decides" || value === "direct" || value === "team" || value === "workflow" || value === "community";
}

export function createAgentFluxTaskEnvelope(input: {
	task: string;
	workStyle: WorkStyleSelection;
	taskId?: string;
}): AgentFluxTaskEnvelope {
	const task = input.task.trim();
	if (!task) throw new Error("Task cannot be empty");
	return {
		version: 1,
		taskId: input.taskId?.trim() || `task-${randomUUID()}`,
		workStyle: input.workStyle,
		task,
	};
}

export function encodeAgentFluxTaskEnvelope(envelope: AgentFluxTaskEnvelope): string {
	const metadata = Buffer.from(JSON.stringify({
		version: envelope.version,
		taskId: envelope.taskId,
		workStyle: envelope.workStyle,
	}), "utf-8").toString("base64url");
	return `${PREFIX}${metadata}\n${envelope.task}`;
}

export function parseAgentFluxTaskEnvelope(prompt: string): AgentFluxTaskEnvelope | null {
	if (!prompt.startsWith(PREFIX)) return null;
	const newline = prompt.indexOf("\n");
	if (newline < 0) throw new Error("Invalid AgentFlux task envelope: task is missing");
	try {
		const metadata = JSON.parse(Buffer.from(prompt.slice(PREFIX.length, newline), "base64url").toString("utf-8"));
		const task = prompt.slice(newline + 1).trim();
		if (metadata?.version !== 1 || typeof metadata.taskId !== "string" || !metadata.taskId.trim() || !isWorkStyleSelection(metadata.workStyle) || !task) {
			throw new Error("invalid fields");
		}
		return { version: 1, taskId: metadata.taskId.trim(), workStyle: metadata.workStyle, task };
	} catch (error) {
		throw new Error(`Invalid AgentFlux task envelope: ${error instanceof Error ? error.message : String(error)}`);
	}
}
