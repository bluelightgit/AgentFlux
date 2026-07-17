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

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Mode } from "./types";
import type { TelemetryEvidence, TelemetryOutcomeStatus } from "../telemetry/events";

// ─── 类型定义 ───

export interface ExperienceRecord {
	id: string;
	timestamp: string;
	/** 与 telemetry 的因果链保持一致；旧记录可缺省。 */
	taskId?: string;
	runId?: string;
	decisionId?: string;
	stepId?: string;
	attemptId?: string;
	startedAt?: number;
	finishedAt?: number;
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
	status?: TelemetryOutcomeStatus;
	/** `cost` 是旧字段；`costUsd` 是 telemetry 统一字段，两者存储同一数值。 */
	cost: number;
	costUsd?: number;
	latencyMs: number;
	turns: number;
	cacheHitRate: number;
	/** 质量门是否通过 */
	gatePassed?: boolean;
	/** 重试次数 */
	retryCount?: number;
	/** 任务完成的可验证证据。 */
	evidence?: TelemetryEvidence[];
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
			timestamp: new Date(entry.finishedAt ?? Date.now()).toISOString(),
			taskId: entry.taskId,
			runId: entry.runId,
			decisionId: entry.decisionId,
			stepId: entry.stepId,
			attemptId: entry.attemptId,
			startedAt: entry.startedAt,
			finishedAt: entry.finishedAt,
			signature,
			routedMode: entry.routedMode,
			actualMode: entry.actualMode,
			outcome: {
				...entry.outcome,
				cost: finiteNumber(entry.outcome.costUsd) ?? entry.outcome.cost,
				costUsd: finiteNumber(entry.outcome.costUsd) ?? entry.outcome.cost,
			},
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
	 * 兼容当前 TelemetryWriter 的扁平 schema 与旧 `{ payload: ... }` schema。
	 * 关联优先级: decisionId > runId > taskId > 同 session 时序窗口。
	 * 没有可判定 outcome/exitCode 的真实 run 时不生成经验，避免 `every([]) === true`
	 * 将未执行的决策污染为“成功且零成本”。
	 */
	importFromTelemetry(eventsFile: string): number {
		if (!existsSync(eventsFile)) return 0;
		try {
			const content = readFileSync(eventsFile, "utf-8");
			const events: Array<Record<string, any>> = content.split("\n")
				.map(line => line.trim())
				.filter(Boolean)
				.flatMap((line, index) => {
					try { return [{ ...normalizeTelemetryEvent(JSON.parse(line)), _index: index }]; }
					catch { return []; }
				});
			let imported = 0;

			const decisions = events.filter(e => e.type === "routing.decision");
			const allRuns = events.filter(e => e.type === "subagent.run");

			for (let i = 0; i < decisions.length; i++) {
				const p = decisions[i];
				const nextDecisionIndex = decisions
					.slice(i + 1)
					.find(d => d.sessionId === p.sessionId)?._index ?? Number.POSITIVE_INFINITY;
				const runs = correlateRuns(p, allRuns, nextDecisionIndex)
					.map(event => ({ event, success: resolveRunSuccess(event) }))
					.filter((run): run is { event: Record<string, any>; success: boolean } => run.success !== null);

				// 没有真实完成 run 的决策不是训练样本。
				if (runs.length === 0) continue;

				const runEvents = runs.map(run => run.event);
				const totalCost = runEvents.reduce((sum, run) => sum + readCostUsd(run), 0);
				const totalLatency = aggregateLatency(runEvents);
				const success = runs.every(run => run.success);
				const status: TelemetryOutcomeStatus = success
					? "success"
					: runs.some(run => run.success) ? "partial" : aggregateFailureStatus(runEvents);
				const evidence = collectEvidence(p, runEvents);
				const startedAt = minTimestamp(runEvents.map(readStartedAt));
				const finishedAt = maxTimestamp(runEvents.map(readFinishedAt));
				const firstRun = runEvents[0];
				const gateValues = runEvents
					.map(run => run.outcome?.gatePassed ?? run.gatePassed)
					.filter((value): value is boolean => typeof value === "boolean");

				this.record({
					taskId: p.taskId ?? firstRun.taskId,
					runId: p.runId ?? firstRun.runId,
					decisionId: p.decisionId ?? firstRun.decisionId,
					stepId: p.stepId ?? firstRun.stepId,
					attemptId: p.attemptId ?? firstRun.attemptId,
					startedAt,
					finishedAt,
					taskType: p.taskType ?? p.task?.type ?? "unknown",
					complexityTier: finiteNumber(p.complexityTier ?? p.task?.complexityTier) ?? 0,
					fileCount: finiteNumber(p.fileCount ?? p.task?.fileCount) ?? 0,
					diffLines: finiteNumber(p.diffLines ?? p.task?.diffLines) ?? 0,
					routedMode: p.mode ?? "M1",
					actualMode: p.actualMode ?? firstRun.actualMode ?? firstRun.mode ?? p.mode ?? "M1",
					outcome: {
						status,
						success,
						cost: totalCost,
						costUsd: totalCost,
						latencyMs: totalLatency,
						turns: runEvents.reduce((sum, run) => sum + (finiteNumber(run.turns) ?? 1), 0),
						cacheHitRate: average(runEvents.map(run => finiteNumber(run.cacheHitRate) ?? 0)),
						gatePassed: gateValues.length > 0 ? gateValues.every(Boolean) : undefined,
						retryCount: runEvents.reduce((sum, run) => sum + (finiteNumber(run.retryCount ?? run.outcome?.retryCount) ?? 0), 0),
						evidence,
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

function normalizeTelemetryEvent(raw: any): Record<string, any> {
	const payload = raw && typeof raw.payload === "object" && raw.payload !== null ? raw.payload : {};
	const normalized = { ...payload, ...raw };
	delete normalized.payload;
	normalized.type = raw?.type ?? payload.type;
	normalized.sessionId = raw?.sessionId ?? payload.sessionId ?? "";
	return normalized;
}

function correlateRuns(
	decision: Record<string, any>,
	allRuns: Record<string, any>[],
	nextDecisionIndex: number,
): Record<string, any>[] {
	const byDecision = decision.decisionId
		? allRuns.filter(run => run.decisionId === decision.decisionId)
		: [];
	if (byDecision.length > 0) return byDecision;

	const inWindow = allRuns.filter(run =>
		run._index > decision._index &&
		run._index < nextDecisionIndex &&
		run.sessionId === decision.sessionId
	);
	if (decision.runId) {
		const byRun = inWindow.filter(run => run.runId === decision.runId);
		if (byRun.length > 0) return byRun;
	}
	if (decision.taskId) {
		const byTask = inWindow.filter(run => run.taskId === decision.taskId);
		if (byTask.length > 0) return byTask;
	}
	return inWindow;
}

function resolveRunSuccess(run: Record<string, any>): boolean | null {
	if (typeof run.outcome?.success === "boolean") return run.outcome.success;
	if (typeof run.success === "boolean") return run.success;
	const status = String(run.outcome?.status ?? run.status ?? "").toLowerCase();
	if (status === "success" || status === "succeeded" || status === "passed" || status === "done") return true;
	if (["failure", "failed", "partial", "cancelled", "canceled", "timeout", "timed_out"].includes(status)) return false;
	const exitCode = finiteNumber(run.exitCode ?? run.outcome?.exitCode);
	return exitCode === undefined ? null : exitCode === 0;
}

function readCostUsd(run: Record<string, any>): number {
	return finiteNumber(run.costUsd ?? run.cost ?? run.outcome?.costUsd ?? run.outcome?.cost ?? run.usage?.cost) ?? 0;
}

function readStartedAt(run: Record<string, any>): number | undefined {
	const explicit = timestampNumber(run.startedAt);
	if (explicit !== undefined) return explicit;
	const finishedAt = timestampNumber(run.finishedAt ?? run.ts);
	const latencyMs = finiteNumber(run.latencyMs);
	return finishedAt !== undefined && latencyMs !== undefined ? Math.max(0, finishedAt - latencyMs) : undefined;
}

function readFinishedAt(run: Record<string, any>): number | undefined {
	return timestampNumber(run.finishedAt ?? run.ts);
}

function readLatency(run: Record<string, any>): number {
	const explicit = finiteNumber(run.latencyMs ?? run.outcome?.latencyMs);
	if (explicit !== undefined) return Math.max(0, explicit);
	const startedAt = readStartedAt(run);
	const finishedAt = readFinishedAt(run);
	return startedAt !== undefined && finishedAt !== undefined ? Math.max(0, finishedAt - startedAt) : 0;
}

function aggregateLatency(runs: Record<string, any>[]): number {
	const starts = runs.map(readStartedAt).filter((value): value is number => value !== undefined);
	const finishes = runs.map(readFinishedAt).filter((value): value is number => value !== undefined);
	if (starts.length === runs.length && finishes.length === runs.length && runs.length > 0) {
		return Math.max(0, Math.max(...finishes) - Math.min(...starts));
	}
	return runs.reduce((sum, run) => sum + readLatency(run), 0);
}

function aggregateFailureStatus(runs: Record<string, any>[]): TelemetryOutcomeStatus {
	const statuses = runs.map(run => String(run.outcome?.status ?? run.status ?? "").toLowerCase());
	if (statuses.some(status => status === "timeout" || status === "timed_out")) return "timeout";
	if (statuses.some(status => status === "cancelled" || status === "canceled")) return "cancelled";
	return "failure";
}

function collectEvidence(decision: Record<string, any>, runs: Record<string, any>[]): TelemetryEvidence[] | undefined {
	const evidence = [decision, ...runs]
		.flatMap(event => [event.evidence, event.outcome?.evidence])
		.filter(Array.isArray)
		.flat()
		.filter(item => item && typeof item === "object") as TelemetryEvidence[];
	return evidence.length > 0 ? evidence : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampNumber(value: unknown): number | undefined {
	const numeric = finiteNumber(value);
	if (numeric !== undefined) return numeric;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function minTimestamp(values: Array<number | undefined>): number | undefined {
	const present = values.filter((value): value is number => value !== undefined);
	return present.length > 0 ? Math.min(...present) : undefined;
}

function maxTimestamp(values: Array<number | undefined>): number | undefined {
	const present = values.filter((value): value is number => value !== undefined);
	return present.length > 0 ? Math.max(...present) : undefined;
}

function average(values: number[]): number {
	return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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
