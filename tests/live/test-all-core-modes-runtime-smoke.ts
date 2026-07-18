/**
 * Zero-provider-cost Desktop runtime smoke for every documented AgentFlux mode.
 *
 * Production Desktop intentionally exposes only AUTO/M1/M2/M5. This test uses
 * the real Desktop AgentRuntime and replaces its private spawn-mode argument in
 * the test process only, allowing core M3/M4/M6 fallback behavior to be proven
 * without widening the renderer/IPC contract.
 */
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

type RequestedMode = "M1" | "M2" | "M3" | "M4" | "M5" | "M6";
type DesktopModePolicy = "M1" | "M2" | "M5";
type Request = { id: string; method: "confirm" | "select" | "input" };
type Snapshot = {
	runId: string;
	pid: number | null;
	status: string;
	pendingUiRequests: Request[];
	events: Array<{ type: string; data?: unknown }>;
	exitCode: number | null;
	stderrSummary: string;
};
type SpawnProcess = (...args: unknown[]) => unknown;
type Runtime = {
	start(options: { projectRoot: string; name: string; initialTask: string; taskTitle: string; modePolicy: DesktopModePolicy }): Promise<string>;
	list(): Snapshot[];
	respondToExtensionUI(runId: string, response: Record<string, unknown>): Promise<void>;
	stop(runId: string): Promise<void>;
	shutdownAll(): Promise<void>;
	on(event: string, listener: (snapshot: Snapshot) => void): void;
	spawnProcess: SpawnProcess;
};

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, "../..");
const desktopRoot = join(projectRoot, "desktop");
const fixture = join(desktopRoot, "tests", "live", "fixtures", "extension-ui-smoke.ts");
const resultPath = join(desktopRoot, ".tmp-all-modes-runtime-smoke-result.json");
const { AgentRuntime } = require(join(desktopRoot, "dist-electron", "agent-runtime.js")) as {
	AgentRuntime: new () => Runtime;
};
const modes: RequestedMode[] = ["M1", "M2", "M3", "M4", "M5", "M6"];
const expectedEffective: Record<RequestedMode, DesktopModePolicy> = {
	M1: "M1", M2: "M2", M3: "M2", M4: "M5", M5: "M5", M6: "M5",
};
const allowedPolicy: Record<RequestedMode, DesktopModePolicy> = {
	M1: "M1", M2: "M2", M3: "M1", M4: "M1", M5: "M5", M6: "M1",
};

process.env.AGENTFLUX_DESKTOP_LIVE_TEST = "1";
process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION = fixture;
process.env.AGENTFLUX_EXTENSION_UI_RESULT = resultPath;
process.env.AGENTFLUX_PI_MODEL = "octopus-anthropic/deepseek-v4-flash";
process.env.AGENTFLUX_PI_THINKING = "off";

const runtime = new AgentRuntime();
const originalSpawn = runtime.spawnProcess.bind(runtime);
let requestedMode: RequestedMode = "M1";
// Test-only seam: preserve all Desktop spawn/lifecycle behavior while passing
// the documented experimental mode to core. Renderer and IPC remain closed.
runtime.spawnProcess = (...args: unknown[]) => originalSpawn(...args.slice(0, 4), requestedMode);

const responded = new Set<string>();
const responseErrors: string[] = [];
const sleep = (ms: number) => new Promise(resolveDone => setTimeout(resolveDone, ms));
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
		: { id: request.id, value: request.method === "select" ? "beta" : "smoke-value" };
	void runtime.respondToExtensionUI(snapshot.runId, response).catch(error => {
		responseErrors.push(`${snapshot.runId}:${request.id}:${String(error)}`);
	});
});

async function main(): Promise<void> {
	const evidence: Array<Record<string, unknown>> = [];
	try {
		for (const mode of modes) {
			requestedMode = mode;
			rmSync(resultPath, { force: true });
			const runId = await runtime.start({
				projectRoot,
				name: `all-modes-${mode.toLowerCase()}-${Date.now().toString(36)}`,
				taskTitle: `Zero-cost ${mode} fallback smoke`,
				initialTask: "",
				modePolicy: allowedPolicy[mode],
			});
			const ready = await waitFor(`${mode} Extension UI responses`, () => {
				const current = runtime.list().find(item => item.runId === runId);
				return current?.events.filter(event => event.type === "extension_ui_response").length === 3 ? current : undefined;
			});
			if (ready.pid == null) throw new Error(`${mode} did not expose a runtime PID`);
			if (responseErrors.length > 0) throw new Error(responseErrors.join(" | "));
			const notification = ready.events
				.map(event => event.data as { method?: string; message?: string } | undefined)
				.find(data => data?.method === "notify" && data.message?.startsWith("AgentFlux"))?.message;
			if (!notification?.endsWith(`· ${expectedEffective[mode]}`)) {
				throw new Error(`${mode} expected effective ${expectedEffective[mode]}, got ${notification ?? "no notification"}`);
			}
			await runtime.stop(runId);
			const exited = await waitFor(`${mode} graceful exit`, () => {
				const current = runtime.list().find(item => item.runId === runId);
				return current?.exitCode === 0 ? current : undefined;
			}, 10_000);
			evidence.push({ requestedMode: mode, effectiveMode: expectedEffective[mode], runId, pid: ready.pid, responses: 3, notification, exitCode: exited.exitCode });
		}
		if (new Set(evidence.map(item => item.pid)).size !== modes.length) throw new Error("each mode must use an independent process");
		process.stdout.write(`${JSON.stringify({ ok: true, cost: 0, modes: evidence }, null, 2)}\n`);
	} finally {
		await runtime.shutdownAll();
		rmSync(resultPath, { force: true });
		delete process.env.AGENTFLUX_DESKTOP_LIVE_TEST;
		delete process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION;
		delete process.env.AGENTFLUX_EXTENSION_UI_RESULT;
		delete process.env.AGENTFLUX_PI_MODEL;
		delete process.env.AGENTFLUX_PI_THINKING;
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
