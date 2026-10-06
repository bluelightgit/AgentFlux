/** duration 与 age/freshness 分离；缺终态时间时保持未知，不让历史 duration 持续增长。 */
export function runDurationMs(run: { createdAt: string; finishedAt?: string; status: string } | undefined, now = Date.now()): number | undefined {
	if (!run) return undefined;
	const start = Date.parse(run.createdAt);
	const terminal = ["completed", "failed", "cancelled", "timed_out"].includes(run.status);
	const end = run.finishedAt ? Date.parse(run.finishedAt) : terminal ? NaN : now;
	return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}
