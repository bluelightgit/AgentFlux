import { describe, expect, it } from 'vitest';
import { validateStartOptions } from '../../electron/runtime-start-contract';

const valid = {
  projectRoot: 'C:\\work\\AgentFlux', name: 'lead', taskTitle: 'Task title', initialTask: 'Do the work',
  priority: 'normal', workStyle: 'agent_decides',
};

describe('agent-runtime:start IPC input contract', () => {
  it('accepts only the task-scoped closed contract and trims text', () => {
    expect(validateStartOptions({ ...valid, taskTitle: '  Task title  ', workStyle: 'workflow' })).toEqual({ ...valid, taskTitle: 'Task title', workStyle: 'workflow' });
  });

  it('rejects arbitrary renderer env/args and unknown modes', () => {
    expect(() => validateStartOptions({ ...valid, env: { SECRET: 'x' } })).toThrow('不允许的字段');
    expect(() => validateStartOptions({ ...valid, args: ['--dangerous'] })).toThrow('不允许的字段');
    expect(() => validateStartOptions({ ...valid, workStyle: 'swarm' })).toThrow('workStyle');
  });

  it('rejects renderer-forged retry provenance', () => {
    for (const [field, value] of [['retryOfRunId', 'forged'], ['rootRunId', 'forged'], ['retryAttempt', 2]] as const) {
      expect(() => validateStartOptions({ ...valid, [field]: value })).toThrow('不允许的字段');
    }
  });

  it('requires title, prompt, priority and work style', () => {
    for (const key of ['taskTitle', 'initialTask', 'priority', 'workStyle']) {
      const input = { ...valid } as Record<string, unknown>;
      delete input[key];
      expect(() => validateStartOptions(input)).toThrow();
    }
  });
});
