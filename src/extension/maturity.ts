/**
 * AgentFlux Extension — 项目成熟度采集
 * 文档依据: docs/14-project-evolution
 *
 * V0: file_count + commit_history 两信号 (LOC/耦合度/依赖深度 Phase 2 静态分析补)
 * 阈值: Seed → Growth(50file/20commit) → Established(300file/100commit) → Mature(多PR/持久记忆, Phase 2+)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ProjectProfile, ProjectStage, ProjectRole, Mode } from "../core/types";

function git(cwd: string, args: string): string {
	try {
		return execFileSync("git", args.split(/\s+/).filter(Boolean), { cwd, encoding: "utf-8", timeout: 5000 }).trim();
	} catch { return ""; }
}

export interface MaturityResult {
	fileCount: number;
	commitCount: number;
	branch: string | null;
	stage: ProjectStage;
	role: ProjectRole;
}

export function collectMaturity(cwd: string): MaturityResult {
	const fileCount = git(cwd, "ls-files").split("\n").filter(Boolean).length;
	const commitCount = Number(git(cwd, "rev-list --count HEAD")) || 0;
	const branch = git(cwd, "rev-parse --abbrev-ref HEAD") || null;

	// docs/14 阈值
	let stage: ProjectStage = "Seed";
	let role: ProjectRole = "doer";
	if (fileCount > 50 || commitCount > 20) { stage = "Growth"; role = "doer+reviewer"; }
	if (commitCount > 100 || fileCount > 300) { stage = "Established"; role = "planner+orchestrator+reviewer"; }
	// Mature 需多 PR/持久记忆信号, V0/Phase1 不判定

	return { fileCount, commitCount, branch, stage, role };
}

export function stageToBaselineMode(stage: ProjectStage): Mode {
	// 与 core/routing.maturityBaselineMode 一致, 此处供 profile 持久化用
	return stage === "Seed" ? "M1" : stage === "Mature" ? "M4" : "M2";
}

export function loadOrCreateProfile(cwd: string, m: MaturityResult): ProjectProfile {
	const dir = join(cwd, ".agentflux");
	try { mkdirSync(dir, { recursive: true }); } catch { /* */ }
	const p = join(dir, "project-profile.json");
	let existing: ProjectProfile | null = null;
	if (existsSync(p)) {
		try { existing = JSON.parse(readFileSync(p, "utf-8")); } catch { existing = null; }
	}
	const updated: ProjectProfile = {
		version: 1,
		project: { root: cwd, name: cwd.split(/[\\/]/).pop() ?? cwd },
		maturity: {
			stage: m.stage,
			stage_since: existing?.maturity?.stage_since ?? new Date().toISOString().slice(0, 10),
			signals: {
				file_count: m.fileCount,
				commit_history: m.commitCount,
				session_history: existing?.maturity?.signals?.session_history ?? 0,
			},
		},
		role: { primary: m.role, delegate_impl: m.stage === "Established" || m.stage === "Mature" },
		baseline_mode: stageToBaselineMode(m.stage),
		history: existing?.history ?? [],
	};
	try { writeFileSync(p, JSON.stringify(updated, null, 2)); } catch { /* */ }
	return updated;
}

/** agent_end 时 session_history +1 */
export function bumpSessionHistory(cwd: string, profile: ProjectProfile): void {
	if (profile?.maturity) {
		profile.maturity.signals.session_history = (profile.maturity.signals.session_history ?? 0) + 1;
		try { writeFileSync(join(cwd, ".agentflux", "project-profile.json"), JSON.stringify(profile, null, 2)); } catch { /* */ }
	}
}
