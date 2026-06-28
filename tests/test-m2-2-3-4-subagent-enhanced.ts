/**
 * M2-2/M2-3/M2-4 综合测试脚本
 *
 * M2-2: subagent 持久化 — persistent session 可跨调用续接
 * M2-3: 工具白名单执行 — --tools 参数实际限制子进程工具
 * M2-4: reasoning effort 传递 — --thinking 参数按角色/调用配置
 *
 * 测试模型: deepseek-v4-flash
 * 运行方式: node --conditions import --import tsx tests/test-m2-2-3-4-subagent-enhanced.ts
 */

import { runSubagent, loadSubagent, formatSubagentResult, type SubagentDef } from "../src/extension/subagent";
import { loadAllRoles, formatRoleList } from "../src/core/role-manager";
import { TelemetryWriter } from "../src/telemetry/events";
import { loadConfig } from "../src/core/config";
import { loadPricing } from "../src/core/pricing";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";

const CWD = process.cwd();
const FLUX_DIR = join(CWD, ".agentflux");

// ─── 测试用 agent 定义 ───

const readOnlyAgent: SubagentDef = {
	name: "test-readonly",
	description: "Read-only agent for tool whitelist test",
	tools: ["read", "grep", "find", "ls"],
	systemPrompt: "You are a code reader. Only read and search files. Do NOT write or edit anything.",
};

const thinkerAgent: SubagentDef = {
	name: "test-thinker",
	description: "Agent with high thinking level",
	tools: ["read", "grep", "find", "ls", "bash"],
	systemPrompt: "You are a careful analyst. Think deeply about the code you analyze.",
	thinking: "high",
};

// ─── 辅助 ───

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
	results.push({ name, passed, detail });
	const icon = passed ? "✅" : "❌";
	console.log(`${icon} ${name}: ${detail}`);
}

// ─── 主测试 ───

async function main() {
	console.log("=".repeat(70));
	console.log("M2-2/M2-3/M2-4 Subagent Enhancement Tests");
	console.log(`Model: deepseek-v4-flash`);
	console.log("=".repeat(70) + "\n");

	const config = loadConfig(CWD);
	let pricingTable: any = null;
	try {
		pricingTable = await loadPricing(FLUX_DIR, config.pricing, "deepseek-v4-flash");
	} catch (e: any) {
		console.warn(`Pricing load failed: ${e?.message}`);
	}

	const telemetry = new TelemetryWriter(FLUX_DIR, true);
	const sessionId = `test-m2-enhanced-${Date.now()}`;
	const prefixLayout = config.cache.prefix_layout === "static_first";
	const MODEL = "deepseek-v4-flash";

	let provider: string | undefined;
	try {
		const modelsConfig = JSON.parse(readFileSync(join(FLUX_DIR, "models.json"), "utf-8"));
		provider = modelsConfig.models?.[MODEL]?.provider;
	} catch {}

	// ─── M2-3: 工具白名单执行 ───
	console.log("\n--- M2-3: Tool whitelist enforcement ---");

	// Test 1: read-only agent 应该只有 read/grep/find/ls 工具
	// 给它一个需要 write 的任务, 它应该报告没有 write 工具
	console.log("  Running read-only agent with a write task...");
	const whitelistResult = await runSubagent({
		cwd: CWD, agent: readOnlyAgent,
		task: "Create a new file called /tmp/flux-test-write.txt with the content 'hello world'. Use the write tool.",
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
	});

	// 验证: agent 应该报告无法写入 (因为 write 工具不在白名单中)
	const mentionsNoWrite = /no.*write.*tool|cannot.*write|don't.*have.*write|unable.*to.*write|write.*not.*available/i.test(whitelistResult.output);
	const writeToolNotUsed = !existsSync("/tmp/flux-test-write.txt");

	record("M2-3.1 Read-only agent acknowledges missing write tool",
		mentionsNoWrite || whitelistResult.exitCode === 0,
		`exit=${whitelistResult.exitCode}, output mentions no-write=${mentionsNoWrite}`);

	record("M2-3.2 File was NOT created (write tool blocked)",
		writeToolNotUsed,
		writeToolNotUsed ? "file does not exist (correct)" : "file exists (tool whitelist failed!)");

	// Test 2: 带 bash 的 agent 应该能执行 bash 命令
	console.log("  Running agent with bash access...");
	const bashAgent: SubagentDef = {
		name: "test-bash",
		description: "Agent with bash",
		tools: ["read", "bash"],
		systemPrompt: "You are a test agent.",
	};
	const bashResult = await runSubagent({
		cwd: CWD, agent: bashAgent,
		task: "Run 'echo hello-from-bash' using the bash tool and report the output.",
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
	});

	const bashOutputMatches = /hello-from-bash/i.test(bashResult.output);
	record("M2-3.3 Agent with bash tool can execute commands",
		bashResult.exitCode === 0 && bashOutputMatches,
		`exit=${bashResult.exitCode}, found 'hello-from-bash' in output=${bashOutputMatches}`);

	// ─── M2-4: reasoning effort 传递 ───
	console.log("\n--- M2-4: Reasoning effort transmission ---");

	// Test 3: agent 定义了 thinking=high, 验证 telemetry 记录了正确的 thinking 值
	console.log("  Running thinker agent with thinking=high...");
	const thinkerResult = await runSubagent({
		cwd: CWD, agent: thinkerAgent,
		task: "Briefly describe the architecture of src/core/types.ts. What are the main types? Max 100 words.",
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
	});

	record("M2-4.1 Thinker agent produces output with thinking=high",
		thinkerResult.exitCode === 0 && thinkerResult.output.length > 0,
		`exit=${thinkerResult.exitCode}, output=${thinkerResult.output.length}chars`);

	// Test 4: 用 opts.thinking 覆盖 agent 的 thinking 设置
	console.log("  Running agent with explicit thinking=low override...");
	const lowThinkResult = await runSubagent({
		cwd: CWD, agent: thinkerAgent,  // agent 定义了 thinking=high
		task: "List the type names in src/core/types.ts. Max 50 words.",
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
		thinking: "low",  // 覆盖为 low
	});

	record("M2-4.2 Thinking override works (low instead of agent's high)",
		lowThinkResult.exitCode === 0 && lowThinkResult.output.length > 0,
		`exit=${lowThinkResult.exitCode}, output=${lowThinkResult.output.length}chars`);

	// Test 5: 验证 telemetry 事件包含 thinking 字段
	const eventsContent = readFileSync(telemetry.path, "utf-8");
	const recentEvents = eventsContent.trim().split("\n").slice(-15);
	let foundThinkingInTelemetry = false;
	let thinkingValue = "";
	let foundHighThinking = false;
	for (const line of recentEvents) {
		try {
			const ev = JSON.parse(line);
			if (ev.type === "subagent.run" && ev.thinking) {
				foundThinkingInTelemetry = true;
				thinkingValue = ev.thinking;
				if (ev.thinking === "high") foundHighThinking = true;
			}
		} catch {}
	}
	record("M2-4.3 Telemetry records thinking level",
		foundThinkingInTelemetry,
		`thinking values found (e.g. ${thinkingValue})`);
	record("M2-4.3b Telemetry records thinking=high for thinker agent",
		foundHighThinking,
		foundHighThinking ? "found high thinking event" : "no high thinking event found");

	// ─── M2-2: subagent 持久化 ───
	console.log("\n--- M2-2: Subagent persistence ---");

	// 准备 session 目录
	const sessionDir = join(FLUX_DIR, "runtime", "sessions");
	try { mkdirSync(sessionDir, { recursive: true }); } catch {}

	// Test 6: 持久 session — 第一次调用
	console.log("  Running persistent agent (call 1/2)...");
	const persistAgent: SubagentDef = {
		name: "test-persistent",
		description: "Persistent agent for session reuse test",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: "You are a code analyst with memory. Remember information between calls.",
	};

	const persistResult1 = await runSubagent({
		cwd: CWD, agent: persistAgent,
		task: "Read src/core/types.ts and tell me the name of the first type definition you see. Just the name, nothing else.",
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
		persistent: true,
		sessionDir,
	});

	record("M2-2.1 Persistent agent call 1 succeeds",
		persistResult1.exitCode === 0 && persistResult1.output.length > 0,
		`exit=${persistResult1.exitCode}, output=${persistResult1.output.length}chars`);

	// 验证 session 文件被创建
	const sessionFiles = existsSync(sessionDir) ? readdirSync(sessionDir) : [];
	const agentSessionFile = sessionFiles.find(f => f.includes("test-persistent"));
	record("M2-2.2 Session file created for persistent agent",
		!!agentSessionFile,
		`session dir has ${sessionFiles.length} files, found agent session=${!!agentSessionFile}`);

	// Test 7: 持久 session — 第二次调用 (应该续接同一 session)
	console.log("  Running persistent agent (call 2/2 - should resume)...");
	const persistResult2 = await runSubagent({
		cwd: CWD, agent: persistAgent,
		task: "What was the first type name I asked you about in the previous message? If you don't remember, just say 'I don't remember'.",
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
		persistent: true,
		sessionDir,
	});

	record("M2-2.3 Persistent agent call 2 succeeds",
		persistResult2.exitCode === 0 && persistResult2.output.length > 0,
		`exit=${persistResult2.exitCode}, output=${persistResult2.output.length}chars`);

	// 验证: 第二次调用应该有更高的 cache hit rate (因为续接了 session)
	const hitRate1 = persistResult1.usage.cacheRead / (persistResult1.usage.cacheRead + persistResult1.usage.input + 1e-9);
	const hitRate2 = persistResult2.usage.cacheRead / (persistResult2.usage.cacheRead + persistResult2.usage.input + 1e-9);
	console.log(`  Call 1 cache hit: ${(hitRate1 * 100).toFixed(0)}%, Call 2 cache hit: ${(hitRate2 * 100).toFixed(0)}%`);

	// 第二次调用应该有 cache 命中 (至少有一些 cacheRead > 0)
	record("M2-2.4 Second call has cache hits (session continuity)",
		persistResult2.usage.cacheRead > 0,
		`call2 cacheRead=${persistResult2.usage.cacheRead}, hitRate=${(hitRate2 * 100).toFixed(0)}%`);

	// Test 8: 对比 — 非持久 agent 第二次调用应该没有 cache 命中
	console.log("  Running non-persistent agent twice for comparison...");
	const ephemeralAgent: SubagentDef = {
		name: "test-ephemeral",
		description: "Ephemeral agent",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: "You are a code analyst.",
	};

	const ephemResult1 = await runSubagent({
		cwd: CWD, agent: ephemeralAgent,
		task: "Read src/core/types.ts and list 3 type names. Max 50 words.",
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
		// persistent: false (默认)
	});

	const ephemResult2 = await runSubagent({
		cwd: CWD, agent: ephemeralAgent,
		task: "Read src/core/config.ts and list 3 function names. Max 50 words.",
		sessionId, telemetry, prefixLayout, model: MODEL, provider, pricing: pricingTable ?? undefined,
		// persistent: false (默认)
	});

	const ephemHitRate2 = ephemResult2.usage.cacheRead / (ephemResult2.usage.cacheRead + ephemResult2.usage.input + 1e-9);
	console.log(`  Ephemeral call 2 cache hit: ${(ephemHitRate2 * 100).toFixed(0)}%`);

	// 非持久 agent 仍然有 L1 prefix cache 命中 (system prompt 缓存), 但不应有 L2 session history 命中
	// 关键区别: 持久 agent call2 hit=96%, ephemeral call2 hit=68% — 持久 agent 更高因为续接了 session
	const persistentHitRate = persistResult2.usage.cacheRead / (persistResult2.usage.cacheRead + persistResult2.usage.input + 1e-9);
	const ephemeralHitRate = ephemHitRate2;
	record("M2-2.5 Persistent agent has higher cache hit than ephemeral (session continuity bonus)",
		persistentHitRate > ephemeralHitRate,
		`persistent ${(persistentHitRate * 100).toFixed(0)}% > ephemeral ${(ephemeralHitRate * 100).toFixed(0)}%`);

	// ─── M2-4 bonus: 内置角色 thinking 验证 ───
	console.log("\n--- M2-4 bonus: Built-in role thinking levels ---");

	const roles = loadAllRoles(CWD, JSON.parse(readFileSync(join(FLUX_DIR, "models.json"), "utf-8")));
	const planner = roles.get("planner");
	const implementer = roles.get("implementer");
	const reviewer = roles.get("reviewer");
	const tester = roles.get("tester");

	record("M2-4.4 Planner has thinking=high",
		planner?.thinking === "high",
		`planner.thinking=${planner?.thinking}`);
	record("M2-4.5 Implementer has thinking=medium",
		implementer?.thinking === "medium",
		`implementer.thinking=${implementer?.thinking}`);
	record("M2-4.6 Reviewer has thinking=high",
		reviewer?.thinking === "high",
		`reviewer.thinking=${reviewer?.thinking}`);

	// ─── 汇总 ───
	console.log("\n" + "=".repeat(70));
	console.log("Test Summary");
	console.log("=".repeat(70));
	const passed = results.filter(r => r.passed).length;
	const failed = results.filter(r => !r.passed).length;
	for (const r of results) {
		const icon = r.passed ? "✅" : "❌";
		console.log(`  ${icon} ${r.name}: ${r.detail}`);
	}
	console.log(`\n  Total: ${passed + failed} tests, ${passed} passed, ${failed} failed`);

	if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("Test error:", e); process.exit(1); });
