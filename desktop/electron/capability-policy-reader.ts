import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CapabilityPolicyBundle {
  schemaVersion: 1;
  records: Array<{ effective: unknown; registered?: unknown }>;
  notices: string[];
}

const AGENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function safeJson(filePath: string, notices: string[]): unknown | undefined {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown; }
  catch { notices.push(`Unable to parse ${path.basename(filePath)}; the record was ignored.`); return undefined; }
}

export function readCapabilityPolicyBundle(projectRoot: string): CapabilityPolicyBundle {
  if (!path.isAbsolute(projectRoot)) throw new Error('projectRoot 必须是绝对路径');
  const effectiveDir = path.join(projectRoot, '.agentflux', 'runtime', 'capability-effective');
  const registeredDir = path.join(projectRoot, '.agentflux', 'runtime', 'capability-overrides');
  const notices: string[] = [];
  const records: CapabilityPolicyBundle['records'] = [];
  if (!fs.existsSync(effectiveDir)) return { schemaVersion: 1, records, notices };

  for (const filename of fs.readdirSync(effectiveDir).filter((name) => name.endsWith('.json')).sort()) {
    const agentName = filename.slice(0, -5);
    if (!AGENT_NAME.test(agentName)) { notices.push(`Ignored invalid capability filename: ${filename}`); continue; }
    const effective = safeJson(path.join(effectiveDir, filename), notices) as Record<string, unknown> | undefined;
    if (!effective || effective.schemaVersion !== 1 || effective.agentName !== agentName) {
      notices.push(`Ignored unsupported capability record: ${filename}`);
      continue;
    }
    const registeredPath = path.join(registeredDir, filename);
    const registered = fs.existsSync(registeredPath) ? safeJson(registeredPath, notices) : undefined;
    records.push({ effective, ...(registered ? { registered } : {}) });
  }
  return { schemaVersion: 1, records, notices };
}
