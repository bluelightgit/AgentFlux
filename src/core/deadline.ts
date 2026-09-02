/** 可选的模型执行 deadline；undefined/null 表示不设置硬 wall-clock 限制。 */
export type OptionalDurationMs = number | null | undefined;

/**
 * 规范化一个可选的正数时长。
 * 0、负数、NaN 和 Infinity 均拒绝，避免把“没有 deadline”和“立即超时”混为一谈。
 */
export function normalizeOptionalDurationMs(value: OptionalDurationMs, name = "deadline"): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be undefined/null or a positive finite number`);
	}
	return Math.max(1, value);
}

/** 将可选的秒数配置转换为毫秒。 */
export function normalizeOptionalSeconds(value: number | null | undefined, name = "deadline seconds"): number | undefined {
	const seconds = normalizeOptionalDurationMs(value, name);
	if (seconds === undefined) return undefined;
	const milliseconds = seconds * 1000;
	if (!Number.isFinite(milliseconds)) throw new Error(`${name} is too large to represent in milliseconds`);
	return milliseconds;
}

/** 从开始时间和可选时长计算绝对 deadline。 */
export function deadlineFrom(startMs: number, durationMs: OptionalDurationMs): number | undefined {
	const normalized = normalizeOptionalDurationMs(durationMs);
	return normalized === undefined ? undefined : startMs + normalized;
}

/** 返回距绝对 deadline 的剩余时长；没有 deadline 时返回 undefined。 */
export function remainingDuration(deadlineMs: number | null | undefined, nowMs = Date.now()): number | undefined {
	return deadlineMs == null ? undefined : Math.max(0, deadlineMs - nowMs);
}
