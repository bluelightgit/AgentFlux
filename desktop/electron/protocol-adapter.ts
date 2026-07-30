/**
 * Protocol Adapter — JSONL 分帧/消息解析/stdin 写入
 *
 * 职责：
 * - stdout 逐字节缓冲 LF 分帧器
 * - 传入消息解析与校验
 * - stdin JSONL 行写入
 * - 扩展 UI 请求/响应辅助
 */

import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// ─── 常量 ───────────────────────────────────────────────────────────────────

const LINE_FEED = 0x0a;

// ─── 类型 ───────────────────────────────────────────────────────────────────

export interface IncomingMessage {
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

export interface OutgoingMessage {
  id?: string;
  type: string;
  message?: string;
  [key: string]: unknown;
}

export interface FramedMessage {
  runId: string;
  msg: IncomingMessage;
}

export type ExtensionUIDialogMethod = 'select' | 'confirm' | 'input';

export type ExtensionUIResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

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

// ─── 事件 ───────────────────────────────────────────────────────────────────

export const PROTOCOL_EVENT_FRAME = 'frame';
export const PROTOCOL_EVENT_ERROR = 'error';

// ─── ProtocolAdapter 类 ─────────────────────────────────────────────────────

/**
 * 管理单个子进程的 JSONL 协议读写。
 * 每个 RuntimeRecord 对应一个独立的 ProtocolAdapter 实例。
 */
export class ProtocolAdapter extends EventEmitter {
  private frameBuffer: number[] = [];
  /** 已观察到的 stdin 错误对象引用（用于去重） */
  private observedStdinErrors = new WeakSet<object>();

  private _pendingUiRequests: Map<string, PendingExtensionUIRequest> = new Map();
  private _uiTimers = new Map<string, NodeJS.Timeout>();

  readonly DEFAULT_UI_REQUEST_TIMEOUT_MS = 5 * 60_000;

  constructor(
    private readonly proc: ChildProcess,
    private readonly runId: string,
    private readonly onUiRequest: (runId: string, msg: IncomingMessage) => void,
    private readonly onMessage: (runId: string, msg: IncomingMessage) => void,
  ) {
    super();
    this.setupStdout();
    this.setupStdinError();
  }

  get pendingUiRequests(): Map<string, PendingExtensionUIRequest> {
    return this._pendingUiRequests;
  }

  // ── stdout: 自定义 LF 分帧器（逐字节缓冲） ──

  private setupStdout(): void {
    const processFrame = (lineBytes: number[]): void => {
      const line = Buffer.from(lineBytes).toString('utf-8').trim();
      if (!line) return;

      let msg: IncomingMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // 非 JSON 行忽略（例如 pi 的日志输出）
      }

      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string' || msg.type.trim().length === 0) return;

      this.emit(PROTOCOL_EVENT_FRAME, { runId: this.runId, msg });

      if (msg.type === 'extension_ui_request') {
        this.onUiRequest(this.runId, msg);
      } else {
        this.onMessage(this.runId, msg);
      }
    };

    this.proc.stdout?.on('data', (data: Buffer) => {
      for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        if (byte === LINE_FEED) {
          if (this.frameBuffer.length > 0) {
            processFrame(this.frameBuffer);
            this.frameBuffer = [];
          }
        } else {
          this.frameBuffer.push(byte);
        }
      }
    });

    this.proc.stdout?.on('end', () => {
      if (this.frameBuffer.length > 0) {
        processFrame(this.frameBuffer);
        this.frameBuffer = [];
      }
    });
  }

  // ── stderr 收集 ──

  setupStderr(handler: (text: string) => void): void {
    this.proc.stderr?.on('data', (data: Buffer) => {
      handler(data.toString('utf-8'));
    });
  }

  // ── stdin 写入 ──

  private setupStdinError(): void {
    this.proc.stdin?.on('error', (error: Error) => {
      if (this.observedStdinErrors.has(error)) return;
      this.observedStdinErrors.add(error);
      this.emit(PROTOCOL_EVENT_ERROR, error);
    });
  }

  /** 标记进程已退出（供外部设置） */
  _exited = false;

  get stdinReady(): boolean {
    const stdin = this.proc.stdin;
    const exited = this._exited || this.proc.killed;
    return !!(stdin && !exited
      && !stdin.destroyed && !stdin.writableEnded && !stdin.writableFinished);
  }

  async sendJson(msg: Record<string, unknown>): Promise<void> {
    if (!this.stdinReady) {
      const error = new Error(`RPC stdin 不可写: ${this.runId}`) as NodeJS.ErrnoException;
      error.code = 'RPC_STDIN_CLOSED';
      throw error;
    }
    const line = JSON.stringify(msg) + '\n';
    const stdin = this.proc.stdin!;
    await new Promise<void>((resolveDone, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolveDone();
      };
      try {
        stdin.write(line, 'utf-8', finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // ── 扩展 UI 请求管理 ──

  addPendingUiRequest(request: PendingExtensionUIRequest, onTimeout?: (runId: string, id: string, method: string) => void): void {
    this._pendingUiRequests.set(request.id, request);
    const key = `${this.runId}:${request.id}`;
    const previous = this._uiTimers.get(key);
    if (previous) clearTimeout(previous);
    if (request.expiresAt > Date.now()) {
      const duration = request.expiresAt - Date.now();
      const timer = setTimeout(() => {
        this._uiTimers.delete(key);
        if (!this._pendingUiRequests.delete(request.id)) return;
        onTimeout?.(this.runId, request.id, request.method);
      }, duration);
      timer.unref?.();
      this._uiTimers.set(key, timer);
    }
  }

  removePendingUiRequest(id: string): PendingExtensionUIRequest | undefined {
    this.clearUiTimer(id);
    const req = this._pendingUiRequests.get(id);
    this._pendingUiRequests.delete(id);
    return req;
  }

  clearAllPendingUiRequests(reason: string): PendingExtensionUIRequest[] {
    const requests = Array.from(this._pendingUiRequests.values());
    for (const request of requests) {
      this.clearUiTimer(request.id);
    }
    this._pendingUiRequests.clear();
    return requests;
  }

  private clearUiTimer(requestId: string): void {
    const key = `${this.runId}:${requestId}`;
    const timer = this._uiTimers.get(key);
    if (timer) clearTimeout(timer);
    this._uiTimers.delete(key);
  }

  closeStdin(): void {
    try {
      this.proc.stdin?.end();
    } catch {
      // maybe already closed
    }
  }

  /** 清理资源，移除所有监听器 */
  dispose(): void {
    this.clearAllPendingUiRequests('dispose');
    this.removeAllListeners();
  }
}
