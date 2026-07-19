/**
 * Agent Runtime Manager — Electron 主进程侧
 *
 * 多进程模型：每个 start() 独立 spawn pi --mode rpc 子进程，
 * 通过 Map<runId, RuntimeRecord> 管理所有运行中记录。
 *
 * 通信协议：自定义 LF 分帧器（逐字节缓冲），JSONL over stdin/stdout。
 * 进程终止：Windows → taskkill /PID /T /F，POSIX → process group kill -TERM。
 *
 * 事件系统：
 *   - EVENT_RECORD_UPDATE: 携带完整 snapshot，用于 store runtimes 更新
 *   - EVENT_RUNTIME_EVENT: 携带 {runId, event} envelope，每条真实 RPC JSON 产生一个事件
 *   - EVENT_RECORD_REMOVED: 记录被移除
 */

import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { isWorkStyleSelection, type RuntimeStartOptions, type TaskPriority, type WorkStyleSelection } from '../shared/runtime-contract';

// ─── 类型定义 ───────────────────────────────────────────────────────────────

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
  pendingUiRequests: Map<string, PendingExtensionUIRequest>;
}

export type ExtensionUIDialogMethod = 'select' | 'confirm' | 'input';

export interface PendingExtensionUIRequest {
  runId: string;
  id: string;
  method: ExtensionUIDialogMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  createdAt: number;
  expiresAt: number;
}

export type ExtensionUIResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

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

export type StartOptions = Partial<RuntimeStartOptions> & Pick<RuntimeStartOptions, 'projectRoot' | 'name'>;
export type { TaskPriority, WorkStyleSelection } from '../shared/runtime-contract';

interface SpawnCommand {
  command: string;
  argsPrefix: string[];
  source: 'env' | 'project' | 'path';
  runAsNode: boolean;
  cliPath: string;
  runtimeSource: NodeRuntimeSource;
  runtimeVersion: string | null;
}

export type NodeRuntimeSource = 'trusted-env' | 'npm' | 'process' | 'path' | 'native-cli' | 'electron-opt-in';

export interface NodeRuntimeResolution {
  command: string;
  source: NodeRuntimeSource;
  runAsNode: boolean;
}

/**
 * Resolve the executable used for a JavaScript CLI without trusting renderer input.
 * Electron's embedded Node is deliberately not the default: Electron may ship an
 * older Node/undici combination than the project CLI supports.
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

  // Diagnostic/test-only escape hatch. Normal Electron production always asks
  // the operating system to resolve a real `node` executable from PATH.
  if (env.AGENTFLUX_ALLOW_ELECTRON_AS_NODE === '1') {
    return { command: processExecPath, source: 'electron-opt-in', runAsNode: true };
  }
  return { command: 'node', source: 'path', runAsNode: false };
}

/** 发往子进程的 JSONL 消息 — RPC 格式 */
interface OutgoingMessage {
  id: string;
  type: string;
  message?: string;
}

/** 从子进程接收的 JSONL 消息 */
interface IncomingMessage {
  id?: string;
  type: string;
  runId?: string;
  sessionId?: string;
  success?: boolean;
  status?: string;
  content?: unknown;
  error?: string;
  method?: string;
  title?: string;
  options?: unknown;
  timeout?: number;
  placeholder?: string;
  message?: unknown;
}

// ─── 常量 ───────────────────────────────────────────────────────────────────

const SIGTERM_TIMEOUT_MS = 3000;
const STDERR_SUMMARY_MAX_LINES = 50;
const LINE_FEED = 0x0a; // '\n'
const DEFAULT_UI_REQUEST_TIMEOUT_MS = 5 * 60_000;
const PERSISTENCE_SCHEMA_VERSION = 2;
const DEFAULT_HISTORY_CAP = 100;
const MINIMUM_PI_NODE_VERSION = '22.19.0';

interface RuntimePersistenceFile {
  schemaVersion: 2;
  savedAt: number;
  records: AgentSessionSnapshot[];
}

export interface RuntimeDiagnostics {
  persistence: {
    status: 'disabled' | 'missing' | 'ready' | 'corrupt' | 'unsupported';
    message?: string;
    detectedSchemaVersion?: number | string;
  };
}

export interface AgentRuntimeTestHooks {
  /** Main-process test seam only; never exposed through preload/renderer IPC. */
  nodeVersionProbe?: (command: string) => string | null;
}

// ─── AgentRuntime 类 ────────────────────────────────────────────────────────

export class AgentRuntime extends EventEmitter {
  private records: Map<string, RuntimeRecord> = new Map();
  private historicalRecords: Map<string, AgentSessionSnapshot> = new Map();
  private persistencePath: string | null = null;
  private historyCap = DEFAULT_HISTORY_CAP;
  private persistenceTimer: NodeJS.Timeout | null = null;
  private uiTimers = new Map<string, NodeJS.Timeout>();
  private observedStdinErrors = new WeakSet<object>();
  private diagnostics: RuntimeDiagnostics = { persistence: { status: 'disabled' } };

  constructor(private readonly testHooks: AgentRuntimeTestHooks = {}) {
    super();
  }

  // 事件名常量
  static readonly EVENT_RECORD_UPDATE = 'record-update';
  static readonly EVENT_RECORD_REMOVED = 'record-removed';
  /** 每条真实 pi RPC JSON 事件独立分发 */
  static readonly EVENT_RUNTIME_EVENT = 'runtime-event';

  /**
   * 启用受控的运行历史恢复。只恢复 snapshot/events；运行中状态会降级为 aborted，
   * PID 永远清空，避免把上一次应用实例的进程误报为在线。
   */
  configurePersistence(filePath: string, historyCap = DEFAULT_HISTORY_CAP): void {
    if (!path.isAbsolute(filePath)) throw new Error('runtime persistence path 必须是绝对路径');
    this.persistencePath = filePath;
    this.historyCap = Math.max(1, Math.min(500, Math.floor(historyCap)));
    this.loadPersistedHistory();
  }

  getDiagnostics(): RuntimeDiagnostics {
    return JSON.parse(JSON.stringify(this.diagnostics)) as RuntimeDiagnostics;
  }

  // ── 启动子进程 ──────────────────────────────────────────────────────────

  /**
   * 启动一个独立的 pi --mode rpc 子进程，立即通过 stdin 发送 initialTask。
   *
   * @param options 启动选项
   * @returns 新创建的 runId
   */
  async start(options: StartOptions): Promise<string> {
    const { projectRoot, name, initialTask } = options;
    const taskTitle = options.taskTitle?.trim() || initialTask?.trim().slice(0, 80) || 'Untitled task';
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
      initialPrompt: initialTask?.trim() ?? '',
      priority,
      workStyle,
      name: uniqueName,
      proc,
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
      pendingUiRequests: new Map(),
    };

    this.records.set(runId, record);
    this.setupProcessHandlers(record, entryPath);

    // initialTask 非空时发送初始 prompt，为空时不发送
    if (initialTask && typeof initialTask === 'string' && initialTask.trim().length > 0) {
      await this.sendJson(runId, {
        id: runId,
        type: 'prompt',
        message: initialTask,
      });
    }

    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
    return runId;
  }

  async retry(sourceRunId: string): Promise<string> {
    const source = this.records.get(sourceRunId) ?? this.historicalRecords.get(sourceRunId);
    if (!source || !['failed', 'aborted'].includes(source.status)) {
      throw new Error('Only a known failed or aborted run can be retried');
    }
    const projectRoot = source.projectRoot;
    if (!projectRoot) throw new Error('Historical run has no verified workspace provenance');
    const runId = await this.start({ projectRoot, name: source.name.replace(/-\d+$/, ''), taskTitle: source.taskTitle, initialTask: source.initialPrompt, priority: source.priority, workStyle: source.workStyle });
    const created = this.records.get(runId)!;
    created.retryOfRunId = source.runId;
    created.rootRunId = source.rootRunId || source.runId;
    created.retryAttempt = source.retryAttempt + 1;
    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
    return runId;
  }

  async waitUntilReady(runId: string, timeoutMs = 8_000): Promise<void> {
    const current = this.records.get(runId);
    if (!current) throw new Error('RPC_EXIT_BEFORE_READY: runtime record missing');
    if (!current.initialPrompt) return; // idle runtime: child spawn is the readiness contract
    if (current.validRpcCount > 0) return;
    if (current.status === 'failed' || current.exitCode !== null || current.exitSignal !== null || current.errorCode) {
      throw new Error(`${current.errorCode ?? 'RPC_EXIT_BEFORE_READY'}: runtime exited before a valid RPC frame`);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off(AgentRuntime.EVENT_RECORD_UPDATE, onUpdate);
        if (error) reject(error); else resolve();
      };
      const onUpdate = (snapshot: AgentSessionSnapshot) => {
        if (snapshot.runId !== runId) return;
        const record = this.records.get(runId);
        if (record && record.validRpcCount > 0) finish();
        else if (snapshot.status === 'failed') finish(new Error(`${snapshot.errorCode ?? 'RPC_EXIT_BEFORE_READY'}: runtime exited before a valid RPC frame`));
      };
      const timer = setTimeout(() => {
        const record = this.records.get(runId);
        if (record) { record.status = 'failed'; record.errorCode = 'RPC_READY_TIMEOUT'; record.lastActivity = Date.now(); record.proc.kill(); this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId)); }
        finish(new Error('RPC_READY_TIMEOUT: no valid RPC frame received'));
      }, timeoutMs);
      this.on(AgentRuntime.EVENT_RECORD_UPDATE, onUpdate);
      const afterSubscribe = this.records.get(runId);
      if (!afterSubscribe || afterSubscribe.status === 'failed' || afterSubscribe.exitCode !== null || afterSubscribe.exitSignal !== null || afterSubscribe.errorCode) {
        finish(new Error(`${afterSubscribe?.errorCode ?? 'RPC_EXIT_BEFORE_READY'}: runtime exited before a valid RPC frame`));
      } else if (afterSubscribe.validRpcCount > 0) finish();
    });
  }

  /**
   * 生成 spawn 参数数组。所有用户输入参数通过数组元素传递，
   * 不拼接 shell 字符串，防止参数注入。
   */
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
    // Opt-in live-test extension. This is deliberately unavailable to renderer IPC:
    // only a test process which controls the Electron main-process environment can enable it.
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

  /**
   * 创建子进程（不涉及 shell 解释，天然防止注入）。
   */
  private resolveSpawnCommand(projectRoot: string): SpawnCommand {
    const javascriptCommand = (cliPath: string, source: 'env' | 'project'): SpawnCommand => {
      let runtime = resolveJavaScriptRuntime(process.execPath, process.env);
      let runtimeVersion = this.detectNodeVersion(runtime.command, runtime.runAsNode);
      // npm/current-process discovery is advisory. If it points at an older
      // Node, still try the operator's PATH before reporting incompatibility.
      // The explicit AGENTFLUX_NODE_EXECUTABLE remains a hard choice.
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
    // 只有仍有真实子进程的 runtime 占用 routable name。历史/崩溃记录按 runId
    // 保留展示，但不能阻止重启实例以同 recipient 接管 inbox lease/redelivery。
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
    // Renderer can only select this closed policy union. Arbitrary env/args never cross IPC.
    if (workStyle !== 'agent_decides') childEnv.AGENTFLUX_WORK_STYLE = workStyle;
    else delete childEnv.AGENTFLUX_WORK_STYLE;
    // Never leak Electron's parent flag into a real Node child.
    delete childEnv.ELECTRON_RUN_AS_NODE;
    if (resolved.runAsNode) childEnv.ELECTRON_RUN_AS_NODE = '1';
    const proc = spawn(resolved.command, args, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: childEnv,
      // 不使用 shell，防止参数注入
      shell: false,
    });
    return { proc, resolved };
  }

  // ── 进程事件绑定 ────────────────────────────────────────────────────────

  private setupProcessHandlers(record: RuntimeRecord, _entryPath: string): void {
    const { proc, runId } = record;

    // ── stdout: 自定义 LF 分帧器（逐字节缓冲） ──
    let frameBuffer: number[] = [];

    const processFrame = (lineBytes: number[]): void => {
      // 转换为 utf-8 字符串
      const line = Buffer.from(lineBytes).toString('utf-8').trim();
      if (!line) return;

      let msg: IncomingMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        // 非 JSON 行忽略（例如 pi 的日志输出）
        return;
      }

      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string' || msg.type.trim().length === 0) return;

      this.handleIncomingMessage(runId, msg);
    };

    proc.stdout?.on('data', (data: Buffer) => {
      for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        if (byte === LINE_FEED) {
          // 遇到 LF，处理当前帧
          if (frameBuffer.length > 0) {
            processFrame(frameBuffer);
            frameBuffer = [];
          }
        } else {
          frameBuffer.push(byte);
        }
      }
    });

    // 进程退出时刷新缓冲区
    proc.stdout?.on('end', () => {
      if (frameBuffer.length > 0) {
        processFrame(frameBuffer);
        frameBuffer = [];
      }
    });

    // ── stderr: 收集摘要 ──
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      const current = this.records.get(runId);
      if (!current) return;

      const lines = text.split('\n');
      const newStderr = current.stderrSummary
        ? current.stderrSummary + '\n' + lines.join('\n')
        : lines.join('\n');
      const allLines = newStderr.split('\n');
      // 保留最近 STDERR_SUMMARY_MAX_LINES 行
      const trimmed = allLines.slice(-STDERR_SUMMARY_MAX_LINES);
      current.stderrSummary = trimmed.join('\n');
      this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    });

    // Writable streams emit `error` even when write() also reports the same
    // failure through its callback. Keep a permanent listener so an exit/write
    // race can never become an uncaught EPIPE in Electron's main process.
    proc.stdin?.on('error', (error: Error) => {
      this.recordStdinFailure(runId, error);
    });

    // ── exit / error ──
    proc.on('exit', (code, signal) => {
      const current = this.records.get(runId);
      if (!current) return;

      current.exitCode = code;
      current.exitSignal = signal ? signal.toString() : null;
      const duplicateTerminal = current.errorCode === 'SPAWN_FAILED';
      if (code === 0 && current.validRpcCount === 0) current.errorCode = 'RPC_EXIT_ZERO_WITHOUT_PROTOCOL';
      else if (current.validRpcCount === 0 && current.errorCode === null) current.errorCode = 'RPC_EXIT_BEFORE_READY';
      void this.cancelPendingUiRequests(current, 'process_exit', false);
      // 如果已经 aborted/failed，保持当前状态不变
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
        this.emit(AgentRuntime.EVENT_RUNTIME_EVENT, { runId, event: { type: 'process_exit', data: exitEvent } });
      }
      this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
      this.schedulePersistence();
    });

    proc.on('error', (err) => {
      const current = this.records.get(runId);
      if (!current) return;

      current.status = 'failed';
      current.errorCode = 'SPAWN_FAILED';
      void this.cancelPendingUiRequests(current, 'process_error', false);
      current.lastActivity = Date.now();
      current.events.push({
        type: 'process_error',
        timestamp: Date.now(),
        data: { message: err.message, errorCode: 'SPAWN_FAILED' },
      });
      // process_error 也作为独立 runtime event 分发
      this.emit(AgentRuntime.EVENT_RUNTIME_EVENT, { runId, event: { type: 'process_error', data: { message: err.message, errorCode: 'SPAWN_FAILED' } } });
      this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
      this.schedulePersistence();
    });
  }

  // ── 协议消息处理 ────────────────────────────────────────────────────────

  private handleIncomingMessage(runId: string, msg: IncomingMessage): void {
    const record = this.records.get(runId);
    if (!record) return;
    record.validRpcCount += 1;

    // 依据真实 pi RPC 生命周期更新状态
    const type = msg.type ?? '';
    if (type === 'extension_ui_request') {
      this.handleExtensionUIRequest(record, msg);
    }
    if (type === 'agent_start') {
      record.status = 'running';
    } else if (type === 'agent_settled' || type === 'agent_end') {
      // 仅在当前状态不是 aborted/failed 时更新
      if (record.status !== 'aborted' && record.status !== 'failed') {
        // response 顶层 success===false 时视为 failed
        if (msg.content && typeof msg.content === 'object') {
          const content = msg.content as Record<string, unknown>;
          if (content.success === false) {
            record.status = 'failed';
          } else {
            record.status = 'done';
          }
        } else {
          record.status = 'done';
        }
      }
    } else if (type === 'response') {
      // 顶层 success===false 时置 failed
      if (msg.success === false) {
        record.status = 'failed';
      } else if (msg.status) {
        record.status = this.mapResponseStatus(msg.status);
      }
    } else if (msg.status) {
      record.status = this.mapResponseStatus(msg.status);
    }

    record.lastActivity = Date.now();

    this.pushEvent(record, type, msg.content ?? msg);

    // 每条真实 RPC JSON 产生独立 runtime event（含 runId envelope）
    this.emit(AgentRuntime.EVENT_RUNTIME_EVENT, { runId, event: msg });

    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
  }

  private handleExtensionUIRequest(record: RuntimeRecord, msg: IncomingMessage): void {
    if (!msg.id || !['select', 'confirm', 'input'].includes(msg.method ?? '')) return;
    const method = msg.method as ExtensionUIDialogMethod;
    if (method === 'select' && (!Array.isArray(msg.options) || msg.options.some((v) => typeof v !== 'string'))) return;
    const timeout = Number.isFinite(msg.timeout) && (msg.timeout ?? 0) > 0
      ? Math.min(msg.timeout!, DEFAULT_UI_REQUEST_TIMEOUT_MS)
      : DEFAULT_UI_REQUEST_TIMEOUT_MS;
    const now = Date.now();
    const request: PendingExtensionUIRequest = {
      runId: record.runId,
      id: msg.id,
      method,
      title: typeof msg.title === 'string' ? msg.title : 'Agent needs input',
      ...(typeof msg.message === 'string' ? { message: msg.message } : {}),
      ...(method === 'select' ? { options: [...(msg.options as string[])] } : {}),
      ...(typeof msg.placeholder === 'string' ? { placeholder: msg.placeholder } : {}),
      createdAt: now,
      expiresAt: now + timeout,
    };
    record.pendingUiRequests.set(request.id, request);
    record.status = 'blocked';
    const key = `${record.runId}:${request.id}`;
    const previous = this.uiTimers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.uiTimers.delete(key);
      const current = this.records.get(record.runId);
      if (!current?.pendingUiRequests.delete(request.id)) return;
      // pi 自带 timeout 时会自行 resolve；Desktop 默认 timeout 则主动取消以防永久阻塞。
      if (!(Number.isFinite(msg.timeout) && (msg.timeout ?? 0) > 0)) {
        void this.sendJson(record.runId, { type: 'extension_ui_response', id: request.id, cancelled: true }).catch(() => { /* process may have exited */ });
      }
      this.pushEvent(current, 'extension_ui_timeout', { id: request.id, method });
      this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(record.runId));
      this.schedulePersistence();
    }, timeout);
    timer.unref?.();
    this.uiTimers.set(key, timer);
  }

  async respondToExtensionUI(runId: string, response: ExtensionUIResponse): Promise<void> {
    this.ensureRecord(runId);
    if (!response || typeof response !== 'object' || typeof response.id !== 'string' || response.id.length === 0) {
      throw new Error('Extension UI 响应必须包含非空 id');
    }
    const responseKinds = [
      'value' in response && typeof response.value === 'string',
      'confirmed' in response && typeof response.confirmed === 'boolean',
      'cancelled' in response && response.cancelled === true,
    ].filter(Boolean).length;
    if (responseKinds !== 1) throw new Error('Extension UI 响应必须且只能包含 value、confirmed 或 cancelled 之一');
    const record = this.records.get(runId)!;
    const request = record.pendingUiRequests.get(response.id);
    if (!request) throw new Error(`Extension UI 请求不存在或已结束: ${response.id}`);
    if ('confirmed' in response && request.method !== 'confirm') throw new Error('confirmed 只适用于 confirm 请求');
    if ('value' in response) {
      if (request.method === 'confirm') throw new Error('value 不适用于 confirm 请求');
      if (request.method === 'select' && !request.options?.includes(response.value)) {
        throw new Error(`select 响应不在允许选项中: ${response.value}`);
      }
    }
    await this.sendJson(runId, { type: 'extension_ui_response', ...response });
    this.clearUiTimer(runId, response.id);
    record.pendingUiRequests.delete(response.id);
    if (record.status === 'blocked') record.status = 'running';
    record.lastActivity = Date.now();
    this.pushEvent(record, 'extension_ui_response', response);
    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
  }

  private clearUiTimer(runId: string, requestId: string): void {
    const key = `${runId}:${requestId}`;
    const timer = this.uiTimers.get(key);
    if (timer) clearTimeout(timer);
    this.uiTimers.delete(key);
  }

  private cancelPendingUiRequests(record: RuntimeRecord, reason: string, writeResponse: boolean): Promise<void> | void {
    const requests = [...record.pendingUiRequests.values()];
    if (requests.length === 0) return;
    if (!writeResponse) {
      for (const request of requests) {
        this.clearUiTimer(record.runId, request.id);
        this.pushEvent(record, 'extension_ui_cancelled', { id: request.id, method: request.method, reason });
      }
      record.pendingUiRequests.clear();
      return;
    }
    return (async () => {
      for (const request of requests) {
        this.clearUiTimer(record.runId, request.id);
        try {
          await this.sendJson(record.runId, { type: 'extension_ui_response', id: request.id, cancelled: true });
        } catch {
          // Stop/abort/shutdown are best-effort cancellation paths. sendJson
          // already records the transport diagnostic; lifecycle cleanup must
          // continue and remove the local pending request.
        }
        this.pushEvent(record, 'extension_ui_cancelled', { id: request.id, method: request.method, reason });
      }
      record.pendingUiRequests.clear();
    })();
  }

  /** 向 record 添加事件，缓冲上限 1000 条 */
  private pushEvent(record: RuntimeRecord, type: string, data: unknown): void {
    record.events.push({
      type,
      timestamp: Date.now(),
      data,
    });
    // 缓冲上限 1000 条，超出则丢弃最旧的
    if (record.events.length > 1000) {
      record.events.splice(0, record.events.length - 1000);
    }
  }

  // ── 发送 JSONL 到 stdin ────────────────────────────────────────────────

  private recordStdinFailure(runId: string, rawError: unknown): Error {
    const error = rawError instanceof Error ? rawError : new Error(String(rawError));
    if (typeof error === 'object' && this.observedStdinErrors.has(error)) return error;
    if (typeof error === 'object') this.observedStdinErrors.add(error);
    const record = this.records.get(runId);
    if (!record) return error;
    const active = !['done', 'failed', 'aborted'].includes(record.status)
      && record.exitCode === null && record.exitSignal === null;
    if (active) {
      record.status = 'failed';
      record.errorCode = 'RPC_STDIN_WRITE_FAILED';
    }
    record.lastActivity = Date.now();
    const data = {
      message: error.message,
      code: typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code : null,
      errorCode: 'RPC_STDIN_WRITE_FAILED',
    };
    this.pushEvent(record, 'rpc_stdin_error', data);
    this.emit(AgentRuntime.EVENT_RUNTIME_EVENT, { runId, event: { type: 'rpc_stdin_error', data } });
    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
    return error;
  }

  private async sendJson(runId: string, msg: Record<string, unknown>): Promise<void> {
    const record = this.records.get(runId);
    if (!record) {
      throw new Error(`Runtime 记录不存在: ${runId}`);
    }
    const stdin = record.proc.stdin;
    if (
      !stdin || record.proc.killed || record.exitCode !== null || record.exitSignal !== null
      || stdin.destroyed || stdin.writableEnded || stdin.writableFinished
    ) {
      const error = new Error(`RPC stdin 不可写: ${runId}`) as NodeJS.ErrnoException;
      error.code = 'RPC_STDIN_CLOSED';
      throw this.recordStdinFailure(runId, error);
    }
    const line = JSON.stringify(msg) + '\n';
    await new Promise<void>((resolveDone, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        if (error) reject(this.recordStdinFailure(runId, error));
        else resolveDone();
      };
      try {
        stdin.write(line, 'utf-8', finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // ── 进程终止 ──────────────────────────────────────────────────────────────

  /**
   * 根据平台杀死指定进程及其子进程树。
   * Windows: taskkill /PID <pid> /T /F
   * POSIX: process group kill (kill -TERM -<pid>)
   *
   * 3秒 fallback timer 在 taskkill exit/error 时 clear，resolve 只执行一次。
   */
  private killProcess(proc: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!proc || proc.killed) {
        resolve();
        return;
      }

      const pid = proc.pid;
      if (pid === undefined) {
        resolve();
        return;
      }

      let resolved = false;

      const safeResolve = (): void => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      if (process.platform === 'win32') {
        // Windows: 使用 spawn 传参数数组调用 taskkill /PID /T /F，禁止 exec 字符串
        const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          shell: false,
        });

        // 设置超时后备方案
        const fallbackTimer = setTimeout(() => {
          if (!proc.killed) {
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          }
          safeResolve();
        }, SIGTERM_TIMEOUT_MS);

        taskkill.on('exit', () => {
          clearTimeout(fallbackTimer);
          safeResolve();
        });
        taskkill.on('error', () => {
          clearTimeout(fallbackTimer);
          safeResolve();
        });
      } else {
        // POSIX: 向进程组发送 SIGTERM (负 PID = 进程组)
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          // 进程可能已不存在
        }
        const fallbackTimer = setTimeout(() => {
          if (!proc.killed) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              try { proc.kill('SIGKILL'); } catch { /* ignore */ }
            }
          }
          safeResolve();
        }, SIGTERM_TIMEOUT_MS);

        // POSIX 没有 taskkill，所以保留 fallback timer 作为主路径
        // 但仍用一个安全的 resolve
        // 注意：POSIX 下我们只用 fallback timer（无 taskkill 进程可监听）
        // 需要通过 proc.on('exit') 来提前 resolve
        const exitHandler = (): void => {
          clearTimeout(fallbackTimer);
          safeResolve();
        };
        proc.once('exit', exitHandler);
        proc.once('error', () => {
          clearTimeout(fallbackTimer);
          safeResolve();
        });
      }
    });
  }

  /** Let pi RPC consume stdin EOF and run session_shutdown before force-kill fallback. */
  private async stopProcessGracefully(proc: ChildProcess, graceMs = 1_500): Promise<void> {
    if (proc.killed) return;
    let settled = false;
    let exited = proc.exitCode != null || proc.signalCode != null;
    await new Promise<void>((resolveDone) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveDone();
      };
      const timer = setTimeout(finish, graceMs);
      proc.once('exit', () => { exited = true; finish(); });
      proc.once('error', finish);
      try { proc.stdin?.end(); } catch { finish(); }
    });
    if (!proc.killed && !exited) await this.killProcess(proc);
  }

  // ── 公开 API ────────────────────────────────────────────────────────────

  /**
   * 向指定 runId 的 session 发送 prompt。
   */
  async prompt(runId: string, prompt: string): Promise<void> {
    this.ensureRecord(runId);

    const record = this.records.get(runId)!;
    const now = Date.now();
    record.lastActivity = now;
    this.pushEvent(record, 'prompt', { prompt });

    await this.sendJson(runId, {
      id: runId,
      type: 'prompt',
      message: prompt,
    });

    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
  }

  /**
   * 向指定 runId 的 session 发送 steer 指令。
   */
  async steer(runId: string, prompt: string): Promise<void> {
    this.ensureRecord(runId);

    const record = this.records.get(runId)!;
    const now = Date.now();
    record.lastActivity = now;
    this.pushEvent(record, 'steer', { prompt });

    await this.sendJson(runId, {
      id: runId,
      type: 'steer',
      message: prompt,
    });

    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
  }

  /**
   * 向指定 runId 的 session 发送 followUp 指令。
   */
  async followUp(runId: string, prompt: string): Promise<void> {
    this.ensureRecord(runId);

    const now = Date.now();
    const record = this.records.get(runId)!;
    record.lastActivity = now;
    this.pushEvent(record, 'followUp', { prompt });

    await this.sendJson(runId, {
      id: runId,
      type: 'follow_up',
      message: prompt,
    });

    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
  }

  /**
   * 终止指定 runId 的 session。
   * 发送 RPC abort 消息给子进程，设置状态为 aborted，但不杀死进程。
   */
  async abort(runId: string): Promise<void> {
    this.ensureRecord(runId);

    const now = Date.now();
    const record = this.records.get(runId)!;
    record.status = 'aborted';
    record.lastActivity = now;
    this.pushEvent(record, 'abort', null);
    const pendingCancellation = this.cancelPendingUiRequests(record, 'runtime_abort', true);
    if (pendingCancellation) await pendingCancellation;

    // 发送 RPC abort 消息（不含 message 字段），不杀死子进程
    await this.sendJson(runId, {
      id: runId,
      type: 'abort',
    });

    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
  }

  /**
   * 停止指定 runId 的 session（强制杀死整个进程树）。
   */
  async stop(runId: string): Promise<void> {
    this.ensureRecord(runId);

    const now = Date.now();
    const record = this.records.get(runId)!;
    record.status = 'aborted';
    record.lastActivity = now;
    this.pushEvent(record, 'stop', null);
    const pendingCancellation = this.cancelPendingUiRequests(record, 'runtime_stop', true);
    if (pendingCancellation) await pendingCancellation;

    await this.stopProcessGracefully(record.proc);
    this.emit(AgentRuntime.EVENT_RECORD_UPDATE, this.getSnapshot(runId));
    this.schedulePersistence();
  }

  /**
   * 返回所有 runtime 记录的快照。
   */
  list(): AgentSessionSnapshot[] {
    const merged = new Map(this.historicalRecords);
    for (const r of this.records.values()) merged.set(r.runId, this.getSnapshot(r.runId));
    return Array.from(merged.values()).map((snapshot) => ({
      ...snapshot,
      retryable: ['failed', 'aborted'].includes(snapshot.status) && Boolean(snapshot.projectRoot),
    }));
  }

  /**
   * 关闭所有 runtime 记录并杀死所有子进程。
   */
  async shutdownAll(): Promise<void> {
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = null;
    }
    const entries = Array.from(this.records.entries());
    const killPromises = entries.map(async ([runId, record]) => {
      const pendingCancellation = this.cancelPendingUiRequests(record, 'runtime_shutdown', true);
      if (pendingCancellation) await pendingCancellation;
      await this.stopProcessGracefully(record.proc);
      this.emit(AgentRuntime.EVENT_RECORD_REMOVED, runId);
    });
    await Promise.all(killPromises);
    if (entries.length > 0) this.persistNow(entries.map(([runId]) => this.getSnapshot(runId)));
    this.records.clear();
  }


  // ── 内部工具 ────────────────────────────────────────────────────────────

  private ensureRecord(runId: string): void {
    if (!this.records.has(runId)) {
      throw new Error(`Runtime 记录不存在: ${runId}`);
    }
  }

  private getSnapshot(runId: string): AgentSessionSnapshot {
    const r = this.records.get(runId);
    if (!r) {
      throw new Error(`Runtime 记录不存在: ${runId}`);
    }
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
      pendingUiRequests: Array.from(r.pendingUiRequests.values()),
      historical: false,
    };
  }

  private schedulePersistence(): void {
    if (!this.persistencePath || this.persistenceTimer) return;
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      this.persistNow();
    }, 100);
    this.persistenceTimer.unref?.();
  }

  private loadPersistedHistory(): void {
    this.historicalRecords.clear();
    if (!this.persistencePath) {
      this.diagnostics = { persistence: { status: 'disabled' } };
      return;
    }
    if (!fs.existsSync(this.persistencePath)) {
      this.diagnostics = { persistence: { status: 'missing' } };
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.persistencePath, 'utf8')) as Partial<RuntimePersistenceFile>;
      if (parsed.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
        this.diagnostics = {
          persistence: {
            status: 'unsupported',
            message: `Runtime history schema ${String(parsed.schemaVersion ?? 'unknown')} is not supported; history was ignored safely.`,
            detectedSchemaVersion: typeof parsed.schemaVersion === 'number' || typeof parsed.schemaVersion === 'string'
              ? parsed.schemaVersion
              : 'unknown',
          },
        };
        return;
      }
      if (!Array.isArray(parsed.records)) {
        this.diagnostics = {
          persistence: { status: 'corrupt', message: 'Runtime history records are invalid; history was ignored safely.' },
        };
        return;
      }
      const records = parsed.records
        .filter((item): item is AgentSessionSnapshot => Boolean(item && typeof item.runId === 'string' && typeof item.name === 'string'))
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .slice(0, this.historyCap);
      for (const item of records) {
        this.historicalRecords.set(item.runId, {
          ...item,
          projectRoot: typeof item.projectRoot === 'string' ? item.projectRoot : '',
          taskId: typeof item.taskId === 'string' ? item.taskId : `legacy-task-${item.runId}`,
          executionId: typeof item.executionId === 'string' ? item.executionId : `legacy-execution-${item.runId}`,
          retryOfRunId: typeof item.retryOfRunId === 'string' ? item.retryOfRunId : null,
          rootRunId: typeof item.rootRunId === 'string' ? item.rootRunId : item.runId,
          retryAttempt: typeof item.retryAttempt === 'number' ? item.retryAttempt : 0,
          taskTitle: typeof item.taskTitle === 'string' ? item.taskTitle : item.name,
          initialPrompt: typeof item.initialPrompt === 'string' ? item.initialPrompt : '',
          priority: ['low', 'normal', 'high', 'critical'].includes(item.priority) ? item.priority : 'normal',
          workStyle: isWorkStyleSelection(item.workStyle) ? item.workStyle : 'agent_decides',
          pid: null,
          status: ['starting', 'running', 'blocked'].includes(item.status) ? 'aborted' : item.status,
          events: Array.isArray(item.events) ? item.events.slice(-1000) : [],
          errorCode: typeof item.errorCode === 'string' ? item.errorCode : null,
          retryable: false,
          cliSource: ['env', 'project', 'path'].includes(item.cliSource) ? item.cliSource : 'project',
          cliPath: typeof item.cliPath === 'string' ? item.cliPath : 'legacy/unknown',
          runtimeSource: typeof item.runtimeSource === 'string' ? item.runtimeSource : 'native-cli',
          runtimeExecutable: typeof item.runtimeExecutable === 'string' ? item.runtimeExecutable : 'legacy/unknown',
          runtimeVersion: typeof item.runtimeVersion === 'string' ? item.runtimeVersion : null,
          pendingUiRequests: [],
          historical: true,
        });
      }
      this.diagnostics = { persistence: { status: 'ready' } };
    } catch (error: unknown) {
      this.diagnostics = {
        persistence: {
          status: 'corrupt',
          message: `Runtime history could not be read; history was ignored safely (${error instanceof Error ? error.message : String(error)}).`,
        },
      };
    }
  }

  private persistNow(additional: AgentSessionSnapshot[] = []): void {
    if (!this.persistencePath) return;
    const merged = new Map(this.historicalRecords);
    for (const record of this.records.values()) merged.set(record.runId, this.getSnapshot(record.runId));
    for (const snapshot of additional) merged.set(snapshot.runId, snapshot);
    const records = Array.from(merged.values())
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, this.historyCap)
      .map((item) => ({ ...item, pendingUiRequests: [] }));
    const payload: RuntimePersistenceFile = { schemaVersion: 2, savedAt: Date.now(), records };
    const directory = path.dirname(this.persistencePath);
    const tempPath = `${this.persistencePath}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
      fs.renameSync(tempPath, this.persistencePath);
    } catch {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }

  private mapResponseStatus(status: string): SessionStatus {
    switch (status) {
      case 'running':
        return 'running';
      case 'blocked':
        return 'blocked';
      case 'done':
      case 'completed':
        return 'done';
      case 'failed':
      case 'error':
        return 'failed';
      case 'aborted':
      case 'cancelled':
        return 'aborted';
      default:
        return 'running';
    }
  }
}

// ─── 单例 ───────────────────────────────────────────────────────────────────

export const agentRuntime = new AgentRuntime();
