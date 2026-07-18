import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createEphemeralRecord, finishEphemeralRecord } from "./agents/agent-lifecycle";
import { formatAgentRunResult, formatParallelAgentResults, runAgent, runAgentsParallel, type AgentRunResult, type AgentTemplate, type ParallelAgentTask } from "./agents/agent-runner";
import { archivePersistentAgent, formatPersistentAgents, listPersistentAgents, registerPersistentAgent, runPersistentAgent, type PersistentAgentContext } from "./agents/persistent-agent";
import { getForkCandidates, handleForkCommand, registerSessionFork } from "./agents/session-fork";
import { loadAllRoles } from "./agents/templates";
import { createIssue, claimIssue, commentOnIssue, formatIssue, getIssue, listIssues, resolveIssue, submitClaim } from "./core/community";
import { loadConfig, resolveSharedSkills, validateConfig } from "./core/config";
import { MessageBus } from "./core/message-bus";
import { formatLifecycleGcReport, runLifecycleGc } from "./core/lifecycle-gc";
import { discoverPiModels, mergeModels } from "./core/model-capability";
import { loadPricing, type PricingTable } from "./core/pricing";
import { createTaskExecutionPlan, formatTaskExecutionPlan, type TaskExecutionPlan } from "./core/task-execution";
import type { WorkStyle } from "./core/types";
import { analyzeCompaction, formatCompactionAdvice, registerCompactionAdvisor } from "./extension/compaction-advisor";
import { FLUX_HELP, getFluxArgumentCompletions, parseFluxCommand } from "./extension/commands";
import { applyMask } from "./extension/mask";
import { applyPrefixLayout } from "./extension/prefix-layout";
import { showFluxTuiMenu } from "./extension/tui-menu";
import { TelemetryWriter } from "./telemetry/events";
import { executeDAG, formatDAGResult, generateTaskDAG, resolveDAGRoleModel, type DAGExecutionResult } from "./workflows/dag-executor";

interface RuntimeContext {
	cwd: string;
	fluxDir: string;
	config: ReturnType<typeof loadConfig>;
	modelsConfig: any;
	sharedSkills: string[];
	pricing?: PricingTable;
}
function readModels(cwd: string): any {
	const path = join(cwd, ".agentflux", "models.json");
	let value: any = { models: {} };
	if (existsSync(path)) try { value = JSON.parse(readFileSync(path, "utf-8")); } catch {}
	value.models = mergeModels(value.models ?? {}, discoverPiModels());
	return value;
}

function notify(ctx: any, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else (level === "error" ? console.error : console.log)(text);
}

function templateFromRole(runtime: RuntimeContext, roleName: string, name = roleName): AgentTemplate {
	const role = loadAllRoles(runtime.cwd, runtime.modelsConfig).get(roleName);
	if (!role) throw new Error(`Unknown Agent template: ${roleName}`);
	return {
		name,
		role: roleName,
		description: role.description ?? roleName,
		model: role.model,
		provider: role.model ? runtime.modelsConfig.models?.[role.model]?.provider : undefined,
		tools: role.tools,
		skills: [...new Set([...runtime.sharedSkills, ...(role.skills ?? [])])],
		mcpServers: role.mcpServers,
		workspace: role.workspace,
		systemPrompt: role.systemPrompt ?? `You are the ${roleName} Agent.`,
		thinking: role.thinking,
		communication: role.communication,
	};
}

export default function agentFlux(pi: ExtensionAPI) {
	let runtime: RuntimeContext | null = null;
	let telemetry: TelemetryWriter | null = null;
	let sessionId = "main";
	let turnIndex = 0;
	let currentPlan: TaskExecutionPlan | null = null;
	const activeRuns = new Map<string, AbortController>();

	const persistentContext = (): PersistentAgentContext => {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		return { cwd: runtime.cwd, modelsConfig: runtime.modelsConfig, telemetry: telemetry ?? undefined, pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, prefixLayout: runtime.config.cache.prefix_layout === "static_first", timeoutMs: runtime.config.budget.max_wall_clock_seconds * 1000, maxCostUsd: runtime.config.budget.max_cost_per_task };
	};

	async function runEphemeral(role: string, name: string, task: string, signal?: AbortSignal, lockFiles?: string[], taskId?: string): Promise<AgentRunResult> {
		if (!runtime) throw new Error("AgentFlux is not initialized");
		const record = createEphemeralRecord({ name, role, sessionId, telemetry: telemetry ?? undefined });
		const result = await runAgent({ cwd: runtime.cwd, agent: templateFromRole(runtime, role, name), task, sessionId, telemetry: telemetry ?? undefined, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, persistent: false, timeoutMs: runtime.config.budget.max_wall_clock_seconds * 1000, maxRetries: 1, maxCostUsd: runtime.config.budget.max_cost_per_task, signal, lockFiles, taskId });
		finishEphemeralRecord(record, result.exitCode, result.usage.cost, telemetry ?? undefined, sessionId);
		return result;
	}

	async function runWorkflow(plan: TaskExecutionPlan, signal?: AbortSignal): Promise<DAGExecutionResult> {
		if (!runtime || !telemetry) throw new Error("AgentFlux is not initialized");
		const planner = resolveDAGRoleModel(runtime.cwd, runtime.modelsConfig, "planner");
		const startedAt = Date.now();
		const dag = await generateTaskDAG(plan.task, { cwd: runtime.cwd, model: planner.model, provider: planner.provider, thinking: planner.thinking, models: runtime.modelsConfig.models, pricing: runtime.pricing, telemetry, sessionId, prefixLayout: runtime.config.cache.prefix_layout === "static_first", signal, maxCostUsd: plan.budget.maxCostUsd, timeoutMs: plan.budget.maxWallClockMs, taskId: plan.taskId });
		return executeDAG(dag, { cwd: runtime.cwd, fluxDir: runtime.fluxDir, modelsConfig: runtime.modelsConfig, telemetry, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, sessionId, sharedSkills: runtime.sharedSkills, persistent: false, enableQualityGate: true, maxRetries: 1, signal, maxCostUsd: plan.budget.maxCostUsd, maxWallClockMs: Math.max(1, plan.budget.maxWallClockMs - (Date.now() - startedAt)), maxIterations: dag.nodes.length + plan.budget.maxIterations, maxParallel: 3, executionId: plan.taskId, taskId: plan.taskId });
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		const config = loadConfig(ctx.cwd);
		const warnings = validateConfig(config);
		const modelsConfig = readModels(ctx.cwd);
		const fluxDir = join(ctx.cwd, ".agentflux");
		telemetry = new TelemetryWriter(fluxDir);
		sessionId = ctx.sessionManager?.getSessionFile?.() ?? `main-${randomUUID()}`;
		runtime = { cwd: ctx.cwd, fluxDir, config, modelsConfig, sharedSkills: resolveSharedSkills(config, modelsConfig) };
		try { runtime.pricing = await loadPricing(fluxDir, config.pricing, ctx.model?.id); } catch {}
		for (const warning of warnings) notify(ctx, warning, "warning");
		notify(ctx, "AgentFlux ready · Direct / Team / Workflow / Community", "info");
	});

	pi.on("context", async (event: any) => {
		if (!runtime) return undefined;
		const result = applyMask(event.messages, runtime.config.context, null);
		return result.result.applied ? { messages: result.messages } : undefined;
	});
	pi.on("before_provider_request", async (event: any) => runtime ? applyPrefixLayout(event.payload, runtime.config.cache).payload : undefined);
	pi.on("before_agent_start", async (event: any) => {
		if (!currentPlan) return undefined;
		const instruction = currentPlan.workStyle === "direct"
			? "Work directly in the main Agent. Do not create another Agent."
			: currentPlan.workStyle === "team"
				? "You are the lead Agent. Use flux_team or flux_agent only for bounded independent work, then integrate and verify the result."
				: currentPlan.workStyle === "community"
					? "Act as Community moderator. Use flux_issue for claims, discussion and resolution; execution must have an explicit claim."
					: "Use flux_workflow exactly once and report its verified result.";
		return { systemPrompt: `${event.systemPrompt}\n\nAgentFlux task contract:\n${formatTaskExecutionPlan(currentPlan)}\n${instruction}` };
	});
	pi.on("turn_end", async () => { turnIndex += 1; });
	pi.on("agent_end", async () => {
		if (!currentPlan || !telemetry) return;
		telemetry.writeTaskExecution({ sessionId, taskId: currentPlan.taskId, action: "completed", workStyle: currentPlan.workStyle, task: currentPlan.task, outcome: { status: "success", success: true } });
		currentPlan = null;
	});
	pi.on("session_shutdown", async () => { for (const controller of activeRuns.values()) controller.abort(); activeRuns.clear(); });

	registerSessionFork(pi, () => ({ sessionId, telemetry }));
	registerCompactionAdvisor(pi, () => ({ sessionId, telemetry }));

	pi.registerTool({
		name: "flux_agent",
		label: "Agent",
		description: "Create, run, list or archive an Agent. Ephemeral Agents terminate after one task; persistent Agents keep a stable identity and session.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("run_ephemeral"), Type.Literal("create_persistent"), Type.Literal("run_persistent"), Type.Literal("list"), Type.Literal("archive")]), name: Type.Optional(Type.String()), role: Type.Optional(Type.String()), task: Type.Optional(Type.String()), lockFiles: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params, signal) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			if (params.action === "list") return { content: [{ type: "text", text: formatPersistentAgents(listPersistentAgents(runtime.cwd)) }], details: { ok: true } };
			if (!params.name) throw new Error(`${params.action} requires name`);
			if (params.action === "create_persistent") { if (!params.role) throw new Error("create_persistent requires role"); const agent = registerPersistentAgent(runtime.cwd, params.name, params.role, runtime.modelsConfig); telemetry?.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "persistent", origin: "template", status: "idle", action: "created" }); return { content: [{ type: "text", text: `Created persistent Agent ${agent.name} (${agent.role})` }], details: { ok: true } }; }
			if (params.action === "archive") { const agent = archivePersistentAgent(runtime.cwd, params.name); telemetry?.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "persistent", origin: agent.lineage.origin, status: "archived", action: "archived" }); return { content: [{ type: "text", text: `Archived ${agent.name}` }], details: { ok: true } }; }
			if (!params.task) throw new Error(`${params.action} requires task`);
			const result = params.action === "run_persistent" ? await runPersistentAgent(params.name, params.task, persistentContext(), signal) : await runEphemeral(params.role ?? params.name, params.name, params.task, signal, params.lockFiles, currentPlan?.taskId);
			return { content: [{ type: "text", text: formatAgentRunResult(result) }], details: { ok: true } };
		},
	});

	pi.registerTool({
		name: "flux_team",
		label: "Agent Team",
		description: "Run a small set of independent Agent tasks in parallel. The main Agent remains lead and integrates the results.",
		parameters: Type.Object({ tasks: Type.Array(Type.Object({ name: Type.String(), role: Type.Optional(Type.String()), task: Type.String(), persistent: Type.Optional(Type.Boolean()), lockFiles: Type.Optional(Type.Array(Type.String())) }), { minItems: 1, maxItems: 5 }) }),
		async execute(_id, params, signal) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			const ephemeral: ParallelAgentTask[] = [];
			const locks: Record<string, string[]> = {};
			const persistentTasks: Array<Promise<AgentRunResult>> = [];
			for (const item of params.tasks) {
				if (item.persistent) persistentTasks.push(runPersistentAgent(item.name, item.task, persistentContext(), signal));
				else { ephemeral.push({ agent: templateFromRole(runtime, item.role ?? item.name, item.name), task: item.task, label: item.name }); if (item.lockFiles) locks[item.name] = item.lockFiles; }
			}
			const parallel = ephemeral.length ? await runAgentsParallel(ephemeral, { cwd: runtime.cwd, sessionId, telemetry: telemetry ?? undefined, prefixLayout: runtime.config.cache.prefix_layout === "static_first", pricing: runtime.pricing, timeoutMs: runtime.config.budget.max_wall_clock_seconds * 1000, maxRetries: 1, lockFiles: locks, signal, maxCostUsd: runtime.config.budget.max_cost_per_task, taskId: currentPlan?.taskId }) : null;
			const persistentResults = await Promise.all(persistentTasks);
			const text = [parallel ? formatParallelAgentResults(parallel) : "", ...persistentResults.map(formatAgentRunResult)].filter(Boolean).join("\n\n");
			return { content: [{ type: "text", text }], details: { parallel, persistentResults } };
		},
	});

	pi.registerTool({ name: "flux_workflow", label: "Workflow", description: "Plan and execute a fixed DAG with dependencies, file locks and quality gates.", parameters: Type.Object({ task: Type.String() }), async execute(_id, params, signal) { if (!runtime) throw new Error("AgentFlux is not initialized"); const plan = createTaskExecutionPlan({ task: params.task, workStyle: "workflow", selectedBy: "main_agent", budget: runtime.config.budget }); const result = await runWorkflow(plan, signal); return { content: [{ type: "text", text: `${formatTaskExecutionPlan(plan)}\n\n${formatDAGResult(result)}` }], details: result }; } });

	pi.registerTool({
		name: "flux_issue", label: "Community Issue", description: "Create, discuss, claim, submit and resolve Community work.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("show"), Type.Literal("comment"), Type.Literal("claim"), Type.Literal("submit"), Type.Literal("resolve")]), issueId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), body: Type.Optional(Type.String()), agent: Type.Optional(Type.String()), scope: Type.Optional(Type.String()), claimId: Type.Optional(Type.String()), acceptanceCriteria: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params) {
			if (!runtime) throw new Error("AgentFlux is not initialized");
			if (params.action === "list") { const issues = listIssues(runtime.cwd); return { content: [{ type: "text", text: issues.length ? issues.map(formatIssue).join("\n\n") : "No Community issues." }], details: { ok: true } }; }
			if (params.action === "create") { const issue = createIssue(runtime.cwd, { title: params.title ?? "", description: params.body ?? "", acceptanceCriteria: params.acceptanceCriteria }); return { content: [{ type: "text", text: formatIssue(issue) }], details: { ok: true } }; }
			if (!params.issueId) throw new Error(`${params.action} requires issueId`);
			const issue = params.action === "show" ? getIssue(runtime.cwd, params.issueId)
				: params.action === "comment" ? commentOnIssue(runtime.cwd, params.issueId, params.agent ?? "main", params.body ?? "")
					: params.action === "claim" ? claimIssue(runtime.cwd, params.issueId, params.agent ?? "main", params.scope ?? "")
						: params.action === "submit" ? submitClaim(runtime.cwd, params.issueId, params.claimId ?? "")
							: resolveIssue(runtime.cwd, params.issueId);
			if (!issue) throw new Error(`Issue not found: ${params.issueId}`);
			return { content: [{ type: "text", text: formatIssue(issue) }], details: { ok: true } };
		},
	});

	pi.registerTool({ name: "flux_message", label: "Agent Message", description: "Send or inspect reliable Agent messages.", parameters: Type.Object({ action: Type.Union([Type.Literal("send"), Type.Literal("poll"), Type.Literal("ack")]), sender: Type.Optional(Type.String()), target: Type.String(), content: Type.Optional(Type.String()), messageId: Type.Optional(Type.String()) }), async execute(_id, params) { if (!runtime) throw new Error("AgentFlux is not initialized"); const bus = new MessageBus(runtime.fluxDir); const sender = params.sender ?? "main"; const result = params.action === "send" ? bus.sendDirect(sender, params.target, "message", params.content ?? "") : params.action === "poll" ? bus.poll(params.target) : bus.acknowledge(params.target, params.messageId ?? ""); return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result }; } });

	pi.registerCommand("flux", { description: "Open AgentFlux Workbench or run a command", getArgumentCompletions: getFluxArgumentCompletions, handler: async (input: string, ctx: any) => {
		try {
			if (!runtime || !telemetry) throw new Error("AgentFlux is not initialized");
			if (!input.trim()) {
				const menuCommand = await showFluxTuiMenu(ctx);
				if (menuCommand === undefined) return notify(ctx, FLUX_HELP);
				if (menuCommand === null) return;
				input = menuCommand;
			}
			const command = parseFluxCommand(input);
			if (command.kind === "help") return notify(ctx, FLUX_HELP);
			if (command.kind === "compact") return notify(ctx, formatCompactionAdvice(analyzeCompaction(ctx)));
			if (command.kind === "status") return notify(ctx, [`work style ${currentPlan?.workStyle ?? "idle"}`, `active runs ${activeRuns.size}`, formatPersistentAgents(listPersistentAgents(runtime.cwd)), `issues ${listIssues(runtime.cwd).length}`].join("\n"));
			if (command.kind === "fork") return notify(ctx, await handleForkCommand(command.args, ctx));
			if (command.kind === "gc") return notify(ctx, formatLifecycleGcReport(runLifecycleGc(runtime.fluxDir, runtime.config.retention, { dryRun: command.dryRun, activeRunIds: [...activeRuns.keys()] })));
			if (command.kind === "cancel") { const ids = command.taskId ? [command.taskId] : [...activeRuns.keys()]; for (const id of ids) activeRuns.get(id)?.abort(); return notify(ctx, ids.length ? `Cancellation requested: ${ids.join(", ")}` : "No active runs."); }
			if (command.kind === "agent") {
				const [action, name, roleOrTask, ...rest] = command.args;
				if (action === "list") return notify(ctx, formatPersistentAgents(listPersistentAgents(runtime.cwd)));
				if (action === "create" && name && roleOrTask) {
					const agent = registerPersistentAgent(runtime.cwd, name, roleOrTask, runtime.modelsConfig);
					telemetry.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "persistent", origin: "template", status: "idle", action: "created" });
					return notify(ctx, `Created ${agent.name}`);
				}
				if (action === "archive" && name) {
					const agent = archivePersistentAgent(runtime.cwd, name);
					telemetry.writeAgentLifecycle({ sessionId, agentId: agent.id, agent: agent.name, kind: "persistent", origin: agent.lineage.origin, status: "archived", action: "archived" });
					return notify(ctx, `Archived ${agent.name}`);
				}
				if (action === "run" && name && roleOrTask) return notify(ctx, formatAgentRunResult(await runPersistentAgent(name, [roleOrTask, ...rest].join(" "), persistentContext())));
				throw new Error("Usage: /flux agent list|create <name> <role>|run <name> <task>|archive <name>");
			}
			if (command.kind === "issue") {
				const [action, id, ...rest] = command.args;
				if (action === "list") return notify(ctx, listIssues(runtime.cwd).map(formatIssue).join("\n\n") || "No Community issues.");
				if (action === "create") return notify(ctx, formatIssue(createIssue(runtime.cwd, { title: [id, ...rest].filter(Boolean).join(" "), description: "" })));
				if (action === "show" && id) { const issue = getIssue(runtime.cwd, id); if (!issue) throw new Error(`Issue not found: ${id}`); return notify(ctx, formatIssue(issue)); }
				if (action === "comment" && id) return notify(ctx, formatIssue(commentOnIssue(runtime.cwd, id, "main", rest.join(" "))));
				if (action === "claim" && id && rest.length >= 2) return notify(ctx, formatIssue(claimIssue(runtime.cwd, id, rest[0], rest.slice(1).join(" "))));
				if (action === "submit" && id && rest[0]) return notify(ctx, formatIssue(submitClaim(runtime.cwd, id, rest[0])));
				if (action === "resolve" && id) return notify(ctx, formatIssue(resolveIssue(runtime.cwd, id)));
				throw new Error("Invalid /flux issue command");
			}
			if (command.kind === "work") {
				const plan = createTaskExecutionPlan({ task: command.task, workStyle: command.style, selectedBy: "user", budget: runtime.config.budget });
				telemetry.writeTaskExecution({ sessionId, taskId: plan.taskId, action: "created", workStyle: plan.workStyle, task: plan.task });
				if (plan.workStyle === "workflow") {
					const controller = new AbortController(); activeRuns.set(plan.taskId, controller);
					if (ctx.mode === "print") {
						try { notify(ctx, formatDAGResult(await runWorkflow(plan, controller.signal))); }
						finally { activeRuns.delete(plan.taskId); }
						return;
					}
					notify(ctx, `${formatTaskExecutionPlan(plan)}\nDispatched.`);
					void runWorkflow(plan, controller.signal).then(result => notify(ctx, formatDAGResult(result))).catch(error => notify(ctx, `Workflow failed: ${error?.message ?? error}`, "error")).finally(() => activeRuns.delete(plan.taskId)); return;
				}
				if (plan.workStyle === "community") { const issue = createIssue(runtime.cwd, { title: plan.task.slice(0, 100), description: plan.task, acceptanceCriteria: [] }); notify(ctx, `${formatTaskExecutionPlan(plan)}\nCreated ${issue.id}`); }
				else notify(ctx, `${formatTaskExecutionPlan(plan)}\nApplied.`);
				currentPlan = plan;
				const previousTurn = turnIndex;
				pi.sendUserMessage(plan.workStyle === "community" ? `Moderate and execute Community issue for: ${plan.task}` : plan.task);
				if (ctx.mode === "print") {
					const deadline = Date.now() + 5_000;
					while (ctx.isIdle?.() && turnIndex === previousTurn && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
					if (!ctx.isIdle?.()) await ctx.waitForIdle?.();
					else if (turnIndex === previousTurn) throw new Error("AgentFlux could not start the delegated main turn");
				}
				return;
			}
		} catch (error: any) { notify(ctx, error?.message ?? String(error), "error"); }
	} });
}
