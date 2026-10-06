/**
 * 统一的一次性/持久 Agent 执行入口。
 * Pi 提供模型、原生会话、工具与缓存；Core 负责权限、预算、消息和真实进程事实。
 * 子入口始终加载安全/Message V2/settle hooks，与可选缓存布局独立。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import type { PricingTable } from "../core/pricing";
import { UsageAccounting } from "../core/usage-accounting";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { resolveSessionFileById } from "./agent-session-fork";
import { observeProcessAsync, type ProcessIdentity } from "../core/process-identity";
import { parseFrontmatter } from "./templates";
import type { TelemetryWriter } from "../telemetry/events";
import type { ModelEntry, RoleRequirement } from "../core/model-capability";
import { rankModels } from "../core/model-capability";
import { SharedBoard } from "../core/shared-board";
import { MessageBus } from "../core/message-bus";
import {
	communicationPolicyFromFrontmatter, evaluateCommunicationContract,
	formatCommunicationContractInstruction,
	type CommunicationContractReport, type CommunicationPolicyInput,
} from "../core/communication-policy";
import {
	loadEffectiveCapabilitySnapshot, loadRegisteredCapabilityOverride, loadRegisteredCapabilityOverrideForRole, resolveCapabilityPolicy, writeEffectiveCapabilitySnapshot,
	type CapabilityPolicyInput, type WorkspaceCapabilityInput,
} from "../core/capability-policy";
import { createEphemeralRecord, finishEphemeralRecord, startEphemeralRecord } from "./agent-lifecycle";
import { clearAgentRunStop, readAgentRunStop } from "./agent-run-control";
import {
	finishAgentRun,
	heartbeatAgentRun,
	markAgentRunRunning,
	markSdkAgentRunRunning,
	bindAgentRunProcessIdentity,
	markAgentRunStopRequested,
	registerAgentRun,
	listAgentRuns,
	updateAgentRunHealth,
	updateAgentRunSnapshot,
	type AgentRunHealthUpdate,
	type AgentRunParentBudget,
	type AgentRunSnapshot,
} from "../core/run-registry";
import { normalizeOptionalDurationMs, remainingDuration } from "../core/deadline";
import { getTaskExecution } from "../core/task-registry";
import { assessRunHealth, DEFAULT_RUN_HEALTH_CONFIG, shouldEmitHealthWarning, type AgentRunHealth, type RunHealthConfig } from "../core/run-health";
import { ensureCapabilityForkSession } from "./agent-session-fork";
import { loadConfig, loadSubagentRuntime } from "../core/config";
import { getPiSdkHost, requirePiSdkHost, type PiSdkHostBinding } from "../core/pi-sdk";
import { activateSdkRunOwner, createSdkRunOwner, retireSdkRunOwner, type SdkRunOwner } from "../core/runtime-owner";
import { registerActiveContext, releaseActiveContext, readActiveContext } from "../core/active-context";
import { createSdkRunDriver, type SdkRunDriver } from "./sdk-run-driver";
import { resolvePiInvocation, type PiInvocationDescriptor, type PiInvocationOverride } from "../core/pi-runtime";
import { IncrementalJsonlParser, usageCountersFromJson, type JsonlStreamIssue } from "../core/jsonl-stream";

// ──────────────────────────────── Parallel Agents ────────────────────────────────

export interface ParallelAgentTask {
	agent: AgentTemplate;
	task: string;
	label?: string;             // 可选标签, 用于结果区分 (默认用 agent.name)
	workspaceCwd?: string;      // 子进程实际工作区；AgentFlux 状态仍写入 common.cwd
	lockFiles?: string[];       // 相对路径以 workspaceCwd 为基准
	model?: string;
	provider?: string;
	thinking?: AgentTemplate["thinking"];
	maxTurns?: number;
	maxInputTokens?: number;
	completionProof?: AgentCompletionProof;
}

export interface AgentCompletionProof {
	files: Array<{
		path: string;
		contains?: string[];
	}>;
}

export interface AgentCompletionProofReport {
	passed: boolean;
	checkedFiles: string[];
	failures: string[];
}

export function evaluateAgentCompletionProof(workspaceCwd: string, proof: AgentCompletionProof): AgentCompletionProofReport {
	const root = resolve(workspaceCwd);
	const checkedFiles: string[] = [];
	const failures: string[] = [];
	const files = Array.isArray(proof?.files) ? proof.files : [];
	for (const item of files) {
		const path = resolve(root, item.path);
		const rel = relative(root, path);
		if (rel === ".." || rel.startsWith(`..${sep}`)) {
			failures.push(`proof path outside workspace: ${item.path}`);
			continue;
		}
		checkedFiles.push(path);
		if (!existsSync(path)) {
			failures.push(`proof file missing: ${item.path}`);
			continue;
		}
		const required = item.contains ?? [];
		if (required.length === 0) continue;
		let content = "";
		try { content = readFileSync(path, "utf-8"); }
		catch (error: any) {
			failures.push(`proof file unreadable: ${item.path}: ${error?.message ?? error}`);
			continue;
		}
		for (const text of required) {
			if (!content.includes(text)) failures.push(`proof text missing in ${item.path}: ${text}`);
		}
	}
	if (files.length === 0) failures.push("completion proof has no files");
	return { passed: failures.length === 0, checkedFiles, failures };
}

export interface ParallelRunResult {
	results: AgentRunResult[];
	wallClockMs: number;        // 并行总耗时
	sumIndividualMs: number;    // 各 agent 耗时之和 (用于计算加速比)
	speedupRatio: number;       // sumIndividual / wallClock (1.0=无加速, 2.0=理想双线程)
	totalCost: number;
	allSucceeded: boolean;
	errors: string[];           // 失败 agent 的错误信息
}

export function allocateParallelAgentBudget(maxCostUsd: number | undefined, taskCount: number): number | undefined {
	if (maxCostUsd === undefined) return undefined;
	if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error("Parallel task budget must be greater than 0");
	if (!Number.isInteger(taskCount) || taskCount <= 0) throw new Error("Parallel task count must be a positive integer");
	return maxCostUsd / taskCount;
}

/**
 * 并行运行多个相互独立的 Agent 任务。
 *
 * 每个 subagent 是独立子进程, 天然并行.
 * 一个 agent 失败不影响其他 agent (隔离错误).
 *
 * @param tasks 要并行执行的 agent 任务列表
 * @param common 共享参数 (cwd, sessionId, telemetry, prefixLayout, pricing)
 * @returns ParallelRunResult 包含所有结果 + 并行性能指标
 */
export async function runAgentsParallel(
	tasks: ParallelAgentTask[],
	common: {
		cwd: string;
		sessionId: string;
		telemetry?: TelemetryWriter;
		prefixLayout: boolean;
		pricing?: PricingTable;
		persistent?: boolean;
		sessionIds?: Map<string, string>;   // per-label session ID (team-workflow 用)
		sessionDir?: string;                // 自定义 session 目录
		timeoutMs?: number | null;           // 可选相对 deadline；省略/null 不因 wall-clock 终止
		/** 父级传入的绝对 deadline；优先于 timeoutMs，避免跨批次重置时钟。 */
		deadlineAt?: number;
		maxRetries?: number;                // 重试次数 (默认 1)
		lockFiles?: Record<string, string[]>;  // per-label 文件锁: {label: [file paths]}
		signal?: AbortSignal;               // 调用方取消时终止所有子进程
		maxCostUsd?: number;                // 父任务聚合成本上限；按 child 预算分配
		maxTurns?: number;                  // 父任务聚合 assistant turn 上限
		maxInputTokens?: number;            // 父任务聚合 input token 上限
		maxParallel?: number;               // 父任务并发上限；省略时与 tasks 数相同
		parentMaxParallel?: number;         // 已存在父 Task 时的 active Run 上限
		health?: RunHealthConfig;
		taskId?: string;                   // 父任务关联；每个并行 child 共享 taskId
		executionId?: string;              // 父 execution 关联
		requireBoundaryReceipt?: boolean;
		onEvent?: (event: unknown, context: AgentRunnerJsonEventContext) => void;
		onJsonEvent?: (event: unknown, context: AgentRunnerJsonEventContext) => void;
		onEntry?: (entry: unknown, context: AgentRunnerJsonEventContext) => void;
		onProtocolIssue?: (issue: JsonlStreamIssue) => void;
		invocationOverride?: PiInvocationOverride;
	},
): Promise<ParallelRunResult> {
	const wallStart = Date.now();
	if (tasks.length === 0) return { results: [], wallClockMs: 0, sumIndividualMs: 0, speedupRatio: 1, totalCost: 0, allSucceeded: true, errors: [] };
	const maxParallel = common.maxParallel ?? tasks.length;
	if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("Parallel maxParallel must be a positive integer");
	// 显式并发上限用批次实现；每批重新按父级剩余预算分配，避免后续批次重新获得完整父预算。
	if (maxParallel < tasks.length) {
		const results: AgentRunResult[] = [];
		const errors: string[] = [];
		let totalCost = 0;
		let wallClockMs = 0;
		let sumIndividualMs = 0;
		let allSucceeded = true;
		for (let start = 0; start < tasks.length; start += maxParallel) {
			const batchTasks = tasks.slice(start, start + maxParallel);
			const batch = await runAgentsParallel(batchTasks, {
				...common,
				maxParallel: undefined,
				parentMaxParallel: common.parentMaxParallel ?? common.maxParallel,
				maxCostUsd: common.maxCostUsd === undefined ? undefined : Math.max(0, common.maxCostUsd - totalCost),
				maxTurns: common.maxTurns === undefined ? undefined : Math.max(0, common.maxTurns - results.reduce((sum, item) => sum + item.usage.turns, 0)),
				maxInputTokens: common.maxInputTokens === undefined ? undefined : Math.max(0, common.maxInputTokens - results.reduce((sum, item) => sum + item.usage.input, 0)),
			});
			results.push(...batch.results);
			errors.push(...batch.errors);
			totalCost += batch.totalCost;
			wallClockMs += batch.wallClockMs;
			sumIndividualMs += batch.sumIndividualMs;
			allSucceeded = allSucceeded && batch.allSucceeded;
		}
		return { results, wallClockMs, sumIndividualMs, speedupRatio: wallClockMs > 0 ? sumIndividualMs / wallClockMs : 1, totalCost: Number(totalCost.toFixed(6)), allSucceeded, errors };
	}
	const perAgentMaxCostUsd = allocateParallelAgentBudget(common.maxCostUsd, tasks.length);
	const perAgentMaxTurns = common.maxTurns === undefined ? undefined : Math.floor(common.maxTurns / tasks.length);
	const perAgentMaxInputTokens = common.maxInputTokens === undefined ? undefined : Math.floor(common.maxInputTokens / tasks.length);
	const runIds = tasks.map(() => `subagent-${randomUUID()}`);
	const lifecycleRecords = tasks.map((task, index) => common.persistent ? null : createEphemeralRecord({
		name: task.agent.name,
		role: task.agent.role ?? task.agent.name,
		sessionId: common.sessionId,
		taskId: common.taskId,
		runId: runIds[index],
		currentTask: task.task.slice(0, 200),
		model: task.agent.model,
		telemetry: common.telemetry,
	}));
	for (let index = 0; index < tasks.length; index++) {
		const record = lifecycleRecords[index];
		if (record) startEphemeralRecord(record, {
			sessionId: common.sessionId,
			taskId: common.taskId,
			runId: runIds[index],
			currentTask: tasks[index].task,
			model: tasks[index].agent.model,
			telemetry: common.telemetry,
		});
	}

	// 为每个 task 记录独立开始时间, 用于计算 sumIndividualMs
	const timings: Array<{ start: number; end: number }> = [];

	// Promise.all 包装: 每个 subagent 独立运行, 错误隔离
	const settled = await Promise.allSettled(
		tasks.map((t, i) => {
			const individualStart = Date.now();
			// per-label session ID 优先, fallback 到 common.sessionId
			const sid = (t.label ? common.sessionIds?.get(t.label) : undefined) ?? common.sessionId;
			return runAgent({
				cwd: common.cwd,
				workspaceCwd: t.workspaceCwd,
				agent: t.agent,
				task: t.task,
				sessionId: sid,
				telemetry: common.telemetry,
				prefixLayout: common.prefixLayout,
				pricing: common.pricing,
				persistent: common.persistent,
				persistentSessionId: common.persistent ? `flux-${t.label ?? t.agent.name}-${sid}` : undefined,
				sessionDir: common.sessionDir,
				timeoutMs: common.timeoutMs,
				deadlineAt: common.deadlineAt,
				maxRetries: common.maxRetries ?? 1,
				model: t.model,
				provider: t.provider,
				thinking: t.thinking,
				maxTurns: t.maxTurns === undefined ? perAgentMaxTurns : perAgentMaxTurns === undefined ? t.maxTurns : Math.min(t.maxTurns, perAgentMaxTurns),
				maxInputTokens: t.maxInputTokens === undefined ? perAgentMaxInputTokens : perAgentMaxInputTokens === undefined ? t.maxInputTokens : Math.min(t.maxInputTokens, perAgentMaxInputTokens),
				completionProof: t.completionProof,
				lockFiles: t.lockFiles ?? (t.label ? common.lockFiles?.[t.label] : undefined),
				signal: common.signal,
				maxCostUsd: perAgentMaxCostUsd,
				parentMaxCostUsd: common.maxCostUsd,
				parentMaxTurns: common.maxTurns,
				parentMaxInputTokens: common.maxInputTokens,
				parentMaxParallel: common.parentMaxParallel ?? common.maxParallel,
				taskId: common.taskId,
				executionId: common.executionId,
				requireBoundaryReceipt: common.requireBoundaryReceipt,
				onEvent: common.onEvent,
				onJsonEvent: common.onJsonEvent,
				onEntry: common.onEntry,
				onProtocolIssue: common.onProtocolIssue,
				runId: runIds[i],
				liveTeamCommunication: true,
				invocationOverride: common.invocationOverride,
				health: common.health,
			}).then(result => {
				timings[i] = { start: individualStart, end: Date.now() };
				return result;
			});
		}),
	);

	const wallClockMs = Date.now() - wallStart;

	// 收集结果
	const results: AgentRunResult[] = [];
	const errors: string[] = [];
	let totalCost = 0;
	let allSucceeded = true;

	for (let i = 0; i < settled.length; i++) {
		const s = settled[i];
		if (s.status === "fulfilled") {
			results.push(s.value);
			const record = lifecycleRecords[i];
			if (record) finishEphemeralRecord(record, s.value.exitCode, s.value.usage.cost, common.telemetry, common.sessionId, common.taskId, runIds[i]);
			totalCost += s.value.usage.cost;
			if (s.value.exitCode !== 0 || s.value.errorMessage) {
				allSucceeded = false;
				errors.push(`${tasks[i].label ?? tasks[i].agent.name}: exit=${s.value.exitCode} ${s.value.errorMessage ?? ""}`);
			}
		} else {
			// rejected (spawn error etc)
			allSucceeded = false;
			const errMsg = `${tasks[i].label ?? tasks[i].agent.name}: ${s.reason?.message ?? s.reason}`;
			errors.push(errMsg);
			results.push({
				agent: tasks[i].agent.name, exitCode: -1, output: "",
				usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
				model: null, errorMessage: errMsg,
			});
			const record = lifecycleRecords[i];
			if (record) finishEphemeralRecord(record, -1, 0, common.telemetry, common.sessionId, common.taskId, runIds[i]);
		}
	}

	const sumIndividualMs = timings.reduce((sum, t) => sum + (t ? (t.end - t.start) : 0), 0);
	const speedupRatio = wallClockMs > 0 ? sumIndividualMs / wallClockMs : 1;

	return {
		results, wallClockMs, sumIndividualMs, speedupRatio,
		totalCost: Number(totalCost.toFixed(6)), allSucceeded, errors,
	};
}

/** 格式化并行 subagent 结果为工具返回 content */
export function formatParallelAgentResults(r: ParallelRunResult): string {
	const lines: string[] = [
		`[AgentFlux parallel: ${r.results.length} agents]`,
		`wall ${(r.wallClockMs / 1000).toFixed(1)}s · sum ${(r.sumIndividualMs / 1000).toFixed(1)}s · speedup ${r.speedupRatio.toFixed(2)}x · $${r.totalCost.toFixed(4)} · ${r.allSucceeded ? "all ok" : `${r.errors.length} failed`}`,
	];
	for (const res of r.results) {
		const hitRate = res.usage.cacheRead / (res.usage.cacheRead + res.usage.input + 1e-9);
		lines.push(`  ── ${res.agent}: turns ${res.usage.turns} · in ${res.usage.input} · read ${res.usage.cacheRead} · hit ${(hitRate * 100).toFixed(0)}% · $${res.usage.cost.toFixed(4)}${res.errorMessage ? ` · ERROR: ${res.errorMessage.slice(0, 100)}` : ""}`);
	}
	if (r.errors.length > 0) {
		lines.push("", "Errors:");
		for (const e of r.errors) lines.push(`  - ${e}`);
	}
	// 各 agent 输出摘要
	lines.push("", "Outputs:");
	for (const res of r.results) {
		const preview = (res.output || "(no output)").slice(0, 500);
		lines.push(`  ── ${res.agent} ──`);
		lines.push(preview);
	}
	return lines.join("\n");
}

export interface AgentTemplate {
	name: string;
	role?: string;
	description: string;
	tools?: string[];
	model?: string;
	provider?: string;    // pi provider name; if omitted, child inherits pi default
	skills?: string[];      // F2: 角色特有 skills (如 ["planning", "code-review"])
	mcpServers?: string[];
	workspace?: WorkspaceCapabilityInput;
	systemPrompt: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	communication?: CommunicationPolicyInput; // 角色模板默认；运行实例可收窄或增加完成门
}

export interface AgentRunnerJsonEventContext {
	sequence: number;
	raw: string;
}

export interface AgentBoundaryReceiptDetails {
	schemaVersion: 1;
	generation: number;
	outcome: "completed" | "aborted" | "error";
	terminalFailure: boolean;
	terminalFailureOutcome?: "aborted" | "error";
	consumed: boolean;
	consumedGeneration?: number;
	consumedMessageIds: string[];
	settled: false;
	continueRequested: boolean;
}

export const AGENTFLUX_BOUNDARY_RECEIPT_CUSTOM_TYPE = "agentflux.boundary.receipt";

/** Validate the fixed custom entry emitted by the safe subagent boundary hook. */
export function readAgentBoundaryReceipt(value: unknown): AgentBoundaryReceiptDetails | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const entry = value as Record<string, unknown>;
	if (entry.customType !== AGENTFLUX_BOUNDARY_RECEIPT_CUSTOM_TYPE) return null;
	const details = entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data)
		? entry.data as Record<string, unknown>
		: entry.details !== null && typeof entry.details === "object" && !Array.isArray(entry.details)
			? entry.details as Record<string, unknown> : undefined;
	if (!details || details.schemaVersion !== 1 || !Number.isInteger(details.generation) || (details.generation as number) < 1
		|| !["completed", "aborted", "error"].includes(details.outcome as string)
		|| typeof details.terminalFailure !== "boolean"
		|| details.terminalFailure !== (details.outcome !== "completed")
		|| typeof details.consumed !== "boolean"
		|| !Array.isArray(details.consumedMessageIds)
		|| !details.consumedMessageIds.every(item => typeof item === "string")
		|| details.settled !== false
		|| typeof details.continueRequested !== "boolean") return null;
	if (details.terminalFailure && details.terminalFailureOutcome !== details.outcome) return null;
	if (!details.terminalFailure && details.terminalFailureOutcome !== undefined) return null;
	if (details.consumedGeneration !== undefined
		&& (!Number.isInteger(details.consumedGeneration) || (details.consumedGeneration as number) < 1)) return null;
	return details as unknown as AgentBoundaryReceiptDetails;
}

export interface AgentRunResult {
	agent: string;
	/** Physical Pi session identity actually opened by this Run, when persistent. */
	sessionId?: string;
	sessionFile?: string;
	backend?: "process" | "sdk";
	sdkOwner?: SdkRunOwner;
	/** 本次运行实际选择的角色。 */
	role?: string;
	exitCode: number;
	/** True only when the runner observed and enforced an explicit deadline. */
	timedOut?: boolean;
	output: string;
	usage: {
		turns: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
	};
	model: string | null;
	provider?: string;
	responseModel?: string;
	thinkingLevel?: string;
	costAccounting?: { complete: boolean; attributionComplete: boolean; provisional: boolean };
	/** Host/CLI identity used for this physical child (test overrides are unverified). */
	invocation?: PiInvocationDescriptor["provenance"];
	/** Base invocation descriptor retained for Main/supervisor evidence. */
	invocationDescriptor?: PiInvocationDescriptor;
	/** JSONL protocol diagnostics; incomplete means no complete boundary was proven. */
	protocolErrors?: string[];
	incomplete?: boolean;
	assistantMessages?: string[];
	errorMessage?: string;
	retryCount?: number;  // 自动重试次数 (0=首次成功)
	fallbackModel?: string;  // 降级后的实际使用模型 (如果有)
	fallbackFrom?: string;   // 原始模型名 (如果发生了降级)
	communication?: CommunicationContractReport;
	capability?: {
		snapshotPath: string;
		narrowed: string[];
		cacheBreakingChanges: Array<"tool_schema" | "skill_set" | "mcp_set" | "runtime_policy_guard">;
	};
	completionProof?: AgentCompletionProofReport;
}

/** 从 .agentflux/agents/*.md 加载 agent 定义 (frontmatter + body), 回落到内建 reviewer */
export function loadAgentTemplate(cwd: string, name: string): AgentTemplate | null {
	// agent 名会参与文件路径和 session id，禁止路径穿越与分隔符。
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) return null;
	const dir = join(cwd, ".agentflux", "agents");
	const file = resolve(dir, `${name}.md`);
	if (!file.startsWith(resolve(dir) + sep)) return null;
	if (existsSync(file)) {
		try {
			const { frontmatter, body } = parseFrontmatter(readFileSync(file, "utf-8"));
			if (!frontmatter.name) return null;
			const tools = frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean);
			const skills = frontmatter.skills?.split(",").map((skill) => skill.trim()).filter(Boolean);
			const thinking = frontmatter.thinking as AgentTemplate["thinking"] | undefined;
			return {
				name: frontmatter.name, description: frontmatter.description ?? "",
				tools: tools?.length ? tools : undefined, model: frontmatter.model,
				provider: frontmatter.provider,
				skills: skills?.length ? [...new Set(skills)] : undefined,
				mcpServers: frontmatter.mcp_servers?.split(",").map(item => item.trim()).filter(Boolean),
				workspace: frontmatter.workspace_roots || frontmatter.denied_paths
					? {
						roots: frontmatter.workspace_roots?.split(",").map(item => item.trim()).filter(Boolean),
						deniedPaths: frontmatter.denied_paths?.split(",").map(item => item.trim()).filter(Boolean),
						blockDangerousCommands: frontmatter.block_dangerous_commands !== "false",
					} : undefined,
				systemPrompt: body,
				thinking: thinking && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking) ? thinking : undefined,
				communication: communicationPolicyFromFrontmatter(frontmatter),
			};
		} catch { /* fall through */ }
	}
	// 内建 fallback: reviewer
	if (name === "reviewer") {
		return {
			name: "reviewer",
			description: "Code review specialist (read-only)",
			model: "oa/glm-5.2",
			provider: "octopus-completions",
			thinking: "xhigh",
			tools: ["read", "grep", "find", "ls", "bash"],
			systemPrompt: "You are a senior code reviewer. Assess code quality, security, and maintainability. Bash is limited to read-only commands (git diff/log/show). Use these sections: ## Reviewed Files / ## Critical Issues / ## Warnings / ## Suggestions / ## Summary. Cite specific file paths and line numbers.",
		};
	}
	return null;
}
/** 合并项目共享 Skill 与角色 Skill；返回副本，避免污染缓存或调用方定义。 */
export function withSharedSkills(agent: AgentTemplate, sharedSkills?: string[]): AgentTemplate {
	const skills = [...new Set([...(sharedSkills ?? []), ...(agent.skills ?? [])]
		.map(skill => skill.trim())
		.filter(Boolean))];
	return { ...agent, skills: skills.length > 0 ? skills : undefined };
}

/** process driver始终加载package-owned安全/Message V2入口，与缓存开关无关。 */
function getSubagentEntryPath(_cwd: string): string {
	// 从已安装 package 自身定位，不能假设目标项目也有 src/subagent-entry.ts。
	const ownFile = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
	const ownDir = dirname(ownFile);
	// 构建产物位于 dist/host，扩展位于同级的 dist/extension。
	const bundledEntry = resolve(ownDir, "..", "extension", "subagent-entry.js");
	if (existsSync(bundledEntry)) return bundledEntry;
	// 源码执行时 ownDir=src/agents。
	return resolve(ownDir, "..", "subagent-entry.ts");
}

/**
 * Add the package-owned Windows preload after the Host resolver has selected the
 * CLI. The preload is an AgentFlux process policy, not part of Pi provenance.
 */
function addBackgroundPreload(invocation: PiInvocationDescriptor): PiInvocationDescriptor {
	if (process.platform !== "win32" || !invocation.cliPath) return invocation;
	const ownFile = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
	const preload = join(dirname(ownFile), "background-preload.mjs");
	if (!existsSync(preload)) throw new Error(`AgentFlux background preload not found: ${preload}`);
	const preloadArgs: string[] = [];
	preloadArgs.push("--import", pathToFileURL(preload).href);
	const cliPath = invocation.cliPath;
	const args = invocation.cliArgs ?? [];
	return { ...invocation, command: process.execPath, args: [...preloadArgs, cliPath, ...args] };
}

/**
 * 运行单个 subagent。
 * @param opts.cwd 工作目录
 * @param agent agent 定义
 * @param task 任务描述
 * @param sessionId 主 session id (telemetry 关联)
 * @param telemetry telemetry writer (可选, 不传则不写)
 * @param prefixLayout 缓存布局观测标记，不控制安全入口或执行后端
 * @param model 覆盖 agent.model
 * @param provider 覆盖 agent.provider
 * @param pricing 父进程用价格表重算子进程成本
 * @param persistent true=保留 session 文件可续接, false=一次性 ephemeral
 * @param sessionDir 持久 session 存储目录, 默认 .agentflux/runtime/sessions/
 * @param thinking 覆盖 agent.thinking 的 reasoning effort 级别
 */
// ── SharedBoard 集成: agent 启动前读 inbox + 注册 ──

/**
 * 只从 Message V2 注入 Run 对应的消息；旧 SharedBoard inbox/group 不再进入模型上下文。
 * ACK 统一在本次 Run 成功收敛后由调用方完成，避免把“已读”冒充实际消费。
 */
function prependInboxMessages(task: string, agentName: string, cwd: string, runId: string): { task: string; v2MessageIds: string[] } {
	try {
		const fluxDir = join(cwd, ".agentflux");
		const v2Messages = new MessageBus(fluxDir, { redeliveryAfterMs: loadConfig(cwd).communication.redelivery_after_ms }).poll(agentName, {
			limit: 20,
			correlationId: runId,
			includeUncorrelated: true,
			// A stop control written before this poll fences startup injection too;
			// uncorrelated steer is legacy residue and must not cross Run boundaries.
			accept: envelope => !readAgentRunStop(cwd, runId)
				&& (envelope.type !== "steer" || envelope.correlationId === runId),
		});
		if (v2Messages.length === 0) return { task, v2MessageIds: [] };
		const messages = v2Messages.map(({ envelope }) =>
			`[V2 ${envelope.channel.type}/${envelope.channel.id} from ${envelope.from} id=${envelope.id}] ${envelope.content.slice(0, 500)}`);
		return {
			task: `=== Messages from other agents ===\n${messages.join("\n")}\n=== End messages ===\n\n${task}`,
			v2MessageIds: v2Messages.map(item => item.envelope.id),
		};
	} catch {
		return { task, v2MessageIds: [] };
	}
}

// ── 错误检测: 模型错误 (可降级) vs 瞬时错误 (可重试) vs 进程错误 ──

/** 只有明确指向模型/凭据的解析错误才可触发模型降级；普通 file not found 不是模型错误。 */
function isModelError(msg?: string): boolean {
	return !!msg && /\bmodel\b.{0,80}\b(?:not found|unknown|invalid|unsupported|unavailable|does not exist)\b|\b(?:unknown|invalid|unsupported|unavailable)\s+model\b|no api key|opencode/i.test(msg);
}

/** 瞬时错误 — 502/503/500/overloaded/gateway 等, 重试同一模型 */
function isTransientError(msg?: string, output?: string): boolean {
	const text = `${msg ?? ""} ${output ?? ""}`;
	return /502|503|500|overloaded|service unavailable|gateway|bad gateway|rate limit|429|timeout|resourceexhausted|local total request limit reached|connection (refused|reset|closed)|ECONNREFUSED|ETIMEDY|负载.*上限|过载|服务不可用|超时|请求失败|繁忙/i.test(text);
}

export function canCompletionProofRecover(
	result: Pick<AgentRunResult, "exitCode" | "output" | "errorMessage">,
): boolean {
	if (result.exitCode === 72) return false;
	if (result.exitCode === 74) return true;
	return result.exitCode !== 0
		&& result.output.trim().length > 0
		&& isTransientError(result.errorMessage);
}

/** Provider/API 组合不兼容 — 重试同一组合通常无效，应切换模型/provider。 */
function isProviderCompatibilityError(msg?: string): boolean {
	return !!msg && /406(?: status code)?|not acceptable/i.test(msg);
}

/** 明确的 provider/API 故障；裸 timeout 或普通进程错误只能重试，不能切换模型。 */
function isExplicitProviderError(msg?: string, output?: string): boolean {
	const text = `${msg ?? ""} ${output ?? ""}`;
	return isProviderCompatibilityError(msg) || isProviderQuotaError(msg, output)
		|| /\b(?:http\s*)?(?:429|500|502|503)\b|provider|api error|upstream|gateway|service unavailable|server(?:s)? (?:are )?overloaded|rate limit|resourceexhausted|local total request limit reached|connection (?:refused|reset|closed)|ECONNREFUSED|ETIMEDOUT|负载.*上限|过载|服务不可用|请求失败|繁忙/i.test(text);
}

/** 只用于在线错误展示/归类，不把普通业务/文件错误写成 provider/model 故障。 */
function isProviderOrModelError(msg?: string, output?: string): boolean {
	return !!msg && (isModelError(msg) || isExplicitProviderError(msg, output));
}

function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 仅供确定性测试注入 Registry 写入依赖；生产 flux_agent schema 不暴露该参数。
 * 未提供的方法全部使用 Core Run Registry 的真实原子实现。
 */
export interface AgentRunRegistryHooks {
	register?: typeof registerAgentRun;
	markRunning?: typeof markAgentRunRunning;
	heartbeat?: typeof heartbeatAgentRun;
	updateSnapshot?: typeof updateAgentRunSnapshot;
	updateHealth?: typeof updateAgentRunHealth;
	finish?: typeof finishAgentRun;
}

/**
 * Provider 额度/计费错误不会通过等待或重试同一 provider 恢复。
 * 与普通 429 rate-limit 分开，避免把月额度耗尽当成瞬时抖动。
 */
export function isProviderQuotaError(msg?: string, output?: string): boolean {
	const text = `${msg ?? ""} ${output ?? ""}`;
	return /\b402\b|insufficient balance|monthly usage limit|usage limit reached|quota (?:exceeded|exhausted)|billing (?:error|limit)|payment required|available balance|额度(?:不足|耗尽)|余额不足/i.test(text);
}

/** 为不可恢复的 provider 故障选择不同 provider 的候选，避免同通道循环。 */
export function selectFallbackModel(
	currentModel: string,
	currentProvider: string | undefined,
	tried: readonly string[],
	models: Record<string, ModelEntry>,
	requirement: RoleRequirement,
	avoidCurrentProvider = false,
): string | undefined {
	return rankModels(requirement, models)
		.map(candidate => candidate.model)
		.find(candidate => {
			if (candidate === currentModel || tried.includes(candidate)) return false;
			if (!avoidCurrentProvider || !currentProvider) return true;
			return models[candidate]?.provider !== currentProvider;
		});
}

/** 注册 agent 到 SharedBoard agent 注册表 */
function registerAgentInBoard(agent: AgentTemplate, task: string, cwd: string, model?: string, provider?: string): void {
	try {
		const board = new SharedBoard(join(cwd, ".agentflux"));
		board.registerAgent({
			name: agent.name,
			role: agent.name,  // agent name IS the role (planner/implementer/reviewer/tester/designer)
			status: "running",
			currentTask: task.slice(0, 200),
			model,
			provider,
			thinking: agent.thinking,
		});
		// 确保 "all" 大群包含此 agent
		board.ensureAllGroup([agent.name]);
	} catch { /* 静默 */ }
}

function registerRuntimeAgentInBoard(
	agent: AgentTemplate,
	task: string,
	cwd: string,
	instanceId: string,
	model?: string,
	provider?: string,
): void {
	try {
		const board = new SharedBoard(join(cwd, ".agentflux"));
		board.registerRuntimeAgent({
			name: agent.name,
			role: "rpc-runtime",
			status: "running",
			currentTask: task.slice(0, 200),
			model,
			provider,
			thinking: agent.thinking,
			instanceId,
		});
		board.ensureAllGroup([agent.name]);
	} catch {}
}

/** 更新 agent 状态 */
function updateAgentStatusInBoard(agentName: string, status: "done" | "failed", cwd: string): void {
	try {
		const board = new SharedBoard(join(cwd, ".agentflux"));
		board.updateAgentPresence(agentName, { status });
	} catch { /* 静默 */ }
}

const activeSubagentProcesses = new Map<string, ChildProcess | SdkRunDriver>();
const childProcessIdentities = new WeakMap<ChildProcess, ProcessIdentity>();

/** 当前进程内仍在运行的 pi 子进程，供状态页和取消测试使用。 */
export function getActiveAgentRunIds(): string[] {
	return [...activeSubagentProcesses.keys()];
}

async function terminateProcessTree(proc: ChildProcess): Promise<boolean> {
	if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return true;
	const expected = childProcessIdentities.get(proc);
	const observed = await observeProcessAsync(proc.pid);
	if (proc.exitCode !== null || proc.signalCode !== null || observed.state === "dead") return true;
	if (!expected || observed.state !== "alive") return false;
	if (observed.identity.birth !== expected.birth || observed.identity.platform !== expected.platform) return true;
	if (process.platform === "win32") {
		// Synchronously wait for taskkill to finish its /T traversal. An async
		// taskkill child can outlive the run's parent-close event and keep the
		// fixture/workspace locked even after cancellation was reported.
		const killed = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
			shell: false, stdio: "ignore", windowsHide: true, timeout: 7000,
		});
		if (killed.error || killed.status !== 0) {
			try { if (!proc.kill()) return false; } catch { return false; }
		}
		await new Promise(resolveDone => setTimeout(resolveDone, 500));
		return true;
	}
	// POSIX 下子进程以独立 process group 启动，负 PID 可终止其整个后代树。
	try { process.kill(-proc.pid, "SIGTERM"); }
	catch { try { return proc.kill("SIGTERM"); } catch { return false; } }
	return true;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise(resolveWait => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolveWait(true);
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolveWait(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function runAgent(opts: {
	cwd: string;
	workspaceCwd?: string; // 子进程 cwd；运行状态、消息与 telemetry 仍归属 cwd
	agent: AgentTemplate;
	task: string;
	sessionId: string;
	telemetry?: TelemetryWriter;
	prefixLayout: boolean;
	model?: string;
	provider?: string;
	pricing?: PricingTable;  // F1-14: 父进程用价格表重算子进程成本
	persistent?: boolean;
	persistentSessionId?: string; // 持久 session 的作用域 key；未传时沿用 agent 名
	/** Native Pi fork target. When set, open this exact file instead of deriving a key. */
	persistentSessionFile?: string;
	sessionDir?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	timeoutMs?: number | null; // 可选相对 deadline；未设置时不因模型执行 wall-clock 自动终止
	/** 绝对 deadline，供 planner/DAG/judge 继承同一父级时钟。 */
	deadlineAt?: number;
	maxRetries?: number;      // 超时/进程失败时自动重试次数 (默认 0)
	retryDelayMs?: number;    // 重试初始延迟 (默认 2000ms, 指数退避)
	// 模型降级 (opt-in, 默认关): 模型不可用时自动切换低一档模型重试
	enableModelFallback?: boolean;
	modelsForFallback?: Record<string, ModelEntry>;  // 降级可选模型表
	roleRequirementForFallback?: RoleRequirement;     // 降级排序用的角色需求
	fallbackHistory?: string[];                        // 已尝试过的模型 (避免循环)
	lockFiles?: string[];                              // 文件锁: 防并行编辑冲突
	signal?: AbortSignal;                              // 取消信号，终止真实子进程并停止重试
	runId?: string;                                    // 外部 run 关联 id
	maxCostUsd?: number;                               // 本 Run/节点成本上限（单次调用可能产生少量超额）
	/** 父 Task 聚合预算；与本 Run 上限分开，避免 fan-out 每个 child 重置预算。 */
	parentMaxCostUsd?: number;
	parentMaxTurns?: number;
	parentMaxInputTokens?: number;
	parentMaxParallel?: number;
	maxTurns?: number;                                 // 完成一个 assistant turn 后检查的硬上限
	maxInputTokens?: number;                           // 跨 turn 累计 input token 硬上限
	completionProof?: AgentCompletionProof;            // 声明后所有成功都必须通过；仅 exit 74 可由文件事实恢复为成功
	env?: Record<string, string>;                      // 透传给子进程的额外环境变量
	taskId?: string;                                   // Message V2 / telemetry correlation
	executionId?: string;                              // first-class parent execution correlation
	liveTeamCommunication?: boolean;                    // Team child 在结束前主动轮询 operator/peer inbox
	communicationOverride?: CommunicationPolicyInput; // 注册实例/单次调用动态覆盖角色模板
	capabilityOverride?: CapabilityPolicyInput;         // 单次运行覆盖；只能收窄模板和注册实例
	/** 注册实例允许的角色集合；用于选择多角色 Agent 的本次角色。 */
	registeredRoles?: string[];
	/** 显式注册身份；persistent 仅表示会话持久化，不隐含 Agent registry 引用。 */
	agentId?: string;
	/** 仅供确定性生命周期测试注入本地假进程；生产入口不会暴露。 */
	invocationOverride?: PiInvocationOverride;
	/** 仅供确定性测试注入一次 Registry 写失败；生产入口不会暴露。 */
	runRegistry?: AgentRunRegistryHooks;
	/** 运行过程实时回调（assistant 消息 / 工具调用 / 回合），供 UI 直播子代理运行过程。 */
	onProgress?: (event: { type: "message" | "tool"; text: string }) => void;
	/** Main/Core hook for every complete JSON event; callback failure is fail-closed. */
	onEvent?: (event: unknown, context: AgentRunnerJsonEventContext) => void;
	/** Alias with explicit JSON naming for Main/UsageAccounting integration. */
	onJsonEvent?: (event: unknown, context: AgentRunnerJsonEventContext) => void;
	/** Entry hook for UsageAccounting/session-entry consumers. */
	onEntry?: (entry: unknown, context: AgentRunnerJsonEventContext) => void;
	/** Protocol/consumer diagnostics retained in the Run result. */
	onProtocolIssue?: (issue: JsonlStreamIssue) => void;
	/** Production runs require safe-agent boundary receipt + agent_settled; test overrides default off. */
	requireBoundaryReceipt?: boolean;
	/** 健康状态发生变化或需要限频提示时回调；不会改变 Run 终态。 */
	onHealthChange?: (event: { health: AgentRunHealth; reason?: string; warning: boolean }) => void;
	health?: RunHealthConfig;
}): Promise<AgentRunResult> {
	const { cwd, agent, sessionId, telemetry, prefixLayout } = opts;
	const workspaceCwd = resolve(opts.workspaceCwd ?? cwd);
	if (!existsSync(workspaceCwd)) {
		return {
			agent: agent.name, exitCode: 72, output: "",
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
			model: null, errorMessage: `workspace does not exist: ${workspaceCwd}`, retryCount: 0,
		};
	}
	if (opts.persistent && opts.persistentSessionFile && !existsSync(opts.persistentSessionFile)) {
		return {
			agent: agent.name, exitCode: 72, output: "",
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
			model: null, errorMessage: `persistent native fork session does not exist: ${opts.persistentSessionFile}`, retryCount: 0,
		};
	}
	// 配置方式/Host身份在创建Run前冻结；未知值和SDK不支持的env/CLI覆盖不得fallback。
	let runtimeMode: "process" | "sdk";
	let sdkBinding: PiSdkHostBinding | undefined;
	try {
		runtimeMode = loadSubagentRuntime(cwd);
		if (runtimeMode === "sdk") {
			if (opts.invocationOverride || (opts.env && Object.keys(opts.env).length)) throw new Error("SDK subagents do not support process invocation or environment overrides");
			sdkBinding = requirePiSdkHost(cwd);
		}
	} catch (error: any) {
		return { agent: agent.name, exitCode: 72, output: "", model: null, retryCount: 0,
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 }, errorMessage: String(error?.message ?? error) };
	}
	// 包边界错误必须在登记 Run/lease 之前拒绝，不能留下没有 PID 的 starting Run。
	let defaultInvocation: PiInvocationDescriptor | undefined;
	if (!opts.invocationOverride) {
		try {
			const binding = sdkBinding ?? getPiSdkHost(cwd);
			defaultInvocation = addBackgroundPreload(resolvePiInvocation(binding ? { hostPackageDir: binding.sdk.getPackageDir(), hostVersion: binding.sdk.VERSION } : {}));
		}
		catch (error: any) {
			return { agent: agent.name, exitCode: 72, output: "", model: null, retryCount: 0,
				usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
				errorMessage: String(error?.message ?? error) };
		}
	}
	let invocationDescriptor: PiInvocationDescriptor | undefined = defaultInvocation;
	let invocationProvenance: PiInvocationDescriptor["provenance"] | undefined = defaultInvocation?.provenance;
	if (opts.invocationOverride) {
		try {
			invocationDescriptor = resolvePiInvocation({ invocationOverride: opts.invocationOverride });
			invocationProvenance = invocationDescriptor.provenance;
		} catch (error: any) {
			return { agent: agent.name, exitCode: 72, output: "", model: null, retryCount: 0,
				usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
				errorMessage: String(error?.message ?? error) };
		}
	}
	const lockFiles = opts.lockFiles?.map(file => resolve(workspaceCwd, file));
	const runStartedAt = Date.now();
	const timeoutMs = normalizeOptionalDurationMs(opts.timeoutMs, "Agent run timeoutMs");
	if (opts.deadlineAt !== undefined && (!Number.isFinite(opts.deadlineAt) || opts.deadlineAt < 0)) {
		throw new Error("Agent run deadlineAt must be a finite non-negative timestamp");
	}
	const maxRetries = opts.maxRetries ?? 0;
	const retryDelayMs = opts.retryDelayMs ?? 2000;
	// An inherited absolute deadline is authoritative. Never recreate it from
	// the remaining duration at a later planner/node/retry boundary.
	const deadline = opts.deadlineAt ?? (timeoutMs === undefined ? undefined : runStartedAt + timeoutMs);
	const deadlineLabel = timeoutMs === undefined
		? (deadline === undefined ? "none" : "absolute deadline")
		: `${timeoutMs / 1000}s`;
	const processRunId = opts.runId ?? `subagent-${randomUUID()}`;
	const requireBoundaryReceipt = opts.requireBoundaryReceipt ?? !opts.invocationOverride;
	let sdkOwner: SdkRunOwner | undefined;
	try { if (runtimeMode === "sdk") sdkOwner = createSdkRunOwner(processRunId); }
	catch (error) {
		return { agent: agent.name, backend: runtimeMode, exitCode: 72, output: "", model: null, retryCount: 0,
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 }, errorMessage: String(error) };
	}
	const runRegistry = opts.runRegistry ?? {};
	const registerRun = runRegistry.register ?? registerAgentRun;
	const markRunningRun = runRegistry.markRunning ?? markAgentRunRunning;
	const heartbeatRun = runRegistry.heartbeat ?? heartbeatAgentRun;
	const updateSnapshotRun = runRegistry.updateSnapshot ?? updateAgentRunSnapshot;
	const finishRun = runRegistry.finish ?? finishAgentRun;
	const updateHealthRun = runRegistry.updateHealth ?? updateAgentRunHealth;
	const agentInstanceId = `${agent.name}:${processRunId}`;
	const capabilityRole = agent.role ?? agent.name;
	const fluxDir = join(cwd, ".agentflux");
	const parentBudgetError = (checkConcurrency = true): string | undefined => {
		if (!opts.taskId) return undefined;
		try {
			const parentRuns = listAgentRuns(fluxDir, { taskId: opts.taskId });
			const parentExecution = opts.executionId ? getTaskExecution(fluxDir, opts.executionId) : undefined;
			if (checkConcurrency && opts.parentMaxParallel !== undefined) {
				if (!Number.isInteger(opts.parentMaxParallel) || opts.parentMaxParallel < 1) return "parent maxParallel must be a positive integer";
				const active = parentRuns.filter(run => run.status === "starting" || run.status === "running" || run.status === "stop_requested");
				if (active.length >= opts.parentMaxParallel) return `parent concurrency budget exhausted: ${active.length} active runs >= ${opts.parentMaxParallel}`;
			}
			const total = parentRuns.reduce((sum, run) => ({
				cost: sum.cost + (Number.isFinite(run.costUsd) ? run.costUsd : 0),
				turns: sum.turns + (Number.isFinite(run.turns) ? run.turns : 0),
				input: sum.input + (Number.isFinite(run.input) ? run.input : 0),
			}), {
				cost: parentExecution?.usage?.costUsd ?? 0,
				turns: 0,
				input: parentExecution?.usage?.input ?? 0,
			});
			if (opts.parentMaxCostUsd !== undefined && (!Number.isFinite(opts.parentMaxCostUsd) || opts.parentMaxCostUsd <= 0)) return "parent maxCostUsd must be a finite positive number";
			if (opts.parentMaxTurns !== undefined && (!Number.isInteger(opts.parentMaxTurns) || opts.parentMaxTurns < 1)) return "parent maxTurns must be a positive integer";
			if (opts.parentMaxInputTokens !== undefined && (!Number.isInteger(opts.parentMaxInputTokens) || opts.parentMaxInputTokens < 1)) return "parent maxInputTokens must be a positive integer";
			if (opts.parentMaxCostUsd !== undefined && total.cost >= opts.parentMaxCostUsd) return `parent task budget exhausted: $${total.cost.toFixed(6)} >= $${opts.parentMaxCostUsd.toFixed(6)}`;
			if (opts.parentMaxTurns !== undefined && total.turns >= opts.parentMaxTurns) return `parent task turn budget exhausted: ${total.turns} >= ${opts.parentMaxTurns}`;
			if (opts.parentMaxInputTokens !== undefined && total.input >= opts.parentMaxInputTokens) return `parent task input budget exhausted: ${total.input} >= ${opts.parentMaxInputTokens}`;
			return undefined;
		} catch (error) {
			return `parent budget state unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
	};
	const initialParentBudgetError = parentBudgetError();
	let registeredCapability: CapabilityPolicyInput | undefined;
	const runCapability: CapabilityPolicyInput | undefined = opts.capabilityOverride || opts.communicationOverride
		? { ...(opts.capabilityOverride ?? {}), communication: opts.communicationOverride ?? opts.capabilityOverride?.communication }
		: undefined;
	let capabilityPolicy;
	let capabilitySnapshotPath = "";
	const capabilitySnapshotRole = opts.registeredRoles && opts.registeredRoles.length > 1 ? capabilityRole : undefined;
	let previousEffectiveCapability: any = null;
	try {
		const registeredRecord = loadRegisteredCapabilityOverrideForRole(fluxDir, agent.name, capabilityRole);
		const baseRegisteredRecord = loadRegisteredCapabilityOverride(fluxDir, agent.name);
		// 角色绑定及存储损坏均走同一拒绝路径，且在启动子进程前失败关闭。
		if (baseRegisteredRecord && !registeredRecord && !opts.registeredRoles?.includes(capabilityRole)) {
			throw new Error(`registered role ${baseRegisteredRecord.role} does not match ${capabilityRole}`);
		}
		registeredCapability = registeredRecord?.override;
		capabilityPolicy = resolveCapabilityPolicy({
			cwd: workspaceCwd, agentName: agent.name, role: capabilityRole, runId: processRunId, instanceId: agentInstanceId,
			template: {
				tools: agent.tools, skills: agent.skills, mcpServers: agent.mcpServers,
				communication: agent.communication, workspace: agent.workspace,
			},
			registered: registeredCapability,
			run: runCapability,
		});
		previousEffectiveCapability = loadEffectiveCapabilitySnapshot(fluxDir, agent.name, capabilitySnapshotRole)?.effective ?? null;
		capabilitySnapshotPath = writeEffectiveCapabilitySnapshot(fluxDir, capabilityPolicy, capabilitySnapshotRole);
	} catch (error: any) {
		telemetry?.writeCapabilityPolicy({
			sessionId, runId: processRunId, agent: agent.name, role: capabilityRole,
			instanceId: agentInstanceId, action: "reject", result: "denied",
			detail: String(error?.message ?? error).slice(0, 500),
		});
		return {
			agent: agent.name, exitCode: 77, output: "",
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
			model: null, errorMessage: `capability policy rejected: ${error?.message ?? error}`, retryCount: 0,
		};
	}
	const communicationPolicy = capabilityPolicy.effective.communication;
	// The package-owned safe entry is independent of cache/prefix layout. It is
	// always explicit, while --no-extensions still excludes every discovered or
	// configured extension. This keeps workspace/lock/message hooks available in
	// both native and prefix-none child modes.
	const shapeChanged = (key: "tools" | "skills" | "mcpServers" | "communication" | "workspace") =>
		previousEffectiveCapability != null
		&& JSON.stringify(previousEffectiveCapability[key]) !== JSON.stringify(capabilityPolicy.effective[key]);
	const capabilityCacheChanges = [...new Set([
		registeredCapability?.tools || runCapability?.tools ? "tool_schema" : null,
		registeredCapability?.skills || runCapability?.skills ? "skill_set" : null,
		registeredCapability?.mcpServers || runCapability?.mcpServers ? "mcp_set" : null,
		registeredCapability?.communication || registeredCapability?.workspace
			|| runCapability?.communication || runCapability?.workspace ? "runtime_policy_guard" : null,
		shapeChanged("tools") ? "tool_schema" : null,
		shapeChanged("skills") ? "skill_set" : null,
		shapeChanged("mcpServers") ? "mcp_set" : null,
		shapeChanged("communication") || shapeChanged("workspace") ? "runtime_policy_guard" : null,
	].filter((item): item is "tool_schema" | "skill_set" | "mcp_set" | "runtime_policy_guard" => !!item))];
	// 角色切换不仅可能改变工具，还可能改变 system prompt/model；持久会话
	// 不能把 planner 的上下文静默复用给 reviewer，因此这些字段都参与 generation。
	const capabilityGeneration = createHash("sha256").update(JSON.stringify({
		role: capabilityRole,
		systemPrompt: agent.systemPrompt,
		model: opts.model ?? agent.model,
		provider: opts.provider ?? agent.provider,
		thinking: opts.thinking ?? agent.thinking,
		tools: capabilityPolicy.effective.tools,
		skills: capabilityPolicy.effective.skills,
		mcpServers: capabilityPolicy.effective.mcpServers,
	})).digest("hex").slice(0, 12);
	telemetry?.writeCapabilityPolicy({
		sessionId, runId: processRunId, agent: agent.name, role: capabilityRole,
		instanceId: agentInstanceId, action: "resolve", result: "success",
		narrowed: capabilityPolicy.narrowed, cacheImpact: capabilityCacheChanges,
		detail: `snapshot=${capabilitySnapshotPath}`,
	});
	try {
		if (sdkOwner) activateSdkRunOwner(cwd, sdkOwner);
		registerRun(fluxDir, {
			id: processRunId,
			agentId: opts.agentId,
			taskId: opts.taskId,
			executionId: opts.executionId,
			sessionId,
			agent: agent.name,
			role: capabilityRole,
			currentTask: opts.task.slice(0, 500),
			model: opts.model ?? agent.model,
			provider: opts.provider ?? agent.provider,
			kind: opts.persistent ? "persistent" : "ephemeral",
			backend: runtimeMode, sdkOwner,
			invocation: invocationProvenance,
			deadlineAt: deadline === undefined ? undefined : new Date(deadline).toISOString(),
		}, {
			parentMaxParallel: opts.parentMaxParallel,
			parentBudget: { maxCostUsd: opts.parentMaxCostUsd, maxTurns: opts.parentMaxTurns, maxInputTokens: opts.parentMaxInputTokens },
		});
	} catch (error) {
		if (sdkOwner) retireSdkRunOwner(cwd, sdkOwner);
		if (error instanceof Error && error.message.includes("parent concurrency budget exhausted")) {
			return {
				agent: agent.name, exitCode: 75, output: "",
				usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, cost: 0 },
				model: null, errorMessage: error.message, retryCount: 0,
			};
		}
		try {
			finishRun(fluxDir, processRunId, {
				status: "failed",
				phase: "terminal",
				turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, costUsd: 0,
				attempt: 0, model: opts.model ?? agent.model ?? null, provider: opts.provider ?? agent.provider ?? null,
				error: `Run Registry register failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		} catch { /* 注册失败时可能没有可收敛的记录 */ }
		throw error;
	}

	const thinkingLevel = opts.thinking ?? agent.thinking ?? "off";

	// SharedBoard 集成: 读 inbox + 注册 agent
	let scopedTask = lockFiles && lockFiles.length > 0
		? `${opts.task}\n\n=== Enforced file edit scope ===\nYou may read other files for context, but you may modify ONLY these paths:\n${lockFiles.map(file => `- ${file}`).join("\n")}\nIf the task requires another file, stop and report the missing scope instead of editing it.\n=== End enforced scope ===`
		: opts.task;
	const communicationInstruction = formatCommunicationContractInstruction(communicationPolicy);
	if (communicationInstruction) scopedTask = `${scopedTask}\n\n${communicationInstruction}`;
	if (opts.liveTeamCommunication && communicationPolicy.enabled && communicationPolicy.actions.includes("poll")) {
		scopedTask = `${scopedTask}\n\n=== Live team communication ===\nAfter completing substantive work and before your final response, call flux_agent_message with action=poll. Process relevant operator or peer updates and acknowledge every message you consumed.\n=== End live team communication ===`;
	}
	const inboxInjection = prependInboxMessages(scopedTask, agent.name, cwd, processRunId);
	const taskWithInbox = inboxInjection.task;
	if (opts.persistent) {
		registerRuntimeAgentInBoard(
			agent,
			opts.task,
			cwd,
			agentInstanceId,
			opts.model ?? agent.model,
			opts.provider ?? agent.provider,
		);
	} else {
		registerAgentInBoard(agent, opts.task, cwd, opts.model ?? agent.model, opts.provider ?? agent.provider);
	}

	// 文件锁 owner 必须是本次运行实例，不能只用角色名（两个 implementer 不是同一 owner）。
	const lockOwner = `${agent.name}:${processRunId}`;

	// 文件锁: 获取要编辑的文件的锁。任何冲突都 fail-closed。
	const lockedFiles: string[] = [];
	let lockError: string | undefined;
	let sdkLease: ReturnType<typeof registerActiveContext> | undefined;
	if (sdkOwner) {
		try { sdkLease = registerActiveContext(cwd, { name: `sdk:${processRunId}`, context: readActiveContext(cwd).context ?? "main", scope: processRunId, task: opts.task, runtimeOwner: sdkOwner }); }
		catch (error) { lockError = `SDK context ownership rejected: ${String(error)}`; }
	}
	if (lockFiles && lockFiles.length > 0) {
		try {
			const board = new SharedBoard(join(cwd, ".agentflux"), { runtimeOwner: sdkOwner });
			for (const fp of lockFiles) {
				if (board.acquireFileLock(lockOwner, fp)) {
					lockedFiles.push(fp);
				} else {
					lockError = `file lock conflict: ${fp}`;
					break;
				}
			}
			if (lockError) board.releaseAllLocks(lockOwner);
		} catch (error: any) {
			lockError = `file lock error: ${error?.message ?? error}`;
		}
	}

	let retryCount = 0;
	let lastResult: AgentRunResult | null = null;
	let attemptCount = 0;
	let nativeForkTargetFile: string | undefined;
	let nativeForkTargetId: string | undefined;
	const aggregateUsage: AgentRunResult["usage"] = {
		turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0,
	};
	const aggregateProtocolErrors: string[] = [];
	let aggregateProtocolIncomplete = false;
	let aggregateCostComplete = true;
	let aggregateAttributionComplete = true;
	let modelError: string | undefined;
	let providerError: string | undefined;
	let observedProvider = opts.provider ?? agent.provider;
	const healthConfig = opts.health ?? DEFAULT_RUN_HEALTH_CONFIG;
	let currentPhase: AgentRunSnapshot["phase"] = "starting";
	let currentCostAccounting: AgentRunResult["costAccounting"];
	let currentHealth: AgentRunHealth = "healthy";
	// 以 Registry 注册后的时刻为进度基线；注册可能跨毫秒，不能再用更早的 runStartedAt 写回快照。
	let lastProgressAt = new Date().toISOString();
	let lastProgressType = "registered";
	let lastProgressSummary = opts.task.slice(0, 300);
	let healthWarningAt: string | undefined;
	let healthWarningCount = 0;
	let repeatActionSignature: string | undefined;
	let repeatActionCount = 0;
	let repeatActionWindowStartedAt: string | undefined;
	let contextPercent: number | undefined;
	let contextWindow: number | undefined;
	let contextTokensObserved = 0;
	let waitingForProvider = false;
	let registryDiagnosticCount = 0;
	let registryDiagnosticsSuppressed = false;
	const reportRegistryFailure = (operation: string, error: unknown): void => {
		registryDiagnosticCount += 1;
		if (registryDiagnosticCount <= 3) {
			console.error(`[flux run-registry] ${agent.name}/${processRunId} ${operation} failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`);
		} else if (!registryDiagnosticsSuppressed) {
			registryDiagnosticsSuppressed = true;
			console.error(`[flux run-registry] ${agent.name}/${processRunId} further ${operation} failures suppressed`);
		}
	};
	let parentBudgetSnapshotError: string | undefined;
	const parentBudget: AgentRunParentBudget = {
		maxCostUsd: opts.parentMaxCostUsd,
		maxTurns: opts.parentMaxTurns,
		maxInputTokens: opts.parentMaxInputTokens,
	};
	const writeLiveSnapshot = (snapshot: AgentRunSnapshot): boolean => {
		try {
			const record = updateSnapshotRun(fluxDir, processRunId, snapshot, parentBudget);
			if (record.status === "stop_requested" && record.error?.includes("parent ")) {
				parentBudgetSnapshotError = record.error;
			}
			return true;
		} catch (error) {
			// 在线遥测是 best-effort；不能把 Registry 故障伪装成业务错误或杀掉健康 child。
			reportRegistryFailure("online snapshot", error);
			return false;
		}
	};
	const classifyOnlineError = (message: unknown, output = ""): "model" | "provider" | undefined => {
		const text = typeof message === "string" ? message : String(message ?? "");
		if (!text || !isProviderOrModelError(text, output)) return undefined;
		if (isModelError(text)) {
			modelError = text.slice(0, 2000);
			return "model";
		}
		if (isExplicitProviderError(text, output)) {
			providerError = text.slice(0, 2000);
			return "provider";
		}
		return undefined;
	};
	const updateRepeatedAction = (signature: string, now = new Date().toISOString()): void => {
		if (signature === repeatActionSignature) repeatActionCount++;
		else {
			repeatActionSignature = signature;
			repeatActionCount = 1;
			repeatActionWindowStartedAt = now;
		}
	};
	const observeHealth = (phase: AgentRunSnapshot["phase"]): { health: AgentRunHealth; reason?: string; warning: boolean } => {
		const next = assessRunHealth({
			phase,
			nowMs: Date.now(),
			lastProgressAt,
			lastActivityAt: new Date().toISOString(),
			providerError,
			modelError,
			waitingForProvider,
			repeatActionSignature,
			repeatActionCount,
			contextPercent,
			contextWindow,
			contextTokens: contextTokensObserved,
		}, healthConfig);
		const warning = shouldEmitHealthWarning(currentHealth, next, Date.now(), healthWarningAt, healthConfig.warning_cooldown_ms);
		const changed = currentHealth !== next.health;
		if (changed || warning) {
			currentHealth = next.health;
			if (next.health !== "healthy" && warning) {
				healthWarningAt = new Date().toISOString();
				healthWarningCount++;
			}
			try { opts.onHealthChange?.({ health: next.health, reason: next.reason, warning }); } catch { /* UI/observer 回调失败不影响 child */ }
		}
		return { health: next.health, reason: next.reason, warning };
	};
	const persistHealth = (assessment: { health: AgentRunHealth; reason?: string }): void => {
		try {
			const update: AgentRunHealthUpdate = {
				health: assessment.health,
				reason: assessment.reason,
				lastProgressAt,
				lastProgressType,
				lastProgressSummary,
				healthWarningAt,
				healthWarningCount,
				repeatActionSignature,
				repeatActionCount,
				repeatActionWindowStartedAt,
			};
			updateHealthRun(fluxDir, processRunId, update);
		} catch (error) {
			reportRegistryFailure("health update", error);
		}
	};
	const refreshHealth = (): void => {
		const before = currentHealth;
		const next = observeHealth(currentPhase);
		if (before !== next.health || next.warning) persistHealth(next);
	};
	const absoluteUsage = (current?: AgentRunResult["usage"]): AgentRunSnapshot => ({
		phase: "running",
		turns: aggregateUsage.turns + usageNumber(current?.turns),
		input: aggregateUsage.input + usageNumber(current?.input),
		output: aggregateUsage.output + usageNumber(current?.output),
		cacheRead: aggregateUsage.cacheRead + usageNumber(current?.cacheRead),
		cacheWrite: aggregateUsage.cacheWrite + usageNumber(current?.cacheWrite),
		contextTokens: Math.max(usageNumber(aggregateUsage.contextTokens), usageNumber(current?.contextTokens)),
		costUsd: aggregateUsage.cost + usageNumber(current?.cost),
	});
	const activeRunSnapshot = (
		current: AgentRunResult["usage"] | undefined,
		fields: Pick<AgentRunSnapshot, "phase"> & Partial<Omit<AgentRunSnapshot, "phase" | "turns" | "input" | "output" | "cacheRead" | "cacheWrite" | "contextTokens" | "costUsd">>,
	): void => {
		currentPhase = fields.phase;
		contextTokensObserved = Math.max(contextTokensObserved, aggregateUsage.contextTokens, usageNumber(current?.contextTokens));
		const activityType = fields.lastActivityType;
		const semanticProgress = fields.lastProgressAt !== undefined
			|| ["process_started", "sdk_session_started", "message_end", "tool_start", "tool_end", "model_error", "provider_error"].includes(activityType ?? "");
		if (fields.lastProgressAt !== undefined) lastProgressAt = fields.lastProgressAt;
		else if (semanticProgress) lastProgressAt = fields.lastActivityAt ?? new Date().toISOString();
		if (fields.lastProgressType !== undefined) lastProgressType = fields.lastProgressType;
		else if (semanticProgress && activityType) lastProgressType = activityType;
		if (fields.lastProgressSummary !== undefined) lastProgressSummary = fields.lastProgressSummary;
		else if (semanticProgress && fields.lastActivitySummary) lastProgressSummary = fields.lastActivitySummary;
		const health = observeHealth(fields.phase);
		const usage = absoluteUsage(current);
		writeLiveSnapshot({
			...usage,
			...fields,
			costAccounting: currentCostAccounting,
			health: health.health,
			healthReason: health.reason ?? null,
			lastProgressAt,
			lastProgressType,
			lastProgressSummary,
			healthWarningAt,
			healthWarningCount,
			repeatActionSignature,
			repeatActionCount,
			repeatActionWindowStartedAt,
			attempt: attemptCount,
			lastActivityAt: fields.lastActivityAt ?? new Date().toISOString(),
			model: fields.model ?? opts.model ?? agent.model ?? undefined,
			provider: fields.provider ?? opts.provider ?? agent.provider ?? undefined,
			modelError: fields.modelError ?? modelError,
			providerError: fields.providerError ?? providerError,
		});
	};

	if (initialParentBudgetError || lockError || opts.signal?.aborted) {
		const preflightExitCode = initialParentBudgetError ? 75 : lockError ? 73 : 130;
		lastResult = {
			agent: agent.name,
			exitCode: preflightExitCode,
			output: "",
			usage: { ...aggregateUsage },
			model: null,
			errorMessage: initialParentBudgetError ?? lockError ?? "cancelled before start",
			retryCount: 0,
		};
		activeRunSnapshot(undefined, {
			phase: opts.signal?.aborted ? "stopping" : "error",
			lastActivityType: opts.signal?.aborted ? "stop_requested" : initialParentBudgetError ? "parent_budget_exhausted" : "start_rejected",
			lastActivitySummary: lastResult.errorMessage ?? "run rejected before start",
		});
	}

	while (retryCount <= maxRetries && ![73, 75, 76, 77, 130].includes(lastResult?.exitCode ?? -1)) {
		if (opts.signal?.aborted) {
			lastResult = {
				agent: agent.name, exitCode: 130, output: "", usage: { ...aggregateUsage }, model: null,
				errorMessage: "cancelled", retryCount: Math.max(0, attemptCount - 1),
			};
			activeRunSnapshot(undefined, { phase: "stopping", lastActivityType: "stop_requested", lastActivitySummary: "run cancelled before next attempt" });
			break;
		}
		if (opts.maxCostUsd !== undefined && aggregateUsage.cost >= opts.maxCostUsd) {
			lastResult = {
				agent: agent.name, exitCode: 75, output: "", usage: { ...aggregateUsage }, model: null,
				errorMessage: `budget exhausted: $${aggregateUsage.cost.toFixed(6)} >= $${opts.maxCostUsd.toFixed(6)}`,
				retryCount: Math.max(0, attemptCount - 1),
			};
			activeRunSnapshot(undefined, { phase: "stopping", lastActivityType: "budget_exhausted", lastActivitySummary: lastResult.errorMessage });
			break;
		}
		const attemptTimeoutMs = remainingDuration(deadline);
		if (attemptTimeoutMs !== undefined && attemptTimeoutMs <= 0) {
			lastResult ??= {
				agent: agent.name, exitCode: 124, output: "", usage: { ...aggregateUsage }, model: null,
				timedOut: true,
				errorMessage: "explicit deadline exhausted before child start", retryCount: Math.max(0, attemptCount - 1),
			};
			lastResult.exitCode = 124;
			lastResult.timedOut = true;
			lastResult.errorMessage = `explicit deadline (${deadlineLabel}) exhausted across retries/fallbacks`;
			activeRunSnapshot(undefined, { phase: "stopping", lastActivityType: "timeout", lastActivitySummary: lastResult.errorMessage });
			break;
		}
		// Native fork targets get a deterministic second branch per effective
		// role/capability generation. Never let reviewer and implementer append to
		// the same physical Pi file.
		if (opts.persistent && opts.persistentSessionFile && !nativeForkTargetFile) {
			const sDir = opts.sessionDir ?? join(cwd, ".agentflux", "runtime", "sessions");
			try {
				if (!opts.persistentSessionId) throw new Error("native fork requires a persistent base session ID");
				const branch = ensureCapabilityForkSession(
					opts.persistentSessionFile, cwd, sDir, opts.persistentSessionId, capabilityGeneration,
				);
				nativeForkTargetFile = branch.targetFile;
				nativeForkTargetId = branch.targetSessionId;
			} catch (error) {
				lastResult = {
					agent: agent.name, exitCode: 72, output: "",
					usage: { ...aggregateUsage }, model: null,
					errorMessage: `native capability fork rejected: ${error instanceof Error ? error.message : String(error)}`,
					retryCount: Math.max(0, attemptCount - 1),
				};
				activeRunSnapshot(undefined, { phase: "error", lastActivityType: "start_rejected", lastActivitySummary: lastResult.errorMessage });
				break;
			}
		}
		// 每次迭代重建 args (因为 tmpDir 路径会变)
		const attemptArgs: string[] = ["--mode", "json", "-p", "--no-prompt-templates", "--no-context-files", "--approve"];
		let attemptSessionId: string | undefined;
		let attemptSessionFile: string | undefined;

		// Persistent Agent 复用 session；Ephemeral Agent 不保留 session。
		if (opts.persistent) {
			const sDir = opts.sessionDir ?? join(cwd, ".agentflux", "runtime", "sessions");
			attemptArgs.push("--session-dir", sDir);
			if (opts.persistentSessionFile) {
				if (!nativeForkTargetFile || !nativeForkTargetId) throw new Error("native fork target was not materialized");
				attemptSessionId = nativeForkTargetId;
				attemptSessionFile = nativeForkTargetFile;
				attemptArgs.push("--session", nativeForkTargetFile);
			} else {
				const rawSessionId = `${opts.persistentSessionId ?? `flux-${agent.name}`}-cap-${capabilityGeneration}`;
				const agentSessionId = rawSessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
				attemptSessionId = agentSessionId;
				attemptArgs.push("--session-id", agentSessionId);
			}
		} else {
			attemptArgs.push("--no-session");
		}
		// Always disable discovery first. Explicit skills are the only resource
		// allowlist and must follow --no-skills in the CLI argv.
		attemptArgs.push("--no-skills");
		for (const skill of capabilityPolicy.effective.skills) attemptArgs.push("--skill", skill);
		// --no-extensions remains unconditional; only the package-owned safe entry
		// is loaded, independently of cache/prefix layout.
		attemptArgs.push("--no-extensions", "-e", getSubagentEntryPath(cwd));
		const model = opts.model ?? agent.model ?? null;
		const provider = opts.provider ?? agent.provider ?? null;
		if (provider) {
			observedProvider = provider;
			attemptArgs.push("--provider", provider);
		}
		if (model) attemptArgs.push("--model", model);
		attemptArgs.push("--thinking", thinkingLevel);
		if (capabilityPolicy.effective.tools.length > 0) attemptArgs.push("--tools", capabilityPolicy.effective.tools.join(","));
		else attemptArgs.push("--no-tools");

		let tmpDir: string | null = null;
		if (agent.systemPrompt.trim()) {
			tmpDir = mkdtempSync(join(tmpdir(), "flux-agent-"));
			const tmpPrompt = join(tmpDir, "prompt.md");
			writeFileSync(tmpPrompt, agent.systemPrompt, "utf-8");
			attemptArgs.push("--append-system-prompt", tmpPrompt);
		}
		attemptArgs.push(`Task: ${taskWithInbox}`);

		const result: AgentRunResult = {
			agent: agent.name, role: capabilityRole, backend: runtimeMode, sdkOwner, exitCode: 0, output: "",
			sessionId: attemptSessionId,
			sessionFile: attemptSessionFile,
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
			model: null,
			invocation: invocationProvenance,
			invocationDescriptor,
			protocolErrors: [],
			incomplete: false,
			retryCount,
			fallbackModel: opts.fallbackHistory && opts.fallbackHistory.length > 1 ? (opts.model ?? agent.model ?? undefined) : undefined,
			fallbackFrom: opts.fallbackHistory && opts.fallbackHistory.length > 1 ? opts.fallbackHistory[0] : undefined,
		};
		attemptCount++;
		const sDir = opts.sessionDir ?? join(cwd, ".agentflux", "runtime", "sessions");
		const accounting = new UsageAccounting({ sessionId: attemptSessionId ?? `${processRunId}:${attemptCount}`, pricing: opts.pricing });
		const syncUsage = (): void => {
			const snapshot = accounting.snapshot();
			Object.assign(result.usage, { turns: snapshot.turns, input: snapshot.input, output: snapshot.output, cacheRead: snapshot.cacheRead, cacheWrite: snapshot.cacheWrite, cost: snapshot.cost });
			result.costAccounting = { complete: snapshot.complete && !result.incomplete, attributionComplete: snapshot.attributionComplete, provisional: snapshot.provisional };
			currentCostAccounting = { complete: aggregateCostComplete && result.costAccounting.complete, attributionComplete: aggregateAttributionComplete && snapshot.attributionComplete, provisional: snapshot.provisional };
		};

		try {
			const baselineFile = attemptSessionFile ?? (attemptSessionId ? resolveSessionFileById(sDir, attemptSessionId) : undefined);
			if (baselineFile) accounting.setBaselineEntryIds(parseSessionEntries(readFileSync(baselineFile, "utf8")).flatMap(entry => "id" in entry ? [entry.id] : []));
			const sdkDriver = runtimeMode === "sdk" ? await createSdkRunDriver({ binding: sdkBinding!, owner: sdkOwner!,
				controlCwd: cwd, cwd: workspaceCwd, runId: processRunId, agentName: agent.name, instanceId: agentInstanceId, role: capabilityRole, taskId: opts.taskId,
				model: model ?? "", provider: provider ?? undefined, thinking: thinkingLevel, appendSystemPrompt: agent.systemPrompt,
				capability: capabilityPolicy.effective, lockFiles: lockFiles ?? [], startupMessageIds: inboxInjection.v2MessageIds,
				persistent: opts.persistent === true, sessionId: attemptSessionId, sessionFile: baselineFile, sessionDir: sDir, signal: opts.signal }) : undefined;
			if (sdkDriver) { result.sessionId = sdkDriver.sessionId; result.sessionFile = sdkDriver.sessionFile; }
			const outputParts: string[] = [];
			const assistantMessages: string[] = [];
			let lastAssistantError: string | undefined;
			let stderrBuf = "";
			const exitCode = await new Promise<number>((resolveExit) => {
				const invocation = opts.invocationOverride
					? { command: opts.invocationOverride.command, args: [...opts.invocationOverride.args, ...attemptArgs] }
					: { command: defaultInvocation!.command, args: [...defaultInvocation!.args, ...attemptArgs] };
				const proc = sdkDriver ? undefined : spawn(invocation.command, invocation.args, {
					cwd: workspaceCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					// Keep each Run in its own process group on every host. On Windows this
					// prevents an abrupt parent-Pi termination from implicitly killing the
					// child Run before restart recovery can observe its stale heartbeat;
					// explicit stop/deadline paths still taskkill this Run with /T.
					detached: true,
					windowsHide: true,
					env: {
						...process.env,
						...(opts.env ?? {}),
						AGENTFLUX_AGENT_NAME: agent.name,
						AGENTFLUX_AGENT_ROLE: capabilityRole,
						AGENTFLUX_AGENT_INSTANCE_ID: agentInstanceId,
						AGENTFLUX_RUN_ID: processRunId,
						AGENTFLUX_TASK_ID: opts.taskId ?? "",
						AGENTFLUX_CONTROL_CWD: cwd,
						AGENTFLUX_WORKSPACE_CWD: workspaceCwd,
						AGENTFLUX_LOCK_FILES: JSON.stringify(lockFiles ?? []),
						AGENTFLUX_COMMUNICATION_POLICY: JSON.stringify(communicationPolicy),
						AGENTFLUX_CAPABILITY_POLICY: JSON.stringify(capabilityPolicy.effective),
						AGENTFLUX_RPC_INBOX_PUMP: opts.persistent ? "1" : "",
						AGENTFLUX_STARTUP_MESSAGE_IDS: JSON.stringify(inboxInjection.v2MessageIds),
					},
				});
				let startupFailure: string | undefined;
				try {
					if (sdkDriver) markSdkAgentRunRunning(fluxDir, processRunId, sdkOwner!, sdkDriver.sessionId, attemptCount, { model, provider });
					else {
						if (!proc?.pid) throw new Error(`Agent process did not expose a pid: ${processRunId}`);
						markRunningRun(fluxDir, processRunId, proc.pid, attemptCount, { model, provider, processIdentity: undefined });
					}
					activeRunSnapshot(undefined, {
						phase: "running", lastActivityType: sdkDriver ? "sdk_session_started" : "process_started",
						lastActivitySummary: sdkDriver ? `SDK session started (${sdkDriver.sessionId}, attempt ${attemptCount})` : `child process started (pid ${proc!.pid}, attempt ${attemptCount})`, model, provider,
					});
				} catch (error: any) {
					startupFailure = `Run Registry start failed: ${error?.message ?? error}`;
					result.errorMessage = startupFailure;
					reportRegistryFailure("start", error);
					// Keep the same listeners, usage ledger and process ownership until actual exit.
				}
				const jsonlParser = new IncrementalJsonlParser<any>();
				let settled = false;
				let assistantMessageOpen = false;
				let userWaitDepth = 0;
				let phaseBeforeUserWait = currentPhase;
				let providerWaitBeforeUserWait = false;
				let provisionalMessageUsage: AgentRunResult["usage"] | undefined;
				let sawAgentSettled = false;
				let boundaryGeneration = 0;
				let sawValidBoundaryReceipt = false;
				let sawInvalidBoundaryReceipt = false;
				let assistantSource: string | undefined;
				let assistantSequence = 0;
				let lastBoundaryReceipt: AgentBoundaryReceiptDetails | null = null;
				let latestSettledGeneration = 0;
				let forcedExitCode: number | null = null;
				let terminationPromise: Promise<void> | null = null;
				let identityObservation: Promise<void> = Promise.resolve();
				let killGraceTimer: NodeJS.Timeout | undefined;
				let controlTimer: NodeJS.Timeout | undefined;
				let deadlineTimer: NodeJS.Timeout | undefined;
				const done = (code: number) => {
					if (!settled) {
						settled = true;
						activeSubagentProcesses.delete(processRunId);
						opts.signal?.removeEventListener("abort", onAbort);
						if (killGraceTimer) clearTimeout(killGraceTimer);
						if (deadlineTimer) clearTimeout(deadlineTimer);
						if (controlTimer) clearInterval(controlTimer);
						resolveExit(code);
					}
				};
				const requestTermination = (exitCode: number) => {
					if (forcedExitCode !== null) return;
					forcedExitCode = exitCode;
					if (exitCode === 124) result.timedOut = true;
					activeRunSnapshot(result.usage, {
						phase: "stopping",
						lastActivityAt: new Date().toISOString(),
						lastActivityType: exitCode === 124 ? "timeout" : exitCode === 130 ? "stop_requested" : "limit_reached",
						lastActivitySummary: exitCode === 124 ? "run timeout requested" : exitCode === 130 ? "run cancellation requested" : `run termination requested (exit ${exitCode})`,
						model,
						provider,
					});
					// A Windows parent may emit close before taskkill /T has finished
					// reaping its descendants. Keep the caller blocked on the tree-kill
					// command so a cancelled run cannot report completion while child
					// processes still hold files or consume resources.
					terminationPromise = identityObservation.then(() => sdkDriver ? sdkDriver.abort() : terminateProcessTree(proc!)).then(accepted => {
						if (!accepted) {
							result.errorMessage = [result.errorMessage, "Process termination refused or failed: birth identity or signal delivery could not be verified"].filter(Boolean).join("; ");
							activeRunSnapshot(result.usage, {
								phase: "stopping", lastActivityType: "termination_refused",
								lastActivitySummary: result.errorMessage, model, provider,
							});
							// Keep the Run active until its actual close; a refusal is not exit evidence.
							return;
						}
						if (!settled && proc) killGraceTimer = setTimeout(() => {
							if (proc.exitCode !== null || proc.signalCode !== null) done(exitCode);
							else activeRunSnapshot(result.usage, {
								phase: "stopping", lastActivityType: "termination_pending",
								lastActivitySummary: "Termination has not produced exit evidence; retaining process ownership", model, provider,
							});
						}, 10_000);
					}).catch(error => {
						result.errorMessage = [result.errorMessage, `Process termination failed: ${String(error)}`].filter(Boolean).join("; ");
						activeRunSnapshot(result.usage, { phase: "stopping", lastActivityType: "termination_refused", lastActivitySummary: result.errorMessage, model, provider });
					});
				};
				const onAbort = () => requestTermination(130);
				activeSubagentProcesses.set(processRunId, sdkDriver ?? proc!);
				opts.signal?.addEventListener("abort", onAbort, { once: true });
				let lastHeartbeatAttemptAt = Date.now();
				let lastHealthRefreshAt = Date.now();
				controlTimer = setInterval(() => {
					const stopRequest = readAgentRunStop(cwd, processRunId);
					if (stopRequest) {
						try { markAgentRunStopRequested(fluxDir, processRunId); }
						catch (error) { reportRegistryFailure("stop request", error); }
						requestTermination(130);
					}
					// The 200ms control tick is only a scheduler. A failed heartbeat is
					// retried at the bounded interval and never kills a healthy child.
					if (Date.now() - lastHeartbeatAttemptAt >= 2_000) {
						lastHeartbeatAttemptAt = Date.now();
						try {
							heartbeatRun(fluxDir, processRunId);
						} catch (error: any) {
							reportRegistryFailure("heartbeat", error);
						}
					}
					if (Date.now() - lastHealthRefreshAt >= 1_000) {
						lastHealthRefreshAt = Date.now();
						refreshHealth();
					}
				}, 200);
				const provisionalSnapshot = (): AgentRunResult["usage"] => { syncUsage(); return { ...result.usage }; };
				const recordProtocolIssue = (issue: JsonlStreamIssue): void => {
					try { opts.onProtocolIssue?.(issue); } catch { /* observer failure cannot hide protocol failure */ }
					const detail = `${issue.kind}${issue.sequence === undefined ? "" : ` frame=${issue.sequence}`}: ${issue.message}`;
					if (!result.protocolErrors?.includes(detail)) result.protocolErrors?.push(detail);
					if (issue.incomplete) result.incomplete = true;
					result.errorMessage = [result.errorMessage, `Pi JSONL protocol error: ${detail}`].filter(Boolean).join("; ");
					activeRunSnapshot(provisionalSnapshot(), {
						phase: "error", lastActivityType: "jsonl_protocol_error",
						lastActivitySummary: detail.slice(0, 2000), model, provider,
					});
				};
				const processEvent = (ev: any) => {
					if (settled) return;
					if (!ev || typeof ev !== "object" || Array.isArray(ev) || typeof ev.type !== "string") {
						recordProtocolIssue({ kind: "invalid_record", message: "Pi JSONL event is missing a string type", incomplete: true });
						return;
					}
					if (ev.type === "agent_start") {
						boundaryGeneration++;
						sawAgentSettled = false;
						lastBoundaryReceipt = null;
					}
					if (ev.type === "compaction_end" && ev.result?.usage && !opts.persistent && !sdkDriver) {
						accounting.ingestEntry({ ...ev.result, type: "compaction", id: `${processRunId}:${attemptCount}:summary:${assistantSequence}`, usage: ev.result.usage });
						syncUsage();
					}
					if (ev.type === "ui_prompt_start") {
						if (userWaitDepth++ === 0) { phaseBeforeUserWait = currentPhase; providerWaitBeforeUserWait = waitingForProvider; }
						waitingForProvider = false;
						activeRunSnapshot(result.usage, { phase: "waiting_user", lastActivityType: "ui_prompt_start", lastActivitySummary: "waiting for user input" });
						return;
					}
					if (ev.type === "ui_prompt_end") {
						if (userWaitDepth > 0) userWaitDepth--;
						if (userWaitDepth === 0) {
							waitingForProvider = providerWaitBeforeUserWait;
							activeRunSnapshot(result.usage, { phase: phaseBeforeUserWait, lastActivityType: "ui_prompt_end", lastActivitySummary: "user input wait ended", lastProgressAt: new Date().toISOString() });
						}
						return;
					}
					if (ev.type === "message_start") {
						if (ev.message?.role === "assistant") {
							assistantSource = `${processRunId}:${attemptCount}:assistant:${++assistantSequence}`;
							assistantMessageOpen = true;
							provisionalMessageUsage = undefined;
						}

						waitingForProvider = true;
						activeRunSnapshot(result.usage, {
							phase: "running", lastActivityType: "provider_request",
							lastActivitySummary: "waiting for provider response", model, provider,
						});
						return;
					}
					if (ev.type === "message_update") {
						const assistantMessageEvent = ev.assistantMessageEvent;
						if (!assistantMessageEvent || typeof assistantMessageEvent.type !== "string") {
							recordProtocolIssue({ kind: "invalid_record", message: "message_update is missing assistantMessageEvent.type", incomplete: true });
							return;
						}
						assistantMessageOpen = true;
						const rawUsage = ev.usage;
						if (rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)) {
							accounting.ingestStream(ev, { sourceId: assistantSource });
							const counters = usageCountersFromJson(rawUsage);
							provisionalMessageUsage = {
								turns: 1,
								input: counters.input,
								output: counters.output,
								cacheRead: counters.cacheRead,
								cacheWrite: counters.cacheWrite,
								contextTokens: counters.contextTokens,
								cost: counters.cost,
							};
							activeRunSnapshot(provisionalSnapshot(), {
								phase: "running", lastActivityType: "message_update",
								lastActivitySummary: `assistant ${assistantMessageEvent.type} (provisional usage)`, model, provider,
							});
							if (parentBudgetSnapshotError || (opts.maxCostUsd !== undefined && aggregateUsage.cost + result.usage.cost >= opts.maxCostUsd)) {
								result.errorMessage = parentBudgetSnapshotError ?? "run budget exhausted during provisional usage";
								requestTermination(75);
							}
						}
						return;
					}
					if (ev.type === "message_end" && !ev.message) {
						recordProtocolIssue({ kind: "invalid_record", message: "message_end is missing its authoritative message", incomplete: true });
						return;
					}
					if (ev.type === "message_end" && ev.message) {
						waitingForProvider = false;
						const msg = ev.message;
						accounting.settleStream(ev, { sourceId: msg.role === "assistant" ? assistantSource : undefined });
						syncUsage();
						if (opts.maxCostUsd !== undefined && aggregateUsage.cost + result.usage.cost >= opts.maxCostUsd) {
							result.errorMessage = "run budget exhausted at finalized usage";
							requestTermination(75);
						}
						if (msg.role !== "assistant") {
							activeRunSnapshot(result.usage, { phase: "running", lastActivityType: "usage_settled", lastActivitySummary: "tool usage settled", model, provider });
							if (parentBudgetSnapshotError) { result.errorMessage = parentBudgetSnapshotError; requestTermination(75); }
							return;
						}
						assistantMessageOpen = false;
						provisionalMessageUsage = undefined;
						if (!msg.usage || typeof msg.usage !== "object" || Array.isArray(msg.usage)) {
							recordProtocolIssue({ kind: "invalid_record", message: "assistant message_end is missing a complete usage snapshot", incomplete: true });
						}
						const u = msg.usage && typeof msg.usage === "object" ? msg.usage : {};
						if (typeof u.contextWindow === "number" && Number.isFinite(u.contextWindow) && u.contextWindow > 0) contextWindow = u.contextWindow;
						result.usage.contextTokens = Math.max(result.usage.contextTokens, usageNumber(u.totalTokens ?? u.contextTokens));
						if (typeof u.contextPercent === "number" && Number.isFinite(u.contextPercent)) contextPercent = u.contextPercent;
						else if (contextWindow && result.usage.contextTokens > 0) contextPercent = result.usage.contextTokens / contextWindow;
						if (typeof msg.model === "string") result.model = msg.model;
						if (typeof msg.responseModel === "string") result.responseModel = msg.responseModel;
						if (typeof msg.provider === "string") result.provider = msg.provider;
						if (typeof msg.thinkingLevel === "string") result.thinkingLevel = msg.thinkingLevel;
						const messageError = (msg.errorMessage === undefined || msg.errorMessage === null ? "" : String(msg.errorMessage))
							|| (msg.stopReason === "error" ? "assistant ended with error" : msg.stopReason === "aborted" ? "assistant aborted" : "");
						// Pi 的自动重试可在同一进程内恢复。只替换 assistant 自己的结局，不能清除 Host 终止/预算/存储错误。
						if (forcedExitCode === null && (!result.errorMessage || result.errorMessage === lastAssistantError)) {
							if (messageError) result.errorMessage = lastAssistantError = messageError;
							else if (msg.stopReason === "stop" || msg.stopReason === "toolUse" || msg.stopReason === "deferred") result.errorMessage = lastAssistantError = undefined;
						}
						if (typeof msg.provider === "string" && msg.provider.trim()) observedProvider = msg.provider;
						const textBlocks: string[] = [];
						if (Array.isArray(msg.content)) {
							for (const block of msg.content) if (block?.type === "text" && typeof block.text === "string" && block.text) {
								textBlocks.push(block.text);
								outputParts.push(block.text);
								assistantMessages.push(block.text);
							}
						}
						const errorClass = messageError ? classifyOnlineError(messageError, textBlocks.join("\n")) : undefined;
						const activitySummary = (messageError || textBlocks.at(-1) || "assistant message completed").replace(/\s+/g, " ").slice(0, 2000);
						activeRunSnapshot(result.usage, {
							phase: errorClass ? "error" : "running",
							model: typeof msg.model === "string" ? msg.model : model,
							provider: observedProvider ?? provider,
							lastActivityType: errorClass === "model" ? "model_error" : errorClass === "provider" ? "provider_error" : "message_end",
							lastActivitySummary: activitySummary,
						});
						const aggregateParentError = parentBudgetError(false);
						if (aggregateParentError) {
							result.errorMessage = aggregateParentError;
							activeRunSnapshot(result.usage, { phase: "stopping", lastActivityType: "parent_budget_exhausted", lastActivitySummary: aggregateParentError, model, provider });
							requestTermination(75);
						}
						for (const text of textBlocks) {
							try { opts.onProgress?.({ type: "message", text }); } catch { /* UI 回调失败不影响 child */ }
						}
						if (opts.maxTurns !== undefined && result.usage.turns >= opts.maxTurns) {
							result.errorMessage = `turn limit reached: ${result.usage.turns} >= ${opts.maxTurns}`;
							activeRunSnapshot(result.usage, { phase: "stopping", lastActivityType: "limit_reached", lastActivitySummary: result.errorMessage, model, provider });
							requestTermination(74);
						} else if (opts.maxInputTokens !== undefined && result.usage.input >= opts.maxInputTokens) {
							result.errorMessage = `input token limit reached: ${result.usage.input} >= ${opts.maxInputTokens}`;
							activeRunSnapshot(result.usage, { phase: "stopping", lastActivityType: "limit_reached", lastActivitySummary: result.errorMessage, model, provider });
							requestTermination(74);
						}
					} else if (ev.type === "tool_execution_start") {
						waitingForProvider = false;
						const toolName = typeof ev.toolName === "string" ? ev.toolName : typeof ev.name === "string" ? ev.name : "tool";
						const input = ev.args;
						const inputText = input && typeof input === "object" ? JSON.stringify(input).slice(0, 200) : typeof input === "string" ? input.slice(0, 200) : "";
						const activity = `${toolName}${inputText ? ` ${inputText}` : ""}`;
						updateRepeatedAction(`${toolName}:${inputText}`);
						activeRunSnapshot(result.usage, { phase: "tool", lastActivityType: "tool_start", lastActivitySummary: activity, model, provider });
						try { opts.onProgress?.({ type: "tool", text: activity }); } catch { /* UI 回调失败不影响 child */ }
					} else if (ev.type === "tool_execution_end" || ev.type === "tool_result") {
						waitingForProvider = false;
						const toolName = typeof ev.toolName === "string" ? ev.toolName : typeof ev.name === "string" ? ev.name : "tool";
						const summary = typeof ev.error === "string" ? `${toolName} failed: ${ev.error}` : `${toolName} completed`;
						activeRunSnapshot(result.usage, { phase: "running", lastActivityType: "tool_end", lastActivitySummary: summary, model, provider });
					}
					if (parentBudgetSnapshotError && forcedExitCode === null) {
						result.errorMessage = parentBudgetSnapshotError;
						requestTermination(75);
					}
				};

				const consumeJsonl = (items: ReturnType<typeof jsonlParser.push>): void => {
					for (const item of items) {
						if (item.kind === "error") {
							recordProtocolIssue(item.error);
							continue;
						}
						const context: AgentRunnerJsonEventContext = { sequence: item.frame.sequence, raw: item.frame.text };
						const record = item.record as Record<string, unknown>;
						try {
							opts.onEvent?.(record, context);
							if (typeof record.type === "string") opts.onJsonEvent?.(record, context);
						} catch (error) {
							recordProtocolIssue({
								kind: "consumer_error", incomplete: true,
								message: `JSONL event consumer failed: ${error instanceof Error ? error.message : String(error)}`,
							});
							continue;
						}
						if (record.type === "entry_appended") {
							const entry = record.entry;
							const receipt = readAgentBoundaryReceipt(entry);
							if (receipt && receipt.generation === boundaryGeneration) { sawValidBoundaryReceipt = true; lastBoundaryReceipt = receipt; }
							else if (receipt) sawInvalidBoundaryReceipt = true;
							else if (entry && typeof entry === "object"
								&& (entry as Record<string, unknown>).customType === AGENTFLUX_BOUNDARY_RECEIPT_CUSTOM_TYPE) sawInvalidBoundaryReceipt = true;
							accounting.ingestEntry(entry as any);
							syncUsage();
							if ((entry as any)?.usage || (entry as any)?.message?.usage) {
								activeRunSnapshot(result.usage, { phase: currentPhase, lastActivityType: "usage_entry", lastActivitySummary: "session usage entry accounted", model, provider });
								if (parentBudgetSnapshotError || (opts.maxCostUsd !== undefined && aggregateUsage.cost + result.usage.cost >= opts.maxCostUsd)) {
									result.errorMessage = parentBudgetSnapshotError ?? "run budget exhausted at session usage entry";
									requestTermination(75);
								}
							}
							try { opts.onEntry?.(entry, context); }
							catch (error) {
								recordProtocolIssue({
									kind: "consumer_error", incomplete: true,
									message: `JSONL entry consumer failed: ${error instanceof Error ? error.message : String(error)}`,
								});
								continue;
							}
						}
						if (record.type === "agent_settled") {
							sawAgentSettled = true;
							latestSettledGeneration = lastBoundaryReceipt?.generation ?? 0;
						}
						processEvent(record);
					}
				};
				let sdkEventSequence = 0;
				sdkDriver?.on("event", (event: any) => {
					const text = JSON.stringify(event);
					consumeJsonl([{ kind: "record", record: event, frame: { sequence: ++sdkEventSequence, text } }]);
				});
				const lifecycle: { on(event: string, listener: (...args: any[]) => void): unknown } = sdkDriver ?? proc!;
				proc?.stdout?.on("data", (data) => {
					if (settled) return;
					consumeJsonl(jsonlParser.push(data as Uint8Array));
				});
				proc?.stderr?.on("data", (data) => { if (!settled) stderrBuf += data.toString(); });
				lifecycle.on("error", (err: Error) => {
					if (settled) return;
					result.errorMessage = `${sdkDriver ? "SDK session" : "spawn"} error: ${err.message}`;
					activeRunSnapshot(result.usage, { phase: "error", lastActivityType: "spawn_error", lastActivitySummary: result.errorMessage, model, provider });
					if (deadlineTimer) clearTimeout(deadlineTimer);
					if (!sdkDriver) done(forcedExitCode ?? 1);
				});
				lifecycle.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
					if (settled) return;
					if (deadlineTimer) clearTimeout(deadlineTimer);
					consumeJsonl(jsonlParser.finish());
					if (sdkDriver) { accounting.ingestEntries(sdkDriver.getEntries() as any); syncUsage(); }
					if (assistantMessageOpen) {
						recordProtocolIssue({ kind: "truncated_frame", message: "assistant stream ended before message_end", incomplete: true });
					}
					if (requireBoundaryReceipt && forcedExitCode === null && (code ?? 1) === 0
						&& (!sawAgentSettled || !sawValidBoundaryReceipt || sawInvalidBoundaryReceipt || !lastBoundaryReceipt || latestSettledGeneration !== boundaryGeneration || latestSettledGeneration !== lastBoundaryReceipt.generation || lastBoundaryReceipt.continueRequested)) {
						recordProtocolIssue({
							kind: "invalid_record", incomplete: true,
							message: `missing valid settle boundary receipt (agent_settled=${sawAgentSettled}, receipt=${sawValidBoundaryReceipt})`,
						});
					}
					if (requireBoundaryReceipt && lastBoundaryReceipt?.terminalFailure) result.errorMessage ??= `Pi boundary ${lastBoundaryReceipt.outcome}`;
					const resolvedCode = forcedExitCode ?? code ?? 1;
					if (forcedExitCode === null && signal) result.errorMessage = `child process terminated by signal ${signal}`;
					if (resolvedCode === 124 && !result.errorMessage) {
						result.errorMessage = `explicit deadline (${deadlineLabel}) exhausted`;
					}
					activeRunSnapshot(result.usage, {
						phase: result.errorMessage ? "error" : "running",
						lastActivityType: sdkDriver ? result.errorMessage ? "sdk_error" : "sdk_closed" : result.errorMessage ? "process_error" : "process_exit",
						lastActivitySummary: result.errorMessage?.slice(0, 2000) ?? (sdkDriver ? `SDK session drained and disposed (${resolvedCode})` : `child process exited (${resolvedCode})`),
						model: result.model ?? model,
						provider,
					});
					void (terminationPromise ?? identityObservation).finally(() => done(resolvedCode));
				});
				identityObservation = proc?.pid ? observeProcessAsync(proc.pid).then(observation => {
					if (settled || proc.exitCode !== null || proc.signalCode !== null || observation.state !== "alive") return;
					childProcessIdentities.set(proc, observation.identity);
					try { bindAgentRunProcessIdentity(fluxDir, processRunId, attemptCount, observation.identity); }
					catch (error) { reportRegistryFailure("process identity binding", error); }
				}).catch(error => { reportRegistryFailure("process identity observation", error); }) : Promise.resolve();
				if (startupFailure) requestTermination(72);
				if (opts.signal?.aborted || readAgentRunStop(cwd, processRunId)) {
					try { markAgentRunStopRequested(fluxDir, processRunId); }
					catch (error) { reportRegistryFailure("stop request", error); }
					requestTermination(130);
				}
				// Startup work (including birth inspection) consumes the absolute deadline.
				const remaining = remainingDuration(deadline);
				if (remaining !== undefined) {
					if (remaining <= 0) requestTermination(124);
					else deadlineTimer = setTimeout(() => requestTermination(124), remaining);
				}
				sdkDriver?.start(`Task: ${taskWithInbox}`);
			});

			result.exitCode = exitCode;
			result.output = outputParts.join("\n").slice(0, 50 * 1024);
			result.assistantMessages = assistantMessages;
			// pi may surface a provider failure in message_end but still let its CLI
			// process exit 0. A result with errorMessage is never a successful run.
			if (result.exitCode === 0 && result.errorMessage) result.exitCode = 1;
			if (stderrBuf.trim() && result.exitCode !== 0) result.errorMessage = (result.errorMessage ?? "") + ` stderr: ${stderrBuf.slice(0, 500)}`;
			const onlineErrorClass = classifyOnlineError(result.errorMessage, result.output);
			if (onlineErrorClass) {
				activeRunSnapshot(result.usage, {
					phase: "error",
					lastActivityType: onlineErrorClass === "model" ? "model_error" : "provider_error",
					lastActivitySummary: result.errorMessage?.slice(0, 2000) ?? "provider/model error",
					model: result.model ?? model,
					provider,
				});
			}
		} catch (error) {
			result.exitCode = 72;
			result.errorMessage = `Agent driver startup failed: ${error instanceof Error ? error.message : String(error)}`;
			activeRunSnapshot(result.usage, { phase: "error", lastActivityType: "start_rejected", lastActivitySummary: result.errorMessage, model, provider });
		} finally {
			if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } }
		}

		if (opts.persistent && attemptSessionId) {
			try {
				const file = attemptSessionFile ?? resolveSessionFileById(sDir, attemptSessionId);
				if (!file && !opts.invocationOverride) throw new Error("Persistent Pi session was not found after child exit");
				if (file) {
					result.sessionFile = file;
					accounting.ingestEntries(parseSessionEntries(readFileSync(file, "utf8")) as any);
				}
			} catch (error) {
				result.incomplete = true;
				result.errorMessage ??= `Pi accounting session read failed: ${String(error)}`;
				if (result.exitCode === 0) result.exitCode = 1;
			}
		}
		syncUsage();
		aggregateCostComplete &&= result.costAccounting?.complete === true;
		aggregateAttributionComplete &&= result.costAccounting?.attributionComplete === true;
		lastResult = result;
		aggregateUsage.turns += usageNumber(result.usage.turns);
		aggregateUsage.input += usageNumber(result.usage.input);
		aggregateUsage.output += usageNumber(result.usage.output);
		aggregateUsage.cacheRead += usageNumber(result.usage.cacheRead);
		aggregateUsage.cacheWrite += usageNumber(result.usage.cacheWrite);
		aggregateUsage.cost += usageNumber(result.usage.cost);
		aggregateUsage.contextTokens = Math.max(aggregateUsage.contextTokens, usageNumber(result.usage.contextTokens));
		for (const error of result.protocolErrors ?? []) if (!aggregateProtocolErrors.includes(error)) aggregateProtocolErrors.push(error);
		aggregateProtocolIncomplete ||= result.incomplete === true;
		// A malformed or incomplete JSONL boundary is a Host protocol failure,
		// not a provider retry candidate. Do not let a later attempt erase it.
		if (aggregateProtocolErrors.length > 0) break;

		// 成功 → 返回 (exitCode=0 且无 errorMessage)
		if (result.exitCode === 0 && !result.errorMessage) {
			break;
		}

		// 失败 → 判断是否应该重试
		if ([72, 74, 75, 130].includes(result.exitCode) || opts.signal?.aborted) break;
		const isTimeout = result.timedOut === true;
		const isProcessError = result.exitCode !== 0 && !isTimeout;
		const modelErr = isModelError(result.errorMessage);
		const transientErr = isTransientError(result.errorMessage, result.output);
		const providerCompatibilityErr = isProviderCompatibilityError(result.errorMessage);
		const providerQuotaErr = isProviderQuotaError(result.errorMessage, result.output);
		const explicitProviderErr = isExplicitProviderError(result.errorMessage, result.output);

		const tryModelFallback = (avoidCurrentProvider = false): boolean => {
			if (!opts.enableModelFallback || !opts.modelsForFallback || !opts.roleRequirementForFallback) return false;
			const currentModel = opts.model ?? agent.model ?? "";
			const currentProvider = opts.provider ?? agent.provider ?? opts.modelsForFallback[currentModel]?.provider;
			const tried = opts.fallbackHistory ?? [currentModel];
			const fallback = selectFallbackModel(
				currentModel, currentProvider, tried, opts.modelsForFallback,
				opts.roleRequirementForFallback, avoidCurrentProvider,
			);
			if (!fallback || tried.includes(fallback)) return false;

			console.error(`[flux subagent] ${agent.name} model/provider "${currentModel}" unavailable, degrading to "${fallback}"...`);
			opts.model = fallback;
			opts.fallbackHistory = [...tried, fallback];
			if (opts.modelsForFallback[fallback]?.provider) {
				opts.provider = opts.modelsForFallback[fallback].provider;
			}
			activeRunSnapshot(undefined, {
				phase: "retrying",
				lastActivityType: "model_switch",
				lastActivitySummary: `switching model/provider from ${currentModel || "default"} to ${fallback}`,
				model: fallback,
				provider: opts.provider ?? opts.modelsForFallback[fallback]?.provider,
			});
			return true;
		};

		// 余额、月额度和计费错误只能跨 provider 降级；没有健康通道时立即失败。
		// 不能落入 isProcessError 的同 provider 重试分支。
		if (providerQuotaErr) {
			if (tryModelFallback(true)) continue;
			break;
		}

		// 明确的模型或 provider 不兼容错误无需重复相同请求，直接降级。
		if ((modelErr || providerCompatibilityErr) && tryModelFallback()) continue;

		if (retryCount < maxRetries && (isTimeout || isProcessError || modelErr || transientErr || providerCompatibilityErr)) {
			const baseDelay = transientErr ? 5000 : retryDelayMs;  // 502/503 退避更久
			const delay = baseDelay * Math.pow(2, retryCount);  // 指数退避
			const remainingBeforeRetry = remainingDuration(deadline);
			if (remainingBeforeRetry !== undefined && remainingBeforeRetry <= delay) {
				result.exitCode = 124;
				result.timedOut = true;
				result.errorMessage = `explicit deadline (${deadlineLabel}) exhausted before retry`;
				activeRunSnapshot(undefined, { phase: "stopping", lastActivityType: "timeout", lastActivitySummary: result.errorMessage, model, provider });
				break;
			}
			const reason = isTimeout ? `timeout (${deadlineLabel})` : modelErr ? `model error: ${result.errorMessage?.slice(0, 60)}` : providerCompatibilityErr ? `provider compatibility: ${result.errorMessage?.slice(0, 60)}` : transientErr ? `transient: ${result.errorMessage?.slice(0, 60) ?? result.output.slice(0, 60)}` : `exit code ${result.exitCode}`;
			const retrySummary = `${reason}, retry ${retryCount + 1}/${maxRetries} after ${delay}ms`;
			console.error(`[flux subagent] ${agent.name} failed (${reason}), retrying ${retryCount + 1}/${maxRetries} in ${delay}ms...`);
			activeRunSnapshot(undefined, { phase: "backoff", lastActivityType: "retry_backoff", lastActivitySummary: retrySummary, model, provider });
			if (!await waitForRetry(delay, opts.signal)) {
				result.exitCode = 130;
				result.errorMessage = "cancelled during retry backoff";
				activeRunSnapshot(undefined, { phase: "stopping", lastActivityType: "stop_requested", lastActivitySummary: result.errorMessage, model, provider });
				break;
			}
			retryCount++;
			activeRunSnapshot(undefined, { phase: "retrying", lastActivityType: "retry", lastActivitySummary: `starting retry attempt ${retryCount + 1}`, model, provider });
			continue;
		}

		// 只有明确的 provider/API 故障在同通道重试耗尽后才能切换模型/provider；
		// 裸 timeout、文件/命令错误和其他普通进程失败不得触发降级。
		if (explicitProviderErr && tryModelFallback()) continue;

		// 不重试或达到上限 → 跳出
		break;
	}

	const finalResult = lastResult ?? {
		agent: agent.name, exitCode: 1, output: "", usage: { ...aggregateUsage }, model: null,
		errorMessage: "subagent finished without a result", retryCount: Math.max(0, attemptCount - 1),
	};
	finalResult.usage = { ...aggregateUsage };
	finalResult.costAccounting = { complete: aggregateCostComplete && !aggregateProtocolIncomplete, attributionComplete: aggregateAttributionComplete, provisional: false };
	finalResult.retryCount = Math.max(finalResult.retryCount ?? 0, attemptCount - 1);
	finalResult.protocolErrors = aggregateProtocolErrors.length > 0 ? [...aggregateProtocolErrors] : finalResult.protocolErrors;
	finalResult.incomplete = aggregateProtocolIncomplete || finalResult.incomplete === true;
	if (aggregateProtocolErrors.length > 0) {
		finalResult.errorMessage = [finalResult.errorMessage, ...aggregateProtocolErrors.map(error => `Pi JSONL protocol error: ${error}`)]
			.filter(Boolean).filter((message, index, all) => all.indexOf(message) === index).join("; ");
		if (finalResult.exitCode === 0) finalResult.exitCode = 1;
	}
	finalResult.capability = {
		snapshotPath: capabilitySnapshotPath,
		narrowed: [...capabilityPolicy.narrowed],
		cacheBreakingChanges: capabilityCacheChanges,
	};
	if (opts.completionProof) {
		const proof = evaluateAgentCompletionProof(workspaceCwd, opts.completionProof);
		finalResult.completionProof = proof;
		if (proof.passed && canCompletionProofRecover(finalResult)) {
			finalResult.exitCode = 0;
			finalResult.errorMessage = undefined;
			finalResult.output = [finalResult.output, `[AgentFlux completion proof: passed · ${proof.checkedFiles.length} files]`]
				.filter(Boolean).join("\n");
		} else if (!proof.passed && finalResult.exitCode === 0 && !finalResult.errorMessage) {
			finalResult.exitCode = 75;
			finalResult.errorMessage = `completion proof failed: ${proof.failures.join("; ")}`;
		}
	}

	if (finalResult.exitCode === 0 && !finalResult.errorMessage) {
		const communication = evaluateCommunicationContract({
			bus: new MessageBus(join(cwd, ".agentflux")), policy: communicationPolicy,
			sender: agent.name, runId: processRunId, injectedMessageIds: inboxInjection.v2MessageIds,
		});
		finalResult.communication = communication;
		if (!communication.passed) {
			finalResult.exitCode = 76;
			const failures = [
				communication.missingSendTo.length > 0 ? `missing handoff to ${communication.missingSendTo.join(", ")}` : "",
				communication.unacknowledgedInbox.length > 0 ? `unacknowledged inbox ${communication.unacknowledgedInbox.join(", ")}` : "",
			].filter(Boolean);
			finalResult.errorMessage = `communication contract incomplete: ${failures.join("; ")}`;
		}
	}

	// 只有完整成功（含 communication gate）才确认启动前 inbox。
	// 显式 ACK 契约必须由 agent 工具在结束前完成。
	if (finalResult.exitCode === 0 && !finalResult.errorMessage
		&& !communicationPolicy.requireExplicitInboxAck && inboxInjection.v2MessageIds.length > 0) {
		try {
			const bus = new MessageBus(join(cwd, ".agentflux"));
			for (const messageId of inboxInjection.v2MessageIds) bus.acknowledge(agent.name, messageId);
		} catch (error: any) {
			console.error(`[flux message-v2] ${agent.name} acknowledgement failed: ${error?.message ?? error}`);
		}
	}

	const hitRate = finalResult.usage.cacheRead / (finalResult.usage.cacheRead + finalResult.usage.input + 1e-9);
	telemetry?.writeSubagentRun({
		sessionId, taskId: opts.taskId, agent: agent.name, task: opts.task.slice(0, 200), model: finalResult.model,
		runId: processRunId,
		startedAt: runStartedAt,
		finishedAt: Date.now(),
		turns: finalResult.usage.turns, input: finalResult.usage.input, output: finalResult.usage.output,
		cacheRead: finalResult.usage.cacheRead, cacheWrite: finalResult.usage.cacheWrite,
		costUsd: Number(finalResult.usage.cost.toFixed(6)), contextTokens: finalResult.usage.contextTokens,
		cacheHitRate: Number(hitRate.toFixed(4)), prefixLayout, exitCode: finalResult.exitCode,
		timedOut: finalResult.timedOut,
		persistent: opts.persistent ?? false, thinking: finalResult.thinkingLevel ?? thinkingLevel,
		retryCount: finalResult.retryCount,
		communication: finalResult.communication ? {
			passed: finalResult.communication.passed,
			missingSendTo: finalResult.communication.missingSendTo,
			unacknowledgedInbox: finalResult.communication.unacknowledgedInbox,
		} : undefined,
		outcome: {
			status: finalResult.exitCode === 0 && !finalResult.errorMessage ? "success"
				: finalResult.exitCode === 130 ? "cancelled"
				: finalResult.timedOut === true ? "timeout" : "failure",
			success: finalResult.exitCode === 0 && !finalResult.errorMessage,
			exitCode: finalResult.exitCode,
			retryCount: finalResult.retryCount,
			error: finalResult.errorMessage,
		},
	});

	// SharedBoard: 更新 agent 状态
	if (opts.persistent) {
		try {
			new SharedBoard(join(cwd, ".agentflux"))
				.finalizeRuntimeAgentPresence(agent.name, agentInstanceId, finalResult.exitCode);
		} catch {}
	} else {
		updateAgentStatusInBoard(agent.name, finalResult.exitCode === 0 && !finalResult.errorMessage ? "done" : "failed", cwd);
	}
	const terminalInput = {
		status: finalResult.exitCode === 0 && !finalResult.errorMessage
			? "completed" as const
			: finalResult.exitCode === 130
				? "cancelled" as const
				: finalResult.timedOut === true
					? "timed_out" as const
					: "failed" as const,
		phase: "terminal" as const,
		turns: aggregateUsage.turns,
		input: aggregateUsage.input,
		output: aggregateUsage.output,
		cacheRead: aggregateUsage.cacheRead,
		cacheWrite: aggregateUsage.cacheWrite,
		contextTokens: aggregateUsage.contextTokens,
		costUsd: aggregateUsage.cost,
		attempt: attemptCount,
		model: finalResult.model ?? opts.model ?? agent.model ?? null,
		provider: finalResult.provider ?? observedProvider ?? opts.provider ?? agent.provider ?? null,
		responseModel: finalResult.responseModel,
		thinkingLevel: finalResult.thinkingLevel ?? thinkingLevel,
		costAccounting: finalResult.costAccounting,
		modelError,
		providerError,
		error: finalResult.errorMessage,
	};
	let terminalized = false;
	for (let attempt = 0; attempt < 3 && !terminalized; attempt++) {
		try {
			finishRun(fluxDir, processRunId, terminalInput);
			terminalized = true;
		} catch (error) {
			reportRegistryFailure("terminal convergence", error);
			if (attempt < 2) {
				const waiter = new Int32Array(new SharedArrayBuffer(4));
				Atomics.wait(waiter, 0, 0, Math.min(250, 25 * 2 ** attempt));
			}
		}
	}
	if (!terminalized) {
		console.error(`[flux run-registry] ${agent.name}/${processRunId} terminal convergence unavailable; business result preserved as ${terminalInput.status}`);
	}
	// A physical Run is immutable after terminalization.  Any unconsumed
	// correlated instruction belongs to that Run only and must not be visible to
	// a later Run of the same Agent; lease redelivery is not a cross-Run retry
	// mechanism.
	try {
		new MessageBus(fluxDir).rejectByCorrelation(agent.name, processRunId, "run terminated before instruction was consumed");
	} catch (error) {
		reportRegistryFailure("terminal message rejection", error);
	}
	if (sdkOwner) retireSdkRunOwner(cwd, sdkOwner);
	if (sdkLease) releaseActiveContext(cwd, sdkLease.leaseId);
	clearAgentRunStop(cwd, processRunId);

	// 文件锁: 释放所有锁
	if (lockedFiles.length > 0) {
		try {
			const board = new SharedBoard(join(cwd, ".agentflux"), { runtimeOwner: sdkOwner });
			board.releaseAllLocks(lockOwner);
		} catch { /* */ }
	}

	return finalResult;
}

/** 格式化 subagent 结果为工具返回 content（last: 展示最近几条对话消息，默认最后 1 条） */
export function formatAgentRunResult(r: AgentRunResult, last = 1): string {
	const hitRate = r.usage.cacheRead / (r.usage.cacheRead + r.usage.input + 1e-9);
	const retryInfo = r.retryCount && r.retryCount > 0 ? ` · retries=${r.retryCount}` : "";
	const succeeded = r.exitCode === 0 && !r.errorMessage;
	const modelInfo = r.fallbackFrom
		? ` · fallback=${r.fallbackFrom}→${r.fallbackModel ?? r.model ?? "unknown"}`
		: r.model ? ` · model=${r.model}` : "";
	const messages = r.assistantMessages ?? [];
	const recent = messages.slice(-last);
	const lastMessage = recent.length
		? recent[recent.length - 1]
		: r.output.trim() ? r.output : r.errorMessage ?? "(no message)";
	const header = [
		`[AgentFlux subagent: ${r.agent}${r.role ? ` · role=${r.role}` : ""}] ${succeeded ? "SUCCESS" : "FAILED"} (exit=${r.exitCode})`,
		`turns ${r.usage.turns} · in ${r.usage.input} · read ${r.usage.cacheRead} · hit ${(hitRate * 100).toFixed(0)}% · $${r.usage.cost.toFixed(4)}${retryInfo}${modelInfo}${r.backend ? ` · backend=${r.backend}` : ""}`,
		...(r.errorMessage ? [`error: ${r.errorMessage}`] : []),
		...(!succeeded ? ["next: choose one bounded action — continue directly without this delegation, select a healthy provider, or stop and report; do not repeat the same failed delegation without a new plan"] : []),
	].join("\n");
	if (last > 1 && recent.length > 1) {
		return [
			header,
			`last ${recent.length} message(s):`,
			...recent.map((message, index) => `--- ${index + 1} ---\n${message.slice(0, 2000)}`),
		].join("\n");
	}
	return `${header}\n\n${lastMessage.slice(0, 8000)}`;
}
