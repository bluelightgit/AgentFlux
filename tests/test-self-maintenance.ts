/**
 * AgentFlux 自维护机制测试 — health-monitor + 4 个子命令
 */

import { getVersionInfo, checkHealth, formatHealthReport, scanRecentIssues, checkUpgrade, formatUpgradeInfo, formatStatusReport, formatIssues, type SubsystemStatus, type AgentInfo } from "../src/extension/health-monitor";
import { join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

const CWD = process.cwd();
const FLUX_DIR = join(CWD, ".agentflux");
const EVENTS_PATH = join(FLUX_DIR, "events.jsonl");

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`  ${icon} ${name}: ${detail}`);
}

async function main() {
	console.log("=".repeat(70));
	console.log("AgentFlux Self-Maintenance Test");
	console.log("=".repeat(70));

	// ═══════════════════════════════════════════
	// 1. getVersionInfo
	// ═══════════════════════════════════════════
	console.log("\n📦 1. Version Info\n");

	const vInfo = getVersionInfo(CWD);
	console.log(`  version=${vInfo.version}, commit=${vInfo.commit}, clean=${vInfo.clean}, branch=${vInfo.branch}`);
	console.log(`  files=${vInfo.fileCount}, lines=${vInfo.totalLines}`);

	record("getVersionInfo: returns version string",
		vInfo.version !== "unknown" && vInfo.version.length > 0,
		`version=${vInfo.version}`);
	record("getVersionInfo: returns git commit",
		vInfo.commit !== "unknown" && vInfo.commit.length >= 7,
		`commit=${vInfo.commit}`);
	record("getVersionInfo: returns clean status (may be dirty during test)",
		typeof vInfo.clean === "boolean",
		`clean=${vInfo.clean}`);
	record("getVersionInfo: returns branch name",
		vInfo.branch.length > 0,
		`branch=${vInfo.branch}`);
	record("getVersionInfo: counts source files",
		vInfo.fileCount > 20,
		`files=${vInfo.fileCount}`);
	record("getVersionInfo: counts source lines",
		vInfo.totalLines > 5000,
		`lines=${vInfo.totalLines}`);

	// ═══════════════════════════════════════════
	// 2. checkHealth
	// ═══════════════════════════════════════════
	console.log("\n🏥 2. Health Check\n");

	const health = checkHealth(CWD, FLUX_DIR);
	console.log(`  ${formatHealthReport(health)}`.split("\n").join("\n  "));

	record("checkHealth: returns 8 checks",
		health.checks.length === 8,
		`checks=${health.checks.length}`);
	record("checkHealth: Config check passes",
		health.checks[0].status === "ok",
		`status=${health.checks[0].status}`);
	record("checkHealth: models.json check passes",
		health.checks[1].status === "ok",
		`status=${health.checks[1].status}`);
	record("checkHealth: Telemetry check passes",
		health.checks[3].status === "ok",
		`status=${health.checks[3].status}`);
	record("checkHealth: Git check returns status (may warn during test)",
		health.checks[7].status === "ok" || health.checks[7].status === "warn",
		`status=${health.checks[7].status}`);
	record("checkHealth: okCount + warnCount + errorCount = total",
		health.okCount + health.warnCount + health.errorCount === 8,
		`ok=${health.okCount}, warn=${health.warnCount}, error=${health.errorCount}`);

	// Test with bad config
	const badFluxDir = join(CWD, ".agentflux-test-bad");
	try { rmSync(badFluxDir, { recursive: true }); } catch {}
	mkdirSync(badFluxDir, { recursive: true });
	writeFileSync(join(badFluxDir, "agentflux.json"), "{ invalid json }");
	writeFileSync(join(badFluxDir, "models.json"), "{ broken");
	const badHealth = checkHealth(CWD, badFluxDir);
	record("checkHealth: bad config → error status",
		badHealth.checks[0].status === "error",
		`status=${badHealth.checks[0].status}`);
	record("checkHealth: bad models.json → error status",
		badHealth.checks[1].status === "error",
		`status=${badHealth.checks[1].status}`);
	record("checkHealth: errorCount > 0 for bad config",
		badHealth.errorCount >= 2,
		`errors=${badHealth.errorCount}`);
	rmSync(badFluxDir, { recursive: true });

	// ═══════════════════════════════════════════
	// 3. scanRecentIssues
	// ═══════════════════════════════════════════
	console.log("\n🔍 3. Issue Scanner\n");

	// Test with real events
	const realIssues = scanRecentIssues(EVENTS_PATH, 50);
	record("scanRecentIssues: returns array (no crash on real data)",
		Array.isArray(realIssues),
		`issues=${realIssues.length}`);

	// Test with synthetic error data
	const testEventsPath = join(CWD, ".agentflux", "test-events-tmp.jsonl");
	const syntheticEvents: any[] = [];

	// Add 5 subagent failures
	for (let i = 0; i < 5; i++) {
		syntheticEvents.push({ type: "subagent.run", exitCode: 1, agent: `fail-agent-${i}`, costUsd: 0.001 });
	}
	// Add 2 success
	syntheticEvents.push({ type: "subagent.run", exitCode: 0, agent: "ok-agent", costUsd: 0.001 });
	syntheticEvents.push({ type: "subagent.run", exitCode: 0, agent: "ok-agent2", costUsd: 0.001 });

	// Add 5 low cache hit turns
	for (let i = 0; i < 5; i++) {
		syntheticEvents.push({ type: "cache.sample", cacheHitRate: 0.1, contextPercent: 30, turnIndex: i });
	}

	// Add 3 routing fallbacks out of 4
	for (let i = 0; i < 3; i++) {
		syntheticEvents.push({ type: "routing.decision", fallback: true, mode: "M2", confidence: 0.5 });
	}
	syntheticEvents.push({ type: "routing.decision", fallback: false, mode: "M3", confidence: 0.8 });

	// Add 3 high context turns
	for (let i = 0; i < 3; i++) {
		syntheticEvents.push({ type: "cache.sample", cacheHitRate: 0.9, contextPercent: 90, turnIndex: 100 + i });
	}

	writeFileSync(testEventsPath, syntheticEvents.map(e => JSON.stringify(e)).join("\n") + "\n");

	const synthIssues = scanRecentIssues(testEventsPath, 100);
	console.log(`  Synthetic issues found: ${synthIssues.length}`);
	for (const iss of synthIssues) {
		console.log(`    ${iss.severity} ${iss.category}: ${iss.message}`);
	}

	record("scanRecentIssues: detects subagent failures",
		synthIssues.some(i => i.category === "subagent_failure"),
		`found=${synthIssues.some(i => i.category === "subagent_failure")}`);
	record("scanRecentIssues: detects low cache hit",
		synthIssues.some(i => i.category === "low_cache"),
		`found=${synthIssues.some(i => i.category === "low_cache")}`);
	record("scanRecentIssues: detects routing fallback",
		synthIssues.some(i => i.category === "routing_fallback"),
		`found=${synthIssues.some(i => i.category === "routing_fallback")}`);
	record("scanRecentIssues: detects high context",
		synthIssues.some(i => i.category === "high_context"),
		`found=${synthIssues.some(i => i.category === "high_context")}`);

	// Test with clean data (no issues)
	const cleanEvents: any[] = [];
	for (let i = 0; i < 10; i++) {
		syntheticEvents.push({ type: "subagent.run", exitCode: 0, agent: `ok-${i}`, costUsd: 0.001 });
		syntheticEvents.push({ type: "cache.sample", cacheHitRate: 0.85, contextPercent: 20, turnIndex: i });
	}
	writeFileSync(testEventsPath, cleanEvents.map(e => JSON.stringify(e)).join("\n") + "\n");
	const cleanIssues = scanRecentIssues(testEventsPath, 20);
	record("scanRecentIssues: clean data → no issues",
		cleanIssues.length === 0,
		`issues=${cleanIssues.length}`);

	// Test with non-existent file
	const noFileIssues = scanRecentIssues("/nonexistent/path.jsonl", 20);
	record("scanRecentIssues: non-existent file → empty array (no crash)",
		noFileIssues.length === 0,
		`issues=${noFileIssues.length}`);

	rmSync(testEventsPath);

	// ═══════════════════════════════════════════
	// 4. checkUpgrade
	// ═══════════════════════════════════════════
	console.log("\n🔄 4. Upgrade Check\n");

	const upgrade = checkUpgrade(CWD);
	console.log(`  ${formatUpgradeInfo(upgrade)}`.split("\n").join("\n  "));

	record("checkUpgrade: returns current commit",
		upgrade.currentCommit !== "unknown" && upgrade.currentCommit.length >= 7,
		`commit=${upgrade.currentCommit}`);
	record("checkUpgrade: returns current message",
		upgrade.currentMessage.length > 0,
		`msg=${upgrade.currentMessage.slice(0, 40)}...`);
	record("checkUpgrade: returns branch name",
		upgrade.currentBranch.length > 0,
		`branch=${upgrade.currentBranch}`);
	record("checkUpgrade: returns hasRemote boolean",
		typeof upgrade.hasRemote === "boolean",
		`hasRemote=${upgrade.hasRemote}`);
	record("checkUpgrade: returns upToDate boolean",
		typeof upgrade.upToDate === "boolean",
		`upToDate=${upgrade.upToDate}`);
	record("checkUpgrade: returns recommendation string",
		upgrade.recommendation.length > 0,
		`rec=${upgrade.recommendation.slice(0, 40)}...`);

	// ═══════════════════════════════════════════
	// 5. formatHealthReport
	// ═══════════════════════════════════════════
	console.log("\n📝 5. Format Output\n");

	const healthText = formatHealthReport(health);
	record("formatHealthReport: produces multi-line text",
		healthText.length > 100 && healthText.includes("Health Check"),
		`length=${healthText.length}`);
	record("formatHealthReport: includes all check names",
		healthText.includes("Config") && healthText.includes("Telemetry") && healthText.includes("Git"),
		`has Config, Telemetry, Git`);
	record("formatHealthReport: includes result line",
		healthText.includes("Result:"),
		`has Result line`);

	// ═══════════════════════════════════════════
	// 6. formatStatusReport
	// ═══════════════════════════════════════════
	const subsystems: SubsystemStatus[] = health.checks.map(c => ({
		name: c.name, healthy: c.status === "ok", detail: c.detail,
	}));
	const activeAgents: AgentInfo[] = [];
	const issues = scanRecentIssues(EVENTS_PATH, 20);

	const statusText = formatStatusReport(vInfo, {
		mode: "M2", preset: "balanced", stage: "Growth", role: "doer+reviewer",
		turnIndex: 15, cacheHitRate: 0.87, costUsd: 0.0234, branch: "main",
	}, subsystems, activeAgents, issues, {
		fluxDir: FLUX_DIR, eventsPath: EVENTS_PATH, configPath: join(FLUX_DIR, "agentflux.json"),
	});

	record("formatStatusReport: produces multi-line text",
		statusText.length > 200 && statusText.includes("Status"),
		`length=${statusText.length}`);
	record("formatStatusReport: includes version info",
		statusText.includes(vInfo.version) && statusText.includes(vInfo.commit),
		`has version + commit`);
	record("formatStatusReport: includes mode info",
		statusText.includes("M2") && statusText.includes("balanced"),
		`has mode + preset`);
	record("formatStatusReport: includes subsystems section",
		statusText.includes("Subsystems:"),
		`has Subsystems section`);
	record("formatStatusReport: includes Active Agents section",
		statusText.includes("Active Agents:"),
		`has Active Agents section`);
	record("formatStatusReport: includes Recent Issues section",
		statusText.includes("Recent Issues:"),
		`has Recent Issues section`);
	record("formatStatusReport: includes Paths section",
		statusText.includes("Paths:") && statusText.includes(FLUX_DIR),
		`has Paths section`);

	// ═══════════════════════════════════════════
	// 7. formatIssues
	// ═══════════════════════════════════════════
	const issuesText = formatIssues(synthIssues);
	record("formatIssues: non-empty for issues",
		issuesText.length > 0,
		`length=${issuesText.length}`);
	record("formatIssues: empty for no issues",
		formatIssues([]) === "",
		`empty string for no issues`);

	// ═══════════════════════════════════════════
	// 8. formatUpgradeInfo
	// ═══════════════════════════════════════════
	const upgradeText = formatUpgradeInfo(upgrade);
	record("formatUpgradeInfo: produces multi-line text",
		upgradeText.length > 50 && upgradeText.includes("Upgrade"),
		`length=${upgradeText.length}`);
	record("formatUpgradeInfo: includes current commit",
		upgradeText.includes(upgrade.currentCommit),
		`has current commit`);

	// ═══════════════════════════════════════════
	// 汇总
	// ═══════════════════════════════════════════
	console.log("\n" + "=".repeat(70));
	console.log("Self-Maintenance Test Summary");
	console.log("=".repeat(70));

	const passed = results.filter(r => r.passed).length;
	const failed = results.filter(r => !r.passed).length;

	for (const r of results) {
		const icon = r.passed ? "✅" : "❌";
		console.log(`  ${icon} ${r.name}: ${r.detail}`);
	}

	console.log(`\n  Total: ${passed + failed} tests, ${passed} passed, ${failed} failed`);

	if (failed > 0) {
		console.log("\n  ❌ FAILED TESTS:");
		for (const r of results.filter(r => !r.passed)) {
			console.log(`    ${r.name}`);
		}
		process.exit(1);
	} else {
		console.log("\n  ✅ ALL TESTS PASSED");
	}
}

main().catch(e => { console.error("Test error:", e); process.exit(1); });
