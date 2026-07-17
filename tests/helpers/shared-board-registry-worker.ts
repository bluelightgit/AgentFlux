import { SharedBoard } from "../../src/core/shared-board";

const [, , fluxDir, prefix] = process.argv;
if (!fluxDir || !prefix) throw new Error("usage: worker <fluxDir> <prefix>");

const board = new SharedBoard(fluxDir);
for (let index = 0; index < 10; index++) {
	const name = `${prefix}-agent-${index}`;
	board.registerAgent({ name, role: "tester", status: "running" });
	board.updateAgentStatus(name, { status: "running", workingOn: `${prefix}-task-${index}` });
	board.ensureAllGroup([name], prefix);
	if (index < 5) board.createGroup(`${prefix}-team-${index}`, [name], "team", prefix);
}
