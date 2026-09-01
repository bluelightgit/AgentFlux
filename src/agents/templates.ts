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
import { communicationPolicyFromFrontmatter, type CommunicationPolicyInput } from "../core/communication-policy";
import type { WorkspaceCapabilityInput } from "../core/capability-policy";
import type { ThinkingLevel } from "../core/types";

// ──────────────────────────────── 类型 ────────────────────────────────

export interface RoleDefinition {
	name: string;
	description?: string;
	model?: string;              // 直接指定模型
	provider?: string;           // 与模型绑定的 pi provider，可不在 AgentFlux 模型表中
	requirement?: Record<string, number>;  // 能力需求向量
	tools?: string[];            // 可用工具列表
	skills?: string[];           // 角色特有 skills
	mcpServers?: string[];       // 当前 pi runtime 无 server 级 gate；非空会 fail-closed
	workspace?: WorkspaceCapabilityInput;
	systemPrompt?: string;       // 角色 system prompt
	source: "md" | "json" | "builtin";  // 来源
	thinking?: ThinkingLevel;
	/** Role-template defaults. A registered/run instance may apply a narrower override. */
	communication?: CommunicationPolicyInput;
}

// ──────────────────────────────── 内置模板 ────────────────────────────────

const BUILTIN_ROLES: Record<string, RoleDefinition> = {
	assistant: {
		name: "assistant",
		description: "通用默认子代理（无角色模板时使用）",
		tools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
		systemPrompt: "你是一个通用助理子代理。忠实执行给定的任务，按需查看工作区，并汇报具体结果。",
		source: "builtin",
		thinking: "off",
	},
	planner: {
		name: "planner",
		description: "分析需求, 拆解任务, 输出实现计划",
		requirement: { coding: 0.3, reasoning: 0.9, speed: 0.2, context: 0.7, cost_eff: 0.3 },
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: "你是一名资深规划者。分析需求，拆解为实现步骤，识别风险与依赖。输出任务边界清晰的结构化计划。不要编写实现代码。",
		source: "builtin",
		thinking: "high",
	},
	implementer: {
		name: "implementer",
		description: "写代码, 跑测试",
		requirement: { coding: 0.8, reasoning: 0.5, speed: 0.6, cost_eff: 0.7 },
		tools: ["read", "write", "edit", "bash", "grep", "find"],
		systemPrompt: "你是一名资深开发者。按计划实现任务，编写干净、可维护的代码，运行测试验证。遇到问题时记录说明。",
		source: "builtin",
		thinking: "medium",
	},
	reviewer: {
		name: "reviewer",
		description: "审查代码质量/安全/可维护性",
		requirement: { coding: 0.7, reasoning: 0.8, cost_eff: 0.4 },
		tools: ["read", "grep", "bash"],
		systemPrompt: "你是一名代码评审者。从正确性、安全性、性能、可维护性角度评审改动。输出：## 必须修复的问题 / ## 建议 / ## 整体评价。不要直接修改代码。",
		source: "builtin",
		thinking: "high",
	},
	tester: {
		name: "tester",
		description: "写测试用例, 验证正确性",
		requirement: { coding: 0.7, reasoning: 0.5, speed: 0.5, cost_eff: 0.6 },
		tools: ["read", "write", "edit", "bash"],
		systemPrompt: "你是一名测试工程师。为实现编写全面的测试，覆盖正常路径、边界与错误处理，运行测试并汇报结果。",
		source: "builtin",
	},
};

// ──────────────────────────────── MD 解析 ────────────────────────────────

export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
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

		const thinkingRaw = frontmatter.thinking;
		const thinking = thinkingRaw && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingRaw)
			? thinkingRaw as RoleDefinition["thinking"] : undefined;

		roles.set(name, {
			name,
			description: frontmatter.description,
			model: frontmatter.model,
			provider: frontmatter.provider,
			requirement,
			tools: frontmatter.tools ? parseList(frontmatter.tools) : undefined,
			skills: frontmatter.skills ? parseList(frontmatter.skills) : undefined,
			systemPrompt: body || undefined,
			source: "md",
			thinking,
			communication: communicationPolicyFromFrontmatter(frontmatter),
			mcpServers: frontmatter.mcp_servers ? parseList(frontmatter.mcp_servers) : undefined,
			workspace: frontmatter.workspace_roots || frontmatter.denied_paths || frontmatter.block_dangerous_commands
				? {
					roots: frontmatter.workspace_roots ? parseList(frontmatter.workspace_roots) : undefined,
					deniedPaths: frontmatter.denied_paths ? parseList(frontmatter.denied_paths) : undefined,
					blockDangerousCommands: frontmatter.block_dangerous_commands === undefined
						? undefined : !["false", "no", "0", "off"].includes(frontmatter.block_dangerous_commands.toLowerCase()),
				} : undefined,
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
		const thinkingRaw = d.thinking;
		const thinking = thinkingRaw && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingRaw)
			? thinkingRaw as RoleDefinition["thinking"] : undefined;
		roles.set(name, {
			name,
			description: d.description,
			model: d.model,
			provider: d.provider,
			requirement: d.requirement,
			tools: d.tools,
			skills: d.skills,
			systemPrompt: d.systemPrompt,
			source: "json",
			thinking,
			communication: d.communication && typeof d.communication === "object" ? d.communication : undefined,
			mcpServers: Array.isArray(d.mcpServers) ? d.mcpServers : undefined,
			workspace: d.workspace && typeof d.workspace === "object" ? d.workspace : undefined,
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

// ──────────────────────────────── 格式化 ────────────────────────────────

export function formatRoleList(roles: Map<string, RoleDefinition>): string {
	const lines = ["Agent Roles:", ""];
	for (const [name, def] of roles) {
		const source = def.source === "builtin" ? "(内置)" : def.source === "json" ? "(json)" : "(md)";
		const modelInfo = def.model ? `model=${def.model}` : def.requirement ? `req={${Object.entries(def.requirement).map(([k, v]) => `${k}:${v}`).join(",")}}` : "???";
		const toolsInfo = def.tools ? `tools=[${def.tools.join(",")}]` : "tools=all";
		const thinkInfo = def.thinking ? `thinking=${def.thinking}` : "";
		const communicationInfo = def.communication
			? `message=${def.communication.enabled === false ? "off" : "on"}${def.communication.requiredSendTo?.length ? ` required→${def.communication.requiredSendTo.join("|")}` : ""}` : "";
		lines.push(`  ${name.padEnd(16)} ${source}  ${modelInfo}  ${toolsInfo}${thinkInfo ? "  " + thinkInfo : ""}${communicationInfo ? "  " + communicationInfo : ""}`);
		if (def.description) lines.push(`  ${"".padEnd(16)} ${def.description}`);
	}
	return lines.join("\n");
}
