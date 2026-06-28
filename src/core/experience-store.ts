/**
 * AgentFlux F3-3 — 反馈闭环 (ExperienceStore)
 * 文档依据: docs/05-routing 层3, docs/22-mode-capability-roadmap
 *
 * 核心思路: "穷人版 RL" — 用统计替代 RL
 *   1. 每次任务执行后, 记录: 任务签名 (type+complexity+scope hash) → mode → 实际结果 (cost/latency/success)
 *   2. querySimilar() 查找历史相似任务
 *   3. suggest() 当 ≥3 条相似记录且成功率 >70% 时, 返回最低成本模式推荐
 *
 * 数据来源: 消费 telemetry events.jsonl 中的 routing.decision + subagent.run + cache.sample
 *
 * 参考: EvoRoute (ACL 2026) 经验路由 -80% 成本; BAMAS ILP+RL -86% 成本
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Mode } from "./types";

// ─── 类型定义 ───

export interface ExperienceRecord {
	id: string;
	timestamp: string;
	/** 任务签名 */
	signature: TaskSignature;
	/** 路由推荐的模式 */
	routedMode: Mode;
	/** 实际使用的模式 (可能被用户覆盖) */
	actualMode: Mode;
	/** 执行结果 */
	outcome: TaskOutcome;
	/** 额外上下文 */
	context?: {
		stage?: string;
		preset?: string;
		projectHash?: string;
	};
}

export interface TaskSignature {
	/** 任务类型 (bugfix/feature/refactor/explore/review/test/docs/unknown) */
	taskType: string;
	/** 复杂度等级 0-3 */
	complexityTier: number;
	/** 涉及文件数 */
	fileCount: number;
	/** diff 行数 */
	diffLines: number;
	/** 签名哈希 (type+tier+fileCountBucket) */
	hash: string;
}

export interface TaskOutcome {
	success: boolean;
	cost: number;
	latencyMs: number;
	turns: number;
	cacheHitRate: number;
	/** 质量门是否通过 */
	gatePassed?: boolean;
	/** 重试次数 */
	retryCount?: number;
}

export interface ModeRecommendation {
	/** 推荐模式 */
	mode: Mode;
	/** 置信度 0-1 */
	confidence: number;
	/** 样本数 */
	sampleCount: number;
	/** 平均成本 */
	avgCost: number;
	/** 平均延迟 */
	avgLatencyMs: number;
	/** 成功率 */
	successRate: number;
	/** 理由 */
	reason: string;
}

// ─── ExperienceStore ───

export class ExperienceStore {
	private readonly storeDir: string;
	private readonly recordsFile: string;

	constructor(fluxDir: string) {
		this.storeDir = join(fluxDir, "runtime");
		this.recordsFile = join(this.storeDir, "experience.jsonl");
		if (!existsSync(this.storeDir)) mkdirSync(this.storeDir, { recursive: true });
	}

	/**
	 * 记录一次任务执行经验.
	 */
	record(entry: Omit<ExperienceRecord, "id" | "timestamp" | "signature"> & {
		taskType: string;
		complexityTier: number;
		fileCount: number;
		diffLines: number;
	}): void {
		const signature: TaskSignature = {
			taskType: entry.taskType,
			complexityTier: entry.complexityTier,
			fileCount: entry.fileCount,
			diffLines: entry.diffLines,
			hash: this.computeHash(entry.taskType, entry.complexityTier, entry.fileCount),
		};

		const record: ExperienceRecord = {
			id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: new Date().toISOString(),
			signature,
			routedMode: entry.routedMode,
			actualMode: entry.actualMode,
			outcome: entry.outcome,
			context: entry.context,
		};

		try {
			appendFileSync(this.recordsFile, JSON.stringify(record) + "\n", "utf-8");
		} catch (e) {
			console.error(`[flux exp] failed to record: ${e}`);
		}
	}

	/**
	 * 查找相似任务的历史记录.
	 *
	 * 相似度定义: 同 taskType + 同 complexityTier + fileCount 在同一桶 (±5)
	 */
	querySimilar(taskType: string, complexityTier: number, fileCount: number): ExperienceRecord[] {
		const all = this.loadAll();
		const targetHash = this.computeHash(taskType, complexityTier, fileCount);
		// 精确匹配
		const exact = all.filter(r => r.signature.hash === targetHash);
		if (exact.length >= 3) return exact;
		// 放宽: 同 type + 同 tier
		const relaxed = all.filter(r =>
			r.signature.taskType === taskType &&
			r.signature.complexityTier === complexityTier
		);
		return relaxed;
	}

	/**
	 * 基于历史经验推荐最优模式.
	 *
	 * 条件:
	 *   - 至少 minSamples 条相似记录 (默认 3)
	 *   - 成功率 > minSuccessRate (默认 0.7)
	 *   - 选择成功率达标的模式中平均成本最低的
	 *
	 * @returns 推荐结果, 或 null 如果数据不足
	 */
	suggest(
		taskType: string,
		complexityTier: number,
		fileCount: number,
		opts?: { minSamples?: number; minSuccessRate?: number },
	): ModeRecommendation | null {
		const minSamples = opts?.minSamples ?? 3;
		const minSuccessRate = opts?.minSuccessRate ?? 0.7;

		const similar = this.querySimilar(taskType, complexityTier, fileCount);
		if (similar.length < minSamples) {
			return null;
		}

		// 按 actualMode 分组统计
		const modeStats = new Map<Mode, { records: ExperienceRecord[]; successCount: number; totalCost: number; totalLatency: number }>();
		for (const r of similar) {
			const mode = r.actualMode;
			if (!modeStats.has(mode)) {
				modeStats.set(mode, { records: [], successCount: 0, totalCost: 0, totalLatency: 0 });
			}
			const stats = modeStats.get(mode)!;
			stats.records.push(r);
			if (r.outcome.success) stats.successCount++;
			stats.totalCost += r.outcome.cost;
			stats.totalLatency += r.outcome.latencyMs;
		}

		// 筛选成功率达标的模式
		const candidates: ModeRecommendation[] = [];
		for (const [mode, stats] of modeStats) {
			const successRate = stats.successCount / stats.records.length;
			if (successRate < minSuccessRate) continue;
			const avgCost = stats.totalCost / stats.records.length;
			const avgLatency = stats.totalLatency / stats.records.length;
			candidates.push({
				mode,
				confidence: Math.min(0.95, 0.5 + stats.records.length * 0.1),
				sampleCount: stats.records.length,
				avgCost,
				avgLatencyMs: avgLatency,
				successRate,
				reason: `${mode}: ${stats.records.length} samples, ${((successRate) * 100).toFixed(0)}% success, avg $${avgCost.toFixed(6)}`,
			});
		}

		if (candidates.length === 0) return null;

		// 选最低成本
		candidates.sort((a, b) => a.avgCost - b.avgCost);
		return candidates[0];
	}

	/**
	 * 获取所有记录 (从 JSONL 文件加载).
	 */
	loadAll(): ExperienceRecord[] {
		if (!existsSync(this.recordsFile)) return [];
		try {
			const content = readFileSync(this.recordsFile, "utf-8");
			return content.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as ExperienceRecord);
		} catch { return []; }
	}

	/**
	 * 获取统计摘要.
	 */
	getStats(): { totalRecords: number; uniqueSignatures: number; modeDistribution: Record<string, number> } {
		const all = this.loadAll();
		const signatures = new Set(all.map(r => r.signature.hash));
		const modeDist: Record<string, number> = {};
		for (const r of all) {
			modeDist[r.actualMode] = (modeDist[r.actualMode] || 0) + 1;
		}
		return { totalRecords: all.length, uniqueSignatures: signatures.size, modeDistribution: modeDist };
	}

	/**
	 * 从 telemetry events.jsonl 导入历史数据.
	 *
	 * 匹配 routing.decision 事件, 关联同 session 的 subagent.run 事件获取实际成本.
	 */
	importFromTelemetry(eventsFile: string): number {
		if (!existsSync(eventsFile)) return 0;
		try {
			const content = readFileSync(eventsFile, "utf-8");
			const events = content.split("\n").filter(Boolean).map(l => JSON.parse(l));
			let imported = 0;

			// 按 session 分组 subagent.run 事件
			const subagentRuns = new Map<string, any[]>();
			for (const e of events) {
				if (e.type === "subagent.run") {
					const sid = e.sessionId || e.payload?.sessionId || "";
					if (!subagentRuns.has(sid)) subagentRuns.set(sid, []);
					subagentRuns.get(sid)!.push(e);
				}
			}

			for (const e of events) {
				if (e.type !== "routing.decision") continue;
				const p = e.payload || e;
				const sessionId = e.sessionId || p.sessionId || "";
				const runs = subagentRuns.get(sessionId) || [];

				// 从 subagent.run 聚合实际成本
				const totalCost = runs.reduce((s, r) => s + (r.payload?.cost || r.cost || 0), 0);
				const totalLatency = runs.reduce((s, r) => s + (r.payload?.latencyMs || 0), 0);
				const success = runs.every(r => (r.payload?.exitCode || 0) === 0);

				this.record({
					taskType: p.taskType || "unknown",
					complexityTier: p.complexityTier || 0,
					fileCount: p.fileCount || 0,
					diffLines: p.diffLines || 0,
					routedMode: p.mode || "M1",
					actualMode: p.mode || "M1",
					outcome: {
						success,
						cost: totalCost,
						latencyMs: totalLatency,
						turns: runs.length,
						cacheHitRate: runs.reduce((s, r) => s + (r.payload?.cacheHitRate || 0), 0) / (runs.length || 1),
					},
					context: { stage: p.stage, preset: p.preset },
				});
				imported++;
			}
			return imported;
		} catch (e) {
			console.error(`[flux exp] telemetry import failed: ${e}`);
			return 0;
		}
	}

	private computeHash(taskType: string, tier: number, fileCount: number): string {
		// fileCount 分桶: 0, 1-3, 4-10, 11-30, 31+
		const bucket = fileCount === 0 ? 0 : fileCount <= 3 ? 1 : fileCount <= 10 ? 2 : fileCount <= 30 ? 3 : 4;
		return createHash("md5").update(`${taskType}:${tier}:${bucket}`).digest("hex").slice(0, 8);
	}
}

// ─── 格式化 ───

export function formatRecommendation(rec: ModeRecommendation | null): string {
	if (!rec) return "No recommendation (insufficient data).";
	return `Recommend: ${rec.mode} (conf=${rec.confidence.toFixed(2)}, samples=${rec.sampleCount}, success=${((rec.successRate) * 100).toFixed(0)}%, avgCost=$${rec.avgCost.toFixed(6)}, avgLatency=${(rec.avgLatencyMs / 1000).toFixed(1)}s) — ${rec.reason}`;
}

export function formatExperienceStats(stats: { totalRecords: number; uniqueSignatures: number; modeDistribution: Record<string, number> }): string {
	const lines = [
		`Experience Store:`,
		`  records     ${stats.totalRecords}`,
		`  signatures  ${stats.uniqueSignatures}`,
		`  modes       ${Object.entries(stats.modeDistribution).map(([m, c]) => `${m}×${c}`).join(", ") || "(none)"}`,
	];
	return lines.join("\n");
}
