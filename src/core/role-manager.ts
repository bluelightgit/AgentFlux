/**
 * Agent 角色定义层 — 加载、解析、实例化
 * 文档依据: docs/18-agent-roles.md
 *
 * 角色定义来源 (优先级递减):
 *   1. .agentflux/agents/*.md  (MD 格式, 兼容 pi subagent 示例)
 *   2. .agentflux/models.json roles 字段 (JSON 格式, 完整版)
 *   3. 内置基础模板 (planner/implementer/reviewer/tester)
 *
 * MD 格式 frontmatter: name, description, tools, model, requirement, skills
 * MD body 作为 systemPrompt
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { assignModel, type AssignResult } from "./model-capability";

// ──────────────────────────────── 类型 ────────────────────────────────

export interface RoleDefinition {
	name: string;
	description?: string;
	model?: string;              // 直接指定模型
	requirement?: Record<string, number>;  // 能力需求向量
	tools?: string[];            // 可用工具列表
	skills?: string[];           // 角色特有 skills
	systemPrompt?: string;       // 角色 system prompt
	source: "md" | "json" | "builtin";  // 来源
}

export interface RoleInstance {
	name: string;                // 唯一实例名
	role: string;                // 角色模板名
	model: string;               // 运行时解析出的模型
	assignSource: AssignResult;  // 模型分配详情
	session: string;             // pi session ID
	status: "idle" | "running" | "blocked" | "done" | "failed";
	task: string;
	createdAt: string;
	output?: string;             // 产出物路径 (handoff 等)
}

export interface Registry {
	instances: RoleInstance[];
}

// ──────────────────────────────── 内置模板 ────────────────────────────────

const BUILTIN_ROLES: Record<string, RoleDefinition> = {
	planner: {
		name: "planner",
		description: "分析需求, 拆解任务, 输出实现计划",
		requirement: { coding: 0.3, reasoning: 0.9, speed: 0.2, context: 0.7, cost_eff: 0.3 },
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: "You are a senior planner. Analyze the requirement, break it down into implementation steps, identify risks and dependencies. Output a structured plan with clear task boundaries. Do not write implementation code.",
		source: "builtin",
	},
	implementer: {
		name: "implementer",
		description: "写代码, 跑测试",
		requirement: { coding: 0.8, reasoning: 0.5, speed: 0.6, cost_eff: 0.7 },
		tools: ["read", "write", "edit", "bash", "grep", "find"],
		systemPrompt: "You are a senior developer. Implement the task according to the plan. Write clean, maintainable code. Run tests to verify. If you encounter issues, document them.",
		source: "builtin",
	},
	reviewer: {
		name: "reviewer",
		description: "审查代码质量/安全/可维护性",
		requirement: { coding: 0.7, reasoning: 0.8, cost_eff: 0.4 },
		tools: ["read", "grep", "bash"],
		systemPrompt: "You are a code reviewer. Review the diff for: correctness, security, performance, maintainability. Output: ## Issues (must fix) / ## Suggestions (should consider) / ## Looks Good. Do not modify code directly.",
		source: "builtin",
	},
	tester: {
		name: "tester",
		description: "写测试用例, 验证正确性",
		requirement: { coding: 0.7, reasoning: 0.5, speed: 0.5, cost_eff: 0.6 },
		tools: ["read", "write", "edit", "bash"],
		systemPrompt: "You are a test engineer. Write comprehensive tests for the implementation. Cover happy path, edge cases, and error handling. Run tests and report results.",
		source: "builtin",
	},
};

// ──────────────────────────────── MD 解析 ────────────────────────────────

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!fmMatch) return { frontmatter: {}, body: content };

	const fmText = fmMatch[1];
	const body = fmMatch[2].trim();
	const frontmatter: Record<string, string> = {};

	for (const line of fmText.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		frontmatter[key] = value;
	}
	return { frontmatter, body };
}

function parseList(value: string): string[] {
	return value.split(",").map(s => s.trim()).filter(Boolean);
}

function tryParseJSON(value: string): Record<string, number> | undefined {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

/**
 * 从 .agentflux/agents/*.md 加载角色定义
 */
function loadRolesFromMD(agentsDir: string): Map<string, RoleDefinition> {
	const roles = new Map<string, RoleDefinition>();
	if (!existsSync(agentsDir)) return roles;

	for (const file of readdirSync(agentsDir)) {
		if (!file.endsWith(".md")) continue;
		const path = join(agentsDir, file);
		const content = readFileSync(path, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);
		const name = frontmatter.name || basename(file, ".md");
		const requirementRaw = frontmatter.requirement;
		const requirement = requirementRaw ? tryParseJSON(requirementRaw) : undefined;

		roles.set(name, {
			name,
			description: frontmatter.description,
			model: frontmatter.model,
			requirement,
			tools: frontmatter.tools ? parseList(frontmatter.tools) : undefined,
			skills: frontmatter.skills ? parseList(frontmatter.skills) : undefined,
			systemPrompt: body || undefined,
			source: "md",
		});
	}
	return roles;
}

/**
 * 从 models.json roles 字段加载角色定义
 */
function loadRolesFromJSON(modelsConfig: any): Map<string, RoleDefinition> {
	const roles = new Map<string, RoleDefinition>();
	const rolesObj = modelsConfig?.roles;
	if (!rolesObj || typeof rolesObj !== "object") return roles;

	for (const [name, def] of Object.entries(rolesObj)) {
		const d = def as any;
		roles.set(name, {
			name,
			description: d.description,
			model: d.model,
			requirement: d.requirement,
			tools: d.tools,
			skills: d.skills,
			systemPrompt: d.systemPrompt,
			source: "json",
		});
	}
	return roles;
}

// ──────────────────────────────── 统一加载 ────────────────────────────────

/**
 * 加载所有角色定义 (MD > JSON > 内置)
 * 优先级: MD 文件覆盖 JSON roles, JSON roles 覆盖内置
 */
export function loadAllRoles(cwd: string, modelsConfig: any): Map<string, RoleDefinition> {
	const roles = new Map<string, RoleDefinition>();

	// 1. 内置模板 (最低优先级)
	for (const [name, def] of Object.entries(BUILTIN_ROLES)) {
		roles.set(name, def);
	}

	// 2. models.json roles (覆盖内置)
	const jsonRoles = loadRolesFromJSON(modelsConfig);
	for (const [name, def] of jsonRoles) {
		roles.set(name, def);
	}

	// 3. .agentflux/agents/*.md (最高优先级)
	const mdRoles = loadRolesFromMD(join(cwd, ".agentflux", "agents"));
	for (const [name, def] of mdRoles) {
		roles.set(name, def);
	}

	return roles;
}

// ──────────────────────────────── 实例注册表 ────────────────────────────────

export function loadRegistry(fluxDir: string): Registry {
	const path = join(fluxDir, "runtime", "registry.json");
	if (!existsSync(path)) return { instances: [] };
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return { instances: [] };
	}
}

export function saveRegistry(fluxDir: string, registry: Registry): void {
	const path = join(fluxDir, "runtime", "registry.json");
	// 确保目录存在
	const dir = join(fluxDir, "runtime");
	if (!existsSync(dir)) {
		require("node:fs").mkdirSync(dir, { recursive: true });
	}
	require("node:fs").writeFileSync(path, JSON.stringify(registry, null, 2));
}

let instanceCounter: Record<string, number> = {};

/**
 * 生成唯一实例名
 * 用户指定 name 时用它, 否则自动生成 role-N
 */
export function generateInstanceName(roleName: string, customName?: string): string {
	if (customName) return customName;
	instanceCounter[roleName] = (instanceCounter[roleName] ?? 0) + 1;
	return `${roleName}-${instanceCounter[roleName]}`;
}

/**
 * 创建角色实例
 */
export function createInstance(
	roleName: string,
	role: RoleDefinition,
	models: Record<string, any>,
	task: string,
	sessionId: string,
	customName?: string,
): RoleInstance {
	const assign = assignModel(roleName, role, models);
	const name = generateInstanceName(roleName, customName);

	return {
		name,
		role: roleName,
		model: assign.model,
		assignSource: assign,
		session: sessionId,
		status: "idle",
		task,
		createdAt: new Date().toISOString(),
	};
}

// ──────────────────────────────── 格式化 ────────────────────────────────

export function formatRoleList(roles: Map<string, RoleDefinition>): string {
	const lines = ["Agent Roles:", ""];
	for (const [name, def] of roles) {
		const source = def.source === "builtin" ? "(内置)" : def.source === "json" ? "(json)" : "(md)";
		const modelInfo = def.model ? `model=${def.model}` : def.requirement ? `req={${Object.entries(def.requirement).map(([k, v]) => `${k}:${v}`).join(",")}}` : "???";
		const toolsInfo = def.tools ? `tools=[${def.tools.join(",")}]` : "tools=all";
		lines.push(`  ${name.padEnd(16)} ${source}  ${modelInfo}  ${toolsInfo}`);
		if (def.description) lines.push(`  ${"".padEnd(16)} ${def.description}`);
	}
	return lines.join("\n");
}

export function formatInstanceList(registry: Registry): string {
	if (registry.instances.length === 0) return "No active instances.";
	const lines = ["Agent Instances:", ""];
	for (const inst of registry.instances) {
		const statusIcon = {
			idle: "○", running: "●", blocked: "⚠", done: "✓", failed: "✗",
		}[inst.status] ?? "?";
		lines.push(`  ${statusIcon} ${inst.name.padEnd(20)} ${inst.role.padEnd(12)} ${inst.model.padEnd(20)} ${inst.status}`);
		if (inst.task) lines.push(`    task: ${inst.task.slice(0, 80)}`);
	}
	return lines.join("\n");
}
