/**
 * Zero-provider-cost Desktop execution-policy smoke.
 *
 * Reuses the existing Desktop test-only Extension UI fixture, so each policy
 * launches a real pi --mode rpc process and exercises three stdin responses
 * without sending a model prompt.
 */
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

type ModePolicy = "agent_decides" | "M1" | "M2" | "M5";
type Request = { id: string; method: "confirm" | "select" | "input" };
type Snapshot = {
	runId: string;
	name: string;
	pid: number | null;
	status: string;
	modePolicy: ModePolicy;
	pendingUiRequests: Request[];
	events: Array<{ type: string; data?: unknown }>;
	exitCode: number | null;
	stderrSummary: string;
};
type Runtime = {
	start(options: { projectRoot: string; name: string; initialTask: string; taskTitle: string; modePolicy: ModePolicy }): Promise<string>;
	list(): Snapshot[];
	respondToExtensionUI(runId: string, response: Record<string, unknown>): Promise<void>;
	stop(runId: string): Promise<void>;
	shutdownAll(): Promise<void>;
	on(event: string, listener: (snapshot: Snapshot) => void): void;
};

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, "../..");
const desktopRoot = join(projectRoot, "desktop");
const fixture = join(desktopRoot, "tests", "live", "fixtures", "extension-ui-smoke.ts");
const resultPath = join(desktopRoot, ".tmp-mode-runtime-smoke-result.json");
const { AgentRuntime } = require(join(desktopRoot, "dist-electron", "agent-runtime.js")) as {
	AgentRuntime: new () => Runtime;
};

process.env.AGENTFLUX_DESKTOP_LIVE_TEST = "1";
process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION = fixture;
process.env.AGENTFLUX_EXTENSION_UI_RESULT = resultPath;
process.env.AGENTFLUX_PI_MODEL = "octopus-anthropic/deepseek-v4-flash";
process.env.AGENTFLUX_PI_THINKING = "off";
// AUTO must delete inherited execution mode; fixed policies replace it.
process.env.AGENTFLUX_EXECUTION_MODE = "M6";

const runtime = new AgentRuntime();
const responded = new Set<string>();
const responseErrors: string[] = [];
const sleep = (ms: number) => new Promise(resolveDone => setTimeout(resolveDone, ms));
const snapshots = () => runtime.list();
async function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await sleep(25);
	}
	throw new Error(`timeout waiting for ${label}`);
}

runtime.on("record-update", snapshot => {
	const request = snapshot.pendingUiRequests.find(item => !responded.has(`${snapshot.runId}:${item.id}`));
	if (!request) return;
	responded.add(`${snapshot.runId}:${request.id}`);
	const response = request.method === "confirm"
		? { id: request.id, confirmed: true }
		: request.method === "select"
			? { id: request.id, value: "beta" }
			: { id: request.id, value: "smoke-value" };
	void runtime.respondToExtensionUI(snapshot.runId, response).catch(error => {
		responseErrors.push(`${snapshot.runId}:${request.id}:${String(error)}`);
	});
});

const policies: ModePolicy[] = ["agent_decides", "M1", "M2", "M5"];
const evidence: Array<Record<string, unknown>> = [];

async function main(): Promise<void> {
	try {
	for (const modePolicy of policies) {
		try { rmSync(resultPath, { force: true }); } catch { /* no prior result */ }
		const runId = await runtime.start({
			projectRoot,
			name: `mode-${modePolicy.toLowerCase()}-${Date.now().toString(36)}`,
			taskTitle: `Zero-cost ${modePolicy} runtime smoke`,
			initialTask: "",
			modePolicy,
		});
		const ready = await waitFor(`${modePolicy} extension responses`, () => {
			const current = snapshots().find(item => item.runId === runId);
			return current && current.events.filter(event => event.type === "extension_ui_response").length === 3
				? current : undefined;
		});
		if (ready.modePolicy !== modePolicy || ready.pid == null) {
			throw new Error(`${modePolicy} snapshot mismatch: policy=${ready.modePolicy} pid=${ready.pid}`);
		}
		if (responseErrors.length > 0) throw new Error(responseErrors.join(" | "));
		const eventTypes = ready.events.map(event => event.type);
		const coreNotification = ready.events
			.map(event => event.data as { method?: string; message?: string } | undefined)
			.find(data => data?.method === "notify" && data.message?.startsWith("AgentFlux"))?.message;
		if (!coreNotification) throw new Error(`${modePolicy} did not emit the core session_start notification`);
		if (modePolicy === "agent_decides" && coreNotification.includes("· M6")) {
			throw new Error(`AUTO inherited parent AGENTFLUX_EXECUTION_MODE: ${coreNotification}`);
		}
		if (modePolicy !== "agent_decides" && !coreNotification.endsWith(`· ${modePolicy}`)) {
			throw new Error(`${modePolicy} did not reach core execution state: ${coreNotification}`);
		}
		if (ready.exitCode == null) await runtime.stop(runId);
		const exited = await waitFor(`${modePolicy} graceful exit`, () => {
			const current = snapshots().find(item => item.runId === runId);
			return current?.exitCode === 0 ? current : undefined;
		}, 10_000);
		evidence.push({
			modePolicy,
			runId,
			pid: ready.pid,
			responses: eventTypes.filter(type => type === "extension_ui_response").length,
			blockedObserved: eventTypes.includes("extension_ui_request"),
			coreNotification,
			exitCode: exited.exitCode,
			stderr: exited.stderrSummary,
		});
	}
	const uniquePids = new Set(evidence.map(item => item.pid));
	if (uniquePids.size !== policies.length) throw new Error(`expected ${policies.length} independent PIDs, got ${uniquePids.size}`);
		process.stdout.write(`${JSON.stringify({ ok: true, cost: 0, policies: evidence }, null, 2)}\n`);
	} catch (error) {
		process.stderr.write(`${JSON.stringify({
			ok: false,
			error: error instanceof Error ? error.stack : String(error),
			responseErrors,
			snapshots: snapshots(),
		}, null, 2)}\n`);
		throw error;
	} finally {
		await runtime.shutdownAll();
		try { rmSync(resultPath, { force: true }); } catch { /* best effort */ }
		delete process.env.AGENTFLUX_DESKTOP_LIVE_TEST;
		delete process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION;
		delete process.env.AGENTFLUX_EXTENSION_UI_RESULT;
		delete process.env.AGENTFLUX_PI_MODEL;
		delete process.env.AGENTFLUX_PI_THINKING;
		delete process.env.AGENTFLUX_EXECUTION_MODE;
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
