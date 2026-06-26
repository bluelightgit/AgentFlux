/**
 * Team 管理 — /flux team 命令实现
 * 文档依据: docs/18-agent-roles.md, docs/19-multi-agent-architecture.md
 *
 * 命令:
 *   /flux team status        — 显示所有实例状态 + 黑板
 *   /flux team plan <task>   — 创建 planner 实例分析任务
 *   /flux team build <task>  — 创建 implementer 实例执行任务
 *   /flux team review        — 创建 reviewer 实例审查当前变更
 *   /flux team abort <name>  — 终止指定实例
 *   /flux team roles         — 列出所有角色定义
 *   /flux team models        — 列出所有模型 + 能力 + 分配
 *   /flux team affinity      — 显示每个角色的亲和度排名
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

	// 默认: 显示帮助
	const help = [
		"AgentFlux Team Commands:",
		"  /flux team status         — 显示所有实例状态 + 黑板",
		"  /flux team plan <task>    — 创建 planner 实例分析任务",
		"  /flux team build <task>   — 创建 implementer 实例执行任务",
		"  /flux team review         — 创建 reviewer 实例审查当前变更",
		"  /flux team abort <name>   — 终止指定实例",
		"  /flux team roles          — 列出所有角色定义",
		"  /flux team models         — 列出所有模型 + 能力 + 分配",
		"  /flux team affinity       — 显示每个角色的亲和度排名",
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
	if (lines.length <= 2) lines.push("  (models.json 中无模型定义)");
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
		const msg = "用法: /flux team plan <任务描述>";
		if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
		return;
	}
	await runTeamAgent("planner", task, ctx, teamCtx);
}

async function cmdTeamBuild(task: string, ctx: any, teamCtx: TeamContext): Promise<void> {
	if (!task) {
		const msg = "用法: /flux team build <任务描述>";
		if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
		return;
	}
	await runTeamAgent("implementer", task, ctx, teamCtx);
}

async function cmdTeamReview(ctx: any, teamCtx: TeamContext): Promise<void> {
	// 获取当前 git diff 作为审查对象
	const { execSync } = require("node:child_process");
	let diff = "";
	try {
		diff = execSync("git diff HEAD", { cwd: teamCtx.cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 }).trim();
	} catch {}
	if (!diff) {
		// 尝试 unstaged
		try {
			diff = execSync("git diff", { cwd: teamCtx.cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 }).trim();
		} catch {}
	}
	const task = diff
		? `Review the following git diff:\n\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\`\n\nProvide structured review.`
		: "Review the current codebase for issues. No uncommitted changes found, review recent commits.";
	await runTeamAgent("reviewer", task, ctx, teamCtx);
}

async function cmdTeamAbort(name: string, ctx: any, teamCtx: TeamContext): Promise<void> {
	if (!name) {
		const msg = "用法: /flux team abort <实例名>";
		if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
		return;
	}
	const registry = loadRegistry(teamCtx.fluxDir);
	const inst = registry.instances.find(i => i.name === name);
	if (!inst) {
		const msg = `实例 ${name} 不存在`;
		if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
		return;
	}
	inst.status = "failed";
	saveRegistry(teamCtx.fluxDir, registry);
	const board = new SharedBoard(teamCtx.fluxDir);
	board.updateAgentStatus(name, { status: "failed" });
	const msg = `实例 ${name} 已终止`;
	if (ctx.hasUI) ctx.ui.notify(msg, "info"); else console.log(msg);
}

// ──────────────────────────────── 核心: 运行 team agent ────────────────────────────────

async function runTeamAgent(
	roleName: string,
	task: string,
	ctx: any,
	teamCtx: TeamContext,
): Promise<void> {
	const roles = loadAllRoles(teamCtx.cwd, teamCtx.modelsConfig);
	const role = roles.get(roleName);
	if (!role) {
		const msg = `角色 ${roleName} 不存在。可用角色: ${[...roles.keys()].join(", ")}`;
		if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
		return;
	}

	const models = teamCtx.modelsConfig?.models ?? {};
	if (Object.keys(models).length === 0) {
		const msg = "models.json 中无模型定义, 无法启动 team agent";
		if (ctx.hasUI) ctx.ui.notify(msg, "error"); else console.error(msg);
		return;
	}

	// 创建实例
	const sessionId = `flux-team-${roleName}-${Date.now()}`;
	const instance = createInstance(roleName, role, models, task, sessionId);
	const registry = loadRegistry(teamCtx.fluxDir);
	registry.instances.push(instance);
	saveRegistry(teamCtx.fluxDir, registry);

	// 更新黑板
	const board = new SharedBoard(teamCtx.fluxDir);
	board.updateAgentStatus(instance.name, { status: "running", workingOn: task.slice(0, 100) });

	const modelInfo = `${instance.model} (${instance.assignSource.source})`;
	const startMsg = `启动 ${instance.name} [${roleName}] → ${modelInfo}\n任务: ${task.slice(0, 200)}`;
	if (ctx.hasUI) ctx.ui.notify(startMsg, "info");
	console.error(`[flux team] ${startMsg}`);

	// 加载 agent 定义 (转换为 subagent.ts 可用的格式)
	const agent = roleToSubagent(role, instance.model, teamCtx);

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

		// 更新实例状态
		const reg = loadRegistry(teamCtx.fluxDir);
		const inst = reg.instances.find(i => i.name === instance.name);
		if (inst) {
			inst.status = "done";
			inst.output = result.output?.slice(0, 500);
			saveRegistry(teamCtx.fluxDir, reg);
		}

		// 更新黑板
		board.updateAgentStatus(instance.name, { status: "done", output: "完成" });

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
		// 更新实例状态为失败
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

/**
 * 将 RoleDefinition 转换为 subagent.ts 的 AgentDefinition 格式
 */
function roleToSubagent(role: RoleDefinition, model: string, teamCtx: TeamContext): any {
	const skills = [
		...(teamCtx.sharedSkills ?? []),
		...(role.skills ?? []),
	];

	return {
		name: role.name,
		description: role.description ?? role.name,
		tools: role.tools,           // undefined 时 subagent.ts 用全部工具
		model,
		systemPrompt: role.systemPrompt ?? `You are a ${role.name}.`,
		skills: skills.length > 0 ? skills : undefined,
	};
}
