import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluateLockFileToolCall,
	evaluateCapabilityToolCall, capabilityToolUnsupportedReason, loadRegisteredCapabilityOverride, loadRegisteredCapabilityOverrideForRole, normalizeRuntimeCapabilityOverride,
	normalizeRuntimeCommunicationOverride, resolveCapabilityPolicy, saveRegisteredCapabilityOverride,
	writeEffectiveCapabilitySnapshot,
	type CapabilityPolicyInput,
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
		const template: CapabilityPolicyInput = {
			tools: ["read", "bash", "write"],
			skills: ["base", "review"],
			communication: {
				enabled: true, actions: ["send", "poll", "ack", "status"],
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
		check("PowerShell is rejected before capability execution when no reliable gate exists",
			capabilityToolUnsupportedReason("powershell")?.includes("reliable capability/path gate") === true
				&& evaluateCapabilityToolCall({ ...bashPolicy.effective, tools: ["powershell"] }, root, "powershell", { command: "Get-ChildItem" })?.includes("unavailable") === true,
			"PowerShell fail-closed");
		rejects("PowerShell capability cannot widen the supported execution set", () => resolveCapabilityPolicy({
			cwd: root, agentName: "powershell-agent", role: "reviewer", runId: "ps-run",
			template: { ...template, tools: ["read", "powershell"] },
		}), /PowerShell capability is unavailable/);

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
		check("lockFiles allows edits to the exact declared file",
			evaluateLockFileToolCall(root, ["src/allowed.ts"], "edit", { path: "src/allowed.ts" }) === null,
			"exact path accepted");
		check("lockFiles blocks write tools outside the declared files",
			evaluateLockFileToolCall(root, ["src/allowed.ts"], "write", { path: "src/other.ts" })?.includes("outside") === true,
			"out-of-scope write rejected");
		check("lockFiles keeps read access available for surrounding context",
			evaluateLockFileToolCall(root, ["src/allowed.ts"], "read", { path: "src/other.ts" }) === null,
			"read remains available");
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
		writeFileSync(foreignLock, `${process.pid}:foreign-owner`, "utf-8");
		utimesSync(foreignLock, new Date(0), new Date(0));
		rejects("concurrent override writer fails closed without deleting the foreign lock", () => saveRegisteredCapabilityOverride({
			fluxDir, agentName: "reviewer-1", role: "reviewer", expectedRevision: 1,
			override: { tools: ["read"] },
		}), /lock timeout/);
		check("failed concurrent writer preserves lock ownership", existsSync(foreignLock), foreignLock);
		unlinkSync(foreignLock);
		const roleBase = saveRegisteredCapabilityOverride({
			fluxDir, agentName: "role-switch", role: "reviewer", expectedRevision: 0, override: { tools: ["read"] },
		});
		const roleSecondary = saveRegisteredCapabilityOverride({
			fluxDir, agentName: "role-switch", role: "implementer", expectedRevision: 0, override: { tools: ["read", "bash"] },
		});
		check("registered capability overrides remain separately bound for multiple roles",
			roleBase.revision === 1 && roleSecondary.revision === 1
				&& loadRegisteredCapabilityOverride(fluxDir, "role-switch")?.role === "reviewer"
				&& loadRegisteredCapabilityOverrideForRole(fluxDir, "role-switch", "implementer")?.override.tools?.join(",") === "read,bash",
			`${roleBase.role}/${roleSecondary.role}`);
		const badPath = join(fluxDir, "runtime", "capability-overrides", "corrupt-agent.json");
		const valid = { ...saved, agentName: "corrupt-agent", override: { tools: ["read"] } };
		for (const bad of ["{broken", "null", "[]", JSON.stringify({ ...valid, schemaVersion: 2 }),
			JSON.stringify({ ...valid, agentName: "someone-else" }), JSON.stringify({ ...valid, revision: 0 }),
			JSON.stringify({ ...valid, override: { tools: null } }), JSON.stringify({ ...valid, override: { workspace: { roots: [42] } } }),
			JSON.stringify({ ...valid, override: { communication: { maxMessagesPerRun: 0 } } }),
			JSON.stringify({ ...valid, override: { communication: { enabled: "false" } } })]) {
			writeFileSync(badPath, bad);
			rejects("corrupt override cannot restore template permissions", () => loadRegisteredCapabilityOverride(fluxDir, "corrupt-agent"), /[Cc]orrupt|[Ii]nvalid/);
			rejects("save cannot overwrite corrupt evidence", () => saveRegisteredCapabilityOverride({ fluxDir, agentName: "corrupt-agent", role: "reviewer", override: {} }), /[Cc]orrupt|[Ii]nvalid/);
			check("bad file preserved byte-for-byte", readFileSync(badPath, "utf8") === bad, bad);
		}
		const scopedFile = readdirSync(join(fluxDir, "runtime", "capability-overrides")).find(file => /^role-switch\.[a-f0-9]+\.json$/.test(file))!;
		const scopedPath = join(fluxDir, "runtime", "capability-overrides", scopedFile);
		const scopedBefore = readFileSync(scopedPath, "utf8");
		for (const bad of ["{broken", JSON.stringify({ ...roleSecondary, role: "reviewer" })]) {
			writeFileSync(scopedPath, bad);
			rejects("bad role-scoped override cannot fall back to base", () => loadRegisteredCapabilityOverrideForRole(fluxDir, "role-switch", "implementer"), /[Cc]orrupt|[Ii]nvalid/);
		}
		writeFileSync(scopedPath, scopedBefore);
		check("only missing override returns null", loadRegisteredCapabilityOverride(fluxDir, "absent") === null, "ENOENT");
		const neverSpawned = join(root, "never-spawned.json");
		process.env.AGENTFLUX_TEST_CAPTURE = neverSpawned;
		const deniedRun = await runAgent({ cwd: root, agent: { name: "corrupt-agent", role: "reviewer", description: "bad policy", tools: ["read", "write"], systemPrompt: "x" },
			task: "must not start", sessionId: "test", prefixLayout: true,
			invocationOverride: { command: process.execPath, args: [join(process.cwd(), "tests/helpers/successful-subagent.cjs")] } });
		check("corrupt registered policy rejects before spawn", deniedRun.exitCode === 77 && !existsSync(neverSpawned), deniedRun.errorMessage ?? "");
		delete process.env.AGENTFLUX_TEST_CAPTURE;
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
		const nativeCacheCapture = JSON.parse(readFileSync(capturePath, "utf-8"));
		check("native cache mode still loads the mandatory tool-hook safety extension",
			noHook.exitCode === 0 && nativeCacheCapture.argv.includes("--no-extensions")
				&& nativeCacheCapture.argv.includes("-e")
				&& /subagent-entry/.test(nativeCacheCapture.argv[nativeCacheCapture.argv.indexOf("-e") + 1])
				&& nativeCacheCapture.argv.includes("--no-skills")
				&& nativeCacheCapture.capability.workspace.roots.includes(root),
			JSON.stringify(nativeCacheCapture.argv));
	} finally {
		delete process.env.AGENTFLUX_TEST_CAPTURE;
		rmSync(root, { recursive: true, force: true });
	}

	const failed = results.filter(result => !result.passed);
	console.log(`\nCapability policy: ${results.length - failed.length}/${results.length} passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
