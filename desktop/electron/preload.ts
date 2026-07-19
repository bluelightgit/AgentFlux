/**
 * Electron preload 脚本
 *
 * 通过 contextBridge 安全地向渲染进程暴露能力。
 * 保留全部 legacy window.api（文件/目录/监听/窗口/对话框），
 * 额外 expose window.agentRuntime（类型安全的桥接）。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeStartOptions } from '../shared/runtime-contract';

// ─── Legacy API: window.api ────────────────────────────────────────────────
// 保留 git HEAD 版本 window.api 的全部能力

export interface ElectronFileApi {
  readFile: (path: string) => string;
  fileSize: (path: string) => number;
  getFileSize: (path: string) => number;
  readFileIncremental: (path: string, offset: number) => { content: string; newSize: number };
  exists: (path: string) => boolean;
  pathExists: (path: string) => boolean;
  writeFile: (path: string, content: string) => boolean;
  deleteFile: (path: string) => boolean;
  listDirectory: (path: string) => string[];
  readDirectory: (path: string) => string[];
  readDirectoryFiles: (path: string) => Array<{ name: string; content: string }>;
  getUserDataPath: () => string;
  watchFile: (path: string) => { ok: boolean };
  unwatchFile: (path: string) => { ok: boolean };
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  isMaximized: () => boolean;
  showFolderDialog: () => string | null;
  platform: string;
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
  };
}

const api: ElectronFileApi = {
  // ── File operations ──
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath) as unknown as string,
  fileSize: (filePath) => ipcRenderer.invoke('file-size', filePath) as unknown as number,
  getFileSize: (filePath) => ipcRenderer.invoke('file-size', filePath) as unknown as number,
  readFileIncremental: (filePath, offset) =>
    ipcRenderer.invoke('read-file-incremental', filePath, offset) as unknown as { content: string; newSize: number },
  exists: (filePath) => ipcRenderer.invoke('path-exists', filePath) as unknown as boolean,
  pathExists: (filePath) => ipcRenderer.invoke('path-exists', filePath) as unknown as boolean,
  writeFile: (filePath, content) =>
    ipcRenderer.invoke('write-file', filePath, content) as unknown as boolean,
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath) as unknown as boolean,

  // ── Directory operations ──
  listDirectory: (dirPath) => ipcRenderer.invoke('list-directory', dirPath) as unknown as string[],
  readDirectory: (dirPath) => ipcRenderer.invoke('list-directory', dirPath) as unknown as string[],
  readDirectoryFiles: (dirPath) =>
    ipcRenderer.invoke('read-directory-files', dirPath) as unknown as Array<{ name: string; content: string }>,

  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path') as unknown as string,

  // ── File watching ──
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath) as unknown as { ok: boolean },
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath) as unknown as { ok: boolean },

  // ── Window controls ──
  minimizeWindow: () => { ipcRenderer.invoke('window-minimize'); },
  maximizeWindow: () => { ipcRenderer.invoke('window-maximize'); },
  closeWindow: () => { ipcRenderer.invoke('window-close'); },
  isMaximized: () => ipcRenderer.invoke('window-is-maximized') as unknown as boolean,

  // ── Dialogs ──
  showFolderDialog: () => ipcRenderer.invoke('show-folder-dialog') as unknown as string | null,

  platform: process.platform,

  // ── Raw IPC access ──
  ipcRenderer: {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, listener) => { ipcRenderer.on(channel, listener); },
    removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener); },
  },
};

contextBridge.exposeInMainWorld('api', api);

// ─── Agent Runtime Bridge ──────────────────────────────────────────────────

export interface AgentRuntimeBridge {
  start(options: RuntimeStartOptions): Promise<{ runId: string; taskId: string; executionId: string }>;
  retry(runId: string): Promise<{ runId: string; taskId: string; executionId: string }>;
  list(): Promise<unknown[]>;
  diagnostics(): Promise<unknown>;
  capabilityPolicies(projectRoot: string): Promise<unknown>;
  prompt(runId: string, prompt: string): Promise<{ ok: boolean }>;
  steer(runId: string, prompt: string): Promise<{ ok: boolean }>;
  followUp(runId: string, prompt: string): Promise<{ ok: boolean }>;
  abort(runId: string): Promise<{ ok: boolean }>;
  stop(runId: string): Promise<{ ok: boolean }>;
  extensionUiResponse(
    runId: string,
    response: { id: string; value?: string; confirmed?: boolean; cancelled?: true },
  ): Promise<{ ok: boolean }>;
  shutdownAll(): Promise<{ ok: boolean }>;
  onEvent(callback: (event: unknown) => void): () => void;
}

const agentRuntime: AgentRuntimeBridge = {
  start: (options) => ipcRenderer.invoke('agent-runtime:start', options),
  retry: (runId) => ipcRenderer.invoke('agent-runtime:retry', runId),
  list: () => ipcRenderer.invoke('agent-runtime:list'),
  diagnostics: () => ipcRenderer.invoke('agent-runtime:diagnostics'),
  capabilityPolicies: (projectRoot) => ipcRenderer.invoke('agent-runtime:capabilityPolicies', projectRoot),
  prompt: (runId, prompt) =>
    ipcRenderer.invoke('agent-runtime:prompt', runId, prompt),
  steer: (runId, prompt) =>
    ipcRenderer.invoke('agent-runtime:steer', runId, prompt),
  followUp: (runId, prompt) =>
    ipcRenderer.invoke('agent-runtime:followUp', runId, prompt),
  abort: (runId) => ipcRenderer.invoke('agent-runtime:abort', runId),
  stop: (runId) => ipcRenderer.invoke('agent-runtime:stop', runId),
  extensionUiResponse: (runId, response) =>
    ipcRenderer.invoke('agent-runtime:extensionUiResponse', runId, response),
  shutdownAll: () => ipcRenderer.invoke('agent-runtime:shutdownAll'),
  onEvent: (callback) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('agent-runtime-event', handler);
    return () => { ipcRenderer.removeListener('agent-runtime-event', handler); };
  },
};

contextBridge.exposeInMainWorld('agentRuntime', agentRuntime);
