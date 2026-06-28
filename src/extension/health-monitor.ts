/**
 * AgentFlux 自维护模块 — 健康检查 + 状态查询 + 升级检测 + 错误扫描
 * Docs: docs/24-self-maintenance.md
 */

import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, appendFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

// ─── 类型 ───

export interface HealthCheck {
	name: string;
	status: "ok" | "warn" | "error";
	detail: string;
}

export interface HealthReport {
	checks: HealthCheck[];
	okCount: number;
	warnCount: number;
	errorCount: number;
	timestamp: number;
}

export interface SubsystemStatus {
	name: string;
	healthy: boolean;
	detail: string;
	path?: string;
}

export interface AgentInfo {
	name: string;
	role: string;
	status: string;
	model?: string;
	callCount?: number;
	totalCost?: number;
}

export interface Issue {
	severity: "warn" | "error";
	category: string;
	message: string;
	count: number;
}

export interface GitCommit {
	hash: string;
	message: string;
}

export interface UpgradeInfo {
	currentCommit: string;
	currentMessage: string;
	currentBranch: string;
	remoteCommits: GitCommit[];
	upToDate: boolean;
	hasRemote: boolean;
	recommendation: string;
}

export interface VersionInfo {
	version: string;
	commit: string;
	clean: boolean;
	branch: string;
	fileCount: number;
	totalLines: number;
}

// ─── 版本信息 ───

export function getVersionInfo(cwd: string): VersionInfo {
	let version = "unknown";
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
		version = pkg.version ?? "unknown";
	} catch {}

	let commit = "unknown";
	let clean = false;
	let branch = "unknown";
	try {
		commit = execSync("git rev-parse --short HEAD", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
		clean = execSync("git status --porcelain", { cwd, encoding: "utf-8", timeout: 5000 }).trim() === "";
		branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
	} catch {}

	let fileCount = 0;
	let totalLines = 0;
	try {
		const files = execSync('find src/ -name "*.ts"', { cwd, encoding: "utf-8", timeout: 5000 }).trim().split("\n").filter(Boolean);
		fileCount = files.length;
		for (const f of files) {
			try {
				const content = readFileSync(join(cwd, f), "utf-8");
				totalLines += content.split("\n").length;
			} catch {}
		}
	} catch {}

	return { version, commit, clean, branch, fileCount, totalLines };
}

// ─── 健康检查 ───

export function checkHealth(cwd: string, fluxDir: string): HealthReport {
	const checks: HealthCheck[] = [];
	const ts = Date.now();

	// 1. Config
	try {
		const configPath = join(fluxDir, "agentflux.json");
		if (existsSync(configPath)) {
			JSON.parse(readFileSync(configPath, "utf-8"));
			checks.push({ name: "Config", status: "ok", detail: "agentflux.json parsed" });
		} else {
			checks.push({ name: "Config", status: "ok", detail: "using defaults (no agentflux.json)" });
		}
	} catch (e: any) {
		checks.push({ name: "Config", status: "error", detail: `parse error: ${e?.message}` });
	}

	// 2. models.json
	try {
		const modelsPath = join(fluxDir, "models.json");
		if (existsSync(modelsPath)) {
			const mc = JSON.parse(readFileSync(modelsPath, "utf-8"));
			const modelCount = Object.keys(mc.models ?? {}).length;
			checks.push({ name: "models.json", status: "ok", detail: `${modelCount} models, ${Object.keys(mc.roles ?? {}).length} roles` });
		} else {
			checks.push({ name: "models.json", status: "warn", detail: "file not found (builtins only)" });
		}
	} catch (e: any) {
		checks.push({ name: "models.json", status: "error", detail: `parse error: ${e?.message}` });
	}

	// 3. Pricing cache
	try {
		const pricingCachePath = join(fluxDir, "pricing-cache.json");
		if (existsSync(pricingCachePath)) {
			const pc = JSON.parse(readFileSync(pricingCachePath, "utf-8"));
			const entryCount = pc.entries?.length ?? Object.keys(pc).length;
			const ageMs = Date.now() - (pc.fetchedAt ?? 0);
			const ageH = Math.floor(ageMs / 3600000);
			if (ageH > 24) {
				checks.push({ name: "Pricing", status: "warn", detail: `cache ${ageH}h old (refresh recommended), ${entryCount} entries` });
			} else {
				checks.push({ name: "Pricing", status: "ok", detail: `${entryCount} entries, cache ${ageH}h old` });
			}
		} else {
			checks.push({ name: "Pricing", status: "warn", detail: "no pricing cache (will fetch on next session_start)" });
		}
	} catch (e: any) {
		checks.push({ name: "Pricing", status: "error", detail: `cache parse error: ${e?.message}` });
	}

	// 4. Telemetry
	try {
		const eventsPath = join(fluxDir, "events.jsonl");
		if (existsSync(eventsPath)) {
			// Try append to verify writability
			appendFileSync(eventsPath, "");
			const stat = statSync(eventsPath);
			const sizeKB = Math.round(stat.size / 1024);
			checks.push({ name: "Telemetry", status: "ok", detail: `events.jsonl writable, ${sizeKB}KB` });
		} else {
			checks.push({ name: "Telemetry", status: "ok", detail: "events.jsonl will be created on first event" });
		}
	} catch (e: any) {
		checks.push({ name: "Telemetry", status: "error", detail: `not writable: ${e?.message}` });
	}

	// 5. SharedBoard dirs
	try {
		const requiredDirs = ["", "tasks", "handoffs", "decisions", "messages"];
		const missing = requiredDirs.filter(d => !existsSync(join(fluxDir, d)));
		if (missing.length === 0) {
			checks.push({ name: "SharedBoard", status: "ok", detail: "all dirs exist" });
		} else {
			checks.push({ name: "SharedBoard", status: "warn", detail: `missing dirs: ${missing.join(", ")} (will be created on demand)` });
		}
	} catch (e: any) {
		checks.push({ name: "SharedBoard", status: "error", detail: `${e?.message}` });
	}

	// 6. Experience store
	try {
		const expPath = join(fluxDir, "runtime", "experience.jsonl");
		if (existsSync(expPath)) {
			const lines = readFileSync(expPath, "utf-8").split("\n").filter(Boolean);
			checks.push({ name: "ExperienceStore", status: "ok", detail: `${lines.length} records` });
		} else {
			checks.push({ name: "ExperienceStore", status: "warn", detail: "no records (cold start, not an error)" });
		}
	} catch (e: any) {
		checks.push({ name: "ExperienceStore", status: "error", detail: `${e?.message}` });
	}

	// 7. Runtime dir
	try {
		const runtimeDir = join(fluxDir, "runtime");
		if (existsSync(runtimeDir)) {
			const files = readdirSync(runtimeDir);
			checks.push({ name: "Runtime", status: "ok", detail: `${files.length} files in runtime/` });
		} else {
			checks.push({ name: "Runtime", status: "warn", detail: "runtime/ not found (will be created on demand)" });
		}
	} catch (e: any) {
		checks.push({ name: "Runtime", status: "error", detail: `${e?.message}` });
	}

	// 8. Git status (source code integrity)
	try {
		const porcelain = execSync("git status --porcelain", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
		if (porcelain === "") {
			checks.push({ name: "Git", status: "ok", detail: "working tree clean" });
		} else {
			const dirty = porcelain.split("\n").filter(Boolean).length;
			checks.push({ name: "Git", status: "warn", detail: `${dirty} uncommitted change(s)` });
		}
	} catch (e: any) {
		checks.push({ name: "Git", status: "warn", detail: "not a git repo or git not available" });
	}

	const okCount = checks.filter(c => c.status === "ok").length;
	const warnCount = checks.filter(c => c.status === "warn").length;
	const errorCount = checks.filter(c => c.status === "error").length;

	return { checks, okCount, warnCount, errorCount, timestamp: ts };
}

// ─── 错误扫描 ───

export function scanRecentIssues(eventsPath: string, windowSize = 20): Issue[] {
	const issues: Issue[] = [];
	if (!existsSync(eventsPath)) return issues;

	try {
		const lines = readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean);
		const recent = lines.slice(-windowSize).map(l => {
			try { return JSON.parse(l); } catch { return null; }
		}).filter(Boolean) as any[];

		// 1. Subagent failures
		const subagentEvents = recent.filter(e => e.type === "subagent.run");
		const failures = subagentEvents.filter(e => (e.exitCode ?? 0) !== 0);
		if (failures.length >= 2) {
			issues.push({
				severity: "error",
				category: "subagent_failure",
				message: `${failures.length}/${subagentEvents.length} subagent runs failed in last ${windowSize} events`,
				count: failures.length,
			});
		}

		// 2. Low cache hit rate
		const cacheEvents = recent.filter(e => e.type === "cache.sample");
		if (cacheEvents.length >= 5) {
			const lowHit = cacheEvents.filter(e => (e.cacheHitRate ?? 1) < 0.2);
			if (lowHit.length >= 3) {
				issues.push({
					severity: "warn",
					category: "low_cache",
					message: `${lowHit.length}/${cacheEvents.length} turns with cache hit < 20%`,
					count: lowHit.length,
				});
			}
		}

		// 3. Routing fallback frequency
		const routingEvents = recent.filter(e => e.type === "routing.decision");
		if (routingEvents.length >= 3) {
			const fallbacks = routingEvents.filter(e => e.fallback === true);
			if (fallbacks.length > routingEvents.length / 2) {
				issues.push({
					severity: "warn",
					category: "routing_fallback",
					message: `${fallbacks.length}/${routingEvents.length} routing decisions used fallback`,
					count: fallbacks.length,
				});
			}
		}

		// 4. Context percent high (approaching compaction)
		const highCtx = cacheEvents.filter(e => (e.contextPercent ?? 0) > 85);
		if (highCtx.length >= 2) {
			issues.push({
				severity: "warn",
				category: "high_context",
				message: `${highCtx.length} turns with context > 85% (compaction likely)`,
				count: highCtx.length,
			});
		}

	} catch {}

	return issues;
}

// ─── 升级检测 ───

export function checkUpgrade(cwd: string): UpgradeInfo {
	let currentCommit = "unknown";
	let currentMessage = "";
	let currentBranch = "main";
	let remoteCommits: GitCommit[] = [];
	let hasRemote = false;

	try {
		currentCommit = execSync("git rev-parse --short HEAD", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
		currentMessage = execSync("git log -1 --format=%s", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
		currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
	} catch {}

	// Check if remote exists
	try {
		const remotes = execSync("git remote", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
		hasRemote = remotes.length > 0;
	} catch {}

	if (hasRemote) {
		try {
			// Fetch (non-fatal)
			execSync("git fetch --quiet", { cwd, encoding: "utf-8", timeout: 15000 });

			// Get commits between HEAD and origin/<branch>
			const range = `HEAD..origin/${currentBranch}`;
			const log = execSync(`git log ${range} --oneline --format=%h|%s`, { cwd, encoding: "utf-8", timeout: 5000 }).trim();

			if (log) {
				remoteCommits = log.split("\n").filter(Boolean).map(line => {
					const [hash, ...msgParts] = line.split("|");
					return { hash: hash.trim(), message: msgParts.join("|").trim() };
				});
			}
		} catch {}
	}

	const upToDate = remoteCommits.length === 0;
	let recommendation: string;
	if (!hasRemote) {
		recommendation = "No remote configured — local-only development";
	} else if (upToDate) {
		recommendation = "Up to date";
	} else {
		recommendation = `Run 'git pull origin ${currentBranch}' then '/flux restart' to apply ${remoteCommits.length} update(s)`;
	}

	return { currentCommit, currentMessage, currentBranch, remoteCommits, upToDate, hasRemote, recommendation };
}

// ─── 格式化 ───

export function formatHealthReport(report: HealthReport): string {
	const lines: string[] = [];
	lines.push("AgentFlux Health Check");
	lines.push("═".repeat(60));

	report.checks.forEach((c, i) => {
		const icon = c.status === "ok" ? "✅" : c.status === "warn" ? "⚠️ " : "❌";
		const num = `[${i + 1}/${report.checks.length}]`;
		lines.push(`${num} ${c.name.padEnd(16)} ${icon} ${c.detail}`);
	});

	lines.push("");
	const resultIcon = report.errorCount > 0 ? "❌" : report.warnCount > 0 ? "⚠️ " : "✅";
	lines.push(`Result: ${resultIcon} ${report.okCount} OK, ${report.warnCount} warning(s), ${report.errorCount} error(s)`);

	if (report.errorCount > 0) {
		lines.push("");
		lines.push("Errors found — consider '/flux restart' to reinitialize");
	}

	return lines.join("\n");
}

export function formatStatusReport(
	version: VersionInfo,
	runtimeState: { mode: string; preset: string; stage: string; role: string; turnIndex: number; cacheHitRate: number; costUsd: number; branch: string | null },
	subsystems: SubsystemStatus[],
	activeAgents: AgentInfo[],
	issues: Issue[],
	paths: { fluxDir: string; eventsPath: string; configPath: string },
): string {
	const lines: string[] = [];
	lines.push("AgentFlux Status");
	lines.push("═".repeat(60));

	const dirtyStr = version.clean ? "clean" : "dirty";
	lines.push(`Version       ${version.version} · git ${version.commit} (${dirtyStr})`);
	lines.push(`Branch        ${version.branch}`);
	lines.push(`Source        ${version.fileCount} files, ${version.totalLines} lines`);
	lines.push(`Mode          ${runtimeState.mode} · preset ${runtimeState.preset} · stage ${runtimeState.stage}/${runtimeState.role}`);
	lines.push(`Session       turn ${runtimeState.turnIndex} · cache hit ${(runtimeState.cacheHitRate * 100).toFixed(0)}% · cost $${runtimeState.costUsd.toFixed(4)}`);

	lines.push("");
	lines.push("Subsystems:");
	for (const s of subsystems) {
		const icon = s.healthy ? "✅" : "⚠️ ";
		const pathStr = s.path ? ` → ${s.path}` : "";
		lines.push(`  ${icon} ${s.name.padEnd(16)} ${s.detail}${pathStr}`);
	}

	if (activeAgents.length > 0) {
		lines.push("");
		lines.push("Active Agents:");
		for (const a of activeAgents) {
			const costStr = a.totalCost !== undefined ? ` · $${a.totalCost.toFixed(4)}` : "";
			lines.push(`  ${a.name.padEnd(20)} ${a.role.padEnd(14)} ${a.status}${costStr}`);
		}
	} else {
		lines.push("");
		lines.push("Active Agents: (none)");
	}

	if (issues.length > 0) {
		lines.push("");
		lines.push(`Recent Issues (${issues.length}):`);
		for (const iss of issues) {
			const icon = iss.severity === "error" ? "❌" : "⚠️ ";
			lines.push(`  ${icon} ${iss.category}: ${iss.message}`);
		}
	} else {
		lines.push("");
		lines.push("Recent Issues: (none)");
	}

	lines.push("");
	lines.push("Paths:");
	lines.push(`  config    ${paths.configPath}`);
	lines.push(`  events    ${paths.eventsPath}`);
	lines.push(`  fluxDir   ${paths.fluxDir}`);

	return lines.join("\n");
}

export function formatUpgradeInfo(info: UpgradeInfo): string {
	const lines: string[] = [];
	lines.push("AgentFlux Upgrade Check");
	lines.push("═".repeat(60));
	lines.push(`Current:    ${info.currentCommit} (${info.currentMessage})`);
	lines.push(`Branch:     ${info.currentBranch}`);

	if (!info.hasRemote) {
		lines.push("");
		lines.push("No git remote configured — local-only development");
		lines.push("To enable upgrade checks: git remote add origin <url>");
		return lines.join("\n");
	}

	lines.push("");
	if (info.upToDate) {
		lines.push("✅ Up to date — no new commits on origin/" + info.currentBranch);
	} else {
		lines.push(`Status: ${info.remoteCommits.length} commit(s) behind origin/${info.currentBranch}`);
		lines.push("");
		lines.push("New commits:");
		for (const c of info.remoteCommits) {
			lines.push(`  ${c.hash}  ${c.message}`);
		}
		lines.push("");
		lines.push("Recommendation:");
		lines.push(`  ${info.recommendation}`);
	}

	return lines.join("\n");
}

export function formatIssues(issues: Issue[]): string {
	if (issues.length === 0) return "";
	const lines: string[] = [];
	for (const iss of issues) {
		const icon = iss.severity === "error" ? "❌" : "⚠️";
		lines.push(`${icon} ${iss.message}`);
	}
	return lines.join(" · ");
}
