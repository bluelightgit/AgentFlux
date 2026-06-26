/**
 * AgentFlux Core — Phase 2 静态分析信号 (RGAO 风格)
 * 文档依据: docs/05-routing 层1 静态, 08-references RGAO (arxiv 2605.05657)
 *
 * 复杂度检测方案 (git churn-based, 替代硬编码后缀):
 *   用 git log --numstat 获取每个文件的 added/deleted 行数,
 *   有 churn 历史 = 活跃代码文件, 不需要猜后缀.
 *   (Michael Feathers 的 Churn × Complexity = Hotspots 方法论)
 *
 * 信号来源:
 *   - git log --numstat: churn (变更行数/频率/热点)
 *   - git ls-files: 当前文件列表
 *   - 文件内容正则: import 图, 符号密度, TODO (仅对 churn 识别的代码文件)
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import type { Mode } from "./types";

export interface FileChurn {
	file: string;
	commits: number;
	added: number;
	deleted: number;
	churn: number;       // added + deleted
}

export interface TaskComplexitySignal {
	/** 代码文件数 (git churn 识别, 不含 docs/config) */
	fileCount: number;
	/** 代码行数 (当前 tracked 代码文件的非空行) */
	loc: number;
	/** 总 churn 行数 (git 历史中所有 added+deleted) */
	totalChurn: number;
	/** 依赖深度估算 (最长 import 链) */
	dependencyDepth: number;
	/** 跨模块耦合度 (被多文件 import 的模块比例) */
	crossModuleCoupling: number;
	/** 符号密度 (函数/类定义数 / LOC) */
	symbolDensity: number;
	/** 复杂度等级 0-3 (FastPath/SubAgent/MultiAgent/DeepResearch) */
	complexityTier: 0 | 1 | 2 | 3;
	/** 推荐模式 (RGAO 路由结果) */
	recommendedMode: Mode;
	/** 推荐理由 */
	reason: string[];
	// ── git 统计信号 ──
	/** 热点文件数 (commit 数 >3 的文件) */
	hotspotFiles: number;
	/** 最近 7 天提交数 */
	recentCommits: number;
	/** 测试覆盖率估算 (测试文件数 / 代码文件数, 0-1) */
	testCoverageEstimate: number;
	/** TODO/FIXME 密度 (每千行) */
	todoDensity: number;
	/** churn 最高的文件 (top 5) */
	topChurnFiles: { file: string; churn: number; commits: number }[];
}

/**
 * 收集代码库的静态复杂度信号 (git churn-based).
 */
export function collectComplexitySignal(cwd: string, scope?: string): TaskComplexitySignal {
	const reason: string[] = [];

	// 1. git churn 分析 (核心: 用提交历史识别代码文件)
	const churnMap = collectChurn(cwd);
	const allChurnFiles = scope
		? [...churnMap.values()].filter(c => c.file.startsWith(scope))
		: [...churnMap.values()];

	// 过滤非代码: churn < 3 行的文件大概率不是代码 (一次性 config/lock)
	// 黑名单策略: 不猜什么是代码, 只排除明显不是的 (.md/.json/.yaml/.lock/图片等)
	const codeChurnFiles = allChurnFiles.filter(c => c.churn >= 3 && !isNonCodeFile(c.file));
	const fileCount = codeChurnFiles.length;
	const totalChurn = codeChurnFiles.reduce((s, c) => s + c.churn, 0);

	// 当前 tracked 文件 (用于读内容算 LOC/import)
	const trackedFiles = listTrackedFiles(cwd, scope);
	const codeFileNames = new Set(codeChurnFiles.map(c => c.file));
	const currentCodeFiles = trackedFiles.filter(f => codeFileNames.has(f));

	// 2. LOC + 符号密度 (读当前代码文件, 限制 200 个)
	const readFiles = currentCodeFiles.slice(0, 200);
	let loc = 0;
	let totalSymbols = 0;
	for (const f of readFiles) {
		const content = readFileSyncSafe(join(cwd, f));
		if (!content) continue;
		const nonBlank = content.split("\n").filter(l => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("#"));
		loc += nonBlank.length;
		const symbols = content.match(/\b(function|def|class|interface|enum|const|let|var)\s+\w+/g);
		totalSymbols += symbols?.length ?? 0;
	}
	const symbolDensity = loc > 0 ? totalSymbols / loc : 0;

	// 3. 依赖深度 + 跨模块耦合
	const importGraph = buildImportGraph(cwd, readFiles);

	// 4. git 统计信号
	const hotspotFiles = codeChurnFiles.filter(c => c.commits > 3).length;
	const recentCommits = countRecentCommits(cwd);
	const testCoverageEstimate = estimateTestCoverage(currentCodeFiles);
	const todoDensity = countTodoDensity(cwd, readFiles, loc);

	// top churn files
	const topChurnFiles = [...codeChurnFiles]
		.sort((a, b) => b.churn - a.churn)
		.slice(0, 5)
		.map(c => ({ file: c.file, churn: c.churn, commits: c.commits }));

	// 5. 复杂度等级判定
	let tier: 0 | 1 | 2 | 3 = 0;
	let mode: Mode = "M1";
	if (fileCount <= 10 && loc <= 500 && importGraph.maxDepth <= 2) {
		tier = 0; mode = "M1";
		reason.push("FastPath: small project (code<=10, loc<=500, depth<=2)");
	} else if (fileCount <= 50 && importGraph.maxDepth <= 4 && importGraph.couplingRatio < 0.3) {
		tier = 1; mode = "M2";
		reason.push("SubAgent: medium project (code<=50, depth<=4, coupling<0.3)");
	} else if (importGraph.maxDepth >= 6 || importGraph.couplingRatio >= 0.5 || fileCount > 200) {
		tier = 3; mode = "M4";
		reason.push(`DeepResearch: high complexity (depth>=6 or coupling>=0.5 or code>200)`);
	} else {
		tier = 2; mode = "M3";
		reason.push("MultiAgent: medium-high complexity (needs fork exploration or multi-perspective)");
	}

	// git 信号补充
	if (hotspotFiles > 5) reason.push(`many hotspots (${hotspotFiles}), lean toward careful review`);
	if (testCoverageEstimate < 0.2 && fileCount > 10) reason.push(`low test coverage (${(testCoverageEstimate*100).toFixed(0)}%), lean toward adding tester`);
	if (todoDensity > 5) reason.push(`high tech debt (TODO/FIXME ${todoDensity.toFixed(1)}/kloc), lean toward refactor`);
	if (recentCommits > 20) reason.push(`active project (${recentCommits} commits in 7d), lean toward parallel`);

	return {
		fileCount, loc, totalChurn,
		dependencyDepth: importGraph.maxDepth,
		crossModuleCoupling: importGraph.couplingRatio,
		symbolDensity, complexityTier: tier, recommendedMode: mode, reason,
		hotspotFiles, recentCommits, testCoverageEstimate, todoDensity, topChurnFiles,
	};
}

/**
 * 从 git log --numstat 收集每个文件的 churn 数据.
 * 输出: Map<file, FileChurn>
 */
function collectChurn(cwd: string): Map<string, FileChurn> {
	const map = new Map<string, FileChurn>();
	try {
		// --no-merges 排除合并提交, -M 检测重命名
		const out = execSync(
			"git log --no-merges -M --numstat --format=\"\"",
			{ cwd, encoding: "utf-8", timeout: 15000, maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
		);
		for (const line of out.split("\n")) {
			if (!line.trim()) continue;
			// numstat 格式: added\tdeleted\tfilename
			const parts = line.split("\t");
			if (parts.length < 3) continue;
			const added = parseInt(parts[0]) || 0;
			const deleted = parseInt(parts[1]) || 0;
			const file = parts.slice(2).join("\t"); // 文件名可能含 tab? 罕见但安全
			if (!file || file === "/dev/null") continue;
			const existing = map.get(file);
			if (existing) {
				existing.commits++;
				existing.added += added;
				existing.deleted += deleted;
				existing.churn += added + deleted;
			} else {
				map.set(file, { file, commits: 1, added, deleted, churn: added + deleted });
			}
		}
	} catch { /* not a git repo or no commits */ }
	return map;
}

/** git ls-files 列出当前跟踪文件 */
function listTrackedFiles(cwd: string, scope?: string): string[] {
	try {
		const out = execSync("git ls-files", { cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
		let files = out.split("\n").filter(Boolean);
		files = files.filter(f =>
			!f.includes("node_modules/") && !f.includes("dist/") && !f.includes("build/") && !f.startsWith(".git/")
		);
		if (scope) files = files.filter(f => f.startsWith(scope));
		return files;
	} catch { return []; }
}

/** 黑名单: 排除明显不是代码的文件 (不猜什么是代码, 只排除确定不是的) */
function isNonCodeFile(f: string): boolean {
	const lower = f.toLowerCase();
	// 文档 / 配置 / 数据
	if (/\.(md|txt|rst|json|yaml|yml|toml|ini|cfg|conf|env|lock|csv|xml|svg)$/.test(lower)) return true;
	if (/(license|readme|changelog|contributing|authors|code_of_conduct)$/i.test(lower)) return true;
	if (/^\.(gitignore|editorconfig|npmrc|nvmrc|env)/.test(lower)) return true;
	// 图片 / 二进制
	if (/\.(png|jpg|jpeg|gif|webp|ico|bmp|ttf|otf|woff|woff2|eot|pdf|zip|tar|gz|jar|war|class|o|so|dll|exe|bin)$/.test(lower)) return true;
	return false;
}

function readFileSyncSafe(path: string): string | null {
	try {
		const { readFileSync } = require("node:fs");
		return readFileSync(path, "utf-8");
	} catch { return null; }
}

/** 最近 7 天提交数 */
function countRecentCommits(cwd: string): number {
	try {
		const out = execSync('git log --since="7 days ago" --oneline', { cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
		return out.split("\n").filter(Boolean).length;
	} catch { return 0; }
}

/** 测试覆盖率估算 (测试文件数 / 代码文件数) */
function estimateTestCoverage(codeFiles: string[]): number {
	const testFiles = codeFiles.filter(f =>
		/test|spec/i.test(f) ||
		f.endsWith(".test.ts") || f.endsWith(".spec.ts") ||
		f.endsWith("_test.go") || f.endsWith("_test.py") ||
		f.includes("/tests/") || f.includes("/test/")
	);
	return codeFiles.length > 0 ? testFiles.length / codeFiles.length : 0;
}

/** TODO/FIXME 密度 (每千行) */
function countTodoDensity(cwd: string, files: string[], loc: number): number {
	if (loc === 0) return 0;
	let todoCount = 0;
	for (const f of files) {
		const content = readFileSyncSafe(join(cwd, f));
		if (!content) continue;
		const matches = content.match(/\b(TODO|FIXME|HACK|XXX)\b/gi);
		todoCount += matches?.length ?? 0;
	}
	return (todoCount / loc) * 1000;
}

interface ImportGraph {
	maxDepth: number;
	couplingRatio: number;
}

function buildImportGraph(cwd: string, files: string[]): ImportGraph {
	const importers = new Map<string, Set<string>>();
	const fileImports = new Map<string, string[]>();
	for (const f of files) {
		const content = readFileSyncSafe(join(cwd, f));
		if (!content) continue;
		const imports = extractImports(content, f);
		fileImports.set(f, imports);
		for (const imp of imports) {
			if (!importers.has(imp)) importers.set(imp, new Set());
			importers.get(imp)!.add(f);
		}
	}
	const multiImport = Array.from(importers.values()).filter(s => s.size > 1).length;
	const couplingRatio = (importers.size || 1) > 0 ? multiImport / importers.size : 0;
	let maxDepth = 0;
	for (const [, imps] of fileImports) { if (imps.length > maxDepth) maxDepth = imps.length; }
	maxDepth = Math.min(maxDepth, 10);
	return { maxDepth, couplingRatio };
}

function extractImports(content: string, filePath: string): string[] {
	const imports: string[] = [];
	let m;
	const esRe = /from\s+['"]([^'"]+)['"]/g;
	while ((m = esRe.exec(content)) !== null) imports.push(m[1]);
	const cjsRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
	while ((m = cjsRe.exec(content)) !== null) imports.push(m[1]);
	if (filePath.endsWith(".py")) {
		const pyRe = /^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
		while ((m = pyRe.exec(content)) !== null) imports.push(m[1] || m[2]);
	}
	return imports.filter(i => i.startsWith(".") || i.startsWith("/") || i.startsWith("@/"));
}

/** Format complexity signal for display (used by /flux why, /flux complexity) */
export function formatComplexitySignal(s: TaskComplexitySignal): string {
	const tierNames = ["FastPath", "SubAgent", "MultiAgent", "DeepResearch"];
	const lines = [
		`Complexity Signal (git churn-based):`,
		`  files    ${s.fileCount} (git churn detected)`,
		`  loc      ${s.loc}`,
		`  churn    ${s.totalChurn} (total changed lines)`,
		`  depth    ${s.dependencyDepth} (longest import chain)`,
		`  coupling ${s.crossModuleCoupling.toFixed(2)} (multi-imported module ratio)`,
		`  symbols  ${s.symbolDensity.toFixed(3)}/line`,
		`  ── git signals ──`,
		`  hotspots ${s.hotspotFiles} (files with >3 commits)`,
		`  recent   ${s.recentCommits} commits (7d)`,
		`  testCov  ${(s.testCoverageEstimate * 100).toFixed(0)}% (test/source ratio)`,
		`  todo     ${s.todoDensity.toFixed(1)}/kloc`,
		`  ── top churn ──`,
	];
	for (const t of s.topChurnFiles) {
		lines.push(`  ${t.file.padEnd(30)} churn=${String(t.churn).padStart(5)} commits=${t.commits}`);
	}
	lines.push(`  tier     ${tierNames[s.complexityTier]} → ${s.recommendedMode}`);
	lines.push(`  reason   ${s.reason.join("; ")}`);
	return lines.join("\n");
}
