/**
 * Agent Runtime — Electron 主进程侧公开 API Facade
 *
 * 将运行时操作委托给三个职责单一的模块：
 * - runtime-manager: 子进程 spawn/终止/生命周期
 * - protocol-adapter: JSONL 分帧/消息解析/stdin 写入
 * - history-store: 持久化读写/schema v2/容量管理
 *
 * AgentRuntime 类保留完整公开 API 签名，保持与 main.ts IPC handler 的兼容。
 */

import { EventEmitter } from 'events';
import type {
  TaskPriority,
  WorkStyleSelection,
} from '../shared/runtime-contract';
import { RuntimeManager, MANAGER_EVENT_RECORD_UPDATE, MANAGER_EVENT_RECORD_REMOVED, MANAGER_EVENT_RUNTIME_EVENT, resolveJavaScriptRuntime, type AgentSessionSnapshot, type StartOptions, type NodeVersionTestHooks, type NodeRuntimeSource } from './runtime-manager';
import { type ExtensionUIResponse, type PendingExtensionUIRequest } from './protocol-adapter';
import { HistoryStore, type HistoryStoreDiagnostics } from './history-store';

// ─── 重导出类型 ─────────────────────────────────────────────────────────────

export type { AgentSessionSnapshot, StartOptions, NodeRuntimeSource, TaskPriority, WorkStyleSelection, PendingExtensionUIRequest } from './runtime-manager';
export type { ExtensionUIResponse } from './protocol-adapter';
export type { HistoryStoreDiagnostics } from './history-store';
export { resolveJavaScriptRuntime } from './runtime-manager';

// ─── 事件常量 ───────────────────────────────────────────────────────────────

const EVENT_RECORD_UPDATE = 'record-update';
const EVENT_RECORD_REMOVED = 'record-removed';
const EVENT_RUNTIME_EVENT = 'runtime-event';

// ─── Diagnostics 类型 ──────────────────────────────────────────────────────

export interface RuntimeDiagnostics {
  persistence: HistoryStoreDiagnostics['persistence'];
}

export interface AgentRuntimeTestHooks extends NodeVersionTestHooks {
  // 可添加未来测试钩子
}

// ─── AgentRuntime 类 ────────────────────────────────────────────────────────

export class AgentRuntime extends EventEmitter {
  private manager: RuntimeManager;
  private store: HistoryStore;

  // 事件名常量（供 main.ts 等外部代码引用）
  static readonly EVENT_RECORD_UPDATE = EVENT_RECORD_UPDATE;
  static readonly EVENT_RECORD_REMOVED = EVENT_RECORD_REMOVED;
  static readonly EVENT_RUNTIME_EVENT = EVENT_RUNTIME_EVENT;

  constructor(private readonly testHooks: AgentRuntimeTestHooks = {}) {
    super();
    this.manager = new RuntimeManager(testHooks);
    this.store = new HistoryStore();

    // 桥接 manager 事件 → AgentRuntime 事件
    this.manager.on(MANAGER_EVENT_RECORD_UPDATE, (snapshot: AgentSessionSnapshot) => {
      this.emit(EVENT_RECORD_UPDATE, snapshot);
    });

    this.manager.on(MANAGER_EVENT_RECORD_REMOVED, (runId: string) => {
      this.emit(EVENT_RECORD_REMOVED, runId);
    });

    this.manager.on(MANAGER_EVENT_RUNTIME_EVENT, (payload: { runId: string; event: unknown }) => {
      this.emit(EVENT_RUNTIME_EVENT, payload);
    });

    // 桥接 manager 内部 ui_request/message → 内部处理方法
    this.manager.on('ui_request', (runId: string, msg: { type: string; id?: string; method?: string; title?: string; message?: string; options?: string[]; placeholder?: string; timeout?: number }) => {
      this.handleUiRequest(runId, msg as any);
    });

    this.manager.on('message', (runId: string, msg: { type: string; id?: string; status?: string; success?: boolean; content?: unknown }) => {
      this.handleIncomingMessage(runId, msg as any);
    });

    // Bridge adapter stdin errors to facade handling
    this.manager.on('adapter_error', (runId: string, error: Error) => {
      this.handleStdinError(runId, error);
    });
  }

  /**
   * 启用受控的运行历史恢复。只恢复 snapshot/events；运行中状态会降级为 aborted，
   * PID 永远清空，避免把上一次应用实例的进程误报为在线。
   */
  configurePersistence(filePath: string, historyCap = 100): void {
    this.store.configure(filePath, historyCap);
  }

  getDiagnostics(): RuntimeDiagnostics {
    return { persistence: this.store.getDiagnostics() };
  }

  // ── 启动子进程 ──────────────────────────────────────────────────────────

  /**
   * 启动一个独立的 pi --mode rpc 子进程，立即通过 stdin 发送 initialTask。
   */
  async start(options: StartOptions): Promise<string> {
    const record = await this.manager.createProcess(options);
    const runId = record.runId;

    // 发送 initialTask
    if (options.initialTask && typeof options.initialTask === 'string' && options.initialTask.trim().length > 0) {
      try {
        await record.adapter.sendJson({
          id: runId,
          type: 'prompt',
          message: options.initialTask,
        });
      } catch (error: unknown) {
        this.handleStdinError(runId, error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
    return runId;
  }

  async retry(sourceRunId: string): Promise<string> {
    const source = this.manager.getRecord(sourceRunId) ?? this.store.get(sourceRunId);
    if (!source || !['failed', 'aborted'].includes(source.status)) {
      throw new Error('Only a known failed or aborted run can be retried');
    }
    const projectRoot = source.projectRoot;
    if (!projectRoot) throw new Error('Historical run has no verified workspace provenance');
    const runId = await this.start({
      projectRoot,
      name: source.name.replace(/-\d+$/, ''),
      taskTitle: source.taskTitle,
      initialTask: source.initialPrompt,
      priority: source.priority,
      workStyle: source.workStyle,
    });
    const created = this.manager.getRecord(runId)!;
    created.retryOfRunId = source.runId;
    created.rootRunId = source.rootRunId || source.runId;
    created.retryAttempt = source.retryAttempt + 1;
    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
    return runId;
  }

  async waitUntilReady(runId: string, timeoutMs = 8_000): Promise<void> {
    const current = this.manager.getRecord(runId);
    if (!current) throw new Error('RPC_EXIT_BEFORE_READY: runtime record missing');
    if (!current.initialPrompt) return;
    if (current.validRpcCount > 0) return;
    // DEBUG: log state before checking
    const stateBeforeCheck = JSON.stringify({ status: current.status, exitCode: current.exitCode, exitSignal: current.exitSignal, errorCode: current.errorCode });
    if (current.status === 'failed' || current.exitCode !== null || current.exitSignal !== null || current.errorCode) {
      console.log('DEBUG waitUntilReady early exit:', stateBeforeCheck);
      throw new Error(`${current.errorCode ?? 'RPC_EXIT_BEFORE_READY'}: runtime exited before a valid RPC frame`);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off(EVENT_RECORD_UPDATE, onUpdate);
        if (error) reject(error); else resolve();
      };
      const onUpdate = (snapshot: AgentSessionSnapshot) => {
        if (snapshot.runId !== runId) return;
        const record = this.manager.getRecord(runId);
        if (record && record.validRpcCount > 0) finish();
        else if (snapshot.status === 'failed') finish(new Error(`${snapshot.errorCode ?? 'RPC_EXIT_BEFORE_READY'}: runtime exited before a valid RPC frame`));
      };
      const timer = setTimeout(() => {
        const record = this.manager.getRecord(runId);
        if (record) {
          this.manager.setStatus(runId, 'failed');
          record.errorCode = 'RPC_READY_TIMEOUT';
          record.proc.kill();
        }
        finish(new Error('RPC_READY_TIMEOUT: no valid RPC frame received'));
      }, timeoutMs);
      this.on(EVENT_RECORD_UPDATE, onUpdate);
      const afterSubscribe = this.manager.getRecord(runId);
      if (!afterSubscribe || afterSubscribe.status === 'failed' || afterSubscribe.exitCode !== null || afterSubscribe.exitSignal !== null || afterSubscribe.errorCode) {
        finish(new Error(`${afterSubscribe?.errorCode ?? 'RPC_EXIT_BEFORE_READY'}: runtime exited before a valid RPC frame`));
      } else if (afterSubscribe.validRpcCount > 0) finish();
    });
  }

  // ── 协议消息处理 ────────────────────────────────────────────────────────

  private handleIncomingMessage(runId: string, msg: {
    type: string;
    id?: string;
    status?: string;
    success?: boolean;
    content?: unknown;
  }): void {
    const record = this.manager.getRecord(runId);
    if (!record) return;
    record.validRpcCount += 1;

    const type = msg.type ?? '';
    if (type === 'agent_start') {
      record.status = 'running';
    } else if (type === 'agent_settled' || type === 'agent_end') {
      if (record.status !== 'aborted' && record.status !== 'failed') {
        if (msg.content && typeof msg.content === 'object') {
          const content = msg.content as Record<string, unknown>;
          record.status = content.success === false ? 'failed' : 'done';
        } else {
          record.status = 'done';
        }
      }
    } else if (type === 'response') {
      if (msg.success === false) {
        record.status = 'failed';
      } else if (msg.status) {
        record.status = this.manager.mapResponseStatus(msg.status);
      }
    } else if (msg.status) {
      record.status = this.manager.mapResponseStatus(msg.status);
    }

    record.lastActivity = Date.now();
    this.manager.pushEvent(record, type, msg.content ?? msg);
    this.emit(EVENT_RUNTIME_EVENT, { runId, event: msg });
    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
  }

  private handleUiRequest(runId: string, msg: {
    type: string;
    id?: string;
    method?: string;
    title?: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    timeout?: number;
  }): void {
    const record = this.manager.getRecord(runId);
    if (!record) return;
    record.validRpcCount += 1;

    if (!msg.id || !['select', 'confirm', 'input'].includes(msg.method ?? '')) return;
    const method = msg.method as 'select' | 'confirm' | 'input';
    if (method === 'select' && (!Array.isArray(msg.options) || msg.options.some((v) => typeof v !== 'string'))) return;
    const timeout = Number.isFinite(msg.timeout) && (msg.timeout ?? 0) > 0
      ? Math.min(msg.timeout!, record.adapter.DEFAULT_UI_REQUEST_TIMEOUT_MS)
      : record.adapter.DEFAULT_UI_REQUEST_TIMEOUT_MS;
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

    record.adapter.addPendingUiRequest(
      request as PendingExtensionUIRequest,
      (rid: string, id: string, method: string) => {
        // Timeout callback: record timeout event and emit updates
        const current = this.manager.getRecord(rid);
        if (!current) return;
        // pi 自带 timeout 时会自行 resolve；Desktop 默认 timeout 则主动取消以防永久阻塞。
        if (!(Number.isFinite(msg.timeout) && (msg.timeout ?? 0) > 0)) {
          void current.adapter.sendJson({
            type: 'extension_ui_response', id, cancelled: true,
          }).catch(() => { /* process may have exited */ });
        }
        this.manager.pushEvent(current, 'extension_ui_timeout', { id, method });
        this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(rid));
        this.schedulePersistence();
      },
    );
    record.status = 'blocked';
    record.lastActivity = Date.now();
    this.manager.pushEvent(record, 'extension_ui_request', request);
    this.emit(EVENT_RUNTIME_EVENT, { runId, event: { type: 'extension_ui_request', ...request } });
    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
  }

  async respondToExtensionUI(runId: string, response: ExtensionUIResponse): Promise<void> {
    const record = this.manager.ensureRecord(runId);
    if (!response || typeof response !== 'object' || typeof response.id !== 'string' || response.id.length === 0) {
      throw new Error('Extension UI 响应必须包含非空 id');
    }
    const responseKinds = [
      'value' in response && typeof response.value === 'string',
      'confirmed' in response && typeof response.confirmed === 'boolean',
      'cancelled' in response && response.cancelled === true,
    ].filter(Boolean).length;
    if (responseKinds !== 1) throw new Error('Extension UI 响应必须且只能包含 value、confirmed 或 cancelled 之一');
    const request = record.adapter.pendingUiRequests.get(response.id);
    if (!request) throw new Error(`Extension UI 请求不存在或已结束: ${response.id}`);
    if ('confirmed' in response && request.method !== 'confirm') throw new Error('confirmed 只适用于 confirm 请求');
    if ('value' in response) {
      if (request.method === 'confirm') throw new Error('value 不适用于 confirm 请求');
      if (request.method === 'select' && !request.options?.includes(response.value)) {
        throw new Error(`select 响应不在允许选项中: ${response.value}`);
      }
    }
    try {
      await record.adapter.sendJson({ type: 'extension_ui_response', ...response });
    } catch (error) {
      // sendJson failure already recorded via handleStdinError by prompt/steer/followUp
      // but respondToExtensionUI doesn't go through those paths, so do it here.
      this.handleStdinError(runId, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    record.adapter.removePendingUiRequest(response.id);
    if (record.status === 'blocked') record.status = 'running';
    record.lastActivity = Date.now();
    this.manager.pushEvent(record, 'extension_ui_response', response);
    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
  }

  /**
   * 发送 cancellation 到子进程并记录事件，但不抛异常（best-effort）。
   */
  private cancelPendingUiRequests(
    runId: string,
    reason: string,
  ): void | Promise<void> {
    const record = this.manager.getRecord(runId);
    if (!record) return;
    const requests = Array.from(record.adapter.pendingUiRequests.values());
    if (requests.length === 0) return;
    // 有 pending 请求时返回 Promise（需要 await sendJson）
    return (async () => {
      for (const request of requests) {
        try {
          await record.adapter.sendJson({
            type: 'extension_ui_response',
            id: request.id,
            cancelled: true,
          });
        } catch {
          // Stop/abort/shutdown are best-effort cancellation paths.
        }
        this.manager.pushEvent(record, 'extension_ui_cancelled', {
          id: request.id,
          method: request.method,
          reason,
        });
      }
      record.adapter.clearAllPendingUiRequests(reason);
    })();
  }

  private handleStdinError(runId: string, error: Error): Error {
    const record = this.manager.getRecord(runId);
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
    this.manager.pushEvent(record, 'rpc_stdin_error', data);
    this.emit(EVENT_RUNTIME_EVENT, { runId, event: { type: 'rpc_stdin_error', data } });
    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
    return error;
  }

  // ── 公开 API ────────────────────────────────────────────────────────────

  async prompt(runId: string, prompt_text: string): Promise<void> {
    this.manager.ensureRecord(runId);
    const record = this.manager.getRecord(runId)!;
    record.lastActivity = Date.now();
    this.manager.pushEvent(record, 'prompt', { prompt: prompt_text });

    try {
      await record.adapter.sendJson({ id: runId, type: 'prompt', message: prompt_text });
    } catch (error) {
      throw this.handleStdinError(runId, error instanceof Error ? error : new Error(String(error)));
    }

    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
  }

  async steer(runId: string, prompt_text: string): Promise<void> {
    this.manager.ensureRecord(runId);
    const record = this.manager.getRecord(runId)!;
    record.lastActivity = Date.now();
    this.manager.pushEvent(record, 'steer', { prompt: prompt_text });

    try {
      await record.adapter.sendJson({ id: runId, type: 'steer', message: prompt_text });
    } catch (error) {
      throw this.handleStdinError(runId, error instanceof Error ? error : new Error(String(error)));
    }

    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
  }

  async followUp(runId: string, prompt_text: string): Promise<void> {
    this.manager.ensureRecord(runId);
    const record = this.manager.getRecord(runId)!;
    record.lastActivity = Date.now();
    this.manager.pushEvent(record, 'followUp', { prompt: prompt_text });

    try {
      await record.adapter.sendJson({ id: runId, type: 'follow_up', message: prompt_text });
    } catch (error) {
      throw this.handleStdinError(runId, error instanceof Error ? error : new Error(String(error)));
    }

    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
  }

  async abort(runId: string): Promise<void> {
    const record = this.manager.ensureRecord(runId);
    record.status = 'aborted';
    record.lastActivity = Date.now();
    this.manager.pushEvent(record, 'abort', null);

    // 先取消所有 pending UI 请求（发送 cancellation 到子进程）
    void this.cancelPendingUiRequests(runId, 'runtime_abort');

    // 发送 RPC abort 消息（不含 message 字段），不杀死子进程
    try {
      await record.adapter.sendJson({ id: runId, type: 'abort' });
    } catch {
      // Process may already be gone; that's fine for abort
    }

    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
  }

  async stop(runId: string): Promise<void> {
    const record = this.manager.ensureRecord(runId);
    record.status = 'aborted';
    record.lastActivity = Date.now();
    this.manager.pushEvent(record, 'stop', null);

    // 先取消所有 pending UI 请求（发送 cancellation 到子进程）
    void this.cancelPendingUiRequests(runId, 'runtime_stop');

    await this.manager.stopProcessGracefully(record.proc);
    this.emit(EVENT_RECORD_UPDATE, this.manager.getSnapshot(runId));
    this.schedulePersistence();
  }

  list(): AgentSessionSnapshot[] {
    const merged = new Map<string, AgentSessionSnapshot>();
    for (const r of this.manager.getAllRecords()) {
      merged.set(r.runId, this.manager.getSnapshot(r.runId));
    }
    for (const historical of this.store.list()) {
      if (!merged.has(historical.runId)) {
        merged.set(historical.runId, historical);
      }
    }
    return Array.from(merged.values()).map((snapshot) => ({
      ...snapshot,
      retryable: ['failed', 'aborted'].includes(snapshot.status) && Boolean(snapshot.projectRoot),
    }));
  }

  async shutdownAll(): Promise<void> {
    this.store.shutdown();
    const entries = Array.from(this.manager.getAllRecords());
    const killPromises = entries.map(async (record) => {
      void this.cancelPendingUiRequests(record.runId, 'runtime_shutdown');
      await this.manager.stopProcessGracefully(record.proc);
      this.emit(EVENT_RECORD_REMOVED, record.runId);
    });
    await Promise.all(killPromises);
    if (entries.length > 0) this.store.saveNow(entries.map((r) => this.manager.getSnapshot(r.runId)));
    this.manager.clearRecords();
  }

  // ── 内部工具 ────────────────────────────────────────────────────────────

  private schedulePersistence(): void {
    this.store.scheduleSave(() =>
      Array.from(this.manager.getAllRecords()).map((r) => this.manager.getSnapshot(r.runId)),
    );
  }
}

// ─── 单例 ───────────────────────────────────────────────────────────────────

export const agentRuntime = new AgentRuntime();
