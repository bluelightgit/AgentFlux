import { readFileContent } from './file-access';

export interface WorkspaceEntry { id: string; name: string; path: string; lastOpened: number; pinned: boolean; }
export interface WorkspaceRegistry { workspaces: WorkspaceEntry[]; activeId: string | null; }

async function getRegistryPath(): Promise<string> {
  if (typeof window === 'undefined' || !window.api?.getUserDataPath) throw new Error('no window.api');
  const userDataPath = await window.api.getUserDataPath();
  return userDataPath + '/workspaces.json';
}

export async function loadRegistry(): Promise<WorkspaceRegistry> {
  try { const p = await getRegistryPath(); const content = await readFileContent(p); if (!content) return { workspaces: [], activeId: null }; return JSON.parse(content); } catch { return { workspaces: [], activeId: null }; }
}
export async function saveRegistry(reg: WorkspaceRegistry): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.ipcRenderer) throw new Error('no window.api');
  const p = await getRegistryPath(); await window.api.ipcRenderer.invoke('write-file', p, JSON.stringify(reg, null, 2));
}
export async function addWorkspace(path: string): Promise<WorkspaceEntry> {
  const reg = await loadRegistry(); const entry: WorkspaceEntry = { id: Date.now().toString(), name: path.split(/[/\\]/).filter(Boolean).pop() || path, path, lastOpened: Date.now(), pinned: false }; reg.workspaces.push(entry); await saveRegistry(reg); return entry;
}
export async function removeWorkspace(id: string): Promise<void> {
  const reg = await loadRegistry(); reg.workspaces = reg.workspaces.filter(w => w.id !== id); if (reg.activeId === id) reg.activeId = null; await saveRegistry(reg);
}
export async function setActive(id: string): Promise<WorkspaceEntry | null> {
  const reg = await loadRegistry(); const entry = reg.workspaces.find(w => w.id === id); if (!entry) return null; entry.lastOpened = Date.now(); reg.activeId = id; await saveRegistry(reg); return entry;
}
export async function getActiveWorkspace(): Promise<WorkspaceEntry | null> {
  const reg = await loadRegistry(); if (!reg.activeId) return null; return reg.workspaces.find(w => w.id === reg.activeId) || null;
}
