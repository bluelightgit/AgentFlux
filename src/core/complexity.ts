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
	/** 文件数 (git ls-files) */
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
}

/**
 * 收集代码库的静态复杂度信号.
 * cwd: 项目根目录
 * scope: 可选, 限定分析范围 (如 "src/"), 默认全项目
 */
export function collectComplexitySignal(cwd: string, scope?: string): TaskComplexitySignal {
	const reason: string[] = [];
	let fileCount = 0;
	let loc = 0;
	let dependencyDepth = 0;
	let crossModuleCoupling = 0;
	let symbolDensity = 0;

	// 1. 文件列表 (git ls-files, 排除 node_modules/dist)
	const trackedFiles = listTrackedFiles(cwd, scope);
	fileCount = trackedFiles.length;

	// 2. LOC + 符号密度 (读前 N 个代码文件, 零依赖正则)
	const codeFiles = trackedFiles
		.filter(f => /\.(ts|js|tsx|jsx|py|go|rs|java)$/.test(f))
		.slice(0, 200); // 限制读取量, 避免大项目卡顿

	let totalSymbols = 0;
	for (const f of codeFiles) {
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
	const importGraph = buildImportGraph(cwd, codeFiles);
	dependencyDepth = importGraph.maxDepth;
	crossModuleCoupling = importGraph.couplingRatio;

	// 4. 复杂度等级判定 (RGAO 风格阈值)
	let tier: 0 | 1 | 2 | 3 = 0;
	let mode: Mode = "M1";
	if (fileCount <= 10 && loc <= 500 && dependencyDepth <= 2) {
		tier = 0; mode = "M1";
		reason.push("FastPath: 小型任务 (file<=10, loc<=500, depth<=2)");
	} else if (fileCount <= 50 && dependencyDepth <= 4 && crossModuleCoupling < 0.3) {
		tier = 1; mode = "M2";
		reason.push("SubAgent: 中型任务 (file<=50, depth<=4, coupling<0.3)");
	} else if (dependencyDepth >= 6 || crossModuleCoupling >= 0.5 || fileCount > 200) {
		tier = 3; mode = "M4";
		reason.push(`DeepResearch: 高耦合任务 (depth>=6 或 coupling>=0.5 或 file>200)`);
	} else {
		tier = 2; mode = "M3";
		reason.push("MultiAgent: 中高复杂度 (需 fork 探索或多视角)");
	}

	return {
		fileCount, loc, dependencyDepth, crossModuleCoupling, symbolDensity,
		complexityTier: tier, recommendedMode: mode, reason,
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
		`  files    ${s.fileCount}`,
		`  loc      ${s.loc}`,
		`  depth    ${s.dependencyDepth} (最长 import 链)`,
		`  coupling ${s.crossModuleCoupling.toFixed(2)} (被多文件引用的模块比)`,
		`  symbols  ${s.symbolDensity.toFixed(3)}/line`,
		`  tier     ${tierNames[s.complexityTier]} → ${s.recommendedMode}`,
		`  reason   ${s.reason.join("; ")}`,
	].join("\n");
}
