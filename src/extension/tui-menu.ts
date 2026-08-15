export interface TuiAgentInfo {
	name: string;
	kind: "main" | "subagent";
	role: string;
	status: string;
	model?: string;
	provider?: string;
	sessionId?: string;
	callCount: number;
	totalCostUsd: number;
	capabilityGeneration: number;
	lastTask?: string;
	communication: "current_chat" | "persistent_session" | "message" | "none";
}

export interface TuiIssueInfo {
	id: string;
	title: string;
	status: string;
	claims: Array<{ id: string; agent: string; scope: string; status: string }>;
}

export interface FluxTuiMenuData {
	agents: TuiAgentInfo[];
	roles: string[];
	issues: TuiIssueInfo[];
	forkPoints: Array<{ entryId: string; preview: string }>;
	activeTaskIds: string[];
	tasks?: Array<{ id: string; task: string; status: string; operation: string }>;
	workflows?: Array<{ id: string; name: string; version: number; description: string; nodeCount: number }>;
	groups?: Array<{ id: string; name: string; type: string; members: string[]; description?: string }>;
	mainInbox?: Array<{ id: string; from: string; channel: string; content: string; priority: string; status: string }>;
}

async function select(ctx: any, title: string, options: string[]): Promise<string | null> {
	if (options.length === 0) return null;
	return (await ctx.ui.select(title, options)) ?? null;
}

async function input(ctx: any, title: string, placeholder: string): Promise<string | null> {
	return (await ctx.ui.input(title, placeholder))?.trim() || null;
}

function agentLabel(agent: TuiAgentInfo): string {
	return `${agent.name} · ${agent.kind} · ${agent.role} · ${agent.status}${agent.model ? ` · ${agent.model}` : ""}`;
}

function agentDetails(agent: TuiAgentInfo): string {
	return [
		`Agent ${agent.name}`,
		`  kind          ${agent.kind}`,
		`  role/status  ${agent.role} / ${agent.status}`,
		`  model        ${agent.provider ? `${agent.provider}/` : ""}${agent.model ?? "default"}`,
		`  session      ${agent.sessionId ?? "-"}`,
		`  calls/cost   ${agent.callCount} / $${agent.totalCostUsd.toFixed(6)}`,
		`  capability   generation ${agent.capabilityGeneration}`,
		`  last task    ${agent.lastTask ?? "-"}`,
	].join("\n");
}

export async function showAgentTuiMenu(ctx: any, data: FluxTuiMenuData): Promise<string | null | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.select) return undefined;
	const createLabel = "+ Create Persistent Agent";
	const options = [...data.agents.map(agentLabel), createLabel];
	const selected = await select(ctx, "Persistent Agents · select an Agent to inspect or talk", options);
	if (!selected) return null;
	if (selected === createLabel) {
		const name = await input(ctx, "Agent name", "e.g. reviewer-main");
		if (!name) return null;
		const role = await select(ctx, "Role template", data.roles);
		return role ? `agent create ${name} ${role}` : null;
	}
	const agent = data.agents.find(candidate => agentLabel(candidate) === selected);
	if (!agent) return null;
	ctx.ui.notify(agentDetails(agent), "info");
	const actions = ["Details · show information"];
	if (agent.communication === "current_chat") actions.unshift("Talk · continue in current Main conversation");
	if (agent.communication === "persistent_session") actions.unshift("Talk · continue Agent session");
	if (agent.communication === "message") actions.unshift("Message · send to active Agent");
	if (agent.kind === "subagent" && agent.status !== "archived") {
		if (agent.status === "running") actions.push("Stop · abort the running run");
		else if (agent.lastTask) actions.push("Retry · re-run last task");
		actions.push("Archive · retire this Agent");
	}
	const action = await select(ctx, agent.name, actions);
	if (action?.startsWith("Talk")) {
		const message = await input(ctx, `Talk to ${agent.name}`, "Describe the task, question or follow-up");
		if (!message) return null;
		return agent.communication === "current_chat" ? message : `agent run ${agent.name} ${message}`;
	}
	if (action?.startsWith("Message")) { const message = await input(ctx, `Message ${agent.name}`, "Message content"); return message ? `message send ${agent.name} ${message}` : null; }
	if (action?.startsWith("Details")) { ctx.ui.notify(agentDetails(agent), "info"); return null; }
	if (action?.startsWith("Stop")) return `agent stop ${agent.name}`;
	if (action?.startsWith("Retry")) return `agent retry ${agent.name}`;
	if (action?.startsWith("Delete")) return `agent delete ${agent.name}`;
	return null;
}

export async function showMessageTuiMenu(ctx: any, data: FluxTuiMenuData): Promise<string | null | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.select) return undefined;
	const groups = data.groups ?? [];
	const inbox = data.mainInbox ?? [];
	const selected = await select(ctx, "Messages", [
		`Main inbox · ${inbox.length} pending`,
		"Groups · list, create or send",
	]);
	if (!selected) return null;
	if (selected.startsWith("Main inbox")) {
		if (inbox.length === 0) { ctx.ui.notify("Main inbox is empty.", "info"); return null; }
		const labels = inbox.map(item => `${item.priority} · ${item.status} · ${item.from} · ${item.content.slice(0, 72)}`);
		const chosen = await select(ctx, "Main inbox", labels);
		const message = inbox.find((item, index) => labels[index] === chosen);
		if (!message) return null;
		if (message.status === "pending") return "message inbox main";
		const action = await select(ctx, message.id, ["Acknowledge", "Keep for later"]);
		return action === "Acknowledge" ? `message ack main ${message.id}` : null;
	}
	const createLabel = "+ Create group";
	const labels = groups.map(group => `${group.name} · ${group.type} · ${group.members.length} members`);
	const chosen = await select(ctx, "Message groups", [...labels, createLabel]);
	if (!chosen) return null;
	if (chosen === createLabel) {
		const name = await input(ctx, "Group name", "e.g. release-review");
		const members = name ? await input(ctx, "Members", "Comma-separated Agent names") : null;
		return name && members ? `message group create ${name} ${members}` : null;
	}
	const group = groups.find((item, index) => labels[index] === chosen);
	if (!group) return null;
	ctx.ui.notify(`Group ${group.name}\n  id       ${group.id}\n  members  ${group.members.join(", ")}`, "info");
	const action = await select(ctx, group.name, ["Send message", "Details"]);
	if (action !== "Send message") return null;
	const content = await input(ctx, `Message ${group.name}`, "Message content");
	return content ? `message group send ${group.id} ${content}` : null;
}

export async function showIssueTuiMenu(ctx: any, data: FluxTuiMenuData): Promise<string | null | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.select) return undefined;
	const createLabel = "+ Create Community Issue";
	const issueLabels = data.issues.map(issue => `${issue.id} · ${issue.status} · ${issue.title}`);
	const selected = await select(ctx, "Community Issues", [...issueLabels, createLabel]);
	if (!selected) return null;
	if (selected === createLabel) {
		const title = await input(ctx, "Issue title", "Describe the outcome to coordinate");
		return title ? `issue create ${title}` : null;
	}
	const issue = data.issues.find(candidate => selected.startsWith(`${candidate.id} ·`));
	if (!issue) return null;
	const action = await select(ctx, `${issue.id} · ${issue.title}`, ["Show", "Comment", "Claim work", "Submit claim", "Review claim", "Resolve"]);
	if (action === "Show") return `issue show ${issue.id}`;
	if (action === "Comment") { const text = await input(ctx, "Comment", "Add facts, risks or a proposal"); return text ? `issue comment ${issue.id} ${text}` : null; }
	if (action === "Claim work") {
		const agent = await input(ctx, "Claiming Agent", "Agent name");
		const scope = agent ? await input(ctx, "Claim scope", "Files, responsibility or artifact") : null;
		return agent && scope ? `issue claim ${issue.id} ${agent} ${scope}` : null;
	}
	if (action === "Submit claim") {
		const submittable = issue.claims.filter(claim => claim.status === "active");
		const claimLabel = await select(ctx, "Claim to submit", submittable.map(claim => `${claim.id} · ${claim.agent} · ${claim.scope}`));
		const claim = submittable.find(candidate => claimLabel?.startsWith(`${candidate.id} ·`));
		return claim ? `issue submit ${issue.id} ${claim.id}` : null;
	}
	if (action === "Review claim") {
		const pending = issue.claims.filter(claim => claim.status === "submitted");
		if (pending.length === 0) { await select(ctx, "No submitted claims to review", ["OK"]); return null; }
		const claimLabel = await select(ctx, "Claim to review", pending.map(claim => `${claim.id} · ${claim.agent} · ${claim.scope}`));
		const claim = pending.find(candidate => claimLabel?.startsWith(`${candidate.id} ·`));
		if (!claim) return null;
		const verdict = await select(ctx, "Verdict", ["pass · 通过", "rework · 退回重做"]);
		if (!verdict) return null;
		if (verdict.startsWith("pass")) return `issue review ${issue.id} ${claim.id} pass`;
		const feedback = await input(ctx, "Rework feedback", "What must the agent fix?");
		return `issue review ${issue.id} ${claim.id} rework ${feedback ?? ""}`;
	}
	if (action === "Resolve") return `issue resolve ${issue.id}`;
	return null;
}

export async function showForkTuiMenu(ctx: any, data: FluxTuiMenuData): Promise<string | null | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.select) return undefined;
	const point = await select(ctx, "Fork point", data.forkPoints.slice().reverse().map(item => `${item.entryId} · ${item.preview}`));
	const candidate = data.forkPoints.find(item => point?.startsWith(`${item.entryId} ·`));
	return candidate ? `fork ${candidate.entryId}` : null;
}

export async function showTaskTuiMenu(ctx: any, data: FluxTuiMenuData): Promise<string | null | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.select) return undefined;
	const tasks = data.tasks ?? [];
	if (tasks.length === 0) { ctx.ui.notify("No AgentFlux tasks.", "info"); return null; }
	const labels = tasks.map(task => `${task.status} · ${task.task.slice(0, 72)}`);
	const selected = await select(ctx, "Task history", labels);
	const task = tasks.find((candidate, index) => labels[index] === selected);
	if (!task) return null;
	const action = await select(ctx, task.task, ["Show", "Continue", "Reuse", "Resume interrupted execution"]);
	if (action === "Show") return `task show ${task.id}`;
	if (action === "Continue") return `task continue ${task.id}`;
	if (action === "Reuse") return `task reuse ${task.id}`;
	if (action === "Resume interrupted execution") return `task resume ${task.id}`;
	return null;
}

export async function showWorkflowTuiMenu(ctx: any, data: FluxTuiMenuData): Promise<string | null | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.select) return undefined;
	const createLabel = "+ New Workflow";
	const workflows = data.workflows ?? [];
	const labels = workflows.map(item => `${item.name} · v${item.version} · ${item.nodeCount} nodes`);
	const selected = await select(ctx, "Saved Workflows", [...labels, createLabel]);
	if (!selected) return null;
	if (selected === createLabel) {
		const task = await input(ctx, "New Workflow task", "Describe the outcome and fixed dependencies");
		return task ? `work workflow ${task}` : null;
	}
	const workflow = workflows.find((item, index) => labels[index] === selected);
	if (!workflow) return null;
	const action = await select(ctx, `${workflow.name} · v${workflow.version}`, ["Show DAG", "Reuse exact definition", "Modify as new version"]);
	if (action === "Show DAG") return `workflow show ${workflow.id}`;
	const task = action === "Reuse exact definition"
		? await input(ctx, "Reuse Workflow", "Describe this execution")
		: action === "Modify as new version"
			? await input(ctx, "Modify Workflow", "Describe the required DAG changes")
			: null;
	if (!task) return null;
	return action === "Reuse exact definition"
		? `workflow reuse ${workflow.id} ${task}`
		: `workflow modify ${workflow.id} ${task}`;
}

export async function showFluxTuiMenu(ctx: any, data: FluxTuiMenuData): Promise<string | null | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.select) return undefined;
	const selected = await select(ctx, "AgentFlux Workbench", [
		"New task · describe outcome", "Tasks · reuse, resume or continue", "Workflows · saved fixed DAGs", "Agents · inspect, create or talk", "Community · Issues and Claims",
		"Spaces · workflow/community and timeline", "Messages · groups and Main inbox", "Fork · branch from session context", "Runtime · status or cancel", "Context · compaction advice",
		"Maintenance · lifecycle GC", "Help · command reference",
	]);
	if (!selected) return null;
	if (selected.startsWith("Spaces")) return "space";
	if (selected.startsWith("New task")) {
		const task = await input(ctx, "new task", "Describe the outcome and acceptance criteria");
		return task ? `task new ${task}` : null;
	}
	if (selected.startsWith("Workflows")) return showWorkflowTuiMenu(ctx, data);
	if (selected.startsWith("Tasks")) return showTaskTuiMenu(ctx, data);
	if (selected.startsWith("Agents")) return showAgentTuiMenu(ctx, data);
	if (selected.startsWith("Community")) return showIssueTuiMenu(ctx, data);
	if (selected.startsWith("Messages")) return showMessageTuiMenu(ctx, data);
	if (selected.startsWith("Fork")) return showForkTuiMenu(ctx, data);
	if (selected.startsWith("Runtime")) {
		const action = await select(ctx, "Runtime", ["Status", "Cancel task"]);
		if (action === "Status") return "status";
		if (action === "Cancel task") {
			const taskId = await select(ctx, "Task to cancel", data.activeTaskIds.length ? [...data.activeTaskIds, "all"] : ["all"]);
			return taskId ? `cancel ${taskId === "all" ? "" : taskId}`.trim() : null;
		}
	}
	if (selected.startsWith("Context")) return "compact";
	if (selected.startsWith("Maintenance")) {
		const action = await select(ctx, "Lifecycle GC", ["Dry run · preview only", "Run GC · archive eligible data"]);
		return action?.startsWith("Dry") ? "gc dry-run" : action?.startsWith("Run") ? "gc" : null;
	}
	return "help";
}
