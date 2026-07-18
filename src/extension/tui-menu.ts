export interface TuiAgentInfo {
	name: string;
	kind: "main" | "persistent" | "ephemeral";
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
	if (agent.communication === "persistent_session") actions.unshift("Talk · continue Persistent session");
	if (agent.communication === "message") actions.unshift("Message · send to active Agent");
	if (agent.kind === "persistent" && agent.status !== "archived") actions.push("Archive · retire this Agent");
	const action = await select(ctx, agent.name, actions);
	if (action?.startsWith("Talk")) {
		const message = await input(ctx, `Talk to ${agent.name}`, "Describe the task, question or follow-up");
		if (!message) return null;
		return agent.communication === "current_chat" ? `work direct ${message}` : `agent run ${agent.name} ${message}`;
	}
	if (action?.startsWith("Message")) { const message = await input(ctx, `Message ${agent.name}`, "Message content"); return message ? `message ${agent.name} ${message}` : null; }
	if (action?.startsWith("Details")) { ctx.ui.notify(agentDetails(agent), "info"); return null; }
	if (action?.startsWith("Archive")) return `agent archive ${agent.name}`;
	return null;
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
	const action = await select(ctx, `${issue.id} · ${issue.title}`, ["Show", "Comment", "Claim work", "Submit claim", "Resolve"]);
	if (action === "Show") return `issue show ${issue.id}`;
	if (action === "Comment") { const text = await input(ctx, "Comment", "Add facts, risks or a proposal"); return text ? `issue comment ${issue.id} ${text}` : null; }
	if (action === "Claim work") {
		const agent = await input(ctx, "Claiming Agent", "Agent name");
		const scope = agent ? await input(ctx, "Claim scope", "Files, responsibility or artifact") : null;
		return agent && scope ? `issue claim ${issue.id} ${agent} ${scope}` : null;
	}
	if (action === "Submit claim") {
		const active = issue.claims.filter(claim => claim.status !== "completed");
		const claimLabel = await select(ctx, "Claim to submit", active.map(claim => `${claim.id} · ${claim.agent} · ${claim.scope}`));
		const claim = active.find(candidate => claimLabel?.startsWith(`${candidate.id} ·`));
		return claim ? `issue submit ${issue.id} ${claim.id}` : null;
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

export async function showFluxTuiMenu(ctx: any, data: FluxTuiMenuData): Promise<string | null | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.select) return undefined;
	const selected = await select(ctx, "AgentFlux Workbench", [
		"Work · start a task", "Agents · inspect, create or talk", "Community · Issues and Claims",
		"Fork · branch from session context", "Runtime · status or cancel", "Context · compaction advice",
		"Maintenance · lifecycle GC", "Help · command reference",
	]);
	if (!selected) return null;
	if (selected.startsWith("Work")) {
		const style = await select(ctx, "Work style", [
			"direct · Main Agent executes", "team · dynamic Agent collaboration",
			"workflow · fixed dependency DAG", "community · Issue and Claim collaboration",
		]);
		if (!style) return null;
		const task = await input(ctx, `${style.split(" ·")[0]} task`, "Describe the outcome and acceptance criteria");
		return task ? `work ${style.split(" ·")[0]} ${task}` : null;
	}
	if (selected.startsWith("Agents")) return showAgentTuiMenu(ctx, data);
	if (selected.startsWith("Community")) return showIssueTuiMenu(ctx, data);
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
