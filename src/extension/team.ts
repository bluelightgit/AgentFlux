/**
 * Team 管理 — /flux team 命令实现
 * 文档依据: docs/18-agent-roles.md, docs/19-multi-agent-architecture.md
 *
 * 命令:
 *   /flux team status        — Show all agent instances + blackboard
 *   /flux team plan <task>   — Launch planner agent for task analysis
 *   /flux team build <task>  — 创建 implementer instance执行任务
 *   /flux team review        — Launch reviewer agent for current changes
 *   /flux team abort <name>  — Abort a specific instance
 *   /flux team roles         — List all role definitions
 *   /flux team models        — List all models + capability + assignment
 *   /flux team affinity      — Show per-role model affinity ranking
 */

import { loadAllRoles, createInstance, loadRegistry, saveRegistry, formatRoleList, formatInstanceList, type RoleDefinition, type RoleInstance } from "../core/role-manager";
import { SharedBoard, formatBlackboard, formatTaskList, generateHandoffContent } from "../core/shared-board";
import { resolveCapability, calcAffinity, rankModels, formatCapability, formatAffinityTable, type ModelCapability } from "../core/model-capability";
import { runSubagent, loadSubagent, formatSubagentResult } from "./subagent";
import type { TelemetryWriter } from "../telemetry/events";
import { join } from "node:path";

export interface TeamContext {
	cwd: string;
	fluxDir: string;
	telemetry: TelemetryWriter;
	modelsConfig: any;          // models.json 完整内容
	sharedSkills?: string[];
	prefixLayout: boolean;
	pricing?: any;             // F1-14: PricingTable 用于子进程成本计算
}

// ──────────────────────────────── 命令处理 ────────────────────────────────

export async function handleTeamCommand(
	parts: string[],
	ctx: any,
	teamCtx: TeamContext,
): Promise<void> {
	const sub = parts[0];

	if (sub === "status") return cmdTeamStatus(ctx, teamCtx);
	if (sub === "plan") return cmdTeamPlan(parts.slice(1).join(" "), ctx, teamCtx);
	if (sub === "build") return cmdTeamBuild(parts.slice(1).join(" "), ctx, teamCtx);
	if (sub === "review") return cmdTeamReview(ctx, teamCtx);
	if (sub === "abort") return cmdTeamAbort(parts[1], ctx, teamCtx);
	if (sub === "roles") return cmdTeamRoles(ctx, teamCtx);
	if (sub === "models") return cmdTeamModels(ctx, teamCtx);
	if (sub === "affinity") return cmdTeamAffinity(ctx, teamCtx);
	if (sub === "pipeline") return cmdTeamPipeline(parts.slice(1).join(" "), ctx, teamCtx);

	// 默认: 显示帮助
	const help = [
		"AgentFlux Team Commands:",
		"  /flux team status         — Show all agent instances + blackboard",
		"  /flux team plan <task>    — Launch planner agent for task analysis",
		"  /flux team build <task>   — Launch implementer agent (auto-chains planner handoff)",
		"  /flux team review         — Launch reviewer agent (auto-chains implementer handoff)",
		"  /flux team pipeline <task>— M5 pipeline: plan->build->review auto-chain",
		"  /flux team abort <name>   — Abort a specific instance",
		"  /flux team roles          — List all role definitions",
		"  /flux team models         — List all models + capability + assignment",
		"  /flux team affinity       — Show per-role model affinity ranking",
	].join("\n");
	if (ctx.hasUI) ctx.ui.notify(help, "info");
	else console.log(help);
}

// ──────────────────────────────── 具体命令 ────────────────────────────────

function cmdTeamStatus(ctx: any, teamCtx: TeamContext): void {
	const board = new SharedBoard(teamCtx.fluxDir);
	const registry = loadRegistry(teamCtx.fluxDir);
	const bb = board.getBlackboard();
	const tasks = board.listTasks();
	const text = [
		formatBlackboard(bb),
		"",
		formatTaskList(tasks),
		"",
		formatInstanceList(registry),
	].join("\n");
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	else console.log(text);
}

function cmdTeamRoles(ctx: any, teamCtx: TeamContext): void {
	const roles = loadAllRoles(teamCtx.cwd, teamCtx.modelsConfig);
	const text = formatRoleList(roles);
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	else console.log(text);
}

function cmdTeamModels(ctx: any, teamCtx: TeamContext): void {
	const models = teamCtx.modelsConfig?.models ?? {};
	const lines = ["Models:", ""];
	for (const [name, entry] of Object.entries(models)) {
		const e = entry as any;
		const cap = resolveCapability(name, e, models);
		lines.push(`  ${name.padEnd(20)} ${formatCapability(cap)}`);
		if (e.provider) lines.push(`    provider=${e.provider}  ctx=${e.contextWindow}`);
	}
	if (lines.length <= 2) lines.push("  (models.json 中无models defined in models.json)");
	if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
	else console.log(lines.join("\n"));
}

function cmdTeamAffinity(ctx: any, teamCtx: TeamContext): void {
	const roles = loadAllRoles(teamCtx.cwd, teamCtx.modelsConfig);
	const models = teamCtx.modelsConfig?.models ?? {};
	const lines: string[] = ["Affinity Analysis:", ""];

	for (const [roleName, role] of roles) {
		if (!role.requirement) {
			lines.push(`  ${roleName}: model=${role.model ?? "(未指定)"}`);
			continue;
		}
		const ranked = rankModels(role.requirement, models);
		lines.push(`  ${roleName}:`);
		for (const r of ranked) {
			const marker = r === ranked[0] ? "★" : " ";
			lines.push(`    ${marker} ${r.model.padEnd(20)} affinity=${r.affinity.toFixed(3)}`);
		}
		lines.push("");
	}

	if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
	else console.log(lines.join("\n"));
}

async function cmdTeamPlan(task: string, ctx: any, teamCtx: TeamContext): Promise<void> {
	if (!task) {
		const msg = "Usage: /flux team plan <task description>";
		if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
		return;
	}
	await runTeamAgent("planner", task, ctx, teamCtx);
}

async function cmdTeamBuild(task: string, ctx: any, teamCtx: TeamContext): Promise<void> {
	if (!task) {
		const msg = "Usage: /flux team build <task description>";
		if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
		return;
	}
	// M5 pipeline: auto-find latest planner handoff, prepend to task
	const board = new SharedBoard(teamCtx.fluxDir);
	const plannerHandoff = findLatestHandoff(teamCtx.fluxDir, "planner");
	if (plannerHandoff) {
		task = `[Previous Planner Handoff]\n${plannerHandoff.slice(0, 3000)}\n\n---\n\n[Your Task]\n${task}`;
		console.error(`[flux team] build: chained planner handoff (${plannerHandoff.length} chars)`);
	}
	await runTeamAgent("implementer", task, ctx, teamCtx, "planner");
}

async function cmdTeamReview(ctx: any, teamCtx: TeamContext): Promise<void> {
	// M5 pipeline: auto-find latest implementer handoff
	const board = new SharedBoard(teamCtx.fluxDir);
	const implHandoff = findLatestHandoff(teamCtx.fluxDir, "implementer");

	// 获取当前 git diff 作为审查对象
	const { execSync } = require("node:child_process");
	let diff = "";
	try {
		diff = execSync("git diff HEAD", { cwd: teamCtx.cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 }).trim();
	} catch {}
	if (!diff) {
		try { diff = execSync("git diff", { cwd: teamCtx.cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 }).trim(); } catch {}
	}

	let task: string;
	if (implHandoff) {
		task = `[Previous Implementer Handoff]\n${implHandoff.slice(0, 3000)}\n\n---\n\n[Your Task]\nReview the implementation described above.`;
		if (diff) task += `\n\nAlso review the current git diff:\n\n\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\``;
		console.error(`[flux team] review: chained implementer handoff (${implHandoff.length} chars)`);
	} else if (diff) {
		task = `Review the following git diff:\n\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\`\n\nProvide structured review.`;
	} else {
		task = "Review the current codebase for issues. No uncommitted changes found, review recent commits.";
	}
	await runTeamAgent("reviewer", task, ctx, teamCtx, "implementer");
}

async function cmdTeamPipeline(task: string, ctx: any, teamCtx: TeamContext): Promise<void> {
	if (!task) {
		const msg = "Usage: /flux team pipeline <task description>\nauto-run plan→build→review pipeline";
		if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
		return;
	}
	const banner = `M5 Pipeline: plan → build → review\nTask: ${task.slice(0, 200)}`;
	if (ctx.hasUI) ctx.ui.notify(banner, "info");
	console.error(`[flux team] === ${banner} ===`);

	// Step 1: plan
	console.error("[flux team] pipeline step 1/3: plan");
	await runTeamAgent("planner", task, ctx, teamCtx);

	// Step 2: build (自动拼接 planner handoff)
	console.error("[flux team] pipeline step 2/3: build");
	const plannerHandoff = findLatestHandoff(teamCtx.fluxDir, "planner");
	const buildTask = plannerHandoff
		? `[Previous Planner Handoff]\n${plannerHandoff.slice(0, 3000)}\n\n---\n\n[Your Task]\n${task}`
		: task;
	await runTeamAgent("implementer", buildTask, ctx, teamCtx, "planner");

	// Step 3: review (自动拼接 implementer handoff + git diff)
	console.error("[flux team] pipeline step 3/3: review");
	const implHandoff = findLatestHandoff(teamCtx.fluxDir, "implementer");
	const { execSync } = require("node:child_process");
	let diff = "";
	try { diff = execSync("git diff HEAD", { cwd: teamCtx.cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 }).trim(); } catch {}
	let reviewTask: string;
	if (implHandoff) {
		reviewTask = `[Previous Implementer Handoff]\n${implHandoff.slice(0, 3000)}\n\n---\n\n[Your Task]\nReview the implementation described above.`;
		if (diff) reviewTask += `\n\nAlso review the current git diff:\n\n\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\``;
	} else if (diff) {
		reviewTask = `Review the following git diff:\n\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\`\n\nProvide structured review.`;
	} else {
		reviewTask = "Review the current codebase for issues.";
	}
	await runTeamAgent("reviewer", reviewTask, ctx, teamCtx, "implementer");

	const done = "M5 Pipeline Done. use /flux team status to see results.";
	if (ctx.hasUI) ctx.ui.notify(done, "info");
	console.error(`[flux team] === ${done} ===`);
}

async function cmdTeamAbort(name: string, ctx: any, teamCtx: TeamContext): Promise<void> {
	if (!name) {
		const msg = "Usage: /flux team abort <instance name>";
		if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
		return;
	}
	const registry = loadRegistry(teamCtx.fluxDir);
	const inst = registry.instances.find(i => i.name === name);
	if (!inst) {
		const msg = `instance ${name} does not exist`;
		if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
		return;
	}
	inst.status = "failed";
	saveRegistry(teamCtx.fluxDir, registry);
	const board = new SharedBoard(teamCtx.fluxDir);
	board.updateAgentStatus(name, { status: "failed" });
	const msg = `instance ${name} 已终止`;
	if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
}

// ──────────────────────────────── 核心: 运行 team agent ────────────────────────────────

async function runTeamAgent(
	roleName: string,
	task: string,
	ctx: any,
	teamCtx: TeamContext,
	handoffFromRole?: string,
): Promise<void> {
	const roles = loadAllRoles(teamCtx.cwd, teamCtx.modelsConfig);
	const role = roles.get(roleName);
	if (!role) {
		const msg = `role ${roleName} does not exist。可用role: ${[...roles.keys()].join(", ")}`;
		if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
		return;
	}

	const models = teamCtx.modelsConfig?.models ?? {};
	if (Object.keys(models).length === 0) {
		const msg = "models.json 中无models defined in models.json, 无法Launching team agent";
		if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
		return;
	}

	// 创建instance
	const sessionId = `flux-team-${roleName}-${Date.now()}`;
	const instance = createInstance(roleName, role, models, task, sessionId);
	const registry = loadRegistry(teamCtx.fluxDir);
	registry.instances.push(instance);
	saveRegistry(teamCtx.fluxDir, registry);

	// 更新blackboard
	const board = new SharedBoard(teamCtx.fluxDir);
	board.updateAgentStatus(instance.name, { status: "running", workingOn: task.slice(0, 100) });

	const modelInfo = `${instance.model} (${instance.assignSource.source})`;
	const startMsg = `Launching ${instance.name} [${roleName}] → ${modelInfo}\nTask: ${task.slice(0, 200)}`;
	if (ctx.hasUI) ctx.ui.notify(startMsg, "info");
	console.error(`[flux team] ${startMsg}`);

	// 加载 agent 定义 (转换为 subagent.ts 可用的格式)
	const agent = roleToSubagent(role, instance.model, teamCtx, instance.provider);

	try {
		const result = await runSubagent({
			cwd: teamCtx.cwd,
			agent,
			task,
			sessionId: instance.session,
			telemetry: teamCtx.telemetry,
			prefixLayout: teamCtx.prefixLayout,
			pricing: teamCtx.pricing,
		});

		// 更新instance状态
		const reg = loadRegistry(teamCtx.fluxDir);
		const inst = reg.instances.find(i => i.name === instance.name);
		if (inst) {
			inst.status = "done";
			inst.output = result.output?.slice(0, 500);
			saveRegistry(teamCtx.fluxDir, reg);
		}

		// 更新blackboard
		board.updateAgentStatus(instance.name, { status: "done", output: "Done" });

		// 写 handoff (如果有输出)
		if (result.output) {
			const handoffPath = board.writeHandoff(
				instance.name,
				"next",
				generateHandoffContent(instance.name, "next", task, { output: result.output.slice(0, 2000) }),
			);
			console.error(`[flux team] handoff written: ${handoffPath}`);
		}

		const summary = formatSubagentResult(result);
		if (ctx.hasUI) ctx.ui.notify(summary, "info");
		console.error(`[flux team] ${instance.name} done:\n${summary}`);
	} catch (e: any) {
		// 更新instance状态为失败
		const reg = loadRegistry(teamCtx.fluxDir);
		const inst = reg.instances.find(i => i.name === instance.name);
		if (inst) {
			inst.status = "failed";
			saveRegistry(teamCtx.fluxDir, reg);
		}
		board.updateAgentStatus(instance.name, { status: "failed" });
		const errMsg = `${instance.name} 失败: ${e?.message}`;
		if (ctx.hasUI) ctx.ui.notify(errMsg, "error");
		console.error(`[flux team] ${errMsg}`);
	}
}

// ──────────────────────────────── 辅助 ────────────────────────────────

/** 查找最近的某个role的 handoff 文件内容 */
function findLatestHandoff(fluxDir: string, rolePrefix: string): string | null {
	const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
	const dir = join(fluxDir, "shared", "handoffs");
	if (!existsSync(dir)) return null;
	const files = readdirSync(dir).filter((f: string) => f.endsWith(".md") && f.startsWith(rolePrefix));
	if (files.length === 0) return null;
	// 按修改时间降序, 取最新
	files.sort((a: string, b: string) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
	return readFileSync(join(dir, files[0]), "utf-8");
}

/**
 * 将 RoleDefinition 转换为 subagent.ts 的 AgentDefinition 格式
 */
function roleToSubagent(role: RoleDefinition, model: string, teamCtx: TeamContext, provider?: string): any {
	const skills = [
		...(teamCtx.sharedSkills ?? []),
		...(role.skills ?? []),
	];

	return {
		name: role.name,
		description: role.description ?? role.name,
		tools: role.tools,           // undefined 时 subagent.ts 用全部工具
		model,
		provider,                   // undefined 时子进程继承 pi 默认 provider
		systemPrompt: role.systemPrompt ?? `You are a ${role.name}.`,
		skills: skills.length > 0 ? skills : undefined,
	};
}
