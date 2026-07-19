/**
 * AgentRuntime 单元测试 — 全新版本，覆盖 Doc 27 所有测试门
 *
 * 测试门：
 * 1. spawn 精确参数 — --mode rpc --approve -e <entry> --name <name>，shell: false
 * 2. 两个独立进程 — 两次 start() 产生不同 runId、不同 PID、各自 stdin 写入
 * 3. LF 碎片逐字节分帧 — 跨多个 chunk 的字节碎片经自定义分帧器正确还原为 JSONL 行
 * 4a. 四种 RPC 命令 (prompt/steer/follow_up/abort) 均使用 {id, type, message} 精确格式
 * 4b. incoming status 映射 — running/blocked/done/failed/aborted 及其别名
 * 5. abort 不杀进程 vs stop 杀选中进程 — abort 仅发 RPC，stop 杀死进程树
 * 6. 退出状态可观察 — 进程 exit 后 record 仍可访问，含 exitCode/exitSignal
 * 7a. 空/undefined 参数抛出明确错误
 * 7b. 非绝对路径/目录不存在/缺少 entry.ts 抛出明确错误
 * 7c. 对不存在的 runId 操作抛出明确错误 + process error 事件
 * 8. EVENT_RUNTIME_EVENT — 每条真实 RPC JSON 产生独立事件
 * 9. agent_settled/agent_end 仅在当前状态不是 aborted/failed 时置 done
 * 10. response 顶层 success===false 置 failed
 * 11. killProcess 的 3 秒 fallback timer 在 taskkill exit/error 时 clear，resolve 只执行一次
 *
 * 使用 child_process mock 验证，不涉及真实 pi 进程。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

// ─── 前置 Mock（在 import 之前） ───────────────────────────────────────────

// Gate 7b 需要复用 existsSync 的 mock 引用
const { mockExistsSync } = vi.hoisted(() => {
  return { mockExistsSync: vi.fn(() => true) };
});

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  watch: vi.fn(),
  FSWatcher: class {
    close() {}
    closeAll() {}
  },
  default: {},
}));

// ─── Mock child_process：spawn 工厂 + 进程列表 ─────────────────────────────

interface MockChildProcess {
  pid: number;
  stdin: {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
    destroyed: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
  };
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
}

const { spawnMock, spawnSyncMock, mockProcesses } = vi.hoisted(() => {
  const processList: MockChildProcess[] = [];

  const spawnMock = vi.fn(
    (command: string, args: string[], _options: unknown) => {
      const pid = 1000 + processList.length;
      const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> =
        {};
      const stdinHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};

      const proc: MockChildProcess = {
        pid,
        stdin: {
          write: vi.fn((_line: string, _encoding: string, callback?: (error?: Error | null) => void) => {
            callback?.();
            return true;
          }),
          end: vi.fn(),
          on: vi.fn(
            (event: string, handler: (...args: unknown[]) => void) => {
              if (!stdinHandlers[event]) stdinHandlers[event] = [];
              stdinHandlers[event].push(handler);
            },
          ),
          emit: (event: string, ...args: unknown[]) => {
            for (const handler of stdinHandlers[event] ?? []) handler(...args);
          },
          destroyed: false,
          writableEnded: false,
          writableFinished: false,
        },
        stdout: {
          on: vi.fn(
            (event: string, handler: (...args: unknown[]) => void) => {
              if (!eventHandlers[event]) eventHandlers[event] = [];
              eventHandlers[event].push(handler);
            },
          ),
        },
        stderr: {
          on: vi.fn(
            (event: string, handler: (...args: unknown[]) => void) => {
              if (!eventHandlers[event]) eventHandlers[event] = [];
              eventHandlers[event].push(handler);
            },
          ),
        },
        on: vi.fn(
          (event: string, handler: (...args: unknown[]) => void) => {
            if (!eventHandlers[event]) eventHandlers[event] = [];
            eventHandlers[event].push(handler);
          },
        ),
        once: vi.fn(
          (event: string, handler: (...args: unknown[]) => void) => {
            if (!eventHandlers[event]) eventHandlers[event] = [];
            eventHandlers[event].push(handler);
          },
        ),
        kill: vi.fn(() => {
          proc.killed = true;
        }),
        killed: false,
        emit: (event: string, ...args: unknown[]) => {
          const handlers = eventHandlers[event] || [];
          for (const h of handlers) h(...args);
          // .once handlers: remove after first call
          if (eventHandlers[event]) {
            eventHandlers[event] = [];
          }
        },
      };

      processList.push(proc);
      return proc;
    },
  );

  return {
    spawnMock,
    spawnSyncMock: vi.fn(() => ({ stdout: 'v24.11.1\n', stderr: '', status: 0 })),
    mockProcesses: processList,
  };
});

vi.mock('child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
  ChildProcess: class {},
  exec: vi.fn((_cmd: string, cb?: (...args: unknown[]) => void) => {
    if (typeof cb === 'function') cb(null, '', '');
  }),
  execSync: vi.fn(),
  fork: vi.fn(),
  spawnSync: spawnSyncMock,
}));

// 抑制 process.kill 对不存在的进程抛出异常（killProcess 中调用）
vi.spyOn(process, 'kill').mockImplementation(
  (_pid: number, _signal?: string) => {
    // 在 mock 环境中静默处理
    return true;
  },
);

// ─── 导入被测模块 ───────────────────────────────────────────────────────────

import { AgentRuntime, resolveJavaScriptRuntime } from '../../electron/agent-runtime';

// ─── 辅助函数 ───────────────────────────────────────────────────────────────

/** 向指定 mock 进程的 stdout 推送完整 JSONL 行（自动追加 \n） */
function feedStdout(procIdx: number, jsonLine: string): void {
  const proc = mockProcesses[procIdx];
  if (!proc) throw new Error(`mock process #${procIdx} not found`);
  const dataHandlers = (proc.stdout.on as ReturnType<typeof vi.fn>).mock.calls
    .filter((c: [string, unknown]) => c[0] === 'data')
    .map((c: [string, unknown]) => c[1]);

  const buffer = Buffer.from(jsonLine + '\n', 'utf-8');
  for (const handler of dataHandlers) {
    (handler as (data: Buffer) => void)(buffer);
  }
}

/** 向指定 mock 进程的 stdout 推送原始字节碎片（不含自动换行） */
function feedStdoutChunk(procIdx: number, chunk: Buffer): void {
  const proc = mockProcesses[procIdx];
  if (!proc) throw new Error(`mock process #${procIdx} not found`);
  const dataHandlers = (proc.stdout.on as ReturnType<typeof vi.fn>).mock.calls
    .filter((c: [string, unknown]) => c[0] === 'data')
    .map((c: [string, unknown]) => c[1]);

  for (const handler of dataHandlers) {
    (handler as (data: Buffer) => void)(chunk);
  }
}

function feedStderr(procIdx: number, text: string): void {
  const proc = mockProcesses[procIdx];
  if (!proc) throw new Error(`mock process #${procIdx} not found`);
  const handlers = (proc.stderr.on as ReturnType<typeof vi.fn>).mock.calls
    .filter((call: [string, unknown]) => call[0] === 'data')
    .map((call: [string, unknown]) => call[1]);
  for (const handler of handlers) (handler as (data: Buffer) => void)(Buffer.from(text, 'utf8'));
}

/** 触发 mock 进程的 exit 事件 */
function emitExit(
  procIdx: number,
  code: number | null,
  signal: string | null,
): void {
  const proc = mockProcesses[procIdx];
  if (!proc) throw new Error(`mock process #${procIdx} not found`);
  proc.emit('exit', code, signal);
}

/** 触发 mock 进程的 error 事件 */
function emitError(procIdx: number, err: Error): void {
  const proc = mockProcesses[procIdx];
  if (!proc) throw new Error(`mock process #${procIdx} not found`);
  proc.emit('error', err);
}

/** 获取最后一次 stdin.write 调用解析的 JSON */
function getLastWrittenJson(procIdx: number): Record<string, unknown> {
  const proc = mockProcesses[procIdx];
  if (!proc) throw new Error(`mock process #${procIdx} not found`);
  const calls = (proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const lastCall = calls[calls.length - 1][0] as string;
  return JSON.parse(lastCall);
}

/** 获取指定序位的 stdin.write 调用对应的 JSON */
function getWrittenJsonAt(
  procIdx: number,
  callIndex: number,
): Record<string, unknown> {
  const proc = mockProcesses[procIdx];
  if (!proc) throw new Error(`mock process #${procIdx} not found`);
  const calls = (proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(callIndex);
  return JSON.parse(calls[callIndex][0] as string);
}

// ─── 测试套件 ───────────────────────────────────────────────────────────────

describe('AgentRuntime — Doc 27 测试门', () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockImplementation(() => true);
    delete process.env.AGENTFLUX_PI_CLI;
    delete process.env.AGENTFLUX_PI_MODEL;
    delete process.env.AGENTFLUX_PI_THINKING;
    delete process.env.AGENTFLUX_NODE_EXECUTABLE;
    delete process.env.npm_node_execpath;
    delete process.env.AGENTFLUX_ALLOW_ELECTRON_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;
    spawnSyncMock.mockReturnValue({ stdout: 'v24.11.1\n', stderr: '', status: 0 });
    mockProcesses.length = 0;
    runtime = new AgentRuntime();
    vi.mocked(fs.readFileSync).mockImplementation(() => '');
  });

  afterEach(async () => {
    // Use fake timers to avoid waiting the 3-second fallback timer in killProcess
    vi.useFakeTimers();
    const shutdownPromise = runtime.shutdownAll();
    await vi.advanceTimersByTimeAsync(5000);
    await shutdownPromise;
    vi.useRealTimers();
  });

  // ── Gate 1: spawn 精确参数 ──────────────────────────────────────────────

  it('Gate 1: spawn 使用精确参数 --mode rpc --approve -e <entry> --name <name>，shell: false', async () => {
    const projectRoot = '/test/project';
    const name = 'my-agent';
    const initialTask = 'do something';

    await runtime.start({ projectRoot, name, initialTask });

    // spawn 必须被调用一次
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnMock.mock.calls[0];

    // 优先使用项目 node_modules 中的当前 pi CLI，并通过当前 Node 启动。
    expect(command).toBe(process.execPath);

    // args 必须是数组（非 shell 字符串）
    expect(Array.isArray(args)).toBe(true);

    const entryPath = path.join('/test/project', 'src', 'entry.ts');
    const expectedArgs = [
      path.join(projectRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
      '--mode',
      'rpc',
      '--approve',
      '-e',
      entryPath,
      '--name',
      'my-agent',
    ];

    // 精确验证参数序列
    expect(args).toEqual(expectedArgs);

    // shell 必须禁用，防止参数注入
    expect((options as Record<string, unknown>).shell).toBe(false);

    // cwd 必须是 projectRoot
    expect((options as Record<string, unknown>).cwd).toBe(projectRoot);

    // stdio 必须是 pipe
    expect((options as Record<string, unknown>).stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect((options as any).env).toMatchObject({
      AGENTFLUX_RPC_INBOX_PUMP: '1',
      AGENTFLUX_AGENT_NAME: name,
      AGENTFLUX_RUNTIME_INSTANCE_ID: expect.any(String),
      AGENTFLUX_PI_SOURCE: 'project',
    });
    expect((options as any).env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');

    // 验证 args 中无注入字符
    const allArgs = args as string[];
    for (const arg of allArgs) {
      expect(arg).not.toContain(';');
      expect(arg).not.toContain('&&');
      expect(arg).not.toContain('|');
      expect(arg).not.toContain('$(');
      expect(arg).not.toContain('`');
    }

    // 验证 PID 存在
    expect(mockProcesses[0].pid).toBe(1000);
    const list = runtime.list();
    expect(list[0].pid).toBe(1000);
    expect(list[0]).toMatchObject({
      cliSource: 'project',
      runtimeSource: 'process',
      runtimeExecutable: process.execPath,
      runtimeVersion: process.version,
    });
  });

  it('Gate 1b: 重复名称自动生成唯一 runtime 名称', async () => {
    const first = await runtime.start({ projectRoot: '/test/project', name: 'worker', initialTask: '' });
    const second = await runtime.start({ projectRoot: '/test/project', name: 'worker', initialTask: '' });
    expect(first).not.toBe(second);
    expect(runtime.list().map((item) => item.name)).toEqual(['worker', 'worker-2']);
    expect((spawnMock.mock.calls[1][1] as string[]).slice(-2)).toEqual(['--name', 'worker-2']);
  });

  it('Gate 1b2: 已退出记录和恢复历史不占用 routable name', async () => {
    await runtime.start({ projectRoot: '/test/project', name: 'lease-worker', initialTask: '' });
    emitExit(0, 1, null);
    await runtime.start({ projectRoot: '/test/project', name: 'lease-worker', initialTask: '' });
    expect((spawnMock.mock.calls[1][1] as string[]).slice(-2)).toEqual(['--name', 'lease-worker']);

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      schemaVersion: 2,
      savedAt: 1,
      records: [{
        runId: 'historical-run', name: 'historical-worker', pid: 999, status: 'done', events: [],
        stderrSummary: '', startedAt: 1, lastActivity: 1, exitCode: 0, exitSignal: null,
        pendingUiRequests: [], historical: false,
      }],
    }));
    runtime.configurePersistence('/tmp/runtime-history.v1.json');
    await runtime.start({ projectRoot: '/test/project', name: 'historical-worker', initialTask: '' });
    expect((spawnMock.mock.calls[2][1] as string[]).slice(-2)).toEqual(['--name', 'historical-worker']);
  });

  it('Gate 1c: AGENTFLUX_PI_CLI 可显式覆盖项目 CLI', async () => {
    const override = path.resolve('/opt/pi/custom-cli.js');
    process.env.AGENTFLUX_PI_CLI = override;
    await runtime.start({ projectRoot: '/test/project', name: 'override-agent', initialTask: '' });
    expect(spawnMock.mock.calls[0][0]).toBe(process.execPath);
    expect((spawnMock.mock.calls[0][1] as string[])[0]).toBe(override);
    expect((spawnMock.mock.calls[0][2] as any).env.AGENTFLUX_PI_SOURCE).toBe('env');
    expect((spawnMock.mock.calls[0][2] as any).env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('Gate 1c2: native CLI override does not inject ELECTRON_RUN_AS_NODE', async () => {
    const override = path.resolve('/opt/pi/pi.exe');
    process.env.AGENTFLUX_PI_CLI = override;
    await runtime.start({ projectRoot: '/test/project', name: 'native-agent', initialTask: '' });
    expect(spawnMock.mock.calls[0][0]).toBe(override);
    expect((spawnMock.mock.calls[0][2] as any).env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('Gate 1c3: 缺少项目固定 CLI 时拒绝静默回退全局 pi', async () => {
    mockExistsSync.mockImplementation((candidate: string) =>
      !candidate.includes(`${path.sep}node_modules${path.sep}`));
    await expect(runtime.start({ projectRoot: '/test/project', name: 'path-agent', initialTask: '' }))
      .rejects.toThrow('不会静默回退到 PATH 中的全局 pi');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('Gate 1c4: Electron process.execPath 不用于启动项目 JS CLI', () => {
    const electronPath = 'C:\\Program Files\\AgentFlux\\electron.exe';
    const resolved = resolveJavaScriptRuntime(electronPath, {}, () => true);
    expect(resolved).toEqual({ command: 'node', source: 'path', runAsNode: false });
  });

  it('Gate 1c4b: Electron-as-Node 只能由 main-process 测试开关显式启用', () => {
    const electronPath = 'C:\\Program Files\\AgentFlux\\electron.exe';
    const resolved = resolveJavaScriptRuntime(electronPath, { AGENTFLUX_ALLOW_ELECTRON_AS_NODE: '1' }, () => true);
    expect(resolved).toEqual({ command: electronPath, source: 'electron-opt-in', runAsNode: true });
  });

  it('Gate 1c5: npm_node_execpath 可安全选择含空格的真实 Node 路径', () => {
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const resolved = resolveJavaScriptRuntime('C:\\AgentFlux\\electron.exe', { npm_node_execpath: nodePath }, () => true);
    expect(resolved).toEqual({ command: nodePath, source: 'npm', runAsNode: false });
  });

  it('Gate 1c6: Electron parent 环境中的 ELECTRON_RUN_AS_NODE 不会泄漏到 Node child', async () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    await runtime.start({ projectRoot: '/test/project', name: 'clean-env-agent', initialTask: '' });
    expect((spawnMock.mock.calls[0][2] as any).env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('Gate 1c7: Node 22.18 被拒绝，22.19 可启动', async () => {
    const nodePath = path.resolve('/opt/node-22/node');
    process.env.AGENTFLUX_NODE_EXECUTABLE = nodePath;
    let detectedVersion = 'v22.18.0';
    runtime = new AgentRuntime({ nodeVersionProbe: () => detectedVersion });
    await expect(runtime.start({ projectRoot: '/test/project', name: 'old-node', initialTask: '' }))
      .rejects.toThrow('Agent CLI 需要 Node >=22.19.0');
    expect(spawnMock).not.toHaveBeenCalled();

    detectedVersion = 'v22.19.0';
    await runtime.start({ projectRoot: '/test/project', name: 'supported-node', initialTask: '' });
    expect(spawnMock.mock.calls[0][0]).toBe(nodePath);
  });

  it('Gate 1c8: Node 探测 ENOENT/异常版本时提供可操作错误', async () => {
    const nodePath = path.resolve('/opt/node-broken/node');
    process.env.AGENTFLUX_NODE_EXECUTABLE = nodePath;
    runtime = new AgentRuntime({
      nodeVersionProbe: () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); },
    });
    await expect(runtime.start({ projectRoot: '/test/project', name: 'missing-node', initialTask: '' }))
      .rejects.toThrow('AGENTFLUX_NODE_EXECUTABLE');

    runtime = new AgentRuntime({ nodeVersionProbe: () => null });
    await expect(runtime.start({ projectRoot: '/test/project', name: 'bad-version', initialTask: '' }))
      .rejects.toThrow('未知版本');
  });

  it('Gate 1d: trusted env can select a low-cost model and thinking level', async () => {
    process.env.AGENTFLUX_PI_MODEL = 'deepseek-v4-flash';
    process.env.AGENTFLUX_PI_THINKING = 'off';
    await runtime.start({ projectRoot: '/test/project', name: 'cost-agent', initialTask: '' });
    expect((spawnMock.mock.calls[0][1] as string[]).slice(-4)).toEqual([
      '--model', 'deepseek-v4-flash', '--thinking', 'off',
    ]);
  });

  // ── Gate 2: 两个独立进程 ────────────────────────────────────────────────

  it('Gate 2: 两次 start 创建两个独立进程，互不干扰', async () => {
    const runId1 = await runtime.start({
      projectRoot: '/path/a',
      name: 'agent-alpha',
      initialTask: 'task one',
    });
    expect(typeof runId1).toBe('string');
    expect(runId1.length).toBeGreaterThan(0);

    const runId2 = await runtime.start({
      projectRoot: '/path/b',
      name: 'agent-beta',
      initialTask: 'task two',
    });
    expect(typeof runId2).toBe('string');

    // 两个不同的 runId
    expect(runId1).not.toBe(runId2);

    // spawn 调用两次
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // 两个独立进程
    expect(mockProcesses.length).toBe(2);
    expect(mockProcesses[0].pid).toBe(1000);
    expect(mockProcesses[1].pid).toBe(1001);

    // 每个进程的 args 不同（entry 路径不同、name 不同）
    const args0 = spawnMock.mock.calls[0][1] as string[];
    const args1 = spawnMock.mock.calls[1][1] as string[];
    const entryIdx0 = args0.indexOf('-e') + 1;
    const entryIdx1 = args1.indexOf('-e') + 1;
    expect(args0[entryIdx0]).toBe(path.join('/path/a', 'src', 'entry.ts'));
    expect(args1[entryIdx1]).toBe(path.join('/path/b', 'src', 'entry.ts'));
    const nameIdx0 = args0.indexOf('--name') + 1;
    const nameIdx1 = args1.indexOf('--name') + 1;
    expect(args0[nameIdx0]).toBe('agent-alpha');
    expect(args1[nameIdx1]).toBe('agent-beta');

    // 每个进程都写入了 initialTask（prompt）
    expect(mockProcesses[0].stdin.write).toHaveBeenCalledTimes(1);
    expect(mockProcesses[1].stdin.write).toHaveBeenCalledTimes(1);

    // 验证两条不同的 initialTask 消息
    const msg1 = getWrittenJsonAt(0, 0);
    expect(msg1.type).toBe('prompt');
    expect(msg1.message).toBe('task one');
    expect(msg1.id).toBe(runId1);

    const msg2 = getWrittenJsonAt(1, 0);
    expect(msg2.type).toBe('prompt');
    expect(msg2.message).toBe('task two');
    expect(msg2.id).toBe(runId2);

    // list() 返回两条记录
    const list = runtime.list();
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.runId === runId1)).toBeTruthy();
    expect(list.find((r) => r.runId === runId2)).toBeTruthy();

    // 两个进程相互独立
    expect(mockProcesses[0].killed).toBe(false);
    expect(mockProcesses[1].killed).toBe(false);
  });

  // ── Gate 3: LF 碎片逐字节分帧 ──────────────────────────────────────────

  it('Gate 3: LF 碎片逐字节分帧 — 跨 3+ chunk 正确还原 JSONL', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'frag-test',
      initialTask: 'init',
    });
    expect(runId).toBeTruthy();

    // 将一个 JSONL 行拆成 3 个 chunk，中间不包含 LF
    const chunk1 = Buffer.from('{"type":"response","runId":"', 'utf-8');
    const chunk2 = Buffer.from(runId + '","status":"running"', 'utf-8');
    const chunk3 = Buffer.from(',"content":"fragmented"}\n', 'utf-8');

    feedStdoutChunk(0, chunk1);
    feedStdoutChunk(0, chunk2);
    feedStdoutChunk(0, chunk3);

    // 验证 record 已更新：status 应为 running，event content 应为 fragmented
    const list = runtime.list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('running');

    // 验证 response 事件携带了 content
    const respEvents = list[0].events.filter((e) => e.type === 'response');
    expect(respEvents.length).toBeGreaterThanOrEqual(1);
    const lastResp = respEvents[respEvents.length - 1];
    expect(lastResp.data).toEqual('fragmented');

    // 验证更多碎片场景：同一行跨 5 个单字节碎片
    const jsonLine =
      '{"type":"response","runId":"' + runId + '","content":"tiny"}\n';
    for (let i = 0; i < jsonLine.length; i++) {
      feedStdoutChunk(0, Buffer.from(jsonLine[i], 'utf-8'));
    }

    const list2 = runtime.list();
    expect(
      list2[0].events.filter((e) => e.type === 'response').length,
    ).toBeGreaterThanOrEqual(2);
    const tinyResp = list2[0].events.filter((e) => e.data === 'tiny');
    expect(tinyResp.length).toBeGreaterThanOrEqual(1);
  });

  // ── Gate 4a: 四种 RPC 命令的 outgoing 格式 ─────────────────────────────

  it('Gate 4a: 四种 RPC 命令 (prompt/steer/follow_up/abort) 均使用 {id, type, message} 精确格式', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'rpc-test',
      initialTask: 'start task',
    });

    // ── ① prompt ──
    const initMsg = getWrittenJsonAt(0, 0);
    expect(initMsg).toEqual({
      id: runId,
      type: 'prompt',
      message: 'start task',
    });
    expect(initMsg).not.toHaveProperty('runId');
    expect(initMsg).not.toHaveProperty('prompt');
    expect(initMsg).not.toHaveProperty('text');
    expect(Object.keys(initMsg).sort()).toEqual(['id', 'message', 'type']);

    // prompt() 方法
    (mockProcesses[0].stdin.write as ReturnType<typeof vi.fn>).mockClear();
    await runtime.prompt(runId, 'continue please');
    const promptMsg = getLastWrittenJson(0);
    expect(promptMsg).toEqual({
      id: runId,
      type: 'prompt',
      message: 'continue please',
    });

    // ── ② steer ──
    (mockProcesses[0].stdin.write as ReturnType<typeof vi.fn>).mockClear();
    await runtime.steer(runId, 'change direction');
    const steerMsg = getLastWrittenJson(0);
    expect(steerMsg).toHaveProperty('id', runId);
    expect(steerMsg).toHaveProperty('type', 'steer');
    expect(steerMsg).toHaveProperty('message', 'change direction');

    // ── ③ follow_up ──
    (mockProcesses[0].stdin.write as ReturnType<typeof vi.fn>).mockClear();
    await runtime.followUp(runId, 'next task');
    const followUpMsg = getLastWrittenJson(0);
    expect(followUpMsg).toHaveProperty('id', runId);
    expect(followUpMsg).toHaveProperty('type', 'follow_up');
    expect(followUpMsg).toHaveProperty('message', 'next task');

    // ── ④ abort — 不含 message 字段 ──
    (mockProcesses[0].stdin.write as ReturnType<typeof vi.fn>).mockClear();
    await runtime.abort(runId);
    const abortMsg = getLastWrittenJson(0);
    expect(abortMsg).toEqual({
      id: runId,
      type: 'abort',
    });
    expect(Object.keys(abortMsg).sort()).toEqual(['id', 'type']);
  });

  // ── Gate 4b: incoming status 映射 ─────────────────────────────────────

  it('Gate 4b: incoming status 映射 — running/blocked/done/failed/aborted 及其别名', async () => {
    const statusMappings: Array<{ incoming: string; expected: string }> = [
      { incoming: 'running', expected: 'running' },
      { incoming: 'blocked', expected: 'blocked' },
      { incoming: 'done', expected: 'done' },
      { incoming: 'completed', expected: 'done' },
      { incoming: 'failed', expected: 'failed' },
      { incoming: 'error', expected: 'failed' },
      { incoming: 'aborted', expected: 'aborted' },
      { incoming: 'cancelled', expected: 'aborted' },
      { incoming: 'unknown_status', expected: 'running' }, // 默认 fallback
    ];

    for (const { incoming, expected } of statusMappings) {
      const prevCount = mockProcesses.length;
      const rid = await runtime.start({
        projectRoot: '/test',
        name: `map-${incoming}`,
        initialTask: 'init',
      });
      const newProcIdx = prevCount;
      feedStdout(
        newProcIdx,
        JSON.stringify({ type: 'response', runId: rid, status: incoming }),
      );
      const snap = runtime.list().find((r) => r.runId === rid);
      expect(snap?.status).toBe(expected);
    }
  });

  // ── Gate 5: abort 不杀进程 vs stop 杀选中进程 ─────────────────────────

  it('Gate 5: abort 不杀进程，stop 杀死选中进程，且不影响其他 runtime', async () => {
    const runId1 = await runtime.start({
      projectRoot: '/path/a',
      name: 'agent-a',
      initialTask: 'task a',
    });
    const runId2 = await runtime.start({
      projectRoot: '/path/b',
      name: 'agent-b',
      initialTask: 'task b',
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(mockProcesses.length).toBe(2);
    expect(mockProcesses[0].killed).toBe(false);
    expect(mockProcesses[1].killed).toBe(false);

    // ── abort 不杀进程 ──
    await runtime.abort(runId1);

    let list = runtime.list();
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.runId === runId1)?.status).toBe('aborted');
    expect(mockProcesses[0].killed).toBe(false);

    const abortMsg = getLastWrittenJson(0);
    expect(abortMsg.type).toBe('abort');

    // 第二个进程完全不受 abort 影响
    expect(mockProcesses[1].killed).toBe(false);
    (mockProcesses[1].stdin.write as ReturnType<typeof vi.fn>).mockClear();
    await runtime.prompt(runId2, 'still working');
    expect(mockProcesses[1].stdin.write).toHaveBeenCalledTimes(1);
    const promptMsg = getLastWrittenJson(1);
    expect(promptMsg.type).toBe('prompt');
    expect(promptMsg.message).toBe('still working');

    // ── stop 杀死选中进程 ──
    vi.useFakeTimers();
    const stopPromise = runtime.stop(runId2);
    await vi.advanceTimersByTimeAsync(5000);
    await stopPromise;
    vi.useRealTimers();

    expect(mockProcesses[1].killed).toBe(true);
    list = runtime.list();
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.runId === runId2)?.status).toBe('aborted');
    expect(mockProcesses[0].killed).toBe(false);
  });

  // ── Gate 6: 退出状态可观察 ─────────────────────────────────────────────

  it('Gate 6: 进程退出后 record 仍可访问，含 exitCode/exitSignal', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'exit-obs',
      initialTask: 'run',
    });

    expect(runtime.list()).toHaveLength(1);

    // ── 正常退出 (code=0) ──
    emitExit(0, 0, null);
    let list = runtime.list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('failed');
    expect(list[0].errorCode).toBe('RPC_EXIT_ZERO_WITHOUT_PROTOCOL');
    expect(list[0].exitCode).toBe(0);
    expect(list[0].exitSignal).toBeNull();
    expect(list[0].name).toBe('exit-obs');
    expect(list[0].runId).toBe(runId);
    expect(list[0].startedAt).toBeGreaterThan(0);

    const exitEvents = list[0].events.filter((e) => e.type === 'process_exit');
    expect(exitEvents.length).toBe(1);
    expect(exitEvents[0].data).toEqual(expect.objectContaining({ code: 0, signal: null }));

    // ── 非零退出 (code=1) ──
    mockProcesses.length = 0;
    (spawnMock as ReturnType<typeof vi.fn>).mockClear();
    const runId2 = await runtime.start({
      projectRoot: '/test',
      name: 'exit-fail',
      initialTask: 'fail task',
    });
    feedStderr(0, 'TypeError: webidl.util.markAsUncloneable is not a function\nUpgrade Node to >=22.19.0\n');
    emitExit(0, 1, null);
    list = runtime.list();
    const failRecord = list.find((r) => r.runId === runId2)!;
    expect(failRecord.status).toBe('failed');
    expect(failRecord.exitCode).toBe(1);
    expect(failRecord.events.find((event) => event.type === 'process_exit')?.data).toEqual(expect.objectContaining({
      stderrSummary: expect.stringContaining('markAsUncloneable'),
      runtimeSource: 'process',
      runtimeVersion: process.version,
      requiredNodeVersion: '>=22.19.0',
    }));

    // ── 信号终止 (signal=SIGTERM) ──
    mockProcesses.length = 0;
    (spawnMock as ReturnType<typeof vi.fn>).mockClear();
    const runId3 = await runtime.start({
      projectRoot: '/test',
      name: 'exit-signal',
      initialTask: 'sig task',
    });
    emitExit(0, null, 'SIGTERM');
    list = runtime.list();
    const sigRecord = list.find((r) => r.runId === runId3)!;
    expect(sigRecord.status).toBe('failed');
    expect(sigRecord.exitCode).toBeNull();
    expect(sigRecord.exitSignal).toBe('SIGTERM');
  });

  // ── Gate 7a: 空/undefined 参数 ─────────────────────────────────────────

  it('Gate 7a: 空/undefined 参数抛出明确错误', async () => {
    const validOpts = {
      projectRoot: '/test/valid',
      name: 'valid',
      initialTask: 'valid task',
    };

    await expect(
      runtime.start({ ...validOpts, projectRoot: '' }),
    ).rejects.toThrow('projectRoot 是必填的字符串参数');
    await expect(
      runtime.start({
        ...validOpts,
        projectRoot: undefined as unknown as string,
      }),
    ).rejects.toThrow('projectRoot 是必填的字符串参数');

    await expect(
      runtime.start({ ...validOpts, name: '' }),
    ).rejects.toThrow('name 是必填的字符串参数');
    await expect(
      runtime.start({ ...validOpts, name: undefined as unknown as string }),
    ).rejects.toThrow('name 是必填的字符串参数');

    // initialTask 为空/undefined — 现在允许为空，创建空闲 runtime
    const firstRunId = await runtime.start({
      projectRoot: '/test/valid',
      name: 'first',
      initialTask: 'first task',
    });
    expect(firstRunId).toBeTruthy();
    expect(runtime.list().length).toBe(1);

    const rid = await runtime.start({ ...validOpts, initialTask: '' });
    expect(rid).toBeTruthy();
    expect(runtime.list().length).toBe(2);
    const lastProc = mockProcesses[mockProcesses.length - 1];
    expect(lastProc.stdin.write).toHaveBeenCalledTimes(0);

    vi.useFakeTimers();
    const stopPromise = runtime.stop(rid);
    // 触发 taskkill exit 事件提前 resolve，避免等 3 秒
    if (mockProcesses.length > 0) {
      mockProcesses[mockProcesses.length - 1].emit('exit', 0, null);
    }
    await vi.advanceTimersByTimeAsync(5000);
    await stopPromise;
    vi.useRealTimers();
    mockProcesses.length = 0;
    (spawnMock as ReturnType<typeof vi.fn>).mockClear();

    const rid2 = await runtime.start({
      ...validOpts,
      initialTask: undefined as unknown as string,
    });
    expect(rid2).toBeTruthy();
  });

  // ── Gate 7b: 非绝对路径/目录不存在/缺少 entry.ts ──────────────────────

  it('Gate 7b: 非绝对路径/目录不存在/缺少 entry.ts 抛出明确错误', async () => {
    await expect(
      runtime.start({
        projectRoot: 'relative/path',
        name: 'test',
        initialTask: 'task',
      }),
    ).rejects.toThrow('projectRoot 必须是绝对路径');

    await expect(
      runtime.start({
        projectRoot: 'foo/bar',
        name: 'test',
        initialTask: 'task',
      }),
    ).rejects.toThrow(/projectRoot 必须是绝对路径，收到: foo\/bar/);

    const mockImpl1: () => boolean = (p: string | Buffer) => {
        const pStr = typeof p === 'string' ? p : p.toString();
        if (pStr === '/nonexistent/root') return false;
        if (pStr === '/nonexistent/root/src/entry.ts') return false;
        return true;
      };
    mockExistsSync.mockImplementation(mockImpl1);

    await expect(
      runtime.start({
        projectRoot: '/nonexistent/root',
        name: 'test',
        initialTask: 'task',
      }),
    ).rejects.toThrow('projectRoot 目录不存在: /nonexistent/root');

    const mockImpl2: () => boolean = (p: string | Buffer) => {
        const pStr = typeof p === 'string' ? p : p.toString();
        if (pStr === '/no-entry/project') return true;
        if (pStr === path.join('/no-entry/project', 'src', 'entry.ts'))
          return false;
        return true;
      };
    mockExistsSync.mockImplementation(mockImpl2);

    await expect(
      runtime.start({
        projectRoot: '/no-entry/project',
        name: 'test',
        initialTask: 'task',
      }),
    ).rejects.toThrow('projectRoot 缺少 src/entry.ts');

    mockExistsSync.mockImplementation(() => true);
  });

  // ── Gate 7c: 对不存在的 runId 操作 + process error 事件 ───────────────

  it('Gate 7c: 对不存在的 runId 操作抛出明确错误 + process error 事件', async () => {
    const validOpts = {
      projectRoot: '/test',
      name: 'valid',
      initialTask: 'valid task',
    };

    const runId = await runtime.start(validOpts);
    expect(runId).toBeTruthy();
    expect(runtime.list()).toHaveLength(1);

    await expect(runtime.prompt('non-existent', 'hi')).rejects.toThrow(
      'Runtime 记录不存在: non-existent',
    );
    await expect(runtime.steer('non-existent', 'hi')).rejects.toThrow(
      'Runtime 记录不存在: non-existent',
    );
    await expect(runtime.followUp('non-existent', 'hi')).rejects.toThrow(
      'Runtime 记录不存在: non-existent',
    );
    await expect(runtime.abort('non-existent')).rejects.toThrow(
      'Runtime 记录不存在: non-existent',
    );
    await expect(runtime.stop('non-existent')).rejects.toThrow(
      'Runtime 记录不存在: non-existent',
    );

    mockProcesses.length = 0;
    (spawnMock as ReturnType<typeof vi.fn>).mockClear();
    const errRunId = await runtime.start({
      projectRoot: '/test',
      name: 'error-test',
      initialTask: 'err',
    });
    emitError(0, new Error('connection refused'));
    const list = runtime.list();
    const errRecord = list.find((r) => r.runId === errRunId)!;
    expect(errRecord.status).toBe('failed');
    const errEvt = errRecord.events.find((e) => e.type === 'process_error');
    expect(errEvt).toBeTruthy();
    expect((errEvt!.data as { message: string }).message).toBe(
      'connection refused',
    );
  });

  // ── Gate 8: EVENT_RUNTIME_EVENT 事件 ───────────────────────────────────

  it('Gate 8: 每条真实 RPC JSON 产生 EVENT_RUNTIME_EVENT', async () => {
    const eventHandler = vi.fn();
    runtime.on(AgentRuntime.EVENT_RUNTIME_EVENT, eventHandler);

    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'event-test',
      initialTask: 'init',
    });

    // start 产生了一条 prompt RPC 消息（发送 stdin），但这不是 incoming 事件
    // 我们需要触发 incoming message 来验证
    eventHandler.mockClear();

    // 发送一条 incoming agent_start
    feedStdout(0, JSON.stringify({
      type: 'agent_start',
      runId,
      content: 'starting agent',
    }));

    expect(eventHandler).toHaveBeenCalledTimes(1);
    const call = eventHandler.mock.calls[0][0] as { runId: string; event: unknown };
    expect(call).toHaveProperty('runId', runId);
    expect(call).toHaveProperty('event');
    expect((call.event as Record<string, unknown>).type).toBe('agent_start');

    // 发送 response
    eventHandler.mockClear();
    feedStdout(0, JSON.stringify({
      type: 'response',
      runId,
      content: 'hello',
    }));
    expect(eventHandler).toHaveBeenCalledTimes(1);
    const call2 = eventHandler.mock.calls[0][0] as { runId: string; event: unknown };
    expect((call2.event as Record<string, unknown>).type).toBe('response');

    // process_error 也产生 EVENT_RUNTIME_EVENT
    eventHandler.mockClear();
    emitError(0, new Error('test error'));
    const errorCalls = eventHandler.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>).event && (c[0] as Record<string, unknown>).event !== undefined,
    );
    const procErrorEvent = errorCalls.find(
      (c: unknown[]) => (c[0] as { event: { type: string } }).event?.type === 'process_error',
    );
    expect(procErrorEvent).toBeTruthy();

    // process_exit 也产生 EVENT_RUNTIME_EVENT
    eventHandler.mockClear();
    mockProcesses.length = 0;
    (spawnMock as ReturnType<typeof vi.fn>).mockClear();
    const runId2 = await runtime.start({
      projectRoot: '/test',
      name: 'exit-event-test',
      initialTask: 'run',
    });
    eventHandler.mockClear();
    emitExit(0, 0, null);
    const exitEvents = eventHandler.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event: { type: string } }).event?.type === 'process_exit',
    );
    expect(exitEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ── Gate 9: agent_settled/agent_end 仅在当前状态不是 aborted/failed 时置 done ──

  it('Gate 9: agent_settled 在 aborted 状态下保持 aborted', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'abort-settled',
      initialTask: 'init',
    });

    // 先 abort
    await runtime.abort(runId);
    expect(runtime.list()[0].status).toBe('aborted');

    // 然后收到 agent_settled
    feedStdout(0, JSON.stringify({
      type: 'agent_settled',
      runId,
      content: { success: true },
    }));

    // 状态应保持 aborted，不变成 done
    expect(runtime.list()[0].status).toBe('aborted');
  });

  it('Gate 9: agent_end 在 failed 状态下保持 failed', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'fail-end',
      initialTask: 'init',
    });

    // 先标记为 failed
    const record = runtime.list().find(r => r.runId === runId)!;
    // 模拟 process_error 导致 failed
    emitError(0, new Error('some error'));
    expect(runtime.list()[0].status).toBe('failed');

    // 然后收到 agent_end
    mockProcesses.length = 0;
    (spawnMock as ReturnType<typeof vi.fn>).mockClear();
    const runId2 = await runtime.start({
      projectRoot: '/test',
      name: 'fail-end-2',
      initialTask: 'init',
    });

    // 先触发 process_error
    emitError(0, new Error('process crash'));
    expect(runtime.list().find(r => r.runId === runId2)?.status).toBe('failed');

    // 然后收到 agent_end
    feedStdout(0, JSON.stringify({
      type: 'agent_end',
      runId: runId2,
      content: { success: true },
    }));

    // 状态应保持 failed，不变成 done
    expect(runtime.list().find(r => r.runId === runId2)?.status).toBe('failed');
  });

  it('Gate 9: agent_settled 在正常状态下置 done', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'normal-settled',
      initialTask: 'init',
    });

    feedStdout(0, JSON.stringify({
      type: 'agent_settled',
      runId,
      content: { success: true },
    }));

    expect(runtime.list()[0].status).toBe('done');
  });

  // ── Gate 10: response 顶层 success===false 置 failed ──

  it('Gate 10: agent_settled 中 content.success===false 置 failed', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'success-false',
      initialTask: 'init',
    });

    feedStdout(0, JSON.stringify({
      type: 'agent_settled',
      runId,
      content: { success: false, error: 'something went wrong' },
    }));

    expect(runtime.list()[0].status).toBe('failed');
  });

  it('Gate 10: agent_end 中 content.success===false 置 failed', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'end-fail',
      initialTask: 'init',
    });

    feedStdout(0, JSON.stringify({
      type: 'agent_end',
      runId,
      content: { success: false, error: 'failed end' },
    }));

    expect(runtime.list()[0].status).toBe('failed');
  });

  it('Gate 10: response 顶层 success===false 置 failed', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'response-fail',
      initialTask: 'init',
    });

    feedStdout(0, JSON.stringify({
      type: 'response',
      runId,
      success: false,
      content: 'task failed',
    }));

    expect(runtime.list()[0].status).toBe('failed');
  });

  // ── Gate 11: killProcess 的 3 秒 fallback timer ──────────────────────

  it('Gate 11: stop 优先关闭 stdin 并在进程自行 exit 时不强杀', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'kill-timer',
      initialTask: 'init',
    });

    expect(mockProcesses.length).toBe(1);

    let resolved = false;

    vi.useFakeTimers();

    const stopPromise = runtime.stop(runId).then(() => { resolved = true; });

    // 触发 exit 事件来提前 resolve（模拟 kill 成功后进程退出）
    mockProcesses[0].emit('exit', 0, null);

    // 推进 timer 确保 fallback timer 不会二次 resolve
    await vi.advanceTimersByTimeAsync(5000);

    await stopPromise;

    expect(resolved).toBe(true);
    expect(mockProcesses[0].stdin.end).toHaveBeenCalledTimes(1);
    expect(mockProcesses[0].killed).toBe(false);

    vi.useRealTimers();
  });

  // ── shutdownAll 清理所有 ──────────────────────────────────────────────

  it('shutdownAll 清空所有记录并杀死所有进程', async () => {
    const runId1 = await runtime.start({
      projectRoot: '/path/a',
      name: 'a',
      initialTask: 'a',
    });
    const runId2 = await runtime.start({
      projectRoot: '/path/b',
      name: 'b',
      initialTask: 'b',
    });
    expect(runtime.list()).toHaveLength(2);

    vi.useFakeTimers();
    const shutdownPromise = runtime.shutdownAll();
    await vi.advanceTimersByTimeAsync(5000);
    await shutdownPromise;
    vi.useRealTimers();

    expect(runtime.list()).toHaveLength(0);
    expect(mockProcesses[0].killed).toBe(true);
    expect(mockProcesses[1].killed).toBe(true);
  });

  // ── 事件缓冲上限 1000 条 ──────────────────────────────────────────────

  it('事件缓冲上限 1000 条', async () => {
    const runId = await runtime.start({
      projectRoot: '/test',
      name: 'cap-test',
      initialTask: 'init',
    });

    // 推送 2000 个事件
    for (let i = 0; i < 2000; i++) {
      feedStdout(0, JSON.stringify({
        type: 'response',
        runId,
        content: `event-${i}`,
      }));
    }

    const list = runtime.list();
    expect(list[0].events.length).toBe(1000);
  });

  it('Extension UI: confirm/select/input 请求可观察并按原生协议响应', async () => {
    const runId = await runtime.start({ projectRoot: '/test', name: 'ui-agent', initialTask: '' });

    feedStdout(0, JSON.stringify({
      type: 'extension_ui_request', id: 'confirm-1', method: 'confirm',
      title: 'Delete?', message: 'Cannot undo', timeout: 10_000,
    }));
    let snapshot = runtime.list().find((item) => item.runId === runId)!;
    expect(snapshot.status).toBe('blocked');
    expect(snapshot.pendingUiRequests[0]).toMatchObject({
      runId, id: 'confirm-1', method: 'confirm', title: 'Delete?', message: 'Cannot undo',
    });
    await runtime.respondToExtensionUI(runId, { id: 'confirm-1', confirmed: false });
    expect(getLastWrittenJson(0)).toEqual({ type: 'extension_ui_response', id: 'confirm-1', confirmed: false });
    expect(runtime.list().find((item) => item.runId === runId)!.pendingUiRequests).toEqual([]);

    feedStdout(0, JSON.stringify({
      type: 'extension_ui_request', id: 'select-1', method: 'select',
      title: 'Choose', options: ['A', 'B'],
    }));
    await expect(runtime.respondToExtensionUI(runId, { id: 'select-1', value: 'C' })).rejects.toThrow('不在允许选项中');
    await runtime.respondToExtensionUI(runId, { id: 'select-1', value: 'B' });
    expect(getLastWrittenJson(0)).toEqual({ type: 'extension_ui_response', id: 'select-1', value: 'B' });

    feedStdout(0, JSON.stringify({
      type: 'extension_ui_request', id: 'input-1', method: 'input',
      title: 'Name', placeholder: 'agent name',
    }));
    snapshot = runtime.list().find((item) => item.runId === runId)!;
    expect(snapshot.pendingUiRequests[0]).toMatchObject({ id: 'input-1', method: 'input', placeholder: 'agent name' });
    await runtime.respondToExtensionUI(runId, { id: 'input-1', cancelled: true });
    expect(getLastWrittenJson(0)).toEqual({ type: 'extension_ui_response', id: 'input-1', cancelled: true });
  });

  it('Extension UI: stop 会取消 pending request，退出后清理且不可再次响应', async () => {
    const runId = await runtime.start({ projectRoot: '/test', name: 'ui-stop', initialTask: '' });
    feedStdout(0, JSON.stringify({ type: 'extension_ui_request', id: 'input-stop', method: 'input', title: 'Wait' }));
    vi.useFakeTimers();
    const stopPromise = runtime.stop(runId);
    mockProcesses[0].emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopPromise;
    vi.useRealTimers();
    expect((mockProcesses[0].stdin.write as ReturnType<typeof vi.fn>).mock.calls.map((call) => JSON.parse(call[0] as string)))
      .toContainEqual({ type: 'extension_ui_response', id: 'input-stop', cancelled: true });
    expect(runtime.list().find((item) => item.runId === runId)!.pendingUiRequests).toEqual([]);
    await expect(runtime.respondToExtensionUI(runId, { id: 'input-stop', value: 'late' })).rejects.toThrow('不存在或已结束');
  });

  it('Extension UI: 请求超时后清理 pending、记录 timeout 且保持非阻塞', async () => {
    vi.useFakeTimers();
    const runId = await runtime.start({ projectRoot: '/test/project', name: 'ui-timeout', initialTask: '' });
    feedStdout(0, JSON.stringify({
      type: 'extension_ui_request', id: 'input-timeout', method: 'input', title: 'Timed input', timeout: 100,
    }));
    expect(runtime.list().find((item) => item.runId === runId)).toMatchObject({ status: 'blocked' });
    await vi.advanceTimersByTimeAsync(101);
    const snapshot = runtime.list().find((item) => item.runId === runId)!;
    expect(snapshot.pendingUiRequests).toEqual([]);
    expect(snapshot.events).toContainEqual(expect.objectContaining({
      type: 'extension_ui_timeout', data: { id: 'input-timeout', method: 'input' },
    }));
    vi.useRealTimers();
  });

  it('Extension UI: 拒绝缺少或混合 payload，abort 先取消 pending 再发 abort', async () => {
    const runId = await runtime.start({ projectRoot: '/test', name: 'ui-abort', initialTask: '' });
    feedStdout(0, JSON.stringify({ type: 'extension_ui_request', id: 'confirm-abort', method: 'confirm', title: 'Wait' }));
    await expect(runtime.respondToExtensionUI(runId, { id: 'confirm-abort' } as any)).rejects.toThrow('必须且只能包含');
    await expect(runtime.respondToExtensionUI(runId, { id: 'confirm-abort', confirmed: true, cancelled: true } as any)).rejects.toThrow('必须且只能包含');
    await runtime.abort(runId);
    const writes = (mockProcesses[0].stdin.write as ReturnType<typeof vi.fn>).mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(writes.slice(-2)).toEqual([
      { type: 'extension_ui_response', id: 'confirm-abort', cancelled: true },
      { id: runId, type: 'abort' },
    ]);
    expect(runtime.list().find((item) => item.runId === runId)!.pendingUiRequests).toEqual([]);
  });

  it('Extension UI: write callback EPIPE 保留 pending 并收敛为可诊断失败', async () => {
    const runId = await runtime.start({ projectRoot: '/test', name: 'ui-epipe', initialTask: '' });
    feedStdout(0, JSON.stringify({ type: 'extension_ui_request', id: 'confirm-epipe', method: 'confirm', title: 'Wait' }));
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    mockProcesses[0].stdin.write.mockImplementationOnce((_line: string, _encoding: string, callback?: (error?: Error | null) => void) => {
      callback?.(error);
      return false;
    });

    await expect(runtime.respondToExtensionUI(runId, { id: 'confirm-epipe', confirmed: true })).rejects.toThrow('EPIPE');
    const snapshot = runtime.list().find((item) => item.runId === runId)!;
    expect(snapshot).toMatchObject({ status: 'failed', errorCode: 'RPC_STDIN_WRITE_FAILED' });
    expect(snapshot.pendingUiRequests).toEqual([expect.objectContaining({ id: 'confirm-epipe' })]);
    expect(snapshot.events).toContainEqual(expect.objectContaining({
      type: 'rpc_stdin_error', data: expect.objectContaining({ code: 'EPIPE', errorCode: 'RPC_STDIN_WRITE_FAILED' }),
    }));
    expect(snapshot.events.some((event) => event.type === 'extension_ui_response')).toBe(false);
  });

  it('RPC stdin: stream error 有监听器且同一错误只记录一次', async () => {
    const runId = await runtime.start({ projectRoot: '/test', name: 'stdin-error', initialTask: '' });
    const error = Object.assign(new Error('stream EPIPE'), { code: 'EPIPE' });
    mockProcesses[0].stdin.emit('error', error);
    mockProcesses[0].stdin.emit('error', error);
    const snapshot = runtime.list().find((item) => item.runId === runId)!;
    expect(snapshot).toMatchObject({ status: 'failed', errorCode: 'RPC_STDIN_WRITE_FAILED' });
    expect(snapshot.events.filter((event) => event.type === 'rpc_stdin_error')).toHaveLength(1);
  });

  it('RPC stdin: writableEnded/destroyed 与已退出进程均拒绝写入', async () => {
    const endedRunId = await runtime.start({ projectRoot: '/test', name: 'stdin-ended', initialTask: '' });
    mockProcesses[0].stdin.writableEnded = true;
    await expect(runtime.prompt(endedRunId, 'late')).rejects.toThrow('RPC stdin 不可写');
    expect(runtime.list().find((item) => item.runId === endedRunId)).toMatchObject({ status: 'failed', errorCode: 'RPC_STDIN_WRITE_FAILED' });

    const destroyedRunId = await runtime.start({ projectRoot: '/test', name: 'stdin-destroyed', initialTask: '' });
    mockProcesses[1].stdin.destroyed = true;
    await expect(runtime.steer(destroyedRunId, 'late')).rejects.toThrow('RPC stdin 不可写');

    const exitedRunId = await runtime.start({ projectRoot: '/test', name: 'stdin-exited', initialTask: '' });
    mockProcesses[2].emit('exit', 0, null);
    await expect(runtime.followUp(exitedRunId, 'late')).rejects.toThrow('RPC stdin 不可写');
  });

  it('Persistence MVP: 恢复历史时清空 PID/pending，并将旧在线状态降级为 aborted', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      schemaVersion: 2,
      savedAt: 123,
      records: [{
        runId: 'old-run', name: 'old-agent', pid: 9876, status: 'running', events: [],
        stderrSummary: '', startedAt: 100, lastActivity: 200, exitCode: null,
        exitSignal: null, pendingUiRequests: [{ id: 'stale' }], historical: false,
      }],
    }));
    runtime.configurePersistence('/tmp/agentflux/runtime-history.v1.json');
    expect(runtime.list()).toEqual([expect.objectContaining({
      runId: 'old-run', taskId: 'legacy-task-old-run', executionId: 'legacy-execution-old-run',
      taskTitle: 'old-agent', priority: 'normal', workStyle: 'agent_decides',
      pid: null, status: 'aborted', pendingUiRequests: [], historical: true,
    })]);
  });

  it('Persistence diagnostics: 损坏文件与未知 schema 可见但不阻止启动', () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw new SyntaxError('bad json'); });
    runtime.configurePersistence('/tmp/agentflux/runtime-history.v1.json');
    expect(runtime.getDiagnostics().persistence).toMatchObject({ status: 'corrupt' });
    expect(runtime.list()).toEqual([]);

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ schemaVersion: 99, records: [] }));
    runtime.configurePersistence('/tmp/agentflux/runtime-history.v1.json');
    expect(runtime.getDiagnostics().persistence).toMatchObject({
      status: 'unsupported', detectedSchemaVersion: 99,
    });
    expect(runtime.list()).toEqual([]);
  });

  it('Persistence MVP: 使用 schema v2、容量上限和 temp rename 原子写', async () => {
    mockExistsSync.mockImplementation((candidate) => String(candidate) === '/test' || String(candidate).endsWith('entry.ts') || String(candidate).includes('node_modules'));
    runtime.configurePersistence('/tmp/agentflux/runtime-history.v1.json', 1);
    vi.useFakeTimers();
    await runtime.start({ projectRoot: '/test', name: 'persisted', initialTask: '' });
    feedStdout(0, JSON.stringify({ type: 'agent_start' }));
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    expect(fs.writeFileSync).toHaveBeenCalled();
    const [tempPath, raw] = vi.mocked(fs.writeFileSync).mock.calls.at(-1)!;
    expect(tempPath).toBe('/tmp/agentflux/runtime-history.v1.json.tmp');
    const parsed = JSON.parse(String(raw));
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.records).toHaveLength(1);
    expect(fs.renameSync).toHaveBeenCalledWith('/tmp/agentflux/runtime-history.v1.json.tmp', '/tmp/agentflux/runtime-history.v1.json');
  });

  it('Task contract: snapshot 与 history 持久化 task/execution/run IDs、标题、优先级和模式', async () => {
    runtime.configurePersistence('/tmp/agentflux/runtime-history.v1.json');
    vi.useFakeTimers();
    const runId = await runtime.start({
      projectRoot: '/test', name: 'lead', taskTitle: 'Ship control room', initialTask: 'Implement the P0 slice',
      priority: 'critical', workStyle: 'workflow',
    });
    const snapshot = runtime.list().find((item) => item.runId === runId)!;
    expect(snapshot).toMatchObject({
      runId, taskTitle: 'Ship control room', initialPrompt: 'Implement the P0 slice', priority: 'critical', workStyle: 'workflow',
    });
    expect(snapshot.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(snapshot.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set([snapshot.taskId, snapshot.executionId, snapshot.runId]).size).toBe(3);
    await vi.advanceTimersByTimeAsync(150);
    vi.useRealTimers();
    const raw = String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]);
    expect(JSON.parse(raw).records[0]).toMatchObject({ taskId: snapshot.taskId, executionId: snapshot.executionId, runId });
  });

  it('Work style: fixed 注入闭集 env，agent_decides 不继承父进程值', async () => {
    process.env.AGENTFLUX_WORK_STYLE = 'team';
    await runtime.start({ projectRoot: '/test', name: 'auto', initialTask: 'auto', workStyle: 'agent_decides' });
    const autoEnv = (spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
    expect(autoEnv.AGENTFLUX_WORK_STYLE).toBeUndefined();

    await runtime.start({ projectRoot: '/test', name: 'fixed', initialTask: 'fixed', workStyle: 'workflow' });
    const fixedEnv = (spawnMock.mock.calls[1][2] as { env: NodeJS.ProcessEnv }).env;
    expect(fixedEnv.AGENTFLUX_WORK_STYLE).toBe('workflow');
    delete process.env.AGENTFLUX_WORK_STYLE;
  });

  it('Task contract: 拒绝 renderer 不支持的 priority/workStyle', async () => {
    await expect(runtime.start({ projectRoot: '/test', name: 'bad', initialTask: 'bad', priority: 'urgent' as any })).rejects.toThrow('priority 不受支持');
    await expect(runtime.start({ projectRoot: '/test', name: 'bad', initialTask: 'bad', workStyle: 'swarm' as any })).rejects.toThrow('workStyle 不受支持');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('P1 readiness: 首个合法 RPC 完成握手且 initial prompt 只发送一次', async () => {
    const runId = await runtime.start({ projectRoot: '/test', name: 'ready', initialTask: 'once' });
    const ready = runtime.waitUntilReady(runId, 1000);
    expect(mockProcesses[0].stdin.write).toHaveBeenCalledTimes(1);
    feedStdout(0, JSON.stringify({ type: 'agent_start' }));
    await expect(ready).resolves.toBeUndefined();
    expect(mockProcesses[0].stdin.write).toHaveBeenCalledTimes(1);
  });

  it('P1 readiness: timeout 终止并给出稳定错误码', async () => {
    vi.useFakeTimers();
    const runId = await runtime.start({ projectRoot: '/test', name: 'timeout', initialTask: 'wait' });
    const ready = runtime.waitUntilReady(runId, 50);
    const assertion = expect(ready).rejects.toThrow('RPC_READY_TIMEOUT');
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(runtime.list()[0]).toMatchObject({ status: 'failed', errorCode: 'RPC_READY_TIMEOUT' });
    vi.useRealTimers();
  });

  it('P1 readiness: 早退与 exit0 无协议均失败且 promise 不悬挂', async () => {
    const runId = await runtime.start({ projectRoot: '/test', name: 'early', initialTask: 'wait' });
    const ready = runtime.waitUntilReady(runId, 1000);
    emitExit(0, 0, null);
    await expect(ready).rejects.toThrow('RPC_EXIT_ZERO_WITHOUT_PROTOCOL');
    expect(runtime.list()[0]).toMatchObject({ status: 'failed', errorCode: 'RPC_EXIT_ZERO_WITHOUT_PROTOCOL' });
  });

  it('P1 readiness: wait 前已退出立即拒绝且不覆盖原错误码', async () => {
    const runId = await runtime.start({ projectRoot: '/test', name: 'pre-exit', initialTask: 'wait' });
    emitExit(0, 1, null);
    await expect(runtime.waitUntilReady(runId, 1000)).rejects.toThrow('RPC_EXIT_BEFORE_READY');
    expect(runtime.list()[0].errorCode).toBe('RPC_EXIT_BEFORE_READY');
  });

  it('P1 readiness: null/array/empty object/empty type 不算合法 RPC', async () => {
    vi.useFakeTimers();
    const runId = await runtime.start({ projectRoot: '/test', name: 'invalid-frame', initialTask: 'wait' });
    for (const frame of ['null', '[]', '{}', '{"type":""}']) feedStdout(0, frame);
    const ready = runtime.waitUntilReady(runId, 25);
    const assertion = expect(ready).rejects.toThrow('RPC_READY_TIMEOUT');
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    vi.useRealTimers();
  });

  it('P1 terminal: process_error 后 exit 去重为一个终态事件', async () => {
    await runtime.start({ projectRoot: '/test', name: 'dedupe', initialTask: '' });
    emitError(0, new Error('spawn failed'));
    emitExit(0, 1, null);
    const terminal = runtime.list()[0].events.filter((event) => event.type === 'process_error' || event.type === 'process_exit');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: 'process_error', data: { errorCode: 'SPAWN_FAILED' } });
  });

  it('P1 retry: runtime derives provenance and preserves source record', async () => {
    const sourceRunId = await runtime.start({ projectRoot: '/test', name: 'lead', taskTitle: 'Original', initialTask: 'same prompt', priority: 'high', workStyle: 'workflow' });
    emitExit(0, 1, null);
    const before = structuredClone(runtime.list().find((item) => item.runId === sourceRunId)!);
    const retryRunId = await runtime.retry(sourceRunId);
    const source = runtime.list().find((item) => item.runId === sourceRunId)!;
    const retry = runtime.list().find((item) => item.runId === retryRunId)!;
    expect(source).toEqual(before);
    expect(retry).toMatchObject({ retryOfRunId: sourceRunId, rootRunId: sourceRunId, retryAttempt: 1, taskTitle: 'Original', initialPrompt: 'same prompt', priority: 'high', workStyle: 'workflow' });
    expect(retry.executionId).not.toBe(source.executionId);
  });

});
