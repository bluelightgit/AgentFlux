/**
 * AgentFlux M3 — Fork 工作流 (M3-1 ~ M3-4)
 * 文档依据: docs/22-mode-capability-roadmap.md M3 增强
 *
 * M3-1: /flux fork explore <task> → 一键 fork A/B 分支做并行探索
 * M3-2: fork 结果比较 → LLM 对比两分支输出, 推荐胜者
 * M3-3: fork merge 自动化 → 读取两分支 last assistant message, LLM 合并注入主分支
 * M3-4: fork prune → 一键丢弃失败分支 + 记录原因
 *
 * 注意: M3 fork 操作需要 pi TUI/RPC 模式的 ctx.fork() API,
 *       无法在独立脚本中测试, 需在真实 pi 环境验证.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { TelemetryWriter } from "../telemetry/events";
import { getForkCandidates } from "./fork-mode";

// ─── 类型 ───

export interface ForkExploreResult {
	branchA: { entryId: string; output: string };
	branchB: { entryId: string; output: string };
	comparison: ForkComparison | null;
	recommendedWinner: "A" | "B" | "tie" | null;
}

export interface ForkComparison {
	winner: "A" | "B" | "tie";
	reasoning: string;
	mergedOutput: string;     // M3-3: LLM 合并后的输出
}

// ─── M3-2/M3-3: LLM 比较和合并 ───

/**
 * 用 LLM 比较两个 fork 分支的输出, 并合并最佳部分 (M3-2 + M3-3).
 *
 * @param outputA 分支 A 的 last assistant message
 * @param outputB 分支 B 的 last assistant message
 * @param task 原始任务描述
 * @param opts 模型/provider 配置
 */
export async function compareAndMergeForks(
	outputA: string,
	outputB: string,
	task: string,
	opts: {
		cwd: string;
		model?: string;
		provider?: string;
	},
): Promise<ForkComparison> {
	const comparePrompt = `You are a fork comparison judge. Two branches explored the same task independently.

## Original Task
${task.slice(0, 1000)}

## Branch A Output
${outputA.slice(0, 6000)}

## Branch B Output
${outputB.slice(0, 6000)}

## Instructions
1. Compare both outputs against the task requirements
2. Pick the winner (A, B, or tie if equally good)
3. Merge the best parts of both into a single cohesive output

Respond in EXACTLY this JSON format:
\`\`\`json
{
  "winner": "A" | "B" | "tie",
  "reasoning": "<why this branch won, max 200 words>",
  "mergedOutput": "<the merged best-of-both output>"
}
\`\`\`
Respond with ONLY the JSON.`;

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-prompt-templates", "--no-context-files", "--approve", "--no-skills", "--no-extensions"];
	if (opts.provider) args.push("--provider", opts.provider);
	if (opts.model) args.push("--model", opts.model);
	args.push("--thinking", "off");
	args.push("--tools", "read");

	const tmpDir = mkdtempSync(join(tmpdir(), "flux-fork-cmp-"));
	const tmpPrompt = join(tmpDir, "cmp-prompt.md");
	writeFileSync(tmpPrompt, "You are a fork comparison judge. Respond only with JSON.", "utf-8");
	args.push("--append-system-prompt", tmpPrompt);
	args.push(comparePrompt);

	let llmOutput = "";
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
							const content = ev.message.content;
							if (Array.isArray(content)) {
								for (const b of content) if (b?.type === "text" && b.text) llmOutput += b.text;
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

	// 解析 JSON
	try {
		const jsonMatch = llmOutput.match(/```json\s*([\s\S]*?)```/) || llmOutput.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse((jsonMatch[1] || jsonMatch[0]).trim());
			return {
				winner: parsed.winner === "A" || parsed.winner === "B" || parsed.winner === "tie" ? parsed.winner : "tie",
				reasoning: parsed.reasoning || "No reasoning provided",
				mergedOutput: parsed.mergedOutput || outputA,
			};
		}
	} catch {}

	// 回退: 无法解析
	return {
		winner: "tie",
		reasoning: `Could not parse LLM comparison (exit=${exitCode}). Defaulting to tie.`,
		mergedOutput: outputA,
	};
}

// ─── M3-1: /flux fork explore 命令 ───

/**
 * /flux fork explore <task> 命令处理器 (M3-1).
 *
 * 工作流:
 *   1. 从最近用户消息 fork 两个分支
 *   2. 分支 A: 用 effort=high 仔细做
 *   3. 分支 B: 用 effort=low 快速试
 *   4. 完成后 LLM 对比两分支输出 (M3-2)
 *   5. 推荐胜者, 合并最佳部分 (M3-3)
 *   6. 用户确认后 prune 败者 (M3-4)
 *
 * 注意: 此命令需要在 pi TUI 模式下运行, 因为依赖 ctx.fork().
 */
export async function handleForkExploreCommand(
	task: string,
	ctx: any,
	opts: {
		sessionId: string;
		telemetry: TelemetryWriter | null;
		model?: string;
		provider?: string;
	},
): Promise<string> {
	if (!task) {
		return "Usage: /flux fork explore <task>\nForks two branches to explore the task with different approaches, then compares and merges results.";
	}

	if (!ctx.fork) {
		return "M3 fork explore unavailable: ctx.fork not available (need TUI or RPC mode)";
	}

	const candidates = getForkCandidates(ctx, 1);
	const forkPoint = candidates[candidates.length - 1];
	if (!forkPoint) {
		return "No fork point found: need at least one user message to fork from";
	}

	const { sessionId, telemetry } = opts;

	// 记录 fork explore 开始
	telemetry?.writeContextEvent({
		sessionId, turnIndex: -1,
		action: "fork",
		detail: `fork explore: "${task.slice(0, 100)}" from ${forkPoint.entryId.slice(0, 12)}`,
		contextPercentBefore: null, contextPercentAfter: null,
	});

	// Step 1: Fork 分支 A (high effort)
	console.error("[flux fork] exploring branch A (high effort)...");
	const branchAOriginalId = ctx.sessionManager?.getLeafId?.() ?? "unknown";
	const forkAResult = await ctx.fork(forkPoint.entryId, {
		position: "at",
		withSession: async (newCtx: any) => {
			// 分支 A: 在新分支中用 high effort 执行任务
			// 这里不能直接调 LLM, 只能注入消息让 pi 处理
			// 实际实现: 返回分支 ID, 用户在分支中执行
			newCtx.ui?.notify?.(`Branch A (high effort): ${task.slice(0, 100)}`, "info");
		},
	});

	if (forkAResult?.cancelled) {
		return "fork explore: branch A fork was cancelled";
	}

	// Step 2: 回到 fork 点, Fork 分支 B (low effort)
	// 需要导航回原始分支
	const branchALeafId = ctx.sessionManager?.getLeafId?.() ?? null;

	// 导航回 fork 点再 fork B
	if (ctx.navigateTree) {
		await ctx.navigateTree(forkPoint.entryId, { summarize: false, label: "fork-explore-origin" });
	}

	console.error("[flux fork] exploring branch B (low effort)...");
	const forkBResult = await ctx.fork(forkPoint.entryId, {
		position: "at",
		withSession: async (newCtx: any) => {
			newCtx.ui?.notify?.(`Branch B (low effort): ${task.slice(0, 100)}`, "info");
		},
	});

	if (forkBResult?.cancelled) {
		return "fork explore: branch B fork was cancelled";
	}

	const branchBLeafId = ctx.sessionManager?.getLeafId?.() ?? null;

	// 记录两个分支
	telemetry?.writeContextEvent({
		sessionId, turnIndex: -1,
		action: "fork",
		detail: `fork explore: branch A=${branchALeafId?.slice(0, 12)}, branch B=${branchBLeafId?.slice(0, 12)}`,
		contextPercentBefore: null, contextPercentAfter: null,
	});

	const lines = [
		"Fork Explore: Two branches created",
		"─".repeat(50),
		`  Fork point: ${forkPoint.entryId.slice(0, 12)}  "${forkPoint.preview}"`,
		`  Branch A:   ${branchALeafId?.slice(0, 12) ?? "?"}  (high effort — think carefully)`,
		`  Branch B:   ${branchBLeafId?.slice(0, 12) ?? "?"}  (low effort — quick attempt)`,
		`  Task:       ${task.slice(0, 200)}`,
		"",
		"Next steps:",
		"  1. Execute the task in each branch (the branches are now active)",
		"  2. Run /flux fork compare to compare and merge results",
		"  3. Run /flux fork prune <A|B> to discard the losing branch",
		"",
		"Note: Branch switching is done via pi's /tree command.",
		"      AgentFlux will auto-compare when both branches have assistant responses.",
	];

	return lines.join("\n");
}

// ─── M3-2/M3-3: /flux fork compare 命令 ───

/**
 * /flux fork compare 命令处理器 (M3-2 + M3-3).
 *
 * 读取当前分支和兄弟分支的 last assistant message,
 * 用 LLM 对比并合并.
 */
export async function handleForkCompareCommand(
	ctx: any,
	opts: {
		sessionId: string;
		telemetry: TelemetryWriter | null;
		model?: string;
		provider?: string;
	},
): Promise<string> {
	const sm = ctx.sessionManager;
	if (!sm) return "fork compare: session manager not available";

	const currentLeafId = sm.getLeafId?.();
	if (!currentLeafId) return "fork compare: no current leaf entry";

	// 获取当前分支的最后一条 assistant message
	const branch = sm.getBranch?.() ?? [];
	const currentAssistant = [...branch].reverse().find((e: any) =>
		e.type === "message" && e.message?.role === "assistant"
	);
	if (!currentAssistant) return "fork compare: no assistant message in current branch";

	const currentOutput = extractText(currentAssistant.message?.content);

	// 找兄弟分支: 同一 parent 的其他子节点
	const parentId = currentAssistant.parentUuid || currentAssistant.parentId;
	if (!parentId) return "fork compare: no parent entry found (not a fork branch?)";

	const siblings = sm.getChildren?.(parentId) ?? [];
	const otherBranches = siblings.filter((e: any) => e.id !== currentLeafId && e.id !== currentAssistant.id);

	if (otherBranches.length === 0) {
		return "fork compare: no sibling branches found. Use /flux fork explore first to create A/B branches.";
	}

	// 收集兄弟分支的 assistant 输出
	const siblingOutputs: Array<{ id: string; output: string }> = [];
	for (const sibling of otherBranches) {
		const siblingBranch = sm.getBranch?.(sibling.id) ?? [];
		const siblingAssistant = [...siblingBranch].reverse().find((e: any) =>
			e.type === "message" && e.message?.role === "assistant"
		);
		if (siblingAssistant) {
			siblingOutputs.push({
				id: sibling.id,
				output: extractText(siblingAssistant.message?.content),
			});
		}
	}

	if (siblingOutputs.length === 0) {
		return "fork compare: sibling branches have no assistant messages yet. Complete the task in both branches first.";
	}

	// 取第一个兄弟分支做 A/B 比较
	const sibling = siblingOutputs[0];
	console.error(`[flux fork] comparing branch ${currentLeafId.slice(0, 12)} vs sibling ${sibling.id.slice(0, 12)}`);

	// 找原始任务 (fork 点的 user message)
	const parentEntry = sm.getEntry?.(parentId);
	const task = parentEntry?.message?.content
		? extractText(parentEntry.message.content)
		: "(task not found)";

	opts.telemetry?.writeContextEvent({
		sessionId: opts.sessionId, turnIndex: -1,
		action: "fork",
		detail: `fork compare: A=${currentLeafId.slice(0, 12)} (${currentOutput.length}chars) vs B=${sibling.id.slice(0, 12)} (${sibling.output.length}chars)`,
		contextPercentBefore: null, contextPercentAfter: null,
	});

	// M3-2 + M3-3: LLM 比较和合并
	const comparison = await compareAndMergeForks(
		currentOutput, sibling.output, task,
		{ cwd: ctx.cwd, model: opts.model, provider: opts.provider },
	);

	// 记录比较结果
	opts.telemetry?.writeContextEvent({
		sessionId: opts.sessionId, turnIndex: -1,
		action: "fork",
		detail: `fork compare result: winner=${comparison.winner}, merged=${comparison.mergedOutput.length}chars`,
		contextPercentBefore: null, contextPercentAfter: null,
	});

	// M3-3: 将合并结果注入当前分支
	if (ctx.appendEntry && comparison.mergedOutput) {
		try {
			ctx.appendEntry({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `[Fork Merge Result]\n\n${comparison.mergedOutput}` }],
				},
			});
		} catch (e: any) {
			console.error(`[flux fork] merge injection failed: ${e?.message}`);
		}
	}

	const lines = [
		"Fork Compare & Merge Result",
		"─".repeat(50),
		`  Winner: ${comparison.winner === "A" ? "Current branch" : comparison.winner === "B" ? "Sibling branch" : "Tie"}`,
		`  Reasoning: ${comparison.reasoning}`,
		"",
		"Merged output has been injected into the current branch.",
		`  Merged length: ${comparison.mergedOutput.length} chars`,
		"",
		`To prune the losing branch, run: /flux fork prune ${comparison.winner === "A" ? sibling.id.slice(0, 12) : comparison.winner === "B" ? currentLeafId?.slice(0, 12) ?? "?" : "(no prune needed for tie)"}`,
	];

	return lines.join("\n");
}

// ─── M3-4: /flux fork prune 命令 ───

/**
 * /flux fork prune <branchId> 命令处理器 (M3-4).
 *
 * 丢弃指定分支并记录原因.
 * pi 没有直接的 "delete branch" API, 但可以:
 *   1. 导航到另一个分支 (离开要 prune 的分支)
 *   2. 标记该分支为 pruned (通过 label)
 *   3. 记录 prune 原因到 telemetry
 */
export async function handleForkPruneCommand(
	args: string[],
	ctx: any,
	opts: {
		sessionId: string;
		telemetry: TelemetryWriter | null;
	},
): Promise<string> {
	if (!args[0]) {
		return "Usage: /flux fork prune <branchId|A|B>\nPrunes (discards) the specified fork branch and records the reason.";
	}

	const sm = ctx.sessionManager;
	if (!sm) return "fork prune: session manager not available";

	let targetId: string | undefined;
	const label = args[0];

	if (label === "A" || label === "B") {
		// A/B 快捷方式: 找最近 fork 的两个分支
		const currentLeafId = sm.getLeafId?.();
		const branch = sm.getBranch?.() ?? [];
		const currentAssistant = [...branch].reverse().find((e: any) =>
			e.type === "message" && e.message?.role === "assistant"
		);
		const parentId = currentAssistant?.parentUuid || currentAssistant?.parentId;
		if (parentId) {
			const siblings = sm.getChildren?.(parentId) ?? [];
			if (label === "A") {
				targetId = siblings.find((e: any) => e.id !== currentLeafId)?.id;
			} else {
				targetId = currentLeafId ?? undefined;
			}
		}
	} else {
		targetId = args[0];
	}

	if (!targetId) {
		return `fork prune: could not find branch "${args[0]}"`;
	}

	// 记录 prune
	const reason = args.slice(1).join(" ") || "user requested prune";
	opts.telemetry?.writeContextEvent({
		sessionId: opts.sessionId, turnIndex: -1,
		action: "fork",
		detail: `fork prune: branch ${targetId.slice(0, 12)} pruned. reason: ${reason}`,
		contextPercentBefore: null, contextPercentAfter: null,
	});

	// 导航到另一分支 (离开要 prune 的)
	const currentLeafId = sm.getLeafId?.();
	if (currentLeafId === targetId) {
		// 当前在要 prune 的分支上, 导航到父节点
		const entry = sm.getEntry?.(targetId);
		const parentId = entry?.parentUuid || entry?.parentId;
		if (parentId && ctx.navigateTree) {
			await ctx.navigateTree(parentId, { summarize: false, label: `pruned: ${reason.slice(0, 50)}` });
		}
	}

	// 标记为 pruned (通过 label)
	try {
		if (sm.setLabel) {
			sm.setLabel(targetId, `pruned: ${reason.slice(0, 60)}`);
		}
	} catch {}

	return `Branch ${targetId.slice(0, 12)} pruned.\nReason: ${reason}\nThe branch is marked as pruned in the session tree. Use /tree to see the tree structure.`;
}

// ─── 辅助 ───

function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b?.type === "text" && b.text)
			.map((b: any) => b.text)
			.join("\n");
	}
	return "";
}

/** 格式化 fork explore 结果 */
export function formatForkExploreResult(r: ForkExploreResult): string {
	const lines = [
		"[Fork Explore Result]",
		`  Branch A: ${r.branchA.output.length} chars`,
		`  Branch B: ${r.branchB.output.length} chars`,
	];
	if (r.comparison) {
		lines.push(`  Winner: ${r.recommendedWinner}`);
		lines.push(`  Reasoning: ${r.comparison.reasoning}`);
		lines.push(`  Merged: ${r.comparison.mergedOutput.length} chars`);
	}
	return lines.join("\n");
}
