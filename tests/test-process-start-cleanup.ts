import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { runAgent, getActiveAgentRunIds, canCompletionProofRecover } from '../src/agents/agent-runner';
import { getProcessIdentity } from '../src/core/process-identity';
import { isProcessAlive } from '../src/core/fs-lock';

const root = mkdtempSync(join(tmpdir(), 'agentflux-start-cleanup-'));
const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldPath = process.env.PATH;
process.env.HOME = root; process.env.USERPROFILE = root;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 250; i++) { if (fn()) return; await pause(20); }
  assert.fail('fixture coordination timeout');
}
const agent: Parameters<typeof runAgent>[0]['agent'] = { name: 'startup-cleanup', role: 'assistant', description: 'Fixture', systemPrompt: 'Only execute the fixture.', tools: ['read'] };

async function registryFailure(unknown: boolean) {
  const cwd = join(root, unknown ? 'unknown' : 'known'); mkdirSync(cwd);
  const runtime = join(cwd, '.agentflux/runtime');
  const release = join(cwd, 'release'), ready = join(cwd, 'ready'), helper = join(cwd, 'helper.cjs');
  writeFileSync(join(cwd, 'proof.txt'), 'PROOF_EXISTS');
  writeFileSync(helper, `const fs=require('node:fs');
const msg={type:'message_end',message:{role:'assistant',stopReason:'stop',model:'fixture',content:[{type:'text',text:'STARTUP_PAYLOAD'}],usage:{input:2,output:1,cost:{total:0.001}}}};
process.stdout.write(JSON.stringify(msg)+'\\n',()=>fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)));
const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(poll);process.exit(0)}},20);
setTimeout(()=>process.exit(2),20000).unref();`);
  let publications = 0, settled = false;
  if (unknown) process.env.PATH = join(root, 'no-system-probes');
  const pending = runAgent({
    agent, task: 'startup failure fixture', cwd, sessionId: 'startup-fixture', prefixLayout: false, maxRetries: 2,
    lockFiles: ['protected.txt'],
    invocationOverride: { command: process.execPath, args: [helper] },
    runRegistry: { markRunning: () => { publications++; throw new Error('injected registry publication failure'); } },
    completionProof: { files: [{ path: 'proof.txt', contains: ['PROOF_EXISTS'] }] },
  });
  pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await waitFor(() => publications > 0);
    if (process.platform === 'win32') {
      // This also protects the online-output regression: the probe must not block this timer.
      await pause(100);
      assert.equal(settled, false, 'publication failure must not settle before cleanup');
      assert.ok(getActiveAgentRunIds().length > 0, 'local ownership survives startup failure');
      const early = JSON.parse(readFileSync(join(runtime, 'runs.json'), 'utf8')).runs[0];
      assert.ok(['starting', 'running', 'stop_requested'].includes(early.status));
      assert.equal(readdirSync(join(cwd, '.agentflux/shared/locks')).filter(name => name.endsWith('.lock')).length, 1, 'file ownership must survive pending cleanup');
    }
    if (unknown) {
      await waitFor(() => existsSync(ready));
      await pause(200);
      assert.ok(isProcessAlive(Number(readFileSync(ready, 'utf8'))));
      assert.equal(settled, false, 'unknown birth cannot pretend the live process exited');
      writeFileSync(release, 'release');
    }
    const result = await pending;
    assert.equal(result.exitCode, 72);
    assert.equal(result.retryCount, 0);
    assert.equal(publications, 1);
    assert.match(result.errorMessage ?? '', /Run Registry start failed/);
    assert.equal(result.completionProof?.passed, true, 'artifact proof does not erase the Host failure');
    if (unknown) assert.match(result.errorMessage ?? '', /termination refused or failed/i);
    if (existsSync(ready)) {
      assert.equal(result.usage.cost, 0.001, 'emitted usage survives the failed launch publication');
      assert.equal(isProcessAlive(Number(readFileSync(ready, 'utf8'))), false);
    }
    const terminal = JSON.parse(readFileSync(join(runtime, 'runs.json'), 'utf8')).runs;
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].status, 'failed');
    assert.equal(terminal[0].costUsd, result.usage.cost);
    assert.equal(readdirSync(join(cwd, '.agentflux/shared/locks')).filter(name => name.endsWith('.lock')).length, 0);
    assert.equal(getActiveAgentRunIds().length, 0);
    console.log(`PASS registry publication failure retains ownership and usage (${unknown ? 'unknown birth' : 'verified stop'})`);
  } finally {
    writeFileSync(release, 'release');
    await pending.catch(() => undefined);
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  }
}

async function acceptedSignalWithoutExit() {
  const cwd = join(root, 'signal-pending'); mkdirSync(cwd);
  const release = join(cwd, 'release'), ready = join(cwd, 'ready'), helper = join(cwd, 'helper.cjs');
  writeFileSync(helper, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
const p=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(p);process.exit(0)}},20);
setTimeout(()=>process.exit(2),20000).unref();`);
  const cp = createRequire(import.meta.url)('node:child_process');
  const nativeSpawnSync = cp.spawnSync, nativeTimeout = globalThis.setTimeout;
  const controller = new AbortController();
  let settled = false, calls = 0;
  const pending = runAgent({ agent, task: 'accepted signal without exit', cwd, sessionId: 'signal-fixture', prefixLayout: false,
    signal: controller.signal, invocationOverride: { command: process.execPath, args: [helper] } });
  pending.then(() => { settled = true; }, () => { settled = true; });
  const record = () => {
    const path = join(cwd, '.agentflux/runtime/runs.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).runs[0] : undefined;
  };
  try {
    await waitFor(() => existsSync(ready) && !!record()?.processIdentity);
    // Isolated test-only accepted taskkill receipt; the real child intentionally remains alive.
    cp.spawnSync = (command: string, ...args: any[]) => command === 'taskkill'
      ? (calls++, { pid: 0, status: 0, signal: null, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
      : nativeSpawnSync(command, ...args);
    syncBuiltinESMExports();
    // Advance only the grace check, not the model deadline or identity probe timeout.
    globalThis.setTimeout = ((callback: any, ms?: number, ...args: any[]) => nativeTimeout(callback, ms === 10_000 ? 50 : ms, ...args)) as typeof setTimeout;
    controller.abort();
    await waitFor(() => record()?.recentEvents?.some((event: any) => event.type === 'termination_pending'));
    assert.equal(calls, 1);
    assert.equal(settled, false);
    assert.ok(isProcessAlive(Number(readFileSync(ready, 'utf8'))));
    assert.ok(['starting', 'running', 'stop_requested'].includes(record().status));
    writeFileSync(release, 'release');
    assert.equal((await pending).exitCode, 130);
    assert.equal(record().status, 'cancelled');
    assert.equal(getActiveAgentRunIds().length, 0);
    console.log('PASS accepted signal and elapsed grace cannot substitute for actual exit');
  } finally {
    cp.spawnSync = nativeSpawnSync; syncBuiltinESMExports();
    globalThis.setTimeout = nativeTimeout;
    writeFileSync(release, 'release'); await pending.catch(() => undefined);
  }
}

try {
  getProcessIdentity(); // Warm only our own identity before the controlled Windows PATH failure.
  await registryFailure(false);
  if (process.platform === 'win32') { await registryFailure(true); await acceptedSignalWithoutExit(); }
  const missing = await runAgent({
    agent, task: 'missing executable', cwd: root, sessionId: 'missing-fixture', prefixLayout: false, maxRetries: 2,
    invocationOverride: { command: join(root, 'missing-executable'), args: [] },
  });
  assert.equal(missing.exitCode, 72);
  assert.equal(missing.retryCount, 0);
  assert.equal(missing.usage.cost, 0);
  assert.match(missing.errorMessage ?? '', /spawn error/);
  assert.equal(getActiveAgentRunIds().length, 0);
  assert.equal(canCompletionProofRecover({ exitCode: 72, output: 'done', errorMessage: 'ETIMEDOUT' }), false);
  console.log('PASS no-PID spawn errors are handled and cannot be retried or proof-recovered');
} finally {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  rmSync(root, { recursive: true, force: true });
}
