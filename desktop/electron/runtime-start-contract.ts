import { isWorkStyleSelection, type RuntimeStartOptions } from '../shared/runtime-contract';

/** Closed renderer → main contract. No env/argv/file mutation fields are accepted. */
export function validateStartOptions(input: unknown): RuntimeStartOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('start options 必须是对象');
  const value = input as Record<string, unknown>;
  const allowed = new Set(['projectRoot', 'name', 'taskTitle', 'initialTask', 'priority', 'workStyle']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`start options 包含不允许的字段: ${unknown.join(', ')}`);
  const requiredText = (key: string, max: number): string => {
    const text = value[key];
    if (typeof text !== 'string' || text.trim().length === 0) throw new Error(`${key} 是必填的非空字符串`);
    if (text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error(`${key} 格式无效`);
    return text.trim();
  };
  const priority = value.priority;
  const workStyle = value.workStyle;
  if (!['low', 'normal', 'high', 'critical'].includes(String(priority))) throw new Error('priority 必须是 low/normal/high/critical');
  if (!isWorkStyleSelection(workStyle)) throw new Error('workStyle 必须是 agent_decides/direct/team/workflow/community');
  return {
    projectRoot: requiredText('projectRoot', 4096),
    name: requiredText('name', 96),
    taskTitle: requiredText('taskTitle', 160),
    initialTask: requiredText('initialTask', 100_000),
    priority: priority as RuntimeStartOptions['priority'],
    workStyle,
  };
}
