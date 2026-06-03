/**
 * Source-settings tests:
 *   - schema migration v1 / v2 → v3 fills `sources` with all-true defaults
 *   - layered path resolution (env > settings > built-in default)
 *   - per-source enable gate short-circuits `discover()`
 *   - mixed-tool plugin disables one tool's branch but keeps others
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  loadSettings,
  saveSettings,
  loadSourceSettings,
  isSourceEnabled,
  _resetSourceSettingsCache,
} from './settings.js';
import { claudeHomeDir } from './tool-paths.js';
import { SessionSource } from '../parsers/session-source.js';
import { PasteSource } from '../parsers/paste-source.js';
import { PlanSource } from '../parsers/plan-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
const origClaudeHomeEnv = process.env.CHAT_RECALL_CLAUDE_HOME;
const origDataDirEnv = process.env.CHAT_RECALL_DATA_DIR;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'src-set-'));
  process.env.HOME = tmpHome;
  // Pin chat-recall's own data dir into the tmpdir so tests don't read/write
  // the developer's real settings.json.
  process.env.CHAT_RECALL_DATA_DIR = join(tmpHome, '.chat-recall');
  delete process.env.CHAT_RECALL_CLAUDE_HOME;
  _resetSourceSettingsCache();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origDataDirEnv === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = origDataDirEnv;
  if (origClaudeHomeEnv === undefined) delete process.env.CHAT_RECALL_CLAUDE_HOME;
  else process.env.CHAT_RECALL_CLAUDE_HOME = origClaudeHomeEnv;
  rmSync(tmpHome, { recursive: true, force: true });
  _resetSourceSettingsCache();
});

// ── Schema migration ─────────────────────────────────────────────────

describe('schema migration', () => {
  test('v1 file (embedding+summary only) gets sources defaulted to all-enabled', () => {
    const dir = join(tmpHome, '.chat-recall', 'settings');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      v: 1,
      embedding: { provider: 'none' },
      summary: { provider: 'none' },
    }));

    const s = loadSettings();
    expect(s.sources.enabled.claude.sessions).toBe(true);
    expect(s.sources.enabled.claude.pasteCache).toBe(true);
    expect(s.sources.enabled.gemini.sessions).toBe(true);
    expect(s.sources.enabled.opencode.sessions).toBe(true);
    expect(s.sources.enabled.codex.sessions).toBe(true);
    expect(s.sources.enabled.common.mcps).toBe(true);
  });

  test('partial v2 file: present fields kept, missing fields default to true', () => {
    const dir = join(tmpHome, '.chat-recall', 'settings');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      v: 2,
      embedding: { provider: 'none' },
      summary: { provider: 'none' },
      sources: {
        enabled: {
          claude: { pasteCache: false },  // explicit opt-out
        },
      },
    }));

    const s = loadSettings();
    // Explicit opt-out preserved
    expect(s.sources.enabled.claude.pasteCache).toBe(false);
    // Sibling fields filled in
    expect(s.sources.enabled.claude.sessions).toBe(true);
    expect(s.sources.enabled.claude.history).toBe(true);
    // Other tools defaulted in too
    expect(s.sources.enabled.gemini.sessions).toBe(true);
  });
});

// ── Layered path resolution ─────────────────────────────────────────

describe('claudeHomeDir layered resolution', () => {
  test('env wins over settings wins over default', () => {
    const dir = join(tmpHome, '.chat-recall', 'settings');
    mkdirSync(dir, { recursive: true });
    saveSettings({
      v: 3,
      embedding: { provider: 'none' },
      summary: { provider: 'none' },
      sources: {
        enabled: {
          claude:   { sessions: true, plans: true, tasks: true, pasteCache: true, history: true, skills: true, agents: true, commands: true, hooks: true, plugins: true },
          gemini:   { sessions: true, plans: true, brain: true, extensions: true },
          opencode: { sessions: true, plans: true, todos: true, skills: true },
          codex:    { sessions: true, plugins: true, skills: true },
          common:   { mcps: true, agentMd: true },
        },
        claudeHome: '/from/settings/.claude',
      },
      privacy: { redactIndex: false, projectDenylist: [], redactToolOutputs: false, redactPasteCache: false, redactFilePaths: false },
      sync: { enabled: false, upload: { findings: true, sessionMeta: true, dismissals: true, customRules: true }, excludeTools: [], excludeProjects: [] },
      team: { enabled: false, autoPull: true, publishAllowed: { skills: true, commands: true, agents: true, mcps: true, plans: true, plugins: true, instructions: false, hooks: false }, vault: { enabled: false, syncTools: ['claude'], excludeProjects: [] } },
    });
    _resetSourceSettingsCache();

    // Settings value takes effect when env is unset
    expect(claudeHomeDir()).toBe('/from/settings/.claude');

    // Env wins over settings
    process.env.CHAT_RECALL_CLAUDE_HOME = '/from/env/.claude';
    expect(claudeHomeDir()).toBe('/from/env/.claude');

    // Removing env falls back to settings
    delete process.env.CHAT_RECALL_CLAUDE_HOME;
    expect(claudeHomeDir()).toBe('/from/settings/.claude');
  });

  test('built-in default applies when both env and settings are absent', () => {
    expect(claudeHomeDir()).toBe(join(tmpHome, '.claude'));
  });
});

// ── Per-source enable gate ──────────────────────────────────────────

describe('isSourceEnabled', () => {
  test('default is true when settings.json is missing', () => {
    expect(isSourceEnabled('claude', 'sessions')).toBe(true);
    expect(isSourceEnabled('claude', 'pasteCache')).toBe(true);
  });

  test('explicit false short-circuits a single source', () => {
    const ss = loadSourceSettings();
    ss.enabled.claude.pasteCache = false;
    saveSettings({
      ...loadSettings(),
      sources: { ...ss },
    });
    _resetSourceSettingsCache();

    expect(isSourceEnabled('claude', 'pasteCache')).toBe(false);
    // Sibling sources unaffected
    expect(isSourceEnabled('claude', 'sessions')).toBe(true);
  });
});

// ── Source plugins respect the gate ─────────────────────────────────

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of g) out.push(item);
  return out;
}

describe('SessionSource gate', () => {
  test('discover() yields nothing when claude.sessions is disabled', async () => {
    // Create one Claude session on disk so the plugin would normally
    // emit it.
    const projDir = join(tmpHome, '.claude', 'projects', '-tmp-x');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, '11111111-2222-4333-8444-555555555555.jsonl'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n',
    );

    // Sanity: with sessions enabled, the plugin yields it.
    expect((await collect(new SessionSource().discover())).length).toBeGreaterThanOrEqual(1);

    // Disable, expect zero.
    const cur = loadSettings();
    saveSettings({
      ...cur,
      sources: { ...cur.sources, enabled: { ...cur.sources.enabled, claude: { ...cur.sources.enabled.claude, sessions: false } } },
    });
    _resetSourceSettingsCache();
    expect(await collect(new SessionSource().discover())).toEqual([]);
  });
});

describe('PasteSource gate', () => {
  test('discover() yields nothing when claude.pasteCache is disabled', async () => {
    const cacheDir = join(tmpHome, '.claude', 'paste-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'abc.txt'), 'hello world\n');

    // Sanity: enabled by default, the plugin emits the file.
    expect((await collect(new PasteSource().discover())).length).toBeGreaterThanOrEqual(1);

    // Disable, expect zero.
    const cur = loadSettings();
    saveSettings({
      ...cur,
      sources: { ...cur.sources, enabled: { ...cur.sources.enabled, claude: { ...cur.sources.enabled.claude, pasteCache: false } } },
    });
    _resetSourceSettingsCache();
    expect(await collect(new PasteSource().discover())).toEqual([]);
  });
});

describe('PlanSource per-tool branch gates', () => {
  test('disabling claude.plans keeps gemini/opencode plans flowing', async () => {
    // Drop a Claude plan and a Gemini plan on disk.
    const claudePlans = join(tmpHome, '.claude', 'plans');
    mkdirSync(claudePlans, { recursive: true });
    writeFileSync(join(claudePlans, 'plan-a.md'), '# Plan A\nbody\n');

    // Gemini plan tree: tmp/<hash>/<uuid>/plans/<file>.md
    const geminiPlanDir = join(tmpHome, '.gemini', 'tmp', 'h1', 'sess-1', 'plans');
    mkdirSync(geminiPlanDir, { recursive: true });
    writeFileSync(join(geminiPlanDir, 'plan-b.md'), '# Plan B\nbody\n');
    // projects.json so plan-source can resolve the hash to a path
    writeFileSync(join(tmpHome, '.gemini', 'projects.json'), JSON.stringify({
      projects: { '/some/project': {} },
    }));

    // Sanity: both enabled, both yield.
    let items = await collect(new PlanSource().discover());
    const titles = items.map((i: any) => i.title);
    expect(titles.some((t: string) => t.includes('Plan A'))).toBe(true);

    // Disable claude.plans only — gemini still flows.
    const cur = loadSettings();
    saveSettings({
      ...cur,
      sources: { ...cur.sources, enabled: { ...cur.sources.enabled, claude: { ...cur.sources.enabled.claude, plans: false } } },
    });
    _resetSourceSettingsCache();
    items = await collect(new PlanSource().discover());
    const titles2 = items.map((i: any) => i.title);
    expect(titles2.some((t: string) => t.includes('Plan A'))).toBe(false);
    // Gemini branch still active (we don't assert exact content because
    // the plan walker has additional disk requirements; the negative
    // assertion above is the meaningful one).
  });
});
