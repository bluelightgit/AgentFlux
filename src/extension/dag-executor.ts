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
import { assignModel, type ModelEntry, type RoleRequirement } from "../core/model-capability";
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
}

export interface TaskExecutionResult {
	node: TaskNode;
	subagentResult: SubagentRunResult;
	gateResult: QualityGateResult | null;  // 质量门结果 (null=未检查)
	retryCount: number;         // 重试次数
	passed: boolean;            // 是否通过 (gate 通过或无 gate)
}

export interface DAGExecutionResult {
	taskResults: Map<string, TaskExecutionResult>;
	allPassed: boolean;
	totalCost: number;
	wallClockMs: number;
	completedNodes: string[];
	failedNodes: string[];
}

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
		telemetry?: TelemetryWriter;
		sessionId: string;
		prefixLayout: boolean;
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
	});

	// 解析 JSON DAG
	try {
		const jsonMatch = result.output.match(/```json\s*([\s\S]*?)```/) || result.output.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse((jsonMatch[1] || jsonMatch[0]).trim());
			if (parsed.nodes && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
				// 验证和清理
				const nodes: TaskNode[] = parsed.nodes.map((n: any, i: number) => ({
					id: n.id || `t${i + 1}`,
					title: n.title || `Task ${i + 1}`,
					role: ["planner", "implementer", "reviewer", "tester"].includes(n.role) ? n.role : "implementer",
					dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn : [],
					parallelizable: n.parallelizable ?? false,
					acceptanceCriteria: Array.isArray(n.acceptanceCriteria) ? n.acceptanceCriteria : [],
					files: Array.isArray(n.files) ? n.files : [],
					description: n.description,
				}));
				return { nodes, description: parsed.description || task };
			}
		}
	} catch (e: any) {
		console.error(`[flux dag] planner output parse failed: ${e?.message}`);
	}

	// 回退: 单节点 DAG
	console.error("[flux dag] falling back to single-node DAG");
	return {
		description: task,
		nodes: [{
			id: "t1",
			title: "Execute task",
			role: "implementer",
			dependsOn: [],
			parallelizable: false,
			acceptanceCriteria: [],
			files: [],
			description: task,
		}],
	};
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
	const maxRetries = opts.maxRetries ?? 2;
	const enableGate = opts.enableQualityGate ?? true;
	const wallStart = Date.now();
	const taskResults = new Map<string, TaskExecutionResult>();
	const completed = new Set<string>();
	const failed = new Set<string>();
	let totalCost = 0;

	// 加载角色定义
	const roles = loadAllRoles(opts.cwd, opts.modelsConfig);
	const models = opts.modelsConfig?.models ?? {};
	const board = new SharedBoard(opts.fluxDir);

	const rerunCount = new Map<string, number>(); // M5-3 防无限循环: 每个 implementer 最多被重跑 1 次
	const dagStateFile = join(opts.fluxDir, "runtime", "dag-state.json");
	try { mkdirSync(join(opts.fluxDir, "runtime"), { recursive: true }); } catch {}

	function saveDagState(): void {
		const state = {
			description: dag.description,
			completed: [...completed],
			failed: [...failed],
			timestamp: Date.now(),
		};
		try { writeFileSync(dagStateFile, JSON.stringify(state, null, 2)); } catch {}
	}

	// 主循环: 按拓扑序执行
	while (completed.size + failed.size < dag.nodes.length) {
		// 找出所有依赖已完成的就绪任务
		const ready = dag.nodes.filter(n =>
			!completed.has(n.id) &&
			!failed.has(n.id) &&
			n.dependsOn.every(d => completed.has(d))
		);

		if (ready.length === 0) {
			// 死锁检测
			const remaining = dag.nodes.filter(n => !completed.has(n.id) && !failed.has(n.id));
			console.error(`[flux dag] deadlock: remaining=${remaining.map(n => n.id).join(",")}`);
			for (const n of remaining) failed.add(n.id);
			break;
		}

		// 并行执行就绪任务
		console.error(`[flux dag] executing ${ready.length} task(s): ${ready.map(n => n.id).join(", ")}`);

		// M5-shared: 更新 SharedBoard 状态供 /flux status 查看
		for (const node of ready) {
			try {
				board.updateAgentStatus(`dag-${node.id}`, {
					status: "running",
					role: node.role,
					workingOn: node.title.slice(0, 100),
				});
			} catch {}
		}

		// 并行执行就绪任务 (用 allSettled 防止单个节点 throw 导致整批丢失)
		const batchSettled = await Promise.allSettled(
			ready.map(node => executeNodeWithGate(node, roles, models, opts, maxRetries, enableGate))
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
					const implId = node.dependsOn[0];
					if (completed.has(implId) && (rerunCount.get(implId) ?? 0) < 1) {
						rerunCount.set(implId, (rerunCount.get(implId) ?? 0) + 1);
						console.error(`[flux dag] M5-3: reviewer failed, re-running implementer ${implId} (attempt ${rerunCount.get(implId)})`);
						completed.delete(implId); // 重新执行 implementer
						try { board.updateAgentStatus(`dag-${implId}`, { status: "running", workingOn: "re-run (reviewer failed)" }); } catch {}
					} else if (completed.has(implId)) {
						console.error(`[flux dag] M5-3: ${implId} already re-run once, not retrying again`);
					}
				}
			}
		}

		saveDagState();
	}

	const wallClockMs = Date.now() - wallStart;
	const allPassed = failed.size === 0;

	return {
		taskResults, allPassed, totalCost: Number(totalCost.toFixed(6)),
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
): Promise<{ node: TaskNode; result: SubagentRunResult; gateResult: QualityGateResult | null; retryCount: number; passed: boolean; cost: number }> {
	const role = roles.get(node.role);
	if (!role) {
		console.error(`[flux dag] role ${node.role} not found, using implementer`);
	}

	// 用 assignModel 选模型 (优先 role.model 指定, 否则亲和度匹配)
	let assignedModel: string | undefined;
	let assignedProvider: string | undefined;
	try {
		const assign = assignModel(node.role, { model: role?.model, requirement: role?.requirement }, models);
		assignedModel = assign.model;
		assignedProvider = models[assign.model]?.provider;
		console.error(`[flux dag] ${node.id} model: ${assign.model} (${assign.source})`);
	} catch (e: any) {
		console.error(`[flux dag] ${node.id} assignModel failed: ${e?.message}, using role.model`);
		assignedModel = role?.model;
		assignedProvider = role?.model ? models[role.model]?.provider : undefined;
	}

	// 构建 agent 定义
	const agentDef: SubagentDef = {
		name: `dag-${node.id}`,
		description: role?.description ?? node.title,
		tools: role?.tools,
		model: assignedModel,
		provider: assignedProvider,
		systemPrompt: role?.systemPrompt ?? `You are a ${node.role}.`,
		thinking: role?.thinking,
		skills: [...(opts.sharedSkills ?? []), ...(role?.skills ?? [])].length > 0
			? [...(opts.sharedSkills ?? []), ...(role?.skills ?? [])] : undefined,
	};

	const taskText = node.description || node.title;
	let retryCount = 0;
	let lastResult: SubagentRunResult | null = null;
	let lastGateResult: QualityGateResult | null = null;
	let totalNodeCost = 0;

	while (retryCount <= maxRetries) {
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
			timeoutMs: opts.timeoutMs ?? 180000,   // DAG 节点默认 3min
			maxRetries: 1,                        // 底层自动重试 1 次
			retryDelayMs: 3000,
			persistent: opts.persistent ?? true,  // M5-persist: 默认保留 session
		});

		lastResult = result;
		totalNodeCost += result.usage.cost;

		// 超时/进程失败且无质量门 → 上层重试
		if ((result.exitCode !== 0 || result.errorMessage) && (!enableGate || node.acceptanceCriteria.length === 0)) {
			if (retryCount < maxRetries) {
				const reason = result.exitCode === 124 ? "timeout" : `exit ${result.exitCode}`;
				console.error(`[flux dag] ${node.id} failed (${reason}), retrying ${retryCount + 1}/${maxRetries}`);
				retryCount++;
				continue;
			}
			return {
				node, result, gateResult: null, retryCount, passed: false, cost: totalNodeCost,
			};
		}

		// M5-4: 质量门检查
		if (enableGate && node.acceptanceCriteria.length > 0 && result.output) {
			lastGateResult = await checkQualityGate(
				result.output,
				node.acceptanceCriteria,
				{ cwd: opts.cwd, model: opts.model, provider: opts.provider, pricing: opts.pricing, telemetry: opts.telemetry, sessionId: opts.sessionId },
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
		`[DAG Execution: ${r.allPassed ? "ALL PASSED" : `${r.failedNodes.length} FAILED`}]`,
		`  wall ${(r.wallClockMs / 1000).toFixed(1)}s · cost $${r.totalCost.toFixed(6)}`,
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
	}
	return lines.join("\n");
}
