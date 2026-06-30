import { readFileContent } from './file-access';

export interface SessionMetadata {
  fileName: string; sessionId: string; agentName: string; timestamp: string;
  model: string; userMsgs: number; assistantMsgs: number;
  totalInput: number; totalCacheRead: number; totalCost: number;
  cacheHitRate: number; hasErrors: boolean; fileSize: number;
}
export interface SessionMessage { role: string; content: any[]; usage?: any; errorMessage?: string; timestamp: string; }

export async function listSessions(sessionsDir: string): Promise<SessionMetadata[]> {
  let files: string[] = [];
  try { if (typeof window !== 'undefined' && window.api?.listDirectory) files = await window.api.listDirectory(sessionsDir); } catch {}
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
  const metas: SessionMetadata[] = [];
  for (const f of jsonlFiles) { const m = await parseSessionMetadata(sessionsDir + '/' + f); if (m) metas.push(m); }
  return metas.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function parseSessionMetadata(filePath: string): Promise<SessionMetadata | null> {
  const content = await readFileContent(filePath); if (!content) return null;
  const lines = content.trim().split('\n');
  let sessionId = '', timestamp = '', model = '';
  let userMsgs = 0, assistantMsgs = 0, totalInput = 0, totalCacheRead = 0, totalCost = 0, hasErrors = false;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'session') { sessionId = e.id || ''; timestamp = e.timestamp || ''; }
      if (e.type === 'model_change' && e.modelId) model = e.modelId;
      if (e.type === 'message' && e.message) {
        const m = e.message;
        if (m.role === 'user') userMsgs++; if (m.role === 'assistant') assistantMsgs++;
        if (m.usage) { totalInput += m.usage.input || 0; totalCacheRead += m.usage.cacheRead || 0; if (m.usage.cost) totalCost += m.usage.cost.total || 0; }
        if (m.errorMessage) hasErrors = true;
      }
    } catch {}
  }
  const agentName = sessionId.startsWith('flux-') ? sessionId.slice(5) : sessionId;
  const cacheHitRate = totalCacheRead / (totalCacheRead + totalInput + 1e-9);
  return { fileName: filePath.split('/').pop() || '', sessionId, agentName, timestamp, model, userMsgs, assistantMsgs, totalInput, totalCacheRead, totalCost, cacheHitRate, hasErrors, fileSize: content.length };
}

export async function readSessionMessages(filePath: string): Promise<SessionMessage[]> {
  const content = await readFileContent(filePath); if (!content) return [];
  const messages: SessionMessage[] = [];
  for (const line of content.trim().split('\n')) {
    try { const e = JSON.parse(line); if (e.type === 'message' && e.message) { messages.push({ role: e.message.role, content: e.message.content || [], usage: e.message.usage, errorMessage: e.message.errorMessage, timestamp: e.timestamp || '' }); } } catch {}
  }
  return messages;
}
