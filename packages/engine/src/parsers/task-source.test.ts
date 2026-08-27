import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskSource } from './task-source.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '../test-support/home-env.js';

let tmpHome: string;
const origHome = homeEnvSnapshot();
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'task-')); useHomeDir(tmpHome); });
afterEach(() => { restoreHomeEnv(origHome); rmSync(tmpHome, { recursive: true, force: true }); });

describe('TaskSource', () => {
  test('discovers tasks/<sessionUuid>/*.json (TodoWrite output)', async () => {
    const sid = '11111111-2222-3333-4444-555555555555';
    const dir = join(tmpHome, '.claude', 'tasks', sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 'Fix auth bug', status: 'in_progress' }));
    writeFileSync(join(dir, '2.json'), JSON.stringify({ id: '2', subject: 'Write tests', status: 'completed' }));
    const src = new TaskSource(join(tmpHome, '.claude', 'tasks'));
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items.length).toBeGreaterThanOrEqual(1);
    const taskList = items.find(i => i.id === sid);
    expect(taskList).toBeDefined();
    expect(taskList.extra.taskCount).toBe(2);
    expect(taskList.extra.completedCount).toBe(1);
  });

  test('discovers todos/*.json from ~/.claude/todos as agent_todo task items', async () => {
    const todosDir = join(tmpHome, '.claude', 'todos');
    mkdirSync(todosDir, { recursive: true });
    writeFileSync(
      join(todosDir, 'aaa-agent-aaa.json'),
      JSON.stringify([
        { id: '1', content: 'Refactor SSO', status: 'in_progress' },
        { id: '2', content: 'Doc the new flow', status: 'completed' },
      ]),
    );
    const src = new TaskSource(join(tmpHome, '.claude', 'tasks'));
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const agentTodo = items.find(i => i.extra?.kind === 'agent_todo');
    expect(agentTodo).toBeDefined();
    expect(agentTodo.extra.taskCount).toBe(2);
    expect(agentTodo.extra.tool).toBe('claude');
  });

  test('skips empty (2-byte "[]") todos files', async () => {
    const todosDir = join(tmpHome, '.claude', 'todos');
    mkdirSync(todosDir, { recursive: true });
    writeFileSync(join(todosDir, 'empty.json'), '[]');
    const src = new TaskSource(join(tmpHome, '.claude', 'tasks'));
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items.find(i => i.extra?.kind === 'agent_todo')).toBeUndefined();
  });
});
