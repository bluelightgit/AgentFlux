import { contextBridge, ipcRenderer } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  ipcRenderer: {
    invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
  },
  // File access APIs (for events-parser async mode)
  readFile: (filePath: string) => fs.readFileSync(filePath, 'utf-8'),
  fileSize: (filePath: string) => fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
  exists: (filePath: string) => fs.existsSync(filePath),
});
