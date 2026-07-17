import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSharedSkills, validateConfig } from "../src/core/config";
import { buildTaskRoutePlan } from "../src/core/execution-plan";
import { DEFAULT_CONFIG, DEFAULT_PREFERENCE } from "../src/core/types";
import { loadSubagent, withSharedSkills } from "../src/extension/subagent";

const results: Array<{ name: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: string) {
	results.push({ name, passed, detail });
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
}

const root = mkdtempSync(join(tmpdir(), "agentflux-r0-contracts-"));
try {
	const agentsDir = join(root, ".agentflux", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "builder.md"), `---
name: builder
description: test builder
tools: read, write
skills: role-planning, code-review, role-planning
thinking: high
communication_actions: send, ack
communication_targets: reviewer
required_handoff_to: reviewer
max_messages_per_run: 3
---
Build and verify the requested change.
`, "utf-8");

	const agent = loadSubagent(root, "builder");
	check(
		"Markdown agent loads role skills",
		JSON.stringify(agent?.skills) === JSON.stringify(["role-planning", "code-review"]),
		JSON.stringify(agent?.skills),
	);

	const merged = agent ? withSharedSkills(agent, ["project-context", "code-review"]) : null;
	check(
		"shared and role skills merge deterministically",
		JSON.stringify(merged?.skills) === JSON.stringify(["project-context", "code-review", "role-planning"]),
		JSON.stringify(merged?.skills),
	);
	check(
		"skill merge does not mutate loaded role",
		JSON.stringify(agent?.skills) === JSON.stringify(["role-planning", "code-review"]),
		JSON.stringify(agent?.skills),
	);
	check(
		"Markdown agent loads communication policy",
		agent?.communication?.actions?.join(",") === "send,ack"
			&& agent.communication.allowedTargets?.[0] === "reviewer"
			&& agent.communication.requiredSendTo?.[0] === "reviewer"
			&& agent.communication.maxMessagesPerRun === 3,
		JSON.stringify(agent?.communication),
	);

	const legacyConfig = { ...DEFAULT_CONFIG, sharedSkills: ["legacy", "ignored"] };
	const canonical = resolveSharedSkills(legacyConfig, {
		sharedSkills: [" canonical ", "canonical", "", "bad\nname", 42],
	});
	check(
		"models sharedSkills is canonical and sanitized",
		JSON.stringify(canonical) === JSON.stringify(["canonical"]),
		JSON.stringify(canonical),
	);
	const fallback = resolveSharedSkills(legacyConfig, {});
	check(
		"agentflux sharedSkills remains a legacy fallback",
		JSON.stringify(fallback) === JSON.stringify(["legacy", "ignored"]),
		JSON.stringify(fallback),
	);

	const task = `重构复杂模块 ${Array.from({ length: 35 }, (_, index) => `src/feature${index}.ts`).join(" ")}`;
	const staticDisabled = buildTaskRoutePlan({
		cwd: root,
		task,
		stage: "Established",
		config: {
			...DEFAULT_CONFIG,
			routing: {
				...DEFAULT_CONFIG.routing,
				static_signals: false,
				budget_aware: true,
				experience_aware: false,
				override_mode: "auto",
			},
		},
		pref: DEFAULT_PREFERENCE,
	});
	check(
		"static_signals=false removes task signal from route decision",
		staticDisabled.decision.biasSources.taskSignal === undefined,
		JSON.stringify(staticDisabled.decision.biasSources),
	);
	check(
		"route plan exposes disabled static control",
		staticDisabled.routingControls.staticSignals === "disabled"
			&& staticDisabled.decision.reason.includes("routing-control:static_signals=disabled"),
		JSON.stringify(staticDisabled.routingControls),
	);
	check(
		"budget-aware status is honest about limits-only enforcement",
		staticDisabled.routingControls.budgetAware === "limits_only"
			&& staticDisabled.decision.reason.some(reason => reason.includes("budget_aware=limits_only")),
		JSON.stringify(staticDisabled.routingControls),
	);

	const staticEnabled = buildTaskRoutePlan({
		cwd: root,
		task,
		stage: "Established",
		config: {
			...DEFAULT_CONFIG,
			routing: {
				...DEFAULT_CONFIG.routing,
				static_signals: true,
				budget_aware: false,
				experience_aware: false,
				override_mode: "auto",
			},
		},
		pref: DEFAULT_PREFERENCE,
	});
	check(
		"static_signals=true contributes task signal",
		staticEnabled.decision.biasSources.taskSignal === staticEnabled.signal.recommendedMode,
		JSON.stringify(staticEnabled.decision.biasSources),
	);
	check(
		"budget-aware can be explicitly disabled",
		staticEnabled.routingControls.budgetAware === "disabled",
		JSON.stringify(staticEnabled.routingControls),
	);

	const warnings = validateConfig({
		...DEFAULT_CONFIG,
		routing: { ...DEFAULT_CONFIG.routing, budget_aware: true },
	});
	check(
		"config validation reports incomplete budget optimizer",
		warnings.some(warning => warning.includes("预算优化器尚未接入")),
		warnings.join(" | "),
	);
	const communicationWarnings = validateConfig({
		...DEFAULT_CONFIG,
		communication: {
			rpc_inbox_pump: true, poll_interval_ms: 10, batch_size: 100,
			heartbeat_interval_ms: 100, runtime_lease_ms: 1_000, redelivery_after_ms: 100,
		},
	});
	check(
		"config validation rejects unsafe RPC inbox pump bounds",
		communicationWarnings.some(warning => warning.includes("poll_interval_ms"))
			&& communicationWarnings.some(warning => warning.includes("batch_size"))
			&& communicationWarnings.some(warning => warning.includes("runtime_lease_ms"))
			&& communicationWarnings.some(warning => warning.includes("redelivery_after_ms")),
		communicationWarnings.join(" | "),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter(result => !result.passed);
console.log(`\nR0 contracts: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
