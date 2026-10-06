import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "agent-reference-boundaries-"));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = root; process.env.USERPROFILE = root; process.env.PI_CODING_AGENT_DIR = join(root, "pi");
const cwd = join(root, "project"), fluxDir = join(cwd, ".agentflux"), runtime = join(fluxDir, "runtime");
mkdirSync(runtime, { recursive: true });
const bytes = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : undefined;
try {
	assert.equal(homedir(), root);
	const { createAgent, deleteAgent, resetAgentStatus } = await import("../src/agents/agent-store");
	const { createIssue, claimIssue } = await import("../src/core/community");
	const { registerAgentRun } = await import("../src/core/run-registry");
	const { registerTask, updateTaskMetadata } = await import("../src/core/task-registry");
	const { createWorkflowDefinition } = await import("../src/workflows/workflow-registry");
	const { collectAgentReferences } = await import("../src/core/agent-references");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const modelsConfig = { models: {} };
	assert.throws(() => createAgent(cwd, { name: "no-owner", scope: "session", modelsConfig }), /requires ownerSessionId/);
	const privateAgent = createAgent(cwd, { name: "private-actor", scope: "session", ownerSessionId: "alpha", modelsConfig });
	const agentPath = join(runtime, "agents.json"), beforeAgent = bytes(agentPath);
	assert.throws(() => deleteAgent(cwd, privateAgent.id), /not found/);
	assert.throws(() => deleteAgent(cwd, privateAgent.id, "beta"), /not found/);
	assert.throws(() => resetAgentStatus(cwd, privateAgent.id, "failed"), /ownerSessionId/);
	assert.equal(bytes(agentPath), beforeAgent);

	const issue = createIssue(cwd, { title: "logical actor", description: "A name is not an explicit registered identity." });
	const logical = claimIssue(cwd, issue.id, privateAgent.name, "logical", { ownerSessionId: "beta" });
	assert.equal(logical.claims[0].agentId, undefined);
	const issuePath = join(fluxDir, "issues.json"), leasePath = join(runtime, "active-context.json");
	const beforeIssue = bytes(issuePath), beforeLease = bytes(leasePath);
	assert.throws(() => claimIssue(cwd, issue.id, "ignored", "private", { agentId: privateAgent.id, ownerSessionId: "beta" }), /inaccessible/);
	assert.throws(() => claimIssue(cwd, issue.id, `agent-${randomUUID()}`, "missing"), /missing/);
	assert.throws(() => claimIssue(cwd, "issue-missing", "main", "missing"), /Issue not found/);
	assert.throws(() => claimIssue(cwd, issue.id, "main", "logical"), /Scope already claimed/);
	assert.equal(bytes(issuePath), beforeIssue); assert.equal(bytes(leasePath), beforeLease);

	registerTask(fluxDir, "alpha", { taskId: "boundary-task", executionId: "boundary-task", task: "reference checks", selectedBy: "user", operation: "new", budget: { maxCostUsd: 1, maxIterations: 2 } });
	const taskPath = join(runtime, "tasks.json"), beforeTask = bytes(taskPath);
	assert.throws(() => updateTaskMetadata(fluxDir, "boundary-task", { team: [{ name: privateAgent.name, agentId: "" }] }), /non-empty/);
	assert.equal(bytes(taskPath), beforeTask);
	assert.throws(() => claimIssue(cwd, issue.id, privateAgent.name, "empty", { agentId: "", ownerSessionId: "alpha" }), /non-empty/);
	assert.equal(bytes(issuePath), beforeIssue); assert.equal(bytes(leasePath), beforeLease);
	assert.throws(() => registerAgentRun(fluxDir, { id: "empty-ref-run", sessionId: "alpha", agent: privateAgent.name, agentId: "", role: "assistant", currentTask: "empty reference", kind: "persistent" }), /non-empty/);
	assert.equal(bytes(join(runtime, "runs.json")), undefined);
	assert.throws(() => createWorkflowDefinition(fluxDir, { name: "empty-ref", dag: { description: "invalid", nodes: [{ id: "n", title: "empty", role: "assistant", agentId: "", dependsOn: [], parallelizable: false, files: [], acceptanceCriteria: [] }] } }), /non-empty/);
	assert.equal(bytes(join(runtime, "workflows.json")), undefined);
	assert.ok(collectAgentReferences(cwd).has(privateAgent.name), "logical references retain conservative name protection");

	const sessionDir = join(runtime, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const session = SessionManager.create(cwd, sessionDir, { id: `${privateAgent.sessionId}-cap-source` });
	session.appendMessage({ role: "user", content: "Owner-bound source", timestamp: Date.now() } as any);
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Owner-bound answer" }], provider: "test", model: "test", api: "openai-completions", stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);
	const source = session.getSessionFile(); assert.ok(source);
	const sourceBytes = bytes(source), filesBefore = readdirSync(sessionDir).sort();
	assert.throws(() => createAgent(cwd, { name: "wrong-owner-fork", forkFrom: source, ownerSessionId: "beta", modelsConfig }), /another session owner/);
	assert.throws(() => createAgent(cwd, { name: "missing-owner-fork", forkFrom: source, modelsConfig }), /another session owner/);
	assert.deepEqual(readdirSync(sessionDir).sort(), filesBefore);
	// 使备份写入失败：原 Agent store 保持可读，native fork 已创建但未登记的目标必须回滚。
	const backup = `${agentPath}.bak`;
	rmSync(backup, { force: true }); mkdirSync(backup);
	const beforeFailedCommit = bytes(agentPath);
	try {
		assert.throws(() => createAgent(cwd, { name: "failed-commit-fork", forkFrom: source, ownerSessionId: "alpha", modelsConfig }), /EISDIR|EPERM|EACCES|copyfile|permission/i);
		assert.equal(bytes(agentPath), beforeFailedCommit);
		assert.equal(bytes(source), sourceBytes);
		assert.deepEqual(readdirSync(sessionDir).sort(), filesBefore, "failed Agent store commit leaves no unregistered fork file");
	} finally { rmSync(backup, { recursive: true, force: true }); }
	const { runAgent } = await import("../src/agents/agent-runner");
	const terminated = await runAgent({ cwd, sessionId: "alpha", agent: { name: "external-signal", role: "reviewer", description: "Signal classification fixture", systemPrompt: "Reply briefly.", tools: ["read"] },
		task: "External process termination is a failure, not a user cancellation.", prefixLayout: false, maxRetries: 0,
		// Runner appends Pi flags; terminate Node option parsing so the fixture actually executes.
		invocationOverride: { command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGTERM')", "--"] } });
	assert.notEqual(terminated.exitCode, 0); assert.notEqual(terminated.exitCode, 130);
	const runs = JSON.parse(readFileSync(join(runtime, "runs.json"), "utf8")).runs;
	assert.equal(runs.at(-1).status, "failed");
	if (process.platform !== "win32") assert.match(terminated.errorMessage ?? "", /signal SIGTERM/);
	console.log("Agent reference boundary checks passed (owner, logical actors, empty IDs, pre-lease refusal, native fork rollback, external signal failure)");
} finally {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
