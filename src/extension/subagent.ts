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

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { PricingTable } from "../core/pricing";
import { calcCost, lookupPrice } from "../core/pricing";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { TelemetryWriter } from "../telemetry/events";

export interface SubagentDef {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
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
}

/** 从 .agentflux/agents/*.md 加载 agent 定义 (frontmatter + body), 回落到内建 reviewer */
export function loadSubagent(cwd: string, name: string): SubagentDef | null {
	const dir = join(cwd, ".agentflux", "agents");
	const file = join(dir, `${name}.md`);
	if (existsSync(file)) {
		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(readFileSync(file, "utf-8"));
			if (!frontmatter.name) return null;
			const tools = frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean);
			return {
				name: frontmatter.name, description: frontmatter.description ?? "",
				tools: tools?.length ? tools : undefined, model: frontmatter.model,
				systemPrompt: body,
			};
		} catch { /* fall through */ }
	}
	// 内建 fallback: reviewer
	if (name === "reviewer") {
		return {
			name: "reviewer",
			description: "Code review specialist (read-only)",
			tools: ["read", "grep", "find", "ls", "bash"],
			systemPrompt: "You are a senior code reviewer. Analyze code for quality, security, maintainability. Bash is read-only only (git diff/log/show). Output: ## Files Reviewed / ## Critical / ## Warnings / ## Suggestions / ## Summary. Be specific with file paths and line numbers.",
		};
	}
	return null;
}

/** 子进程要加载的 entry 路径:
 *  - prefixLayout=true: 用 subagent-entry.ts (精简, 只加载 prefix-layout, 不注册 tool/command)
 *    避免改变子进程 LLM 工具列表和行为 (实验 C 暴露的问题)
 *  - prefixLayout=false: 不加载任何 AgentFlux 扩展 (naive 对照)
 */
function getSubagentEntryPath(cwd: string): string {
	return join(cwd, "src", "subagent-entry.ts");
}

/** 决定 pi 可执行路径: 用 node + pi 的 cli.js (shell:false, 避免 Windows shell 分词) */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const req = createRequire(import.meta.url);
	let cliPath: string;
	try {
		cliPath = req.resolve("@earendil-works/pi-coding-agent/dist/cli.js");
	} catch {
		// fallback: 用 process.argv[1] (主进程入口)
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
 * @param onLine stdout 行回调 (可选)
 */
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
}): Promise<SubagentRunResult> {
	const { cwd, agent, task, sessionId, telemetry, prefixLayout } = opts;

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-skills", "--no-prompt-templates", "--approve"];
	if (prefixLayout) {
		args.push("--no-extensions", "-e", getSubagentEntryPath(cwd));
	} else {
		args.push("--no-extensions");
	}
	const model = opts.model ?? agent.model ?? "deepseek-v4-flash";
	const provider = opts.provider ?? "octopus-anthropic";
	args.push("--provider", provider, "--model", model, "--thinking", "off");
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	// 注入 agent system prompt (写到临时文件, 避免命令行长度/分词问题)
	let tmpDir: string | null = null;
	if (agent.systemPrompt.trim()) {
		tmpDir = mkdtempSync(join(tmpdir(), "flux-agent-"));
		const tmpPrompt = join(tmpDir, "prompt.md");
		writeFileSync(tmpPrompt, agent.systemPrompt, "utf-8");
		args.push("--append-system-prompt", tmpPrompt);
	}
	// task 作为最后一个位置参数 (shell:false 不分词, 安全)
	args.push(`Task: ${task}`);

	const result: SubagentRunResult = {
		agent: agent.name, exitCode: 0, output: "",
		usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
		model: null,
	};

	try {
		const outputParts: string[] = [];
		let stderrBuf = "";
		const exitCode = await new Promise<number>((resolveExit) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";
			let settled = false;
			const done = (code: number) => { if (!settled) { settled = true; resolveExit(code); } };
			const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* */ } done(124); }, 60000);

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
						// F1-14: 优先本地算成本 (父进程 pricing table × token), 上游 cost.total 兜底
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
			proc.on("error", (err) => { result.errorMessage = `spawn error: ${err.message}`; clearTimeout(timer); done(1); });
			proc.on("close", (code) => { clearTimeout(timer); done(code ?? 0); });
		});

		result.exitCode = exitCode;
		result.output = outputParts.join("\n").slice(0, 50 * 1024);
		if (stderrBuf.trim() && exitCode !== 0) result.errorMessage = (result.errorMessage ?? "") + ` stderr: ${stderrBuf.slice(0, 500)}`;
	} finally {
		if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } }
	}

	const hitRate = result.usage.cacheRead / (result.usage.cacheRead + result.usage.input + 1e-9);
	telemetry?.writeSubagentRun({
		sessionId, agent: agent.name, task: task.slice(0, 200), model: result.model,
		turns: result.usage.turns, input: result.usage.input, output: result.usage.output,
		cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite,
		costUsd: Number(result.usage.cost.toFixed(6)), contextTokens: result.usage.contextTokens,
		cacheHitRate: Number(hitRate.toFixed(4)), prefixLayout, exitCode: result.exitCode,
	});

	return result;
}

/** 格式化 subagent 结果为工具返回 content */
export function formatSubagentResult(r: SubagentRunResult): string {
	const hitRate = r.usage.cacheRead / (r.usage.cacheRead + r.usage.input + 1e-9);
	return [
		`[AgentFlux subagent: ${r.agent}]`,
		`turns ${r.usage.turns} · in ${r.usage.input} · read ${r.usage.cacheRead} · hit ${(hitRate * 100).toFixed(0)}% · $${r.usage.cost.toFixed(4)}`,
		``,
		r.output || "(no output)",
	].join("\n");
}
