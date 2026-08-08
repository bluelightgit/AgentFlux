import { createTaskExecutionPlan } from "../../src/core/task-execution";
import { registerTask } from "../../src/core/task-registry";
import { DEFAULT_CONFIG } from "../../src/core/types";
import { createIssue } from "../../src/core/community";
import { reviseWorkflowDefinition } from "../../src/workflows/workflow-registry";

const [mode, root, prefix, countRaw, selector] = process.argv.slice(2);
const count = Number(countRaw);
if (!mode || !root || !prefix || !Number.isInteger(count) || count < 1) {
	throw new Error("usage: transactional-store-worker <task|workflow|issue> <root> <prefix> <count> [selector]");
}

if (mode === "task") {
	for (let index = 0; index < count; index++) {
		registerTask(root, `session-${prefix}`, createTaskExecutionPlan({
			taskId: `task-${prefix}-${index}`,
			task: `task ${prefix} ${index}`,
			workStyle: "team",
			selectedBy: "user",
			budget: DEFAULT_CONFIG.budget,
		}));
	}
} else if (mode === "workflow") {
	if (!selector) throw new Error("workflow mode requires selector");
	for (let index = 0; index < count; index++) {
		reviseWorkflowDefinition(root, selector, {
			dag: { description: `revision ${prefix} ${index}`, nodes: [] },
			sourceTaskId: `task-${prefix}-${index}`,
		});
	}
} else if (mode === "issue") {
	for (let index = 0; index < count; index++) {
		createIssue(root, {
			title: `issue ${prefix} ${index}`,
			description: "concurrent registry test",
			createdBy: prefix,
		});
	}
} else {
	throw new Error(`unknown mode: ${mode}`);
}
