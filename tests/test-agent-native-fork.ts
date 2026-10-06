import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgent, listAgents, resolveAgentSessionFile, runAgentRecord } from "../src/agents/agent-store";

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assistant(text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "test",
		model: "test-model",
		api: "openai-completions",
		usage: {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "agentflux-native-fork-"));
	const sessionDir = join(root, ".agentflux", "runtime", "sessions");
	const modelsConfig = { models: {} };
	try {
		const source = createAgent(root, { name: "native-source", modelsConfig });
		// This physical key mirrors a real fresh run followed by a capability suffix.
		const freshKey = `${source.sessionId}-fresh-source-run`;
		const sourceSession = SessionManager.create(root, sessionDir, { id: `${freshKey}-cap-abc123` });
		sourceSession.appendMessage({ role: "user", content: "fresh source context", timestamp: Date.now() } as any);
		sourceSession.appendMessage(assistant("source answer"));
		const sourceFile = sourceSession.getSessionFile();
		assert.ok(sourceFile && existsSync(sourceFile));
		const sourceHash = sha256(sourceFile);
		const sourceRegistryPath = join(root, ".agentflux", "runtime", "agents.json");
		const registry = JSON.parse(readFileSync(sourceRegistryPath, "utf8"));
		registry.agents.find((agent: any) => agent.id === source.id).lastSessionId = freshKey;
		writeFileSync(sourceRegistryPath, JSON.stringify(registry, null, 2));

		const fork = createAgent(root, { name: "native-child", forkFrom: source.name, modelsConfig });
		const forkFile = resolveAgentSessionFile(root, fork);
		assert.ok(forkFile && existsSync(forkFile));
		assert.notEqual(fork.sessionId, source.sessionId, "native fork must receive an independent Pi session ID");
		assert.equal(fork.lineage.origin, "fork");
		assert.equal(fork.lineage.forkPoint, resolve(sourceFile));
		const forkManager = SessionManager.open(forkFile);
		assert.equal(forkManager.getSessionId(), fork.sessionId);
		assert.equal(forkManager.getHeader()?.parentSession, resolve(sourceFile));
		assert.deepEqual(forkManager.buildSessionContext().messages.map((message: any) => message.content), [
			"fresh source context",
			[{ type: "text", text: "source answer" }],
		]);
		assert.equal(sha256(sourceFile), sourceHash, "native fork must not mutate source bytes");

		// The runner must pass the exact native file, not derive a shared key or cap suffix.
		const capture = join(root, "capture.json");
		process.env.AGENTFLUX_TEST_CAPTURE = capture;
		const run = await runAgentRecord(fork.id, "continue on the child branch", {
			cwd: root,
			modelsConfig,
			sessionId: "main-session",
			prefixLayout: true,
			invocationOverride: {
				command: process.execPath,
				args: [resolve("tests/helpers/successful-subagent.cjs")],
			},
		});
		const captured = JSON.parse(readFileSync(capture, "utf8"));
		assert.equal(run.exitCode, 0);
		const sharedTargetFile = captured.argv[captured.argv.indexOf("--session") + 1];
		assert.ok(sharedTargetFile && sharedTargetFile !== resolve(forkFile));
		assert.equal(SessionManager.open(sharedTargetFile).getHeader()?.parentSession, resolve(forkFile));
		assert.equal(captured.argv.includes("--session-id"), false);
		assert.equal(sha256(sourceFile), sourceHash, "runner branch load must leave source bytes unchanged");

		// fresh is deliberately isolated from the native shared target.
		const freshRun = await runAgentRecord(fork.id, "fresh isolated child run", {
			cwd: root,
			modelsConfig,
			sessionId: "main-session",
			prefixLayout: true,
			invocationOverride: {
				command: process.execPath,
				args: [resolve("tests/helpers/successful-subagent.cjs")],
			},
		}, undefined, undefined, { sessionMode: "fresh" });
		const freshCaptured = JSON.parse(readFileSync(capture, "utf8"));
		assert.equal(freshRun.exitCode, 0);
		assert.equal(freshCaptured.argv.includes("--session"), false);
		assert.ok(freshCaptured.argv[freshCaptured.argv.indexOf("--session-id") + 1].startsWith(`${fork.sessionId}-fresh-`));

		// A cross-role fork keeps the new native target while the effective policy
		// remains narrowed to the selected role's tools.
		const roleFork = createAgent(root, { name: "native-role-child", roles: ["assistant", "reviewer"], forkFrom: sourceFile, modelsConfig });
		const roleFile = resolveAgentSessionFile(root, roleFork);
		assert.ok(roleFile && existsSync(roleFile));
		const roleRun = await runAgentRecord(roleFork.id, "review the inherited context", {
			cwd: root,
			modelsConfig,
			sessionId: "main-session",
			prefixLayout: true,
			invocationOverride: {
				command: process.execPath,
				args: [resolve("tests/helpers/successful-subagent.cjs")],
			},
		}, undefined, undefined, { role: "reviewer" });
		const roleCaptured = JSON.parse(readFileSync(capture, "utf8"));
		assert.equal(roleRun.exitCode, 0);
		const roleTargetFile = roleCaptured.argv[roleCaptured.argv.indexOf("--session") + 1];
		assert.ok(roleTargetFile && roleTargetFile !== resolve(roleFile));
		assert.equal(SessionManager.open(roleTargetFile).getHeader()?.parentSession, resolve(roleFile));
		assert.deepEqual(roleCaptured.capability.tools, ["bash", "flux_agent_message", "grep", "read"]);
		assert.equal(roleCaptured.capability.tools.includes("write"), false);
		assert.equal(sha256(sourceFile), sourceHash);

		// An explicit path uses the same native SDK path and gets another ID/context.
		const explicit = createAgent(root, { name: "native-path-child", forkFrom: sourceFile, modelsConfig });
		const explicitFile = resolveAgentSessionFile(root, explicit);
		assert.ok(explicitFile && existsSync(explicitFile));
		assert.notEqual(explicit.sessionId, fork.sessionId);
		assert.equal(SessionManager.open(explicitFile).getHeader()?.parentSession, resolve(sourceFile));
		assert.equal(sha256(sourceFile), sourceHash);

		// A source without a real physical session is not a branchable proof.
		let missingRejected = false;
		try { createAgent(root, { name: "missing-child", forkFrom: "does-not-exist.jsonl", modelsConfig }); }
		catch (error) { missingRejected = /does not exist|valid Pi session/.test(String(error)); }
		assert.equal(missingRejected, true);
		const malformed = join(root, "malformed-source.jsonl");
		writeFileSync(malformed, `{"type":"session","version":3,"id":"malformed-source","cwd":${JSON.stringify(root)}}\n{not-json}\n`);
		let malformedRejected = false;
		try { createAgent(root, { name: "malformed-child", forkFrom: malformed, modelsConfig }); }
		catch (error) { malformedRejected = /valid Pi session|not a valid/.test(String(error)); }
		assert.equal(malformedRejected, true, "native fork rejects an unparsable source instead of letting Pi skip bad lines");

		console.log("✓ Agent native fork: fresh/cap source, explicit path, independent IDs/context, runner file load, immutable source");
		console.log(`Native Agent fork checks passed (${listAgents(root).filter(agent => agent.lineage.origin === "fork").length} branches)`);
	} finally {
		delete process.env.AGENTFLUX_TEST_CAPTURE;
		rmSync(root, { recursive: true, force: true });
	}
}

await main();
