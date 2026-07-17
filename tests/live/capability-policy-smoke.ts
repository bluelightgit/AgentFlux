import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runSubagent } from "../../src/extension/subagent";
import { TelemetryWriter } from "../../src/telemetry/events";

const cwd = process.cwd();
const fluxDir = join(cwd, ".agentflux");
const runId = `cap-live-${randomUUID()}`;
const agentName = `cap-live-${randomUUID().slice(0, 8)}`;
const deniedFile = join(fluxDir, "runtime", `${runId}-denied.txt`);

async function main() {
	mkdirSync(join(fluxDir, "runtime"), { recursive: true });
	writeFileSync(deniedFile, "harmless capability gate marker", "utf-8");
	try {
		const widening = await runSubagent({
			cwd,
			agent: { name: `${agentName}-reject`, role: "reviewer", description: "policy rejection", tools: ["read"], systemPrompt: "Be concise." },
			task: "This run must never reach a provider.", sessionId: runId, prefixLayout: true,
			runId: `${runId}-reject`, capabilityOverride: { tools: ["read", "bash"] },
		});
		if (widening.exitCode !== 77 || !widening.errorMessage?.includes("cannot widen")) {
			throw new Error(`widening was not rejected before provider: ${JSON.stringify(widening)}`);
		}

		const telemetry = new TelemetryWriter(fluxDir, true);
		const result = await runSubagent({
			cwd,
			agent: {
				name: agentName, role: "reviewer", description: "capability live gate",
				tools: ["read"], systemPrompt: "Follow the task exactly and keep the final answer to one line.",
				workspace: { roots: [cwd], deniedPaths: [deniedFile], blockDangerousCommands: true },
			},
			task: `You must call the read tool on this exact path: ${deniedFile}. If the tool reports that the path is denied by capability policy, reply exactly CAPABILITY_BLOCKED_OK.`,
			sessionId: runId, telemetry, prefixLayout: true, runId,
			model: "deepseek-v4-flash", provider: "octopus-anthropic", thinking: "off",
			timeoutMs: 60_000, maxRetries: 0,
		});
		const snapshotPath = join(fluxDir, "runtime", "capability-effective", `${agentName}.json`);
		const snapshot = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, "utf-8")) : null;
		const events = existsSync(join(fluxDir, "events.jsonl"))
			? readFileSync(join(fluxDir, "events.jsonl"), "utf-8").trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
		const capabilityEvent = events.find(event => event.type === "capability.policy" && event.runId === runId);
		const report = {
			runId, agentName, exitCode: result.exitCode, output: result.output,
			usage: result.usage, blocked: result.output.includes("CAPABILITY_BLOCKED_OK"),
			snapshot: !!snapshot && snapshot.effective.workspace.deniedPaths.includes(deniedFile),
			telemetry: capabilityEvent?.result === "success",
			wideningRejected: true,
		};
		console.log(JSON.stringify(report, null, 2));
		if (result.exitCode !== 0 || !report.blocked || !report.snapshot || !report.telemetry) process.exitCode = 1;
	} finally {
		try { unlinkSync(deniedFile); } catch {}
	}
}

main().catch(error => { console.error(error); process.exit(1); });
