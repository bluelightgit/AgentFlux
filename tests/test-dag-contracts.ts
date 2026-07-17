import { boundedNodeTimeout, parsePlannerTaskDAG, selectHealthyModel, validateTaskDAG, type TaskNode } from "../src/extension/dag-executor";

const node = (id: string, dependsOn: string[] = []): TaskNode => ({
	id, title: id, role: "implementer", dependsOn, parallelizable: false,
	acceptanceCriteria: [], files: [], description: id,
});
const checks: Array<[string, boolean, string]> = [];
const check = (name: string, passed: boolean, detail: string) => {
	checks.push([name, passed, detail]);
	console.log(`${passed ? "✅" : "❌"} ${name}: ${detail}`);
};
const throws = (nodes: TaskNode[], pattern: RegExp) => {
	try { validateTaskDAG(nodes); return false; }
	catch (error: any) { return pattern.test(error?.message ?? String(error)); }
};

try {
	validateTaskDAG([node("plan"), node("impl", ["plan"]), node("review", ["impl"])]);
	check("valid DAG accepted", true, "plan→impl→review");
} catch (error: any) { check("valid DAG accepted", false, error?.message ?? String(error)); }
check("duplicate ID rejected", throws([node("same"), node("same")], /duplicate/), "duplicate");
check("missing dependency rejected", throws([node("impl", ["missing"])], /missing/), "missing");
check("self dependency rejected", throws([node("self", ["self"])], /itself/), "self");
check("cycle rejected", throws([node("a", ["b"]), node("b", ["a"])], /cycle/), "a↔b");

const models = {
	strong: { provider: "broken", contextWindow: 128_000, capability: { coding: 0.9, reasoning: 0.9 } },
	backup: { provider: "healthy", contextWindow: 128_000, capability: { coding: 0.7, reasoning: 0.7 } },
};
check("healthy preferred model is preserved", selectHealthyModel("strong", { coding: 1 }, models, new Set()) === "strong", "strong");
check("circuit breaker skips unavailable model", selectHealthyModel("strong", { coding: 1 }, models, new Set(["strong"])) === "backup", "strong→backup");
let allUnavailableThrows = false;
try { selectHealthyModel("strong", { coding: 1 }, models, new Set(["strong", "backup"])); }
catch (error: unknown) { allUnavailableThrows = /all models unavailable/.test(error instanceof Error ? error.message : String(error)); }
check("circuit breaker fails closed when every model is unavailable", allUnavailableThrows, "all unavailable");

const repairedDag = parsePlannerTaskDAG(`\`\`\`json
{"description":"repair","nodes":[{"id":"t1","title":"fix","role":"implementer","dependsOn":[],"parallelizable":false,"acceptanceCriteria":["ok"],"files":["desktop\\src\\file.ts",],}],}
\`\`\``, "fallback", 0.01);
check("planner JSON repair handles Windows paths and trailing commas", repairedDag.nodes[0].files[0] === "desktop/src/file.ts" && repairedDag.planningCostUsd === 0.01, repairedDag.nodes[0].files[0]);
let unsafePlannerOutputRejected = false;
try { parsePlannerTaskDAG("not json", "fallback"); }
catch { unsafePlannerOutputRejected = true; }
check("planner repair remains fail-closed without JSON", unsafePlannerOutputRejected, "rejected");
check("node timeout is bounded by DAG global deadline", boundedNodeTimeout(600_000, 150_000, 100_000) === 50_000, `${boundedNodeTimeout(600_000, 150_000, 100_000)}ms`);

const failed = checks.filter(([, passed]) => !passed);
console.log(`\nDAG contracts: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) process.exit(1);
