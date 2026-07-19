/**
 * Opt-in real-provider matrix for Desktop AgentRuntime.
 *
 * A: critical V2 -> steer -> ACK
 * B: abort -> SharedBoard cancelled -> graceful stop -> done
 * C: crash with delivered V2 -> lease-conflict probe -> 30s takeover -> idle prompt -> ACK attempt 2
 *
 * This script is intentionally not part of Vitest. It always cleans up every PID it starts,
 * stops at the first failed stage, and emits one JSON report to stdout.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageBus } from '../../../src/core/message-bus.ts';

type Snapshot = {
  runId: string; name: string; pid: number | null; status: string;
  events: Array<{ type: string; timestamp: number; data?: any }>;
  stderrSummary: string; exitCode: number | null; exitSignal: string | null;
};
type Runtime = {
  start(options: { projectRoot: string; name: string; initialTask?: string }): Promise<string>;
  list(): Snapshot[];
  prompt(runId: string, prompt: string): Promise<void>;
  abort(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  shutdownAll(): Promise<void>;
  on(event: string, listener: (snapshot: Snapshot) => void): void;
};

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, '../../..');
const desktopRoot = resolve(import.meta.dirname, '../..');
const { AgentRuntime } = require(join(desktopRoot, 'dist-electron', 'electron', 'agent-runtime.js')) as {
  AgentRuntime: new () => Runtime;
};

process.env.AGENTFLUX_PI_MODEL = 'octopus-anthropic/deepseek-v4-flash';
process.env.AGENTFLUX_PI_THINKING = 'off';

const fluxDir = join(projectRoot, '.agentflux');
const registryPath = join(fluxDir, 'shared', 'agents', '_registry.json');
const telemetryPath = join(fluxDir, 'events.jsonl');
const runtime = new AgentRuntime();
const bus = new MessageBus(fluxDir);
const startedAt = Date.now();
const prefix = `desktop-live-${startedAt.toString(36)}`;
const transitions = new Map<string, string[]>();
const trackedPids = new Set<number>();
const trackedRuns = new Set<string>();
const progress = (stage: string, detail: Record<string, unknown>) => {
  process.stderr.write(`[desktop-live] ${JSON.stringify({ at: new Date().toISOString(), stage, ...detail })}\n`);
};

runtime.on('record-update', (snapshot) => {
  const values = transitions.get(snapshot.runId) ?? [];
  if (values.at(-1) !== snapshot.status) values.push(snapshot.status);
  transitions.set(snapshot.runId, values);
  if (snapshot.pid) trackedPids.add(snapshot.pid);
});

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

function snapshot(runId: string): Snapshot {
  const value = runtime.list().find((item) => item.runId === runId);
  if (!value) throw new Error(`missing Desktop snapshot ${runId}`);
  return value;
}

function readRegistry(): any[] {
  if (!existsSync(registryPath)) return [];
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

function registryAgent(name: string): any | undefined {
  return readRegistry().find((item) => item.name === name);
}

function eventTypes(runId: string): string[] {
  return snapshot(runId).events.map((event) => event.type);
}

function assistantText(runId: string): string {
  return snapshot(runId).events
    .flatMap((event) => event?.data?.message?.content ?? event?.data?.content ?? [])
    .map((block) => typeof block === 'string' ? block : block?.text ?? '')
    .join('\n');
}

function runtimeEvidence(runId: string): Record<string, unknown> {
  const current = snapshot(runId);
  return {
    name: current.name, runId, pid: current.pid, status: current.status,
    transitions: [...(transitions.get(runId) ?? [])], exitCode: current.exitCode,
    exitSignal: current.exitSignal, eventTypes: eventTypes(runId),
    extensionErrors: current.events.filter((event) => event.type === 'extension_error'),
    stderr: current.stderrSummary,
  };
}

function telemetryEvidence(runIds: string[], names: string[]): Record<string, unknown> {
  if (!existsSync(telemetryPath)) return { events: [], tokens: {}, costUsd: 0 };
  const all = readFileSync(telemetryPath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const protocol = all.filter((event) => event.ts >= startedAt && (
    runIds.includes(event.runId) || names.includes(event.agent)
  ));
  const sessionIds = new Set(protocol.map((event) => event.sessionId).filter(Boolean));
  for (const name of names) {
    const sessionFile = registryAgent(name)?.sessionFile;
    if (sessionFile) sessionIds.add(sessionFile);
  }
  const events = all.filter((event) => event.ts >= startedAt && sessionIds.has(event.sessionId));
  const samples = events.filter((event) => event.type === 'cache.sample');
  return {
    protocol,
    eventCounts: Object.fromEntries([...new Set(events.map((event) => event.type))].map((type) => [
      type, events.filter((event) => event.type === type).length,
    ])),
    tokens: {
      input: samples.reduce((sum, event) => sum + (event.input ?? 0), 0),
      output: samples.reduce((sum, event) => sum + (event.output ?? 0), 0),
      cacheRead: samples.reduce((sum, event) => sum + (event.cacheRead ?? 0), 0),
      cacheWrite: samples.reduce((sum, event) => sum + (event.cacheWrite ?? 0), 0),
    },
    costUsd: samples.reduce((sum, event) => sum + (event.costUsd ?? 0), 0),
  };
}

async function start(name: string): Promise<string> {
  const runId = await runtime.start({ projectRoot, name, initialTask: '' });
  trackedRuns.add(runId);
  await waitFor(`${name} pid`, () => snapshot(runId).pid ?? undefined, 10_000);
  progress('runtime-start', { name, runId, pid: snapshot(runId).pid });
  return runId;
}

async function forceCrash(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGKILL');
    return;
  }
  await new Promise<void>((resolveDone, reject) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false });
    let stderr = '';
    killer.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    killer.on('error', reject);
    killer.on('exit', (code) => code === 0 ? resolveDone() : reject(new Error(`taskkill ${pid} failed (${code}): ${stderr}`)));
  });
}

async function stageA(): Promise<Record<string, unknown>> {
  const stageStarted = Date.now();
  const name = `${prefix}-steer`;
  const runId = await start(name);
  progress('A-critical-steer', { phase: 'started', name, runId, pid: snapshot(runId).pid });
  await waitFor('A registry', () => registryAgent(name)?.instanceId === runId ? registryAgent(name) : undefined, 20_000);
  await runtime.prompt(runId, '调用 bash 执行 node -e "setTimeout(()=>{},6000)"；随后只回复 BASE。');
  await waitFor('A running tool', () => eventTypes(runId).includes('tool_execution_start') ? true : undefined, 45_000);
  const sent = bus.sendDirect('desktop-live-controller', name, 'steer', '立即改变最终答复：只回复 STEER_OK。', {
    priority: 'critical', correlationId: runId, senderInstanceId: prefix,
    dedupeKey: `${prefix}-critical-steer`,
  });
  const delivery = await waitFor('A acknowledged', () => {
    const current = bus.getDelivery(sent.envelope.id, name);
    return current?.status === 'acknowledged' ? current : undefined;
  }, 90_000);
  await waitFor('A STEER_OK', () => assistantText(runId).includes('STEER_OK') ? true : undefined, 10_000);
  const evidence = runtimeEvidence(runId);
  await runtime.stop(runId);
  await waitFor('A shared done', () => registryAgent(name)?.status === 'done' ? true : undefined, 10_000);
  return { ...evidence, messageId: sent.envelope.id, delivery, sharedBoard: registryAgent(name), durationMs: Date.now() - stageStarted };
}

async function stageB(): Promise<Record<string, unknown>> {
  const stageStarted = Date.now();
  const name = `${prefix}-abort`;
  const runId = await start(name);
  progress('B-abort', { phase: 'started', name, runId, pid: snapshot(runId).pid });
  await waitFor('B registry', () => registryAgent(name)?.instanceId === runId ? true : undefined, 20_000);
  await runtime.prompt(runId, '调用 bash 执行 node -e "setTimeout(()=>{},20000)"；随后只回复 BASE。');
  await waitFor('B running tool', () => eventTypes(runId).includes('tool_execution_start') ? true : undefined, 45_000);
  await runtime.abort(runId);
  await waitFor('B Desktop aborted', () => snapshot(runId).status === 'aborted' ? true : undefined, 10_000);
  const cancelled = await waitFor('B SharedBoard cancelled', () => registryAgent(name)?.status === 'cancelled' ? registryAgent(name) : undefined, 20_000);
  const controllableBeforeStop = snapshot(runId).exitCode === null;
  await runtime.stop(runId);
  const done = await waitFor('B SharedBoard done', () => registryAgent(name)?.status === 'done' ? registryAgent(name) : undefined, 15_000);
  return {
    ...runtimeEvidence(runId), cancelled, done, controllableBeforeStop,
    durationMs: Date.now() - stageStarted,
  };
}

async function stageC(): Promise<Record<string, unknown>> {
  const stageStarted = Date.now();
  const name = `${prefix}-recover`;
  const crashedRunId = await start(name);
  progress('C-crash-recovery', { phase: 'started', name, runId: crashedRunId, pid: snapshot(crashedRunId).pid });
  const initialAgent = await waitFor('C registry', () => registryAgent(name)?.instanceId === crashedRunId ? registryAgent(name) : undefined, 20_000);
  await runtime.prompt(crashedRunId, '调用 bash 执行 node -e "setTimeout(()=>{},20000)"；随后只回复 BASE。');
  await waitFor('C running tool', () => eventTypes(crashedRunId).includes('tool_execution_start') ? true : undefined, 45_000);
  const sent = bus.sendDirect('desktop-live-controller', name, 'task', '只回复 RECOVER_OK。', {
    priority: 'normal', correlationId: crashedRunId, senderInstanceId: prefix,
    dedupeKey: `${prefix}-crash-recover`,
  });
  const delivered = await waitFor('C first delivery', () => {
    const current = bus.getDelivery(sent.envelope.id, name);
    return current?.status === 'delivered' && current.attempts === 1 ? current : undefined;
  }, 20_000);
  const crashedPid = snapshot(crashedRunId).pid!;
  await forceCrash(crashedPid);
  await waitFor('C process crash observed', () => snapshot(crashedRunId).exitCode !== null || snapshot(crashedRunId).exitSignal !== null ? true : undefined, 10_000);
  const afterCrash = bus.getDelivery(sent.envelope.id, name);
  if (afterCrash?.status !== 'delivered') throw new Error(`C delivery changed after crash: ${afterCrash?.status}`);

  // Same name is available in Desktop after exit, but the core runtime lease must fail closed.
  const probeRunId = await start(name);
  progress('C-lease-probe', { name, runId: probeRunId, pid: snapshot(probeRunId).pid });
  await waitFor('C lease conflict stderr', () => snapshot(probeRunId).stderrSummary.includes('runtime name already leased') ? true : undefined, 15_000);
  const probeAgent = registryAgent(name);
  if (probeAgent?.instanceId !== crashedRunId) throw new Error('lease-conflict probe overwrote old registry instance');
  const probeEvidence = runtimeEvidence(probeRunId);
  await runtime.stop(probeRunId);

  const leaseAnchor = Date.parse(registryAgent(name)?.heartbeatAt ?? initialAgent.heartbeatAt);
  const waitMs = Math.max(0, leaseAnchor + 31_000 - Date.now());
  if (waitMs > 0) await sleep(waitMs);

  const recoveryRunId = await start(name);
  progress('C-recovery', { name, runId: recoveryRunId, pid: snapshot(recoveryRunId).pid });
  await waitFor('C takeover registry', () => registryAgent(name)?.instanceId === recoveryRunId ? registryAgent(name) : undefined, 15_000);
  const acknowledged = await waitFor('C recovery ACK attempt 2', () => {
    const current = bus.getDelivery(sent.envelope.id, name);
    return current?.status === 'acknowledged' && current.attempts === 2 ? current : undefined;
  }, 90_000);
  await waitFor('C RECOVER_OK', () => assistantText(recoveryRunId).includes('RECOVER_OK') ? true : undefined, 10_000);
  const recoveryEvidence = runtimeEvidence(recoveryRunId);
  await runtime.stop(recoveryRunId);
  await waitFor('C shared done', () => registryAgent(name)?.status === 'done' ? true : undefined, 15_000);
  return {
    name, messageId: sent.envelope.id, firstDelivery: delivered, afterCrash,
    crashed: runtimeEvidence(crashedRunId), probe: probeEvidence,
    recovery: recoveryEvidence, acknowledged, sharedBoard: registryAgent(name),
    leaseWaitMs: waitMs, durationMs: Date.now() - stageStarted,
  };
}

const report: Record<string, any> = {
  model: process.env.AGENTFLUX_PI_MODEL,
  thinking: process.env.AGENTFLUX_PI_THINKING,
  startedAt: new Date(startedAt).toISOString(),
  prefix,
  stages: {},
};

try {
  report.stages.A = await stageA();
  report.stages.B = await stageB();
  report.stages.C = await stageC();
  report.pass = true;
} catch (error: any) {
  report.pass = false;
  report.failedStage = !report.stages.A ? 'A' : !report.stages.B ? 'B' : 'C';
  report.error = error?.stack ?? String(error);
} finally {
  const names = runtime.list().filter((item) => item.name.startsWith(prefix)).map((item) => item.name);
  await runtime.shutdownAll().catch(() => undefined);
  await sleep(750);
  report.telemetry = telemetryEvidence([...trackedRuns], names);
  report.durationMs = Date.now() - startedAt;
  report.finishedAt = new Date().toISOString();
  report.residualPids = [...trackedPids].filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  report.finalSnapshots = runtime.list().filter((item) => item.name.startsWith(prefix));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (report.pass !== true || report.residualPids.length > 0) process.exitCode = 1;
