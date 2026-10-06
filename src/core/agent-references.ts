import { join } from "node:path";
import { listAgentRuns } from "./run-registry";
import { listTasks } from "./task-registry";
import { listIssues } from "./community";
import { listWorkflowDefinitions } from "../workflows/workflow-registry";

const reference = (id: unknown, name: string): string => typeof id === "string" && id.trim() ? id : name;

/** GC 共用的只读引用快照，删除方必须持有 F。损坏读取拒绝；旧空 ID 保守保留 name 保护。 */
export function collectAgentReferences(cwd: string): Set<string> {
	const refs = new Set<string>(), fluxDir = join(cwd, ".agentflux");
	for (const run of listAgentRuns(fluxDir, { activeOnly: true })) refs.add(reference(run.agentId, run.agent));
	for (const task of listTasks(fluxDir)) for (const member of task.team ?? []) refs.add(reference(member.agentId, member.name));
	for (const issue of listIssues(cwd)) for (const claim of issue.claims) refs.add(reference(claim.agentId, claim.agent));
	for (const definition of listWorkflowDefinitions(fluxDir, true)) {
		for (const node of definition.dag.nodes) if (node.agentId) refs.add(node.agentId);
	}
	return refs;
}
