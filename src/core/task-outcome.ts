export interface InvocationOutcome {
	action: "completed" | "failed" | "cancelled";
	status: "success" | "failure" | "cancelled" | "timeout";
	error?: string;
	costUsd?: number;
	costComplete?: boolean;
	attributionComplete?: boolean;
}

export function agentInvocationOutcome(result: { exitCode: number; errorMessage?: string; timedOut?: boolean; usage: { cost: number }; costAccounting?: { complete: boolean; attributionComplete?: boolean } }, aborted = false): InvocationOutcome {
	const status = aborted || result.exitCode === 130 ? "cancelled"
		: result.timedOut ? "timeout" : result.exitCode !== 0 || result.errorMessage ? "failure" : "success";
	return { status, action: status === "success" ? "completed" : status === "cancelled" ? "cancelled" : "failed", costUsd: result.usage.cost,
		costComplete: result.costAccounting?.complete === true, attributionComplete: result.costAccounting?.attributionComplete === true,
		error: status === "success" ? undefined : result.errorMessage ?? `Agent ${status} (exit ${result.exitCode})` };
}

/** 顺序无关的父执行收敛规则；成功不能覆盖任何失败，费用只相加、不取最后值或最大值。 */
export function aggregateInvocationOutcomes(outcomes: readonly InvocationOutcome[]): InvocationOutcome {
	const priority = { success: 0, failure: 1, timeout: 2, cancelled: 3 } as const;
	for (const item of outcomes) {
		if (!item || !["success", "failure", "timeout", "cancelled"].includes(item.status)
			|| item.action !== (item.status === "success" ? "completed" : item.status === "cancelled" ? "cancelled" : "failed")
			|| (item.costUsd !== undefined && (!Number.isFinite(item.costUsd) || item.costUsd < 0))
			|| (item.costComplete !== undefined && typeof item.costComplete !== "boolean")
			|| (item.attributionComplete !== undefined && typeof item.attributionComplete !== "boolean")
			|| (item.error !== undefined && typeof item.error !== "string")) throw new Error("Invalid invocation outcome; refusing to infer success");
	}
	const status = outcomes.reduce<InvocationOutcome["status"]>((s, item) => priority[item.status] > priority[s] ? item.status : s, "success");
	const errors = [...new Set(outcomes.flatMap(item => item.error ? [item.error] : []))].sort();
	return {
		action: status === "success" ? "completed" : status === "cancelled" ? "cancelled" : "failed",
		status,
		error: errors.length ? errors.join("; ") : undefined,
		costUsd: outcomes.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
		costComplete: outcomes.every(item => item.costUsd !== undefined && item.costComplete === true),
		attributionComplete: outcomes.every(item => item.attributionComplete === true),
	};
}
