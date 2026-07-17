/**
 * AgentFlux Extension — subagent runner (F1-7)
 * 文档依据: docs/03-modes M2, 06-cache-strategy L1 跨 session, 10-pi-integration §2
 *
 * 增量价值 (docs 反思 4b174b47): 不重写 subagent 原语, 而是确保:
 *   1. 子进程加载 subagent-entry.ts (精简入口) → 前缀布局自动应用, 但不注册 tool/command
 *      (完整 entry.ts 会改变 LLM 工具列表, 导致行为差异, 实验 C 暴露)
 *   2. 统一 system prompt 前缀 → 主+子共享 L1, 跨调用命中 (docs/06)
 *   3. subagent.run telemetry → cacheRead/cost 可观测, 支撑成本对比验证
 *
 * 对比 naive subagent (pi examples/extensions/subagent, 无前缀布局):
 *   - naive: 子进程无 AgentFlux 扩展, 历史不打 cache_control, 多轮 L2 不缓存
 *   - AgentFlux: 子进程加载 subagent-entry.ts, 前缀布局让 L2 命中, cache 监控可观测
 *   - 两者 LLM 工具列表完全一致 (都是内置工具), 行为可公平对比
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import type { PricingTable } from "../core/pricing";
import { calcCost, lookupPrice } from "../core/pricing";
import { parseFrontmatter } from "../core/role-manager";
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
	loadRegisteredCapabilityOverride, resolveCapabilityPolicy, writeEffectiveCapabilitySnapshot,
	type CapabilityPolicyInput, type WorkspaceCapabilityInput,
} from "../core/capability-policy";

// ──────────────────────────────── M2-1: 并行 subagent ────────────────────────────────

export interface ParallelSubagentTask {
	agent: SubagentDef;
	task: string;
	label?: string;             // 可选标签, 用于结果区分 (默认用 agent.name)
}

export interface ParallelRunResult {
	results: SubagentRunResult[];
	wallClockMs: number;        // 并行总耗时
	sumIndividualMs: number;    // 各 agent 耗时之和 (用于计算加速比)
	speedupRatio: number;       // sumIndividual / wallClock (1.0=无加速, 2.0=理想双线程)
	totalCost: number;
	allSucceeded: boolean;
	errors: string[];           // 失败 agent 的错误信息
}

/**
 * 并行运行多个 subagent (M2-1).
 *
 * 每个 subagent 是独立子进程, 天然并行.
 * 一个 agent 失败不影响其他 agent (隔离错误).
 *
 * @param tasks 要并行执行的 agent 任务列表
 * @param common 共享参数 (cwd, sessionId, telemetry, prefixLayout, pricing)
 * @returns ParallelRunResult 包含所有结果 + 并行性能指标
 */
export async function runSubagentsParallel(
	tasks: ParallelSubagentTask[],
	common: {
		cwd: string;
		sessionId: string;
		telemetry?: TelemetryWriter;
		prefixLayout: boolean;
		pricing?: PricingTable;
		persistent?: boolean;               // M2-2: 持久 session
		sessionIds?: Map<string, string>;   // per-label session ID (team-workflow 用)
		sessionDir?: string;                // 自定义 session 目录
		timeoutMs?: number;                 // 超时 (默认 120000)
		maxRetries?: number;                // 重试次数 (默认 1)
		lockFiles?: Record<string, string[]>;  // per-label 文件锁: {label: [file paths]}
		signal?: AbortSignal;               // 调用方取消时终止所有子进程
		maxCostUsd?: number;                // attempt 之间的实际成本硬停止
	},
): Promise<ParallelRunResult> {
	const wallStart = Date.now();

	// 为每个 task 记录独立开始时间, 用于计算 sumIndividualMs
	const timings: Array<{ start: number; end: number }> = [];

	// Promise.all 包装: 每个 subagent 独立运行, 错误隔离
	const settled = await Promise.allSettled(
		tasks.map((t, i) => {
			const individualStart = Date.now();
			// per-label session ID 优先, fallback 到 common.sessionId
			const sid = (t.label ? common.sessionIds?.get(t.label) : undefined) ?? common.sessionId;
			return runSubagent({
				cwd: common.cwd,
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
				maxRetries: common.maxRetries ?? 1,
				lockFiles: t.label ? common.lockFiles?.[t.label] : undefined,
				signal: common.signal,
				maxCostUsd: common.maxCostUsd,
			}).then(result => {
				timings[i] = { start: individualStart, end: Date.now() };
				return result;
			});
		}),
	);

	const wallClockMs = Date.now() - wallStart;

	// 收集结果
	const results: SubagentRunResult[] = [];
	const errors: string[] = [];
	let totalCost = 0;
	let allSucceeded = true;

	for (let i = 0; i < settled.length; i++) {
		const s = settled[i];
		if (s.status === "fulfilled") {
			results.push(s.value);
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
export function formatParallelResults(r: ParallelRunResult): string {
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

export interface SubagentDef {
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
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";  // M2-4: reasoning effort
	communication?: CommunicationPolicyInput; // 角色模板默认；运行实例可收窄或增加完成门
}

export interface SubagentRunResult {
	agent: string;
	exitCode: number;
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
}

/** 从 .agentflux/agents/*.md 加载 agent 定义 (frontmatter + body), 回落到内建 reviewer */
export function loadSubagent(cwd: string, name: string): SubagentDef | null {
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
			const thinking = frontmatter.thinking as SubagentDef["thinking"] | undefined;
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
				thinking: thinking && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking) ? thinking : undefined,
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
			systemPrompt: "You are a senior code reviewer. Analyze code for quality, security, maintainability. Bash is read-only only (git diff/log/show). Output: ## Files Reviewed / ## Critical / ## Warnings / ## Suggestions / ## Summary. Be specific with file paths and line numbers.",
		};
	}
	return null;
}

/** 合并项目共享 Skill 与角色 Skill；返回副本，避免污染缓存或调用方定义。 */
export function withSharedSkills(agent: SubagentDef, sharedSkills?: string[]): SubagentDef {
	const skills = [...new Set([...(sharedSkills ?? []), ...(agent.skills ?? [])]
		.map(skill => skill.trim())
		.filter(Boolean))];
	return { ...agent, skills: skills.length > 0 ? skills : undefined };
}

/** 子进程要加载的 entry 路径:
 *  - prefixLayout=true: 用 subagent-entry.ts (精简, 只加载 prefix-layout, 不注册 tool/command)
 *    避免改变子进程 LLM 工具列表和行为 (实验 C 暴露的问题)
 *  - prefixLayout=false: 不加载任何 AgentFlux 扩展 (naive 对照)
 */
function getSubagentEntryPath(_cwd: string): string {
	// 从已安装 package 自身定位，不能假设目标项目也有 src/subagent-entry.ts。
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "subagent-entry.ts");
}

/** 决定 pi 可执行路径: 用 node + pi 的 cli.js (shell:false, 避免 Windows shell 分词) */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const req = createRequire(import.meta.url);
	let cliPath: string = "";

	// Method 1: 直接 resolve (如果 exports 字段允许)
	try {
		cliPath = req.resolve("@earendil-works/pi-coding-agent/dist/cli.js");
	} catch { /* exports 限制, 继续尝试 */ }

	// Method 2: 通过 resolve.paths 找到 node_modules 目录, 手动拼接
	if (!cliPath) {
		try {
			const searchPaths = req.resolve.paths("@earendil-works/pi-coding-agent") ?? [];
			for (const p of searchPaths) {
				const candidate = join(p, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
				if (existsSync(candidate)) { cliPath = candidate; break; }
			}
		} catch { /* 继续回退 */ }
	}

	// Method 3: 最终回退 — process.argv[1] (主进程入口)
	if (!cliPath) {
		cliPath = process.argv[1] ?? "";
	}

	return { command: process.execPath, args: [cliPath, ...args] };
}

/**
 * 运行单个 subagent。
 * @param opts.cwd 工作目录
 * @param agent agent 定义
 * @param task 任务描述
 * @param sessionId 主 session id (telemetry 关联)
 * @param telemetry telemetry writer (可选, 不传则不写)
 * @param prefixLayout 是否加载 entry.ts (true=AgentFlux优化, false=naive对照)
 * @param model 覆盖 agent.model
 * @param provider 覆盖 agent.provider
 * @param pricing 父进程用价格表重算子进程成本
 * @param persistent M2-2: true=保留 session 文件可续接, false=一次性 ephemeral
 * @param sessionDir M2-2: 持久 session 存储目录, 默认 .agentflux/runtime/sessions/
 * @param thinking M2-4: 覆盖 agent.thinking 的 reasoning effort 级别
 */
// ── SharedBoard 集成: agent 启动前读 inbox + 注册 ──

/**
 * 读取 agent 的 inbox + 群组消息, 拼接到 task 前面
 * 让 agent 能看到其他 agent 的反馈, 不需要主 agent 桥接
 */
function prependInboxMessages(task: string, agentName: string, cwd: string): { task: string; v2MessageIds: string[] } {
	try {
		const fluxDir = join(cwd, ".agentflux");
		const board = new SharedBoard(fluxDir);
		const unread = board.getUnreadMessages(agentName);
		const groupInbox = board.getGroupInbox(agentName);
		const v2Messages = new MessageBus(fluxDir).poll(agentName, { limit: 20 });

		// 收集所有群组中的最新消息 (只取最后 5 条 per group)
		const groupMsgs: string[] = [];
		for (const { group, messages } of groupInbox) {
			const recent = messages.slice(-5);
			for (const m of recent) {
				if (m.from === agentName) continue;  // 跳过自己发的
				groupMsgs.push(`[${group.name}] ${m.from}: ${m.content.slice(0, 200)}`);
			}
		}

		const dmMsgs = unread.map(m => `[DM from ${m.from}] ${m.content.slice(0, 200)}`);

		const v2Msgs = v2Messages.map(({ envelope }) =>
			`[V2 ${envelope.channel.type}/${envelope.channel.id} from ${envelope.from}] ${envelope.content.slice(0, 500)}`);
		const allMsgs = [...dmMsgs, ...groupMsgs, ...v2Msgs];
		if (allMsgs.length === 0) return { task, v2MessageIds: [] };

		// 标记消息为已读
		for (const m of unread) board.markMessageRead(m.id);

		return {
			task: `=== Messages from other agents ===\n${allMsgs.join("\n")}\n=== End messages ===\n\n${task}`,
			v2MessageIds: v2Messages.map(item => item.envelope.id),
		};
	} catch {
		return { task, v2MessageIds: [] };  // SharedBoard 不存在时静默跳过
	}
}

// ── 错误检测: 模型错误 (可降级) vs 瞬时错误 (可重试) vs 进程错误 ──

/** 模型解析错误 — 可触发模型降级 */
function isModelError(msg?: string): boolean {
	return !!msg && /model not found|404|not found|no api key|opencode/i.test(msg);
}

/** 瞬时错误 — 502/503/500/overloaded/gateway 等, 重试同一模型 */
function isTransientError(msg?: string, output?: string): boolean {
	const text = `${msg ?? ""} ${output ?? ""}`;
	return /502|503|500|overloaded|service unavailable|gateway|bad gateway|rate limit|429|timeout|connection (refused|reset|closed)|ECONNREFUSED|ETIMEDY|负载.*上限|过载|服务不可用|超时|请求失败|繁忙/i.test(text);
}

/** Provider/API 组合不兼容 — 重试同一组合通常无效，应切换模型/provider。 */
function isProviderCompatibilityError(msg?: string): boolean {
	return !!msg && /406(?: status code)?|not acceptable/i.test(msg);
}

/** 注册 agent 到 SharedBoard agent 注册表 */
function registerAgentInBoard(agent: SubagentDef, task: string, cwd: string, model?: string, provider?: string): void {
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

/** 更新 agent 状态 */
function updateAgentStatusInBoard(agentName: string, status: "done" | "failed", cwd: string): void {
	try {
		const board = new SharedBoard(join(cwd, ".agentflux"));
		board.updateAgentPresence(agentName, { status });
	} catch { /* 静默 */ }
}

const activeSubagentProcesses = new Map<string, ChildProcess>();

/** 当前进程内仍在运行的 pi 子进程，供状态页和取消测试使用。 */
export function getActiveSubagentRunIds(): string[] {
	return [...activeSubagentProcesses.keys()];
}

async function terminateProcessTree(proc: ChildProcess): Promise<void> {
	if (!proc.pid) return;
	if (process.platform === "win32") {
		await new Promise<void>((resolveDone) => {
			const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
				shell: false, stdio: "ignore", windowsHide: true,
			});
			killer.once("close", () => resolveDone());
			killer.once("error", () => resolveDone());
		});
		return;
	}
	// POSIX 下子进程以独立 process group 启动，负 PID 可终止其整个后代树。
	try { process.kill(-proc.pid, "SIGTERM"); }
	catch { try { proc.kill("SIGTERM"); } catch { /* process 已退出 */ } }
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

export async function runSubagent(opts: {
	cwd: string;
	agent: SubagentDef;
	task: string;
	sessionId: string;
	telemetry?: TelemetryWriter;
	prefixLayout: boolean;
	model?: string;
	provider?: string;
	pricing?: PricingTable;  // F1-14: 父进程用价格表重算子进程成本
	persistent?: boolean;     // M2-2: 持久 session
	persistentSessionId?: string; // 持久 session 的作用域 key；未传时沿用 agent 名
	sessionDir?: string;      // M2-2: 自定义 session 目录
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";  // M2-4
	timeoutMs?: number;       // 可配置超时 (默认 120000 = 2min)
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
	maxCostUsd?: number;                               // attempt 间成本上限（单次调用可能产生少量超额）
	taskId?: string;                                   // Message V2 / telemetry correlation
	communicationOverride?: CommunicationPolicyInput; // 注册实例/单次调用动态覆盖角色模板
	capabilityOverride?: CapabilityPolicyInput;         // 单次运行覆盖；只能收窄模板和注册实例
	/** 仅供确定性生命周期测试注入本地假进程；生产入口不会暴露。 */
	invocationOverride?: { command: string; args: string[] };
}): Promise<SubagentRunResult> {
	const { cwd, agent, sessionId, telemetry, prefixLayout } = opts;
	const runStartedAt = Date.now();
	const timeoutMs = Math.max(1, opts.timeoutMs ?? 120000);
	const maxRetries = opts.maxRetries ?? 0;
	const retryDelayMs = opts.retryDelayMs ?? 2000;
	const deadline = Date.now() + timeoutMs;
	const processRunId = opts.runId ?? `subagent-${randomUUID()}`;
	const agentInstanceId = `${agent.name}:${processRunId}`;
	const capabilityRole = agent.role ?? agent.name;
	const registeredRecord = loadRegisteredCapabilityOverride(join(cwd, ".agentflux"), agent.name);
	if (registeredRecord && registeredRecord.role !== capabilityRole) {
		return {
			agent: agent.name, exitCode: 77, output: "",
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
			model: null,
			errorMessage: `capability policy rejected: registered role ${registeredRecord.role} does not match ${capabilityRole}`,
			retryCount: 0,
		};
	}
	const registeredCapability = registeredRecord?.override;
	const runCapability: CapabilityPolicyInput | undefined = opts.capabilityOverride || opts.communicationOverride
		? { ...(opts.capabilityOverride ?? {}), communication: opts.communicationOverride ?? opts.capabilityOverride?.communication }
		: undefined;
	let capabilityPolicy;
	let capabilitySnapshotPath = "";
	try {
		capabilityPolicy = resolveCapabilityPolicy({
			cwd, agentName: agent.name, role: capabilityRole, runId: processRunId, instanceId: agentInstanceId,
			template: {
				tools: agent.tools, skills: agent.skills, mcpServers: agent.mcpServers,
				communication: agent.communication, workspace: agent.workspace,
			},
			registered: registeredCapability,
			run: runCapability,
		});
		if (!prefixLayout) capabilityPolicy.effective.workspace.enforcement = "unavailable";
		capabilitySnapshotPath = writeEffectiveCapabilitySnapshot(join(cwd, ".agentflux"), capabilityPolicy);
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
	const capabilityCacheChanges = [...new Set([
		registeredCapability?.tools || runCapability?.tools ? "tool_schema" : null,
		registeredCapability?.skills || runCapability?.skills ? "skill_set" : null,
		registeredCapability?.mcpServers || runCapability?.mcpServers ? "mcp_set" : null,
		registeredCapability?.communication || registeredCapability?.workspace
			|| runCapability?.communication || runCapability?.workspace ? "runtime_policy_guard" : null,
	].filter((item): item is "tool_schema" | "skill_set" | "mcp_set" | "runtime_policy_guard" => !!item))];
	const capabilityGeneration = createHash("sha256").update(JSON.stringify({
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

	const thinkingLevel = opts.thinking ?? agent.thinking ?? "off";

	// SharedBoard 集成: 读 inbox + 注册 agent
	let scopedTask = opts.lockFiles && opts.lockFiles.length > 0
		? `${opts.task}\n\n=== Enforced file edit scope ===\nYou may read other files for context, but you may modify ONLY these paths:\n${opts.lockFiles.map(file => `- ${file}`).join("\n")}\nIf the task requires another file, stop and report the missing scope instead of editing it.\n=== End enforced scope ===`
		: opts.task;
	const communicationInstruction = formatCommunicationContractInstruction(communicationPolicy);
	if (communicationInstruction) scopedTask = `${scopedTask}\n\n${communicationInstruction}`;
	const inboxInjection = prependInboxMessages(scopedTask, agent.name, cwd);
	const taskWithInbox = inboxInjection.task;
	registerAgentInBoard(agent, opts.task, cwd, opts.model ?? agent.model, opts.provider ?? agent.provider);

	// 文件锁 owner 必须是本次运行实例，不能只用角色名（两个 implementer 不是同一 owner）。
	const lockOwner = `${agent.name}:${processRunId}`;

	// 文件锁: 获取要编辑的文件的锁。任何冲突都 fail-closed。
	const lockedFiles: string[] = [];
	let lockError: string | undefined;
	if (opts.lockFiles && opts.lockFiles.length > 0) {
		try {
			const board = new SharedBoard(join(cwd, ".agentflux"));
			for (const fp of opts.lockFiles) {
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
	let lastResult: SubagentRunResult | null = null;
	let attemptCount = 0;
	const aggregateUsage: SubagentRunResult["usage"] = {
		turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0,
	};

	const communicationUnavailable = !prefixLayout
		&& (communicationPolicy.requiredSendTo.length > 0 || communicationPolicy.requireExplicitInboxAck);
	const workspaceGuardUnavailable = !prefixLayout
		&& !!(agent.workspace || registeredCapability?.workspace || runCapability?.workspace);
	if (lockError || opts.signal?.aborted || communicationUnavailable || workspaceGuardUnavailable) {
		lastResult = {
			agent: agent.name,
			exitCode: lockError ? 73 : opts.signal?.aborted ? 130 : communicationUnavailable ? 76 : 77,
			output: "",
			usage: { ...aggregateUsage },
			model: null,
			errorMessage: lockError ?? (opts.signal?.aborted ? "cancelled before start"
				: communicationUnavailable ? "communication contract requires prefixLayout subagent extension"
					: "workspace capability requires prefixLayout subagent tool hook"),
			retryCount: 0,
		};
	}

	while (retryCount <= maxRetries && ![73, 76, 77, 130].includes(lastResult?.exitCode ?? -1)) {
		if (opts.signal?.aborted) {
			lastResult = {
				agent: agent.name, exitCode: 130, output: "", usage: { ...aggregateUsage }, model: null,
				errorMessage: "cancelled", retryCount: Math.max(0, attemptCount - 1),
			};
			break;
		}
		if (opts.maxCostUsd !== undefined && aggregateUsage.cost >= opts.maxCostUsd) {
			lastResult = {
				agent: agent.name, exitCode: 75, output: "", usage: { ...aggregateUsage }, model: null,
				errorMessage: `budget exhausted: $${aggregateUsage.cost.toFixed(6)} >= $${opts.maxCostUsd.toFixed(6)}`,
				retryCount: Math.max(0, attemptCount - 1),
			};
			break;
		}
		const attemptTimeoutMs = deadline - Date.now();
		if (attemptTimeoutMs <= 0) {
			if (lastResult) {
				lastResult.exitCode = 124;
				lastResult.errorMessage = `total timeout (${timeoutMs / 1000}s) exhausted across retries/fallbacks`;
			}
			break;
		}
		// 每次迭代重建 args (因为 tmpDir 路径会变)
		const attemptArgs: string[] = ["--mode", "json", "-p", "--no-prompt-templates", "--no-context-files", "--approve"];

		// M2-2: 持久 session vs 一次性 ephemeral
		if (opts.persistent) {
			const sDir = opts.sessionDir ?? join(cwd, ".agentflux", "runtime", "sessions");
			const rawSessionId = `${opts.persistentSessionId ?? `flux-${agent.name}`}-cap-${capabilityGeneration}`;
			const agentSessionId = rawSessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
			attemptArgs.push("--session-dir", sDir);
			attemptArgs.push("--session-id", agentSessionId);
		} else {
			attemptArgs.push("--no-session");
		}
		// skills
		if (capabilityPolicy.effective.skills.length > 0) {
			for (const skill of capabilityPolicy.effective.skills) attemptArgs.push("--skill", skill);
		} else {
			attemptArgs.push("--no-skills");
		}
		if (prefixLayout) {
			attemptArgs.push("--no-extensions", "-e", getSubagentEntryPath(cwd));
		} else {
			attemptArgs.push("--no-extensions");
		}
		const model = opts.model ?? agent.model ?? null;
		const provider = opts.provider ?? agent.provider ?? null;
		if (provider) attemptArgs.push("--provider", provider);
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

		const result: SubagentRunResult = {
			agent: agent.name, exitCode: 0, output: "",
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
			model: null,
			retryCount,
			fallbackModel: opts.fallbackHistory && opts.fallbackHistory.length > 1 ? (opts.model ?? agent.model ?? undefined) : undefined,
			fallbackFrom: opts.fallbackHistory && opts.fallbackHistory.length > 1 ? opts.fallbackHistory[0] : undefined,
		};
		attemptCount++;

		try {
			const outputParts: string[] = [];
			let stderrBuf = "";
			const exitCode = await new Promise<number>((resolveExit) => {
				const invocation = opts.invocationOverride
					? { command: opts.invocationOverride.command, args: [...opts.invocationOverride.args, ...attemptArgs] }
					: getPiInvocation(attemptArgs);
				const proc = spawn(invocation.command, invocation.args, {
					cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					detached: process.platform !== "win32",
					windowsHide: true,
					env: {
						...process.env,
						AGENTFLUX_AGENT_NAME: agent.name,
						AGENTFLUX_AGENT_INSTANCE_ID: agentInstanceId,
						AGENTFLUX_RUN_ID: processRunId,
						AGENTFLUX_TASK_ID: opts.taskId ?? "",
						AGENTFLUX_COMMUNICATION_POLICY: JSON.stringify(communicationPolicy),
						AGENTFLUX_CAPABILITY_POLICY: JSON.stringify(capabilityPolicy.effective),
					},
				});
				let buffer = "";
				let settled = false;
				let forcedExitCode: number | null = null;
				let killGraceTimer: NodeJS.Timeout | undefined;
				const done = (code: number) => {
					if (!settled) {
						settled = true;
						activeSubagentProcesses.delete(processRunId);
						opts.signal?.removeEventListener("abort", onAbort);
						if (killGraceTimer) clearTimeout(killGraceTimer);
						resolveExit(code);
					}
				};
				const requestTermination = (exitCode: number) => {
					if (forcedExitCode !== null) return;
					forcedExitCode = exitCode;
					void terminateProcessTree(proc);
					// 正常情况下等待 close；极端卡死时 5 秒后解除调用方等待。
					killGraceTimer = setTimeout(() => done(exitCode), 5000);
				};
				const onAbort = () => requestTermination(130);
				activeSubagentProcesses.set(processRunId, proc);
				opts.signal?.addEventListener("abort", onAbort, { once: true });
				const timer = setTimeout(() => requestTermination(124), attemptTimeoutMs);

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let ev: any;
					try { ev = JSON.parse(line); } catch { return; }
					if (ev.type === "message_end" && ev.message) {
						const msg = ev.message;
						if (msg.role === "assistant") {
							result.usage.turns++;
							const u = msg.usage || {};
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							if (opts.pricing && msg.model) {
								result.usage.cost += calcCost(u, lookupPrice(opts.pricing, msg.model));
							} else {
								result.usage.cost += u.cost?.total || 0;
							}
							result.usage.contextTokens = u.totalTokens || 0;
							if (!result.model && msg.model) result.model = msg.model;
							if (msg.errorMessage) result.errorMessage = msg.errorMessage;
							const content = msg.content;
							if (Array.isArray(content)) {
								for (const b of content) if (b?.type === "text" && b.text) outputParts.push(b.text);
							}
						}
					}
				};

				proc.stdout.on("data", (data) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const ln of lines) processLine(ln);
				});
				proc.stderr.on("data", (data) => { stderrBuf += data.toString(); });
				proc.on("error", (err) => { result.errorMessage = `spawn error: ${err.message}`; clearTimeout(timer); done(forcedExitCode ?? 1); });
				proc.on("close", (code, signal) => {
					clearTimeout(timer);
					done(forcedExitCode ?? (code ?? (signal ? 130 : 1)));
				});
			});

			result.exitCode = exitCode;
			result.output = outputParts.join("\n").slice(0, 50 * 1024);
			if (stderrBuf.trim() && exitCode !== 0) result.errorMessage = (result.errorMessage ?? "") + ` stderr: ${stderrBuf.slice(0, 500)}`;
		} finally {
			if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } }
		}

		lastResult = result;
		aggregateUsage.turns += result.usage.turns;
		aggregateUsage.input += result.usage.input;
		aggregateUsage.output += result.usage.output;
		aggregateUsage.cacheRead += result.usage.cacheRead;
		aggregateUsage.cacheWrite += result.usage.cacheWrite;
		aggregateUsage.cost += result.usage.cost;
		aggregateUsage.contextTokens = result.usage.contextTokens;

		// 成功 → 返回 (exitCode=0 且无 errorMessage)
		if (result.exitCode === 0 && !result.errorMessage) {
			break;
		}

		// 失败 → 判断是否应该重试
		if (result.exitCode === 130 || opts.signal?.aborted) break;
		const isTimeout = result.exitCode === 124;
		const isProcessError = result.exitCode !== 0 && result.exitCode !== 124;
		const modelErr = isModelError(result.errorMessage);
		const transientErr = isTransientError(result.errorMessage, result.output);
		const providerCompatibilityErr = isProviderCompatibilityError(result.errorMessage);

		const tryModelFallback = (): boolean => {
			if (!opts.enableModelFallback || !opts.modelsForFallback || !opts.roleRequirementForFallback) return false;
			const currentModel = opts.model ?? agent.model ?? "";
			const tried = opts.fallbackHistory ?? [currentModel];
			const fallback = rankModels(opts.roleRequirementForFallback, opts.modelsForFallback)
				.map(candidate => candidate.model)
				.find(candidate => !tried.includes(candidate));
			if (!fallback || tried.includes(fallback)) return false;

			console.error(`[flux subagent] ${agent.name} model/provider "${currentModel}" unavailable, degrading to "${fallback}"...`);
			opts.model = fallback;
			opts.fallbackHistory = [...tried, fallback];
			if (opts.modelsForFallback[fallback]?.provider) {
				opts.provider = opts.modelsForFallback[fallback].provider;
			}
			return true;
		};

		// 明确的模型或 provider 不兼容错误无需重复相同请求，直接降级。
		if ((modelErr || providerCompatibilityErr) && tryModelFallback()) continue;

		if (retryCount < maxRetries && (isTimeout || isProcessError || modelErr || transientErr || providerCompatibilityErr)) {
			const baseDelay = transientErr ? 5000 : retryDelayMs;  // 502/503 退避更久
			const delay = baseDelay * Math.pow(2, retryCount);  // 指数退避
			if (Date.now() + delay >= deadline) {
				result.exitCode = 124;
				result.errorMessage = `total timeout (${timeoutMs / 1000}s) exhausted before retry`;
				break;
			}
			const reason = isTimeout ? `timeout (${timeoutMs / 1000}s)` : modelErr ? `model error: ${result.errorMessage?.slice(0, 60)}` : providerCompatibilityErr ? `provider compatibility: ${result.errorMessage?.slice(0, 60)}` : transientErr ? `transient: ${result.errorMessage?.slice(0, 60) ?? result.output.slice(0, 60)}` : `exit code ${result.exitCode}`;
			console.error(`[flux subagent] ${agent.name} failed (${reason}), retrying ${retryCount + 1}/${maxRetries} in ${delay}ms...`);
			if (!await waitForRetry(delay, opts.signal)) {
				result.exitCode = 130;
				result.errorMessage = "cancelled during retry backoff";
				break;
			}
			retryCount++;
			continue;
		}

		// 同一 provider 的瞬时错误耗尽重试后，切换下一档模型/provider。
		if (transientErr && tryModelFallback()) continue;

		// 不重试或达到上限 → 跳出
		break;
	}

	const finalResult = lastResult ?? {
		agent: agent.name, exitCode: 1, output: "", usage: { ...aggregateUsage }, model: null,
		errorMessage: "subagent finished without a result", retryCount: Math.max(0, attemptCount - 1),
	};
	finalResult.usage = { ...aggregateUsage };
	finalResult.retryCount = Math.max(finalResult.retryCount ?? 0, attemptCount - 1);
	finalResult.capability = {
		snapshotPath: capabilitySnapshotPath,
		narrowed: [...capabilityPolicy.narrowed],
		cacheBreakingChanges: capabilityCacheChanges,
	};

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

	// 默认兼容模式：只有完整成功（含 communication gate）才确认启动前 inbox。
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
		sessionId, agent: agent.name, task: opts.task.slice(0, 200), model: finalResult.model,
		runId: processRunId,
		startedAt: runStartedAt,
		finishedAt: Date.now(),
		turns: finalResult.usage.turns, input: finalResult.usage.input, output: finalResult.usage.output,
		cacheRead: finalResult.usage.cacheRead, cacheWrite: finalResult.usage.cacheWrite,
		costUsd: Number(finalResult.usage.cost.toFixed(6)), contextTokens: finalResult.usage.contextTokens,
		cacheHitRate: Number(hitRate.toFixed(4)), prefixLayout, exitCode: finalResult.exitCode,
		persistent: opts.persistent ?? false, thinking: thinkingLevel,
		retryCount: finalResult.retryCount,
		communication: finalResult.communication ? {
			passed: finalResult.communication.passed,
			missingSendTo: finalResult.communication.missingSendTo,
			unacknowledgedInbox: finalResult.communication.unacknowledgedInbox,
		} : undefined,
		outcome: {
			status: finalResult.exitCode === 0 && !finalResult.errorMessage ? "success"
				: finalResult.exitCode === 130 ? "cancelled"
				: finalResult.exitCode === 124 ? "timeout" : "failure",
			success: finalResult.exitCode === 0 && !finalResult.errorMessage,
			exitCode: finalResult.exitCode,
			retryCount: finalResult.retryCount,
			error: finalResult.errorMessage,
		},
	});

	// SharedBoard: 更新 agent 状态
	updateAgentStatusInBoard(agent.name, finalResult.exitCode === 0 && !finalResult.errorMessage ? "done" : "failed", cwd);

	// 文件锁: 释放所有锁
	if (lockedFiles.length > 0) {
		try {
			const board = new SharedBoard(join(cwd, ".agentflux"));
			board.releaseAllLocks(lockOwner);
		} catch { /* */ }
	}

	return finalResult;
}

/** 格式化 subagent 结果为工具返回 content */
export function formatSubagentResult(r: SubagentRunResult): string {
	const hitRate = r.usage.cacheRead / (r.usage.cacheRead + r.usage.input + 1e-9);
	const retryInfo = r.retryCount && r.retryCount > 0 ? ` · retries=${r.retryCount}` : "";
	const succeeded = r.exitCode === 0 && !r.errorMessage;
	const modelInfo = r.fallbackFrom
		? ` · fallback=${r.fallbackFrom}→${r.fallbackModel ?? r.model ?? "unknown"}`
		: r.model ? ` · model=${r.model}` : "";
	return [
		`[AgentFlux subagent: ${r.agent}] ${succeeded ? "SUCCESS" : "FAILED"} (exit=${r.exitCode})`,
		`turns ${r.usage.turns} · in ${r.usage.input} · read ${r.usage.cacheRead} · hit ${(hitRate * 100).toFixed(0)}% · $${r.usage.cost.toFixed(4)}${retryInfo}${modelInfo}`,
		...(r.errorMessage ? [`error: ${r.errorMessage}`] : []),
		...(r.capability?.narrowed.length ? [`capability: ${r.capability.narrowed.join(", ")}${r.capability.cacheBreakingChanges.length ? ` · cache-impact=${r.capability.cacheBreakingChanges.join("|")}` : ""}`] : []),
		``,
		r.output || "(no output)",
	].join("\n");
}
