import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentRunStopRequest {
	runId: string;
	requestedAt: string;
	requestedBy: string;
}

function requestPath(cwd: string, runId: string): string {
	const key = createHash("sha256").update(runId).digest("hex").slice(0, 32);
	return join(cwd, ".agentflux", "runtime", "control", `${key}.stop.json`);
}

export function requestAgentRunStop(cwd: string, runId: string, requestedBy = "desktop-operator"): AgentRunStopRequest {
	if (!runId.trim()) throw new Error("runId is required");
	const request: AgentRunStopRequest = {
		runId,
		requestedAt: new Date().toISOString(),
		requestedBy,
	};
	const path = requestPath(cwd, runId);
	mkdirSync(join(cwd, ".agentflux", "runtime", "control"), { recursive: true });
	writeFileSync(path, JSON.stringify(request, null, 2), "utf8");
	return request;
}

export function readAgentRunStop(cwd: string, runId: string): AgentRunStopRequest | undefined {
	const path = requestPath(cwd, runId);
	if (!existsSync(path)) return undefined;
	try {
		const request = JSON.parse(readFileSync(path, "utf8")) as AgentRunStopRequest;
		return request.runId === runId ? request : undefined;
	} catch {
		return undefined;
	}
}

export function clearAgentRunStop(cwd: string, runId: string): void {
	const path = requestPath(cwd, runId);
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {}
}
