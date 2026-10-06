import { analyzeCompaction, registerCompactionAdvisor } from "../src/extension/compaction-advisor";

const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: string) {
	checks.push({ name, passed, detail });
	console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

async function main() {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const records: any[] = [];
	const pi = { on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); } } as any;
	const telemetry = {
		writeContextEvent(event: unknown) { records.push(event); },
	} as any;
	registerCompactionAdvisor(pi, () => ({ sessionId: "session-1", telemetry }));

	const ctx = {
		getContextUsage: () => ({ percent: 72, tokens: 720, contextWindow: 1000 }),
		sessionManager: { getBranch: () => [] },
	};
	const before = await handlers.get("session_before_compact")?.({ reason: "overflow", willRetry: true }, ctx);
	const success = await handlers.get("session_compact")?.({ reason: "overflow", willRetry: true }, ctx);
	const failed = await handlers.get("session_compact_failed")?.({
		reason: "overflow", willRetry: true, errorMessage: "summary provider failed", aborted: false, fromExtension: false,
	}, ctx);
	check("advisor never replaces native compaction", before === undefined && success === undefined && failed === undefined, "all native hooks are observational");
	check("native reason and retry intent are recorded", records.some(item => String(item.detail).includes('"reason":"overflow"') && String(item.detail).includes('"willRetry":true')), JSON.stringify(records));
	check("native compaction failure is recorded", records.some(item => String(item.detail).includes("session_compact_failed") && String(item.detail).includes("summary provider failed")), JSON.stringify(records));
	check("advice keeps context percentage normalized", analyzeCompaction(ctx).contextPercent === 0.72 && analyzeCompaction(ctx).reason.includes("72.0%"), analyzeCompaction(ctx).reason);

	const failedChecks = checks.filter(item => !item.passed);
	console.log(`\nCompaction advisor: ${checks.length - failedChecks.length}/${checks.length} passed`);
	if (failedChecks.length > 0) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
