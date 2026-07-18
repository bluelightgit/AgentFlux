import { parseWorkStyle } from "../core/config";
import type { WorkStyle } from "../core/types";

export type FluxCommand =
	| { kind: "help" }
	| { kind: "work"; style: WorkStyle; task: string }
	| { kind: "agent"; args: string[] }
	| { kind: "fork"; args: string[] }
	| { kind: "issue"; args: string[] }
	| { kind: "cancel"; taskId?: string }
	| { kind: "gc"; dryRun: boolean }
	| { kind: "status" }
	| { kind: "compact" };

export function parseFluxCommand(input: string): FluxCommand {
	const parts = input.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts[0] === "help") return { kind: "help" };
	if (parts[0] === "work") {
		const style = parseWorkStyle(parts[1]);
		if (!style) throw new Error("Usage: /flux work <direct|team|workflow|community> <task>");
		const task = parts.slice(2).join(" ").trim();
		if (!task) throw new Error("Task cannot be empty");
		return { kind: "work", style, task };
	}
	if (parts[0] === "agent") return { kind: "agent", args: parts.slice(1) };
	if (parts[0] === "fork") return { kind: "fork", args: parts.slice(1) };
	if (parts[0] === "issue") return { kind: "issue", args: parts.slice(1) };
	if (parts[0] === "cancel") return { kind: "cancel", taskId: parts[1] };
	if (parts[0] === "gc") {
		if (parts[1] && parts[1] !== "dry-run") throw new Error("Usage: /flux gc [dry-run]");
		return { kind: "gc", dryRun: parts[1] === "dry-run" };
	}
	if (parts[0] === "status") return { kind: "status" };
	if (parts[0] === "compact") return { kind: "compact" };
	throw new Error(`Unknown /flux command: ${parts[0]}`);
}

export const FLUX_HELP = [
	"AgentFlux",
	"  /flux work <direct|team|workflow|community> <task>",
	"  /flux agent list|create <name> <role>|run <name> <task>|archive <name>",
	"  /flux fork [last|index|entryId]",
	"  /flux issue list|create <title>|show <id>|comment <id> <text>|claim <id> <agent> <scope>|submit <id> <claimId>|resolve <id>",
	"  /flux cancel [taskId]",
	"  /flux gc [dry-run]",
	"  /flux status",
	"  /flux compact",
].join("\n");
