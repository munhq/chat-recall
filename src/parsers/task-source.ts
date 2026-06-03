/**
 * Task memory source.
 *
 * Parses ~/.claude/tasks/{uuid}/*.json files. Each task directory
 * corresponds to a session (the UUID IS the session ID). Individual
 * task JSON files contain subject, description, and status.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { discoverSubdirs } from '../core/utils.js';
import { claudeBackend as CLAUDE } from '../core/backends/claude.js';
import { isSourceEnabled } from '../core/settings.js';

interface TaskJson {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status?: string;
  blocks?: string[];
  blockedBy?: string[];
}

const MAX_CHUNK_CHARS = 2000;

export class TaskSource implements MemorySource {
  readonly sourceType = 'task' as const;

  private tasksDirs: string[];

  constructor(tasksDir?: string) {
    if (tasksDir) {
      this.tasksDirs = [tasksDir];
    } else {
      this.tasksDirs = discoverSubdirs('tasks');
    }
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('claude', 'tasks')) return;
    for (const tasksDir of this.tasksDirs) {
      yield* this.discoverInDir(tasksDir);
    }
    // Claude also keeps per-agent todo state in ~/.claude/todos/<uuid>.json,
    // separate from tasks/. Most files are empty (agents that finished
    // cleanly), so we skip the noise and only yield the ones with real content.
    yield* this.discoverClaudeTodos();
  }

  private async *discoverClaudeTodos(): AsyncGenerator<MemoryItem> {
    const todosDir = CLAUDE.todosDir();
    if (!existsSync(todosDir)) return;

    let files: string[];
    try { files = readdirSync(todosDir).filter(f => f.endsWith('.json')); } catch { return; }

    for (const file of files) {
      const filePath = join(todosDir, file);
      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      // Skip empty `[]` files (most of the 2,500+ are these).
      if (stat.size < 6) continue;

      let parsed: TaskJson[];
      try {
        const raw = readFileSync(filePath, 'utf-8');
        parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
      } catch { continue; }

      // Filename pattern: <sessionUuid>-agent-<sessionUuid>.json
      const m = file.match(/^([0-9a-f-]{36})-agent-/i);
      const sessionUuid = m ? m[1] : file.replace(/\.json$/, '');

      const subjects = parsed.map(t => (t as any).content || t.subject || '').filter(Boolean);
      const title = subjects.join(' | ').slice(0, 150);
      const preview = parsed
        .map(t => `[${t.status || 'unknown'}] ${(t as any).content || t.subject || ''}`)
        .join('\n')
        .slice(0, 300);

      yield {
        id: `agent_todo_${sessionUuid}`,
        sourceType: 'task',
        title,
        projectPath: '',
        filePath,
        mtime: stat.mtimeMs,
        contentPreview: preview,
        extra: {
          tool: 'claude',
          kind: 'agent_todo',
          sessionUuid,
          taskCount: parsed.length,
          completedCount: parsed.filter(t => t.status === 'completed').length,
        },
      };
    }
  }

  private async *discoverInDir(tasksDir: string): AsyncGenerator<MemoryItem> {
    if (!existsSync(tasksDir)) return;

    const entries = readdirSync(tasksDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionUuid = entry.name;
      const taskDir = join(tasksDir, sessionUuid);

      try {
        const stat = statSync(taskDir);
        const taskFiles = readdirSync(taskDir).filter(f => f.endsWith('.json'));

        if (taskFiles.length === 0) continue;

        // Read all tasks to build a combined preview
        const tasks = this.readTasks(taskDir, taskFiles);
        if (tasks.length === 0) continue;

        const title = tasks.map(t => t.subject).join(' | ').slice(0, 150);
        const preview = tasks
          .map(t => `[${t.status || 'unknown'}] ${t.subject}`)
          .join('\n')
          .slice(0, 300);

        yield {
          id: sessionUuid,
          sourceType: 'task',
          title,
          projectPath: '', // Linked to session via UUID
          filePath: taskDir,
          mtime: stat.mtimeMs,
          contentPreview: preview,
          extra: {
            taskCount: tasks.length,
            completedCount: tasks.filter(t => t.status === 'completed').length,
          },
        };
      } catch {
        continue;
      }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    // agent_todo items point at a single .json file, not a directory.
    if ((item.extra as any)?.kind === 'agent_todo') {
      return this.parseAgentTodo(item);
    }

    const taskDir = item.filePath;
    if (!existsSync(taskDir)) return [];

    const taskFiles = readdirSync(taskDir).filter(f => f.endsWith('.json'));
    const tasks = this.readTasks(taskDir, taskFiles);

    if (tasks.length === 0) return [];

    const chunks: MemoryChunk[] = [];

    // Chunk 1: Combined task list overview
    const overviewLines = tasks.map(t => {
      let line = `Task ${t.id}: [${t.status || 'unknown'}] ${t.subject}`;
      if (t.description) {
        line += `\n  ${t.description.slice(0, 200)}`;
      }
      return line;
    });

    chunks.push({
      chunkId: `${item.id}_task_overview`,
      itemId: item.id,
      sourceType: 'task',
      title: item.title,
      text: overviewLines.join('\n\n').slice(0, MAX_CHUNK_CHARS),
      chunkType: 'task_overview',
      projectPath: item.projectPath,
      filePath: taskDir,
      mtime: item.mtime,
    });

    // Individual task chunks for tasks with meaningful descriptions
    for (const task of tasks) {
      if (!task.description || task.description.length < 30) continue;

      const text = `${task.subject}\n\n${task.description}`.slice(0, MAX_CHUNK_CHARS);

      chunks.push({
        chunkId: `${item.id}_task_${task.id}`,
        itemId: item.id,
        sourceType: 'task',
        title: task.subject,
        text,
        chunkType: 'task_detail',
        projectPath: item.projectPath,
        filePath: join(taskDir, `${task.id}.json`),
        mtime: item.mtime,
      });
    }

    return chunks.slice(0, 8);
  }

  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    // The task directory UUID IS the session ID. agent_todo items keep the
    // session UUID in extra.sessionUuid so we can still wire the link.
    const extra = (item.extra || {}) as Record<string, unknown>;
    const sessionId = extra.kind === 'agent_todo' ? (extra.sessionUuid as string) : item.id;
    if (!sessionId) return [];
    return [{
      sourceType: 'task',
      sourceId: item.id,
      targetType: 'session',
      targetId: sessionId,
      linkType: 'task_in_session',
      confidence: 1.0,
    }];
  }

  private async parseAgentTodo(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];
    let parsed: TaskJson[];
    try {
      parsed = JSON.parse(readFileSync(item.filePath, 'utf-8'));
    } catch { return []; }
    if (!Array.isArray(parsed) || parsed.length === 0) return [];

    const lines = parsed.map(t => {
      const subject = (t as any).content || t.subject || '';
      const status = t.status || 'unknown';
      return `[${status}] ${subject}`;
    });

    return [{
      chunkId: `${item.id}_agent_todo`,
      itemId: item.id,
      sourceType: 'task',
      title: item.title,
      text: lines.join('\n').slice(0, MAX_CHUNK_CHARS),
      chunkType: 'agent_todo',
      projectPath: item.projectPath,
      filePath: item.filePath,
      mtime: item.mtime,
    }];
  }

  private readTasks(taskDir: string, taskFiles: string[]): TaskJson[] {
    const tasks: TaskJson[] = [];

    // Sort by numeric filename
    const sorted = taskFiles.sort((a, b) => {
      const numA = parseInt(a.replace('.json', ''), 10);
      const numB = parseInt(b.replace('.json', ''), 10);
      return numA - numB;
    });

    for (const file of sorted) {
      try {
        const content = readFileSync(join(taskDir, file), 'utf-8');
        const task = JSON.parse(content) as TaskJson;
        if (task.subject) {
          tasks.push(task);
        }
      } catch {
        continue;
      }
    }

    return tasks;
  }
}
