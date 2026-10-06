import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProcessIdentity, isProcessIdentity, type ProcessIdentity } from '../src/core/process-identity';
import { isLockOwnerActive, createProcessOwnerToken, parseOwnerPid } from '../src/core/fs-lock';
import { updateJsonStore } from '../src/core/json-store';
import { registerActiveContext, readActiveContext, pruneStaleActiveContext, activeContextPath } from '../src/core/active-context';
import { registerAgentRun, markAgentRunRunning, getAgentRun, reconcileStaleAgentRuns, bindAgentRunProcessIdentity, finishAgentRun } from '../src/core/run-registry';
import { registerTask, getTaskExecution, getTask } from '../src/core/task-registry';
import { createTaskExecutionPlan } from '../src/core/task-execution';
import { MessageBus } from '../src/core/message-bus';
import { SharedBoard } from '../src/core/shared-board';
import { DEFAULT_CONFIG } from '../src/core/types';

const root = mkdtempSync(join(tmpdir(), 'agentflux-process-identity-'));
const priorHome = process.env.HOME, priorProfile = process.env.USERPROFILE;
process.env.HOME = join(root, 'home'); process.env.USERPROFILE = join(root, 'home');
mkdirSync(join(root, 'home'), { recursive: true });
let passed = 0;
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const old = new Date(Date.now() - 120_000);
const identity = getProcessIdentity();
assert.ok(identity, 'Current test platform must provide actual birth evidence');
const different: ProcessIdentity = { ...identity, birth: identity.birth.replace(/\d(?=\D*$)/, digit => digit === '0' ? '1' : '0') };
assert.ok(isProcessIdentity(different));
assert.notEqual(different.birth, identity.birth);
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${name}`); };
try {
  check('new, legacy, corrupt and reused lock identities', () => {
    const token = createProcessOwnerToken();
    assert.equal(parseOwnerPid(token), process.pid);
    assert.equal(isLockOwnerActive(token), true);
    assert.equal(isLockOwnerActive(`${process.pid}:legacy`), true);
    assert.equal(isLockOwnerActive(JSON.stringify({ version: 1, owner: `${process.pid}:old`, identity: different })), false);
    assert.equal(isLockOwnerActive(JSON.stringify({ version: 1, owner: `${process.pid}:bad`, identity: { ...identity, birth: 'garbage' } })), true);
    assert.equal(isLockOwnerActive('{broken'), true);
  });
  check('active-context filters reused birth and retains current/legacy owners', () => {
    const cwd = join(root, 'leases');
    registerActiveContext(cwd, { name: 'current', context: 'main', task: 'current' });
    registerActiveContext(cwd, { name: 'old', context: 'main', task: 'old' });
    registerActiveContext(cwd, { name: 'legacy', context: 'main', task: 'legacy' });
    const path = activeContextPath(cwd), state = json(path);
    state.entries.find((x: any) => x.name === 'old').processIdentity = different;
    delete state.entries.find((x: any) => x.name === 'legacy').processIdentity;
    save(path, state);
    assert.deepEqual(readActiveContext(cwd).entries.map(x => x.name), ['current', 'legacy']);
    assert.deepEqual(pruneStaleActiveContext(cwd), ['old']);
    assert.equal(json(path).entries.length, 2);
  });
  for (const owner of ['same', 'reused', 'legacy', 'missing'] as const) {
    check(`Run reconciliation respects ${owner} Task owner identity`, () => {
      const cwd = join(root, owner), fluxDir = join(cwd, '.agentflux');
      const plan = createTaskExecutionPlan({ task: `owner ${owner}`, operation: 'new', selectedBy: 'main_agent', budget: DEFAULT_CONFIG.budget });
      registerTask(fluxDir, 'session', plan, 'running', owner === 'missing' ? {} : { ownerPid: process.pid });
      assert.deepEqual(getTaskExecution(fluxDir, plan.executionId)?.ownerIdentity, owner === 'missing' ? undefined : identity);
      const taskPath = join(fluxDir, 'runtime', 'tasks.json');
      if (owner !== 'same') {
        const tasks = json(taskPath);
        if (owner === 'reused') tasks.executions[0].ownerIdentity = different;
        else delete tasks.executions[0].ownerIdentity;
        save(taskPath, tasks);
      }
      registerAgentRun(fluxDir, { id: 'old-run', taskId: plan.taskId, executionId: plan.executionId, sessionId: 'session', agent: 'worker', role: 'assistant', currentTask: 'old birth', kind: 'ephemeral' });
      markAgentRunRunning(fluxDir, 'old-run', process.pid, 1);
      const runPath = join(fluxDir, 'runtime', 'runs.json'), runs = json(runPath);
      runs.runs[0].processIdentity = different;
      save(runPath, runs);
      reconcileStaleAgentRuns(fluxDir, { now: new Date(Date.now() + 31_000) });
      assert.equal(getAgentRun(fluxDir, 'old-run')?.status, 'failed');
      assert.deepEqual(getAgentRun(fluxDir, 'old-run')?.processIdentity, different);
      assert.equal(getTask(fluxDir, plan.taskId)?.status, owner === 'reused' ? 'failed' : 'running');
    });
  }
  check('birth binding rejects another attempt, changed identity and terminal history', () => {
    const fluxDir = join(root, 'binding', '.agentflux');
    registerAgentRun(fluxDir, { id: 'bound', sessionId: 's', agent: 'worker', role: 'assistant', currentTask: 'binding', kind: 'ephemeral' });
    markAgentRunRunning(fluxDir, 'bound', process.pid, 1, { processIdentity: undefined });
    bindAgentRunProcessIdentity(fluxDir, 'bound', 1, identity);
    const path = join(fluxDir, 'runtime', 'runs.json'), before = readFileSync(path, 'utf8');
    assert.throws(() => bindAgentRunProcessIdentity(fluxDir, 'bound', 2, identity), /another or terminal/);
    assert.throws(() => bindAgentRunProcessIdentity(fluxDir, 'bound', 1, different), /immutable/);
    assert.throws(() => markAgentRunRunning(fluxDir, 'bound', process.pid, 1, { processIdentity: different }), /immutable/);
    assert.equal(readFileSync(path, 'utf8'), before);
    finishAgentRun(fluxDir, 'bound', { status: 'completed' });
    const terminal = readFileSync(path, 'utf8');
    assert.throws(() => bindAgentRunProcessIdentity(fluxDir, 'bound', 1, identity), /another or terminal/);
    assert.equal(readFileSync(path, 'utf8'), terminal);
  });
  check('active Task owner cannot switch physical process', () => {
    const fluxDir = join(root, 'task-owner', '.agentflux');
    const plan = createTaskExecutionPlan({ task: 'immutable owner', selectedBy: 'main_agent', budget: DEFAULT_CONFIG.budget });
    registerTask(fluxDir, 's', plan, 'running', { ownerPid: process.pid });
    const path = join(fluxDir, 'runtime', 'tasks.json'), before = readFileSync(path, 'utf8');
    assert.throws(() => registerTask(fluxDir, 's', plan, 'running', { ownerPid: 99999999 }), /owner is immutable/);
    assert.equal(readFileSync(path, 'utf8'), before);
  });
  check('unpublished launch is deferred rather than assumed dead', () => {
    const fluxDir = join(root, 'unpublished', '.agentflux');
    registerAgentRun(fluxDir, { id: 'pending', sessionId: 's', agent: 'worker', role: 'assistant', currentTask: 'launch gap', kind: 'ephemeral' });
    assert.deepEqual(reconcileStaleAgentRuns(fluxDir, { now: new Date(Date.now() + 60_000) }), []);
    assert.equal(getAgentRun(fluxDir, 'pending')?.status, 'starting');
  });
  check('legacy live Run is deferred, not silently assigned current birth', () => {
    const fluxDir = join(root, 'legacy-run', '.agentflux');
    registerAgentRun(fluxDir, { id: 'legacy', sessionId: 's', agent: 'worker', role: 'assistant', currentTask: 'legacy', kind: 'ephemeral' });
    markAgentRunRunning(fluxDir, 'legacy', process.pid, 1);
    const path = join(fluxDir, 'runtime', 'runs.json'), state = json(path);
    delete state.runs[0].processIdentity; save(path, state);
    reconcileStaleAgentRuns(fluxDir, { now: new Date(Date.now() + 31_000) });
    assert.equal(getAgentRun(fluxDir, 'legacy')?.status, 'running');
    assert.equal(getAgentRun(fluxDir, 'legacy')?.processIdentity, undefined);
  });
  check('JSON store takes over a proven replaced birth but not unknown metadata', () => {
    const path = join(root, 'store.json'), lock = `${path}.lock`;
    const update = () => updateJsonStore(path, () => ({ count: 0 }), (v: any): v is { count: number } => typeof v?.count === 'number', v => v.count++, { lockTimeoutMs: 50, staleLockMs: 100 });
    writeFileSync(lock, JSON.stringify({ version: 1, owner: `${process.pid}:old`, identity: different })); utimesSync(lock, old, old);
    update(); assert.equal(json(path).count, 1);
    const broken = JSON.stringify({ version: 1, owner: `${process.pid}:bad`, identity: { ...identity, birth: 'bad' } });
    writeFileSync(lock, broken); utimesSync(lock, old, old);
    assert.throws(update, /lock timeout/);
    assert.equal(readFileSync(lock, 'utf8'), broken);
  });
  check('Message V2 mutex recognizes a replaced birth', () => {
    const fluxDir = join(root, 'messages'), bus = new MessageBus(fluxDir);
    const path = join(fluxDir, 'shared', 'messages-v2', '.mutex.lock');
    writeFileSync(path, JSON.stringify({ version: 1, owner: `${process.pid}:old`, identity: different })); utimesSync(path, old, old);
    assert.ok(bus.sendDirect('main', 'receiver', 'handoff', 'body'));
  });
  check('SharedBoard mutex and file locks preserve unknown and release replaced birth', () => {
    const fluxDir = join(root, 'board'), board = new SharedBoard(fluxDir);
    const lockDir = join(fluxDir, 'shared', 'locks'); mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, '.mutex-blackboard.lock'), JSON.stringify({ token: 'old', ownerId: `${process.pid}-old`, ownerIdentity: different, timestamp: old.getTime() }));
    board.updateAgentStatus('worker', { status: 'idle' });
    assert.equal(board.acquireFileLock('first', 'file.txt'), true);
    const path = join(lockDir, readdirSync(lockDir).find(p => !p.startsWith('.') && p.endsWith('.lock'))!);
    const payload = json(path); payload.expiresAt = 0; payload.ownerIdentity = { ...identity, birth: 'invalid' }; save(path, payload);
    assert.equal(board.acquireFileLock('second', 'file.txt'), false);
    payload.ownerIdentity = different; save(path, payload);
    assert.equal(board.acquireFileLock('second', 'file.txt'), true);
    assert.equal(board.releaseFileLock('file.txt', 'second'), true);
  });
  console.log(`Process identity integration: ${passed} checks passed`);
} finally {
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
  rmSync(root, { recursive: true, force: true });
}
