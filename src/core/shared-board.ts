/**
 * 共享黑板 — 多 agent 协作的共享状态层
 * 文档依据: docs/19-multi-agent-architecture.md
 *
 * 目录结构:
 *   .agentflux/shared/
 *     blackboard.json   — 全局状态
 *     tasks/            — 任务队列
 *     handoffs/         — 交接文档
 *     decisions/        — 决策记录
 *
 * 设计: 文件-based, 不做 IPC, 可审计, git 友好
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────── 类型 ────────────────────────────────

export interface AgentStatus {
	status: "idle" | "running" | "blocked" | "done" | "failed";
	workingOn?: string;          // task ID
	waitingFor?: string;         // 实例名
	output?: string;             // 产出物路径
}

export interface Blackboard {
	project: string;
	currentMode: string;
	sharedContext: {
		goal?: string;
		constraints?: string[];
		decidedArchitecture?: string;
	};
	agentStatuses: Record<string, AgentStatus>;
	updatedAt: string;
}

export interface Task {
	id: string;
	title: string;
	assignedTo?: string;         // 实例名
	status: "pending" | "in_progress" | "done" | "blocked";
	dependsOn: string[];         // task IDs
	createdAt: string;
	inputHandoff?: string;       // handoff 文件路径
	acceptanceCriteria: string[];
}

export interface Decision {
	id: string;
	by: string;                  // 实例名
	type: string;                // "review_verdict" | "architecture" | ...
	verdict?: string;
	issues?: string[];
	suggestions?: string[];
	timestamp: string;
}

// ──────────────────────────────── 黑板 ────────────────────────────────

export class SharedBoard {
	private readonly sharedDir: string;

	constructor(fluxDir: string) {
		this.sharedDir = join(fluxDir, "shared");
		this.ensureDirs();
	}

	private ensureDirs(): void {
		for (const sub of ["", "tasks", "handoffs", "decisions"]) {
			const dir = join(this.sharedDir, sub);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}
	}

	// ── Blackboard ──

	getBlackboard(): Blackboard {
		const path = join(this.sharedDir, "blackboard.json");
		if (!existsSync(path)) {
			return {
				project: "",
				currentMode: "",
				sharedContext: {},
				agentStatuses: {},
				updatedAt: new Date().toISOString(),
			};
		}
		return JSON.parse(readFileSync(path, "utf-8"));
	}

	saveBlackboard(bb: Blackboard): void {
		bb.updatedAt = new Date().toISOString();
		writeFileSync(join(this.sharedDir, "blackboard.json"), JSON.stringify(bb, null, 2));
	}

	updateAgentStatus(name: string, status: AgentStatus): void {
		const bb = this.getBlackboard();
		bb.agentStatuses[name] = status;
		this.saveBlackboard(bb);
	}

	setSharedContext(ctx: Partial<Blackboard["sharedContext"]>): void {
		const bb = this.getBlackboard();
		bb.sharedContext = { ...bb.sharedContext, ...ctx };
		this.saveBlackboard(bb);
	}

	// ── Tasks ──

	createTask(task: Omit<Task, "id" | "createdAt">): Task {
		const existing = this.listTasks();
		const num = existing.length + 1;
		const id = `task-${String(num).padStart(3, "0")}`;
		const full: Task = { ...task, id, createdAt: new Date().toISOString() };
		writeFileSync(join(this.sharedDir, "tasks", `${id}.json`), JSON.stringify(full, null, 2));
		return full;
	}

	getTask(id: string): Task | null {
		const path = join(this.sharedDir, "tasks", `${id}.json`);
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8"));
	}

	listTasks(): Task[] {
		const dir = join(this.sharedDir, "tasks");
		if (!existsSync(dir)) return [];
		const { readdirSync } = require("node:fs");
		return readdirSync(dir)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => JSON.parse(readFileSync(join(dir, f), "utf-8")))
			.sort((a: Task, b: Task) => a.createdAt.localeCompare(b.createdAt));
	}

	updateTask(id: string, updates: Partial<Task>): void {
		const task = this.getTask(id);
		if (!task) return;
		writeFileSync(join(this.sharedDir, "tasks", `${id}.json`), JSON.stringify({ ...task, ...updates }, null, 2));
	}

	// ── Handoffs ──

	writeHandoff(from: string, to: string, content: string): string {
		const filename = `${from}→${to}.md`;
		writeFileSync(join(this.sharedDir, "handoffs", filename), content);
		return `handoffs/${filename}`;
	}

	readHandoff(from: string, to: string): string | null {
		const path = join(this.sharedDir, "handoffs", `${from}→${to}.md`);
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf-8");
	}

	listHandoffs(): string[] {
		const dir = join(this.sharedDir, "handoffs");
		if (!existsSync(dir)) return [];
		const { readdirSync } = require("node:fs");
		return readdirSync(dir).filter((f: string) => f.endsWith(".md"));
	}

	// ── Decisions ──

	writeDecision(decision: Omit<Decision, "id" | "timestamp">): Decision {
		const existing = this.listDecisions();
		const num = existing.length + 1;
		const id = `decision-${String(num).padStart(3, "0")}`;
		const full: Decision = { ...decision, id, timestamp: new Date().toISOString() };
		writeFileSync(join(this.sharedDir, "decisions", `${id}.json`), JSON.stringify(full, null, 2));
		return full;
	}

	listDecisions(): Decision[] {
		const dir = join(this.sharedDir, "decisions");
		if (!existsSync(dir)) return [];
		const { readdirSync } = require("node:fs");
		return readdirSync(dir)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => JSON.parse(readFileSync(join(dir, f), "utf-8")))
			.sort((a: Decision, b: Decision) => a.timestamp.localeCompare(b.timestamp));
	}

	// ── 路径 ──

	get path(): string {
		return this.sharedDir;
	}
}

// ──────────────────────────────── Handoff 生成 ────────────────────────────────

export function generateHandoffContent(
	from: string,
	to: string,
	task: string,
	details: {
		context?: string;
		plan?: string[];
		filesToRead?: string[];
		acceptanceCriteria?: string[];
		output?: string;
	},
): string {
	const lines = [`# Handoff: ${from} → ${to}`, "", "## Task", task, ""];

	if (details.context) {
		lines.push("## Context", details.context, "");
	}
	if (details.plan && details.plan.length > 0) {
		lines.push("## Plan");
		for (const step of details.plan) lines.push(`- ${step}`);
		lines.push("");
	}
	if (details.filesToRead && details.filesToRead.length > 0) {
		lines.push("## Files to Read");
		for (const f of details.filesToRead) lines.push(`- ${f}`);
		lines.push("");
	}
	if (details.acceptanceCriteria && details.acceptanceCriteria.length > 0) {
		lines.push("## Acceptance Criteria");
		for (const c of details.acceptanceCriteria) lines.push(`- ${c}`);
		lines.push("");
	}
	if (details.output) {
		lines.push("## Output", details.output, "");
	}

	return lines.join("\n");
}

// ──────────────────────────────── 格式化 ────────────────────────────────

export function formatBlackboard(bb: Blackboard): string {
	const lines = ["Blackboard:", ""];
	lines.push(`  project: ${bb.project || "(unset)"}`);
	lines.push(`  mode: ${bb.currentMode || "(unset)"}`);
	if (bb.sharedContext.goal) lines.push(`  goal: ${bb.sharedContext.goal}`);
	if (bb.sharedContext.constraints?.length) {
		lines.push(`  constraints: ${bb.sharedContext.constraints.join(", ")}`);
	}
	lines.push("");
	lines.push("  Agents:");
	for (const [name, status] of Object.entries(bb.agentStatuses)) {
		const icon = { idle: "○", running: "●", blocked: "⚠", done: "✓", failed: "✗" }[status.status] ?? "?";
		lines.push(`    ${icon} ${name}: ${status.status}${status.workingOn ? ` (${status.workingOn})` : ""}`);
	}
	return lines.join("\n");
}

export function formatTaskList(tasks: Task[]): string {
	if (tasks.length === 0) return "No tasks.";
	const lines = ["Tasks:", ""];
	for (const t of tasks) {
		const icon = { pending: "○", in_progress: "●", done: "✓", blocked: "⚠" }[t.status] ?? "?";
		lines.push(`  ${icon} ${t.id}: ${t.title}`);
		if (t.assignedTo) lines.push(`    assigned: ${t.assignedTo}`);
		if (t.dependsOn.length > 0) lines.push(`    depends: ${t.dependsOn.join(", ")}`);
	}
	return lines.join("\n");
}
