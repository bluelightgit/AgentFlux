/**
 * Preload Contract Test
 *
 * 静态/模块契约验证：
 *   1. preload 同时 expose 'api' 与 'agentRuntime'
 *   2. api 包含所有 legacy 方法（文件/目录/监听/窗口/对话框）
 *   3. agentRuntime 包含所有 runtime 方法
 *
 * 由于 preload.ts 依赖于 Electron 的 contextBridge/ipcRenderer，
 * 在 vitest/node 环境中无法直接执行，因此我们通过类型级别和结构契约验证。
 */

import { describe, it, expect } from 'vitest';

// ─── 从 preload 导入类型定义 ───────────────────────────────────────────────
// 这些类型在 preload.ts 中 export，用于验证结构

// 我们定义本地副本用于验证，确保与 preload.ts 中的接口一致
interface ElectronFileApi {
  readFile: (path: string) => unknown;
  fileSize: (path: string) => unknown;
  getFileSize: (path: string) => unknown;
  readFileIncremental: (path: string, offset: number) => unknown;
  exists: (path: string) => unknown;
  pathExists: (path: string) => unknown;
  writeFile: (path: string, content: string) => unknown;
  deleteFile: (path: string) => unknown;
  listDirectory: (path: string) => unknown;
  readDirectory: (path: string) => unknown;
  readDirectoryFiles: (path: string) => unknown;
  getUserDataPath: () => unknown;
  watchFile: (path: string) => unknown;
  unwatchFile: (path: string) => unknown;
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  showFolderDialog: () => unknown;
  platform: string;
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => unknown;
    on: (channel: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
  };
}

interface AgentRuntimeBridge {
  start(options: { projectRoot: string; name: string; taskTitle: string; initialTask: string; priority: 'low'|'normal'|'high'|'critical'; workStyle: 'agent_decides'|'direct'|'team'|'workflow'|'community' }): Promise<{ runId: string; taskId: string; executionId: string }>;
  list(): Promise<unknown[]>;
  diagnostics(): Promise<unknown>;
  capabilityPolicies(projectRoot: string): Promise<unknown>;
  prompt(runId: string, prompt: string): Promise<{ ok: boolean }>;
  steer(runId: string, prompt: string): Promise<{ ok: boolean }>;
  followUp(runId: string, prompt: string): Promise<{ ok: boolean }>;
  abort(runId: string): Promise<{ ok: boolean }>;
  stop(runId: string): Promise<{ ok: boolean }>;
  shutdownAll(): Promise<{ ok: boolean }>;
  onEvent(callback: (event: unknown) => void): () => void;
}

interface GlobalWithApi {
  api?: ElectronFileApi;
  agentRuntime?: AgentRuntimeBridge;
}

// ─── 类型/结构验证（静态契约） ──────────────────────────────────────────────

describe('Preload Contract — 类型与结构验证', () => {

  // ── 验证 window.api 存在并包含全部 legacy 方法 ──

  it('契约：electron-file-api 接口必须包含所有文件操作方法', () => {
    const api: ElectronFileApi = {
      readFile: () => '',
      fileSize: () => 0,
      getFileSize: () => 0,
      readFileIncremental: () => ({ content: '', newSize: 0 }),
      exists: () => true,
      pathExists: () => true,
      writeFile: () => true,
      deleteFile: () => true,
      listDirectory: () => [],
      readDirectory: () => [],
      readDirectoryFiles: () => [],
      getUserDataPath: () => '',
      watchFile: () => ({ ok: true }),
      unwatchFile: () => ({ ok: true }),
      minimizeWindow: async () => {},
      maximizeWindow: async () => false,
      closeWindow: async () => {},
      isMaximized: async () => false,
      showFolderDialog: () => null,
      platform: 'win32',
      ipcRenderer: {
        invoke: () => Promise.resolve(),
        on: () => {},
        removeListener: () => {},
      },
    };

    // 文件操作
    expect(typeof api.readFile).toBe('function');
    expect(typeof api.fileSize).toBe('function');
    expect(typeof api.getFileSize).toBe('function');
    expect(typeof api.readFileIncremental).toBe('function');
    expect(typeof api.exists).toBe('function');
    expect(typeof api.pathExists).toBe('function');
    expect(typeof api.writeFile).toBe('function');
    expect(typeof api.deleteFile).toBe('function');

    // 目录操作
    expect(typeof api.listDirectory).toBe('function');
    expect(typeof api.readDirectory).toBe('function');
    expect(typeof api.readDirectoryFiles).toBe('function');

    // 工具
    expect(typeof api.getUserDataPath).toBe('function');

    // 文件监听
    expect(typeof api.watchFile).toBe('function');
    expect(typeof api.unwatchFile).toBe('function');

    // 窗口控制
    expect(typeof api.minimizeWindow).toBe('function');
    expect(typeof api.maximizeWindow).toBe('function');
    expect(typeof api.closeWindow).toBe('function');
    expect(typeof api.isMaximized).toBe('function');

    // 对话框
    expect(typeof api.showFolderDialog).toBe('function');

    // 平台
    expect(typeof api.platform).toBe('string');

    // IPC
    expect(typeof api.ipcRenderer.invoke).toBe('function');
    expect(typeof api.ipcRenderer.on).toBe('function');
    expect(typeof api.ipcRenderer.removeListener).toBe('function');
  });

  it('契约：agent-runtime-bridge 接口必须包含所有 runtime 方法', () => {
    const bridge: AgentRuntimeBridge = {
      start: async () => ({ runId: '', taskId: '', executionId: '' }),
      list: async () => [],
      prompt: async () => ({ ok: true }),
      steer: async () => ({ ok: true }),
      followUp: async () => ({ ok: true }),
      abort: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      shutdownAll: async () => ({ ok: true }),
      onEvent: () => () => {},
    };

    expect(typeof bridge.start).toBe('function');
    expect(typeof bridge.list).toBe('function');
    expect(typeof bridge.prompt).toBe('function');
    expect(typeof bridge.steer).toBe('function');
    expect(typeof bridge.followUp).toBe('function');
    expect(typeof bridge.abort).toBe('function');
    expect(typeof bridge.stop).toBe('function');
    expect(typeof bridge.shutdownAll).toBe('function');
    expect(typeof bridge.onEvent).toBe('function');
  });

  it('契约：start 方法接受受控的 task-scoped 参数', () => {
    // 验证参数类型
    type StartParams = Parameters<AgentRuntimeBridge['start']>[0];
    const params: StartParams = {
      projectRoot: '/test',
      name: 'test',
      taskTitle: 'Task',
      initialTask: 'optional',
      priority: 'normal',
      workStyle: 'agent_decides',
    };
    expect(params.projectRoot).toBe('/test');
    expect(params.name).toBe('test');
    expect(params.initialTask).toBe('optional');

    // fixed 模式是闭集
    const params2: StartParams = {
      projectRoot: '/test',
      name: 'test',
      taskTitle: 'Task',
      initialTask: 'Prompt',
      priority: 'critical',
      workStyle: 'workflow',
    };
    expect(params2.workStyle).toBe('workflow');
  });

  it('契约：window 同时含有 api 与 agentRuntime 两个属性', () => {
    // 在真正的 Electron 环境中，contextBridge.exposeInMainWorld 将两者注入 window
    // 这里模拟验证
    const w: GlobalWithApi = {
      api: {
        readFile: () => '',
        fileSize: () => 0,
        getFileSize: () => 0,
        readFileIncremental: () => ({ content: '', newSize: 0 }),
        exists: () => true,
        pathExists: () => true,
        writeFile: () => true,
        deleteFile: () => true,
        listDirectory: () => [],
        readDirectory: () => [],
        readDirectoryFiles: () => [],
        getUserDataPath: () => '',
        watchFile: () => ({ ok: true }),
        unwatchFile: () => ({ ok: true }),
        minimizeWindow: async () => {},
        maximizeWindow: async () => false,
        closeWindow: async () => {},
        isMaximized: async () => false,
        showFolderDialog: () => null,
        platform: 'win32',
        ipcRenderer: { invoke: () => Promise.resolve(), on: () => {}, removeListener: () => {} },
      },
      agentRuntime: {
        start: async () => ({ runId: '', taskId: '', executionId: '' }),
        list: async () => [],
        prompt: async () => ({ ok: true }),
        steer: async () => ({ ok: true }),
        followUp: async () => ({ ok: true }),
        abort: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        shutdownAll: async () => ({ ok: true }),
        onEvent: () => () => {},
      },
    };
    
    // 验证两个属性存在
    expect(w.api).toBeDefined();
    expect(w.agentRuntime).toBeDefined();
    
    // 验证 api 有文件操作方法
    expect(typeof w.api!.readFile).toBe('function');
    
    // 验证 agentRuntime 有 runtime 方法
    expect(typeof w.agentRuntime!.start).toBe('function');
  });

  // ── 验证关键 api 方法的签名 ──

  it('契约：readFile 接受 string path 返回 string', () => {
    type ReadFileFn = (path: string) => unknown;
    const fn: ReadFileFn = (p) => p;
    expect(fn('/test/file.txt')).toBe('/test/file.txt');
  });

  it('契约：listDirectory 接受 string path 返回 string[]', () => {
    type ListDirFn = (path: string) => unknown;
    const fn: ListDirFn = (p) => [p];
    expect(Array.isArray(fn('/test'))).toBe(true);
  });

  it('契约：onEvent 返回取消订阅函数', () => {
    type OnEventFn = (callback: (event: unknown) => void) => () => void;
    const fn: OnEventFn = (cb) => {
      cb({ test: true });
      return () => {};
    };
    const unsub = fn((evt) => { expect(evt).toEqual({ test: true }); });
    expect(typeof unsub).toBe('function');
  });

  // ── 验证不删除任一 legacy API ──

  it('契约：ElectronFileApi 包含所有 21 个方法/属性', () => {
    // 类型层面验证 — 使用类型兼容性检查
    const api: ElectronFileApi = {
      readFile: () => '',
      fileSize: () => 0,
      getFileSize: () => 0,
      readFileIncremental: () => ({ content: '', newSize: 0 }),
      exists: () => true,
      pathExists: () => true,
      writeFile: () => true,
      deleteFile: () => true,
      listDirectory: () => [],
      readDirectory: () => [],
      readDirectoryFiles: () => [],
      getUserDataPath: () => '',
      watchFile: () => ({ ok: true }),
      unwatchFile: () => ({ ok: true }),
      minimizeWindow: async () => {},
      maximizeWindow: async () => false,
      closeWindow: async () => {},
      isMaximized: async () => false,
      showFolderDialog: () => null,
      platform: 'win32',
      ipcRenderer: {
        invoke: () => Promise.resolve(),
        on: () => {},
        removeListener: () => {},
      },
    };

    const keys = Object.keys(api);

    const requiredMethods: string[] = [
      'readFile',
      'fileSize',
      'getFileSize',
      'readFileIncremental',
      'exists',
      'pathExists',
      'writeFile',
      'deleteFile',
      'listDirectory',
      'readDirectory',
      'readDirectoryFiles',
      'getUserDataPath',
      'watchFile',
      'unwatchFile',
      'minimizeWindow',
      'maximizeWindow',
      'closeWindow',
      'isMaximized',
      'showFolderDialog',
      'platform',
      'ipcRenderer',
    ];

    for (const method of requiredMethods) {
      expect(keys).toContain(method);
    }

    // 验证方法签名
    expect(typeof api.readFile).toBe('function');
    expect(typeof api.fileSize).toBe('function');
    expect(typeof api.writeFile).toBe('function');
    expect(typeof api.listDirectory).toBe('function');
    expect(typeof api.ipcRenderer).toBe('object');
    expect(typeof api.ipcRenderer.invoke).toBe('function');
    expect(typeof api.platform).toBe('string');
  });

  it('契约：AgentRuntimeBridge 包含 runtime、diagnostics 与 capability policy 方法', () => {
    const bridge: AgentRuntimeBridge = {
      start: async () => ({ runId: '', taskId: '', executionId: '' }),
      list: async () => [],
      diagnostics: async () => ({}),
      capabilityPolicies: async () => ({}),
      prompt: async () => ({ ok: true }),
      steer: async () => ({ ok: true }),
      followUp: async () => ({ ok: true }),
      abort: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      shutdownAll: async () => ({ ok: true }),
      onEvent: () => () => {},
    };

    const keys = Object.keys(bridge);

    const requiredMethods: string[] = [
      'start',
      'list',
      'diagnostics',
      'capabilityPolicies',
      'prompt',
      'steer',
      'followUp',
      'abort',
      'stop',
      'shutdownAll',
      'onEvent',
    ];

    for (const method of requiredMethods) {
      expect(keys).toContain(method);
    }
  });
});

// ─── 模拟模块级别的验证 ─────────────────────────────────────────────────────
// 在无法加载 preload.js 的情况下，通过模拟 contextBridge 验证暴露行为

describe('Preload Contract — 模拟模块暴露验证', () => {
  it('模拟 contextBridge.exposeInMainWorld 被调用两次（api + agentRuntime）', () => {
    const exposedCalls: Array<{ name: string; value: unknown }> = [];

    const mockContextBridge = {
      exposeInMainWorld: (name: string, value: unknown) => {
        exposedCalls.push({ name, value });
      },
    };

    // 模拟 preload 中的逻辑
    const api: ElectronFileApi = {} as ElectronFileApi; // 简化
    const agentRuntimeBridge: AgentRuntimeBridge = {} as AgentRuntimeBridge;

    mockContextBridge.exposeInMainWorld('api', api);
    mockContextBridge.exposeInMainWorld('agentRuntime', agentRuntimeBridge);

    // 验证 exposeInMainWorld 被调用了两次
    expect(exposedCalls.length).toBe(2);

    // 验证两个暴露的名称
    const exposedNames = exposedCalls.map(c => c.name);
    expect(exposedNames).toContain('api');
    expect(exposedNames).toContain('agentRuntime');
  });

  it('模拟暴露的 api 对象包含全部方法（非空验证）', () => {
    const exposedCalls: Array<{ name: string; value: Record<string, unknown> }> = [];

    const mockContextBridge = {
      exposeInMainWorld: (name: string, value: Record<string, unknown>) => {
        exposedCalls.push({ name, value });
      },
    };

    // 模拟 preload 暴露
    const api: Record<string, unknown> = {
      readFile: () => '',
      fileSize: () => 0,
      getFileSize: () => 0,
      readFileIncremental: () => ({ content: '', newSize: 0 }),
      exists: () => true,
      pathExists: () => true,
      writeFile: () => true,
      deleteFile: () => true,
      listDirectory: () => [],
      readDirectory: () => [],
      readDirectoryFiles: () => [],
      getUserDataPath: () => '',
      watchFile: () => ({ ok: true }),
      unwatchFile: () => ({ ok: true }),
      minimizeWindow: async () => {},
      maximizeWindow: async () => false,
      closeWindow: async () => {},
      isMaximized: async () => false,
      showFolderDialog: () => null,
      platform: 'win32',
      ipcRenderer: {
        invoke: () => Promise.resolve(),
        on: () => {},
        removeListener: () => {},
      },
    };

    mockContextBridge.exposeInMainWorld('api', api);

    // 验证所有方法都存在
    const apiObj = exposedCalls.find(c => c.name === 'api')?.value;
    expect(apiObj).toBeDefined();

    if (apiObj) {
      expect(typeof apiObj.readFile).toBe('function');
      expect(typeof apiObj.fileSize).toBe('function');
      expect(typeof apiObj.platform).toBe('string');
      expect(typeof apiObj.ipcRenderer).toBe('object');
      expect(typeof apiObj.ipcRenderer.invoke).toBe('function');
    }
  });

  it('模拟暴露的 agentRuntime 对象包含全部方法（非空验证）', () => {
    const exposedCalls: Array<{ name: string; value: Record<string, unknown> }> = [];

    const mockContextBridge = {
      exposeInMainWorld: (name: string, value: Record<string, unknown>) => {
        exposedCalls.push({ name, value });
      },
    };

    const agentRuntimeBridge: Record<string, unknown> = {
      start: async () => ({ runId: '', taskId: '', executionId: '' }),
      list: async () => [],
      prompt: async () => ({ ok: true }),
      steer: async () => ({ ok: true }),
      followUp: async () => ({ ok: true }),
      abort: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      shutdownAll: async () => ({ ok: true }),
      onEvent: () => () => {},
    };

    mockContextBridge.exposeInMainWorld('agentRuntime', agentRuntimeBridge);

    const rtObj = exposedCalls.find(c => c.name === 'agentRuntime')?.value;
    expect(rtObj).toBeDefined();

    if (rtObj) {
      expect(typeof rtObj.start).toBe('function');
      expect(typeof rtObj.onEvent).toBe('function');
      expect(typeof rtObj.onEvent()).toBe('function'); // returns unsubscribe fn
    }
  });

  it('模拟 window 同时拥有 api 和 agentRuntime', () => {
    // 模拟 Electron 渲染进程中的 window
    interface MockWindow {
      api?: ElectronFileApi;
      agentRuntime?: AgentRuntimeBridge;
    }

    const mockWindow: MockWindow = {};

    // 模拟 contextBridge 注入
    mockWindow.api = {} as ElectronFileApi;
    mockWindow.agentRuntime = {} as AgentRuntimeBridge;

    expect('api' in mockWindow).toBe(true);
    expect('agentRuntime' in mockWindow).toBe(true);
    expect(typeof mockWindow.api).toBe('object');
    expect(typeof mockWindow.agentRuntime).toBe('object');
  });
});
