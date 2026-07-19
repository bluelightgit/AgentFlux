/** Opt-in live smoke for the compiled Electron AgentRuntime and real pi RPC. */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageBus } from '../../../src/core/message-bus.ts';

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, '../../..');
const desktopRoot = resolve(import.meta.dirname, '../..');
const { AgentRuntime } = require(join(desktopRoot, 'dist-electron', 'electron', 'agent-runtime.js')) as {
  AgentRuntime: new () => {
    start(options: { projectRoot: string; name: string; initialTask?: string }): Promise<string>;
    list(): Array<Record<string, any>>;
    stop(runId: string): Promise<void>;
    prompt(runId: string, prompt: string): Promise<void>;
    shutdownAll(): Promise<void>;
    on(event: string, listener: (payload: any) => void): void;
  };
};

process.env.AGENTFLUX_PI_MODEL = process.env.AGENTFLUX_PI_MODEL || 'octopus-anthropic/deepseek-v4-flash';
process.env.AGENTFLUX_PI_THINKING = process.env.AGENTFLUX_PI_THINKING || 'off';

const sleep = (ms: number) => new Promise((resolveDone) => setTimeout(resolveDone, ms));
async function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const runtime = new AgentRuntime();
const transitions = new Map<string, string[]>();
runtime.on('record-update', (snapshot: any) => {
  const list = transitions.get(snapshot.runId) ?? [];
  if (list[list.length - 1] !== snapshot.status) list.push(snapshot.status);
  transitions.set(snapshot.runId, list);
});

const report: Record<string, any> = {
  startedAt: new Date().toISOString(),
  model: process.env.AGENTFLUX_PI_MODEL,
  thinking: process.env.AGENTFLUX_PI_THINKING,
  checks: {},
};
let pids: number[] = [];

try {
  const baseName = `desktop-smoke-${Date.now().toString(36)}`;
  const runA = await runtime.start({ projectRoot, name: baseName, initialTask: '' });
  const runB = await runtime.start({ projectRoot, name: baseName, initialTask: '' });
  const initial = runtime.list();
  pids = initial.map((item) => item.pid).filter((pid): pid is number => typeof pid === 'number');
  const a = initial.find((item) => item.runId === runA)!;
  const b = initial.find((item) => item.runId === runB)!;
  report.runtimes = { A: { runId: runA, name: a.name, pid: a.pid }, B: { runId: runB, name: b.name, pid: b.pid } };
  report.checks.uniqueIdentity = a.name !== b.name && a.pid !== b.pid;

  const registryPath = join(projectRoot, '.agentflux', 'shared', 'agents', '_registry.json');
  await waitFor('both RPC runtimes registered', () => {
    if (!existsSync(registryPath)) return undefined;
    const agents = readJson(registryPath);
    const registered = agents.filter((item: any) => item.name === a.name || item.name === b.name);
    return registered.length === 2 && registered.every((item: any) => Date.parse(item.lastSeen) >= Date.parse(report.startedAt))
      ? true : undefined;
  }, 30_000);

  await runtime.stop(runA);
  report.checks.stopSelected = runtime.list().find((item) => item.runId === runA)?.status === 'aborted'
    && runtime.list().find((item) => item.runId === runB)?.pid === b.pid;
  report.checks.stoppedRegistryTerminal = await waitFor('stopped A registry terminal', () => {
    const stopped = readJson(registryPath).find((item: any) => item.name === a.name);
    return stopped && ['done', 'failed'].includes(stopped.status) ? true : undefined;
  }, 10_000).catch(() => false);

  await runtime.prompt(runB, '请调用 bash 执行 node -e "setTimeout(()=>{},3000)"，完成后只回复 BASE_OK。');
  await waitFor('B running', () => {
    const status = runtime.list().find((item) => item.runId === runB)?.status;
    return status === 'running' ? status : undefined;
  }, 20_000);

  const bus = new MessageBus(join(projectRoot, '.agentflux'));
  const sent = bus.sendDirect('desktop-smoke-leader', b.name, 'task', '只回复 INBOX_OK，不调用工具，不解释。', {
    priority: 'normal', correlationId: runB, senderInstanceId: 'desktop-live-smoke',
    dedupeKey: `desktop-live-${runB}`,
  });
  report.messageId = sent.envelope.id;

  const delivery = await waitFor('V2 acknowledged', () => {
    const current = bus.getDelivery(sent.envelope.id, b.name);
    return current?.status === 'acknowledged' ? current : undefined;
  });
  const terminal = await waitFor('B terminal', () => {
    const current = runtime.list().find((item) => item.runId === runB);
    return current && ['done', 'failed'].includes(current.status) ? current : undefined;
  });
  report.checks.inboxPumpAcknowledged = delivery.status === 'acknowledged';
  report.checks.runtimeTerminal = terminal.status;

  const assistantText = (terminal.events ?? [])
    .flatMap((event: any) => event?.data?.message?.content ?? event?.data?.content ?? [])
    .map((block: any) => block?.text ?? '')
    .join('\n');
  report.checks.inboxResponseObserved = assistantText.includes('INBOX_OK');

  const rawRegistry = readJson(registryPath);
  const rawAgent = rawRegistry.find((item: any) => item.name === b.name);
  report.rawSharedBoardAgent = rawAgent;

  const dagPath = join(projectRoot, '.agentflux', 'runtime', 'dag-state.json');
  const rawDag = existsSync(dagPath) ? readJson(dagPath) : null;

  (globalThis as any).window = {
    api: {
      exists: async (path: string) => existsSync(path),
      readFile: async (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '',
      listDirectory: async (path: string) => existsSync(path) ? readdirSync(path) : [],
      readDirectoryFiles: async (path: string) => existsSync(path)
        ? readdirSync(path, { withFileTypes: true }).filter((item) => item.isFile()).map((item) => ({
          name: item.name, content: readFileSync(join(path, item.name), 'utf8'),
        })) : [],
    },
  };
  const { readAgentStatus } = await import('../../src/lib/agent-status-enhanced.ts');
  const desktopView = await readAgentStatus(join(projectRoot, '.agentflux'));
  const parsedMessage = desktopView.messagesV2.find((item) => item.id === sent.envelope.id);
  const parsedAgent = desktopView.blackboardAgents.find((item) => item.name === b.name);
  report.checks.desktopV2MatchesRaw = parsedMessage?.deliveries.some((item) =>
    item.recipient === b.name && item.status === delivery.status) ?? false;
  report.checks.desktopSharedBoardMatchesRaw = parsedAgent?.status === rawAgent?.status;
  report.checks.desktopDagMatchesRaw = !rawDag || (
    desktopView.dagState?.executionId === rawDag.executionId
    && desktopView.dagState?.status === rawDag.status
    && JSON.stringify(desktopView.dagState?.nodeIds) === JSON.stringify(rawDag.nodeIds)
  );
  report.transitions = Object.fromEntries(transitions);
} catch (error: any) {
  report.error = error?.stack ?? String(error);
  report.failureSnapshots = runtime.list().map((item) => ({
    runId: item.runId,
    name: item.name,
    pid: item.pid,
    status: item.status,
    exitCode: item.exitCode,
    stderrSummary: item.stderrSummary,
    events: item.events,
  }));
} finally {
  await runtime.shutdownAll();
  await sleep(750);
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  report.residualProcesses = pids.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (report.error || Object.values(report.checks).some((value) => value === false || value === 'failed') || report.residualProcesses.length > 0) {
  process.exitCode = 1;
}
