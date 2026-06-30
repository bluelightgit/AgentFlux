import { contextBridge, ipcRenderer } from 'electron';
import * as fs from 'fs';

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  // Sync APIs (for small reads)
  readFile: (filePath: string) => {
    try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
  },
  fileSize: (filePath: string) => {
    try { return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0; } catch { return 0; }
  },
  exists: (filePath: string) => {
    try { return fs.existsSync(filePath); } catch { return false; }
  },
  // Async APIs (for writes/deletes, must go through IPC for safety)
  ipcRenderer: {
    invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
  },
  listDirectory: (dirPath: string) => ipcRenderer.invoke('list-directory', dirPath),
  readDirectoryFiles: (dirPath: string) => ipcRenderer.invoke('read-directory-files', dirPath),
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  showFolderDialog: () => ipcRenderer.invoke('show-folder-dialog'),
});
