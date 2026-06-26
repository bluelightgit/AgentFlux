/**
 * AgentFlux Core — Phase 2 静态分析信号 (RGAO 风格)
 * 文档依据: docs/05-routing 层1 静态, 08-references RGAO (arxiv 2605.05657)
 *
 * RGAO (Retrieval-conditioned topology selection for multi-agent code generation):
 *   从代码索引提取结构复杂度向量, 路由到不同拓扑.
 *   核心信号: 依赖深度, 跨模块耦合度, 符号密度.
 *   实测: 误路由率从 30.1% 降到 8.2%.
 *
 * AgentFlux Phase 2 简化实现:
 *   - 从 git ls-files + 简单正则提取信号 (不依赖 AST, 零依赖)
 *   - 输出 TaskComplexitySignal, 喂给路由器作为 taskSignal
 *   - 模式倾向: 信号越复杂 → 越倾向多 agent/review/fork
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Mode } from "./types";

export interface TaskComplexitySignal {
	/** 代码文件数 (只计源码, 不含 docs/markdown) */
	fileCount: number;
	/** 代码行数 (LOC, 排除空行/注释行) */
	loc: number;
	/** 依赖深度估算 (最长 import 链) */
	dependencyDepth: number;
	/** 跨模块耦合度 (被多文件 import 的模块比例) */
	crossModuleCoupling: number;
	/** 符号密度 (函数/类定义数 / LOC) */
	symbolDensity: number;
	/** 复杂度等级 0-4 (FastPath=0, SubAgent=1, MultiAgent=2, DeepResearch=3) */
	complexityTier: 0 | 1 | 2 | 3;
	/** 推荐模式 (RGAO 路由结果) */
	recommendedMode: Mode;
	/** 推荐理由 */
	reason: string[];
	// ── F2-12 git 统计信号 ──
	/** 热点文件数 (最近 30 天内被修改 >3 次的文件) */
	hotspotFiles: number;
	/** 最近 7 天提交数 */
	recentCommits: number;
	/** 测试覆盖率估算 (测试文件数 / 源码文件数, 0-1) */
	testCoverageEstimate: number;
	/** TODO/FIXME 密度 (每千行) */
	todoDensity: number;
}

/**
 * 收集代码库的静态复杂度信号.
 * cwd: 项目根目录
 * scope: 可选, 限定分析范围 (如 "src/"), 默认全项目
 */
export function collectComplexitySignal(cwd: string, scope?: string): TaskComplexitySignal {
	const reason: string[] = [];
	let loc = 0;
	let dependencyDepth = 0;
	let crossModuleCoupling = 0;
	let symbolDensity = 0;

	// 1. 文件列表 (git ls-files, 只保留代码文件)
	const trackedFiles = listTrackedFiles(cwd, scope);
	const codeFiles = trackedFiles.filter(f => isCodeFile(f));
	const fileCount = codeFiles.length;  // 只统计代码文件

	// 2. LOC + 符号密度 (读前 N 个代码文件, 零依赖正则)
	const readFiles = codeFiles.slice(0, 200); // 限制读取量, 避免大项目卡顿

	let totalSymbols = 0;
	for (const f of readFiles) {
		try {
			const content = readFileSyncSafe(join(cwd, f));
			if (!content) continue;
			const nonBlankLines = content.split("\n").filter(l => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("#"));
			loc += nonBlankLines.length;
			// 符号: function/def/class/interface 声明
			const symbolMatches = content.match(/\b(function|def|class|interface|enum|const|let|var)\s+\w+/g);
			totalSymbols += symbolMatches?.length ?? 0;
		} catch { /* */ }
	}
	symbolDensity = loc > 0 ? totalSymbols / loc : 0;

	// 3. 依赖深度 + 跨模块耦合 (从 import 语句)
	const importGraph = buildImportGraph(cwd, readFiles);
	dependencyDepth = importGraph.maxDepth;
	crossModuleCoupling = importGraph.couplingRatio;

	// 4. F2-12: git 统计信号
	const hotspotFiles = countHotspotFiles(cwd);
	const recentCommits = countRecentCommits(cwd);
	const testCoverageEstimate = estimateTestCoverage(codeFiles);
	const todoDensity = countTodoDensity(cwd, readFiles, loc);

	// 5. 复杂度等级判定 (RGAO 风格阈值, 基于代码文件数)
	let tier: 0 | 1 | 2 | 3 = 0;
	let mode: Mode = "M1";
	if (fileCount <= 10 && loc <= 500 && dependencyDepth <= 2) {
		tier = 0; mode = "M1";
		reason.push("FastPath: 小型任务 (code<=10, loc<=500, depth<=2)");
	} else if (fileCount <= 50 && dependencyDepth <= 4 && crossModuleCoupling < 0.3) {
		tier = 1; mode = "M2";
		reason.push("SubAgent: 中型任务 (code<=50, depth<=4, coupling<0.3)");
	} else if (dependencyDepth >= 6 || crossModuleCoupling >= 0.5 || fileCount > 200) {
		tier = 3; mode = "M4";
		reason.push(`DeepResearch: 高耦合任务 (depth>=6 或 coupling>=0.5 或 code>200)`);
	} else {
		tier = 2; mode = "M3";
		reason.push("MultiAgent: 中高复杂度 (需 fork 探索或多视角)");
	}

	// git 信号补充理由
	if (hotspotFiles > 5) reason.push(`热点文件多 (${hotspotFiles}), 倾向仔细 review`);
	if (testCoverageEstimate < 0.2 && fileCount > 10) reason.push(`测试覆盖率低 (${(testCoverageEstimate*100).toFixed(0)}%), 倾向加 tester`);
	if (todoDensity > 5) reason.push(`技术债高 (TODO/FIXME ${todoDensity.toFixed(1)}/kloc), 倾向 refactor`);
	if (recentCommits > 20) reason.push(`活跃项目 (7天 ${recentCommits} commits), 倾向并行`);

	return {
		fileCount, loc, dependencyDepth, crossModuleCoupling, symbolDensity,
		complexityTier: tier, recommendedMode: mode, reason,
		hotspotFiles, recentCommits, testCoverageEstimate, todoDensity,
	};
}

/** git ls-files 列出跟踪文件, 过滤常见非源码目录 */
function listTrackedFiles(cwd: string, scope?: string): string[] {
	try {
		const out = execSync("git ls-files", { cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
		let files = out.split("\n").filter(Boolean);
		// 过滤
		files = files.filter(f =>
			!f.includes("node_modules/") &&
			!f.includes("dist/") &&
			!f.includes("build/") &&
			!f.startsWith(".git/")
		);
		if (scope) {
			files = files.filter(f => f.startsWith(scope));
		}
		return files;
	} catch {
		return [];
	}
}

/** 判断是否为代码文件 (排除 docs/markdown/config) */
function isCodeFile(f: string): boolean {
	return /\.(ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|rb|php|swift|kt|scala|lua|sh)$/.test(f);
}

/** F2-12: 统计热点文件 (最近 30 天内被修改 >3 次的文件) */
function countHotspotFiles(cwd: string): number {
	try {
		const out = execSync(
			'git log --since="30 days ago" --format="" --name-only',
			{ cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
		);
		const counts = new Map<string, number>();
		for (const line of out.split("\n").filter(Boolean)) {
			counts.set(line, (counts.get(line) ?? 0) + 1);
		}
		return Array.from(counts.values()).filter(c => c > 3).length;
	} catch { return 0; }
}

/** F2-12: 最近 7 天提交数 */
function countRecentCommits(cwd: string): number {
	try {
		const out = execSync(
			'git log --since="7 days ago" --oneline',
			{ cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
		);
		return out.split("\n").filter(Boolean).length;
	} catch { return 0; }
}

/** F2-12: 测试覆盖率估算 (测试文件数 / 源码文件数) */
function estimateTestCoverage(codeFiles: string[]): number {
	const testFiles = codeFiles.filter(f =>
		/test|spec/i.test(f) ||
		f.endsWith(".test.ts") ||
		f.endsWith(".spec.ts") ||
		f.endsWith("_test.go") ||
		f.endsWith("_test.py") ||
		f.includes("/tests/") ||
		f.includes("/test/")
	);
	return codeFiles.length > 0 ? testFiles.length / codeFiles.length : 0;
}

/** F2-12: TODO/FIXME 密度 (每千行代码) */
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

function readFileSyncSafe(path: string): string | null {
	try {
		const { readFileSync } = require("node:fs");
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

interface ImportGraph {
	maxDepth: number;        // 最长 import 链长度
	couplingRatio: number;   // 被多文件引用的模块比例 (0-1)
}

/** 从 import/require 语句构建简单依赖图 */
function buildImportGraph(cwd: string, files: string[]): ImportGraph {
	const importers = new Map<string, Set<string>>(); // module -> set of files importing it
	const fileImports = new Map<string, string[]>();   // file -> imported modules

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

	// 跨模块耦合: 被多于1个文件 import 的模块比例
	const modulesWithMultipleImporters = Array.from(importers.values()).filter(s => s.size > 1).length;
	const totalModules = importers.size || 1;
	const couplingRatio = modulesWithMultipleImporters / totalModules;

	// 依赖深度: 简化估算 (不递归求最长路径, 用 import 数量的对数近似, 避免环检测复杂度)
	let maxDepth = 0;
	for (const [file, imps] of fileImports) {
		if (imps.length > maxDepth) maxDepth = imps.length;
	}
	// 真实深度需拓扑排序, 这里用 max import count 近似 (够用, RGAO 也只看量级)
	maxDepth = Math.min(maxDepth, 10); // 封顶

	return { maxDepth, couplingRatio };
}

/** 从源码提取 import 路径 (TS/JS/Python 通用) */
function extractImports(content: string, filePath: string): string[] {
	const imports: string[] = [];
	// ES modules: import ... from '...'
	let m;
	const esRe = /from\s+['"]([^'"]+)['"]/g;
	while ((m = esRe.exec(content)) !== null) imports.push(m[1]);
	// CommonJS: require('...')
	const cjsRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
	while ((m = cjsRe.exec(content)) !== null) imports.push(m[1]);
	// Python: import X, from X import Y
	if (filePath.endsWith(".py")) {
		const pyRe = /^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
		while ((m = pyRe.exec(content)) !== null) imports.push(m[1] || m[2]);
	}
	// 只保留相对/本地 import (过滤 npm 包等外部依赖)
	return imports.filter(i => i.startsWith(".") || i.startsWith("/") || i.startsWith("@/"));
}

/** 格式化复杂度信号为可读文本 (用于 /flux why) */
export function formatComplexitySignal(s: TaskComplexitySignal): string {
	const tierNames = ["FastPath", "SubAgent", "MultiAgent", "DeepResearch"];
	return [
		`复杂度信号 (RGAO 静态分析):`,
		`  files    ${s.fileCount} (代码文件)`,
		`  loc      ${s.loc}`,
		`  depth    ${s.dependencyDepth} (最长 import 链)`,
		`  coupling ${s.crossModuleCoupling.toFixed(2)} (被多文件引用的模块比)`,
		`  symbols  ${s.symbolDensity.toFixed(3)}/line`,
		`  ── git 信号 ──`,
		`  hotspots ${s.hotspotFiles} (30天内修改>3次的文件)`,
		`  recent   ${s.recentCommits} commits (7天)`,
		`  testCov  ${(s.testCoverageEstimate * 100).toFixed(0)}% (测试文件/源码文件)`,
		`  todo     ${s.todoDensity.toFixed(1)}/kloc (TODO/FIXME密度)`,
		`  tier     ${tierNames[s.complexityTier]} → ${s.recommendedMode}`,
		`  reason   ${s.reason.join("; ")}`,
	].join("\n");
}
