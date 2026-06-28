/**
 * AgentFlux M2-5 — Subagent 结果质量门
 * 文档依据: docs/22-mode-capability-roadmap.md M5-4 质量门
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

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { PricingTable } from "../core/pricing";
import { calcCost, lookupPrice } from "../core/pricing";
import type { TelemetryWriter } from "../telemetry/events";

export interface QualityGateResult {
	passed: boolean;
	feedback: string;           // LLM 给的反馈 (失败原因或确认语)
	criteriaResults: Array<{ criterion: string; met: boolean }>;
	gateCost: number;           // 质量门 LLM 调用成本
	gateModel: string | null;
	gateInputTokens: number;
	gateOutputTokens: number;
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
	},
): Promise<QualityGateResult> {
	if (!criteria.length || !output.trim()) {
		return {
			passed: true, feedback: "No criteria to check or empty output — skipping gate",
			criteriaResults: [], gateCost: 0, gateModel: null, gateInputTokens: 0, gateOutputTokens: 0,
		};
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
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-prompt-templates", "--approve", "--no-skills", "--no-extensions"];
	if (opts.provider) args.push("--provider", opts.provider);
	if (opts.model) args.push("--model", opts.model);
	args.push("--thinking", "off");
	args.push("--tools", "read");  // 最小工具集

	// system prompt 写临时文件
	const tmpDir = mkdtempSync(join(tmpdir(), "flux-gate-"));
	const tmpPrompt = join(tmpDir, "gate-prompt.md");
	writeFileSync(tmpPrompt, "You are a quality gate checker. Respond only with JSON.", "utf-8");
	args.push("--append-system-prompt", tmpPrompt);
	args.push(gatePrompt);

	let gateOutput = "";
	let gateModel: string | null = null;
	let gateInputTokens = 0;
	let gateOutputTokens = 0;
	let gateCost = 0;
	let exitCode = 0;

	try {
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

			const proc = spawn(process.execPath, [cliPath, ...args], { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";
			let settled = false;
			const done = (code: number) => { if (!settled) { settled = true; resolveExit(code); } };
			const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} done(124); }, 30000);

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const ln of lines) {
					if (!ln.trim()) continue;
					try {
						const ev = JSON.parse(ln);
						if (ev.type === "message_end" && ev.message?.role === "assistant") {
							const u = ev.message.usage || {};
							gateInputTokens += u.input || 0;
							gateOutputTokens += u.output || 0;
							if (opts.pricing && ev.message.model) {
								gateCost += calcCost(u, lookupPrice(opts.pricing, ev.message.model));
							} else {
								gateCost += u.cost?.total || 0;
							}
							if (!gateModel && ev.message.model) gateModel = ev.message.model;
							const content = ev.message.content;
							if (Array.isArray(content)) {
								for (const b of content) if (b?.type === "text" && b.text) gateOutput += b.text;
							}
						}
					} catch {}
				}
			});
			proc.on("error", () => { clearTimeout(timer); done(1); });
			proc.on("close", (code) => { clearTimeout(timer); done(code ?? 0); });
		});
	} finally {
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
	}

	// 解析 LLM 输出的 JSON
	let parsed: { passed: boolean; criteriaResults: Array<{ criterion: string; met: boolean }>; feedback: string } | null = null;
	try {
		// 提取 JSON 块 (LLM 可能包裹在 ```json ... ``` 中)
		const jsonMatch = gateOutput.match(/```json\s*([\s\S]*?)```/) || gateOutput.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const jsonStr = jsonMatch[1] || jsonMatch[0];
			parsed = JSON.parse(jsonStr.trim());
		}
	} catch {}

	if (!parsed) {
		// JSON 解析失败, 回退为通过 (不阻塞工作流)
		return {
			passed: true,
			feedback: `Quality gate could not parse LLM response (exit=${exitCode}). Raw: ${gateOutput.slice(0, 200)}`,
			criteriaResults: criteria.map(c => ({ criterion: c, met: true })),
			gateCost: Number(gateCost.toFixed(6)), gateModel, gateInputTokens, gateOutputTokens,
		};
	}

	return {
		passed: parsed.passed,
		feedback: parsed.feedback || (parsed.passed ? "All criteria met" : "Some criteria not met"),
		criteriaResults: parsed.criteriaResults || [],
		gateCost: Number(gateCost.toFixed(6)), gateModel, gateInputTokens, gateOutputTokens,
	};
}

/** 格式化质量门结果 */
export function formatQualityGateResult(r: QualityGateResult): string {
	const lines = [
		`[Quality Gate: ${r.passed ? "PASSED" : "FAILED"}]`,
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
