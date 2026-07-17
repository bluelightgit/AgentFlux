/** Minimal post-fix live verification: base turn -> normal V2 follow-up -> ACK. */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageBus } from '../../../src/core/message-bus.ts';

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, '../../..');
const desktopRoot = resolve(import.meta.dirname, '../..');
const { AgentRuntime } = require(join(desktopRoot, 'dist-electron', 'agent-runtime.js'));

process.env.AGENTFLUX_PI_MODEL = 'octopus-anthropic/deepseek-v4-flash';
process.env.AGENTFLUX_PI_THINKING = 'off';

const sleep = (ms: number) => new Promise((resolveDone) => setTimeout(resolveDone, ms));
async function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const runtime = new AgentRuntime();
const startedAt = Date.now();
const name = `desktop-ack-${startedAt.toString(36)}`;
let pid: number | null = null;
let runId = '';
let messageId = '';
const report: Record<string, unknown> = { name, model: process.env.AGENTFLUX_PI_MODEL, startedAt };

try {
  runId = await runtime.start({ projectRoot, name, initialTask: '' });
  pid = runtime.list()[0]?.pid ?? null;
  report.runId = runId;
  report.pid = pid;

  const registryPath = join(projectRoot, '.agentflux', 'shared', 'agents', '_registry.json');
  const registered = await waitFor('registry', () => {
    if (!existsSync(registryPath)) return undefined;
    const agent = JSON.parse(readFileSync(registryPath, 'utf8')).find((item: any) => item.name === name);
    return agent && Date.parse(agent.lastSeen) >= startedAt ? agent : undefined;
  }, 30_000);

  await runtime.prompt(runId, '请调用 bash 执行 node -e "setTimeout(()=>{},2000)"，完成后只回复 BASE_OK。');
  await waitFor('base running', () => runtime.list()[0]?.status === 'running' ? true : undefined, 45_000);

  const bus = new MessageBus(join(projectRoot, '.agentflux'));
  const sent = bus.sendDirect('desktop-live-leader', name, 'task', '只回复 INBOX_OK，不调用工具，不解释。', {
    priority: 'normal', correlationId: runId, senderInstanceId: 'desktop-minimal-live',
    dedupeKey: `desktop-ack-${runId}`,
  });
  messageId = sent.envelope.id;
  report.messageId = messageId;

  const delivery = await waitFor('acknowledged delivery', () => {
    const current = bus.getDelivery(messageId, name);
    return current?.status === 'acknowledged' ? current : undefined;
  });
  await waitFor('runtime terminal', () => runtime.list()[0]?.status === 'done' ? true : undefined);

  const sessionFile = registered.sessionFile as string;
  const session = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8') : '';
  report.baseObserved = session.includes('BASE_OK');
  report.inboxObserved = session.includes('INBOX_OK') && session.includes(messageId);
  report.delivery = delivery;
  report.pass = report.baseObserved === true && report.inboxObserved === true;
} catch (error: any) {
  report.pass = false;
  report.error = error?.stack ?? String(error);
  report.snapshot = runtime.list();
} finally {
  await runtime.shutdownAll();
  await sleep(500);
  report.durationMs = Date.now() - startedAt;
  report.residualProcess = pid == null ? false : (() => {
    try { process.kill(pid!, 0); return true; } catch { return false; }
  })();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (report.pass !== true || report.residualProcess === true) process.exitCode = 1;
