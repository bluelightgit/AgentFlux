/**
 * Desktop 数据管线验证脚本
 * 直接在 Node 中测试 events-parser + data-aggregator
 * 无需启动 Electron
 */
import { parseEventsFile, filterByType, filterByTimeRange } from "../src/lib/events-parser";
import { aggregateSummary, aggregateRouteHistory, aggregateCacheTrend, aggregateTokenBreakdown, aggregateCostAnalysis, aggregateAgentTimeline } from "../src/lib/data-aggregator";

const eventsPath = "E:/agent-projects/AgentFlux/.agentflux/events.jsonl";
console.log("=== Desktop Data Pipeline Test ===\n");
console.log("Events file:", eventsPath);

const events = await parseEventsFile(eventsPath);
console.log("Total events parsed:", events.length);

const types = events.reduce((acc, e) => { acc[e.type] = (acc[e.type] ?? 0) + 1; return acc; }, {} as Record<string, number>);
console.log("Event types:", JSON.stringify(types));

console.log("\n=== Summary ===");
const summary = aggregateSummary(events);
console.log("Total cost:", `$${summary.totalCost.toFixed(6)}`);
console.log("Avg cache hit:", `${(summary.avgCacheHit * 100).toFixed(1)}%`);
console.log("Routing decisions:", summary.routingDecisions);
console.log("Subagent runs:", summary.subagentRuns);
console.log("Cache samples:", summary.cacheSamples);

console.log("\n=== Route History (all) ===");
const routes = aggregateRouteHistory(events, "all");
console.log("Route points:", routes.length);
for (const r of routes.slice(0, 5)) {
  console.log(`  ${new Date(r.ts).toLocaleTimeString()} ${r.mode} conf=${(r.confidence * 100).toFixed(0)}% preset=${r.preset}`);
}

console.log("\n=== Cache Trend (24h) ===");
const cache = aggregateCacheTrend(events, "24h");
console.log("Cache points:", cache.length);
for (const c of cache.slice(-5)) {
  console.log(`  turn ${c.turnIndex} hit=${(c.hitRate * 100).toFixed(0)}% cost=$${c.cost.toFixed(6)} ctx=${(c.contextPercent * 100).toFixed(2)}%`);
}

console.log("\n=== Token Breakdown (24h) ===");
const tokens = aggregateTokenBreakdown(events, "24h");
for (const t of tokens) {
  console.log(`  ${t.name}: ${t.value > 1000 ? (t.value / 1000).toFixed(1) + "k" : t.value}`);
}

console.log("\n=== Cost Analysis (all) ===");
const costs = aggregateCostAnalysis(events, "all");
console.log("Total cost:", `$${costs.total.toFixed(6)}`);
console.log("Avg per turn:", `$${costs.avgPerTurn.toFixed(6)}`);
console.log("By mode:");
for (const m of costs.byMode) console.log(`  ${m.mode}: $${m.cost.toFixed(6)}`);
console.log("By model:");
for (const m of costs.byModel) console.log(`  ${m.model}: $${m.cost.toFixed(6)}`);

console.log("\n=== Agent Timeline (all) ===");
const agents = aggregateAgentTimeline(events, "all");
console.log("Agent runs:", agents.length);
for (const a of agents.slice(-5)) {
  console.log(`  ${new Date(a.ts).toLocaleTimeString()} ${a.agent} turns=${a.turns} cost=$${a.cost.toFixed(6)} exit=${a.exitCode}${a.retryCount ? ` retries=${a.retryCount}` : ""}`);
}

console.log("\n=== Time Range Filter Test ===");
const h1 = filterByTimeRange(events, "1h").length;
const h24 = filterByTimeRange(events, "24h").length;
const d7 = filterByTimeRange(events, "7d").length;
const all = filterByTimeRange(events, "all").length;
console.log(`1h=${h1} 24h=${h24} 7d=${d7} all=${all}`);

console.log("\n✅ All data pipeline tests passed");
