/**
 * AgentFlux Workflow：planner 输出结构化 DAG，执行器处理拓扑并行、
 * review 反馈、质量门、重试和状态持久化。
 */

import { runAgent, type AgentTemplate, type AgentRunResult } from "../agents/agent-runner";
import { findAgents, getAgentRoles, runAgentRecord } from "../agents/agent-store";
import { checkQualityGate, type QualityGateResult } from "./quality-gate";
import type { TelemetryWriter } from "../telemetry/events";
import type { PricingTable } from "../core/pricing";
import { assignModel, rankModels, type ModelEntry, type RoleRequirement } from "../core/model-capability";
import { loadAllRoles, type RoleDefinition } from "../agents/templates";
import { SharedBoard } from "../core/shared-board";
import { assertSafeOpaqueId, resolvePathInsideExistingRoot } from "../core/safe-path";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { normalizeOptionalDurationMs, remainingDuration } from "../core/deadline";
import type { RunHealthConfig } from "../core/run-health";

/**
 * 诊断日志 sink。默认 console.error；UI 模式下由宿主置空（setDagLogSink(null)），
 * 避免 stderr 直写终端干扰 TUI 输入区。
 */
let dagLogSink: ((message: string) => void) | null = console.error;
export function setDagLogSink(sink: ((message: string) => void) | null): void { dagLogSink = sink; }
function dagLog(message: string): void { dagLogSink?.(message); }

// ─── 类型定义 ───

export interface TaskNode {
	id: string;
	title: string;
	role: string;               // 已注册角色模板名称，可扩展，不限于内置四角色
	/** 可选的已注册 Agent id/name；填写后本节点以该 Agent 身份运行。 */
	agentId?: string;
	/** 该绑定 Agent 的会话策略；shared 复用身份会话，fresh 使用独立会话。 */
	sessionMode?: "shared" | "fresh";
	dependsOn: string[];        // 前置任务 ID
	parallelizable: boolean;    // 是否可与其他任务并行
	acceptanceCriteria: string[]; // 验收标准
	files: string[];            // 涉及文件 (用于冲突检测)
	description?: string;       // 详细描述
}

export interface TaskDAG {
	nodes: TaskNode[];
	description: string;        // 整体任务描述
	planningCostUsd?: number;    // planner 调用也属于任务总成本
}

/** 为 DAG 级熔断选择可用模型；首选健康时保持原选择。 */
export function selectHealthyModel(
	preferred: string,
	requirement: RoleRequirement,
	models: Record<string, ModelEntry>,
	unavailable: ReadonlySet<string>,
): string {
	if (!unavailable.has(preferred)) return preferred;
	const fallback = rankModels(requirement, models)
		.map(candidate => candidate.model)
		.find(candidate => !unavailable.has(candidate));
	if (!fallback) throw new Error(`all models unavailable after circuit breaker: ${[...unavailable].join(", ")}`);
	return fallback;
}
/** 单节点 deadline 不能越过 DAG 的全局 wall-clock deadline。 */
export function boundedNodeTimeout(configuredTimeoutMs: number | null | undefined, dagDeadlineMs: number | null | undefined, nowMs = Date.now()): number | undefined {
	const configured = normalizeOptionalDurationMs(configuredTimeoutMs, "node timeout");
	const remaining = remainingDuration(dagDeadlineMs, nowMs);
	if (configured === undefined) return remaining;
	if (remaining === undefined) return configured;
	return Math.min(configured, remaining);
}

export interface TaskExecutionResult {
	node: TaskNode;
	subagentResult: AgentRunResult;
	gateResult: QualityGateResult | null;  // 质量门结果 (null=未检查)
	retryCount: number;         // 重试次数
	passed: boolean;            // 是否通过 (gate 通过或无 gate)
}

export interface DAGExecutionResult {
	executionId: string;
	taskResults: Map<string, TaskExecutionResult>;
	allPassed: boolean;
	status: "passed" | "failed" | "cancelled" | "budget_exceeded" | "timed_out";
	totalCost: number;
	wallClockMs: number;
	completedNodes: string[];
	failedNodes: string[];
	artifactPaths: Record<string, string>;
}

const ROLE_FALLBACK_REQUIREMENTS: Record<string, RoleRequirement> = {
	planner: { coding: 0.3, reasoning: 0.9, speed: 0.2, context: 0.7, cost_eff: 0.3 },
	implementer: { coding: 0.8, reasoning: 0.5, speed: 0.6, cost_eff: 0.7 },
	reviewer: { coding: 0.7, reasoning: 0.8, cost_eff: 0.4 },
	tester: { coding: 0.7, reasoning: 0.5, speed: 0.5, cost_eff: 0.6 },
};

export interface ResolvedDAGRoleModel {
	model: string;
	provider?: string;
	thinking?: RoleDefinition["thinking"];
	source: "model" | "main" | "affinity" | "single";
}

/** Resolve a DAG role through the same MD > models.json > builtin precedence as node execution. */
export function resolveDAGRoleModel(cwd: string, modelsConfig: any, roleName: string, defaults?: { model?: string; provider?: string }): ResolvedDAGRoleModel {
	const role = loadAllRoles(cwd, modelsConfig).get(roleName);
	if (!role) throw new Error(`DAG role not found: ${roleName}`);
	const models = modelsConfig?.models ?? {};
	// 显式角色模型优先，即使它只存在于 pi provider 配置而尚未出现在 AgentFlux 模型表中。
	if (role.model) {
		return {
			model: role.model,
			provider: role.provider ?? models[role.model]?.provider,
			thinking: role.thinking,
			source: "model",
		};
	}
	// 没有角色级模型时，继承当前 Main Agent；能力亲和度不应静默替换 Main 的选择。
	if (defaults?.model) {
		return {
			model: defaults.model,
			provider: defaults.provider ?? models[defaults.model]?.provider,
			thinking: role.thinking,
			source: "main",
		};
	}
	const requirement = (role.requirement as RoleRequirement | undefined)
		?? ROLE_FALLBACK_REQUIREMENTS[roleName]
		?? { coding: 0.5, reasoning: 0.5, cost_eff: 0.5 };
	const assigned = assignModel(roleName, { model: role.model, requirement }, models);
	return {
		model: assigned.model,
		provider: role.provider ?? models[assigned.model]?.provider,
		thinking: role.thinking,
		source: assigned.source,
	};
}

// ─── Dynamic planning ───

/**
 * 让 planner agent 分析任务并输出结构化 DAG.
 *
 * planner 的 system prompt 要求输出 JSON 格式的 TaskDAG.
 * 如果 planner 输出无法解析为 JSON, 回退为单节点 DAG.
 */
export async function generateTaskDAG(
	task: string,
	opts: {
		cwd: string;
		model?: string;
		provider?: string;
		/** 无显式 planner 模型时继承 Main Agent 当前模型。 */
		defaultModel?: string;
		defaultProvider?: string;
		thinking?: RoleDefinition["thinking"];
		pricing?: PricingTable;
		models?: Record<string, ModelEntry>;
		modelsConfig?: any;
		telemetry?: TelemetryWriter;
		sessionId: string;
		prefixLayout: boolean;
		signal?: AbortSignal;
		maxCostUsd?: number;
		parentMaxTurns?: number;
		parentMaxInputTokens?: number;
		/** Absolute parent deadline; takes precedence over timeoutMs. */
		deadlineAt?: number;
		timeoutMs?: number | null;
		health?: RunHealthConfig;
		taskId?: string;
		executionId?: string;
	},
): Promise<TaskDAG> {
	const plannerAgent: AgentTemplate = {
		name: "dag-planner",
		description: "Decompose task into structured DAG",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: `You are a task decomposition specialist. Analyze the given task and break it down into a structured task graph.

Output EXACTLY this JSON format (no other text):
\`\`\`json
{
  "description": "<overall task description>",
  "nodes": [
    {
      "id": "t1",
      "title": "<short title>",
      "role": "implementer",
      "dependsOn": [],
      "parallelizable": true,
      "acceptanceCriteria": ["<criterion 1>", "<criterion 2>"],
      "files": ["<file path>"],
      "description": "<detailed description>"
    }
  ]
}
\`\`\`

Rules:
- Use an exact registered role template name; built-ins include "planner", "implementer", "reviewer", and "tester", while project roles may add more names
- An optional agentId may bind a node to an existing Agent identity; use sessionMode "shared" or "fresh" when appropriate
- dependsOn lists task IDs that must complete before this task
- parallelizable=true means this task can run alongside other parallelizable tasks
- acceptanceCriteria are verifiable conditions
- files lists the files this task will touch (for conflict detection)
- Use forward slashes in every file path, including on Windows
- Keep it minimal: 2-5 nodes for most tasks
- The last node should usually be a "reviewer" or "tester" that validates the work`,
		thinking: opts.thinking ?? "high",
	};

	const roleNames = [...loadAllRoles(opts.cwd, opts.modelsConfig ?? { models: opts.models }).keys()].sort();
	const result = await runAgent({
		cwd: opts.cwd,
		agent: plannerAgent,
		task: `Analyze this task and decompose it into a structured DAG:\n\n${task}\n\nRegistered role templates (use exact names only): ${roleNames.join(", ")}`,
		sessionId: opts.sessionId,
		telemetry: opts.telemetry,
		prefixLayout: opts.prefixLayout,
		model: opts.model ?? opts.defaultModel,
		provider: opts.provider ?? opts.defaultProvider,
		pricing: opts.pricing,
		thinking: opts.thinking ?? "high",
		maxRetries: 1,
		retryDelayMs: 2000,
		enableModelFallback: !!opts.models && Object.keys(opts.models).length > 1,
		modelsForFallback: opts.models,
		roleRequirementForFallback: ROLE_FALLBACK_REQUIREMENTS.planner,
		signal: opts.signal,
		maxCostUsd: opts.maxCostUsd,
		parentMaxCostUsd: opts.maxCostUsd,
		parentMaxTurns: opts.parentMaxTurns,
		parentMaxInputTokens: opts.parentMaxInputTokens,
		deadlineAt: opts.deadlineAt,
		health: opts.health,
		taskId: opts.taskId,
		executionId: opts.executionId,
		timeoutMs: opts.timeoutMs,
	});

	if (result.exitCode !== 0 || result.errorMessage || !result.output.trim()) {
		throw new Error(`DAG planner failed: ${result.errorMessage ?? `exit ${result.exitCode} with no output`}`);
	}

	try {
		return parsePlannerTaskDAG(result.output, task, result.usage.cost);
	} catch (error: unknown) {
		dagLog(`[flux dag] planner output parse failed: ${error instanceof Error ? error.message : String(error)}`);
		throw new Error("DAG planner returned invalid or non-JSON task graph");
	}
}

/**
 * 解析 planner JSON。仅修复 LLM 常见且语义保守的格式错误：
 * Windows/普通文本反斜杠转义和对象/数组尾逗号；其余错误仍 fail-closed。
 */
export function parsePlannerTaskDAG(output: string, fallbackDescription: string, planningCostUsd = 0): TaskDAG {
	const jsonMatch = output.match(/```json\s*([\s\S]*?)```/i) || output.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("planner output contains no JSON object");
	const raw = (jsonMatch[1] || jsonMatch[0]).trim();
	const repaired = raw
		.replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u")
		.replace(/\\(?!["\\/u])/g, "\\\\")
		.replace(/,\s*([}\]])/g, "$1");
	let parsed: unknown;
	let firstError: unknown;
	try { parsed = JSON.parse(raw); }
	catch (error: unknown) {
		firstError = error;
		try { parsed = JSON.parse(repaired); }
		catch (repairError: unknown) {
			throw new Error(`invalid planner JSON: ${firstError instanceof Error ? firstError.message : String(firstError)}; repair failed: ${repairError instanceof Error ? repairError.message : String(repairError)}`);
		}
	}
	if (!parsed || typeof parsed !== "object") throw new Error("planner JSON is not an object");
	const root = parsed as Record<string, unknown>;
	if (!Array.isArray(root.nodes) || root.nodes.length === 0) throw new Error("planner JSON has no nodes");
	const nodes: TaskNode[] = root.nodes.map((value: unknown, index: number) => {
		if (!value || typeof value !== "object") throw new Error(`planner node ${index + 1} is not an object`);
		const node = value as Record<string, unknown>;
		const strings = (candidate: unknown): string[] => Array.isArray(candidate)
			? candidate.filter((item): item is string => typeof item === "string") : [];
		return {
			id: typeof node.id === "string" && node.id ? node.id : `t${index + 1}`,
			title: typeof node.title === "string" && node.title ? node.title : `Task ${index + 1}`,
			role: typeof node.role === "string" && node.role.trim() ? node.role.trim() : "implementer",
			agentId: typeof node.agentId === "string" && node.agentId.trim() ? node.agentId.trim() : undefined,
			sessionMode: node.sessionMode === undefined ? undefined : node.sessionMode === "fresh" || node.sessionMode === "shared" ? node.sessionMode : (() => { throw new Error(`invalid planner node ${index + 1} sessionMode`); })(),
			dependsOn: strings(node.dependsOn),
			parallelizable: node.parallelizable === true,
			acceptanceCriteria: strings(node.acceptanceCriteria),
			files: strings(node.files).map(file => file.replace(/\\/g, "/")),
			description: typeof node.description === "string" ? node.description : undefined,
		};
	});
	validateTaskDAG(nodes);
	return {
		nodes,
		description: typeof root.description === "string" && root.description ? root.description : fallbackDescription,
		planningCostUsd,
	};
}

export function validateTaskDAG(nodes: TaskNode[]): void {
	const ids = new Set<string>();
	for (const node of nodes) {
		if (typeof node.role !== "string" || !node.role.trim()) throw new Error("invalid DAG: node role must be a non-empty registered role name");
		if (node.agentId !== undefined && (typeof node.agentId !== "string" || !node.agentId.trim())) throw new Error(`invalid DAG: ${node.id} agentId must be a non-empty selector`);
		if (node.sessionMode !== undefined && node.sessionMode !== "shared" && node.sessionMode !== "fresh") throw new Error(`invalid DAG: ${node.id} sessionMode must be shared or fresh`);
		let id: string;
		try { id = assertSafeOpaqueId(node.id, "DAG node id"); }
		catch (error) { throw new Error(`invalid DAG: ${error instanceof Error ? error.message : String(error)}`); }
		if (ids.has(id)) throw new Error(`invalid DAG: duplicate node id '${id}'`);
		ids.add(id);
	}
	for (const node of nodes) {
		for (const dep of node.dependsOn) {
			if (!ids.has(dep)) throw new Error(`invalid DAG: ${node.id} depends on missing node ${dep}`);
			if (dep === node.id) throw new Error(`invalid DAG: ${node.id} depends on itself`);
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(nodes.map(node => [node.id, node]));
	const visit = (id: string) => {
		if (visiting.has(id)) throw new Error(`invalid DAG: dependency cycle at ${id}`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
		visiting.delete(id);
		visited.add(id);
	};
	for (const node of nodes) visit(node.id);
}

function findUpstreamImplementer(node: TaskNode, dag: TaskDAG): string | undefined {
	const byId = new Map(dag.nodes.map(candidate => [candidate.id, candidate]));
	const queue = [...node.dependsOn];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (seen.has(id)) continue;
		seen.add(id);
		const candidate = byId.get(id);
		if (!candidate) continue;
		if (candidate.role === "implementer") return candidate.id;
		queue.push(...candidate.dependsOn);
	}
	return undefined;
}

// ─── DAG execution ───

export interface DAGExecutorOptions {
	cwd: string;
	/** executeDAG 内部传递的绝对全局 deadline；调用方通常不设置。 */
	deadlineAt?: number;
	fluxDir: string;
	modelsConfig: any;
	telemetry: TelemetryWriter;
	prefixLayout: boolean;
	pricing?: PricingTable;
	sessionId: string;
	sharedSkills?: string[];
	/** 节点没有显式模型时继承当前 Main Agent 模型。 */
	defaultModel?: string;
	defaultProvider?: string;
	maxRetries?: number;
	enableQualityGate?: boolean;
	timeoutMs?: number | null; // 每个 subagent 的显式 deadline；省略/null 表示不按 wall-clock 终止
	persistent?: boolean;
	signal?: AbortSignal;      // 用户取消时传播到每个真实子进程
	maxCostUsd?: number;       // 步骤之间硬停止；单次 provider 请求可能产生少量超额
	maxWallClockMs?: number | null;   // 整个 DAG 的显式 wall-clock 上限；省略/null 表示无硬限制
	maxIterations?: number;    // 全局节点执行批次数上限
	maxParallel?: number;      // 并发节点上限
	parentMaxTurns?: number;   // 父 Task 聚合 assistant turn 上限
	parentMaxInputTokens?: number;
	health?: RunHealthConfig;   // 子 Run 健康阈值；只产生提示，不自动终止
	/** 确定性测试或受控宿主可替换子进程入口；正常生产调用留空。 */
	invocationOverride?: { command: string; args: string[] };
	executionId?: string;      // 显式 run id；也用于断点文件
	taskId?: string;
	resume?: boolean;          // 从同 executionId 的 checkpoint 恢复
	resumeFromExecutionId?: string; // 从只读父执行 checkpoint 派生新 execution
	qualityGate?: {            // 质量门独立配置: judge 模型/显式 deadline；省略 timeout 表示只受取消控制
		model?: string;
		provider?: string;
		timeoutMs?: number | null;
	};
}

/**
 * judge 结果 → 动作决策（纯函数, 便于单测）:
 * - pass: 放行
 * - retry_judge: judge 自身无法判定（超时/解析失败）, 重试 judge 而不是重跑节点
 * - retry_node: criteria 明确不满足, 重跑节点
 */
export function judgeAction(gate: QualityGateResult): "pass" | "retry_judge" | "retry_node" {
	if (gate.passed) return "pass";
	if (gate.status === "indeterminate") return "retry_judge";
	return "retry_node";
}

export function createDAGRunId(executionId: string, nodeId: string): string {
	const safeExecutionId = assertSafeOpaqueId(executionId, "executionId");
	const safeNodeId = assertSafeOpaqueId(nodeId, "nodeId");
	return `dag-${safeExecutionId}-${safeNodeId}-${randomUUID()}`;
}

/**
 * 按拓扑序执行 DAG；支持独立节点并行、质量门、自动重试和 review 反馈。
 */
export async function executeDAG(
	dag: TaskDAG,
	opts: DAGExecutorOptions,
): Promise<DAGExecutionResult> {
	validateTaskDAG(dag.nodes);
	const maxRetries = opts.maxRetries ?? 2;
	const enableGate = opts.enableQualityGate ?? true;
	const wallStart = Date.now();
	const configuredWallClockMs = normalizeOptionalDurationMs(opts.maxWallClockMs, "DAG maxWallClockMs");
	const deadline = opts.deadlineAt === undefined
		? configuredWallClockMs === undefined ? undefined : wallStart + configuredWallClockMs
		: (() => {
			if (!Number.isFinite(opts.deadlineAt)) throw new Error("DAG deadlineAt must be finite");
			return opts.deadlineAt;
		})();
	const taskResults = new Map<string, TaskExecutionResult>();
	const completed = new Set<string>();
	const failed = new Set<string>();
	let totalCost = dag.planningCostUsd ?? 0;
	let status: DAGExecutionResult["status"] | "running" = "running";
	let iterationCount = 0;
	const executionId = assertSafeOpaqueId(
		opts.executionId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		"executionId",
	);
	if (opts.taskId) assertSafeOpaqueId(opts.taskId, "taskId");
	const artifactPaths: Record<string, string> = {};

	// 加载角色定义并在执行前验证所有节点绑定，避免执行到一半才发现角色/Agent 配置错误。
	const roles = loadAllRoles(opts.cwd, opts.modelsConfig);
	const models = opts.modelsConfig?.models ?? {};
	const boundAgentIds = new Map<string, string>();
	const boundAgentNames = new Map<string, string>();
	for (const node of dag.nodes) {
		if (!roles.has(node.role)) throw new Error(`DAG role not found: ${node.role}`);
		if (node.agentId) {
			const matches = findAgents(opts.cwd, node.agentId, opts.sessionId);
			if (matches.length === 0) throw new Error(`DAG Agent not found: ${node.agentId}`);
			if (matches.length > 1) throw new Error(`DAG Agent selector is ambiguous: ${node.agentId}`);
			const bound = matches[0];
			if (!getAgentRoles(bound).includes(node.role)) {
				throw new Error(`DAG Agent ${bound.name} is not registered for role ${node.role}; allowed roles: ${getAgentRoles(bound).join(", ")}`);
			}
			boundAgentIds.set(node.id, bound.id);
			boundAgentNames.set(node.id, bound.name);
		}
	}
	const board = new SharedBoard(opts.fluxDir);
	// 本次 DAG 内的 model/provider 熔断记忆：一次明确降级后，后续批次不再重复撞同一故障模型。
	const unavailableModels = new Set<string>();

	const rerunCount = new Map<string, number>();
	const reviewFeedback = new Map<string, string>();
	const runtimeDir = join(opts.fluxDir, "runtime");
	const runsDir = join(runtimeDir, "runs");
	mkdirSync(runsDir, { recursive: true });
	const runDir = resolvePathInsideExistingRoot(runsDir, executionId);
	const artifactDir = join(runDir, "artifacts");
	const dagStateFile = join(runDir, "checkpoint.json");
	const latestStateFile = join(runtimeDir, "dag-state.json");
	const resumeFromExecutionId = opts.resumeFromExecutionId
		? assertSafeOpaqueId(opts.resumeFromExecutionId, "resumeFromExecutionId")
		: opts.resume
			? executionId
			: undefined;
	const resumeCheckpointFile = resumeFromExecutionId
		? resolvePathInsideExistingRoot(runsDir, resumeFromExecutionId, "checkpoint.json")
		: undefined;
	try { mkdirSync(artifactDir, { recursive: true }); } catch {}

	function saveDagState(): void {
		const state = {
			executionId,
			resumedFromExecutionId: resumeFromExecutionId && resumeFromExecutionId !== executionId
				? resumeFromExecutionId
				: undefined,
			description: dag.description,
			nodeIds: dag.nodes.map(node => node.id),
			completed: [...completed],
			failed: [...failed],
			status,
			totalCost,
			iterationCount,
			taskResults: [...taskResults.entries()],
			artifactPaths,
			timestamp: Date.now(),
		};
		try {
			writeFileSync(dagStateFile, JSON.stringify(state, null, 2));
			writeFileSync(latestStateFile, JSON.stringify(state, null, 2));
		} catch {}
	}

	if (resumeCheckpointFile && existsSync(resumeCheckpointFile)) {
		let checkpoint: any;
		try {
			checkpoint = JSON.parse(readFileSync(resumeCheckpointFile, "utf-8"));
		} catch (error: any) {
			throw new Error(`checkpoint ${resumeFromExecutionId} is corrupt and was not overwritten: ${error?.message ?? String(error)}`);
		}
		const checkpointIds = new Set(Array.isArray(checkpoint.nodeIds) ? checkpoint.nodeIds : []);
		const dagIds = new Set(dag.nodes.map(node => node.id));
		if (checkpointIds.size !== dagIds.size || ![...dagIds].every(id => checkpointIds.has(id))) {
			throw new Error(`checkpoint ${resumeFromExecutionId} does not match current DAG (node set differs)`);
		}
		for (const id of checkpoint.completed ?? []) completed.add(id);
		// resume starts a new bounded attempt: completed nodes stay complete, failed nodes become runnable again.
		for (const [id, result] of checkpoint.taskResults ?? []) taskResults.set(id, result);
		Object.assign(artifactPaths, checkpoint.artifactPaths ?? {});
		totalCost = 0;
		iterationCount = 0;
	} else if (resumeFromExecutionId) {
		throw new Error(`checkpoint is unavailable for execution ${resumeFromExecutionId}`);
	}

	// 先写入本次 DAG，避免监控面板在首批节点完成前继续显示上一次执行。
	saveDagState();

	// 主循环: 按拓扑序执行
	while (completed.size + failed.size < dag.nodes.length) {
		if (opts.signal?.aborted) { status = "cancelled"; break; }
		if (deadline !== undefined && Date.now() >= deadline) { status = "timed_out"; break; }
		if (opts.maxCostUsd !== undefined && totalCost >= opts.maxCostUsd) { status = "budget_exceeded"; break; }
		if (iterationCount >= (opts.maxIterations ?? Number.MAX_SAFE_INTEGER)) { status = "failed"; break; }
		iterationCount++;
		// 找出所有依赖已完成的就绪任务
		const readyCandidates = dag.nodes.filter(n =>
			!completed.has(n.id) &&
			!failed.has(n.id) &&
			n.dependsOn.every(d => completed.has(d))
		);

		if (readyCandidates.length === 0) {
			// 死锁检测
			const remaining = dag.nodes.filter(n => !completed.has(n.id) && !failed.has(n.id));
			dagLog(`[flux dag] deadlock: remaining=${remaining.map(n => n.id).join(",")}`);
			for (const n of remaining) failed.add(n.id);
			status = "failed";
			break;
		}

		// parallelizable=false 的节点必须串行；声明了相同文件的节点也不能同批执行。
		const ready: TaskNode[] = [];
		const batchFiles = new Set<string>();
		for (const node of readyCandidates) {
			if (ready.length >= Math.max(1, opts.maxParallel ?? 3)) break;
			const normalizedFiles = node.files.map(file => file.replace(/\\/g, "/").toLowerCase());
			const conflicts = normalizedFiles.some(file => batchFiles.has(file));
			const boundAgentId = boundAgentIds.get(node.id);
			const sameBoundAgent = boundAgentId !== undefined
				&& ready.some(other => boundAgentIds.get(other.id) === boundAgentId);
			const canJoinBatch = ready.length === 0
				|| (node.parallelizable && ready.every(other => other.parallelizable) && !conflicts && !sameBoundAgent);
			if (!canJoinBatch) continue;
			ready.push(node);
			for (const file of normalizedFiles) batchFiles.add(file);
		}

		// 并行执行就绪任务
		dagLog(`[flux dag] executing ${ready.length} task(s): ${ready.map(n => n.id).join(", ")}`);

		// 更新 SharedBoard 状态供工作台查看。
		for (const node of ready) {
			try {
				board.updateAgentStatus(`dag-${node.id}`, {
					status: "running",
					workingOn: node.title.slice(0, 100),
				});
			} catch {}
			opts.telemetry.writeAgentLifecycle({
				sessionId: opts.sessionId,
				taskId: opts.taskId,
				agentId: boundAgentIds.get(node.id) ?? `agent-${executionId}-${node.id}`,
				agent: boundAgentNames.get(node.id) ?? `dag-${node.id}`,
				kind: "subagent",
				origin: "fresh",
				status: "running",
				action: "started",
				role: node.role,
				currentTask: (node.description || node.title).slice(0, 200),
			});
		}

		// 并行执行就绪任务 (用 allSettled 防止单个节点 throw 导致整批丢失)
		const remainingBudget = opts.maxCostUsd === undefined ? undefined : Math.max(0, opts.maxCostUsd - totalCost);
		const perNodeBudget = remainingBudget === undefined ? undefined : remainingBudget / ready.length;
		// An inherited absolute deadline is already checked by the loop and must
		// remain the sole parent clock. Do not turn its current remainder into a
		// fresh relative timeout, which would make every node start a new clock.
		const batchTimeoutMs = deadline === undefined
			? boundedNodeTimeout(opts.timeoutMs, undefined)
			: normalizeOptionalDurationMs(opts.timeoutMs, "DAG node timeout");
		if (batchTimeoutMs !== undefined && batchTimeoutMs <= 0) {
			status = "timed_out";
			break;
		}
		const batchOpts: DAGExecutorOptions = { ...opts, deadlineAt: deadline, timeoutMs: batchTimeoutMs };
		const batchSettled = await Promise.allSettled(
			ready.map(node => executeNodeWithGate(
				node, roles, models, batchOpts, maxRetries, enableGate, executionId,
				taskResults, unavailableModels, reviewFeedback.get(node.id), perNodeBudget,
			))
		);

		const batchResults: Array<{ node: TaskNode; result: AgentRunResult; gateResult: QualityGateResult | null; retryCount: number; passed: boolean; cost: number }> = [];
		for (let i = 0; i < batchSettled.length; i++) {
			const s = batchSettled[i];
			if (s.status === "fulfilled") {
				batchResults.push(s.value);
			} else {
				// executeNodeWithGate threw (spawn error, unexpected exception)
				const node = ready[i];
				dagLog(`[flux dag] ${node.id} threw exception: ${s.reason?.message ?? s.reason}`);
				batchResults.push({
					node, result: { agent: `dag-${node.id}`, exitCode: -1, output: "", usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 }, model: null, errorMessage: `exception: ${s.reason?.message ?? s.reason}` },
					gateResult: null, retryCount: 0, passed: false, cost: 0,
				});
			}
		}

		for (const { node, result, gateResult, retryCount, passed, cost } of batchResults) {
			totalCost += cost;
			taskResults.set(node.id, { node, subagentResult: result, gateResult, retryCount, passed });
			try {
				const artifactPath = resolvePathInsideExistingRoot(artifactDir, `${node.id}.md`);
				writeFileSync(artifactPath, result.output || `(no output)\n\nError: ${result.errorMessage ?? "unknown"}`, "utf-8");
				artifactPaths[node.id] = artifactPath;
			} catch {}

			if (passed) {
				completed.add(node.id);
				dagLog(`[flux dag] ${node.id} ✅ passed (retries=${retryCount}, cost=$${cost.toFixed(6)})`);
				try { board.updateAgentStatus(`dag-${node.id}`, { status: "done", workingOn: node.title.slice(0, 100) }); } catch {}
			} else {
				failed.add(node.id);
				dagLog(`[flux dag] ${node.id} ❌ failed after ${retryCount} retries`);
				try { board.updateAgentStatus(`dag-${node.id}`, { status: "failed", workingOn: node.title.slice(0, 100) }); } catch {}

				// reviewer 失败时允许对应 implementer 重跑一次。
				if (node.role === "reviewer" && node.dependsOn.length > 0) {
					const implId = findUpstreamImplementer(node, dag);
					if (implId && completed.has(implId) && (rerunCount.get(implId) ?? 0) < 1) {
						rerunCount.set(implId, (rerunCount.get(implId) ?? 0) + 1);
						dagLog(`[flux dag] reviewer failed, re-running implementer ${implId} (attempt ${rerunCount.get(implId)})`);
						failed.delete(node.id); // reviewer 在 implementer 修复后必须重新进入队列
						completed.delete(implId); // 重新执行 implementer
						reviewFeedback.set(implId, gateResult?.feedback ?? result.output ?? result.errorMessage ?? "review failed");
						try { board.updateAgentStatus(`dag-${implId}`, { status: "running", workingOn: "re-run (reviewer failed)" }); } catch {}
					} else if (implId && completed.has(implId)) {
						dagLog(`[flux dag] ${implId} already re-run once, not retrying again`);
					}
				}
			}
			opts.telemetry.writeAgentLifecycle({
				sessionId: opts.sessionId,
				taskId: opts.taskId,
				agentId: boundAgentIds.get(node.id) ?? `agent-${executionId}-${node.id}`,
				agent: boundAgentNames.get(node.id) ?? `dag-${node.id}`,
				kind: "subagent",
				origin: "fresh",
				status: passed ? "done" : result.exitCode === 130 ? "cancelled" : "failed",
				action: passed ? "completed" : result.exitCode === 130 ? "cancelled" : "failed",
				role: node.role,
				currentTask: (node.description || node.title).slice(0, 200),
				model: result.model ?? undefined,
				outcome: {
					status: passed ? "success" : result.exitCode === 130 ? "cancelled" : result.exitCode === 124 ? "timeout" : "failure",
					success: passed,
					exitCode: result.exitCode,
					error: result.errorMessage,
				},
			});
		}

		saveDagState();
	}

	const wallClockMs = Date.now() - wallStart;
	const allPassed = failed.size === 0;
	if (completed.size === dag.nodes.length && failed.size === 0) status = "passed";
	else if (status === "running") status = "failed";
	else if (status === "failed" && opts.signal?.aborted) status = "cancelled";
	if (status === "failed") {
		for (const node of dag.nodes) {
			if (!completed.has(node.id) && !failed.has(node.id)) failed.add(node.id);
		}
	}
	saveDagState();

	return {
		executionId, taskResults, allPassed: status === "passed" && allPassed, status,
		totalCost: Number(totalCost.toFixed(6)), artifactPaths,
		wallClockMs, completedNodes: [...completed], failedNodes: [...failed],
	};
}

// ─── 单节点执行 + 质量门 ───

async function executeNodeWithGate(
	node: TaskNode,
	roles: Map<string, RoleDefinition>,
	models: Record<string, any>,
	opts: DAGExecutorOptions,
	maxRetries: number,
	enableGate: boolean,
	executionId: string,
	taskResults: Map<string, TaskExecutionResult>,
	unavailableModels: Set<string>,
	reviewerFeedback?: string,
	maxCostUsd?: number,
): Promise<{ node: TaskNode; result: AgentRunResult; gateResult: QualityGateResult | null; retryCount: number; passed: boolean; cost: number }> {
	const role = roles.get(node.role);
	if (!role) throw new Error(`DAG role not found: ${node.role}`);

	// 选择节点模型：显式角色模型 > Main 当前模型 > 旧的能力亲和度匹配。
	let assignedModel: string | undefined;
	let assignedProvider: string | undefined;
	const roleRequirement = (role?.requirement as RoleRequirement | undefined)
		?? ROLE_FALLBACK_REQUIREMENTS[node.role]
		?? { coding: 0.5, reasoning: 0.5, cost_eff: 0.5 };
	try {
		let assignmentSource: ResolvedDAGRoleModel["source"];
		if (role?.model) {
			assignedModel = role.model;
			assignedProvider = role.provider ?? models[role.model]?.provider;
			assignmentSource = "model";
		} else if (opts.defaultModel) {
			assignedModel = opts.defaultModel;
			assignedProvider = opts.defaultProvider ?? models[opts.defaultModel]?.provider;
			assignmentSource = "main";
		} else {
			const assign = assignModel(node.role, { model: role?.model, requirement: role?.requirement }, models);
			assignedModel = assign.model;
			assignedProvider = role?.provider ?? models[assign.model]?.provider;
			assignmentSource = assign.source;
		}
		if (assignedModel && unavailableModels.has(assignedModel)) {
			const healthyFallback = selectHealthyModel(assignedModel, roleRequirement, models, unavailableModels);
			dagLog(`[flux dag] ${node.id} circuit breaker skips ${assignedModel} → ${healthyFallback}`);
			assignedModel = healthyFallback;
			assignedProvider = models[healthyFallback]?.provider;
		}
		dagLog(`[flux dag] ${node.id} model: ${assignedModel ?? "none"} (${assignmentSource!})`);
	} catch (e: any) {
		dagLog(`[flux dag] ${node.id} assignModel failed: ${e?.message}, using explicit role/Main model`);
		assignedModel = role?.model ?? opts.defaultModel;
		assignedProvider = role?.provider ?? (role?.model ? models[role.model]?.provider : opts.defaultProvider);
	}

	// 构建 agent 定义
	const agentDef: AgentTemplate = {
		name: `dag-${node.id}`,
		role: node.role,
		description: role?.description ?? node.title,
		tools: role?.tools,
		model: assignedModel,
		provider: assignedProvider,
		systemPrompt: role?.systemPrompt ?? `You are a ${node.role}.`,
		thinking: role?.thinking,
		communication: role?.communication,
		mcpServers: role?.mcpServers,
		workspace: role?.workspace,
		skills: [...(opts.sharedSkills ?? []), ...(role?.skills ?? [])].length > 0
			? [...(opts.sharedSkills ?? []), ...(role?.skills ?? [])] : undefined,
	};

	const dependencyArtifacts = node.dependsOn.map(depId => {
		const dep = taskResults.get(depId);
		if (!dep) return `### ${depId}\n(no dependency artifact available)`;
		const output = dep.subagentResult.output || `(no output; ${dep.subagentResult.errorMessage ?? "unknown result"})`;
		return `### ${depId}: ${dep.node.title}\nstatus=${dep.passed ? "passed" : "failed"}\n${output.slice(0, 20_000)}`;
	});
	const taskText = [
		node.description || node.title,
		dependencyArtifacts.length > 0 ? `\n=== Dependency artifacts ===\n${dependencyArtifacts.join("\n\n")}\n=== End dependency artifacts ===` : "",
		reviewerFeedback ? `\n=== Reviewer feedback requiring remediation ===\n${reviewerFeedback}\n=== End reviewer feedback ===` : "",
	].filter(Boolean).join("\n");
	let retryCount = 0;
	let lastResult: AgentRunResult | null = null;
	let lastGateResult: QualityGateResult | null = null;
	let totalNodeCost = 0;
	const nodeTimeoutMs = normalizeOptionalDurationMs(opts.timeoutMs, "node timeout");
	const relativeNodeDeadline = nodeTimeoutMs === undefined ? undefined : Date.now() + nodeTimeoutMs;
	const nodeDeadline = opts.deadlineAt === undefined
		? relativeNodeDeadline
		: relativeNodeDeadline === undefined ? opts.deadlineAt : Math.min(opts.deadlineAt, relativeNodeDeadline);

	while (retryCount <= maxRetries) {
		if (opts.signal?.aborted) {
			return {
				node,
				result: lastResult ?? { agent: agentDef.name, exitCode: 130, output: "", usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: totalNodeCost, contextTokens: 0 }, model: null, errorMessage: "cancelled" },
				gateResult: lastGateResult, retryCount, passed: false, cost: totalNodeCost,
			};
		}
		if (nodeDeadline !== undefined && Date.now() >= nodeDeadline) {
			return {
				node,
				result: lastResult ?? { agent: agentDef.name, exitCode: 124, output: "", usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: totalNodeCost, contextTokens: 0 }, model: null, errorMessage: "node explicit deadline exhausted" },
				gateResult: lastGateResult, retryCount, passed: false, cost: totalNodeCost,
			};
		}
		if (maxCostUsd !== undefined && totalNodeCost >= maxCostUsd) {
			return {
				node,
				result: lastResult ?? { agent: agentDef.name, exitCode: 75, output: "", usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: totalNodeCost, contextTokens: 0 }, model: null, errorMessage: "node budget exhausted" },
				gateResult: lastGateResult, retryCount, passed: false, cost: totalNodeCost,
			};
		}
		// 执行 subagent。绑定了 agentId 的节点通过统一 Agent 存储运行，
		// 因而会保留身份、角色选择、session 与 Run Registry 事实；未绑定节点沿用 DAG 临时参与者。
		const attemptTask = retryCount > 0 && lastGateResult
			? `${taskText}\n\nPrevious attempt failed quality gate:\n${lastGateResult.feedback}\n\nPlease fix the issues and retry.`
			: taskText;
		const remainingNodeCost = maxCostUsd === undefined ? undefined : Math.max(0, maxCostUsd - totalNodeCost);
		const result = node.agentId
			? await runAgentRecord(node.agentId, attemptTask, {
				cwd: opts.cwd,
				modelsConfig: opts.modelsConfig,
				telemetry: opts.telemetry,
				pricing: opts.pricing,
				sessionId: opts.sessionId,
				taskId: opts.taskId,
				executionId,
				sharedSkills: opts.sharedSkills,
				prefixLayout: opts.prefixLayout,
				defaultModel: opts.defaultModel,
				defaultProvider: opts.defaultProvider,
				deadlineAt: nodeDeadline,
				timeoutMs: undefined,
				maxCostUsd: remainingNodeCost,
				parentMaxCostUsd: opts.maxCostUsd,
				parentMaxTurns: opts.parentMaxTurns,
				parentMaxInputTokens: opts.parentMaxInputTokens,
				parentMaxParallel: opts.maxParallel,
				health: opts.health,
				lockFiles: node.files,
				invocationOverride: opts.invocationOverride,
			}, opts.signal, undefined, {
				role: node.role,
				sessionMode: node.sessionMode,
			})
			: await runAgent({
				cwd: opts.cwd,
				agent: agentDef,
				task: attemptTask,
				sessionId: opts.sessionId,
				telemetry: opts.telemetry,
				prefixLayout: opts.prefixLayout,
				model: agentDef.model,
				provider: agentDef.provider,
				pricing: opts.pricing,
				thinking: agentDef.thinking,
				deadlineAt: nodeDeadline,
				timeoutMs: undefined, // nodeDeadline 是所有重试/降级共享的绝对时限
				maxRetries: 1,                        // 底层自动重试 1 次
				retryDelayMs: 3000,
				persistent: opts.persistent ?? true,
				persistentSessionId: `flux-dag-${executionId}-${node.id}`,
				enableModelFallback: Object.keys(models).length > 1,
				modelsForFallback: models,
				roleRequirementForFallback: roleRequirement,
				signal: opts.signal,
				// A quality-gate retry or reviewer-triggered re-run is a new immutable Run
				// while agent.name and persistentSessionId preserve the logical DAG node.
				runId: createDAGRunId(executionId, node.id),
				maxCostUsd: remainingNodeCost,
				parentMaxCostUsd: opts.maxCostUsd,
				parentMaxTurns: opts.parentMaxTurns,
				parentMaxInputTokens: opts.parentMaxInputTokens,
				parentMaxParallel: opts.maxParallel,
				health: opts.health,
				taskId: opts.taskId,
				executionId,
				lockFiles: node.files,
				invocationOverride: opts.invocationOverride,
			});

		lastResult = result;
		if (result.fallbackFrom) {
			unavailableModels.add(result.fallbackFrom);
			dagLog(`[flux dag] circuit breaker opened for ${result.fallbackFrom}; fallback=${result.fallbackModel ?? result.model ?? "unknown"}`);
			// 同一节点后续的质量门/进程重试也必须沿用已经验证可用的模型，
			// 否则会再次命中刚刚熔断的 provider。
			const healthyModel = result.fallbackModel ?? result.model ?? undefined;
			if (healthyModel && healthyModel !== agentDef.model) {
				agentDef.model = healthyModel;
				agentDef.provider = models[healthyModel]?.provider ?? agentDef.provider;
			}
		}
		totalNodeCost += result.usage.cost;

		// 进程失败永远不能被 LLM gate 覆盖为成功。
		if (result.exitCode !== 0 || result.errorMessage) {
			if (opts.signal?.aborted || result.exitCode === 130) {
				return { node, result, gateResult: null, retryCount, passed: false, cost: totalNodeCost };
			}
			if (retryCount < maxRetries && (nodeDeadline === undefined || Date.now() < nodeDeadline)) {
				const reason = result.exitCode === 124 ? "timeout" : result.errorMessage ?? `exit ${result.exitCode}`;
				dagLog(`[flux dag] ${node.id} failed (${reason}), retrying ${retryCount + 1}/${maxRetries}`);
				retryCount++;
				continue;
			}
			return {
				node, result, gateResult: null, retryCount, passed: false, cost: totalNodeCost,
			};
		}

		// 质量门检查
		if (enableGate && node.acceptanceCriteria.length > 0) {
			if (nodeDeadline !== undefined && Date.now() >= nodeDeadline) {
				return {
					node,
					result: { ...result, exitCode: 124, errorMessage: `node explicit deadline (${nodeTimeoutMs === undefined ? "unknown" : `${nodeTimeoutMs / 1000}s`}) exhausted before quality gate` },
					gateResult: null, retryCount, passed: false, cost: totalNodeCost,
				};
			}
			// judge 独立配置优先；未配置显式 timeout 时只受取消和（如有）DAG deadline 控制。
			const gateCfg = opts.qualityGate;
			const gateModel = gateCfg?.model ?? result.model ?? agentDef.model ?? "";
			const gateProvider = gateCfg?.provider ?? (gateModel ? models[gateModel]?.provider ?? agentDef.provider : agentDef.provider);
			let gateAttempts = 0;
			for (;;) {
				gateAttempts++;
				lastGateResult = await checkQualityGate(
					result.output,
					node.acceptanceCriteria,
					{ cwd: opts.cwd, model: gateModel, provider: gateProvider, pricing: opts.pricing, telemetry: opts.telemetry, sessionId: opts.sessionId, signal: opts.signal, deadlineAt: nodeDeadline, timeoutMs: gateCfg?.timeoutMs },
				);
				totalNodeCost += lastGateResult.gateCost;

				const action = judgeAction(lastGateResult);
				if (action === "pass") {
					return { node, result, gateResult: lastGateResult, retryCount, passed: true, cost: totalNodeCost };
				}
				if (action === "retry_judge" && gateAttempts < 2) {
					dagLog(`[flux dag] ${node.id} gate judge indeterminate (${lastGateResult.feedback.slice(0, 80)}), retrying judge ${gateAttempts + 1}/2`);
					continue;
				}
				if (action === "retry_judge") {
					// 关键 verdict 不可判定时必须失败关闭；不能把 indeterminate 改写成成功。
					// 节点本体可能已经 exit=0，但没有明确质量门 pass 就不能释放后续节点。
					dagLog(`[flux dag] ${node.id} gate judge unavailable after ${gateAttempts} attempts (${lastGateResult.feedback.slice(0, 100)}); failing closed without verdict`);
					return {
						node, result,
						gateResult: lastGateResult,
						retryCount, passed: false, cost: totalNodeCost,
					};
				}
				break; // retry_node: criteria 明确不满足, 走节点重试
			}

			dagLog(`[flux dag] ${node.id} gate failed (attempt ${retryCount + 1}/${maxRetries + 1}): ${lastGateResult.feedback.slice(0, 100)}`);
			retryCount++;
			continue;
		}

		// 无质量门或无 criteria: 检查 exitCode
		return {
			node, result, gateResult: null,
			retryCount,
			passed: result.exitCode === 0,
			cost: totalNodeCost,
		};
	}

	// 达到最大重试次数
	return {
		node, result: lastResult!, gateResult: lastGateResult,
		retryCount, passed: false, cost: totalNodeCost,
	};
}

// ─── 格式化 ───

export function formatDAG(dag: TaskDAG): string {
	const lines = [`[Task DAG: ${dag.nodes.length} nodes]`, `  Description: ${dag.description.slice(0, 200)}`, ""];
	for (const node of dag.nodes) {
		const deps = node.dependsOn.length > 0 ? ` ← [${node.dependsOn.join(", ")}]` : "";
		const par = node.parallelizable ? " ∥" : "";
		lines.push(`  ${node.id}: ${node.title} (${node.role}${node.agentId ? ` @${node.agentId}${node.sessionMode === "fresh" ? ":fresh" : ""}` : ""})${deps}${par}`);
		if (node.acceptanceCriteria.length > 0) {
			lines.push(`    criteria: ${node.acceptanceCriteria.join("; ")}`);
		}
	}
	return lines.join("\n");
}
export function formatDAGResult(r: DAGExecutionResult): string {
	const lines = [
		`[DAG Execution: ${r.status.toUpperCase()}]`,
		`  run ${r.executionId} · wall ${(r.wallClockMs / 1000).toFixed(1)}s · cost $${r.totalCost.toFixed(6)}`,
		`  completed: ${r.completedNodes.join(", ") || "(none)"}`,
		`  failed: ${r.failedNodes.join(", ") || "(none)"}`,
	];
	for (const [id, tr] of r.taskResults) {
		const gateIcon = tr.gateResult ? (tr.gateResult.passed ? "✅" : "❌") : "—";
		const retryInfo = tr.retryCount > 0 ? ` (retries=${tr.retryCount})` : "";
		lines.push(`  ${id}: ${gateIcon} ${tr.node.title}${retryInfo} · $${tr.subagentResult.usage.cost.toFixed(6)}`);
		if (tr.gateResult && !tr.gateResult.passed) {
			lines.push(`    gate feedback: ${tr.gateResult.feedback.slice(0, 150)}`);
		}
		if (r.artifactPaths[id]) lines.push(`    artifact: ${r.artifactPaths[id]}`);
	}
	return lines.join("\n");
}

/** Emoji map for each DAG execution status. */
const STATUS_EMOJI: Record<string, string> = {
	passed: "✅",
	failed: "❌",
	cancelled: "🚫",
	budget_exceeded: "💰",
	timed_out: "⏰",
};

/**
 * Format a concise Markdown summary of a DAG execution result.
 *
 * Output includes:
 * - Overall status line with emoji
 * - Execution wall-clock time & optional time label
 * - Total USD cost
 * - Node count breakdown (passed vs failed)
 * - Run ID
 *
 * If @p timeLabel is empty or blank, "(not provided)" is shown instead.
 */
function formatWallClock(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}min ${seconds}s`;
}

export function formatWorkflowSummary(r: DAGExecutionResult, timeLabel?: string): string {
	const label = timeLabel && timeLabel.trim() ? timeLabel.trim() : "(not provided)";
	const emoji = STATUS_EMOJI[r.status] ?? "❓";
	const statusBadge = `\`${r.status.toUpperCase()}\``;
	const wallTime = formatWallClock(r.wallClockMs);
	const cost = `$${r.totalCost.toFixed(6)}`;
	const passedCount = r.completedNodes.length;
	const failedCount = r.failedNodes.length;
	const totalCount = passedCount + failedCount;

	let summary = [
		"## Workflow Execution Summary",
		"",
		`${emoji} **Status:** ${statusBadge}`,
		`**Time:** ${label} · Wall Clock: ${wallTime}`,
		`**Cost:** ${cost}`,
		`**Nodes:** ${passedCount} passed / ${failedCount} failed / ${totalCount} total`,
		`**Run ID:** \`${r.executionId}\``,
	].join("\n");

	// Passed nodes table (only when there are passed nodes)
	if (r.completedNodes.length > 0 && r.taskResults.size > 0) {
		const showArtifact = Object.keys(r.artifactPaths).length > 0;
		const header = showArtifact
			? "| ID | Title | Role | Retries | Cost | Artifact |"
			: "| ID | Title | Role | Retries | Cost |";
		const separator = showArtifact
			? "|----|-------|------|---------|------|----------|"
			: "|----|-------|------|---------|------|";
		const rows: string[] = [];
		for (const id of r.completedNodes) {
			const tr = r.taskResults.get(id);
			if (!tr) continue;
			const title = tr.node.title || id;
			const role = tr.node.role;
			const retries = String(tr.retryCount);
			const nodeCost = `$${tr.subagentResult.usage.cost.toFixed(6)}`;
			const artifact = r.artifactPaths[id]
				? r.artifactPaths[id].split(/[/\\]/).pop() ?? r.artifactPaths[id]
				: "—";
			if (showArtifact) {
				rows.push(`| ${id} | ${title} | ${role} | ${retries} | ${nodeCost} | ${artifact} |`);
			} else {
				rows.push(`| ${id} | ${title} | ${role} | ${retries} | ${nodeCost} |`);
			}
		}
		if (rows.length > 0) {
			summary += "\n\n### ✅ Passed\n" + [header, separator, ...rows].join("\n");
		}
	}

	// Failed nodes table (only when there are failed nodes)
	if (r.failedNodes.length > 0 && r.taskResults.size > 0) {
		const rows: string[] = [];
		for (const id of r.failedNodes) {
			const tr = r.taskResults.get(id);
			if (!tr) {
				rows.push(`| ${id} | ${id} | ? | _(no details)_ |`);
				continue;
			}
			const title = tr.node.title || id;
			const role = tr.node.role;
			const errMsg = tr.subagentResult.errorMessage
				? tr.subagentResult.errorMessage.slice(0, 80)
				: "(no details)";
			rows.push(`| ${id} | ${title} | ${role} | ${errMsg} |`);
		}
		if (rows.length > 0) {
			summary += "\n\n### ❌ Failed\n"
				+ ["| ID | Title | Role | Error |", "|----|-------|------|-------|", ...rows].join("\n");
		}
	}

	return summary;
}
