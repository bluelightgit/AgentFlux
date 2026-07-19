import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Snapshot = { runId: string; status: string; exitCode: number | null; retryOfRunId: string | null; rootRunId: string; retryAttempt: number; pendingUiRequests: Array<{ id: string }>; events: Array<{ type: string }> };
type Runtime = {
  start(options: { projectRoot: string; name: string; initialTask?: string; taskTitle?: string }): Promise<string>;
  retry(runId: string): Promise<string>;
  waitUntilReady(runId: string, timeoutMs?: number): Promise<void>;
  list(): Snapshot[];
  respondToExtensionUI(runId: string, response: { id: string; confirmed: true }): Promise<void>;
  shutdownAll(): Promise<void>;
};

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, '../../..');
const desktopRoot = resolve(import.meta.dirname, '../..');
const flag = join(desktopRoot, '.tmp-retry-lifecycle-smoke.flag');
const fixture = join(import.meta.dirname, 'fixtures', 'retry-lifecycle-smoke.ts');
const { AgentRuntime } = require(join(desktopRoot, 'dist-electron', 'electron', 'agent-runtime.js')) as { AgentRuntime: new () => Runtime };
process.env.AGENTFLUX_DESKTOP_LIVE_TEST = '1';
process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION = fixture;
process.env.AGENTFLUX_RETRY_SMOKE_FLAG = flag;
try { rmSync(flag, { force: true }); } catch { /* clean */ }

const runtime = new AgentRuntime();
const sleep = (ms: number) => new Promise((resolveDone) => setTimeout(resolveDone, ms));
async function waitFor<T>(label: string, read: () => T | undefined, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (value !== undefined) return value; await sleep(25); }
  throw new Error(`timeout: ${label}`);
}

try {
  const failedRunId = await runtime.start({ projectRoot, name: `retry-smoke-${Date.now().toString(36)}`, taskTitle: 'Zero-cost retry smoke', initialTask: '' });
  const failed = await waitFor('controlled failure', () => runtime.list().find((item) => item.runId === failedRunId && item.status === 'failed'));
  const selected = runtime.list().find((item) => item.runId === failedRunId);
  if (!selected || failed.exitCode !== 23) throw new Error('failed run was not selectable/auditable');
  const retryRunId = await runtime.retry(failedRunId);
  const request = await waitFor('valid retry RPC', () => runtime.list().find((item) => item.runId === retryRunId)?.pendingUiRequests[0]);
  await runtime.waitUntilReady(retryRunId, 5_000);
  await runtime.respondToExtensionUI(retryRunId, { id: request.id, confirmed: true });
  const done = await waitFor('retry done', () => runtime.list().find((item) => item.runId === retryRunId && item.status === 'done'));
  if (done.retryOfRunId !== failedRunId || done.rootRunId !== failedRunId || done.retryAttempt !== 1) throw new Error('retry provenance mismatch');
  process.stdout.write(JSON.stringify({ ok: true, failed: { runId: failedRunId, exitCode: failed.exitCode }, retry: { runId: retryRunId, status: done.status, rpcEvents: done.events.length }, cost: 0 }, null, 2));
} finally {
  await runtime.shutdownAll();
  try { rmSync(flag, { force: true }); } catch { /* clean */ }
  delete process.env.AGENTFLUX_DESKTOP_LIVE_TEST;
  delete process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION;
  delete process.env.AGENTFLUX_RETRY_SMOKE_FLAG;
}

if (existsSync(flag)) process.exitCode = 1;
