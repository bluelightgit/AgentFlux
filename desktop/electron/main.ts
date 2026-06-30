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
