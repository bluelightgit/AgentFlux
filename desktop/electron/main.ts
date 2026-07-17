import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { agentRuntime, AgentRuntime } from './agent-runtime';
import { readCapabilityPolicyBundle } from './capability-policy-reader';
import { validateStartOptions } from './runtime-start-contract';

const isDev = process.env.NODE_ENV === 'development';

// ─── IPC 文件读取处理器 (供渲染进程调用) ───
ipcMain.handle('read-file', (_event, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch { return ''; }
});

ipcMain.handle('file-size', (_event, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch { return 0; }
});

ipcMain.handle('read-file-incremental', (_event, filePath: string, offset: number) => {
  try {
    if (!fs.existsSync(filePath)) return { content: '', newSize: 0 };
    const stat = fs.statSync(filePath);
    if (stat.size <= offset) return { content: '', newSize: stat.size };
    const fd = fs.openSync(filePath, 'r');
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    fs.closeSync(fd);
    return { content: buffer.toString('utf-8'), newSize: stat.size };
  } catch { return { content: '', newSize: 0 }; }
});

ipcMain.handle('path-exists', (_event, filePath: string) => {
  try { return fs.existsSync(filePath); } catch { return false; }
});

ipcMain.handle('write-file', (_event, filePath: string, content: string) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch { return false; }
});

ipcMain.handle('delete-file', (_event, filePath: string) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  } catch { return false; }
});

ipcMain.handle('list-directory', (_event, dirPath: string) => {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath);
  } catch { return []; }
});

ipcMain.handle('read-directory-files', (_event, dirPath: string) => {
  try {
    if (!fs.existsSync(dirPath)) return [];
    const files = fs.readdirSync(dirPath);
    return files.map(f => ({ name: f, content: fs.readFileSync(path.join(dirPath, f), 'utf-8') }));
  } catch { return []; }
});

ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

// ─── 文件监听 (fs.watch 实时推送) ───
// 跟踪每个文件路径对应的 watcher, 避免重复监听并支持清理
const fileWatchers = new Map<string, fs.FSWatcher>();

ipcMain.handle('watch-file', (event, filePath: string) => {
  try {
    // 关闭已存在的 watcher 避免重复监听
    const existing = fileWatchers.get(filePath);
    if (existing) { existing.close(); fileWatchers.delete(filePath); }
    const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      // Send event to renderer via webContents.send
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) {
        win.webContents.send('file-changed', { filePath, eventType, timestamp: Date.now() });
      }
    });
    // 监听错误, 自动清理失效的 watcher
    watcher.on('error', () => {
      const w = fileWatchers.get(filePath);
      if (w) { w.close(); fileWatchers.delete(filePath); }
    });
    fileWatchers.set(filePath, watcher);
    return { ok: true };
  } catch { return { ok: false }; }
});

ipcMain.handle('unwatch-file', (_event, filePath: string) => {
  try {
    const watcher = fileWatchers.get(filePath);
    if (watcher) { watcher.close(); fileWatchers.delete(filePath); }
    return { ok: true };
  } catch { return { ok: false }; }
});

ipcMain.handle('window-minimize', () => { BrowserWindow.getFocusedWindow()?.minimize(); });
ipcMain.handle('window-maximize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
});
ipcMain.handle('window-close', () => { BrowserWindow.getFocusedWindow()?.close(); });
ipcMain.handle('window-is-maximized', () => BrowserWindow.getFocusedWindow()?.isMaximized() ?? false);

ipcMain.handle('show-folder-dialog', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

// ─── Agent Runtime IPC 处理器 ─────────────────────────────────────────────

// ── Snapshot 推送 ──
// EVENT_RECORD_UPDATE → push {kind:'snapshot', snapshot} 到渲染进程
agentRuntime.on(AgentRuntime.EVENT_RECORD_UPDATE, (snapshot: unknown) => {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send('agent-runtime-event', { kind: 'snapshot', snapshot });
    }
  }
});

// ── 真实 RPC 事件推送 ──
// EVENT_RUNTIME_EVENT → push {kind:'event', runId, event} 到渲染进程
agentRuntime.on(AgentRuntime.EVENT_RUNTIME_EVENT, (payload: { runId: string; event: unknown }) => {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send('agent-runtime-event', {
        kind: 'event',
        runId: payload.runId,
        event: payload.event,
      });
    }
  }
});

agentRuntime.on(AgentRuntime.EVENT_RECORD_REMOVED, (runId: unknown) => {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send('agent-runtime-event', { kind: 'record_removed', runId });
    }
  }
});

ipcMain.handle('agent-runtime:start', async (_event, rawOptions: unknown) => {
  const options = validateStartOptions(rawOptions);
  const runId = await agentRuntime.start(options);
  await agentRuntime.waitUntilReady(runId);
  const snapshot = agentRuntime.list().find((item) => item.runId === runId);
  if (!snapshot) throw new Error('Runtime 启动后未生成快照');
  return { runId, taskId: snapshot.taskId, executionId: snapshot.executionId };
});

ipcMain.handle('agent-runtime:retry', async (_event, runId: unknown) => {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9:-]{1,160}$/.test(runId)) throw new Error('Invalid retry runId');
  const nextRunId = await agentRuntime.retry(runId);
  await agentRuntime.waitUntilReady(nextRunId);
  const snapshot = agentRuntime.list().find((item) => item.runId === nextRunId);
  if (!snapshot) throw new Error('Retry did not create a snapshot');
  return { runId: nextRunId, taskId: snapshot.taskId, executionId: snapshot.executionId };
});

ipcMain.handle('agent-runtime:prompt', async (_event, runId: string, prompt: string) => {
  await agentRuntime.prompt(runId, prompt);
  return { ok: true };
});

ipcMain.handle('agent-runtime:steer', async (_event, runId: string, prompt: string) => {
  await agentRuntime.steer(runId, prompt);
  return { ok: true };
});

ipcMain.handle('agent-runtime:followUp', async (_event, runId: string, prompt: string) => {
  await agentRuntime.followUp(runId, prompt);
  return { ok: true };
});

ipcMain.handle('agent-runtime:abort', async (_event, runId: string) => {
  await agentRuntime.abort(runId);
  return { ok: true };
});

ipcMain.handle('agent-runtime:stop', async (_event, runId: string) => {
  await agentRuntime.stop(runId);
  return { ok: true };
});

ipcMain.handle('agent-runtime:extensionUiResponse', async (
  _event,
  runId: string,
  response: { id: string; value?: string; confirmed?: boolean; cancelled?: true },
) => {
  await agentRuntime.respondToExtensionUI(runId, response as Parameters<AgentRuntime['respondToExtensionUI']>[1]);
  return { ok: true };
});

ipcMain.handle('agent-runtime:list', async () => {
  return agentRuntime.list();
});

ipcMain.handle('agent-runtime:diagnostics', async () => {
  return agentRuntime.getDiagnostics();
});

ipcMain.handle('agent-runtime:capabilityPolicies', async (_event, projectRoot: string) => {
  return readCapabilityPolicyBundle(projectRoot);
});

ipcMain.handle('agent-runtime:shutdownAll', async () => {
  await agentRuntime.shutdownAll();
  return { ok: true };
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });

    // Suppress benign DevTools Autofill protocol errors (CDP domain not implemented in Electron)
    win.webContents.on('devtools-opened', () => {
      const dt = win.webContents.devToolsWebContents;
      if (dt) {
        dt.on('console-message', (e: Electron.Event, _level: number, message: string) => {
          if (message.includes('Autofill')) e.preventDefault();
        });
      }
    });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  agentRuntime.configurePersistence(path.join(app.getPath('userData'), 'runtime-history.v1.json'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── 应用退出时清理 agent runtime ───────────────────────────────────────────
app.on('will-quit', async () => {
  await agentRuntime.shutdownAll();
});

app.on('before-quit', async () => {
  await agentRuntime.shutdownAll();
});
