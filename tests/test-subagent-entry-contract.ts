import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentEntry from "../src/subagent-entry";

const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: string) {
	checks.push({ name, passed, detail });
	console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

async function main() {
	const root = mkdtempSync(join(tmpdir(), "agentflux-subentry-contract-"));
	const previous = { ...process.env };
	try {
		process.env.AGENTFLUX_AGENT_NAME = "contract-agent";
		process.env.AGENTFLUX_AGENT_INSTANCE_ID = "contract-instance";
		process.env.AGENTFLUX_RUN_ID = "contract-run";
		process.env.AGENTFLUX_CONTROL_CWD = root;
		process.env.AGENTFLUX_AGENT_ROLE = "reviewer";
		process.env.AGENTFLUX_COMMUNICATION_POLICY = JSON.stringify({ enabled: true, actions: ["status"], allowedTargets: ["*"] });
		process.env.AGENTFLUX_CAPABILITY_POLICY = JSON.stringify({
			tools: ["read", "bash", "flux_agent_message"], skills: [], mcpServers: [],
			communication: { enabled: true, actions: ["status"], allowedTargets: ["*"], requiredSendTo: [], requireExplicitInboxAck: false, maxMessagesPerRun: 20 },
			workspace: { roots: [root], deniedPaths: [], blockDangerousCommands: true, enforcement: "tool_hook_partial" },
		});
		process.env.AGENTFLUX_LOCK_FILES = "[]";
		process.env.AGENTFLUX_RPC_INBOX_PUMP = "";

		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		const tools: any[] = [];
		const entries: Array<{ customType: string; data: any }> = [];
		const pi: any = {
			on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); },
			registerTool(tool: any) { tools.push(tool); },
			appendEntry(customType: string, data: any) { entries.push({ customType, data }); },
		};
		subagentEntry(pi);
		const messageTool = tools.find(tool => tool.name === "flux_agent_message");
		check("Agent message tool is model-only and sequential", messageTool?.exposure === "model-only" && messageTool?.executionMode === "sequential", JSON.stringify({ exposure: messageTool?.exposure, executionMode: messageTool?.executionMode }));
		const success = await messageTool.execute("call-1", { action: "status" }, undefined, undefined, { cwd: root });
		const failure = await messageTool.execute("call-2", { action: "ack" }, undefined, undefined, { cwd: root });
		check("Agent message success is JSON-safe and not an error", success.isError === false && JSON.parse(JSON.stringify(success.details)), JSON.stringify(success.details));
		check("Agent message failure is JSON-safe and explicit", failure.isError === true && failure.structuredContent?.ok === false, JSON.stringify(failure.details));

		const gate = handlers.get("tool_call")!;
		const powerShell: any = await gate({ toolName: "powershell", input: { command: "Get-ChildItem" } }, { cwd: root });
		const nestedEscape: any = await gate({ toolName: "read", parentToolCallId: "codemode/1", input: { path: join(root, "..", "outside.txt") } }, { cwd: root });
		check("PowerShell is blocked before execution", powerShell?.block === true && String(powerShell.reason).includes("reliable capability/path gate"), JSON.stringify(powerShell));
		check("nested calls use the same workspace gate", nestedEscape?.block === true && String(nestedEscape.reason).includes("outside"), JSON.stringify(nestedEscape));

		await handlers.get("agent_start")?.({}, {});
		await handlers.get("agent_before_settle")?.({
			type: "agent_before_settle", entries: [], continue: false,
			context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
			outcome: "completed",
		}, {});
		check("JSON-visible boundary receipt has the fixed kind and required associations",
			entries.length === 1
				&& entries[0].customType === "agentflux.boundary.receipt"
				&& entries[0].data.generation === 1
				&& entries[0].data.outcome === "completed"
				&& entries[0].data.terminalFailure === false
				&& entries[0].data.consumed === false,
			JSON.stringify(entries[0]));
		const warming: any = await handlers.get("cache_warming_decision")?.({ action: "warm" }, {});
		check("native cache warming stops without a second timer or global setting", warming?.action === "stop", JSON.stringify(warming));
	} finally {
		for (const key of Object.keys(process.env)) {
			if (!(key in previous)) delete process.env[key];
		}
		for (const [key, value] of Object.entries(previous)) process.env[key] = value;
		rmSync(root, { recursive: true, force: true });
	}
	const failed = checks.filter(item => !item.passed);
	console.log(`\nSubagent entry contract: ${checks.length - failed.length}/${checks.length} passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
