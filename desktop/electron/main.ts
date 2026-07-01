import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

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
  } catch (err: any) { throw new Error(`write-file failed: ${err.message}`); }
});

ipcMain.handle('delete-file', (_event, filePath: string) => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  } catch (err: any) { throw new Error(`delete-file failed: ${err.message}`); }
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

ipcMain.handle('show-folder-dialog', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
