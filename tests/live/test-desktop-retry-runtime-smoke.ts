/** Zero-provider-cost Desktop fail → retry diagnostic smoke. */
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type Snapshot = {
	runId: string; name: string; status: string; exitCode: number | null; errorCode: string | null;
	retryOfRunId: string | null; rootRunId: string; retryAttempt: number; stderrSummary: string;
	pendingUiRequests: Array<{ id: string }>; events: Array<{ type: string; data?: unknown }>;
};
type Runtime = {
	start(options: { projectRoot: string; name: string; initialTask: string; taskTitle: string }): Promise<string>;
	retry(runId: string): Promise<string>;
	waitUntilReady(runId: string, timeoutMs?: number): Promise<void>;
	respondToExtensionUI(runId: string, response: { id: string; confirmed: true }): Promise<void>;
	list(): Snapshot[];
	shutdownAll(): Promise<void>;
	on(event: string, listener: (snapshot: Snapshot) => void): void;
};

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, "../..");
const desktopRoot = join(projectRoot, "desktop");
const fixture = join(desktopRoot, "tests", "live", "fixtures", "retry-lifecycle-smoke.ts");
const flag = join(desktopRoot, `.tmp-retry-runtime-${process.pid}.flag`);
const { AgentRuntime } = require(join(desktopRoot, "dist-electron", "agent-runtime.js")) as { AgentRuntime: new () => Runtime };

process.env.AGENTFLUX_DESKTOP_LIVE_TEST = "1";
process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION = fixture;
process.env.AGENTFLUX_RETRY_SMOKE_FLAG = flag;
const runtime = new AgentRuntime();
let activeRetryRunId = "";
let responseError: string | null = null;
const responded = new Set<string>();
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
	if (!activeRetryRunId || snapshot.runId !== activeRetryRunId) return;
	const request = snapshot.pendingUiRequests[0];
	if (!request || responded.has(request.id)) return;
	responded.add(request.id);
	void runtime.respondToExtensionUI(snapshot.runId, { id: request.id, confirmed: true })
		.catch(error => { responseError = String(error); });
});

async function main(): Promise<void> {
	try {
		try { rmSync(flag, { force: true }); } catch { /* clean */ }
		const sourceRunId = await runtime.start({
			projectRoot, name: `retry-diag-${Date.now().toString(36)}`,
			taskTitle: "Zero-cost retry diagnostic", initialTask: "",
		});
		const source = await waitFor("controlled exit23", () => {
			const item = runtime.list().find(candidate => candidate.runId === sourceRunId);
			return item?.exitCode === 23 ? item : undefined;
		});
		if (!existsSync(flag)) throw new Error("source exited 23 without committing fixture flag");
		const retryRunId = await runtime.retry(sourceRunId);
		activeRetryRunId = retryRunId;
		const settled = await waitFor("retry response or early terminal", () => {
			const item = runtime.list().find(candidate => candidate.runId === retryRunId);
			if (!item) return undefined;
			if (responseError) return { kind: "response-error" as const, item };
			if (item.events.some(event => event.type === "extension_ui_response")) return { kind: "response" as const, item };
			if (item.exitCode !== null || ["done", "failed", "aborted"].includes(item.status)) return { kind: "terminal" as const, item };
			return undefined;
		});
		if (settled.kind === "response-error") throw new Error(`retry response failed: ${responseError}; ${JSON.stringify(settled.item)}`);
		if (settled.kind === "terminal") throw new Error(`retry reached terminal before response: ${JSON.stringify(settled.item)}`);
		const retry = await waitFor("retry done", () => {
			const item = runtime.list().find(candidate => candidate.runId === retryRunId);
			return item?.status === "done" && item.exitCode === 0 ? item : undefined;
		});
		if (retry.retryOfRunId !== sourceRunId || retry.rootRunId !== sourceRunId || retry.retryAttempt !== 1) {
			throw new Error("retry provenance mismatch");
		}
		process.stdout.write(`${JSON.stringify({ ok: true, cost: 0, source, retry }, null, 2)}\n`);
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error), flag: existsSync(flag), snapshots: runtime.list() }, null, 2)}\n`);
		throw error;
	} finally {
		await runtime.shutdownAll();
		try { rmSync(flag, { force: true }); } catch { /* clean */ }
		delete process.env.AGENTFLUX_DESKTOP_LIVE_TEST;
		delete process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION;
		delete process.env.AGENTFLUX_RETRY_SMOKE_FLAG;
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
