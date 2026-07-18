interface MenuAction {
	label: string;
	command: string;
	taskPrompt?: string;
}

const MENU_ACTIONS: MenuAction[] = [
	{ label: "Direct · Main Agent 直接执行", command: "work direct", taskPrompt: "Direct task" },
	{ label: "Team · Main Agent 动态组队", command: "work team", taskPrompt: "Team task" },
	{ label: "Workflow · 执行固定 DAG", command: "work workflow", taskPrompt: "Workflow task" },
	{ label: "Community · 创建协作 Issue", command: "work community", taskPrompt: "Community issue" },
	{ label: "Persistent Agents · 查看与管理", command: "agent list" },
	{ label: "Community Issues · 查看列表", command: "issue list" },
	{ label: "Runtime Status · 当前任务与 Agent", command: "status" },
	{ label: "Context · 压缩建议", command: "compact" },
	{ label: "Maintenance · 预览生命周期回收", command: "gc dry-run" },
	{ label: "Command Help · 完整命令", command: "help" },
];

export async function showFluxTuiMenu(ctx: any): Promise<string | null | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui?.select) return undefined;
	const selected = await ctx.ui.select("AgentFlux Workbench", MENU_ACTIONS.map(action => action.label));
	if (!selected) return null;
	const action = MENU_ACTIONS.find(candidate => candidate.label === selected);
	if (!action) return null;
	if (!action.taskPrompt) return action.command;
	const task = (await ctx.ui.input(action.taskPrompt, "Describe the outcome and acceptance criteria"))?.trim();
	return task ? `${action.command} ${task}` : null;
}
