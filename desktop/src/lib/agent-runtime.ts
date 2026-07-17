import { parseCapabilityPolicyBundle, type CapabilityPolicyBundle } from './capability-policy';

/**
 * Agent Runtime 浏览器侧 TypeScript 客户端
 *
 * 通过 Electron preload 暴露的 `window.agentRuntime` 桥接对象与主进程通信。
 * 纯类型导出，无 any 使用。
 */

// ─── 类型声明 ───────────────────────────────────────────────────────────────

export type Role = 'user' | 'assistant' | 'system' | 'tool';

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

export interface AgentSession {
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
  modePolicy: ModePolicy;
  name: string;
  pid: number | null;
  status: SessionStatus;
  events: SessionEvent[];
  stderrSummary: string;
  cliSource: 'env' | 'project' | 'path';
  cliPath: string;
  runtimeSource: 'trusted-env' | 'npm' | 'process' | 'path' | 'native-cli' | 'electron-opt-in';
  runtimeExecutable: string;
  runtimeVersion: string | null;
  startedAt: number;
  lastActivity: number;
  exitCode: number | null;
  exitSignal: string | null;
  errorCode: string | null;
  retryable: boolean;
  pendingUiRequests: PendingExtensionUIRequest[];
  historical: boolean;
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

export interface StartOptions {
  projectRoot: string;
  name: string;
  taskTitle: string;
  initialTask: string;
  priority: TaskPriority;
  modePolicy: ModePolicy;
}

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';
export type ModePolicy = 'agent_decides' | 'M1' | 'M2' | 'M5';

export interface RequestMessage {
  type: string;
  runId?: string;
  sessionId?: string;
  prompt?: string;
}

export interface ResponseMessage {
  type: string;
  runId?: string;
  sessionId?: string;
  status?: string;
  content?: unknown;
  error?: string;
}

export interface AgentRuntimeStartResult {
  runId: string;
  taskId: string;
  executionId: string;
}

export interface AgentRuntimeOkResult {
  ok: boolean;
}

export interface RuntimeDiagnostics {
  persistence: {
    status: 'disabled' | 'missing' | 'ready' | 'corrupt' | 'unsupported';
    message?: string;
    detectedSchemaVersion?: number | string;
  };
}

export type EventCallback = (event: unknown) => void;
export type UnsubscribeFn = () => void;

// ─── 桥接接口 ───────────────────────────────────────────────────────────────

interface AgentRuntimeBridge {
  start(options: StartOptions): Promise<AgentRuntimeStartResult>;
  retry(runId: string): Promise<AgentRuntimeStartResult>;
  list(): Promise<AgentSession[]>;
  diagnostics?(): Promise<RuntimeDiagnostics>;
  capabilityPolicies?(projectRoot: string): Promise<unknown>;
  prompt(runId: string, prompt: string): Promise<AgentRuntimeOkResult>;
  steer(runId: string, prompt: string): Promise<AgentRuntimeOkResult>;
  followUp(runId: string, prompt: string): Promise<AgentRuntimeOkResult>;
  abort(runId: string): Promise<AgentRuntimeOkResult>;
  stop(runId: string): Promise<AgentRuntimeOkResult>;
  extensionUiResponse(runId: string, response: ExtensionUIResponse): Promise<AgentRuntimeOkResult>;
  shutdownAll(): Promise<AgentRuntimeOkResult>;
  onEvent(callback: EventCallback): UnsubscribeFn;
}

// ─── 全局声明 ───────────────────────────────────────────────────────────────

declare global {
  interface Window {
    agentRuntime?: AgentRuntimeBridge;
  }
}

// ─── AgentRuntimeClient ─────────────────────────────────────────────────────

export class AgentRuntimeClient {
  private bridge: AgentRuntimeBridge | null = null;

  constructor() {
    if (typeof window !== 'undefined' && window.agentRuntime) {
      this.bridge = window.agentRuntime;
    }
  }

  /**
   * 检查桥接是否可用（在 Electron 环境中）。
   */
  get isAvailable(): boolean {
    return this.bridge !== null;
  }

  /**
   * 启动一个新的 agent runtime 进程，返回 runId。
   *
   * @param options.projectRoot 项目根目录（绝对路径）
   * @param options.name Agent 名称
   * @param options.initialTask 初始 prompt
   */
  async start(options: StartOptions): Promise<AgentRuntimeStartResult> {
    this.ensureBridge();
    const result = await this.bridge!.start(options);
    return result;
  }

  async retry(runId: string): Promise<AgentRuntimeStartResult> {
    this.ensureBridge();
    return this.bridge!.retry(runId);
  }

  /**
   * 列出所有 runtime 记录的快照。
   */
  async list(): Promise<AgentSession[]> {
    this.ensureBridge();
    return this.bridge!.list();
  }

  async diagnostics(): Promise<RuntimeDiagnostics> {
    this.ensureBridge();
    if (!this.bridge!.diagnostics) return { persistence: { status: 'disabled' } };
    return this.bridge!.diagnostics();
  }

  async capabilityPolicies(projectRoot: string): Promise<CapabilityPolicyBundle> {
    this.ensureBridge();
    if (!this.bridge!.capabilityPolicies) return { schemaVersion: 1, records: [], notices: [] };
    return parseCapabilityPolicyBundle(await this.bridge!.capabilityPolicies(projectRoot));
  }

  /**
   * 向已存在的 session 发送 prompt 请求。
   */
  async prompt(runId: string, prompt: string): Promise<void> {
    this.ensureBridge();
    await this.bridge!.prompt(runId, prompt);
  }

  /**
   * 向已存在的 session 发送 steer 指令。
   */
  async steer(runId: string, prompt: string): Promise<void> {
    this.ensureBridge();
    await this.bridge!.steer(runId, prompt);
  }

  /**
   * 向已存在的 session 发送 followUp 指令。
   */
  async followUp(runId: string, prompt: string): Promise<void> {
    this.ensureBridge();
    await this.bridge!.followUp(runId, prompt);
  }

  /**
   * 终止指定 session。
   */
  async abort(runId: string): Promise<void> {
    this.ensureBridge();
    await this.bridge!.abort(runId);
  }

  /**
   * 停止指定 runId 的 session。
   */
  async stop(runId: string): Promise<void> {
    this.ensureBridge();
    await this.bridge!.stop(runId);
  }

  async respondToExtensionUI(runId: string, response: ExtensionUIResponse): Promise<void> {
    this.ensureBridge();
    await this.bridge!.extensionUiResponse(runId, response);
  }

  /**
   * 关闭所有 session 并杀死所有子进程。
   */
  async shutdownAll(): Promise<void> {
    this.ensureBridge();
    await this.bridge!.shutdownAll();
  }

  /**
   * 注册事件监听器，接收来自主进程的 agent-runtime 事件推送。
   * 返回取消监听的函数。
   */
  onEvent(callback: EventCallback): UnsubscribeFn {
    this.ensureBridge();
    return this.bridge!.onEvent(callback);
  }

  private ensureBridge(): void {
    if (!this.bridge) {
      throw new Error(
        'AgentRuntimeClient 不可用：window.agentRuntime 未定义。' +
        '请确保在 Electron 渲染进程中使用。',
      );
    }
  }
}

// ─── 默认单例导出 ───────────────────────────────────────────────────────────

export const agentRuntimeClient = new AgentRuntimeClient();
