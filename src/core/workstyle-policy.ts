import type { WorkStyle } from "./types";

export type WorkStyleCapability = "team" | "workflow" | "community";

const CAPABILITIES: Record<WorkStyle, readonly WorkStyleCapability[]> = {
	direct: [],
	team: ["team"],
	workflow: ["team", "workflow"],
	community: ["team", "community"],
};

export function getWorkStyleCapabilities(style: WorkStyle): readonly WorkStyleCapability[] {
	return CAPABILITIES[style];
}

export function workStyleAllows(style: WorkStyle, capability: WorkStyleCapability): boolean {
	return CAPABILITIES[style].includes(capability);
}

export function assertWorkStyleAllows(
	style: WorkStyle,
	capability: WorkStyleCapability,
	operation: string,
): void {
	if (workStyleAllows(style, capability)) return;
	throw new Error(
		`${style} work style cannot ${operation}; ${capability} capability is not available for this task`,
	);
}
