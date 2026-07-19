export const WORK_STYLES = ['direct', 'team', 'workflow', 'community'] as const;
export type WorkStyle = typeof WORK_STYLES[number];
export const WORK_STYLE_SELECTIONS = ['agent_decides', ...WORK_STYLES] as const;
export type WorkStyleSelection = typeof WORK_STYLE_SELECTIONS[number];
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export function isWorkStyleSelection(value: unknown): value is WorkStyleSelection {
  return typeof value === 'string' && WORK_STYLE_SELECTIONS.some((item) => item === value);
}

export interface RuntimeStartOptions {
  projectRoot: string;
  name: string;
  taskTitle: string;
  initialTask: string;
  priority: TaskPriority;
  workStyle: WorkStyleSelection;
}
