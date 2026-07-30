/**
 * Runtime Manager — 子进程 spawn/终止/生命周期管理
 *
 * 职责：
 * - 解析 Node/PI CLI 路径
 * - spawn 子进程并返回 RuntimeRecord
 * - 跨平台进程终止（Windows taskkill / POSIX process group kill）
 * - 进程退出/错误事件绑定
 * - 状态管理（starting/running/blocked/done/failed/aborted）
 */

import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { isWorkStyleSelection, type TaskPriority, type WorkStyleSelection } from '../shared/runtime-contract';
import { ProtocolAdapter, type IncomingMessage, type PendingExtensionUIRequest, PROTOCOL_EVENT_FRAME, PROTOCOL_EVENT_ERROR } from './protocol-adapter';

// ─── 常量 ───────────────────────────────────────────────────────────────────

const SIGTERM_TIMEOUT_MS = 3000;
const STDERR_SUMMARY_MAX_LINES = 50;
const MINIMUM_PI_NODE_VERSION = '22.19.0';

// ─── 类型 ───────────────────────────────────────────────────────────────────

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'aborted';

export interface SessionEvent {
  type: string;
  timestamp: number;
  data?: unknown;
}

export type NodeRuntimeSource = 'trusted-env' | 'npm' | 'process' | 'path' | 'native-cli' | 'electron-opt-in';

export interface NodeRuntimeResolution {
  command: string;
  source: NodeRuntimeSource;
  runAsNode: boolean;
}

export interface SpawnCommand {
  command: string;
  argsPrefix: string[];
  source: 'env' | 'project' | 'path';
  runAsNode: boolean;
  cliPath: string;
  runtimeSource: NodeRuntimeSource;
  runtimeVersion: string | null;
}

export interface RuntimeRecord {
  projectRoot: string;
  runId: string;
  taskId: string;
  executionId: string;
  retryOfRunId: string | null;
  rootRunId: string;
  retryAttempt: number;
  taskTitle: string;
  initialPrompt: string;
  priority: TaskPriority;
  workStyle: WorkStyleSelection;
  name: string;
  proc: ChildProcess;
  adapter: ProtocolAdapter;
  status: SessionStatus;
  events: SessionEvent[];
  stderrSummary: string;
  cliSource: 'env' | 'project' | 'path';
  cliPath: string;
  runtimeSource: NodeRuntimeSource;
  runtimeExecutable: string;
  runtimeVersion: string | null;
  startedAt: number;
  lastActivity: number;
  exitCode: number | null;
  exitSignal: string | null;
  errorCode: string | null;
  validRpcCount: number;
}

export interface AgentSessionSnapshot {
  projectRoot: string;
  runId: string;
  taskId: string;
  executionId: string;
  retryOfRunId: string | null;
  rootRunId: string;
  retryAttempt: number;
  taskTitle: string;
  initialPrompt: string;
  priority: TaskPriority;
  workStyle: WorkStyleSelection;
  name: string;
  pid: number | null;
  status: SessionStatus;
  events: SessionEvent[];
  stderrSummary: string;
  cliSource: 'env' | 'project' | 'path';
  cliPath: string;
  runtimeSource: NodeRuntimeSource;
  runtimeExecutable: string;
  runtimeVersion: string | null;
  startedAt: number;
  lastActivity: number;
  exitCode: number | null;
  exitSignal: string | null;
  errorCode: string | null;
  retryable: boolean;
  pendingUiRequests: PendingExtensionUIRequest[];
  /** 恢复记录仅供审计；永远不代表一个可连接的旧 PID。 */
  historical: boolean;
}

export type StartOptions = Partial<import('../shared/runtime-contract').RuntimeStartOptions> & Pick<import('../shared/runtime-contract').RuntimeStartOptions, 'projectRoot' | 'name'>;

export interface NodeVersionTestHooks {
  nodeVersionProbe?: (command: string) => string | null;
}

// ─── 事件 ───────────────────────────────────────────────────────────────────

export const MANAGER_EVENT_RECORD_UPDATE = 'record-update';
export const MANAGER_EVENT_RECORD_REMOVED = 'record-removed';
export const MANAGER_EVENT_RUNTIME_EVENT = 'runtime-event';

/**
 * Resolve the executable used for a JavaScript CLI without trusting renderer input.
 */
export function resolveJavaScriptRuntime(
  processExecPath: string,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean = fs.existsSync,
): NodeRuntimeResolution {
  const isNodeExecutable = (candidate: string): boolean => /^node(?:\.exe)?$/i.test(path.basename(candidate));
  const trustedCandidates: Array<{ value?: string; source: NodeRuntimeSource }> = [
    { value: env.AGENTFLUX_NODE_EXECUTABLE?.trim(), source: 'trusted-env' },
    { value: env.npm_node_execpath?.trim(), source: 'npm' },
  ];
  for (const candidate of trustedCandidates) {
    if (!candidate.value) continue;
    if (!path.isAbsolute(candidate.value) || !exists(candidate.value) || !isNodeExecutable(candidate.value)) {
      if (candidate.source === 'trusted-env') {
        throw new Error(`AGENTFLUX_NODE_EXECUTABLE 必须指向存在的 Node 可执行文件: ${candidate.value}`);
      }
      continue;
    }
    return { command: candidate.value, source: candidate.source, runAsNode: false };
  }

  if (isNodeExecutable(processExecPath)) {
    return { command: processExecPath, source: 'process', runAsNode: false };
  }

  if (env.AGENTFLUX_ALLOW_ELECTRON_AS_NODE === '1') {
    return { command: processExecPath, source: 'electron-opt-in', runAsNode: true };
  }
  return { command: 'node', source: 'path', runAsNode: false };
}

// ─── RuntimeManager 类 ──────────────────────────────────────────────────────

export class RuntimeManager extends EventEmitter {
  private records: Map<string, RuntimeRecord> = new Map();

  constructor(private readonly testHooks: NodeVersionTestHooks = {}) {
    super();
  }

  // ── 启动子进程 ──────────────────────────────────────────────────────────

  /**
   * 启动一个独立的 pi --mode rpc 子进程。
   * 返回新创建的 RuntimeRecord（不含 adapter 的事件注册 — 由外部 caller 负责）。
   */
  async createProcess(options: StartOptions): Promise<RuntimeRecord> {
    const { projectRoot, name } = options;
    const taskTitle = options.taskTitle?.trim() || options.initialTask?.trim().slice(0, 80) || 'Untitled task';
    const priority = options.priority ?? 'normal';
    const workStyle = options.workStyle ?? 'agent_decides';

    // 参数校验
    if (!projectRoot || typeof projectRoot !== 'string') {
      throw new Error('projectRoot 是必填的字符串参数');
    }
    if (!name || typeof name !== 'string') {
      throw new Error('name 是必填的字符串参数');
    }
    if (!['low', 'normal', 'high', 'critical'].includes(priority)) {
      throw new Error(`priority 不受支持: ${String(priority)}`);
    }
    if (!isWorkStyleSelection(workStyle)) {
      throw new Error(`workStyle 不受支持: ${String(workStyle)}`);
    }

    if (!path.isAbsolute(projectRoot)) {
      throw new Error(`INVALID_PROJECT: projectRoot 必须是绝对路径，收到: ${projectRoot}`);
    }
    if (!fs.existsSync(projectRoot)) {
      throw new Error(`INVALID_PROJECT: projectRoot 目录不存在: ${projectRoot}`);
    }

    const entryPath = path.join(projectRoot, 'src', 'entry.ts');
    if (!fs.existsSync(entryPath)) {
      throw new Error(`INVALID_PROJECT: projectRoot 缺少 src/entry.ts: ${entryPath}`);
    }

    const runId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const uniqueName = this.makeUniqueName(name.trim());
    const { proc, resolved } = this.spawnProcess(projectRoot, uniqueName, entryPath, runId, workStyle);

    const now = Date.now();
    const record: RuntimeRecord = {
      projectRoot,
      runId,
      taskId,
      executionId,
      retryOfRunId: null,
      rootRunId: runId,
      retryAttempt: 0,
      taskTitle,
      initialPrompt: options.initialTask?.trim() ?? '',
      priority,
      workStyle,
      name: uniqueName,
      proc,
      adapter: null as unknown as ProtocolAdapter, // set after creation
      status: 'starting',
      events: [],
      stderrSummary: '',
      cliSource: resolved.source,
      cliPath: resolved.cliPath,
      runtimeSource: resolved.runtimeSource,
      runtimeExecutable: resolved.command,
      runtimeVersion: resolved.runtimeVersion,
      startedAt: now,
      lastActivity: now,
      exitCode: null,
      exitSignal: null,
      errorCode: null,
      validRpcCount: 0,
    };

    // Create protocol adapter
    const adapter = new ProtocolAdapter(
      proc,
      runId,
      (rid, msg) => this.emit('ui_request', rid, msg),
      (rid, msg) => this.emit('message', rid, msg),
    );
    record.adapter = adapter;

    // Setup stderr collection
    adapter.setupStderr((text: string) => {
      const current = this.records.get(runId);
      if (!current) return;
      const lines = text.split('\n');
      const newStderr = current.stderrSummary
        ? current.stderrSummary + '\n' + lines.join('\n')
        : lines.join('\n');
      const allLines = newStderr.split('\n');
      const trimmed = allLines.slice(-STDERR_SUMMARY_MAX_LINES);
      current.stderrSummary = trimmed.join('\n');
      this.emit(MANAGER_EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    });

    // Bridge adapter errors to manager events (for facade handling)
    adapter.on('error', (error: Error) => {
      this.emit('adapter_error', runId, error);
    });

    this.records.set(runId, record);
    this.setupProcessHandlers(record, entryPath);

    return record;
  }

  getRecord(runId: string): RuntimeRecord | undefined {
    return this.records.get(runId);
  }

  hasRecord(runId: string): boolean {
    return this.records.has(runId);
  }

  ensureRecord(runId: string): RuntimeRecord {
    const record = this.records.get(runId);
    if (!record) throw new Error(`Runtime 记录不存在: ${runId}`);
    return record;
  }

  getAllRecords(): RuntimeRecord[] {
    return Array.from(this.records.values());
  }

  removeRecord(runId: string): void {
    this.records.delete(runId);
  }

  clearRecords(): void {
    this.records.clear();
  }

  // ── spawn 参数构建 ──

  private buildSpawnArgs(entryPath: string, name: string): string[] {
    const args = [
      '--mode', 'rpc',
      '--approve',
      '-e', entryPath,
      '--name', name,
    ];
    const model = process.env.AGENTFLUX_PI_MODEL?.trim();
    if (model && /^[a-zA-Z0-9._/-]{1,160}$/.test(model)) args.push('--model', model);
    const thinking = process.env.AGENTFLUX_PI_THINKING?.trim();
    if (thinking && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) {
      args.push('--thinking', thinking);
    }
    const testExtension = process.env.AGENTFLUX_DESKTOP_TEST_EXTENSION?.trim();
    if (process.env.AGENTFLUX_DESKTOP_LIVE_TEST === '1' && testExtension) {
      const projectRoot = path.dirname(path.dirname(entryPath));
      const allowedRoot = path.resolve(projectRoot, 'desktop', 'tests', 'live');
      const resolvedExtension = path.resolve(testExtension);
      const relative = path.relative(allowedRoot, resolvedExtension);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(resolvedExtension)) {
        throw new Error('AGENTFLUX_DESKTOP_TEST_EXTENSION 必须位于 desktop/tests/live/');
      }
      args.push('-e', resolvedExtension);
    }
    return args;
  }

  private resolveSpawnCommand(projectRoot: string): SpawnCommand {
    const javascriptCommand = (cliPath: string, source: 'env' | 'project'): SpawnCommand => {
      let runtime = resolveJavaScriptRuntime(process.execPath, process.env);
      let runtimeVersion = this.detectNodeVersion(runtime.command, runtime.runAsNode);
      if (
        runtime.source !== 'trusted-env' &&
        runtime.source !== 'electron-opt-in' &&
        (!runtimeVersion || !this.isNodeVersionSupported(runtimeVersion)) &&
        runtime.command !== 'node'
      ) {
        runtime = { command: 'node', source: 'path', runAsNode: false };
        runtimeVersion = this.detectNodeVersion(runtime.command, false);
      }
      if (!runtimeVersion || !this.isNodeVersionSupported(runtimeVersion)) {
        throw new Error(
          `NODE_INCOMPATIBLE: Agent CLI 需要 Node >=${MINIMUM_PI_NODE_VERSION}；当前 ${runtime.command} ` +
          `返回 ${runtimeVersion ?? '未知版本'}。请安装兼容 Node，或由 operator 设置 ` +
          'AGENTFLUX_NODE_EXECUTABLE 为 node 可执行文件的绝对路径。',
        );
      }
      return {
        command: runtime.command,
        argsPrefix: [cliPath],
        source,
        runAsNode: runtime.runAsNode,
        cliPath,
        runtimeSource: runtime.source,
        runtimeVersion,
      };
    };
    const override = process.env.AGENTFLUX_PI_CLI?.trim();
    if (override) {
      if (!path.isAbsolute(override) || !fs.existsSync(override)) {
        throw new Error(`AGENTFLUX_PI_CLI 必须指向存在的绝对路径: ${override}`);
      }
      const extension = path.extname(override).toLowerCase();
      return ['.js', '.mjs', '.cjs'].includes(extension)
        ? javascriptCommand(override, 'env')
        : {
          command: override, argsPrefix: [], source: 'env', runAsNode: false,
          cliPath: override, runtimeSource: 'native-cli', runtimeVersion: null,
        };
    }

    const candidates = [
      path.join(projectRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
      path.join(projectRoot, 'node_modules', 'pi-coding-agent', 'dist', 'cli.js'),
    ];
    const projectCli = candidates.find((candidate) => fs.existsSync(candidate));
    if (projectCli) {
      return javascriptCommand(projectCli, 'project');
    }
    throw new Error(
      'CLI_NOT_FOUND: 未找到项目固定的 pi CLI。请安装项目依赖，或由 operator 设置 AGENTFLUX_PI_CLI；' +
      '为避免版本漂移，Desktop 不会静默回退到 PATH 中的全局 pi。',
    );
  }

  private isNodeVersionSupported(version: string): boolean {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match) return false;
    const actual = match.slice(1).map(Number);
    const required = MINIMUM_PI_NODE_VERSION.split('.').map(Number);
    for (let index = 0; index < required.length; index += 1) {
      if (actual[index] > required[index]) return true;
      if (actual[index] < required[index]) return false;
    }
    return true;
  }

  private detectNodeVersion(command: string, runAsNode = false): string | null {
    if (this.testHooks.nodeVersionProbe) {
      try {
        return this.testHooks.nodeVersionProbe(command);
      } catch {
        return null;
      }
    }
    if (command === process.execPath && /^node(?:\.exe)?$/i.test(path.basename(process.execPath))) {
      return process.version;
    }
    try {
      const result = spawnSync(command, ['--version'], {
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 2000,
        env: runAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
      });
      const version = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
      return /^v\d+\.\d+\.\d+/.test(version) ? version : null;
    } catch {
      return null;
    }
  }

  private makeUniqueName(requested: string): string {
    const used = new Set(Array.from(this.records.values())
      .filter((record) => record.exitCode === null && record.exitSignal === null && !record.proc.killed)
      .map((record) => record.name));
    if (!used.has(requested)) return requested;
    let suffix = 2;
    while (used.has(`${requested}-${suffix}`)) suffix += 1;
    return `${requested}-${suffix}`;
  }

  private spawnProcess(
    projectRoot: string,
    name: string,
    entryPath: string,
    runId: string,
    workStyle: WorkStyleSelection,
  ): { proc: ChildProcess; resolved: SpawnCommand } {
    const resolved = this.resolveSpawnCommand(projectRoot);
    const args = [...resolved.argsPrefix, ...this.buildSpawnArgs(entryPath, name)];
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTFLUX_RPC_INBOX_PUMP: '1',
      AGENTFLUX_AGENT_NAME: name,
      AGENTFLUX_RUNTIME_INSTANCE_ID: runId,
      AGENTFLUX_PI_SOURCE: resolved.source,
    };
    if (workStyle !== 'agent_decides') childEnv.AGENTFLUX_WORK_STYLE = workStyle;
    else delete childEnv.AGENTFLUX_WORK_STYLE;
    delete childEnv.ELECTRON_RUN_AS_NODE;
    if (resolved.runAsNode) childEnv.ELECTRON_RUN_AS_NODE = '1';
    const proc = spawn(resolved.command, args, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: childEnv,
      shell: false,
    });
    return { proc, resolved };
  }

  // ── 进程事件绑定 ────────────────────────────────────────────────────────

  private setupProcessHandlers(record: RuntimeRecord, _entryPath: string): void {
    const { proc, runId } = record;

    proc.on('exit', (code, signal) => {
      const current = this.records.get(runId);
      if (!current) return;

      // Mark adapter as exited so sendJson can detect it
      current.adapter._exited = true;

      current.exitCode = code;
      current.exitSignal = signal ? signal.toString() : null;
      const duplicateTerminal = current.errorCode === 'SPAWN_FAILED';
      if (code === 0 && current.validRpcCount === 0) current.errorCode = 'RPC_EXIT_ZERO_WITHOUT_PROTOCOL';
      else if (current.validRpcCount === 0 && current.errorCode === null) current.errorCode = 'RPC_EXIT_BEFORE_READY';
      if (current.status !== 'aborted' && current.status !== 'failed') {
        current.status = code === 0 && current.validRpcCount > 0 ? 'done' : 'failed';
      }
      current.lastActivity = Date.now();
      const stderrSummary = current.stderrSummary.trim().slice(-2000);
      const exitEvent = {
        code,
        signal: signal?.toString() ?? null,
        stderrSummary: stderrSummary || null,
        cliSource: current.cliSource,
        cliPath: current.cliPath,
        runtimeSource: current.runtimeSource,
        runtimeExecutable: current.runtimeExecutable,
        runtimeVersion: current.runtimeVersion,
        requiredNodeVersion: `>=${MINIMUM_PI_NODE_VERSION}`,
        errorCode: current.errorCode,
      };
      if (!duplicateTerminal) {
        this.pushEvent(current, 'process_exit', exitEvent);
        this.emit(MANAGER_EVENT_RUNTIME_EVENT, { runId, event: { type: 'process_exit', data: exitEvent } });
      }
      this.emit(MANAGER_EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    });

    proc.on('error', (err) => {
      const current = this.records.get(runId);
      if (!current) return;
      current.status = 'failed';
      current.errorCode = 'SPAWN_FAILED';
      current.lastActivity = Date.now();
      current.events.push({
        type: 'process_error',
        timestamp: Date.now(),
        data: { message: err.message, errorCode: 'SPAWN_FAILED' },
      });
      this.emit(MANAGER_EVENT_RUNTIME_EVENT, { runId, event: { type: 'process_error', data: { message: err.message, errorCode: 'SPAWN_FAILED' } } });
      this.emit(MANAGER_EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    });
  }

  // ── 进程终止 ──────────────────────────────────────────────────────────

  /**
   * 根据平台杀死指定进程及其子进程树。
   */
  killProcess(proc: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!proc || proc.killed) { resolve(); return; }
      const pid = proc.pid;
      if (pid === undefined) { resolve(); return; }

      let resolved = false;
      const safeResolve = (): void => { if (!resolved) { resolved = true; resolve(); } };

      if (process.platform === 'win32') {
        const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true, shell: false,
        });
        const fallbackTimer = setTimeout(() => {
          if (!proc.killed) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
          safeResolve();
        }, SIGTERM_TIMEOUT_MS);
        taskkill.on('exit', () => { clearTimeout(fallbackTimer); safeResolve(); });
        taskkill.on('error', () => { clearTimeout(fallbackTimer); safeResolve(); });
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
        const fallbackTimer = setTimeout(() => {
          if (!proc.killed) {
            try { process.kill(-pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
          }
          safeResolve();
        }, SIGTERM_TIMEOUT_MS);
        const exitHandler = (): void => { clearTimeout(fallbackTimer); safeResolve(); };
        proc.once('exit', exitHandler);
        proc.once('error', () => { clearTimeout(fallbackTimer); safeResolve(); });
      }
    });
  }

  /** Let pi RPC consume stdin EOF and run session_shutdown before force-kill fallback. */
  async stopProcessGracefully(proc: ChildProcess, graceMs = 1_500): Promise<void> {
    if (proc.killed) return;
    let settled = false;
    let exited = proc.exitCode != null || proc.signalCode != null;
    await new Promise<void>((resolveDone) => {
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolveDone(); };
      const timer = setTimeout(finish, graceMs);
      proc.once('exit', () => { exited = true; finish(); });
      proc.once('error', finish);
      try { proc.stdin?.end(); } catch { finish(); }
    });
    if (!proc.killed && !exited) await this.killProcess(proc);
  }

  // ── 事件工具 ──────────────────────────────────────────────────────────

  /** 向 record 添加事件，缓冲上限 1000 条 */
  pushEvent(record: RuntimeRecord, type: string, data: unknown): void {
    record.events.push({ type, timestamp: Date.now(), data });
    if (record.events.length > 1000) {
      record.events.splice(0, record.events.length - 1000);
    }
  }

  getSnapshot(runId: string): AgentSessionSnapshot {
    const r = this.records.get(runId);
    if (!r) throw new Error(`Runtime 记录不存在: ${runId}`);
    return {
      projectRoot: r.projectRoot,
      runId: r.runId,
      taskId: r.taskId,
      executionId: r.executionId,
      retryOfRunId: r.retryOfRunId,
      rootRunId: r.rootRunId,
      retryAttempt: r.retryAttempt,
      taskTitle: r.taskTitle,
      initialPrompt: r.initialPrompt,
      priority: r.priority,
      workStyle: r.workStyle,
      name: r.name,
      pid: r.proc.pid ?? null,
      status: r.status,
      events: [...r.events],
      stderrSummary: r.stderrSummary,
      cliSource: r.cliSource,
      cliPath: r.cliPath,
      runtimeSource: r.runtimeSource,
      runtimeExecutable: r.runtimeExecutable,
      runtimeVersion: r.runtimeVersion,
      startedAt: r.startedAt,
      lastActivity: r.lastActivity,
      exitCode: r.exitCode,
      exitSignal: r.exitSignal,
      errorCode: r.errorCode,
      retryable: ['failed', 'aborted'].includes(r.status) && Boolean(r.projectRoot),
      pendingUiRequests: Array.from(r.adapter.pendingUiRequests.values()),
      historical: false,
    };
  }

  /** Shorthand to update status and emit record-update */
  setStatus(runId: string, status: SessionStatus): void {
    const r = this.records.get(runId);
    if (r) {
      r.status = status;
      r.lastActivity = Date.now();
      this.emit(MANAGER_EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    }
  }

  updateActivity(runId: string): void {
    const r = this.records.get(runId);
    if (r) r.lastActivity = Date.now();
  }

  mapResponseStatus(status: string): SessionStatus {
    switch (status) {
      case 'running': return 'running';
      case 'blocked': return 'blocked';
      case 'done':
      case 'completed': return 'done';
      case 'failed':
      case 'error': return 'failed';
      case 'aborted':
      case 'cancelled': return 'aborted';
      default: return 'running';
    }
  }
}
