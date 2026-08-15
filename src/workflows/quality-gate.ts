/**
 * AgentFlux Agent/Workflow 结果质量门。
 *
 * 用轻量级 LLM 调用检查 subagent 产出是否满足 acceptance criteria.
 * 不通过时返回失败原因, 可用于自动重试.
 *
 * 设计:
 *   - 用便宜模型 (deepseek-v4-flash) 做门检查, 成本极低
 *   - 输入: subagent 输出 + acceptance criteria 列表
 *   - 输出: { passed, feedback, criteriaMet[] }
 *   - 延迟: 单次 LLM 调用, ~3-5s
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { PricingTable } from "../core/pricing";
import { calcCost, lookupPrice } from "../core/pricing";
import type { TelemetryWriter } from "../telemetry/events";

export type QualityGateStatus = "passed" | "failed" | "indeterminate";

export interface QualityGateResult {
	/** 三态结果。indeterminate 表示 judge 不可用或响应不可验证。 */
	status: QualityGateStatus;
	/** 仅 status="passed" 时为 true。 */
	passed: boolean;
	feedback: string;           // LLM 给的反馈 (失败原因或确认语)
	criteriaResults: Array<{ criterion: string; met: boolean }>;
	gateCost: number;           // 质量门 LLM 调用成本
	gateModel: string | null;
	gateInputTokens: number;
	gateOutputTokens: number;
}

export interface QualityGateJudgement {
	status: QualityGateStatus;
	passed: boolean;
	feedback: string;
	criteriaResults: Array<{ criterion: string; met: boolean }>;
}

/**
 * judge 子进程的可测试执行结果。把进程管理和 verdict 解释分开，
 * 使 timeout/model error/parse error 能在不调用真实模型的情况下回归测试。
 */
export interface QualityGateJudgeExecution {
	output: string;
	exitCode: number;
	timedOut?: boolean;
	errorMessage?: string;
	gateCost?: number;
	gateModel?: string | null;
	gateInputTokens?: number;
	gateOutputTokens?: number;
}

function indeterminateJudgement(feedback: string): QualityGateJudgement {
	return { status: "indeterminate", passed: false, feedback, criteriaResults: [] };
}

/** 严格解析 judge JSON；字段缺失、label 数量不符或 verdict 自相矛盾都返回 indeterminate。 */
export function parseQualityGateJudgeOutput(output: string, criteria: string[]): QualityGateJudgement {
	if (criteria.length === 0) {
		return { status: "passed", passed: true, feedback: "No criteria to check — gate skipped", criteriaResults: [] };
	}

	const jsonMatch = output.match(/```json\s*([\s\S]*?)```/) || output.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return indeterminateJudgement("Quality gate judge response did not contain JSON");

	let parsed: unknown;
	try {
		parsed = JSON.parse((jsonMatch[1] || jsonMatch[0]).trim());
	} catch (e: any) {
		return indeterminateJudgement(`Quality gate judge returned invalid JSON: ${e?.message ?? e}`);
	}

	if (!parsed || typeof parsed !== "object") {
		return indeterminateJudgement("Quality gate judge response is not an object");
	}

	const candidate = parsed as Record<string, unknown>;
	if (typeof candidate.passed !== "boolean" || typeof candidate.feedback !== "string" || !Array.isArray(candidate.criteriaResults)) {
		return indeterminateJudgement("Quality gate judge response does not match the required schema");
	}
	if (candidate.criteriaResults.length !== criteria.length) {
		return indeterminateJudgement(`Quality gate judge returned ${candidate.criteriaResults.length}/${criteria.length} criteria results`);
	}

	const normalized: Array<{ criterion: string; met: boolean }> = [];
	for (let i = 0; i < criteria.length; i++) {
		const raw = candidate.criteriaResults[i];
		if (!raw || typeof raw !== "object" || typeof (raw as any).criterion !== "string" || typeof (raw as any).met !== "boolean") {
			return indeterminateJudgement(`Quality gate judge criterion ${i + 1} is malformed`);
		}
		normalized.push({ criterion: criteria[i], met: (raw as any).met });
	}

	const allMet = normalized.every(r => r.met);
	if (candidate.passed !== allMet) {
		return indeterminateJudgement("Quality gate judge verdict conflicts with its per-criterion results");
	}

	const status: QualityGateStatus = candidate.passed ? "passed" : "failed";
	return {
		status,
		passed: status === "passed",
		feedback: candidate.feedback || (status === "passed" ? "All criteria met" : "Some criteria not met"),
		criteriaResults: normalized,
	};
}

/** 将进程级错误与 judge JSON 合并为最终三态结果。 */
export function interpretQualityGateJudgeExecution(
	execution: QualityGateJudgeExecution,
	criteria: string[],
): QualityGateResult {
	const metrics = {
		gateCost: Number((execution.gateCost ?? 0).toFixed(6)),
		gateModel: execution.gateModel ?? null,
		gateInputTokens: execution.gateInputTokens ?? 0,
		gateOutputTokens: execution.gateOutputTokens ?? 0,
	};

	let judgement: QualityGateJudgement;
	if (criteria.length === 0) {
		judgement = { status: "passed", passed: true, feedback: "No criteria to check — gate skipped", criteriaResults: [] };
	} else if (execution.timedOut) {
		judgement = indeterminateJudgement("Quality gate judge timed out");
	} else if (execution.errorMessage) {
		judgement = indeterminateJudgement(`Quality gate judge unavailable: ${execution.errorMessage}`);
	} else if (execution.exitCode !== 0) {
		judgement = indeterminateJudgement(`Quality gate judge exited with code ${execution.exitCode}`);
	} else if (!execution.output.trim()) {
		judgement = indeterminateJudgement("Quality gate judge returned empty output");
	} else {
		judgement = parseQualityGateJudgeOutput(execution.output, criteria);
	}

	return { ...judgement, ...metrics };
}

/**
 * 运行质量门检查.
 *
 * @param output subagent 的输出文本
 * @param criteria acceptance criteria 列表 (字符串数组)
 * @param opts 模型/provider/pricing 配置
 * @returns QualityGateResult
 */
export async function checkQualityGate(
	output: string,
	criteria: string[],
	opts: {
		cwd: string;
		model?: string;
		provider?: string;
		pricing?: PricingTable;
		telemetry?: TelemetryWriter;
		sessionId?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
	},
): Promise<QualityGateResult> {
	if (!criteria.length) return interpretQualityGateJudgeExecution({ output: "", exitCode: 0 }, criteria);
	if (opts.signal?.aborted) {
		return interpretQualityGateJudgeExecution({ output: "", exitCode: 130, errorMessage: "cancelled before quality gate" }, criteria);
	}
	if (!output.trim()) {
		return interpretQualityGateJudgeExecution({
			output: "", exitCode: 0, errorMessage: "agent output is empty",
		}, criteria);
	}

	const criteriaText = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
	const gatePrompt = `You are a quality gate checker. Determine if the following agent output meets ALL acceptance criteria.

## Acceptance Criteria
${criteriaText}

## Agent Output
${output.slice(0, 8000)}

## Instructions
Check each criterion against the output. Respond in EXACTLY this JSON format:
\`\`\`json
{
  "passed": true/false,
  "criteriaResults": [
    { "criterion": "<criterion text>", "met": true/false }
  ],
  "feedback": "<brief explanation, max 200 words>"
}
\`\`\`
Respond with ONLY the JSON, no other text.`;

	// 用 pi 子进程做一次轻量级 LLM 调用
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-prompt-templates", "--no-context-files", "--approve", "--no-skills", "--no-extensions"];
	if (opts.provider) args.push("--provider", opts.provider);
	if (opts.model) args.push("--model", opts.model);
	args.push("--thinking", "off");
	args.push("--tools", "read");  // 最小工具集

	let gateOutput = "";
	let gateModel: string | null = null;
	let gateInputTokens = 0;
	let gateOutputTokens = 0;
	let gateCost = 0;
	let exitCode = 0;
	let timedOut = false;
	let errorMessage: string | undefined;
	let stderrBuf = "";
	let tmpDir: string | null = null;

	try {
		// system prompt 写临时文件
		tmpDir = mkdtempSync(join(tmpdir(), "flux-gate-"));
		const tmpPrompt = join(tmpDir, "gate-prompt.md");
		writeFileSync(tmpPrompt, "You are a quality gate checker. Respond only with JSON.", "utf-8");
		args.push("--append-system-prompt", tmpPrompt);
		args.push(gatePrompt);

		exitCode = await new Promise<number>((resolveExit) => {
			const req = createRequire(import.meta.url);
			let cliPath = "";
			try { cliPath = req.resolve("@earendil-works/pi-coding-agent/dist/cli.js"); } catch {}
			if (!cliPath) {
				try {
					const searchPaths = req.resolve.paths("@earendil-works/pi-coding-agent") ?? [];
					for (const p of searchPaths) {
						const candidate = join(p, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
						if (existsSync(candidate)) { cliPath = candidate; break; }
					}
				} catch {}
			}
			if (!cliPath) cliPath = process.argv[1] ?? "";

			const proc = spawn(process.execPath, [cliPath, ...args], {
				cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32", windowsHide: true,
			});
			let buffer = "";
			let settled = false;
			let forcedExitCode: number | null = null;
			const killTree = () => {
				if (!proc.pid) { try { proc.kill("SIGKILL"); } catch {} return; }
				// Windows 用 taskkill /T 遍历整个进程树；POSIX 负 PID 杀独立进程组。
				if (process.platform === "win32") {
					try {
						spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
							shell: false, stdio: "ignore", windowsHide: true, timeout: 7000,
						});
					} catch { try { proc.kill("SIGKILL"); } catch {} }
					return;
				}
				try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
			};
			const onAbort = () => {
				forcedExitCode = 130;
				errorMessage = "cancelled during quality gate";
				killTree();
				done(130);
			};
			const done = (code: number) => {
				if (!settled) {
					settled = true;
					opts.signal?.removeEventListener("abort", onAbort);
					resolveExit(code);
				}
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(() => {
				timedOut = true;
				errorMessage = `timeout after ${opts.timeoutMs ?? 30000}ms`;
				killTree();
				done(124);
			}, opts.timeoutMs ?? 30000);

			const processLine = (ln: string) => {
				if (!ln.trim()) return;
				try {
					const ev = JSON.parse(ln);
					if (ev.type !== "message_end" || ev.message?.role !== "assistant") return;
					const u = ev.message.usage || {};
					gateInputTokens += u.input || 0;
					gateOutputTokens += u.output || 0;
					if (opts.pricing && ev.message.model) {
						gateCost += calcCost(u, lookupPrice(opts.pricing, ev.message.model));
					} else {
						gateCost += u.cost?.total || 0;
					}
					if (!gateModel && ev.message.model) gateModel = ev.message.model;
					if (ev.message.errorMessage) errorMessage = ev.message.errorMessage;
					const content = ev.message.content;
					if (Array.isArray(content)) {
						for (const b of content) if (b?.type === "text" && b.text) gateOutput += b.text;
					}
				} catch { /* 非 JSON 行不属于 pi 事件流 */ }
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const ln of lines) processLine(ln);
			});
			proc.stderr.on("data", data => {
				stderrBuf = (stderrBuf + data.toString()).slice(-8000);
			});
			proc.on("error", (err) => {
				errorMessage = `spawn error: ${err.message}`;
				clearTimeout(timer);
				done(1);
			});
			proc.on("close", (code, signal) => {
				clearTimeout(timer);
				if (buffer.trim()) processLine(buffer);
				if (code == null && signal && !timedOut) errorMessage = `judge terminated by ${signal}`;
				done(forcedExitCode ?? (code ?? (signal ? 1 : 0)));
			});
		});
	} catch (e: any) {
		exitCode = 1;
		errorMessage = `judge execution error: ${e?.message ?? e}`;
	} finally {
		if (tmpDir) {
			try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
		}
	}

	if (!errorMessage && exitCode !== 0 && stderrBuf.trim()) errorMessage = stderrBuf.trim().slice(0, 500);
	return interpretQualityGateJudgeExecution({
		output: gateOutput,
		exitCode,
		timedOut,
		errorMessage,
		gateCost,
		gateModel,
		gateInputTokens,
		gateOutputTokens,
	}, criteria);
}

/** 格式化质量门结果 */
export function formatQualityGateResult(r: QualityGateResult): string {
	const status = r.status ?? (r.passed ? "passed" : "failed");
	const lines = [
		`[Quality Gate: ${status.toUpperCase()}]`,
		`  gate cost: $${r.gateCost.toFixed(6)} (${r.gateInputTokens} in / ${r.gateOutputTokens} out)`,
	];
	if (r.criteriaResults.length > 0) {
		lines.push("  Criteria:");
		for (const c of r.criteriaResults) {
			lines.push(`    ${c.met ? "✅" : "❌"} ${c.criterion}`);
		}
	}
	lines.push(`  Feedback: ${r.feedback}`);
	return lines.join("\n");
}
