/**
 * Real pi RPC / Desktop AgentRuntime Extension UI smoke.
 * No model prompt is sent, so provider cost is zero. The test-only extension is constrained
 * by AgentRuntime to desktop/tests/live and writes only the selected test result path.
 */
import { createRequire } from 'node:module';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Request = { id: string; method: 'confirm' | 'select' | 'input'; options?: string[] };
type Snapshot = {
  runId: string; name: string; pid: number | null; status: string;
  pendingUiRequests: Request[]; events: Array<{ type: string; data?: unknown }>;
  exitCode: number | null; stderrSummary: string;
};
type Runtime = {
  start(options: { projectRoot: string; name: string; initialTask?: string }): Promise<string>;
  list(): Snapshot[];
  respondToExtensionUI(runId: string, response: Record<string, unknown>): Promise<void>;
  stop(runId: string): Promise<void>;
  shutdownAll(): Promise<void>;
  on(event: string, listener: (snapshot: Snapshot) => void): void;
};

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, '../../..');
const desktopRoot = resolve(import.meta.dirname, '../..');
const resultPath = join(desktopRoot, '.tmp-extension-ui-live-result.json');
const reportPath = join(desktopRoot, '.tmp-extension-ui-live-report.json');
const tracePath = join(desktopRoot, '.tmp-extension-ui-live-trace.json');
const fixturePath = join(import.meta.dirname, 'fixtures', 'extension-ui-smoke.ts');
const { AgentRuntime } = require(join(desktopRoot, 'dist-electron', 'electron', 'agent-runtime.js')) as {
  AgentRuntime: new () => Runtime;
};

process.env.AGENTFLUX_DESKTOP_LIVE_TEST = '1';
process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION = fixturePath;
process.env.AGENTFLUX_EXTENSION_UI_RESULT = resultPath;
process.env.AGENTFLUX_PI_MODEL = 'octopus-anthropic/deepseek-v4-flash';
process.env.AGENTFLUX_PI_THINKING = 'off';
try { rmSync(resultPath, { force: true }); } catch { /* no prior result */ }
try { rmSync(reportPath, { force: true }); } catch { /* no prior report */ }
try { rmSync(tracePath, { force: true }); } catch { /* no prior trace */ }

const runtime = new AgentRuntime();
const startedAt = Date.now();
const transitions: Array<{ status: string; pending: string[]; at: number }> = [];
const responded = new Set<string>();
const sleep = (ms: number) => new Promise((resolveDone) => setTimeout(resolveDone, ms));
async function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

let runId = '';
runtime.on('record-update', (snapshot) => {
  if (runId && snapshot.runId !== runId) return;
  const next = { status: snapshot.status, pending: snapshot.pendingUiRequests.map((item) => item.method), at: Date.now() };
  const previous = transitions.at(-1);
  if (!previous || previous.status !== next.status || previous.pending.join() !== next.pending.join()) transitions.push(next);
  writeFileSync(tracePath, JSON.stringify({ transitions, events: snapshot.events, stderr: snapshot.stderrSummary }, null, 2), 'utf8');
  const request = snapshot.pendingUiRequests.find((item) => !responded.has(item.id));
  if (request) {
    responded.add(request.id);
    const response = request.method === 'confirm'
      ? { id: request.id, confirmed: true }
      : request.method === 'select'
        ? { id: request.id, value: 'beta' }
        : { id: request.id, value: 'smoke-value' };
    void runtime.respondToExtensionUI(snapshot.runId, response).catch((error) => {
      writeFileSync(reportPath, JSON.stringify({ ok: false, responseError: String(error), transitions }, null, 2), 'utf8');
    });
  }
});

function snapshot(): Snapshot | undefined {
  return runtime.list().find((item) => item.runId === runId);
}

try {
  runId = await runtime.start({ projectRoot, name: `extension-ui-live-${startedAt.toString(36)}`, initialTask: '' });
  await waitFor('three dialog responses', () => (snapshot()?.events.filter((event) => event.type === 'extension_ui_response').length ?? 0) === 3 ? true : undefined);
  const eventTypes = snapshot()?.events.map((event) => event.type) ?? [];
  const responses = snapshot()?.events.filter((event) => event.type === 'extension_ui_response').map((event) => event.data) ?? [];
  if (eventTypes.filter((type) => type === 'extension_ui_response').length !== 3) {
    throw new Error(`expected 3 extension_ui_response events: ${eventTypes.join(',')}`);
  }
  const report = { ok: true, durationMs: Date.now() - startedAt, responses, transitions, eventTypes };
  // Persist evidence before graceful stop: on Windows the process-tree fallback can close
  // the invoking PTY before buffered stdout is flushed.
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await sleep(100);
  if (snapshot()?.exitCode == null) await runtime.stop(runId);
  await waitFor('graceful exit', () => snapshot()?.exitCode === 0 ? true : undefined, 10_000);
  process.stdout.write(`${JSON.stringify({ ...report, final: snapshot() }, null, 2)}\n`);
} catch (error: unknown) {
  writeFileSync(reportPath, JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error), transitions, final: snapshot() }, null, 2), 'utf8');
  throw error;
} finally {
  await runtime.shutdownAll();
  try { rmSync(resultPath, { force: true }); } catch { /* best effort */ }
  try { rmSync(reportPath, { force: true }); } catch { /* best effort */ }
  try { rmSync(tracePath, { force: true }); } catch { /* best effort */ }
  delete process.env.AGENTFLUX_DESKTOP_LIVE_TEST;
  delete process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION;
  delete process.env.AGENTFLUX_EXTENSION_UI_RESULT;
}
