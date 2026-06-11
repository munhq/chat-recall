/**
 * One place that knows every shipped MemorySource. The registration block
 * was copy-pasted across cli.ts (twice), mcp.ts, the auto-indexer and the
 * web server before sync needed it too — five copies was the limit.
 *
 * Server mode must NOT use this (it has no local FS sources to discover);
 * see packages/server/src/services/memory.ts for the conditional set.
 */
import { SourceRegistry } from '../core/source-registry.js';
import { SessionSource } from './session-source.js';
import { PlanSource } from './plan-source.js';
import { TaskSource } from './task-source.js';
import { ClaudeMdSource } from './claude-md-source.js';
import { HistorySource } from './history-source.js';
import { PasteSource } from './paste-source.js';
import { GeminiSessionSource } from './gemini-source.js';
import { GeminiBrainSource } from './gemini-brain-source.js';
import { OpenCodeSource } from './opencode-source.js';
import { OpenCodeTodoSource } from './opencode-todo-source.js';
import { CodexSessionSource } from './codex-session-source.js';
import { DiarySource } from './diary-source.js';
import { SkillsSource } from './skills-source.js';
import { McpsSource } from './mcps-source.js';
import { SlashCommandsSource } from './slash-commands-source.js';
import { SubagentsSource } from './subagents-source.js';
import { HooksSource } from './hooks-source.js';
import { PluginsSource } from './plugins-source.js';

/** Register every shipped source on `registry` (creates one when omitted). */
export function buildSourceRegistry(registry: SourceRegistry = new SourceRegistry()): SourceRegistry {
  registry.register(new SessionSource());
  registry.register(new PlanSource());
  registry.register(new TaskSource());
  registry.register(new ClaudeMdSource());
  registry.register(new HistorySource());
  registry.register(new PasteSource());
  registry.register(new GeminiSessionSource());
  registry.register(new GeminiBrainSource());
  registry.register(new OpenCodeSource());
  registry.register(new OpenCodeTodoSource());
  registry.register(new CodexSessionSource());
  registry.register(new DiarySource());
  registry.register(new SkillsSource());
  registry.register(new McpsSource());
  registry.register(new SlashCommandsSource());
  registry.register(new SubagentsSource());
  registry.register(new HooksSource());
  registry.register(new PluginsSource());
  return registry;
}
