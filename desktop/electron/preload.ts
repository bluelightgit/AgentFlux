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
  // Async file size via IPC (returns Promise<number>), used by useLiveUpdate polling
  getFileSize: (filePath: string) => ipcRenderer.invoke('file-size', filePath),
  // fs.watch-backed live file watching
  watchFile: (filePath: string) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath: string) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback: (data: any) => void) => {
    const handler = (_event: unknown, data: any) => callback(data);
    ipcRenderer.on('file-changed', handler);
    return () => { ipcRenderer.removeListener('file-changed', handler); };
  },
  listDirectory: (dirPath: string) => ipcRenderer.invoke('list-directory', dirPath),
  readDirectoryFiles: (dirPath: string) => ipcRenderer.invoke('read-directory-files', dirPath),
  // Delete a file via IPC (no-op if file missing)
  deleteFile: (filePath: string) => ipcRenderer.invoke('delete-file', filePath),
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  showFolderDialog: () => ipcRenderer.invoke('show-folder-dialog'),
});
