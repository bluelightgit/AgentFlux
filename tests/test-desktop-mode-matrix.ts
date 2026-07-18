import { validateStartOptions } from "../desktop/electron/runtime-start-contract";
import { MODE_CAPABILITIES, resolveExecutableMode } from "../src/core/execution-plan";
import type { Mode } from "../src/core/types";

let passed = 0;
const check = (name: string, condition: boolean): void => {
	if (!condition) throw new Error(`FAILED: ${name}`);
	passed += 1;
	console.log(`  ✓ ${name}`);
};

const base = {
	projectRoot: "E:\\agent-projects\\AgentFlux",
	name: "lead",
	taskTitle: "Mode matrix",
	initialTask: "Exercise the selected execution contract",
	priority: "normal",
} as const;

console.log("\n[Desktop → core execution mode matrix]");

for (const modePolicy of ["agent_decides", "M1", "M2", "M5"] as const) {
	const accepted = validateStartOptions({ ...base, modePolicy });
	check(`Desktop accepts ${modePolicy}`, accepted.modePolicy === modePolicy);
}

for (const modePolicy of ["M3", "M4", "M6"] as const) {
	let rejected = false;
	try {
		validateStartOptions({ ...base, modePolicy });
	} catch (error) {
		rejected = error instanceof Error && error.message.includes("modePolicy");
	}
	check(`Desktop rejects direct fixed ${modePolicy}`, rejected);
}

const expected: Record<Mode, { effective: "M1" | "M2" | "M5"; executor: "main" | "main_with_subagent" | "dag"; status: "available" | "experimental" }> = {
	M1: { effective: "M1", executor: "main", status: "available" },
	M2: { effective: "M2", executor: "main_with_subagent", status: "available" },
	M3: { effective: "M2", executor: "main_with_subagent", status: "experimental" },
	M4: { effective: "M5", executor: "dag", status: "experimental" },
	M5: { effective: "M5", executor: "dag", status: "available" },
	M6: { effective: "M5", executor: "dag", status: "experimental" },
};

for (const mode of Object.keys(expected) as Mode[]) {
	const resolved = resolveExecutableMode(mode);
	const contract = expected[mode];
	check(
		`${mode} resolves to ${contract.effective}/${contract.executor}`,
		resolved.effectiveMode === contract.effective
		&& resolved.executor === contract.executor
		&& MODE_CAPABILITIES[mode].status === contract.status
		&& (contract.status === "available" ? !resolved.fallbackReason : resolved.fallbackReason?.includes(`fallback → ${contract.effective}`) === true),
	);
}

console.log(`\nDesktop mode matrix: ${passed} passed, 0 failed`);
