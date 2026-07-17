/**
 * AgentFlux M5-1/M5-2 — 动态任务分解 + DAG 执行器
 * 文档依据: docs/22-mode-capability-roadmap.md M5 增强
 *
 * M5-1: planner 输出结构化任务 DAG (JSON), 不是纯文本 handoff
 * M5-2: DAG 执行器按拓扑序执行, 独立节点并行
 * M5-3: 条件分支 (review 失败 → 回 implementer 修复)
 * M5-4: 质量门 (acceptance criteria 检查, 不通过自动重试)
 * M5-5: 管道中断/恢复 (保存执行状态到黑板)
 */

import { runSubagent, type SubagentDef, type SubagentRunResult } from "./subagent";
import { checkQualityGate, type QualityGateResult } from "./quality-gate";
import type { TelemetryWriter } from "../telemetry/events";
import type { PricingTable } from "../core/pricing";
import { assignModel, rankModels, type ModelEntry, type RoleRequirement } from "../core/model-capability";
import { loadAllRoles, type RoleDefinition } from "../core/role-manager";
import { SharedBoard } from "../core/shared-board";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

// ─── 类型定义 ───

export interface TaskNode {
	id: string;
	title: string;
	role: string;               // planner | implementer | reviewer | tester
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
export function boundedNodeTimeout(configuredTimeoutMs: number | undefined, dagDeadlineMs: number, nowMs = Date.now()): number {
	return Math.max(1, Math.min(configuredTimeoutMs ?? Number.MAX_SAFE_INTEGER, dagDeadlineMs - nowMs));
}

export interface TaskExecutionResult {
	node: TaskNode;
	subagentResult: SubagentRunResult;
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

// ─── M5-1: 动态任务分解 ───

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
		pricing?: PricingTable;
		models?: Record<string, ModelEntry>;
		telemetry?: TelemetryWriter;
		sessionId: string;
		prefixLayout: boolean;
		signal?: AbortSignal;
		maxCostUsd?: number;
		timeoutMs?: number;
	},
): Promise<TaskDAG> {
	const plannerAgent: SubagentDef = {
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
- Use roles: "planner", "implementer", "reviewer", "tester"
- dependsOn lists task IDs that must complete before this task
- parallelizable=true means this task can run alongside other parallelizable tasks
- acceptanceCriteria are verifiable conditions
- files lists the files this task will touch (for conflict detection)
- Use forward slashes in every file path, including on Windows
- Keep it minimal: 2-5 nodes for most tasks
- The last node should usually be a "reviewer" or "tester" that validates the work`,
		thinking: "high",
	};

	const result = await runSubagent({
		cwd: opts.cwd,
		agent: plannerAgent,
		task: `Analyze this task and decompose it into a structured DAG:\n\n${task}`,
		sessionId: opts.sessionId,
		telemetry: opts.telemetry,
		prefixLayout: opts.prefixLayout,
		model: opts.model,
		provider: opts.provider,
		pricing: opts.pricing,
		thinking: "high",
		maxRetries: 1,
		retryDelayMs: 2000,
		enableModelFallback: !!opts.models && Object.keys(opts.models).length > 1,
		modelsForFallback: opts.models,
		roleRequirementForFallback: ROLE_FALLBACK_REQUIREMENTS.planner,
		signal: opts.signal,
		maxCostUsd: opts.maxCostUsd,
		timeoutMs: opts.timeoutMs,
	});

	if (result.exitCode !== 0 || result.errorMessage || !result.output.trim()) {
		throw new Error(`DAG planner failed: ${result.errorMessage ?? `exit ${result.exitCode} with no output`}`);
	}

	try {
		return parsePlannerTaskDAG(result.output, task, result.usage.cost);
	} catch (error: unknown) {
		console.error(`[flux dag] planner output parse failed: ${error instanceof Error ? error.message : String(error)}`);
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
			role: typeof node.role === "string" && ["planner", "implementer", "reviewer", "tester"].includes(node.role) ? node.role : "implementer",
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
		if (!node.id || ids.has(node.id)) throw new Error(`invalid DAG: duplicate/empty node id '${node.id}'`);
		ids.add(node.id);
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

// ─── M5-2: DAG 执行器 ───

export interface DAGExecutorOptions {
	cwd: string;
	fluxDir: string;
	modelsConfig: any;
	telemetry: TelemetryWriter;
	prefixLayout: boolean;
	pricing?: PricingTable;
	sessionId: string;
	sharedSkills?: string[];
	maxRetries?: number;       // M5-4: 质量门不通过时最大重试次数 (默认 2)
	enableQualityGate?: boolean; // M5-4: 是否启用质量门 (默认 true)
	timeoutMs?: number;        // 每个 subagent 超时 (默认 180000 = 3min)
	persistent?: boolean;      // M5-persist: 是否保留 agent session 上下文 (默认 true)
	signal?: AbortSignal;      // 用户取消时传播到每个真实子进程
	maxCostUsd?: number;       // 步骤之间硬停止；单次 provider 请求可能产生少量超额
	maxWallClockMs?: number;   // 整个 DAG 的 wall-clock 上限
	maxIterations?: number;    // 全局节点执行批次数上限
	maxParallel?: number;      // 并发节点上限
	executionId?: string;      // 显式 run id；也用于断点文件
	resume?: boolean;          // 从同 executionId 的 checkpoint 恢复
}

/**
 * 按拓扑序执行 DAG, 独立节点并行 (M5-2).
 * 支持质量门和自动重试 (M5-4).
 * 支持条件分支: review 失败 → 回 implementer (M5-3).
 */
export async function executeDAG(
	dag: TaskDAG,
	opts: DAGExecutorOptions,
): Promise<DAGExecutionResult> {
	validateTaskDAG(dag.nodes);
	const maxRetries = opts.maxRetries ?? 2;
	const enableGate = opts.enableQualityGate ?? true;
	const wallStart = Date.now();
	const deadline = wallStart + Math.max(1, opts.maxWallClockMs ?? Number.MAX_SAFE_INTEGER);
	const taskResults = new Map<string, TaskExecutionResult>();
	const completed = new Set<string>();
	const failed = new Set<string>();
	let totalCost = dag.planningCostUsd ?? 0;
	let status: DAGExecutionResult["status"] | "running" = "running";
	let iterationCount = 0;
	const executionId = opts.executionId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const artifactPaths: Record<string, string> = {};

	// 加载角色定义
	const roles = loadAllRoles(opts.cwd, opts.modelsConfig);
	const models = opts.modelsConfig?.models ?? {};
	const board = new SharedBoard(opts.fluxDir);
	// 本次 DAG 内的 model/provider 熔断记忆：一次明确降级后，后续批次不再重复撞同一故障模型。
	const unavailableModels = new Set<string>();

	const rerunCount = new Map<string, number>(); // M5-3 防无限循环: 每个 implementer 最多被重跑 1 次
	const reviewFeedback = new Map<string, string>();
	const runtimeDir = join(opts.fluxDir, "runtime");
	const runDir = join(runtimeDir, "runs", executionId);
	const artifactDir = join(runDir, "artifacts");
	const dagStateFile = join(runDir, "checkpoint.json");
	const latestStateFile = join(runtimeDir, "dag-state.json");
	try { mkdirSync(artifactDir, { recursive: true }); } catch {}

	function saveDagState(): void {
		const state = {
			executionId,
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

	if (opts.resume && existsSync(dagStateFile)) {
		const checkpoint = JSON.parse(readFileSync(dagStateFile, "utf-8"));
		if (JSON.stringify(checkpoint.nodeIds) !== JSON.stringify(dag.nodes.map(node => node.id))) {
			throw new Error(`checkpoint ${executionId} does not match current DAG`);
		}
		for (const id of checkpoint.completed ?? []) completed.add(id);
		for (const id of checkpoint.failed ?? []) failed.add(id);
		for (const [id, result] of checkpoint.taskResults ?? []) taskResults.set(id, result);
		Object.assign(artifactPaths, checkpoint.artifactPaths ?? {});
		totalCost = Number(checkpoint.totalCost ?? totalCost);
		iterationCount = Number(checkpoint.iterationCount ?? 0);
	}

	// 先写入本次 DAG，避免监控面板在首批节点完成前继续显示上一次执行。
	saveDagState();

	// 主循环: 按拓扑序执行
	while (completed.size + failed.size < dag.nodes.length) {
		if (opts.signal?.aborted) { status = "cancelled"; break; }
		if (Date.now() >= deadline) { status = "timed_out"; break; }
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
			console.error(`[flux dag] deadlock: remaining=${remaining.map(n => n.id).join(",")}`);
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
			const canJoinBatch = ready.length === 0
				|| (node.parallelizable && ready.every(other => other.parallelizable) && !conflicts);
			if (!canJoinBatch) continue;
			ready.push(node);
			for (const file of normalizedFiles) batchFiles.add(file);
		}

		// 并行执行就绪任务
		console.error(`[flux dag] executing ${ready.length} task(s): ${ready.map(n => n.id).join(", ")}`);

		// M5-shared: 更新 SharedBoard 状态供 /flux status 查看
		for (const node of ready) {
			try {
				board.updateAgentStatus(`dag-${node.id}`, {
					status: "running",
					workingOn: node.title.slice(0, 100),
				});
			} catch {}
		}

		// 并行执行就绪任务 (用 allSettled 防止单个节点 throw 导致整批丢失)
		const remainingBudget = opts.maxCostUsd === undefined ? undefined : Math.max(0, opts.maxCostUsd - totalCost);
		const perNodeBudget = remainingBudget === undefined ? undefined : remainingBudget / ready.length;
		const batchOpts: DAGExecutorOptions = { ...opts, timeoutMs: boundedNodeTimeout(opts.timeoutMs, deadline) };
		const batchSettled = await Promise.allSettled(
			ready.map(node => executeNodeWithGate(
				node, roles, models, batchOpts, maxRetries, enableGate, executionId,
				taskResults, unavailableModels, reviewFeedback.get(node.id), perNodeBudget,
			))
		);

		const batchResults: Array<{ node: TaskNode; result: SubagentRunResult; gateResult: QualityGateResult | null; retryCount: number; passed: boolean; cost: number }> = [];
		for (let i = 0; i < batchSettled.length; i++) {
			const s = batchSettled[i];
			if (s.status === "fulfilled") {
				batchResults.push(s.value);
			} else {
				// executeNodeWithGate threw (spawn error, unexpected exception)
				const node = ready[i];
				console.error(`[flux dag] ${node.id} threw exception: ${s.reason?.message ?? s.reason}`);
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
				const artifactPath = join(artifactDir, `${node.id}.md`);
				writeFileSync(artifactPath, result.output || `(no output)\n\nError: ${result.errorMessage ?? "unknown"}`, "utf-8");
				artifactPaths[node.id] = artifactPath;
			} catch {}

			if (passed) {
				completed.add(node.id);
				console.error(`[flux dag] ${node.id} ✅ passed (retries=${retryCount}, cost=$${cost.toFixed(6)})`);
				try { board.updateAgentStatus(`dag-${node.id}`, { status: "done", workingOn: node.title.slice(0, 100) }); } catch {}
			} else {
				failed.add(node.id);
				console.error(`[flux dag] ${node.id} ❌ failed after ${retryCount} retries`);
				try { board.updateAgentStatus(`dag-${node.id}`, { status: "failed", workingOn: node.title.slice(0, 100) }); } catch {}

				// M5-3: 如果 reviewer 失败, 检查是否有对应 implementer 可以重试 (限 1 次防无限循环)
				if (node.role === "reviewer" && node.dependsOn.length > 0) {
					const implId = findUpstreamImplementer(node, dag);
					if (implId && completed.has(implId) && (rerunCount.get(implId) ?? 0) < 1) {
						rerunCount.set(implId, (rerunCount.get(implId) ?? 0) + 1);
						console.error(`[flux dag] M5-3: reviewer failed, re-running implementer ${implId} (attempt ${rerunCount.get(implId)})`);
						failed.delete(node.id); // reviewer 在 implementer 修复后必须重新进入队列
						completed.delete(implId); // 重新执行 implementer
						reviewFeedback.set(implId, gateResult?.feedback ?? result.output ?? result.errorMessage ?? "review failed");
						try { board.updateAgentStatus(`dag-${implId}`, { status: "running", workingOn: "re-run (reviewer failed)" }); } catch {}
					} else if (implId && completed.has(implId)) {
						console.error(`[flux dag] M5-3: ${implId} already re-run once, not retrying again`);
					}
				}
			}
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
): Promise<{ node: TaskNode; result: SubagentRunResult; gateResult: QualityGateResult | null; retryCount: number; passed: boolean; cost: number }> {
	const role = roles.get(node.role);
	if (!role) {
		console.error(`[flux dag] role ${node.role} not found, using implementer`);
	}

	// 用 assignModel 选模型 (优先 role.model 指定, 否则亲和度匹配)
	let assignedModel: string | undefined;
	let assignedProvider: string | undefined;
	const roleRequirement = (role?.requirement as RoleRequirement | undefined)
		?? ROLE_FALLBACK_REQUIREMENTS[node.role]
		?? { coding: 0.5, reasoning: 0.5, cost_eff: 0.5 };
	try {
		const assign = assignModel(node.role, { model: role?.model, requirement: role?.requirement }, models);
		assignedModel = assign.model;
		assignedProvider = models[assign.model]?.provider;
		if (unavailableModels.has(assignedModel)) {
			const healthyFallback = selectHealthyModel(assignedModel, roleRequirement, models, unavailableModels);
			console.error(`[flux dag] ${node.id} circuit breaker skips ${assignedModel} → ${healthyFallback}`);
			assignedModel = healthyFallback;
			assignedProvider = models[healthyFallback]?.provider;
		}
		console.error(`[flux dag] ${node.id} model: ${assignedModel} (${assign.source}${assignedModel !== assign.model ? ", circuit-breaker fallback" : ""})`);
	} catch (e: any) {
		console.error(`[flux dag] ${node.id} assignModel failed: ${e?.message}, using role.model`);
		assignedModel = role?.model;
		assignedProvider = role?.model ? models[role.model]?.provider : undefined;
	}

	// 构建 agent 定义
	const agentDef: SubagentDef = {
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
	let lastResult: SubagentRunResult | null = null;
	let lastGateResult: QualityGateResult | null = null;
	let totalNodeCost = 0;
	const nodeTimeoutMs = Math.max(1, opts.timeoutMs ?? 180000);
	const nodeDeadline = Date.now() + nodeTimeoutMs;

	while (retryCount <= maxRetries) {
		if (opts.signal?.aborted) {
			return {
				node,
				result: lastResult ?? { agent: agentDef.name, exitCode: 130, output: "", usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: totalNodeCost, contextTokens: 0 }, model: null, errorMessage: "cancelled" },
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
		// 执行 subagent
		const attemptTask = retryCount > 0 && lastGateResult
			? `${taskText}\n\nPrevious attempt failed quality gate:\n${lastGateResult.feedback}\n\nPlease fix the issues and retry.`
			: taskText;

		const result = await runSubagent({
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
			timeoutMs: Math.max(1, nodeDeadline - Date.now()), // 所有重试/降级共享节点总时限
			maxRetries: 1,                        // 底层自动重试 1 次
			retryDelayMs: 3000,
			persistent: opts.persistent ?? true,  // M5-persist: 默认保留 session
			persistentSessionId: `flux-dag-${executionId}-${node.id}`,
			enableModelFallback: Object.keys(models).length > 1,
			modelsForFallback: models,
			roleRequirementForFallback: roleRequirement,
			signal: opts.signal,
			runId: `${executionId}:${node.id}`,
			maxCostUsd: maxCostUsd === undefined ? undefined : Math.max(0, maxCostUsd - totalNodeCost),
			lockFiles: node.files,
		});

		lastResult = result;
		if (result.fallbackFrom) {
			unavailableModels.add(result.fallbackFrom);
			console.error(`[flux dag] circuit breaker opened for ${result.fallbackFrom}; fallback=${result.fallbackModel ?? result.model ?? "unknown"}`);
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
			if (retryCount < maxRetries && Date.now() < nodeDeadline) {
				const reason = result.exitCode === 124 ? "timeout" : result.errorMessage ?? `exit ${result.exitCode}`;
				console.error(`[flux dag] ${node.id} failed (${reason}), retrying ${retryCount + 1}/${maxRetries}`);
				retryCount++;
				continue;
			}
			return {
				node, result, gateResult: null, retryCount, passed: false, cost: totalNodeCost,
			};
		}

		// M5-4: 质量门检查
		if (enableGate && node.acceptanceCriteria.length > 0) {
			if (Date.now() >= nodeDeadline) {
				return {
					node,
					result: { ...result, exitCode: 124, errorMessage: `node timeout (${nodeTimeoutMs / 1000}s) exhausted before quality gate` },
					gateResult: null, retryCount, passed: false, cost: totalNodeCost,
				};
			}
			const actualModel = result.model ?? agentDef.model;
			lastGateResult = await checkQualityGate(
				result.output,
				node.acceptanceCriteria,
				{ cwd: opts.cwd, model: actualModel ?? undefined, provider: actualModel ? models[actualModel]?.provider ?? agentDef.provider : agentDef.provider, pricing: opts.pricing, telemetry: opts.telemetry, sessionId: opts.sessionId, signal: opts.signal },
			);
			totalNodeCost += lastGateResult.gateCost;

			if (lastGateResult.passed) {
				return { node, result, gateResult: lastGateResult, retryCount, passed: true, cost: totalNodeCost };
			}

			console.error(`[flux dag] ${node.id} gate failed (attempt ${retryCount + 1}/${maxRetries + 1}): ${lastGateResult.feedback.slice(0, 100)}`);
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
		lines.push(`  ${node.id}: ${node.title} (${node.role})${deps}${par}`);
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
