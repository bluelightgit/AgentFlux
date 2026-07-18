import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluateCapabilityToolCall, loadRegisteredCapabilityOverride, normalizeRuntimeCapabilityOverride,
	normalizeRuntimeCommunicationOverride, resolveCapabilityPolicy, saveRegisteredCapabilityOverride,
	writeEffectiveCapabilitySnapshot,
} from "../src/core/capability-policy";
import { runAgent } from "../src/agents/agent-runner";
import { TelemetryWriter } from "../src/telemetry/events";

const results: Array<{ name: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: string) {
	results.push({ name, passed, detail });
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
}
function rejects(name: string, fn: () => unknown, pattern: RegExp) {
	let detail = "";
	try { fn(); } catch (error: any) { detail = error.message; }
	check(name, pattern.test(detail), detail || "missing rejection");
}

const root = mkdtempSync(join(tmpdir(), "agentflux-capability-"));
const fluxDir = join(root, ".agentflux");

async function main() {
	try {
		const template = {
			tools: ["read", "bash", "write"],
			skills: ["base", "review"],
			communication: {
				enabled: true, actions: ["send", "poll", "ack", "status"] as const,
				allowedTargets: ["worker-a", "worker-b"], maxMessagesPerRun: 20,
			},
			workspace: { roots: [root], deniedPaths: [join(root, ".env")], blockDangerousCommands: true },
		};
		check("empty structured-output capability shells inherit the role template",
			normalizeRuntimeCapabilityOverride({
				tools: [], skills: [], mcpServers: [],
				workspace: { roots: [], deniedPaths: [], blockDangerousCommands: false },
			}) === undefined,
			"empty arrays are omission, not deny-all");
		const explicitDeny = normalizeRuntimeCapabilityOverride({ tools: [], denyAllTools: true });
		check("deny-all run narrowing requires an explicit flag",
			Array.isArray(explicitDeny?.tools) && explicitDeny.tools.length === 0,
			JSON.stringify(explicitDeny));
		check("empty structured-output communication shells inherit the role template",
			normalizeRuntimeCommunicationOverride({
				enabled: false, actions: [], allowedTargets: [], requiredSendTo: [],
				requireExplicitInboxAck: false, maxMessagesPerRun: 100,
			}) === undefined,
			"default-filled communication object ignored");
		check("communication disable requires an explicit flag",
			normalizeRuntimeCommunicationOverride({ disable: true })?.enabled === false,
			"disable=true maps to enabled=false");
		const policy = resolveCapabilityPolicy({
			cwd: root, agentName: "reviewer-1", role: "reviewer", runId: "run-1",
			template,
			registered: {
				tools: ["read", "bash"], skills: ["review"],
				communication: { allowedTargets: ["worker-a"], maxMessagesPerRun: 10 },
				workspace: { deniedPaths: [join(root, "secrets")] },
			},
			run: {
				tools: ["read"], communication: { actions: ["poll", "status"], maxMessagesPerRun: 3 },
			},
		});
		check("three layers narrow tools/skills and preserve the internal message tool",
			policy.effective.tools.join(",") === "flux_agent_message,read"
				&& policy.effective.skills.join(",") === "review",
			`tools=${policy.effective.tools} skills=${policy.effective.skills}`);
		check("communication override can only reduce actions, targets, and quota",
			policy.effective.communication.actions.join(",") === "poll,status"
				&& policy.effective.communication.allowedTargets.join(",") === "worker-a"
				&& policy.effective.communication.maxMessagesPerRun === 3,
			JSON.stringify(policy.effective.communication));
		check("effective policy records source layers and narrowed fields",
			policy.provenance.some(item => item.sourceLayer === "registered")
				&& policy.provenance.some(item => item.sourceLayer === "run")
				&& policy.narrowed.includes("run:tools"),
			policy.narrowed.join(","));
		check("tool hook blocks tools outside the effective allowlist",
			evaluateCapabilityToolCall(policy.effective, root, "bash", { command: "echo ok" })?.includes("not allowed") === true,
			"bash denied after run-layer narrowing");
		check("tool hook blocks workspace escape and denied paths",
			evaluateCapabilityToolCall(policy.effective, root, "read", { path: join(root, "..", "outside.txt") })?.includes("outside") === true
				&& evaluateCapabilityToolCall(policy.effective, root, "read", { path: join(root, "secrets", "key.txt") })?.includes("denied") === true,
			"path gates active");
		const bashPolicy = resolveCapabilityPolicy({
			cwd: root, agentName: "bash-agent", role: "implementer", runId: "bash-run", template,
		});
		check("tool hook blocks dangerous shell commands and parent traversal",
			evaluateCapabilityToolCall(bashPolicy.effective, root, "bash", { command: "git reset --hard" })?.includes("Dangerous") === true
				&& evaluateCapabilityToolCall(bashPolicy.effective, root, "bash", { command: "type ../secret" })?.includes("traversal") === true,
			"bash gates active");

		rejects("run tools cannot widen a registered allowlist", () => resolveCapabilityPolicy({
			cwd: root, agentName: "a", role: "reviewer", runId: "r", template,
			registered: { tools: ["read"] }, run: { tools: ["read", "bash"] },
		}), /cannot widen/);
		rejects("run skills cannot add a skill absent from the template", () => resolveCapabilityPolicy({
			cwd: root, agentName: "a", role: "reviewer", runId: "r", template,
			run: { skills: ["review", "admin"] },
		}), /cannot widen/);
		rejects("communication targets cannot widen at a lower layer", () => resolveCapabilityPolicy({
			cwd: root, agentName: "a", role: "reviewer", runId: "r", template,
			registered: { communication: { allowedTargets: ["worker-c"] } },
		}), /targets cannot widen/);
		rejects("workspace roots cannot escape the template boundary", () => resolveCapabilityPolicy({
			cwd: root, agentName: "a", role: "reviewer", runId: "r", template,
			run: { workspace: { roots: [join(root, "..")] } },
		}), /workspace roots cannot widen/);
		rejects("non-empty MCP policy fails closed while pi lacks a server gate", () => resolveCapabilityPolicy({
			cwd: root, agentName: "a", role: "reviewer", runId: "r",
			template: { ...template, mcpServers: ["filesystem"] },
		}), /cannot be enforced/);

		const saved = saveRegisteredCapabilityOverride({
			fluxDir, agentName: "reviewer-1", role: "reviewer", expectedRevision: 0,
			override: { tools: ["read", "bash"], skills: ["review"] },
		});
		check("registered override persists with optimistic revision",
			saved.revision === 1 && loadRegisteredCapabilityOverride(fluxDir, "reviewer-1")?.revision === 1,
			`revision=${saved.revision}`);
		rejects("stale registered override revision is rejected", () => saveRegisteredCapabilityOverride({
			fluxDir, agentName: "reviewer-1", role: "reviewer", expectedRevision: 0,
			override: { tools: ["read"] },
		}), /revision conflict/);
		const foreignLock = join(fluxDir, "runtime", "capability-overrides", "reviewer-1.json.lock");
		writeFileSync(foreignLock, "foreign-owner", "utf-8");
		rejects("concurrent override writer fails closed without deleting the foreign lock", () => saveRegisteredCapabilityOverride({
			fluxDir, agentName: "reviewer-1", role: "reviewer", expectedRevision: 1,
			override: { tools: ["read"] },
		}), /already in progress/);
		check("failed concurrent writer preserves lock ownership", existsSync(foreignLock), foreignLock);
		unlinkSync(foreignLock);
		const snapshot = writeEffectiveCapabilitySnapshot(fluxDir, policy);
		check("effective capability snapshot is a stable Desktop-readable contract",
			existsSync(snapshot) && JSON.parse(readFileSync(snapshot, "utf-8")).schemaVersion === 1,
			snapshot);

		const capturePath = join(root, "capture.json");
		saveRegisteredCapabilityOverride({
			fluxDir, agentName: "runner", role: "reviewer", expectedRevision: 0,
			override: { tools: ["read", "bash"], skills: ["review"] },
		});
		process.env.AGENTFLUX_TEST_CAPTURE = capturePath;
		const telemetry = new TelemetryWriter(fluxDir, true);
		const run = await runAgent({
			cwd: root,
			agent: {
				name: "runner", role: "reviewer", description: "runner", tools: ["read", "bash", "write"],
				skills: ["base", "review"], systemPrompt: "Follow the task.",
				communication: { allowedTargets: ["worker-a", "worker-b"] },
			},
			task: "test policy", sessionId: "test", telemetry, prefixLayout: true, persistent: true,
			runId: "cap-run", capabilityOverride: {
				tools: ["read"], skills: ["review"], communication: { allowedTargets: ["worker-a"], maxMessagesPerRun: 5 },
			},
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "successful-subagent.cjs")] },
		});
		const capture = JSON.parse(readFileSync(capturePath, "utf-8"));
		const sessionArg = capture.argv[capture.argv.indexOf("--session-id") + 1];
		check("subagent invocation receives only effective tools/skills and capability env",
			run.exitCode === 0
				&& capture.argv.includes("flux_agent_message,read")
				&& capture.argv.includes("review")
				&& capture.capability.tools.join(",") === "flux_agent_message,read",
			`exit=${run.exitCode} tools=${capture.capability.tools}`);
		check("persistent session generation changes with cache-breaking capability shape",
			typeof sessionArg === "string" && /-cap-[a-f0-9]{12}$/.test(sessionArg)
				&& run.capability?.cacheBreakingChanges.includes("tool_schema") === true,
			`session=${sessionArg}`);
		const templateAgent = { name: "template-cache", role: "implementer", description: "template cache", tools: ["read"], skills: ["base"], systemPrompt: "x" };
		await runAgent({
			cwd: root, agent: templateAgent, task: "baseline", sessionId: "test", prefixLayout: true,
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "successful-subagent.cjs")] },
		});
		const changedTemplateRun = await runAgent({
			cwd: root, agent: { ...templateAgent, skills: ["base", "frontend-design"] }, task: "changed", sessionId: "test", prefixLayout: true,
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "successful-subagent.cjs")] },
		});
		check("role-template capability changes report cache impact against the previous run",
			changedTemplateRun.capability?.cacheBreakingChanges.includes("skill_set") === true,
			JSON.stringify(changedTemplateRun.capability?.cacheBreakingChanges));
		const capabilityEvents = readFileSync(join(fluxDir, "events.jsonl"), "utf-8").trim().split(/\r?\n/)
			.map(line => JSON.parse(line)).filter(event => event.type === "capability.policy");
		check("capability resolution emits an auditable telemetry event",
			capabilityEvents.some(event => event.action === "resolve" && event.result === "success"
				&& event.narrowed.includes("run:tools")),
			`events=${capabilityEvents.length}`);
		const mismatch = await runAgent({
			cwd: root,
			agent: { name: "runner", role: "implementer", description: "runner", tools: ["read"], systemPrompt: "x" },
			task: "must reject", sessionId: "test", prefixLayout: true,
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "successful-subagent.cjs")] },
		});
		check("registered override is bound to its declared role",
			mismatch.exitCode === 77 && mismatch.errorMessage?.includes("does not match implementer") === true,
			mismatch.errorMessage ?? "missing error");
		const noHook = await runAgent({
			cwd: root,
			agent: { name: "no-hook", description: "no-hook", tools: ["read"], systemPrompt: "x", workspace: { roots: [root] } },
			task: "must reject", sessionId: "test", prefixLayout: false,
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests", "helpers", "successful-subagent.cjs")] },
		});
		check("explicit workspace policy fails closed without the tool-hook extension",
			noHook.exitCode === 77 && noHook.errorMessage?.includes("tool hook") === true,
			noHook.errorMessage ?? "missing error");
	} finally {
		delete process.env.AGENTFLUX_TEST_CAPTURE;
		rmSync(root, { recursive: true, force: true });
	}

	const failed = results.filter(result => !result.passed);
	console.log(`\nCapability policy: ${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
