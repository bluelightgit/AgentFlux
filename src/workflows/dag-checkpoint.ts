import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePathInsideExistingRoot } from "../core/safe-path";
import type { TaskDAG, TaskExecutionResult } from "./dag-executor";

function canonical(value: any): any {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
	return value;
}
export function dagFingerprint(dag: TaskDAG): string {
	// 节点排列不是语义；节点内容、依赖、角色和 acceptance 均进入指纹。
	return createHash("sha256").update(JSON.stringify(canonical({ description: dag.description, invocationTask: dag.invocationTask, nodes: [...dag.nodes].sort((a, b) => a.id.localeCompare(b.id)) }))).digest("hex");
}
export function artifactHash(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
export interface DAGCheckpoint {
	version: 1;
	executionId: string;
	resumedFromExecutionId?: string;
	dagFingerprint: string;
	nodeIds: string[];
	completed: string[];
	failed: string[];
	status: string;
	totalCost: number;
	inheritedCostUsd: number;
	attemptCostUsd: number;
	iterationCount: number;
	taskResults: Array<[string, TaskExecutionResult]>;
	artifactPaths: Record<string, string>;
	artifactHashes: Record<string, string>;
}

/** 完整校验后才能跳过节点；无版本的旧快照缺少证明，须显式拒绝。 */
export function validateDAGCheckpoint(value: unknown, dag: TaskDAG, executionId: string, sourceDir: string, requireQualityGate = false): DAGCheckpoint {
	const fail = (reason: string): never => { throw new Error(`checkpoint ${executionId} is invalid and was not overwritten: ${reason}`); };
	const cp = value as DAGCheckpoint;
	const numeric = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
	const ids = new Set(dag.nodes.map(node => node.id));
	const nodeList = (v: unknown): v is string[] => Array.isArray(v) && new Set(v).size === v.length && v.every(id => typeof id === "string" && ids.has(id));
	if (!cp || cp.version !== 1 || cp.executionId !== executionId) fail("schema/version/identity");
	if (cp.dagFingerprint !== dagFingerprint(dag)) fail("DAG fingerprint differs");
	if (!nodeList(cp.nodeIds) || cp.nodeIds.length !== ids.size || !nodeList(cp.completed) || !nodeList(cp.failed)) fail("node sets");
	if (cp.completed.some(id => cp.failed.includes(id))) fail("completed/failed overlap");
	if (!["running", "passed", "failed", "cancelled", "budget_exceeded", "timed_out"].includes(cp.status)) fail("status");
	if (![cp.totalCost, cp.inheritedCostUsd, cp.attemptCostUsd].every(numeric)
		|| Math.abs(cp.totalCost - cp.inheritedCostUsd - cp.attemptCostUsd) > 1e-8
		|| !Number.isInteger(cp.iterationCount) || cp.iterationCount < 0) fail("cost/iterations");
	if (!Array.isArray(cp.taskResults) || !cp.artifactPaths || !cp.artifactHashes
		|| typeof cp.artifactPaths !== "object" || typeof cp.artifactHashes !== "object" || Array.isArray(cp.artifactPaths) || Array.isArray(cp.artifactHashes)) fail("results/artifacts");
	const results = new Map<string, TaskExecutionResult>();
	for (const entry of cp.taskResults) {
		if (!Array.isArray(entry) || entry.length !== 2) fail("result tuple");
		const [id, result] = entry;
		if (!ids.has(id) || results.has(id) || !result || result.node?.id !== id) fail("result node identity");
		if (JSON.stringify(canonical(result.node)) !== JSON.stringify(canonical(dag.nodes.find(node => node.id === id)))) fail("result node content");
		const sub = result.subagentResult;
		if (typeof result.passed !== "boolean" || !Number.isInteger(result.retryCount) || result.retryCount < 0
			|| !sub || !Number.isInteger(sub.exitCode) || typeof sub.output !== "string" || !sub.usage
			|| ![sub.usage.turns, sub.usage.input, sub.usage.output, sub.usage.cacheRead, sub.usage.cacheWrite, sub.usage.cost].every(numeric)) fail("result schema/usage");
		const gate = result.gateResult;
		if (gate !== null && (!gate || !["passed", "failed", "indeterminate"].includes(gate.status)
			|| gate.passed !== (gate.status === "passed") || typeof gate.feedback !== "string"
			|| ![gate.gateCost, gate.gateInputTokens, gate.gateOutputTokens].every(numeric)
			|| !Array.isArray(gate.criteriaResults) || gate.criteriaResults.some(item => !item || typeof item.criterion !== "string" || typeof item.met !== "boolean"))) fail("quality gate schema");
		results.set(id, result);
	}
	for (const [id, path] of Object.entries(cp.artifactPaths)) {
		if (!ids.has(id) || typeof path !== "string" || typeof cp.artifactHashes[id] !== "string") fail("artifact identity");
		const expected = resolvePathInsideExistingRoot(sourceDir, "artifacts", `${id}.md`);
		if (resolve(path) !== resolve(expected)) fail("artifact outside source execution");
		if (artifactHash(path) !== cp.artifactHashes[id]) fail("artifact hash differs");
	}
	if (Object.keys(cp.artifactHashes).some(id => !cp.artifactPaths[id])) fail("orphan artifact hash");
	const completed = new Set(cp.completed);
	for (const id of completed) {
		const result = results.get(id);
		if (!result?.passed || result.subagentResult.exitCode !== 0 || result.subagentResult.errorMessage || result.subagentResult.timedOut
			|| (result.gateResult !== null && result.gateResult?.passed !== true) || !cp.artifactPaths[id]) fail("completed node lacks passed result/artifact");
		const node = dag.nodes.find(node => node.id === id)!;
		if (!node.dependsOn.every(dep => completed.has(dep))) fail("completed dependencies");
		const evidence = result!.subagentResult;
		if (readFileSync(cp.artifactPaths[id], "utf8") !== (evidence.output || `(no output)\n\nError: ${evidence.errorMessage ?? "unknown"}`)) fail("artifact/result output differs");
		if (requireQualityGate && node.acceptanceCriteria.length && (!result!.gateResult?.passed
			|| result!.gateResult.criteriaResults.length !== node.acceptanceCriteria.length
			|| result!.gateResult.criteriaResults.some(item => !item.met || !node.acceptanceCriteria.includes(item.criterion)))) fail("completed node lacks required quality gate");
	}
	if (cp.status === "passed" && (completed.size !== ids.size || cp.failed.length)) fail("false passed state");
	return cp;
}
