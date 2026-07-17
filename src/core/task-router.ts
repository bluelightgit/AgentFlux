/**
 * AgentFlux F3-2 — 任务级路由 (task-level routing)
 * 文档依据: docs/05-routing 层1, docs/22-mode-capability-roadmap
 *
 * 核心改进:
 *   Phase 2 的 collectComplexitySignal() 分析整个仓库 → 粗粒度
 *   Phase 3 的 classifyTask() 分析具体任务 + git diff scope → 精准路由
 *
 * 流程:
 *   1. classifyTask(): 从用户输入文本分类任务类型 (bugfix/feature/refactor/explore/review)
 *   2. analyzeTaskScope(): 用 git diff --stat 识别涉及的文件 (不是全仓库)
 *   3. computeTaskComplexity(): 基于 diff 文件数/耦合度/依赖深度计算复杂度
 *   4. 生成 TaskRoutingSignal 供 route() 消费
 *
 * 参考: RGAO (arxiv 2605.05657) — 从任务相关代码提取复杂度, 不是整个仓库
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Mode, Scenario } from "./types";

// ─── 任务分类 ───

export type TaskType = "bugfix" | "feature" | "refactor" | "explore" | "review" | "test" | "docs" | "unknown";

export interface TaskClassification {
	type: TaskType;
	scenario: Scenario | null;    // 映射到 preference scenario override
	confidence: number;           // 0-1
	keywords: string[];           // 匹配到的关键词
	mentionedFiles: string[];     // 用户输入中提到的文件路径
}

/** 关键词→类型映射表 */
const TYPE_KEYWORDS: Record<Exclude<TaskType, "unknown">, string[]> = {
	bugfix: ["bug", "fix", "crash", "broken", "wrong", "debug", "regression", "not working", "doesn't work", "traceback", "exception", "stacktrace", "修复", "故障", "崩溃", "错误", "异常", "回归", "无法运行", "不工作", "排查问题"],
	feature: ["add", "implement", "create", "new", "build", "feature", "support", "enable", "extend", "introduce", "develop", "新增", "添加", "实现", "创建", "功能", "支持", "开发", "接入", "启用"],
	refactor: ["refactor", "clean", "restructure", "reorganize", "simplify", "deduplicate", "extract", "rename", "move", "consolidate", "重构", "整理", "简化", "去重", "抽取", "重命名", "迁移", "合并模块"],
	explore: ["explore", "investigate", "understand", "analyze", "check", "look", "examine", "research", "study", "find out", "what does", "how does", "探索", "调查", "理解", "分析", "研究", "查看", "看看", "怎么实现", "工作原理"],
	review: ["review", "audit", "inspect", "evaluate", "assess", "check quality", "lint", "verify", "validate", "pr", "pull request", "审查", "评审", "审核", "代码检查", "质量检查", "验证"],
	test: ["test", "coverage", "unit test", "integration test", "mock", "stub", "fixture", "tdd", "bdd", "测试", "覆盖率", "单元测试", "集成测试", "端到端"],
	docs: ["document", "documentation", "readme", "doc", "comment", "javadoc", "docstring", "wiki", "文档", "说明", "注释", "使用指南"],
};

/** 文件路径正则 (匹配用户输入中的文件引用) */
const FILE_PATTERN = /(?:src\/|lib\/|test\/|tests\/|docs\/|components\/|utils\/|core\/)?[\w-]+\/[\w-]+\.\w+/g;

/**
 * 分类用户输入任务文本.
 *
 * 方法: 关键词匹配 + 文件引用提取.
 * 不用 LLM (零成本), 基于 RGAO 的静态信号思路.
 */
export function classifyTask(input: string): TaskClassification {
	const lower = input.toLowerCase();
	const keywords: string[] = [];
	const scores: Partial<Record<Exclude<TaskType, "unknown">, number>> = {};

	for (const [type, words] of Object.entries(TYPE_KEYWORDS) as [Exclude<TaskType, "unknown">, string[]][]) {
		let score = 0;
		for (const w of words) {
			if (lower.includes(w)) {
				score++;
				keywords.push(w);
			}
		}
		if (score > 0) scores[type] = score;
	}

	// 选最高分
	let bestType: TaskType = "unknown";
	let bestScore = 0;
	for (const [type, score] of Object.entries(scores) as [Exclude<TaskType, "unknown">, number][]) {
		if (score > bestScore) { bestScore = score; bestType = type; }
	}

	// 置信度: 基于匹配分数和关键词数
	const confidence = bestScore === 0 ? 0.2 : Math.min(0.9, 0.4 + bestScore * 0.15);

	// 映射到 Scenario (用于 preference override)
	const scenarioMap: Partial<Record<TaskType, Scenario>> = {
		bugfix: "bugfix", feature: "feature", refactor: "refactor", explore: "explore", review: "review",
	};
	const scenario = scenarioMap[bestType] ?? null;

	// 提取文件引用
	const mentionedFiles = [...new Set(input.match(FILE_PATTERN) || [])];

	return { type: bestType, scenario, confidence, keywords, mentionedFiles };
}

// ─── 任务范围分析 (git diff scope) ───

export interface TaskScope {
	/** git diff 涉及的文件 (未提交变更) */
	diffFiles: string[];
	/** diff 涉及的总行数 (added + deleted) */
	diffLines: number;
	/** 用户输入中提到的文件 (与 diff 文件取并集) */
	allRelevantFiles: string[];
	/** 是否有未提交变更 */
	hasUncommittedChanges: boolean;
}

/**
 * 分析任务范围: 用 git diff --stat 识别涉及的文件.
 *
 * 与 Phase 2 collectComplexitySignal 的区别:
 *   Phase 2: git log --numstat 分析整个仓库历史 → 仓库级复杂度
 *   Phase 3: git diff --stat 分析未提交变更 → 任务级范围
 *
 * 参考: RGAO 从任务相关代码提取复杂度向量
 */
export function analyzeTaskScope(cwd: string, mentionedFiles: string[] = []): TaskScope {
	const diffFiles: string[] = [];
	let diffLines = 0;

	try {
		// 未暂存 + 已暂存变更
		const out = execFileSync(
			"git", ["diff", "--stat", "HEAD", "--no-color"],
			{ cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
		);
		// 解析 git diff --stat 输出
		// 格式: " file.ts | 12 ++++--"
		for (const line of out.split("\n")) {
			const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)/);
			if (match) {
				diffFiles.push(match[1].trim());
				diffLines += parseInt(match[2]) || 0;
			}
		}
	} catch { /* not a git repo or no changes */ }

	const allRelevantFiles = [...new Set([...diffFiles, ...mentionedFiles])];

	return {
		diffFiles,
		diffLines,
		allRelevantFiles,
		hasUncommittedChanges: diffFiles.length > 0,
	};
}

// ─── 任务复杂度计算 ───

export interface TaskComplexity {
	/** 涉及文件数 */
	fileCount: number;
	/** 涉及代码行数估算 */
	loc: number;
	/** 跨模块耦合度 (diff 文件被其他文件 import 的比例) */
	coupling: number;
	/** 依赖深度 (diff 文件的 import 链深度) */
	dependencyDepth: number;
	/** 复杂度等级 0-3 (trivial/simple/moderate/complex) */
	tier: 0 | 1 | 2 | 3;
	/** 推荐模式 */
	recommendedMode: Mode;
	/** 推荐理由 */
	reason: string[];
}

/**
 * 基于任务范围计算复杂度.
 *
 * 只分析 diff 涉及的文件 (不是全仓库), 符合 RGAO 思路.
 */
export function computeTaskComplexity(cwd: string, scope: TaskScope): TaskComplexity {
	const files = scope.allRelevantFiles;
	const fileCount = files.length;
	const reason: string[] = [];

	// 估算 LOC (读取 diff 文件)
	let loc = 0;
	let totalImports = 0;
	const fileImportSets: Map<string, Set<string>> = new Map();
	const importedBy: Map<string, Set<string>> = new Map();

	for (const f of files.slice(0, 50)) { // 限制读取量
		try {
			const content = readFileSync(join(cwd, f), "utf-8");
			const nonBlank = content.split("\n").filter(l => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("#"));
			loc += nonBlank.length;

			// 提取 import
			const imports = extractImports(content);
			fileImportSets.set(f, new Set(imports));
			totalImports += imports.length;
			for (const imp of imports) {
				if (!importedBy.has(imp)) importedBy.set(imp, new Set());
				importedBy.get(imp)!.add(f);
			}
		} catch { /* file not found or binary */ }
	}

	// 耦合度: diff 文件被其他文件 import 的比例
	const couplingFiles = files.filter(f => {
		// 检查这个文件是否被 diff 范围外的文件 import
		const importers = importedBy.get(f) || importedBy.get(f.replace(/\.[^.]+$/, "")) || new Set();
		return importers.size > 0;
	});
	const coupling = fileCount > 0 ? couplingFiles.length / fileCount : 0;

	// 依赖深度: diff 文件中最长的 import 链 (简化: 直接 import 数)
	let maxImports = 0;
	for (const [, imps] of fileImportSets) {
		if (imps.size > maxImports) maxImports = imps.size;
	}
	const dependencyDepth = Math.min(maxImports, 10);

	// 复杂度等级
	let tier: 0 | 1 | 2 | 3 = 0;
	let mode: Mode = "M1";

	if (fileCount === 0 && scope.diffLines === 0) {
		// 没有未提交变更 → 可能是探索/新功能
		tier = 0; mode = "M1";
		reason.push("no uncommitted changes, likely exploration or new feature planning");
	} else if (fileCount <= 3 && scope.diffLines <= 50 && dependencyDepth <= 3) {
		tier = 0; mode = "M1";
		reason.push(`trivial: ${fileCount} files, ${scope.diffLines} diff lines, depth ${dependencyDepth}`);
	} else if (fileCount <= 10 && scope.diffLines <= 200 && coupling < 0.3) {
		tier = 1; mode = "M2";
		reason.push(`simple: ${fileCount} files, ${scope.diffLines} diff lines, coupling ${coupling.toFixed(2)}`);
	} else if (fileCount <= 30 && coupling < 0.5 && dependencyDepth <= 6) {
		tier = 2; mode = "M3";
		reason.push(`moderate: ${fileCount} files, coupling ${coupling.toFixed(2)}, depth ${dependencyDepth}`);
	} else {
		tier = 3; mode = "M4";
		reason.push(`complex: ${fileCount} files, coupling ${coupling.toFixed(2)}, depth ${dependencyDepth}`);
	}

	return { fileCount, loc, coupling, dependencyDepth, tier, recommendedMode: mode, reason };
}

function extractImports(content: string): string[] {
	const imports: string[] = [];
	let m;
	const esRe = /from\s+['"]([^'"]+)['"]/g;
	while ((m = esRe.exec(content)) !== null) imports.push(m[1]);
	const cjsRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
	while ((m = cjsRe.exec(content)) !== null) imports.push(m[1]);
	if (/^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/gm.test(content)) {
		const pyRe = /^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
		while ((m = pyRe.exec(content)) !== null) imports.push(m[1] || m[2]);
	}
	return imports.filter(i => i.startsWith(".") || i.startsWith("/") || i.startsWith("@/"));
}

// ─── 任务路由信号 (整合分类 + 范围 + 复杂度) ───

export interface TaskRoutingSignal {
	classification: TaskClassification;
	scope: TaskScope;
	complexity: TaskComplexity;
	/** 综合推荐模式 (结合任务类型和复杂度) */
	recommendedMode: Mode;
	/** 综合置信度 */
	confidence: number;
	/** 完整理由链 */
	reason: string[];
}

/**
 * 生成任务级路由信号 (F3-2 核心入口).
 *
 * 整合: 任务分类 + git diff 范围 + 复杂度计算 → 推荐模式
 */
export function generateTaskRoutingSignal(cwd: string, userInput: string): TaskRoutingSignal {
	const classification = classifyTask(userInput);
	const scope = analyzeTaskScope(cwd, classification.mentionedFiles);
	const complexity = computeTaskComplexity(cwd, scope);

	const reason: string[] = [];
	reason.push(`type:${classification.type} (conf=${classification.confidence.toFixed(2)}, keywords=[${classification.keywords.slice(0, 5).join(",")}])`);
	reason.push(`scope:${scope.diffFiles.length} diff files, ${scope.diffLines} lines, ${scope.allRelevantFiles.length} relevant`);
	reason.push(`complexity:tier${complexity.tier} → ${complexity.recommendedMode} (${complexity.reason.join("; ")})`);

	// 综合推荐: 任务类型可以调整复杂度推荐
	let recommendedMode = complexity.recommendedMode;
	const typeAdjustments: Partial<Record<TaskType, Mode>> = {
		// bugfix: 需要仔细分析 → 至少 M2
		bugfix: complexity.tier < 1 ? "M2" : recommendedMode,
		// review: 需要独立视角 → M3 (fork) 或 M4 (persistent reviewer)
		review: complexity.tier >= 2 ? "M4" : "M3",
		// explore: fork 探索最优
		explore: complexity.tier >= 1 ? "M3" : recommendedMode,
		// feature: 复杂度决定
		feature: recommendedMode,
		// refactor: 需要多视角 → M4
		refactor: complexity.tier >= 2 ? "M4" : recommendedMode,
		// test/docs: 通常简单
		test: complexity.tier < 2 ? "M2" : recommendedMode,
		docs: "M1",
	};
	if (classification.type !== "unknown" && typeAdjustments[classification.type]) {
		recommendedMode = typeAdjustments[classification.type]!;
		reason.push(`type-adjusted: ${classification.type} → ${recommendedMode}`);
	}

	// 综合置信度
	const confidence = Math.min(0.9, (classification.confidence + complexity.tier * 0.1) / 2 + 0.3);

	return { classification, scope, complexity, recommendedMode, confidence, reason };
}

// ─── 格式化 ───

export function formatTaskRoutingSignal(signal: TaskRoutingSignal): string {
	const tierNames = ["trivial", "simple", "moderate", "complex"];
	const lines = [
		"Task Routing Signal:",
		`  type      ${signal.classification.type} (conf=${signal.classification.confidence.toFixed(2)})`,
		`  keywords  [${signal.classification.keywords.slice(0, 8).join(", ")}]`,
		`  files     ${signal.classification.mentionedFiles.length} mentioned, ${signal.scope.diffFiles.length} diff, ${signal.scope.allRelevantFiles.length} relevant`,
		`  diff      ${signal.scope.diffLines} lines changed`,
		`  complexity ${tierNames[signal.complexity.tier]} (files=${signal.complexity.fileCount}, coupling=${signal.complexity.coupling.toFixed(2)}, depth=${signal.complexity.dependencyDepth})`,
		`  recommend  ${signal.recommendedMode} (conf=${signal.confidence.toFixed(2)})`,
		"  reason:",
		...signal.reason.map(r => `    ${r}`),
	];
	return lines.join("\n");
}
